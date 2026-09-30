import { createHash } from 'node:crypto';
import { z } from 'zod';
import { commandSchemas, commandLabels, readCommands, validateCommand } from '../shared/commands.mjs';
import { generationSchema, validateGeneration } from '../shared/generation.mjs';

const EXCLUDED = new Set(['import_image', 'import_color_lookup', 'export_document']);
const COMMANDS = new Set(Object.keys(commandSchemas).filter(name => !EXCLUDED.has(name)));
const PREVIEWS = new Set(['get_preview', 'get_layer_preview', 'get_mask_preview', 'get_channel_preview', 'get_color_range_preview']);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });
const nameSchema = z.string().min(1).max(100);
const empty = z.object({}).strict();
const describeSchema = z.object({ name: nameSchema }).strict();
const executeSchema = z.object({ name: nameSchema, args: z.record(z.string(), z.unknown()).default({}) }).strict();
const generateSchema = generationSchema.omit({ provider: true, mode: true, model: true, requestId: true });
const editSchema = generateSchema.extend({ documentId: z.string().min(1).max(160), expectedRevision: z.number().int().positive() });
const schemas = { prism_list_tools: empty, prism_describe_tool: describeSchema, prism_execute: executeSchema, prism_generate_image: generateSchema, prism_edit_image: editSchema };

function jsonSchema(schema) { const { $schema, ...result } = z.toJSONSchema(schema, { io: 'input' }); return result; }
function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw fail('INVALID_ARGUMENTS', result.error.issues.map(issue => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; '));
  return result.data;
}

// The HTTP caller supplies JSON. Copy before the first await so injected/direct
// callers cannot change a queued tool's nested arguments or execute getters.
function ownJson(value, seen = new Set(), depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || depth > 64 || seen.has(value)) throw fail('INVALID_ARGUMENTS', 'Tool arguments must be finite, acyclic JSON data.');
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw fail('INVALID_ARGUMENTS', 'Tool arguments must use ordinary JSON objects and arrays.');
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value), result = array ? [] : {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (array && key === 'length') continue;
    const property = descriptors[key];
    if (typeof key !== 'string' || !property.enumerable || !Object.hasOwn(property, 'value') || array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) throw fail('INVALID_ARGUMENTS', 'Tool arguments must contain only ordinary JSON data properties.');
    Object.defineProperty(result, key, { value: ownJson(property.value, seen, depth + 1), enumerable: true, configurable: true, writable: true });
  }
  if (array && result.length !== value.length || array && Object.keys(result).length !== value.length) throw fail('INVALID_ARGUMENTS', 'Sparse tool arrays are not supported.');
  seen.delete(value); return result;
}

