import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createChatToolContext } from '../server/chat-tools.mjs';
import { NativeBackend } from '../server/native.mjs';
import { GenerationManager } from '../server/generation.mjs';
import { CodexWorker } from '../server/codex-worker.mjs';

const blue = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#0000ff' } }).png().toBuffer();
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const data = result => JSON.parse(result.content.find(item => item.type === 'text').text);
const call = (context, name, args = {}, callId = name) => context.call({ name, arguments: args, callId });
const nativeCall = (context, name, args = {}, callId = name) => call(context, 'prism_execute', { name, args }, callId);

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-chat-tools-'));
  const native = await new NativeBackend({ dataDir }).init();
  const calls = [], documents = [], jobs = [], contexts = [];
  let generated = 0, api = 0;
  const generation = await new GenerationManager({ dataDir, native, automaticCodex: true, getKey: async () => { api++; throw Error('No API key allowed.'); }, provider: async () => { api++; throw Error('No API call allowed.'); } }).init();
  const worker = new CodexWorker({ manager: generation, adapter: { check: async () => ({ available: true }), generate: async () => { generated++; return blue; } } });
  await worker.start();
  const execute = async request => { calls.push(request); return native.execute(request.command, request.args); };
  function context(extra = {}) {
    const result = createChatToolContext({ execute, generation, turn: { id: 'test-turn' }, onDocument: async document => { documents.push(document); }, onGeneration: async id => { jobs.push(id); }, ...options, ...extra });
    contexts.push(result); return result;
  }
  t.after(async () => { for (const c of contexts) await c.close(); await worker.close(); await generation.close(); await native.close(); assert.equal(api, 0); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { native, generation, worker, context, execute, calls, documents, jobs, generated: () => generated };
}

test('chat uses a compact discovery manifest with real native schemas and no file import/export surface', async t => {
  const f = await fixture(t), context = f.context();
  assert.deepEqual(context.manifest.map(tool => tool.name), ['prism_list_tools', 'prism_describe_tool', 'prism_execute', 'prism_generate_image', 'prism_edit_image']);
  assert.ok(JSON.stringify(context.manifest).length < 10_000);
  const list = data(await call(context, 'prism_list_tools')).tools.map(tool => tool.name);
  for (const name of ['create_document', 'get_document', 'get_preview', 'add_adjustment', 'apply_transaction']) assert.ok(list.includes(name));
  for (const name of ['import_image', 'import_color_lookup', 'export_document', 'extract_subject']) assert.equal(list.includes(name), false);
  const description = data(await call(context, 'prism_describe_tool', { name: 'add_text' }));
  assert.equal(description.inputSchema.additionalProperties, false);
  assert.ok(description.inputSchema.required.includes('expectedRevision'));
  assert.equal(description.inputSchema.properties.expectedRevision.minimum, 1);
  for (const name of ['import_image', 'import_color_lookup', 'export_document', 'arbitrary_file']) {
    assert.equal((await call(context, 'prism_describe_tool', { name })).isError, true);
    assert.equal((await nativeCall(context, name, {})).isError, true);
    assert.equal(f.calls.some(item => item.command === name), false);
  }
});

test('native chat commands retain revisions and stable call IDs and emit image blocks without base64 text', async t => {
  const f = await fixture(t), context = f.context();
  const created = data(await nativeCall(context, 'create_document', { name: 'Chat fixture', width: 8, height: 8, background: '#804020' }, 'create-one')).document;
  assert.equal(f.documents[0].id, created.id);
  const args = { documentId: created.id, layerId: created.layers[0].id, name: 'Renamed' };
  assert.equal(data(await nativeCall(context, 'set_layer', args)).error.code, 'INVALID_ARGUMENTS');
  const edited = data(await nativeCall(context, 'set_layer', { ...args, expectedRevision: created.revision }, 'rename-once')).document;
  const rejected = await nativeCall(context, 'set_layer', { ...args, expectedRevision: created.revision }, 'rename-once');
  assert.equal(data(rejected).error.code, 'REVISION_CONFLICT', 'This direct native fixture deliberately has no app deduplication; chat must not rebase the retry.');
  const writes = f.calls.filter(item => item.command === 'set_layer');
  assert.equal(writes.length, 2); assert.equal(writes[0].requestId, writes[1].requestId); assert.equal(writes[0].backend, 'native');
  assert.notEqual(f.calls.find(item => item.command === 'create_document').requestId, writes[0].requestId);
  const preview = await nativeCall(context, 'get_preview', { documentId: created.id, maxWidth: 32 });
  assert.equal(preview.content.filter(item => item.type === 'image').length, 1);
  assert.equal(data(preview).preview.data, undefined); assert.equal(preview.structuredContent.preview.data, undefined);
  assert.equal(data(preview).preview.width, 8);
  assert.equal((await f.native.execute('get_document', { documentId: created.id })).document.revision, edited.revision);
});

test('nested transaction and recipe definitions cannot reintroduce excluded commands', async t => {
  const f = await fixture(t), context = f.context();
  const doc = (await f.native.execute('create_document', { width: 8, height: 8 })).document;
  for (const name of ['import_image', 'import_color_lookup', 'export_document']) {
    const result = await nativeCall(context, 'apply_transaction', { documentId: doc.id, expectedRevision: doc.revision, label: 'Forbidden', operations: [{ command: name, args: {} }] });
    assert.equal(data(result).error.code, 'UNSUPPORTED_COMMAND');
  }
  const saved = await nativeCall(context, 'save_edit_recipe', { documentId: doc.id, expectedRevision: doc.revision, name: 'Forbidden recipe', slots: [], steps: [{ command: 'import_image', args: { data: 'aaaa', mimeType: 'image/png' } }] });
  assert.equal(saved.isError, true);
  assert.equal(f.calls.some(item => item.command === 'apply_transaction' || item.command === 'save_edit_recipe'), false);
  assert.equal((await f.native.execute('get_document', { documentId: doc.id })).document.revision, doc.revision);
});

test('arguments are owned before capability waits and accessors never execute', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(); let reads = 0;
  const doc = (await f.native.execute('create_document', { width: 8, height: 8 })).document;
  const context = f.context({ execute: async request => {
    if (request.command === 'capabilities') { entered.resolve(); await release.promise; }
    return f.execute(request);
  } });
  const args = { name: 'apply_transaction', args: { documentId: doc.id, expectedRevision: doc.revision, label: 'Owned arguments', operations: [{ command: 'set_layer', args: { layerId: doc.layers[0].id, name: 'Original name' } }] } };
  const running = call(context, 'prism_execute', args); await entered.promise;
  args.args.operations[0].args.name = 'Changed after call'; release.resolve();
  assert.equal(data(await running).document.layers[0].name, 'Original name');
  const malicious = { name: 'set_layer', args: Object.defineProperty({}, 'documentId', { enumerable: true, get() { reads++; return doc.id; } }) };
  const before = f.calls.length; assert.equal((await call(context, 'prism_execute', malicious, 'getter')).isError, true);
  assert.equal(reads, 0); assert.equal(f.calls.length, before);
});

