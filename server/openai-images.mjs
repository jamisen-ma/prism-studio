import sharp from 'sharp';

// Official schema verified September 2026:
// https://developers.openai.com/api/docs/guides/image-generation
// https://developers.openai.com/api/reference/resources/images/methods/edit
// This module never reads credentials, performs file I/O, logs provider payloads,
// follows image URLs, redirects a request, or retries a potentially billable call.
const MODELS = new Set(['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2']);
const SIZES = new Set(['auto', '1024x1024', '1536x1024', '1024x1536']);
const QUALITIES = new Set(['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
const BACKGROUNDS = new Set(['auto', 'opaque', 'transparent']);
const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_PIXELS = 24_000_000;
const MAX_AXIS = 8192;
const DEADLINE_MS = 300_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MESSAGES = Object.freeze({
  AI_AUTHENTICATION: 'OpenAI authentication failed. Check the API key and project permissions in AI settings.',
  AI_QUOTA: 'The OpenAI project has insufficient quota or available billing credit. Check its billing and spending limits.',
  AI_RATE_LIMIT: 'OpenAI rate-limited this request. Wait before starting another generation.',
  AI_CONTENT_POLICY: 'OpenAI could not complete this image request under its content policy. Revise the prompt or input images.',
  AI_MODEL_UNAVAILABLE: 'The selected image model is unavailable to this OpenAI project. Check model access or select another supported model.',
  AI_UNAVAILABLE: 'OpenAI image generation is temporarily unavailable. This request was not retried.',
  AI_NETWORK: 'The OpenAI connection failed. Completion and billing may be uncertain; this request was not retried.',
  AI_CANCELLED: 'The image request was cancelled. OpenAI may still finish or bill a request already submitted.',
  AI_TIMEOUT: 'The image request exceeded its five-minute deadline. Completion and billing may be uncertain; it was not retried.',
  AI_RESPONSE_INVALID: 'OpenAI returned an invalid or unsupported image response.',
  AI_LIMIT_EXCEEDED: 'The image request or response exceeds the supported image or response size limit.',
  AI_REQUEST_REJECTED: 'OpenAI rejected the image request. Check the prompt, image inputs and generation settings.'
});

class ImageProviderError extends Error {
  constructor(code, message = MESSAGES[code], requestId) {
    super(message);
    this.name = 'ImageProviderError';
    this.code = code;
    this.safeMessage = true;
    if (requestId) this.requestId = requestId;
  }
}
function invalid(message) { throw new ImageProviderError('INVALID_ARGUMENT', message); }
function fail(code, requestId) { throw new ImageProviderError(code, MESSAGES[code], requestId); }
function safeRequestId(value, apiKey) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
    && !value.startsWith('sk-') && !value.includes(apiKey) ? value : undefined;
}

function validateOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) invalid('Image generation requires an options object.');
  const {
    apiKey, prompt, model = 'gpt-image-2.5-sunburst', size = 'auto', quality = 'auto', background = 'auto',
    image, mask, signal, fetchImpl = globalThis.fetch
  } = options;
  if (typeof apiKey !== 'string' || apiKey.length < 16 || apiKey.length > 1024 || !/^[\x21-\x7e]+$/.test(apiKey)) fail('AI_AUTHENTICATION');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32000) invalid('The image prompt must contain 1–32000 characters.');
  if (!MODELS.has(model)) invalid('Choose one of the supported GPT Image models.');
  if (!SIZES.has(size)) invalid('Image size must be auto, 1024x1024, 1536x1024 or 1024x1536.');
  if (!QUALITIES.has(quality) || (model === 'gpt-image-2' && ['xhigh', 'max'].includes(quality))) invalid('The selected quality is not supported by this image model.');
  if (!BACKGROUNDS.has(background)) invalid('Image background must be auto, opaque or transparent.');
  if (typeof fetchImpl !== 'function') invalid('The image provider transport must be a function.');
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid('The image request signal must be an AbortSignal.');
  if (mask !== undefined && image === undefined) invalid('An image mask requires an input image.');
  for (const value of [image, mask]) {
    if (value === undefined) continue;
    if (!Buffer.isBuffer(value) || value.length === 0) invalid('Input images and masks must be nonempty PNG Buffers.');
    if (value.length > MAX_IMAGE_BYTES) fail('AI_LIMIT_EXCEEDED');
  }
  return { apiKey, prompt, model, size, quality, background, image, mask, signal, fetchImpl };
}

