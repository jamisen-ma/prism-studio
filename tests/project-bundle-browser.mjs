import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { createCompanion } from '../server/index.mjs';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-project-browser-'));
const artifacts = path.resolve('test-results'); await fs.mkdir(artifacts, { recursive: true });
let keyReads = 0, providerCalls = 0;
const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => { keyReads++; return null; }, imageProvider: async () => { providerCalls++; throw Error('Project transfer never generates images.'); } });
const width = 160, height = 120, raw = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set([x % 256, (y * 2) % 256, 147, x < 20 ? 128 : 255], (y * width + x) * 4);
const source = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
let document = (await companion.native.execute('import_image', { name: 'Editable transfer fixture', data: source.toString('base64'), mimeType: 'image/png' })).document;
const seed = async (command, args) => { document = (await companion.native.execute(command, { documentId: document.id, ...args })).document; };
await seed('add_shape', { name: 'Editable card', shape: 'rectangle', x: 30, y: 20, width: 100, height: 80, fill: '#274f6f', radius: 9 });
await seed('set_layer_mask', { layerId: document.layers.at(-1).id, mask: { shape: 'ellipse', x: 25, y: 15, width: 110, height: 90, feather: 3 } });
await seed('group_layers', { layerIds: document.layers.map(layer => layer.id), name: 'Artwork group' });
await seed('add_text', { name: 'Editable title', text: 'PRISM', x: 42, y: 52, fontSize: 18, color: '#ffffff', fontFamily: 'Fraunces' });
await seed('select_region', { shape: 'ellipse', x: 25, y: 15, width: 110, height: 90, feather: 4 });
await seed('save_selection', { name: 'Card area' });
const original = structuredClone(document), originalId = original.id;
const assets = new Map();
for (const layer of original.layers) for (const field of ['asset', 'sourceAsset', 'alphaAsset']) if (layer[field]) assets.set(layer[field], await fs.readFile(path.join(companion.native.assetsDir, layer[field])));
const baseUrl = `http://127.0.0.1:${await companion.listen()}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(12000);
const errors = [], transfers = [], checkpoints = [];
let expectedTransferError = false;
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error' && !expectedTransferError) errors.push(message.text()); });
page.on('request', request => { if (request.url().includes('/api/projects/')) transfers.push({ method: request.method(), url: request.url(), headers: request.headers(), data: request.postDataBuffer() }); });
await page.route('https://**', route => route.abort());
const dialog = page.getByRole('dialog');
const current = async () => (await companion.native.execute('get_document', { documentId: await page.getByLabel('Open document').inputValue() })).document;
const documents = async () => (await companion.native.execute('list_documents', {})).documents;
const pixels = async documentId => { const result = await companion.native.execute('get_preview', { documentId, maxWidth: width }); return sharp(Buffer.from(result.data, 'base64')).ensureAlpha().raw().toBuffer(); };
const settled = async () => { await expect(page.locator('.save-status .spin')).toHaveCount(0); await expect(page.getByRole('alert')).toHaveCount(0); };
const baseline = await pixels(originalId);
async function openFileMenu() { await page.getByRole('button', { name: 'File', exact: true }).click(); }
async function pickProject(file) { await openFileMenu(); const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: 'Open project', exact: true }).click(); await (await chooser).setFiles(file); }
function checkpoint(message) { checkpoints.push(message); console.log(`Verified: ${message}`); }
function editableShape(doc) {
  return doc.layers.map(layer => Object.fromEntries(['name', 'type', 'visible', 'opacity', 'blendMode', 'mode', 'asset', 'sourceAsset', 'alphaAsset', 'sourceFormat', 'width', 'height', 'mask', 'vector', 'gradient', 'text', 'x', 'y', 'fontSize', 'fontFamily', 'fontWeight', 'fontStyle', 'align', 'color', 'effects', 'protected', 'transforms'].filter(key => layer[key] !== undefined).map(key => [key, layer[key]]).concat([['parentName', doc.layers.find(parent => parent.id === layer.parentId)?.name || null]])));
}
try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' }); await expect(page.locator('.artboard img')).toBeVisible(); await settled();
  await openFileMenu(); await page.getByRole('button', { name: 'Download project', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Editable project', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByText(/Undo history is not included/)).toBeVisible();
  await expect(dialog.getByText(/editable layers, groups, masks, saved selections/)).toBeVisible();
  await page.screenshot({ path: path.join(artifacts, 'editable-project-download.png'), animations: 'disabled' });
  const downloading = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'Download .prism project', exact: true }).click();
  const download = await downloading; assert.match(download.suggestedFilename(), /\.prism$/);
  const bundlePath = path.join(dataDir, 'transfer.prism'); await download.saveAs(bundlePath);
  const bytes = await fs.readFile(bundlePath); assert.ok(bytes.length > source.length);
  await expect(dialog).toHaveCount(0); await settled();
  assert.deepEqual((await companion.native.execute('get_document', { documentId: originalId })).document, original);
  const exportRequest = transfers.find(item => item.method === 'GET'); assert.ok(exportRequest.url.endsWith(`expectedRevision=${original.revision}`)); assert.equal(exportRequest.headers.authorization, `Bearer ${companion.token}`);
  checkpoint('editable project choice clearly excludes history; authenticated binary download preserves the original document');

  await pickProject(bundlePath); await expect.poll(async () => (await current()).id).not.toBe(originalId); await settled();
  const imported = await current(); assert.equal((await documents()).length, 2); assert.equal(imported.canUndo, false); assert.equal(imported.canRedo, false);
  assert.equal(imported.history.length, 1); assert.deepEqual(editableShape(imported), editableShape(original));
  assert.deepEqual(imported.selection, original.selection); assert.deepEqual(imported.savedSelections.map(({ name, mask }) => ({ name, mask })), original.savedSelections.map(({ name, mask }) => ({ name, mask })));
  assert.deepEqual(await pixels(imported.id), baseline); assert.deepEqual(await pixels(originalId), baseline);
  for (const [hash, data] of assets) assert.deepEqual(await fs.readFile(path.join(companion.native.assetsDir, hash)), data);
  const importedTitle = imported.layers.find(layer => layer.type === 'text'); await page.locator('.inspector-tabs').getByRole('button', { name: 'Layers', exact: true }).click(); await page.locator(`.layer-row[data-layer-id="${importedTitle.id}"]`).click();
  await page.getByLabel('Layer name', { exact: true }).fill('Imported title changed'); await page.getByLabel('Layer name', { exact: true }).press('Enter');
  await expect.poll(async () => (await current()).layers.find(layer => layer.id === importedTitle.id).name).toBe('Imported title changed');
  assert.deepEqual((await companion.native.execute('get_document', { documentId: originalId })).document, original);
  const firstImport = transfers.find(item => item.method === 'POST'); assert.equal(firstImport.headers['content-type'], 'application/x-prism-project'); assert.match(firstImport.headers['x-prism-request-id'], /^[a-f0-9-]{36}$/); assert.deepEqual(firstImport.data, bytes);
  checkpoint('raw-file open creates a fresh editable project with exact layers, masks, selection library, assets and rendered pixels; edits stay independent');

  let intercepted = false;
  await page.route('**/api/projects/import', async route => {
    const response = await route.fetch();
    if (!intercepted) { intercepted = true; assert.equal(response.status(), 200); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: 'Import completed, but its reply was lost. Retry this project transfer.' } }) }); }
    else await route.fulfill({ response });
  });
  await pickProject(bundlePath); await expect(page.getByRole('alert')).toContainText('reply was lost'); await expect(page.getByRole('button', { name: 'Retry project import', exact: true })).toBeEnabled();
  assert.equal((await documents()).length, 3);
  const beforeRetry = transfers.filter(item => item.method === 'POST').at(-1);
  await page.getByRole('button', { name: 'Retry project import', exact: true }).click(); await settled();
  await expect.poll(async () => (await current()).id).not.toBe(imported.id);
  const afterRetry = transfers.filter(item => item.method === 'POST').at(-1);
  assert.equal(afterRetry.headers['x-prism-request-id'], beforeRetry.headers['x-prism-request-id']); assert.deepEqual(afterRetry.data, beforeRetry.data); assert.equal((await documents()).length, 3); assert.deepEqual(await pixels((await current()).id), baseline);
  await page.unroute('**/api/projects/import');
  checkpoint('lost successful response retries the exact file and stable request ID without creating a duplicate project');

  const beforeInvalid = await current(), count = (await documents()).length;
  const invalid = path.join(dataDir, 'invalid.prism'); await fs.writeFile(invalid, 'This is not a project bundle.'); expectedTransferError = true;
  await pickProject(invalid); await expect(page.getByRole('alert')).toBeVisible(); await expect(page.getByRole('button', { name: 'Retry project import', exact: true })).toBeEnabled();
  assert.equal((await current()).id, beforeInvalid.id); assert.equal((await documents()).length, count);
  await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click(); expectedTransferError = false;
  await page.setViewportSize({ width: 900, height: 1000 }); await openFileMenu(); await page.getByRole('button', { name: 'Download project', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(artifacts, 'editable-project-compact.png'), animations: 'disabled' });
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click(); await page.reload({ waitUntil: 'networkidle' }); await expect(page.locator('.artboard img')).toBeVisible();
  assert.equal((await documents()).length, count); assert.equal(keyReads, 0); assert.equal(providerCalls, 0); assert.deepEqual(errors, []);
  checkpoint('invalid files preserve every project; reopening and compact layout work without unexpected errors or AI calls');
  await fs.writeFile(path.join(artifacts, 'project-bundle-browser-report.json'), JSON.stringify({ passed: checkpoints, bundleBytes: bytes.length, keyReads, providerCalls, browserErrors: errors }, null, 2));
  console.log(`Portable-project browser checks passed (${checkpoints.length} workflows).`);
} catch (error) { await page.screenshot({ path: path.join(artifacts, 'project-bundle-browser-failure.png'), animations: 'disabled' }).catch(() => {}); console.error('Visible alerts:', await page.getByRole('alert').allTextContents().catch(() => [])); throw error; }
finally { await browser.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