test('cancellation prevents undispatched edits and retains provenance of an accepted native result', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  const stopped = f.context({ signal: controller.signal });
  assert.equal(data(await nativeCall(stopped, 'create_document', { width: 8, height: 8 })).error.code, 'CHAT_CANCELLED');
  assert.equal(f.calls.length, 0);
  for (const phase of ['capabilities', 'create_document']) {
    const entered = deferred(), release = deferred(), docs = [];
    const context = f.context({ onDocument: async doc => docs.push(doc), execute: async request => {
      if (request.command === phase) { entered.resolve(); await release.promise; }
      return f.execute(request);
    } });
    const before = (await f.native.execute('list_documents')).documents.length;
    const running = nativeCall(context, 'create_document', { name: 'Cancellation fixture', width: 8, height: 8 }, phase); await entered.promise;
    const closing = context.close(); release.resolve(); const result = await running; await closing;
    assert.equal(data(result).error.code, 'CHAT_CANCELLED');
    const after = (await f.native.execute('list_documents')).documents.length;
    assert.equal(after - before, phase === 'capabilities' ? 0 : 1);
    assert.equal(docs.length, phase === 'capabilities' ? 0 : 1, 'Accepted native results remain recorded after Stop.');
  }
});

test('generation refuses unavailable workers and overrides before creating a durable request', async t => {
  const f = await fixture(t), context = f.context();
  for (const extra of [{ provider: 'openai' }, { mode: 'edit' }, { model: 'external-model' }, { requestId: 'user-owned' }]) {
    assert.equal((await call(context, 'prism_generate_image', { prompt: 'Test', ...extra })).isError, true);
  }
  f.worker.available = false;
  const result = await call(context, 'prism_generate_image', { prompt: 'Test' });
  assert.equal(data(result).error.code, 'CODEX_WORKER_UNAVAILABLE');
  assert.equal(f.generation.list().jobs.length, 0); assert.equal(f.generated(), 0);
});

