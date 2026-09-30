import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { openBoundedFile, readBoundedHandle } from './bounded-file.mjs';
import { commandLabels } from '../shared/commands.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'];
const ACTIVE = ['queued', 'running'];
const MAX_TURNS = 100, MAX_FILE = 128 * 1024, MAX_STORE = 8 * 1024 * 1024;
const MAX_CALLS = 64, MAX_CACHE = 32 * 1024 * 1024;
const MAX_TOOL_INPUT = 1024 * 1024, MAX_PENDING_INPUT = 8 * 1024 * 1024;
const error = (code, message) => Object.assign(new Error(message), { code });
const assert = (condition, code, message) => { if (!condition) throw error(code, message); };
const INTERRUPTED = { code: 'CHAT_INTERRUPTED', message: 'The chat attempt was interrupted. Completed changes remain; this request will not run again automatically.' };
const CANCELLED = { code: 'CHAT_CANCELLED', message: 'Stopped. Changes already completed remain in the document.' };
// Only fixed, reviewed messages reach public receipts. Never expose raw CLI
// output, model errors, file paths, credentials, or provider response bodies.
const FAILURE_MESSAGES = Object.freeze({
  CHAT_TIMEOUT: 'The local agent timed out. Completed edits remain in the document.',
  CHAT_UNAVAILABLE: 'Local Codex is unavailable. Check its installation and sign-in.',
  CHAT_OUTPUT_LIMIT: 'An agent response exceeded the supported size. Completed edits remain; inspect the document before continuing.',
  CHAT_INVALID_RECEIPT: 'Local Codex returned an unreadable execution response. Completed edits remain in the document.',
  CHAT_PROCESS_FAILED: 'The local Codex process stopped unexpectedly. Completed edits remain in the document.',
  CHAT_INCOMPLETE_REPLY: 'Local Codex stopped before sending a final reply. Completed edits remain in the document.',
  CHAT_AGENT_FAILED: 'Local Codex reported that it could not finish. Check Codex connection, sign-in and usage availability; completed edits remain.',
  CHAT_START_FAILED: 'The local Codex process could not start. Check its installation and sign-in.',
});
const failed = cause => typeof cause?.code === 'string' && Object.hasOwn(FAILURE_MESSAGES, cause.code)
  ? { code: cause.code, message: FAILURE_MESSAGES[cause.code] }
  : { code: 'CHAT_FAILED', message: 'The local agent could not finish. Inspect completed changes before sending another request.' };

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function dataObject(input, allowed) {
  assert(input && typeof input === 'object' && !Array.isArray(input) && [Object.prototype, null].includes(Object.getPrototypeOf(input)), 'INVALID_ARGUMENTS', 'Use a plain JSON object.');
  const out = {};
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    assert(typeof key === 'string' && allowed.includes(key) && descriptor.enumerable && Object.hasOwn(descriptor, 'value'), 'INVALID_ARGUMENTS', 'Unexpected or non-data chat field.');
    out[key] = descriptor.value;
  }
  return out;
}
function ownToolJson(input, allowance) {
  let bytes = 0;
  const charge = count => { bytes += count; assert(bytes <= allowance, 'LIMIT_EXCEEDED', 'Chat tool arguments exceed the per-call or pending-input limit.'); };
  const visit = (value, depth = 0) => {
    assert(depth <= 64, 'INVALID_ARGUMENTS', 'Chat tool JSON is too deeply nested.');
    if (value === null || typeof value === 'boolean') { charge(value === null ? 4 : value ? 4 : 5); return value; }
    if (typeof value === 'number') { assert(Number.isFinite(value), 'INVALID_ARGUMENTS', 'Use finite JSON numbers.'); charge(String(value).length); return value; }
    if (typeof value === 'string') { assert(value.length <= allowance, 'LIMIT_EXCEEDED', 'Chat tool text is too large.'); charge(Buffer.byteLength(JSON.stringify(value))); return value; }
    assert(value && typeof value === 'object', 'INVALID_ARGUMENTS', 'Use JSON data for chat tool arguments.');
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    assert(array ? prototype === Array.prototype : [Object.prototype, null].includes(prototype), 'INVALID_ARGUMENTS', 'Use plain JSON objects and arrays.');
    const keys = Reflect.ownKeys(value); charge(2);
    if (array) {
      assert(value.length <= MAX_TOOL_INPUT / 2 && keys.length === value.length + 1, 'INVALID_ARGUMENTS', 'Use dense JSON arrays.');
      const result = [];
      for (let i = 0; i < value.length; i++) {
        const property = Object.getOwnPropertyDescriptor(value, String(i));
        assert(property?.enumerable && Object.hasOwn(property, 'value'), 'INVALID_ARGUMENTS', 'Use ordinary JSON array entries.');
        if (i) charge(1); result.push(visit(property.value, depth + 1));
      }
      return result;
    }
    const result = {};
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i], property = Object.getOwnPropertyDescriptor(value, key);
      assert(typeof key === 'string' && property.enumerable && Object.hasOwn(property, 'value'), 'INVALID_ARGUMENTS', 'Use own JSON data properties.');
      if (i) charge(1); charge(Buffer.byteLength(JSON.stringify(key)) + 1);
      Object.defineProperty(result, key, { value: visit(property.value, depth + 1), enumerable: true, configurable: true, writable: true });
    }
    return result;
  };
  return { value: visit(input), bytes };
}
export function normalizeChatRequest(input) {
  const value = dataObject(input, ['message', 'requestId', 'documentId', 'selectedLayerId', 'attachments']);
  assert(typeof value.message === 'string' && value.message.trim().length > 0 && value.message.length <= 16000, 'INVALID_ARGUMENTS', 'Chat messages must contain1–16000 characters.');
  assert(typeof value.requestId === 'string' && value.requestId.length > 0 && value.requestId.length <= 160, 'INVALID_ARGUMENTS', 'Use a stable requestId of1–160 characters.');
  for (const key of ['documentId', 'selectedLayerId']) if (Object.hasOwn(value, key)) assert(typeof value[key] === 'string' && UUID.test(value[key]), 'INVALID_ARGUMENTS', 'Use valid document and layer identifiers.');
  assert(value.selectedLayerId === undefined || value.documentId !== undefined, 'INVALID_ARGUMENTS', 'A selected layer requires its document.');
  if (Object.hasOwn(value, 'attachments')) {
    const input = value.attachments;
    assert(Array.isArray(input) && Object.getPrototypeOf(input) === Array.prototype && input.length <= 8 && Reflect.ownKeys(input).length === input.length + 1, 'INVALID_ARGUMENTS', 'Attach up to 8 image documents in an ordinary array.');
    const attachments = [], seen = new Set();
    for (let i = 0; i < input.length; i++) {
      const entry = Object.getOwnPropertyDescriptor(input, String(i));
      assert(entry?.enumerable && Object.hasOwn(entry, 'value'), 'INVALID_ARGUMENTS', 'Use ordinary attachment entries.');
      const attachment = dataObject(entry.value, ['documentId', 'name']);
      assert(typeof attachment.documentId === 'string' && attachment.documentId.length === 36 && UUID.test(attachment.documentId), 'INVALID_ARGUMENTS', 'Attachments require valid document identifiers.');
      if (Object.hasOwn(attachment, 'name')) assert(typeof attachment.name === 'string' && attachment.name.trim().length > 0 && attachment.name.length <= 200, 'INVALID_ARGUMENTS', 'Attachment names must contain 1–200 characters.');
      const documentId = attachment.documentId.toLowerCase();
      assert(!seen.has(documentId), 'INVALID_ARGUMENTS', 'Attach each image document only once.'); seen.add(documentId);
      attachments.push({ documentId, ...(attachment.name !== undefined ? { name: attachment.name.trim() } : {}) });
    }
    if (attachments.length) value.attachments = attachments; else delete value.attachments;
  }
  return { ...value, message: value.message.trim() };
}
function requestFingerprint(args) {
  // Display names are resolved from authoritative documents on first acceptance.
  // A retry remains the same request after a document is renamed or removed.
  return digest(canonical({ ...args, ...(args.attachments ? { attachments: args.attachments.map(({ documentId }) => ({ documentId })) } : {}) }));
}
function publicTurn(record) {
  const { id, requestId, message, status, createdAt, updatedAt, reply, error: problem, events, documentId, selectedLayerId, resultDocumentId, generationJobIds, attachments } = record;
  return structuredClone({ id, requestId, message, status, createdAt, updatedAt, events, ...(documentId ? { documentId } : {}), ...(selectedLayerId ? { selectedLayerId } : {}), ...(attachments ? { attachments } : {}), ...(reply !== undefined ? { reply } : {}), ...(problem ? { error: problem } : {}), ...(resultDocumentId ? { resultDocumentId } : {}), ...(generationJobIds?.length ? { generationJobIds } : {}) });
}

