import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { ChatManager, normalizeChatRequest } from '../server/chat.mjs';
import { createCompanion } from '../server/index.mjs';

const deny = () => assert.fail('Attachment tests never invoke real Codex, generation, or API credentials.');
const request = (attachments, requestId = 'attachments') => ({ message: 'Edit the attached photo', requestId, attachments });
async function until(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Timed out waiting for isolated chat work.');
}
async function metadataFixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-chat-attachments-'));
  const documents = new Map(), reads = [], managers = [];
  const native = { execute: async (command, { documentId }) => {
    assert.equal(command, 'get_document'); reads.push(documentId);
    const document = documents.get(documentId);
    if (!document) throw Object.assign(new Error('Document does not exist.'), { code: 'NOT_FOUND' });
    return { document: structuredClone(document) };
  } };
  const make = async (overrides = {}) => {
    const manager = new ChatManager({ dataDir, native, generation: { get: deny }, enabled: true, adapter: { check: async () => ({ available: true }), run: deny }, createToolContext: deny, ...overrides });
    await manager.init(); manager.kick = () => {}; managers.push(manager); return manager;
  };
  t.after(async () => { for (const manager of managers) await manager.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const add = name => { const document = { id: randomUUID(), name, layers: [] }; documents.set(document.id, document); return document; };
  return { dataDir, documents, reads, make, add, manager: await make() };
}

test('chat attachments strictly own at most eight unique document references without invoking accessors', () => {
  const ids = Array.from({ length: 9 }, () => randomUUID());
  const attachments = ids.slice(0, 8).map(documentId => ({ documentId }));
  const normalized = normalizeChatRequest(request(attachments));
  attachments[0].documentId = ids[8]; attachments.pop();
  assert.deepEqual(normalized.attachments.map(item => item.documentId), ids.slice(0, 8));
  assert.deepEqual(normalizeChatRequest(request([])), { message: 'Edit the attached photo', requestId: 'attachments' });
  assert.deepEqual(normalizeChatRequest(request([{ documentId: ids[0].toUpperCase(), name: '  Advisory name  ' }])).attachments, [{ documentId: ids[0], name: 'Advisory name' }]);
  const invalid = [null, {}, ids.map(documentId => ({ documentId })), new Array(1), [{ documentId: ids[0] }, { documentId: ids[0].toUpperCase() }],
    [{ documentId: 'missing' }], [{ documentId: `${ids[0]}\n` }], [{ documentId: ids[0], name: '' }], [{ documentId: ids[0], name: 'x'.repeat(201) }],
    [{ documentId: ids[0], name: undefined }], [{ documentId: ids[0], data: 'image bytes forbidden' }], [Object.create({ documentId: ids[0] })]];
  for (const value of invalid) assert.throws(() => normalizeChatRequest(request(value)), { code: 'INVALID_ARGUMENTS' });
  let getters = 0;
  for (const key of ['documentId', 'name']) {
    const entry = { documentId: ids[0] }; Object.defineProperty(entry, key, { enumerable: true, get() { getters++; return ids[0]; } });
    assert.throws(() => normalizeChatRequest(request([entry])), { code: 'INVALID_ARGUMENTS' });
  }
  const array = []; Object.defineProperty(array, '0', { enumerable: true, get() { getters++; return { documentId: ids[0] }; } });
  assert.throws(() => normalizeChatRequest(request(array)), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => normalizeChatRequest({ message: 'Test', requestId: 'getter', get attachments() { getters++; return []; } }), { code: 'INVALID_ARGUMENTS' });
  assert.equal(getters, 0);
});

test('chat attachment acceptance resolves authoritative names, owns queued input, and rejects missing documents before persistence', async t => {
  const f = await metadataFixture(t), first = f.add('Original photo.png'), second = f.add('Second photo.png');
  let release; const barrier = new Promise(resolve => { release = resolve; });
  const locked = f.manager.locked(() => barrier);
  const input = request([{ documentId: first.id, name: 'Untrusted display name' }]);
  const pending = f.manager.start(input); input.attachments[0].documentId = second.id; input.attachments[0].name = 'Changed'; input.attachments.push({ documentId: second.id });
  release(); await locked;
  const { turn } = await pending;
  assert.deepEqual(turn.attachments, [{ documentId: first.id, name: first.name }]);
  turn.attachments[0].name = 'Changed public result';
  assert.deepEqual((await f.manager.list()).turns[0].attachments, [{ documentId: first.id, name: first.name }]);
  const bytes = await fs.readFile(path.join(f.dataDir, 'chat', 'turns', `${turn.id}.json`), 'utf8');
  assert.ok(!bytes.includes('Untrusted display name')); assert.ok(!bytes.includes('Changed public result'));
  const before = await fs.readdir(f.manager.turnsDirectory);
  await assert.rejects(f.manager.start(request([{ documentId: second.id }, { documentId: randomUUID() }], 'missing')), { code: 'NOT_FOUND' });
  assert.deepEqual(await fs.readdir(f.manager.turnsDirectory), before); assert.equal(f.manager.turns.size, 1);
});

test('chat attachment retries use ordered document IDs and preserve accepted names after rename or deletion', async t => {
  const f = await metadataFixture(t), first = f.add('First.png'), second = f.add('Second.png');
  const input = request([{ documentId: first.id, name: 'spoof' }, { documentId: second.id }]);
  const accepted = (await f.manager.start(input)).turn;
  first.name = 'Renamed.png'; f.documents.delete(second.id); const reads = f.reads.length;
  const retried = (await f.manager.start({ ...input, attachments: [{ documentId: first.id.toUpperCase(), name: 'different advisory name' }, { documentId: second.id, name: 'also ignored' }] })).turn;
  assert.deepEqual(retried, accepted); assert.equal(f.reads.length, reads);
  for (const attachments of [input.attachments.toReversed(), [{ documentId: first.id }], [{ documentId: first.id }, { documentId: randomUUID() }]]) {
    await assert.rejects(f.manager.start({ ...input, attachments }), { code: 'IDEMPOTENCY_CONFLICT' });
  }
  assert.equal(f.reads.length, reads);
});

test('chat attachment metadata survives restart without reopening historical documents and rejects corrupted receipts', async t => {
  const f = await metadataFixture(t), photo = f.add('Saved reference.png');
  const input = request([{ documentId: photo.id }]);
  const attached = (await f.manager.start(input)).turn;
  const legacy = (await f.manager.start({ message: 'An older text-only message', requestId: 'legacy' })).turn;
  await f.manager.close(); f.documents.clear(); const reads = f.reads.length;
  const reopened = await f.make();
  assert.equal(f.reads.length, reads); assert.equal((await reopened.list()).turns.length, 2);
  const replay = (await reopened.start(input)).turn;
  assert.equal(replay.status, 'interrupted'); assert.deepEqual(replay.attachments, [{ documentId: photo.id, name: photo.name }]);
  assert.equal((await reopened.start({ message: legacy.message, requestId: legacy.requestId })).turn.id, legacy.id);
  const history = reopened.history({ createdAt: new Date(Date.parse(legacy.createdAt) + 1).toISOString() });
  assert.deepEqual(history[0].attachments, replay.attachments); history[0].attachments[0].name = 'Mutation';
  assert.equal((await reopened.list()).turns[0].attachments[0].name, photo.name);
  await reopened.close();
  const file = path.join(f.dataDir, 'chat', 'turns', `${attached.id}.json`), original = await fs.readFile(file, 'utf8'), record = JSON.parse(original);
  const corrupted = [
    { ...record, attachments: [{ documentId: photo.id }] },
    { ...record, attachments: [{ documentId: randomUUID(), name: photo.name }] },
    { ...record, attachments: [...record.attachments, ...record.attachments] },
    { ...record, attachments: [{ ...record.attachments[0], data: 'forbidden' }] },
    { ...record, attachments: [] },
    { ...record, fingerprint: '0'.repeat(64) },
  ];
  for (const changed of corrupted) {
    await fs.writeFile(file, JSON.stringify(changed)); await assert.rejects(f.make(), { code: 'INVALID_CHAT' });
  }
  await fs.writeFile(file, original); const validAgain = await f.make(); assert.equal((await validAgain.list()).turns.length, 2); assert.equal(f.reads.length, reads);
});

test('chat HTTP attachment workflow previews and edits the imported image instead of the open document and carries references into follow-up history', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-chat-attachment-http-'));
  let observed, history, failure, previews = 0;
  const app = await createCompanion({ dataDir, port: 0, chatEnabled: true, imageProvider: deny, getImageKey: deny, chatAdapter: {
    check: async () => ({ available: true }), run: async args => {
      try {
        if (args.turn.requestId === 'follow-up') { history = args.history; return { reply: 'The attached image remains available in this conversation.' }; }
        observed = args.turn;
        const call = async (name, nativeArgs) => {
          const response = await fetch(`${args.toolContext.baseUrl}/api/chat/${args.turn.id}/tool`, { method: 'POST', headers: { Authorization: `Bearer ${args.toolContext.capabilityToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'prism_execute', arguments: { name, args: nativeArgs }, callId: randomUUID() }) });
          assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent)); return result;
        };
        const documentId = args.turn.attachments[0].documentId;
        const document = (await call('get_document', { documentId })).structuredContent.document;
        const preview = await call('get_preview', { documentId, maxWidth: 32 });
        assert.ok(preview.content.some(item => item.type === 'image' && item.mimeType === 'image/png')); previews++;
        await call('add_adjustment', { documentId, expectedRevision: document.revision, kind: 'brightness', value: 20 });
        return { reply: 'Brightened the attached photo with an editable adjustment.' };
      } catch (cause) { failure = cause; throw cause; }
    },
  } });
  const baseUrl = `http://127.0.0.1:${await app.listen()}`;
  t.after(async () => { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#56789a' } }).png().toBuffer();
  const source = (await app.native.execute('import_image', { name: 'Attached image.png', data: png.toString('base64'), mimeType: 'image/png' })).document;
  const current = (await app.native.execute('create_document', { name: 'Unrelated open document', width: 8, height: 8, background: '#111111' })).document;
  const submit = async body => { const response = await fetch(`${baseUrl}/api/chat`, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(response.status, 202); return (await response.json()).turn; };
  const first = await submit({ ...request([{ documentId: source.id, name: 'Pretend name' }]), documentId: current.id });
  const terminal = id => until(async () => (await app.chat.list()).turns.find(turn => turn.id === id && !['queued', 'running'].includes(turn.status)));
  const done = await terminal(first.id); assert.equal(done.status, 'succeeded', failure?.stack); assert.equal(done.resultDocumentId, source.id); assert.equal(previews, 1);
  assert.deepEqual(observed.attachments, [{ documentId: source.id, name: source.name }]);
  assert.equal((await app.native.execute('get_document', { documentId: current.id })).document.revision, current.revision);
  const edited = (await app.native.execute('get_document', { documentId: source.id })).document;
  assert.equal(edited.revision, source.revision + 1); assert.equal(edited.layers.at(-1).kind, 'brightness');
  const followUp = await submit({ message: 'Keep that image as a reference', requestId: 'follow-up', documentId: current.id });
  assert.equal((await terminal(followUp.id)).status, 'succeeded');
  assert.deepEqual(history[0].attachments, done.attachments); assert.equal(history[1].resultDocumentId, source.id);
  const publicList = await fetch(`${baseUrl}/api/chat`, { headers: { Authorization: `Bearer ${app.token}` } });
  assert.deepEqual((await publicList.json()).turns[0].attachments, done.attachments);
  const receipt = await fs.readFile(path.join(dataDir, 'chat', 'turns', `${first.id}.json`), 'utf8');
  assert.ok(!receipt.includes(png.toString('base64'))); assert.ok(!receipt.includes('Pretend name')); assert.equal(JSON.parse(receipt).calls.length, 3);
});