async function validatePNG(buffer, input = false) {
  const bad = () => input ? invalid('Input images and masks must be valid, static PNG images.') : fail('AI_RESPONSE_INVALID');
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE) || buffer.toString('ascii', 12, 16) !== 'IHDR') bad();
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (!width || !height) bad();
  if (width > MAX_AXIS || height > MAX_AXIS || width * height > MAX_PIXELS) fail('AI_LIMIT_EXCEEDED');
  // Reject animated PNG instead of silently choosing its first frame.
  let offset = 8;
  let ended = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (length > buffer.length - offset - 12) bad();
    const kind = buffer.toString('ascii', offset + 4, offset + 8);
    if (kind === 'acTL') bad();
    offset += length + 12;
    if (kind === 'IEND') { ended = true; break; }
  }
  if (!ended || offset !== buffer.length) bad();
  try {
    const image = sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: 'warning' });
    const metadata = await image.metadata();
    if (metadata.format !== 'png' || metadata.width !== width || metadata.height !== height || (metadata.pages || 1) !== 1) bad();
    // metadata alone accepts some truncated IDAT streams; decoding validates pixels.
    await image.resize(1, 1, { fit: 'fill' }).raw().toBuffer();
    return metadata;
  } catch (error) {
    if (error instanceof ImageProviderError) throw error;
    bad();
  }
}

async function cancelBody(response) {
  try { await response.body?.cancel(); } catch { /* No provider errors escape. */ }
}
async function readBounded(response, maximum, signal) {
  const length = response.headers?.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > maximum) {
    await cancelBody(response); fail('AI_LIMIT_EXCEEDED');
  }
  if (!response.body || typeof response.body.getReader !== 'function') fail('AI_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new ImageProviderError('AI_CANCELLED');
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail('AI_RESPONSE_INVALID');
      total += value.byteLength;
      if (total > maximum) fail('AI_LIMIT_EXCEEDED');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } catch (error) {
    try { await reader.cancel(); } catch { /* Preserve the sanitized original error. */ }
    throw error;
  } finally { reader.releaseLock(); }
}

function providerError(status, body, requestId) {
  // Inspect only known machine-readable codes. Never expose error.message/body.
  const code = typeof body?.error?.code === 'string' ? body.error.code : '';
  const type = typeof body?.error?.type === 'string' ? body.error.type : '';
  if (['moderation_blocked', 'content_policy_violation', 'safety_violation'].includes(code)) fail('AI_CONTENT_POLICY', requestId);
  if (['insufficient_quota', 'quota_exceeded', 'billing_hard_limit_reached', 'billing_not_active'].includes(code) || type === 'insufficient_quota') fail('AI_QUOTA', requestId);
  if (status === 401 || code === 'invalid_api_key' || type === 'authentication_error') fail('AI_AUTHENTICATION', requestId);
  if (['model_not_found', 'model_access_denied', 'unsupported_model', 'invalid_model', 'organization_verification_required'].includes(code) || status === 404) fail('AI_MODEL_UNAVAILABLE', requestId);
  if (status === 429) fail('AI_RATE_LIMIT', requestId);
  if (status === 403) fail('AI_AUTHENTICATION', requestId);
  if (status >= 300 && status < 400) fail('AI_NETWORK', requestId);
  if (status >= 500 || status === 408) fail('AI_UNAVAILABLE', requestId);
  fail('AI_REQUEST_REJECTED', requestId);
}

function sanitizedUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key];
  }
  for (const key of ['input_tokens_details', 'output_tokens_details']) {
    const details = value[key];
    if (!details || typeof details !== 'object' || Array.isArray(details)) continue;
    const safe = {};
    for (const field of ['text_tokens', 'image_tokens', 'cached_tokens']) {
      if (Number.isSafeInteger(details[field]) && details[field] >= 0) safe[field] = details[field];
    }
    if (Object.keys(safe).length) result[key] = safe;
  }
  return Object.keys(result).length ? result : undefined;
}

/**
 * Generate/edit one PNG using only injected server-side credentials.
 * image/mask are PNG Buffers. A mask's transparent area is the requested edit.
 * Five-minute deadline, fixed trusted endpoints, no redirects and no retries.
 */