const text = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
function withImage(data, preview) {
  if (!preview || typeof preview.data !== 'string' || !/^image\/(png|jpeg|webp)$/.test(preview.mimeType ?? '')) throw fail('INVALID_IMAGE', 'The editor did not return a supported preview image.');
  if (!preview.data.length || preview.data.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(preview.data)) throw fail('LIMIT_EXCEEDED', 'The preview is too large or invalid. Request a smaller preview.');
  const { data: pixels, ...metadata } = preview;
  const result = text({ ...data, preview: metadata });
  result.content.push({ type: 'image', mimeType: preview.mimeType, data: pixels });
  return result;
}
function errorResult(error) {
  const known = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) && !/^E[A-Z]+$/.test(error.code);
  return { isError: true, ...text({ error: { code: known ? error.code : 'CHAT_TOOL_FAILED', message: known && typeof error.message === 'string' ? error.message.slice(0, 2000) : 'The editor tool could not complete. Inspect the current document before retrying.' } }) };
}
function waitForPoll(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(fail('CHAT_CANCELLED', 'The chat turn was stopped. Existing edits are retained.')); return; }
    const abort = () => { clearTimeout(timer); reject(fail('CHAT_CANCELLED', 'The chat turn was stopped. Existing edits are retained.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 250);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Private per-turn tools. The caller authenticates the turn, serializes calls,
 * persists call receipts, and owns any transport retry reconciliation. */
export function createChatToolContext({ execute, generation, turn, signal, onEvent = async () => {}, onDocument = async () => {}, onGeneration = async () => {} }) {
  if (typeof execute !== 'function' || !generation || typeof turn?.id !== 'string' || !turn.id || turn.id.length > 160) throw new TypeError('Chat tools require an editor, generation manager, and stable turn ID.');
  const controller = new AbortController();
  const activeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const pending = new Set();
  const check = () => { if (activeSignal.aborted) throw fail('CHAT_CANCELLED', 'The chat turn was stopped. Existing edits are retained.'); };
  const requestId = callId => `chat:${createHash('sha256').update(JSON.stringify([turn.id, callId])).digest('hex')}`;
  const manifest = [
    { name: 'prism_list_tools', description: 'Discover supported native editor commands and their labels. Use prism_describe_tool for the exact argument schema before prism_execute. No file imports, exports or external services are exposed.', inputSchema: jsonSchema(empty), annotations: { readOnlyHint: true, openWorldHint: false } },
    { name: 'prism_describe_tool', description: 'Get the exact JSON argument schema for one native command, using its unprefixed name such as get_document or add_text. Changes require the current expectedRevision; never silently retry or rebase.', inputSchema: jsonSchema(describeSchema), annotations: { readOnlyHint: true, openWorldHint: false } },
    { name: 'prism_execute', description: 'Execute a discovered native command with its exact args. Start with list_documents/get_document and inspect get_preview. Preserve editable layers and protection; group related edits with apply_transaction. Preview results contain image blocks. An accepted edit may finish if the turn is stopped.', inputSchema: jsonSchema(executeSchema), annotations: { readOnlyHint: false, openWorldHint: false } },
    { name: 'prism_generate_image', description: 'Create an image with the automatic local Codex image worker and wait for its durable result. Omit documentId for a new project; supply documentId and current expectedRevision to add a layer. Never generate the same request through another tool or retry an uncertain attempt.', inputSchema: jsonSchema(generateSchema), annotations: { readOnlyHint: false, openWorldHint: false } },
    { name: 'prism_edit_image', description: 'Edit the current document through the local Codex image worker. Requires documentId and current expectedRevision. scope=selection hard-clips to the saved selection and protection. Waits for result; stale results remain ready for explicit user review and are never automatically rebased.', inputSchema: jsonSchema(editSchema), annotations: { readOnlyHint: false, openWorldHint: false } },
  ];

  async function nativeCommand(command, args, callId) {
    check();
    const result = await execute({ backend: 'native', command, args, ...(callId ? { requestId: requestId(callId) } : {}) });
    // Report a committed result even if cancellation arrived during dispatch.
    if (result?.document) await onDocument(result.document);
    check(); return result;
  }
  async function availableCommands() {
    const caps = await nativeCommand('capabilities', {});
    if (!Array.isArray(caps?.commands) || !caps.commands.every(name => typeof name === 'string')) throw fail('UNSUPPORTED_COMMAND', 'Native editor capabilities are unavailable.');
    return new Set(caps.commands.filter(name => COMMANDS.has(name)));
  }
  async function ensureCommand(name) {
    if (!COMMANDS.has(name) || !(await availableCommands()).has(name)) throw fail('UNSUPPORTED_COMMAND', 'This native command is not exposed to chat. Discover the supported tools first.');
  }
  const needsRevision = name => !readCommands.has(name) && name !== 'create_document' && name !== 'save_document';
  function commandSchema(name) {
    const schema = jsonSchema(commandSchemas[name]);
    if (needsRevision(name)) {
      schema.required = [...new Set([...(schema.required ?? []), 'expectedRevision'])];
      schema.properties.expectedRevision = { type: 'integer', minimum: 1, description: 'Current document revision. Inspect after a conflict; do not retry with a newer revision automatically.' };
    }
    return schema;
  }

  async function generate(name, args, callId) {
    check();
    const worker = generation.codexWorker?.status();
    if (generation.automaticCodex !== true || worker?.enabled !== true || worker.available !== true) throw fail('CODEX_WORKER_UNAVAILABLE', 'The automatic local Codex image worker is unavailable. Check its installation and sign-in before generating from chat.');
    const request = validateGeneration({ ...args, mode: name === 'prism_edit_image' ? 'edit' : 'generate', provider: 'codex', requestId: requestId(callId) });
    let job, cancellation;
    const abort = () => { if (job) cancellation ??= Promise.resolve(generation.cancel(job.id)).catch(() => {}); };
    activeSignal.addEventListener('abort', abort, { once: true });
    try {
      check(); job = (await generation.start(request)).job;
      if (activeSignal.aborted) abort();
      await onGeneration(job.id);
      if (activeSignal.aborted) { abort(); await cancellation; check(); }
      let state;
      while (true) {
        check(); job = generation.get(job.id).job;
        const next = `${job.status}:${job.automation?.state ?? ''}`;
        if (next !== state) { state = next; await onEvent({ type: 'generation', jobId: job.id, status: job.status, ...(job.automation ? { automation: { state: job.automation.state } } : {}) }); }
        check();
        if (job.status === 'succeeded') {
          const result = await nativeCommand('get_document', { documentId: job.documentId });
          const preview = await nativeCommand('get_preview', { documentId: job.documentId, maxWidth: 700 });
          return withImage({ job, document: result.document }, preview);
        }
        if (['ready', 'failed', 'cancelled'].includes(job.status) || ['interrupted', 'failed'].includes(job.automation?.state) || job.status === 'awaiting_image' && !job.automation) {
          return text({ job, action: job.status === 'ready' ? 'The generated image is retained. Review the current document and apply it explicitly from the generation panel; no revision rebase was attempted.' : 'Generation did not produce an applied result. Inspect this job in the generation panel before submitting a new request. No automatic retry was made.' });
        }
        await waitForPoll(activeSignal);
      }
    } catch (error) {
      // A failed provenance/progress write must not leave an unobserved model
      // request running. Preserve completed/ready output for explicit review.
      if (job) {
        try { if (['awaiting_image', 'queued', 'running'].includes(generation.get(job.id).job.status)) cancellation ??= Promise.resolve(generation.cancel(job.id)).catch(() => {}); }
        catch { /* Keep the original failure; the durable manager owns recovery. */ }
      }
      throw error;
    } finally { activeSignal.removeEventListener('abort', abort); await cancellation; }
  }

  async function dispatch(name, args, callId) {
    check();
    if (name === 'prism_list_tools') {
      const supported = await availableCommands();
      return text({ backend: 'native', tools: [...supported].map(name => ({ name, title: commandLabels[name] ?? name.replaceAll('_', ' '), readOnly: readCommands.has(name) })), instructions: 'Describe a command before executing it. Use current document revisions for changes, then inspect a preview.' });
    }
    if (name === 'prism_describe_tool') { await ensureCommand(args.name); return text({ name: args.name, title: commandLabels[args.name] ?? args.name, inputSchema: commandSchema(args.name), readOnly: readCommands.has(args.name) }); }
    if (name === 'prism_execute') {
      await ensureCommand(args.name);
      if (needsRevision(args.name) && (!Number.isSafeInteger(args.args.expectedRevision) || args.args.expectedRevision < 1)) throw fail('INVALID_ARGUMENTS', 'Chat edits require a current positive expectedRevision. Read the document first.');
      if (args.name === 'apply_transaction' && Array.isArray(args.args.operations) && args.args.operations.some(step => !COMMANDS.has(step?.command))) throw fail('UNSUPPORTED_COMMAND', 'This transaction contains a command that is not exposed to chat.');
      const validated = validateCommand(args.name, args.args);
      const result = await nativeCommand(args.name, validated, callId);
      return PREVIEWS.has(args.name) ? withImage({}, result) : text(result);
    }
    return generate(name, args, callId);
  }

  return {
    manifest,
    call({ name, arguments: input = {}, callId } = {}) {
      let args;
      try {
        check();
        if (!Object.hasOwn(schemas, name) || typeof callId !== 'string' || !callId || callId.length > 160) throw fail('INVALID_ARGUMENTS', 'Use a listed chat tool and a stable callId of 1–160 characters.');
        args = parse(schemas[name], ownJson(input));
      } catch (error) { return Promise.resolve(errorResult(error)); }
      const promise = dispatch(name, args, callId).catch(errorResult);
      pending.add(promise); promise.finally(() => pending.delete(promise)); return promise;
    },
    async close() { controller.abort(); await Promise.allSettled([...pending]); },
  };
}
