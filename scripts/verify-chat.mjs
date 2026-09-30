// Opt-in live check: one generated image plus conventional editable text work.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createCompanion } from '../server/index.mjs';

if (!process.argv.includes('--live')) throw new Error('Pass --live to run the signed-in Codex agent and generate one real image.');
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-chat-live-'));
let app;
async function run(message, documentId) {
  const { turn } = await app.chat.start({ message, requestId: randomUUID(), ...(documentId ? { documentId } : {}) });
  const deadline = Date.now() + 21 * 60 * 1000;
  let previous = '';
  while (Date.now() < deadline) {
    const latest = (await app.chat.list()).turns.find(item => item.id === turn.id);
    const progress = `${latest.status}: ${latest.events.at(-1)?.label ?? 'Starting local agent'}`;
    if (progress !== previous) { console.log(progress); previous = progress; }
    if (!['queued', 'running'].includes(latest.status)) {
      console.log(JSON.stringify({ status: latest.status, reply: latest.reply, error: latest.error, resultDocumentId: latest.resultDocumentId }));
      assert.equal(latest.status, 'succeeded'); return latest;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Live chat check timed out.');
}
try {
  app = await createCompanion({ dataDir, port: 0, chatEnabled: true, codexWorkerEnabled: true,
    getImageKey: async () => { throw new Error('Unexpected optional API credential read'); },
    imageProvider: async () => { throw new Error('Unexpected optional API generation'); },
  });
  await app.listen();
  const first = await run('Create a square warm cream paper background with subtle peach watercolor edges and one delicate autumn leaf. Add chocolate-brown text "AUTUMN" near the top as a separate editable text layer. Keep the background as an image layer. No other text or elements.');
  assert.ok(first.resultDocumentId);
  const doc = (await app.native.execute('get_document', { documentId: first.resultDocumentId })).document;
  const title = doc.layers.find(layer => layer.type === 'text' && layer.text === 'AUTUMN');
  assert.ok(title, 'Mixed request must use real editable text');
  assert.equal(app.generation.list().jobs.length, 1, 'One actual generation');
  assert.equal(app.generation.list().jobs[0].status, 'succeeded');
  const second = await run('Change the title to "OUTFITS" and make it smaller. Keep the existing background unchanged and keep the title editable.', doc.id);
  const updated = (await app.native.execute('get_document', { documentId: doc.id })).document;
  assert.equal(app.generation.list().jobs.length, 1, 'Editing follow-up must not regenerate');
  assert.deepEqual(updated.layers.filter(layer => layer.id !== title.id), doc.layers.filter(layer => layer.id !== title.id), 'Follow-up must preserve every other layer');
  assert.ok(updated.layers.some(layer => layer.id === title.id && layer.type === 'text' && layer.text === 'OUTFITS' && layer.fontSize < title.fontSize));
  const image = await app.native.execute('export_document', { documentId: doc.id, format: 'png' });
  await fs.mkdir('test-results', { recursive: true });
  await fs.writeFile('test-results/chat-live.png', Buffer.from(image.data, 'base64'));
  const report = { completedAt: new Date().toISOString(), turns: [first, second], generationRequests: app.generation.list().jobs.length,
    document: { width: updated.width, height: updated.height, layers: updated.layers.map(layer => ({ type: layer.type, text: layer.text })) } };
  await fs.writeFile('test-results/chat-live.json', JSON.stringify(report, null, 2) + '\n');
  console.log('LIVE CHAT PASSED: generated background + editable text, then conventional follow-up without regeneration.');
} finally { await app?.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
