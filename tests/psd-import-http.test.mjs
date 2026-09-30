import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCompanion } from '../server/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = data => createHash('sha256').update(data).digest('hex');

test('live PSD routes authenticate before parser access, expose explicit color interpretation and preserve source attachments through edits', { timeout: 15000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-psd-http-'));
  const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => { throw Error('No keys'); }, imageProvider: async () => { throw Error('No provider'); } });
  const origin = `http://127.0.0.1:${await companion.listen()}`;
  t.after(async () => { await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const data = await fs.readFile(path.join(root, 'tests/fixtures/psd-import/flat-rle.psd')), digest = hash(data);
  const headers = { Authorization: `Bearer ${companion.token}`, 'Content-Type': 'application/octet-stream' };
  let inspections = 0, imports = 0;
  const inspect = companion.native.inspectPsdImport.bind(companion.native), publish = companion.native.importPsd.bind(companion.native);
  companion.native.inspectPsdImport = args => { inspections++; return inspect(args); };
  companion.native.importPsd = args => { imports++; return publish(args); };
  for (const endpoint of ['inspect-import', 'import']) {
    for (const extra of [{ Authorization: 'Bearer wrong' }, { Origin: 'https://foreign.example' }]) {
      const response = await fetch(`${origin}/api/psd/${endpoint}`, { method: 'POST', headers: { ...headers, ...extra }, body: data });
      assert.ok([401, 403].includes(response.status));
    }
    // Fetch replaces Host; use an actual HTTP request to exercise Host gating.
    const status = await new Promise((resolve, reject) => {
      const request = http.request(`${origin}/api/psd/${endpoint}`, { method: 'POST', headers: { ...headers, Host: 'foreign.example', 'Content-Length': data.length } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      request.on('error', reject); request.end(data);
    });
    assert.equal(status, 403);
  }
  assert.equal(inspections, 0); assert.equal(imports, 0);
  const initialAssets = await fs.readdir(path.join(dataDir, 'native/assets')), initialProjects = await fs.readdir(path.join(dataDir, 'native/projects'));
  const untagged = await (await fetch(`${origin}/api/psd/inspect-import?sourceName=Foreign.psd`, { method: 'POST', headers, body: data })).json();
  assert.equal(untagged.supported, false); assert.equal(untagged.requiresSrgbAssumption, true);
  const report = await (await fetch(`${origin}/api/psd/inspect-import?assumeSrgb=true&sourceName=Foreign.psd`, { method: 'POST', headers, body: data })).json();
  assert.equal(report.supported, true); assert.equal(report.input.sha256, digest); assert.equal(report.validation, 'complete');
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'native/assets')), initialAssets); assert.deepEqual(await fs.readdir(path.join(dataDir, 'native/projects')), initialProjects);
  const importHeaders = { ...headers, 'X-Prism-Request-Id': 'http-foreign', 'X-Prism-Expected-Sha256': digest, 'X-Prism-Importer-Version': '1' };
  const imported = await fetch(`${origin}/api/psd/import?assumeSrgb=true&sourceName=Foreign.psd`, { method: 'POST', headers: importHeaders, body: data });
  assert.equal(imported.status, 200); let { document } = await imported.json(); assert.equal(imports, 1);
  const original = revision => `${origin}/api/psd/${document.id}/original${revision === undefined ? '' : `?expectedRevision=${revision}`}`;
  assert.equal((await fetch(original())).status, 401);
  const download = await fetch(original(document.revision), { headers });
  assert.equal(download.headers.get('content-type'), 'application/octet-stream'); assert.equal(download.headers.get('x-prism-source-sha256'), digest); assert.deepEqual(Buffer.from(await download.arrayBuffer()), data);
  document = (await companion.native.execute('set_layer', { documentId: document.id, expectedRevision: document.revision, layerId: document.layers.at(-1).id, name: 'Edited native layer' })).document;
  assert.equal((await fetch(original(1), { headers })).status, 409);
  const latest = await fetch(original(document.revision), { headers }); assert.deepEqual(Buffer.from(await latest.arrayBuffer()), data);
  const archive = path.join(dataDir, 'native/assets', digest), corrupt = Buffer.from(data); corrupt[corrupt.length - 1] ^= 1;
  await fs.writeFile(archive, corrupt);
  const bad = await fetch(original(document.revision), { headers }); assert.equal(bad.status, 400); assert.equal((await bad.json()).error.code, 'INVALID_PROJECT_BUNDLE');
  await fs.writeFile(archive, data); const recovered = await fetch(original(document.revision), { headers }); assert.deepEqual(Buffer.from(await recovered.arrayBuffer()), data);
  const repeat = await (await fetch(`${origin}/api/psd/import?assumeSrgb=true&sourceName=Foreign.psd`, { method: 'POST', headers: importHeaders, body: data })).json();
  assert.equal(repeat.document.id, document.id); assert.equal(repeat.document.revision, document.revision); assert.equal(imports, 1);
  assert.equal((await companion.native.execute('list_documents', {})).documents.length, 1);
});