export class ChatManager {
  constructor({ dataDir, native, generation, adapter, createToolContext, execute, getBaseUrl = () => 'http://127.0.0.1:43120', enabled = false }) {
    this.directory = path.join(path.resolve(dataDir), 'chat');
    this.turnsDirectory = path.join(this.directory, 'turns'); this.workDirectory = path.join(this.directory, 'work');
    this.native = native; this.generation = generation; this.adapter = adapter; this.createToolContext = createToolContext; this.execute = execute; this.getBaseUrl = getBaseUrl;
    this.enabled = enabled === true; this.available = false; this.checkedAt = 0; this.checking = null;
    this.turns = new Map(); this.sizes = new Map(); this.bytes = 0; this.serial = Promise.resolve(); this.worker = null; this.active = null;
    this.pendingCancellations = new Set();
    this.closed = false; this.initialized = false; this.lastCreated = 0;
  }
  locked(operation) { const result = this.serial.then(operation); this.serial = result.catch(() => {}); return result; }
  ensureAvailable() { assert(this.initialized && !this.closed, 'CLOSED', 'The chat manager is closed.'); }
  record(id) { assert(typeof id === 'string' && UUID.test(id), 'INVALID_ARGUMENTS', 'Use a valid chat turn ID.'); const record = this.turns.get(id); assert(record, 'NOT_FOUND', 'Chat turn not found.'); return record; }

