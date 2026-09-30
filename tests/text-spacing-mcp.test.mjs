import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCompanion } from '../server/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const value = response => { assert.notEqual(response.isError, true, JSON.stringify(response.content)); return response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text); };
const failure = response => { assert.equal(response.isError, true); const text = response.content.find(item => item.type === 'text').text; try { return JSON.parse(text); } catch { return { message: text }; } };

test('official MCP edits tracking and leading with exact Auto reset, atomic history, protection and portable/source preservation', { timeout: 30000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-text-spacing-mcp-'));
  let companion, client, stderr = '', forbiddenCalls = 0; const tokens = [];
  const forbidden = async () => { forbiddenCalls++; throw Error('Text editing is local'); };
  async function start() {
    companion = await createCompanion({ dataDir, port: 0, getImageKey: forbidden, imageProvider: forbidden, segmentSubject: forbidden }); const port = await companion.listen(); tokens.push(companion.token);
    client = new Client({ name: 'text-spacing-verification', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
    transport.stderr?.on('data', bytes => { stderr += bytes; }); await client.connect(transport);
  }
  t.after(async () => { await client?.close(); await companion?.close(); await fs.rm(dataDir, { recursive: true, force: true }); for (const token of tokens) assert.ok(!stderr.includes(token)); assert.equal(forbiddenCalls, 0); });
  await start();
  const call = (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args });
  const caps = value(await call('capabilities', { backend: 'native' })), status = value(await call('status')).backends.find(item => item.id === 'native');
  for (const [key, expected] of Object.entries({ textSpacingProperties: ['tracking', 'leading'], textTrackingUnits: 'thousandths-em', textLeadingUnits: 'source-pixels' })) { assert.deepEqual(caps[key], expected); assert.deepEqual(status[key], expected); }
  const tools = (await client.listTools()).tools;
  for (const name of ['prism_add_text', 'prism_update_text']) { const tool = tools.find(item => item.name === name); assert.ok(tool.inputSchema.properties.tracking); assert.ok(tool.inputSchema.properties.leading); assert.equal(tool.annotations.readOnlyHint, false); }
  const width = 800, height = 640, png = await sharp({ create: { width, height, channels: 4, background: '#ead9c3' } }).png().toBuffer(), input = path.join(dataDir, 'retained-background.png'); await fs.writeFile(input, png);
  let document = value(await call('import_file', { path: input, name: 'Type spacing fixture' })).document;
  const original = structuredClone(document.layers[0]), assetDir = path.join(dataDir, 'native/assets'), originalFiles = await fs.readdir(assetDir);
  const args = () => ({ backend: 'native', documentId: document.id });
  async function edit(command, fields = {}) { document = value(await call(command, { ...args(), expectedRevision: document.revision, ...fields })).document; }
  await edit('add_text', { text: 'AUTUMN\nOUTFITS', x: width / 2, y: 50, fontSize: 64, fontFamily: 'Fraunces', align: 'center', color: '#573c2d' });
  const textId = document.layers.at(-1).id, textLayer = () => document.layers.find(item => item.id === textId);
  async function preview(id = document.id) { const response = await call('get_layer_preview', { backend: 'native', documentId: id, layerId: textId, maxWidth: width }); value(response); return sharp(Buffer.from(response.content.find(item => item.type === 'image').data, 'base64')).ensureAlpha().raw().toBuffer(); }
  const legacy = await preview(); assert.equal(textLayer().tracking, undefined); assert.equal(textLayer().leading, undefined);
  await edit('update_text', { layerId: textId, leading: 180 }); const leadingOnly = await preview();
  assert.deepEqual(leadingOnly.subarray(0, width * 128 * 4), legacy.subarray(0, width * 128 * 4)); assert.notDeepEqual(leadingOnly, legacy);
  const once = { ...args(), expectedRevision: document.revision, layerId: textId, tracking: 100, requestId: 'tracking-once' }, history = document.history.length;
  document = value(await call('update_text', once)).document; assert.deepEqual(value(await call('update_text', once)).document, document); assert.equal(document.history.length, history + 1);
  assert.equal(textLayer().tracking, 100); assert.equal(textLayer().leading, 180); assert.notDeepEqual(await preview(), leadingOnly);
  await edit('update_text', { layerId: textId, fontSize: 80 }); assert.equal(textLayer().tracking, 100); assert.equal(textLayer().leading, 180);
  const spaced = await preview(), authored = structuredClone(document);
  const portable = value(await call('export_project', { documentId: document.id, expectedRevision: document.revision }));
  const restored = value(await call('import_project_file', { path: portable.path, requestId: 'spacing-portable' })).document;
  assert.deepEqual(restored.layers, document.layers); assert.deepEqual(await preview(restored.id), spaced);
  for (const fields of [{ tracking: 1001 }, { tracking: 0.5 }, { leading: 0 }, { leading: 'auto' }]) { failure(await call('update_text', { ...args(), layerId: textId, ...fields })); assert.deepEqual(value(await call('get_document', args())).document, authored); }
  assert.equal(failure(await call('update_text', { ...args(), expectedRevision: document.revision - 1, layerId: textId, leading: null })).code, 'REVISION_CONFLICT');
  failure(await call('apply_transaction', { ...args(), expectedRevision: document.revision, label: 'No partial spacing update', operations: [
    { command: 'update_text', args: { layerId: textId, tracking: -100, leading: null } }, { command: 'update_text', args: { layerId: 'missing', tracking: 5 } },
  ] })); assert.deepEqual(value(await call('get_document', args())).document, authored);
  await edit('apply_transaction', { label: 'Restore Auto type spacing', operations: [{ command: 'update_text', args: { layerId: textId, fontSize: 64, tracking: 0, leading: null } }] });
  assert.ok(!Object.hasOwn(textLayer(), 'tracking')); assert.ok(!Object.hasOwn(textLayer(), 'leading')); assert.deepEqual(await preview(), legacy);
  await edit('undo'); assert.deepEqual(document.layers, authored.layers); assert.deepEqual(await preview(), spaced);
  await edit('redo'); assert.deepEqual(await preview(), legacy);
  await edit('set_layer_protection', { layerId: textId, protected: true }); const protectedDoc = structuredClone(document);
  assert.equal(failure(await call('update_text', { ...args(), layerId: textId, tracking: 50 })).code, 'PROTECTED_LAYER'); assert.deepEqual(value(await call('get_document', args())).document, protectedDoc);
  await edit('set_layer_protection', { layerId: textId, protected: false });
  await edit('update_text', { layerId: textId, tracking: -40, leading: 150 });
  const persisted = structuredClone(document), finalPreview = await preview();
  assert.deepEqual(document.layers[0], original); assert.deepEqual(await fs.readdir(assetDir), originalFiles); assert.deepEqual(await fs.readFile(path.join(assetDir, original.sourceAsset)), png);
  await client.close(); await companion.close(); await start();
  document = value(await call('get_document', args())).document; assert.deepEqual(document, persisted); assert.deepEqual(await preview(), finalPreview); assert.deepEqual(await fs.readFile(input), png);
});
