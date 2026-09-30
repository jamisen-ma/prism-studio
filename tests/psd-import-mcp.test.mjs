import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCompanion } from '../server/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(root, 'tests/fixtures/psd-import');
const hash = data => createHash('sha256').update(data).digest('hex');
const value = response => { assert.notEqual(response.isError, true, JSON.stringify(response.content)); return response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text); };
const failure = response => { assert.equal(response.isError, true); const text = response.content.find(item => item.type === 'text').text; try { return JSON.parse(text); } catch { return { message: text }; } };

function compose(expected) {
  const { width, height } = expected, output = Buffer.alloc(width * height * 4);
  for (const layer of expected.layers) {
    if (!layer.visible) continue;
    const [left, top, right, bottom] = layer.bounds, sourceWidth = right - left;
    for (let y = Math.max(0, top); y < Math.min(height, bottom); y++) for (let x = Math.max(0, left); x < Math.min(width, right); x++) {
      const at = (y * width + x) * 4, sourceAt = ((y - top) * sourceWidth + x - left) * 4;
      let mask = 255;
      if (layer.mask) {
        const [mx, my, mr, mb] = layer.maskBounds;
        mask = x >= mx && x < mr && y >= my && y < mb ? layer.mask[(y - my) * (mr - mx) + x - mx] : layer.maskDefault;
      }
      const sourceAlpha = layer.rgba[sourceAt + 3] / 255 * layer.opacity / 255 * mask / 255, baseAlpha = output[at + 3] / 255, alpha = sourceAlpha + baseAlpha * (1 - sourceAlpha);
      if (!alpha) continue;
      for (let channel = 0; channel < 3; channel++) output[at + channel] = Math.round((layer.rgba[sourceAt + channel] * sourceAlpha + output[at + channel] * baseAlpha * (1 - sourceAlpha)) / alpha);
      output[at + 3] = Math.round(alpha * 255);
    }
  }
  return output;
}

