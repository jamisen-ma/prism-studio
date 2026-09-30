import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { generateImage } from '../server/openai-images.mjs';

// In-memory random transport tokens only. Never read environment or credentials,
// and never use the real fetch implementation in this test suite.
const token = () => randomBytes(24).toString('hex');
const makePNG = (width = 2, height = 2, alpha = true) => {
  let pipeline = sharp({ create: { width, height, channels: 4, background: { r: 80, g: 120, b: 160, alpha: 0.5 } } });
  if (!alpha) pipeline = pipeline.removeAlpha();
  return pipeline.png().toBuffer();
};
const png = await makePNG();
const response = (data = png, extra = {}, headers = {}) => Response.json({ data: [{ b64_json: data.toString('base64') }], ...extra }, { headers });
const options = overrides => ({ apiKey: token(), prompt: 'A small watercolor landscape.', fetchImpl: async () => response(), ...overrides });

test('generation sends one fixed-endpoint JSON request and returns validated PNG bytes', async () => {
  const apiKey = token(); let calls = 0;
  const result = await generateImage(options({ apiKey, model: 'gpt-image-2.5-flare', size: '1536x1024', quality: 'xhigh', background: 'transparent', fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/images/generations');
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${apiKey}`);
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.ok(init.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(init.body), { model: 'gpt-image-2.5-flare', prompt: 'A small watercolor landscape.', size: '1536x1024', quality: 'xhigh', background: 'transparent', output_format: 'png', n: 1, stream: false });
    return response(png, {}, { 'x-request-id': 'req_test_001' });
  } }));
  assert.equal(calls, 1); assert.deepEqual(result.data, png);
  assert.equal(result.mimeType, 'image/png'); assert.equal(result.model, 'gpt-image-2.5-flare'); assert.equal(result.requestId, 'req_test_001');
});

test('edit uses documented image[]/mask multipart fields with no hand-written boundary', async () => {
  const image = await makePNG(3, 2), mask = await makePNG(3, 2);
  const original = Buffer.from(image), originalMask = Buffer.from(mask);
  await generateImage(options({ image, mask, quality: 'max', fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/images/edits');
    assert.equal(init.headers['Content-Type'], undefined);
    assert.ok(init.body instanceof FormData);
    assert.equal(init.body.get('output_format'), 'png'); assert.equal(init.body.get('n'), '1'); assert.equal(init.body.get('stream'), 'false');
    assert.equal(init.body.get('quality'), 'max');
    assert.equal(init.body.getAll('image[]').length, 1);
    for (const [field, expected] of [['image[]', image], ['mask', mask]]) {
      const file = init.body.get(field);
      assert.equal(file.type, 'image/png'); assert.ok(file.name.endsWith('.png'));
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), expected);
    }
    assert.equal(init.body.get('input_fidelity'), null);
    return response();
  } }));
  assert.deepEqual(image, original); assert.deepEqual(mask, originalMask);
});

test('all three allowed models are explicit and legacy model rejects new quality tiers', async () => {
  for (const model of ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2']) {
    const result = await generateImage(options({ model, quality: 'high' }));
    assert.equal(result.model, model);
  }
  for (const quality of ['xhigh', 'max']) await assert.rejects(generateImage(options({ model: 'gpt-image-2', quality })), { code: 'INVALID_ARGUMENT' });
});

test('validation rejects unsupported arguments before any provider call', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return response(); };
  const invalid = [
    { prompt: '' }, { prompt: ' ' }, { prompt: 'x'.repeat(32001) }, { prompt: {} },
    { model: 'another-provider' }, { size: '4096x4096' }, { quality: 'ultra' }, { background: 'checkerboard' },
    { image: new Uint8Array(png) }, { image: Buffer.alloc(0) }, { mask: png }, { signal: {} }, { fetchImpl: null }
  ];
  for (const override of invalid) await assert.rejects(generateImage(options({ fetchImpl, ...override })), { code: 'INVALID_ARGUMENT' });
  for (const apiKey of ['', 'short', ' '.repeat(20), `${token()}\n`]) await assert.rejects(generateImage(options({ apiKey, fetchImpl })), { code: 'AI_AUTHENTICATION' });
  assert.equal(calls, 0);
});

test('edit validates mask alpha, matching dimensions and actual PNG decoding', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return response(); };
  for (const args of [
    { image: png, mask: await makePNG(3, 2) },
    { image: png, mask: await makePNG(2, 2, false) },
    { image: Buffer.from('not a PNG') },
    { image: png.subarray(0, png.length - 15) }
  ]) await assert.rejects(generateImage(options({ fetchImpl, ...args })), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls, 0);
});

test('input and output PNG dimensions are bounded before decoding', async () => {
  const oversized = Buffer.from(png);
  oversized.writeUInt32BE(8192, 16); oversized.writeUInt32BE(8192, 20);
  await assert.rejects(generateImage(options({ image: oversized })), { code: 'AI_LIMIT_EXCEEDED' });
  await assert.rejects(generateImage(options({ fetchImpl: async () => response(oversized) })), { code: 'AI_LIMIT_EXCEEDED' });
  await assert.rejects(generateImage(options({ image: Buffer.alloc(32 * 1024 * 1024 + 1) })), { code: 'AI_LIMIT_EXCEEDED' });
});

test('provider failures map to actionable static codes and never expose secret/body text', async () => {
  const scenarios = [
    [401, 'invalid_api_key', 'AI_AUTHENTICATION'], [403, undefined, 'AI_AUTHENTICATION'],
    [429, 'insufficient_quota', 'AI_QUOTA'], [429, 'rate_limit_exceeded', 'AI_RATE_LIMIT'],
    [400, 'moderation_blocked', 'AI_CONTENT_POLICY'], [400, 'content_policy_violation', 'AI_CONTENT_POLICY'],
    [404, 'model_not_found', 'AI_MODEL_UNAVAILABLE'], [403, 'organization_verification_required', 'AI_MODEL_UNAVAILABLE'],
    [503, undefined, 'AI_UNAVAILABLE'], [400, 'unknown_parameter', 'AI_REQUEST_REJECTED']
  ];
  for (const [status, code, expected] of scenarios) {
    const apiKey = token(); let calls = 0;
    await assert.rejects(generateImage(options({ apiKey, fetchImpl: async () => {
      calls++;
      return Response.json({ error: { code, message: `PRIVATE_PROVIDER_PAYLOAD ${apiKey}`, debug: { Authorization: apiKey } } }, { status, headers: { 'x-request-id': 'req_error_001' } });
    } })), error => {
      assert.equal(error.code, expected); assert.equal(error.safeMessage, true); assert.equal(error.requestId, 'req_error_001');
      assert.equal(error.cause, undefined);
      const exposed = JSON.stringify(error) + error.message + error.stack;
      assert.ok(!exposed.includes(apiKey)); assert.ok(!exposed.includes('PRIVATE_PROVIDER_PAYLOAD'));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('network errors and redirects are not retried or forwarded', async () => {
  const apiKey = token(); let calls = 0;
  await assert.rejects(generateImage(options({ apiKey, fetchImpl: async (_, init) => {
    calls++; assert.equal(init.redirect, 'error');
    throw new Error(`Transport included Authorization ${apiKey}`);
  } })), error => error.code === 'AI_NETWORK' && !error.message.includes(apiKey) && !JSON.stringify(error).includes(apiKey));
  assert.equal(calls, 1);
  await assert.rejects(generateImage(options({ fetchImpl: async () => new Response(null, { status: 307, headers: { location: 'https://untrusted.invalid/collect' } }) })), { code: 'AI_NETWORK' });
});

test('optional metadata is allowlisted and revised prompts redact known credentials', async () => {
  const apiKey = token();
  const result = await generateImage(options({ apiKey, fetchImpl: async () => response(png, {
    data: [{ b64_json: png.toString('base64'), revised_prompt: `Paint a tree. ${apiKey}\u0000` }],
    usage: { input_tokens: 12, output_tokens: 24, total_tokens: 36, debug: apiKey, input_tokens_details: { image_tokens: 8, text_tokens: 4, private: apiKey }, output_tokens_details: { image_tokens: 'bad' } }
  }, { 'x-request-id': apiKey }) }));
  assert.equal(result.requestId, undefined); assert.equal(result.revisedPrompt, 'Paint a tree. [redacted]');
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 24, total_tokens: 36, input_tokens_details: { image_tokens: 8, text_tokens: 4 } });
  assert.ok(!JSON.stringify({ ...result, data: undefined }).includes(apiKey));
  const unsafe = await generateImage(options({ fetchImpl: async () => response(png, {}, { 'x-request-id': 'unsafe request identifier' }) }));
  assert.equal(unsafe.requestId, undefined);
});

test('success response must contain exactly one base64 PNG, never a URL to fetch', async () => {
  const badBodies = [
    {}, { data: [] }, { data: [{ url: 'https://untrusted.invalid/image.png' }] },
    { data: [{ b64_json: '!!!!' }] }, { data: [{ b64_json: png.toString('base64') }, { b64_json: png.toString('base64') }] },
    { data: [{ b64_json: Buffer.from('<svg/>').toString('base64') }] }
  ];
  for (const body of badBodies) {
    let calls = 0;
    await assert.rejects(generateImage(options({ fetchImpl: async () => { calls++; return Response.json(body); } })), { code: 'AI_RESPONSE_INVALID' });
    assert.equal(calls, 1);
  }
  await assert.rejects(generateImage(options({ fetchImpl: async () => new Response('not JSON', { headers: { 'content-type': 'application/json' } }) })), { code: 'AI_RESPONSE_INVALID' });
  await assert.rejects(generateImage(options({ fetchImpl: async () => new Response('<html>unavailable</html>') })), { code: 'AI_RESPONSE_INVALID' });
});

test('content-length limit cancels the response without consuming its body', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(generateImage(options({ fetchImpl: async () => new Response(body, { headers: { 'content-type': 'application/json', 'content-length': String(49 * 1024 * 1024) } }) })), { code: 'AI_LIMIT_EXCEEDED' });
  assert.equal(cancelled, true);
});

test('streamed response is bounded even without content-length', async () => {
  const chunk = new Uint8Array(1024 * 1024);
  let cancelled = false, reads = 0;
  const body = new ReadableStream({ pull(controller) { reads++; controller.enqueue(chunk); }, cancel() { cancelled = true; } });
  await assert.rejects(generateImage(options({ fetchImpl: async () => new Response(body, { headers: { 'content-type': 'application/json' } }) })), { code: 'AI_LIMIT_EXCEEDED' });
  assert.equal(cancelled, true); assert.ok(reads <= 51);
});

test('decoded image limit rejects oversized base64 before image allocation', async () => {
  // This length fits the wire budget but decodes one byte beyond 32 MiB.
  const oversized = 'A'.repeat(Math.ceil(32 * 1024 * 1024 / 3) * 4);
  await assert.rejects(generateImage(options({ fetchImpl: async () => Response.json({ data: [{ b64_json: oversized }] }) })), { code: 'AI_LIMIT_EXCEEDED' });
});

test('pre-aborted and in-flight signals cancel without exposing arbitrary abort reasons', async () => {
  const controller = new AbortController(); const apiKey = token(); let calls = 0;
  controller.abort(apiKey);
  await assert.rejects(generateImage(options({ apiKey, signal: controller.signal, fetchImpl: async () => { calls++; return response(); } })), { code: 'AI_CANCELLED' });
  assert.equal(calls, 0);
  const active = new AbortController(); let transportSignal;
  await assert.rejects(generateImage(options({ apiKey, signal: active.signal, fetchImpl: async (_, init) => {
    transportSignal = init.signal;
    queueMicrotask(() => active.abort(apiKey));
    return new Promise(() => {});
  } })), error => error.code === 'AI_CANCELLED' && !error.message.includes(apiKey));
  assert.equal(transportSignal.aborted, true);
});

test('five-minute deadline rejects even when injected transport ignores AbortSignal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const pending = generateImage(options({ fetchImpl: async (_, init) => { signal = init.signal; return new Promise(() => {}); } }));
  const rejection = assert.rejects(pending, { code: 'AI_TIMEOUT' });
  t.mock.timers.tick(300_001);
  await rejection;
  assert.equal(signal.aborted, true);
});
