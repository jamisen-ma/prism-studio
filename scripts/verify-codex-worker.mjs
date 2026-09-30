// Explicit live smoke test: consumes one built-in Codex image-generation request.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCompanion } from '../server/index.mjs';

if (!process.argv.includes('--live')) throw new Error('Pass --live to generate one real image using the signed-in Codex account.');
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-live-codex-'));
let app;
try {
  app = await createCompanion({ dataDir, port: 0, codexWorkerEnabled: true,
    getImageKey: async () => { throw new Error('Unexpected API credential read'); },
    imageProvider: async () => { throw new Error('Unexpected API generation'); },
  });
  await app.listen();
  assert.equal(app.codexWorker.status().available, true, 'Local Codex must be signed in with image generation available');
  const { job } = await app.generation.start({ mode: 'generate', size: '1024x1024', name: 'Automatic Codex verification',
    prompt: 'A warm cream paper background with subtle peach watercolor at the edges and one delicate autumn leaf in a corner. Simple, uncluttered. No people, text, logos or watermarks.',
    requestId: 'automatic-codex-live-verification',
  });
  console.log('Queued a real Codex image; waiting for the automatic five-second poll.');
  const deadline = Date.now() + 11 * 60 * 1000;
  while (Date.now() < deadline) {
    const current = app.generation.get(job.id).job;
    if (current.status === 'succeeded') break;
    if (['failed', 'interrupted'].includes(current.automation?.state)) throw new Error(`Codex automation ${current.automation.state}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const result = app.generation.get(job.id).job;
  assert.equal(result.status, 'succeeded');
  const output = (await app.generation.output(job.id)).data;
  const directory = path.resolve('test-results'); await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'automatic-codex-live.png'), output);
  const documents = await app.native.execute('list_documents');
  assert.equal(documents.documents.length, 1);
  const receipt = { status: result.status, documents: documents.documents.length, bytes: output.length, sha256: createHash('sha256').update(output).digest('hex'), completedAt: new Date().toISOString() };
  await fs.writeFile(path.join(directory, 'automatic-codex-live.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
} finally { await app?.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