  async init() {
    await fs.mkdir(this.turnsDirectory, { recursive: true, mode: 0o700 }); await fs.mkdir(this.workDirectory, { recursive: true, mode: 0o700 });
    const files = (await fs.readdir(this.turnsDirectory)).filter(name => name.endsWith('.json') && UUID.test(name.slice(0, -5)));
    assert(files.length <= MAX_TURNS, 'LIMIT_EXCEEDED', 'Too many stored chat turns.');
    for (const filename of files) {
      const opened = await openBoundedFile(path.join(this.turnsDirectory, filename), { maxBytes: MAX_FILE, code: 'INVALID_CHAT' });
      let record;
      try { record = JSON.parse((await readBoundedHandle(opened.handle, { bytes: opened.bytes, code: 'INVALID_CHAT' })).data.toString('utf8')); }
      finally { await opened.handle.close(); }
      assert(record.version === 1 && record.id === filename.slice(0, -5) && STATES.includes(record.status) && HASH.test(record.fingerprint) && Number.isFinite(Date.parse(record.createdAt)) && Number.isFinite(Date.parse(record.updatedAt)), 'INVALID_CHAT', 'Invalid persisted chat turn.');
      let request;
      try { request = normalizeChatRequest({ message: record.message, requestId: record.requestId, ...(Object.hasOwn(record, 'documentId') ? { documentId: record.documentId } : {}), ...(Object.hasOwn(record, 'selectedLayerId') ? { selectedLayerId: record.selectedLayerId } : {}), ...(Object.hasOwn(record, 'attachments') ? { attachments: record.attachments } : {}) }); }
      catch { throw error('INVALID_CHAT', 'Invalid persisted chat request.'); }
      assert(record.attachments === undefined || (request.attachments?.length > 0 && request.attachments.every(attachment => typeof attachment.name === 'string') && JSON.stringify(record.attachments) === JSON.stringify(request.attachments)), 'INVALID_CHAT', 'Invalid persisted attachment metadata.');
      assert(record.fingerprint === requestFingerprint(request), 'INVALID_CHAT', 'The persisted chat request does not match its receipt.');
      assert(Array.isArray(record.events) && record.events.length <= 100 && record.events.every(event => UUID.test(event.id) && typeof event.label === 'string' && event.label.length <= 200 && [undefined, 'running', 'succeeded', 'failed'].includes(event.status)), 'INVALID_CHAT', 'Invalid chat progress.');
      assert(Array.isArray(record.calls) && record.calls.length <= MAX_CALLS && record.calls.every(call => UUID.test(call.id) && HASH.test(call.fingerprint) && typeof call.name === 'string' && call.name.length <= 100 && ['running', 'succeeded', 'failed'].includes(call.status)), 'INVALID_CHAT', 'Invalid chat tool receipts.');
      assert(record.reply === undefined || (typeof record.reply === 'string' && record.reply.length <= 32000), 'INVALID_CHAT', 'Invalid chat reply.');
      assert(record.resultDocumentId === undefined || UUID.test(record.resultDocumentId), 'INVALID_CHAT', 'Invalid chat result document.');
      assert(Array.isArray(record.generationJobIds) && record.generationJobIds.length <= MAX_CALLS && record.generationJobIds.every(id => UUID.test(id)), 'INVALID_CHAT', 'Invalid chat generation receipts.');
      if (record.error) record.error = record.status === 'cancelled' ? CANCELLED : record.status === 'interrupted' ? INTERRUPTED : failed(record.error);
      this.turns.set(record.id, record); this.sizes.set(record.id, opened.bytes); this.bytes += opened.bytes; this.lastCreated = Math.max(this.lastCreated, Date.parse(record.createdAt));
    }
    assert(this.bytes <= MAX_STORE, 'LIMIT_EXCEEDED', 'Stored chat history exceeds8MiB.');
    for (const record of this.turns.values()) {
      if (ACTIVE.includes(record.status)) await this.write({ ...record, status: 'interrupted', error: INTERRUPTED, updatedAt: new Date().toISOString() });
      if (ACTIVE.includes(record.status) || ['cancelled', 'interrupted'].includes(record.status)) await this.cancelPendingGeneration(record);
    }
    for (const entry of await fs.readdir(this.workDirectory)) if (UUID.test(entry)) await fs.rm(path.join(this.workDirectory, entry), { recursive: true, force: true });
    this.initialized = true; await this.check(); return this;
  }