test('generation tools wait on the durable worker and return exact applied document previews', async t => {
  const f = await fixture(t), events = [];
  const context = f.context({ onGeneration: async id => {
    f.jobs.push(id); assert.equal(f.generation.get(id).job.automation?.state, f.generated() ? undefined : 'queued');
    await f.worker.tick();
  }, onEvent: async event => events.push(event) });
  const input = { prompt: 'An authored blue fixture', size: 'auto' };
  const result = await call(context, 'prism_generate_image', input, 'one-image');
  assert.equal(result.isError, undefined); assert.equal(data(result).job.status, 'succeeded');
  assert.equal(data(result).document.layers.length, 1); assert.equal(result.content.at(-1).type, 'image');
  assert.equal(f.generated(), 1); assert.equal(f.jobs.length, 1); assert.equal(f.documents.at(-1).id, data(result).document.id);
  const again = await call(context, 'prism_generate_image', input, 'one-image');
  assert.equal(data(again).job.id, data(result).job.id); assert.equal(f.generated(), 1);
  assert.equal((await f.native.execute('list_documents')).documents.length, 1);
  assert.equal(events[0].type, 'generation');
});

test('aborting a generation wait cancels only the job owned by this turn', async t => {
  const f = await fixture(t), entered = deferred();
  const other = (await f.generation.start({ mode: 'generate', prompt: 'Other user request' })).job;
  const context = f.context({ onGeneration: async id => { f.jobs.push(id); entered.resolve(); } });
  const running = call(context, 'prism_generate_image', { prompt: 'Turn-owned request' });
  await entered.promise; await context.close();
  assert.equal(data(await running).error.code, 'CHAT_CANCELLED');
  assert.equal(f.generation.get(f.jobs[0]).job.status, 'cancelled');
  assert.equal(f.generation.get(other.id).job.automation.state, 'queued');
  assert.equal(f.generated(), 0);
});

test('stale generated edits remain ready without rebase or silent application', async t => {
  const f = await fixture(t);
  let doc = (await f.native.execute('create_document', { width: 8, height: 8, background: '#804020' })).document;
  const original = await f.native.renderGraph(doc);
  const context = f.context({ onGeneration: async id => {
    f.jobs.push(id);
    doc = (await f.native.execute('set_layer', { documentId: doc.id, expectedRevision: doc.revision, layerId: doc.layers[0].id, name: 'User changed the document' })).document;
    await f.worker.tick();
  } });
  const result = await call(context, 'prism_edit_image', { prompt: 'Make the image blue', documentId: doc.id, expectedRevision: doc.revision });
  assert.equal(data(result).job.status, 'ready'); assert.equal(data(result).job.error.code, 'REVISION_CONFLICT');
  assert.match(data(result).action, /explicitly/); assert.equal(result.content.some(item => item.type === 'image'), false);
  assert.deepEqual(await f.native.renderGraph(doc), original);
  assert.equal(f.documents.length, 0); assert.equal(f.generated(), 1);
  assert.equal((await f.native.execute('get_document', { documentId: doc.id })).document.revision, doc.revision);
});

test('failed generation provenance persistence cancels the newly created job before it can run', async t => {
  const f = await fixture(t);
  const context = f.context({ onGeneration: async id => { f.jobs.push(id); throw Object.assign(Error('private-storage-path'), { code: 'EIO' }); } });
  const result = await call(context, 'prism_generate_image', { prompt: 'Do not leave an orphan request' });
  assert.equal(result.isError, true); assert.equal(data(result).error.code, 'CHAT_TOOL_FAILED');
  assert.equal(JSON.stringify(result).includes('private-storage-path'), false);
  assert.equal(f.generation.get(f.jobs[0]).job.status, 'cancelled');
  await f.worker.tick(); assert.equal(f.generated(), 0);
});