export async function generateImage(options) {
  const args = validateOptions(options);
  const { apiKey, prompt, model, size, quality, background, image, mask, signal, fetchImpl } = args;
  if (signal?.aborted) fail('AI_CANCELLED');
  const controller = new AbortController();
  let timedOut = false;
  let requestId;
  const externalAbort = () => controller.abort();
  signal?.addEventListener('abort', externalAbort, { once: true });
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(new ImageProviderError(timedOut ? 'AI_TIMEOUT' : 'AI_CANCELLED', undefined, requestId));
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, DEADLINE_MS);

  const run = async () => {
    if (image) {
      const input = await validatePNG(image, true);
      if (mask) {
        const maskInfo = await validatePNG(mask, true);
        if (maskInfo.width !== input.width || maskInfo.height !== input.height) invalid('The input image and mask must have matching dimensions.');
        if (!maskInfo.hasAlpha) invalid('The input mask must have an alpha channel.');
      }
    }
    if (controller.signal.aborted) fail(timedOut ? 'AI_TIMEOUT' : 'AI_CANCELLED');
    const fields = { model, prompt, size, quality, background, output_format: 'png', n: 1, stream: false };
    const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
    let body;
    if (image) {
      body = new FormData();
      for (const [name, value] of Object.entries(fields)) body.append(name, String(value));
      body.append('image[]', new Blob([image], { type: 'image/png' }), 'image.png');
      if (mask) body.append('mask', new Blob([mask], { type: 'image/png' }), 'mask.png');
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(fields);
    }
    const response = await fetchImpl(`https://api.openai.com/v1/images/${image ? 'edits' : 'generations'}`, {
      method: 'POST', headers, body, redirect: 'error', signal: controller.signal
    });
    if (controller.signal.aborted) { await cancelBody(response); fail(timedOut ? 'AI_TIMEOUT' : 'AI_CANCELLED'); }
    requestId = safeRequestId(response.headers?.get('x-request-id'), apiKey);
    if (!response.ok) {
      let parsed;
      try { parsed = JSON.parse(await readBounded(response, MAX_ERROR_BYTES, controller.signal)); }
      catch (error) { if (controller.signal.aborted) throw error; /* Classify by HTTP status when error content is missing/oversized. */ }
      providerError(response.status, parsed, requestId);
    }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type') || '')) {
      await cancelBody(response); fail('AI_RESPONSE_INVALID', requestId);
    }
    const responseText = await readBounded(response, MAX_RESPONSE_BYTES, controller.signal);
    let result;
    try { result = JSON.parse(responseText); } catch { fail('AI_RESPONSE_INVALID', requestId); }
    if (result?.error) providerError(response.status, result, requestId);
    if (!Array.isArray(result?.data) || result.data.length !== 1) fail('AI_RESPONSE_INVALID', requestId);
    const encoded = result.data[0]?.b64_json;
    if (typeof encoded !== 'string' || !encoded || encoded.length % 4 !== 0) fail('AI_RESPONSE_INVALID', requestId);
    if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) fail('AI_LIMIT_EXCEEDED', requestId);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) fail('AI_RESPONSE_INVALID', requestId);
    const bytes = encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
    if (bytes > MAX_IMAGE_BYTES) fail('AI_LIMIT_EXCEEDED', requestId);
    const data = Buffer.from(encoded, 'base64');
    if (data.length !== bytes) fail('AI_RESPONSE_INVALID', requestId);
    await validatePNG(data);
    if (controller.signal.aborted) fail(timedOut ? 'AI_TIMEOUT' : 'AI_CANCELLED');
    const output = { data, mimeType: 'image/png', model };
    if (requestId) output.requestId = requestId;
    const usage = sanitizedUsage(result.usage);
    if (usage) output.usage = usage;
    const revised = result.data[0]?.revised_prompt;
    if (typeof revised === 'string' && revised.length <= 32000) output.revisedPrompt = revised.replaceAll(apiKey, '[redacted]').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    return output;
  };

  try { return await Promise.race([run(), aborted]); }
  catch (error) {
    if (controller.signal.aborted) fail(timedOut ? 'AI_TIMEOUT' : 'AI_CANCELLED', requestId);
    if (error instanceof ImageProviderError) {
      if (!error.requestId && requestId) error.requestId = requestId;
      throw error;
    }
    // No cause, transport error string, request headers, or response body survives.
    fail('AI_NETWORK', requestId);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', externalAbort);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
