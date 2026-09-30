// Explicit real-model / real-MCP integration verification; never calls OpenAI.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCompanion } from '../server/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv[2];
if (!input) {
  console.error('Usage: npm run verify:segmentation:mcp -- path/to/photo.png [output-directory]');
  process.exit(1);
}
const original = await fs.readFile(path.resolve(input));
const installedData = path.resolve(process.env.PRISM_DATA_DIR || path.join(root, '.prism'));
const output = path.resolve(process.argv[3] || path.join(root, 'test-results/real-segmentation-mcp'));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-real-mcp-segmentation-'));
let companion, client;
let providerCalls = 0;
try {
  // Share read-only installed dependencies, not projects or credentials.
  for (const name of ['models', 'python-runtime']) await fs.symlink(path.join(installedData, name), path.join(temporary, name), process.platform === 'win32' ? 'junction' : 'dir');
  companion = await createCompanion({
    dataDir: temporary, port: 0, getImageKey: async () => null,
    imageProvider: async () => { providerCalls++; throw new Error('Provider calls are forbidden in this local check.'); },
  });
  const port = await companion.listen();
  client = new Client({ name: 'prism-real-local-verification', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root,
    env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: temporary }, stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  await client.connect(transport);
  async function call(name, args = {}) {
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 110_000 });
    assert.notEqual(response.isError, true, `MCP ${name} failed: ${JSON.stringify(response.content)}`);
    return response.structuredContent || JSON.parse(response.content.find(item => item.type === 'text').text);
  }
  const status = await call('prism_status');
  assert.equal(status.segmentation.installed, true, 'Install the local model and runtime first.');
  assert.equal(status.ai.configured, false, 'This check must not use provider credentials.');
  const tools = (await client.listTools()).tools;
  assert.ok(tools.every(tool => typeof tool.title === 'string' && tool.title.length > 0), 'Every tool needs a reviewable title.');
  const catalog = await call('prism_tool_catalog');
  assert.equal(catalog.photoshopReferenceCount, 71);
  assert.equal(catalog.nativeExtensionCount, 4);
  let document = (await call('prism_import_file', { path: path.resolve(input), name: 'Real local MCP verification', requestId: 'local-import-once' })).document;
  const source = document.layers[0];
  const sourcePixels = await companion.native.renderLayer(source);
  const start = performance.now();
  const extractArgs = { backend: 'native', documentId: document.id, expectedRevision: document.revision, layerId: source.id, requestId: 'real-extraction-once' };
  document = (await call('prism_extract_subject', extractArgs)).document;
  const elapsedMs = Math.round(performance.now() - start);
  assert.deepEqual((await call('prism_extract_subject', extractArgs)).document, document, 'A repeated MCP request must not run or apply extraction twice.');
  const cutout = document.layers.at(-1);
  const raw = await companion.native.renderLayer(cutout);
  for (let i = 0; i < raw.length; i += 4) assert.deepEqual(raw.subarray(i, i + 3), sourcePixels.subarray(i, i + 3));
  assert.deepEqual(await fs.readFile(path.join(temporary, 'native/assets', source.sourceAsset)), original);
  const alpha = await companion.native.readAlpha(cutout.alphaAsset, cutout.width, cutout.height);
  for (const view of ['layer', 'source', 'mask']) {
    const response = await client.callTool({ name: 'prism_get_layer_preview', arguments: { backend: 'native', documentId: document.id, layerId: cutout.id, view, maxWidth: 2400 } });
    assert.notEqual(response.isError, true, JSON.stringify(response.content));
    const content = response.content.find(item => item.type === 'image');
    assert.equal(content?.mimeType, 'image/png', 'Layer inspection must return an actual MCP image content block.');
    const inspected = await sharp(Buffer.from(content.data, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.ok(inspected.info.width > 0 && inspected.info.height > 0);
    if (document.width <= 2400 && view === 'mask') {
      for (let i = 0; i < alpha.length; i++) assert.equal(inspected.data[i * 4], alpha[i]);
    }
  }
  assert.deepEqual((await call('prism_get_document', { backend: 'native', documentId: document.id })).document, document, 'Inspection must not alter the graph, revision or history.');

  // A tiny source-alpha repair demonstrates real command wiring and one-step
  // undo without assuming which accessory an arbitrary input contains.
  let repairPixel = -1;
  for (let i = 0; i < raw.length; i += 4) if (sourcePixels[i + 3] === 255 && raw[i + 3] < 32) { repairPixel = i / 4; break; }
  let repaired = false;
  if (repairPixel >= 0) {
    const x = repairPixel % document.width, y = Math.floor(repairPixel / document.width);
    document = (await call('prism_select_rectangle', { backend: 'native', documentId: document.id, expectedRevision: document.revision, x, y, width: 1, height: 1 })).document;
    document = (await call('prism_refine_cutout_from_selection', { backend: 'native', documentId: document.id, expectedRevision: document.revision, layerId: cutout.id, mode: 'add' })).document;
    const restored = await companion.native.renderLayer(document.layers.at(-1));
    assert.deepEqual(restored.subarray(repairPixel * 4, repairPixel * 4 + 4), sourcePixels.subarray(repairPixel * 4, repairPixel * 4 + 4));
    document = (await call('prism_undo', { backend: 'native', documentId: document.id, expectedRevision: document.revision })).document;
    assert.deepEqual(await companion.native.renderLayer(document.layers.at(-1)), raw);
    repaired = true;
  }
  const exported = await call('prism_export_document', { backend: 'native', documentId: document.id, format: 'png' });
  const exportedBytes = await fs.readFile(exported.path);
  const decoded = await sharp(exportedBytes).ensureAlpha().raw().toBuffer();
  const actualComposite = await companion.native.render(companion.native.project(document.id));
  assert.deepEqual(decoded, actualComposite);
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'cutout.png'), exportedBytes);
  const report = {
    ok: true, path: 'Official MCP SDK → stdio → authenticated HTTP → native engine → real local Python model',
    elapsedMs, width: document.width, height: document.height,
    sourceBytesUnchanged: true, allSourceRgbUnchanged: true, duplicateExtractionAppliedOnce: true,
    layerOriginalAndMaskMcpImagesVerified: true, selectionRepairAndUndoVerified: repaired, exportedPixelsExact: true, providerCalls,
    nativeCommandCount: status.backends.find(backend => backend.id === 'native').commands.length,
    runtime: status.segmentation.runtime,
  };
  assert.equal(providerCalls, 0);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await client?.close();
  await companion?.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