test('official MCP imports independently produced raw/PackBits PSD layers, preserves exact originals and recovers receipts after restart', { timeout: 45000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-psd-import-mcp-'));
  let companion, client, origin, stderr = ''; const tokens = [];
  async function start() {
    companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => { throw Error('No keys'); }, imageProvider: async () => { throw Error('No provider'); } });
    origin = `http://127.0.0.1:${await companion.listen()}`; tokens.push(companion.token);
    client = new Client({ name: 'psd-import-mcp-verification', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: origin, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
    transport.stderr?.on('data', chunk => { stderr += chunk; }); await client.connect(transport);
  }
  t.after(async () => { await client?.close(); await companion?.close(); await fs.rm(dataDir, { recursive: true, force: true }); for (const token of tokens) assert.ok(!stderr.includes(token)); });
  await start();
  const call = (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args });
  const caps = value(await call('capabilities', { backend: 'native' })); assert.deepEqual(caps.layeredImportFormats, ['psd']); assert.equal(caps.psdImportPolicy, 'rgb8-flat-raster-v1');
  assert.deepEqual(value(await call('status')).backends.find(item => item.id === 'native').layeredImportFormats, caps.layeredImportFormats);
  const existing = value(await call('create_document', { backend: 'native', name: 'Existing stays intact', width: 9, height: 6, background: '#294967' })).document;
  const expectedFiles = JSON.parse(await fs.readFile(path.join(fixtureDir, 'expected.json'), 'utf8'));
  const assetDir = path.join(dataDir, 'native/assets'), projectDir = path.join(dataDir, 'native/projects');
  const initialAssets = await fs.readdir(assetDir), initialProjects = await fs.readdir(projectDir);
  let document, replayArgs, firstDocument, firstSource;
  for (const [index, expected] of expectedFiles.entries()) {
    const filename = path.join(fixtureDir, expected.filename), data = await fs.readFile(filename);
    const untagged = value(await call('inspect_psd_import_file', { path: filename })); assert.equal(untagged.supported, false); assert.equal(untagged.requiresSrgbAssumption, true);
    const report = value(await call('inspect_psd_import_file', { path: filename, assumeSrgb: true }));
    assert.equal(report.supported, true); assert.equal(report.validation, 'complete'); assert.equal(report.input.sha256, hash(data)); assert.equal(report.input.bytes, data.length); assert.equal(report.document.layerCount, 3);
    if (!index) { assert.deepEqual(await fs.readdir(assetDir), initialAssets); assert.deepEqual(await fs.readdir(projectDir), initialProjects); }
    const args = { path: filename, assumeSrgb: true, expectedSha256: report.input.sha256, importerVersion: report.importerVersion, requestId: `independent-import-${index}` };
    const imported = value(await call('import_psd_file', args)); document = imported.document;
    assert.equal(imported.historyIncluded, false); assert.equal(document.revision, 1); assert.equal(document.history.length, 1); assert.equal(document.layers.length, 3);
    assert.deepEqual(document.layers.map(layer => layer.name), expected.layers.map(layer => layer.name));
    assert.equal(document.sourceDocument.format, 'psd'); assert.equal(document.sourceDocument.asset, hash(data)); assert.equal(document.sourceDocument.bytes, data.length);
    for (let layerIndex = 0; layerIndex < document.layers.length; layerIndex++) {
      const layer = document.layers[layerIndex], original = expected.layers[layerIndex];
      assert.equal(layer.visible, original.visible); assert.equal(layer.opacity, original.opacity / 255); assert.equal(layer.blendMode, 'normal'); assert.ok(!layer.protected);
      const source = await sharp(await fs.readFile(path.join(assetDir, layer.sourceAsset))).ensureAlpha().raw().toBuffer(); assert.deepEqual(source, Buffer.from(original.rgba));
    }
    const preview = await call('get_preview', { backend: 'native', documentId: document.id, maxWidth: 32 }); value(preview);
    const pixels = await sharp(Buffer.from(preview.content.find(item => item.type === 'image').data, 'base64')).ensureAlpha().raw().toBuffer(); assert.deepEqual(pixels, compose(expected));
    assert.equal(value(await call('import_psd_file', args)).document.id, document.id);
    assert.equal(failure(await call('import_psd_file', { ...args, name: 'Conflict' })).code, 'REQUEST_CONFLICT');
    const archive = value(await call('export_original_psd', { documentId: document.id, expectedRevision: document.revision }));
    assert.equal(archive.sha256, hash(data)); assert.equal(archive.original, true); assert.deepEqual(await fs.readFile(archive.path), data); assert.equal((await fs.stat(archive.path)).mode & 0o777, 0o600);
    if (!index) { replayArgs = args; firstDocument = document; firstSource = data; }
  }
  const args = { backend: 'native', documentId: firstDocument.id };
  document = value(await call('add_layer_filter', { ...args, expectedRevision: firstDocument.revision, layerId: firstDocument.layers.at(-1).id, kind: 'brightness', value: 20 })).document;
  const archive = value(await call('export_original_psd', { documentId: document.id, expectedRevision: document.revision })); assert.deepEqual(await fs.readFile(archive.path), firstSource);
  assert.equal(failure(await call('export_original_psd', { documentId: document.id, expectedRevision: 1 })).code, 'REVISION_CONFLICT');
  assert.equal(failure(await call('export_original_psd', { documentId: existing.id })).code, 'NO_SOURCE_DOCUMENT');
  const portable = value(await call('export_project', { documentId: document.id, expectedRevision: document.revision }));
  const restored = value(await call('import_project_file', { path: portable.path, requestId: 'portable-psd-source' })).document;
  assert.deepEqual(restored.layers, document.layers); assert.deepEqual(restored.sourceDocument, document.sourceDocument);
  assert.deepEqual(await fs.readFile(value(await call('export_original_psd', { documentId: restored.id })).path), firstSource);
  assert.deepEqual(value(await call('get_document', { backend: 'native', documentId: existing.id })).document, existing);
  const countBefore = value(await call('list_documents', { backend: 'native' })).documents.length;
  await client.close(); client = undefined; await companion.close(); companion = undefined; await start();
  const recovered = value(await call('import_psd_file', replayArgs)); assert.equal(recovered.document.id, firstDocument.id); assert.equal(recovered.document.revision, document.revision);
  assert.equal(value(await call('list_documents', { backend: 'native' })).documents.length, countBefore);
  assert.deepEqual(await fs.readFile(value(await call('export_original_psd', { documentId: document.id })).path), firstSource);
});