  async write(record) {
    const serialized = JSON.stringify(record), bytes = Buffer.byteLength(serialized);
    assert(bytes <= MAX_FILE && this.bytes - (this.sizes.get(record.id) ?? 0) + bytes <= MAX_STORE, 'LIMIT_EXCEEDED', 'Chat history storage limit reached.');
    const destination = path.join(this.turnsDirectory, `${record.id}.json`), temporary = path.join(this.turnsDirectory, `.${record.id}-${randomUUID()}.tmp`);
    let handle;
    try { handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(serialized); await handle.sync(); await handle.close(); handle = null; await fs.rename(temporary, destination); }
    finally { await handle?.close(); await fs.unlink(temporary).catch(() => {}); }
    this.bytes += bytes - (this.sizes.get(record.id) ?? 0); this.sizes.set(record.id, bytes); this.turns.set(record.id, record); return record;
  }

  check() {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      let ready = false;
      if (this.enabled && !this.closed) try { ready = (await this.adapter.check())?.available === true; } catch { /* Public readiness never exposes child output. */ }
      this.available = ready; this.checkedAt = Date.now();
    })().finally(() => { this.checking = null; });
    return this.checking;
  }
  async list() {
    this.ensureAvailable(); if (Date.now() - this.checkedAt > 30000) await this.check();
    return { available: this.available && !this.closed, ...(!this.available ? { message: this.enabled ? 'The local Codex agent is unavailable. Check its installation and sign-in.' : 'Local agent chat is disabled.' } : {}), turns: [...this.turns.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(publicTurn) };
  }

  start(input) {
    const args = normalizeChatRequest(input), fingerprint = requestFingerprint(args);
    return this.locked(async () => {
      this.ensureAvailable();
      const existing = [...this.turns.values()].find(turn => turn.requestId === args.requestId);
      if (existing) { assert(existing.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', 'This requestId belongs to different chat input.'); return { turn: publicTurn(existing) }; }
      assert(this.enabled && this.available, 'CHAT_UNAVAILABLE', 'The local Codex agent is unavailable.');
      assert(this.turns.size < MAX_TURNS && [...this.turns.values()].filter(turn => ACTIVE.includes(turn.status)).length < 6, 'LIMIT_EXCEEDED', 'The chat queue or retained history is full.');
      if (args.documentId) {
        const { document } = await this.native.execute('get_document', { documentId: args.documentId });
        assert(!args.selectedLayerId || document.layers.some(layer => layer.id === args.selectedLayerId), 'NOT_FOUND', 'The selected layer is no longer in this document.');
      }
      let attachments;
      if (args.attachments) {
        attachments = [];
        for (const { documentId } of args.attachments) {
          const { document } = await this.native.execute('get_document', { documentId });
          assert(document.id === documentId && typeof document.name === 'string' && document.name.trim().length > 0 && document.name.length <= 200, 'INVALID_CHAT_RESULT', 'Invalid attached document metadata.');
          attachments.push({ documentId, name: document.name });
        }
      }
      const createdAt = new Date(Math.max(Date.now(), this.lastCreated + 1)).toISOString(); this.lastCreated = Date.parse(createdAt);
      const record = { version: 1, id: randomUUID(), ...args, ...(attachments ? { attachments } : {}), fingerprint, status: 'queued', createdAt, updatedAt: createdAt, events: [], calls: [], generationJobIds: [] };
      await this.write(record); this.kick(); return { turn: publicTurn(record) };
    });
  }

  history(before) {
    // Each canvas has its own conversation: only earlier turns sent from, producing, or attaching this document.
    const thread = turn => before.documentId ? turn.documentId === before.documentId || turn.resultDocumentId === before.documentId || Boolean(turn.attachments?.some(item => item.documentId === before.documentId)) : !turn.documentId;
    const turns = [...this.turns.values()].filter(turn => turn.createdAt < before.createdAt && !ACTIVE.includes(turn.status) && thread(turn)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-20);
    const entries = []; let bytes = 0;
    for (const turn of turns.reverse()) {
      const pair = [{ role: 'user', content: turn.message, ...(turn.attachments ? { attachments: structuredClone(turn.attachments) } : {}) }, { role: 'assistant', content: turn.reply ?? `${turn.status}: ${turn.error?.message ?? 'No reply was recorded.'}`, ...(turn.resultDocumentId ? { resultDocumentId: turn.resultDocumentId } : {}) }];
      const size = Buffer.byteLength(JSON.stringify(pair)); if (bytes + size > 65536) break;
      entries.unshift(...pair); bytes += size;
    }
    return entries;
  }

  kick() {
    if (this.worker || this.closed) return;
    let halted = false;
    this.worker = this.drain().catch(() => { this.available = false; halted = true; }).finally(() => {
      this.worker = null;
      if (!halted && !this.closed && [...this.turns.values()].some(turn => turn.status === 'queued' && !this.pendingCancellations.has(turn.id))) this.kick();
    });
  }
  async drain() {
    while (!this.closed) {
      const record = await this.locked(async () => {
        if (this.closed) return null;
        const next = [...this.turns.values()].filter(turn => turn.status === 'queued' && !this.pendingCancellations.has(turn.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        return next ? this.write({ ...next, status: 'running', updatedAt: new Date().toISOString() }) : null;
      });
      if (!record) return;
      await this.run(record);
    }
  }

  async update(id, mutate) { return this.locked(async () => this.write({ ...mutate(this.record(id)), updatedAt: new Date().toISOString() })); }
  redact(active, value) { return String(value).split(active.token).join('[private capability]'); }
  event(active, input) {
    const generationLabels = { queued: 'Image queued', awaiting_image: 'Image queued', generating: 'Creating image', running: 'Creating image', returning: 'Saving image', succeeded: 'Image added to the document', ready: 'Image ready for review', failed: 'Image could not finish', interrupted: 'Image request interrupted', cancelled: 'Image request stopped' };
    let label = typeof input?.label === 'string' ? input.label : input?.type === 'generation' ? generationLabels[input.automation?.state ?? input.status] ?? 'Creating image' : null;
    if (!label) return Promise.resolve();
    label = this.redact(active, label).slice(0, 200);
    const status = ['running', 'succeeded', 'failed'].includes(input.status) ? input.status : 'running';
    return this.update(active.id, record => ({ ...record, events: record.events.length < 100 ? [...record.events, { id: randomUUID(), label, status }] : record.events }));
  }
  async run(record) {
    const active = { id: record.id, token: randomBytes(32).toString('hex'), controller: new AbortController(), calls: new Map(), tail: Promise.resolve(), cacheBytes: 0, pendingInputBytes: 0, revoked: false };
    this.active = active;
    const workDir = path.join(this.workDirectory, record.id);
    try {
      await fs.mkdir(workDir, { mode: 0o700 });
      assert(!this.closed && !this.pendingCancellations.has(record.id) && this.record(record.id).status === 'running', 'CHAT_CANCELLED', 'The chat attempt is no longer active.');
      active.context = await this.createToolContext({ native: this.native, execute: this.execute, generation: this.generation, turn: publicTurn(record), signal: active.controller.signal,
        onEvent: event => this.event(active, event),
        onDocument: document => { assert(document && typeof document.id === 'string' && UUID.test(document.id), 'INVALID_CHAT_RESULT', 'Invalid tool document result.'); return this.update(active.id, current => ({ ...current, resultDocumentId: document.id })); },
        onGeneration: jobId => { assert(UUID.test(jobId), 'INVALID_CHAT_RESULT', 'Invalid image job result.'); this.generation.get(jobId); return this.update(active.id, current => ({ ...current, generationJobIds: [...new Set([...current.generationJobIds, jobId])] })); },
      });
      assert(!this.closed && !this.pendingCancellations.has(record.id) && !active.controller.signal.aborted && this.record(record.id).status === 'running', 'CHAT_CANCELLED', 'The chat attempt is no longer active.');
      const result = await this.adapter.run({ turn: publicTurn(record), history: this.history(record), signal: active.controller.signal, onEvent: event => this.event(active, event), workDir, toolContext: { turnId: active.id, baseUrl: this.getBaseUrl(), capabilityToken: active.token } });
      active.revoked = true; await active.tail;
      if (!active.controller.signal.aborted && !this.closed) {
        assert(typeof result?.reply === 'string' && result.reply.length <= 32000, 'INVALID_CHAT_RESULT', 'The local agent returned an invalid reply.');
        await this.update(active.id, current => ({ ...current, status: 'succeeded', reply: this.redact(active, result.reply), error: undefined }));
      }
    } catch (cause) {
      const cancelled = active.controller.signal.aborted;
      active.revoked = true; active.controller.abort(); await active.tail.catch(() => {});
      await this.update(active.id, current => ACTIVE.includes(current.status) ? { ...current, status: this.closed ? 'interrupted' : cancelled ? 'cancelled' : 'failed', error: this.closed ? INTERRUPTED : cancelled ? CANCELLED : failed(cause) } : current);
    } finally {
      active.revoked = true;
      await active.context?.close?.();
      await fs.rm(workDir, { recursive: true, force: true });
      if (this.active === active) this.active = null;
    }
  }

  authenticate(id, token) {
    const active = this.active;
    assert(typeof token === 'string' && HASH.test(token) && active && active.id === id && !active.revoked && !this.closed && !this.pendingCancellations.has(id) && !active.controller.signal.aborted && this.record(id).status === 'running' && timingSafeEqual(Buffer.from(token), Buffer.from(active.token)), 'UNAUTHORIZED', 'This active chat capability is required.');
    return active;
  }
  async tools(id, token) {
    const active = this.authenticate(id, token);
    assert(active.context, 'NOT_READY', 'The agent tool context is not ready.');
    return { tools: typeof active.context.manifest === 'function' ? await active.context.manifest() : active.context.manifest };
  }
  tool(id, token, input) {
    const active = this.authenticate(id, token);
    const args = dataObject(input, ['name', 'arguments', 'callId']);
    assert(typeof args.name === 'string' && args.name.length > 0 && args.name.length <= 100 && typeof args.callId === 'string' && UUID.test(args.callId) && args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments), 'INVALID_ARGUMENTS', 'Tool calls require a name, arguments object and stable UUID callId.');
    const existingCall = active.calls.get(args.callId);
    const snapshot = ownToolJson(args, existingCall ? MAX_TOOL_INPUT : Math.min(MAX_TOOL_INPUT, MAX_PENDING_INPUT - active.pendingInputBytes));
    const owned = snapshot.value, fingerprint = digest(canonical(owned));
    const prior = active.calls.get(owned.callId);
    if (prior) {
      assert(prior.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', 'This callId belongs to different tool arguments.');
      if (prior.pending) return prior.pending;
      assert(prior.result !== undefined, 'CHAT_RECEIPT_ONLY', 'This tool call already completed. Its cached reply expired; inspect current state instead of replaying it.');
      return Promise.resolve(structuredClone(prior.result));
    }
    assert(active.calls.size < MAX_CALLS, 'LIMIT_EXCEEDED', 'This chat turn reached its64 tool-call limit.');
    active.pendingInputBytes += snapshot.bytes;
    const entry = { fingerprint }; active.calls.set(owned.callId, entry);
    const label = owned.name === 'prism_execute' ? commandLabels[owned.arguments.name] ?? 'Editing the image' : ({ prism_list_tools: 'Choosing editing tools', prism_describe_tool: 'Checking editing options', prism_generate_image: 'Generating an image', prism_edit_image: 'Editing with AI' }[owned.name] ?? 'Editing the image');
    const operation = active.tail.then(async () => {
      this.authenticate(id, token);
      await this.update(id, current => ({ ...current, calls: [...current.calls, { id: owned.callId, fingerprint, name: owned.name, status: 'running' }] }));
      this.authenticate(id, token);
      await this.event(active, { label, status: 'running' });
      let result;
      try { result = await active.context.call(owned); }
      catch { result = { isError: true, content: [{ type: 'text', text: 'The tool could not complete. Inspect the current document before trying a new action.' }] }; }
      const serialized = JSON.stringify(result), size = Buffer.byteLength(serialized);
      const safeResult = JSON.parse(this.redact(active, serialized));
      await this.update(id, current => ({ ...current, calls: current.calls.map(call => call.id === owned.callId ? { ...call, status: result.isError ? 'failed' : 'succeeded' } : call) }));
      await this.event(active, { label: `${label}: ${result.isError ? 'could not complete' : 'done'}`, status: result.isError ? 'failed' : 'succeeded' });
      if (size <= MAX_CACHE) {
        for (const old of active.calls.values()) {
          if (active.cacheBytes + size <= MAX_CACHE) break;
          if (!old.pending && old.result !== undefined) { active.cacheBytes -= old.bytes; delete old.result; }
        }
        entry.result = safeResult; entry.bytes = size; active.cacheBytes += size;
      }
      return safeResult;
    });
    entry.pending = operation.finally(() => { entry.pending = null; active.pendingInputBytes -= snapshot.bytes; });
    active.tail = entry.pending.then(() => {}, () => {});
    return entry.pending;
  }

  cancel(id) {
    if (ACTIVE.includes(this.record(id).status)) this.pendingCancellations.add(id);
    if (this.active?.id === id) { this.active.revoked = true; this.active.controller.abort(); }
    return this.locked(async () => {
      this.ensureAvailable(); const record = this.record(id);
      return { turn: publicTurn(ACTIVE.includes(record.status) ? await this.write({ ...record, status: 'cancelled', error: CANCELLED, updatedAt: new Date().toISOString() }) : record) };
    });
  }
  async cancelPendingGeneration(record) {
    for (const id of record.generationJobIds) {
      let job;
      try { job = this.generation.get(id).job; } catch (cause) { if (cause.code === 'NOT_FOUND') continue; throw cause; }
      if (['awaiting_image', 'queued', 'running'].includes(job.status)) await this.generation.cancel(id);
    }
  }
  async close() {
    if (this.closed) { await this.worker; return; }
    this.closed = true;
    if (this.active) { this.active.revoked = true; this.active.controller.abort(); }
    await this.locked(async () => { for (const record of this.turns.values()) if (ACTIVE.includes(record.status)) await this.write({ ...record, status: 'interrupted', error: INTERRUPTED, updatedAt: new Date().toISOString() }); });
    await this.worker; await this.serial;
  }
}
