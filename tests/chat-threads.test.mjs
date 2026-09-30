import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCompanion } from '../server/index.mjs';

const deny = () => assert.fail('Chat thread tests never invoke real Codex, generation, or API credentials.');
const until = async (check, timeout = 10_000) => { const deadline = Date.now() + timeout; for (;;) { const value = await check(); if (value) return value; if (Date.now() > deadline) throw new Error('Timed out waiting for chat work.'); await new Promise(resolve => setTimeout(resolve, 20)); } };

test('each canvas has its own chat history; a result document continues the conversation that created it', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-chat-threads-'));
  const histories = new Map();
  let resultDocumentId;
  const app = await createCompanion({ dataDir, port: 0, chatEnabled: true, imageProvider: deny, getImageKey: deny, chatAdapter: {
    check: async () => ({ available: true }),
    run: async args => {
      histories.set(args.turn.requestId, args.history.filter(entry => entry.role === 'user').map(entry => entry.content));
      if (args.turn.requestId === 'a-creates') {
        // Create a new canvas through the real tool route, which records it as this turn's result.
        const call = async (name, nativeArgs) => { const response = await fetch(`${args.toolContext.baseUrl}/api/chat/${args.turn.id}/tool`, { method: 'POST', headers: { Authorization: `Bearer ${args.toolContext.capabilityToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'prism_execute', arguments: { name, args: nativeArgs }, callId: randomUUID() }) }); assert.equal(response.status, 200); return (await response.json()).structuredContent; };
        const result = await call('create_document', { name: 'Made from A', width: 8, height: 8, background: '#333333' });
        assert.ok(result?.document?.id, JSON.stringify(result)); resultDocumentId = result.document.id;
      }
      return { reply: `Done: ${args.turn.message}` };
    },
  } });
  const baseUrl = `http://127.0.0.1:${await app.listen()}`;
  t.after(async () => { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const a = (await app.native.execute('create_document', { name: 'Canvas A', width: 8, height: 8, background: '#111111' })).document;
  const b = (await app.native.execute('create_document', { name: 'Canvas B', width: 8, height: 8, background: '#222222' })).document;
  const send = async (message, requestId, documentId) => {
    const response = await fetch(`${baseUrl}/api/chat`, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message, requestId, documentId }) });
    assert.equal(response.status, 202);
    const { turn } = await response.json();
    const done = await until(async () => (await app.chat.list()).turns.find(item => item.id === turn.id && !['queued', 'running'].includes(item.status)));
    assert.equal(done.status, 'succeeded', `${requestId}: ${done.error?.message}`);
    return done;
  };
  await send('Warm canvas A', 'a-first', a.id);
  await send('Title on canvas B', 'b-first', b.id);
  await send('Brighter canvas A', 'a-second', a.id);
  assert.deepEqual(histories.get('a-second'), ['Warm canvas A'], 'Canvas A only remembers canvas A');
  await send('Blur canvas B', 'b-second', b.id);
  assert.deepEqual(histories.get('b-second'), ['Title on canvas B'], 'Canvas B only remembers canvas B');
  const creating = await send('Make a new image from A', 'a-creates', a.id);
  assert.equal(creating.resultDocumentId, resultDocumentId);
  await send('Now add a border', 'result-follow-up', resultDocumentId);
  assert.deepEqual(histories.get('result-follow-up'), ['Make a new image from A'], 'The new document continues from the turn that created it');
  const fresh = (await app.native.execute('create_document', { name: 'Brand new', width: 8, height: 8, background: '#444444' })).document;
  await send('Start fresh', 'fresh', fresh.id);
  assert.deepEqual(histories.get('fresh'), [], 'A new canvas starts with an empty conversation');
});
