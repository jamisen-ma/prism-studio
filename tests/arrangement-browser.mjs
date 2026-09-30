import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createCompanion } from '../server/index.mjs';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-arrangement-browser-'));
const artifacts = path.resolve('test-results'); await fs.mkdir(artifacts, { recursive: true });
let keyReads = 0, providerCalls = 0;
const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => { keyReads++; return null; }, imageProvider: async () => { providerCalls++; throw Error('Arrangement must not generate images.'); } });
const width = 160, height = 120;
async function pattern(w, h, region = { x: 0, y: 0, width: w, height: h }) {
  const raw = Buffer.alloc(w * h * 4);
  for (let y = region.y; y < region.y + region.height; y++) for (let x = region.x; x < region.x + region.width; x++) raw.set([70 + x % 80, 80 + y % 70, (x + y) % 3 ? 197 : 81, (x + y) % 7 === 0 ? 1 : (x + y) % 3 === 0 ? 128 : 255], (y * w + x) * 4);
  return sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}
const first = await pattern(width, height, { x: 10, y: 10, width: 20, height: 20 });
let document = (await companion.native.execute('import_image', { name: 'Arrangement fixture', data: first.toString('base64'), mimeType: 'image/png' })).document;
const documentId = document.id, ids = { A: document.layers[0].id };
const seed = async (command, args) => { document = (await companion.native.execute(command, { documentId, ...args })).document; };
await seed('set_layer', { layerId: ids.A, name: 'A' }); await seed('set_layer_protection', { layerId: ids.A, protected: true });
let sourceB;
for (const [name, x, y, w, h] of [['B', 65, 40, 31, 11], ['C', 110, 70, 40, 30]]) {
  const source = (await companion.native.execute('import_image', { name: `${name} source`, data: (await pattern(w, h)).toString('base64'), mimeType: 'image/png' })).document;
  if (name === 'B') sourceB = source;
  await seed('place_layer', { sourceDocumentId: source.id, sourceLayerId: source.layers[0].id, sourceExpectedRevision: source.revision, x, y, width: w, height: h, protect: true, name });
  ids[name] = document.layers.at(-1).id;
}
await seed('create_group', { name: 'Neutral group' }); const neutralId = document.layers.at(-1).id;
await seed('move_layer', { layerId: ids.B, parentId: neutralId });
await seed('add_shape', { name: 'Masked leaf', shape: 'rectangle', x: 135, y: 5, width: 15, height: 15, fill: '#777777' });
const maskedId = document.layers.at(-1).id;
await seed('set_layer_mask', { layerId: maskedId, mask: { shape: 'ellipse', x: 135, y: 5, width: 15, height: 15 } });
await seed('add_adjustment', { kind: 'brightness', value: 0 }); const adjustmentName = document.layers.at(-1).name;
await seed('place_layer', { sourceDocumentId: sourceB.id, sourceLayerId: sourceB.layers[0].id, sourceExpectedRevision: sourceB.revision, x: 5, y: 95, width: 31, height: 11, protect: false, name: 'Faded child' });
const fadedChild = document.layers.at(-1).id;
await seed('create_group', { name: 'Faded group' }); const fadedGroup = document.layers.at(-1).id;
await seed('move_layer', { layerId: fadedChild, parentId: fadedGroup }); await seed('set_layer', { layerId: fadedGroup, opacity: .5 });
const assets = new Map();
for (const layer of document.layers) for (const key of ['asset', 'sourceAsset', 'alphaAsset']) if (layer[key]) assets.set(layer[key], await fs.readFile(path.join(companion.native.assetsDir, layer[key])));
const originalLayers = structuredClone(document.layers);
const baseUrl = `http://127.0.0.1:${await companion.listen()}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(12000);
const errors = [], checkpoints = [], requests = [];
page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/command')) requests.push(request.postDataJSON()); });
await page.route('https://**', route => route.abort());
const current = async () => (await companion.native.execute('get_document', { documentId })).document;
const samples = new Map();
async function bounds(layerId) {
  const preview = await companion.native.execute('get_layer_preview', { documentId, layerId, view: 'layer', maxWidth: width });
  const pixels = await sharp(Buffer.from(preview.data, 'base64')).ensureAlpha().raw().toBuffer();
  let left = width, top = height, right = 0, bottom = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (pixels[(y * width + x) * 4 + 3]) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1); }
  assert.ok(right > left && bottom > top);
  samples.set(layerId, Buffer.concat(Array.from({ length: bottom - top }, (_, index) => pixels.subarray(((top + index) * width + left) * 4, ((top + index) * width + right) * 4))));
  return { left, top, right, bottom, width: right - left, height: bottom - top, centerX: (left + right) / 2, centerY: (top + bottom) / 2 };
}
const allBounds = async () => Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([name, id]) => [name, await bounds(id)])));
const baseline = await allBounds();
const baselineSamples = new Map(samples);
function unchangedContent() { for (const id of Object.values(ids)) assert.deepEqual(samples.get(id), baselineSamples.get(id), 'Translation must preserve every isolated subject pixel, including alpha 1 and 128'); }
const settled = async () => { await expect(page.locator('.save-status .spin')).toHaveCount(0); await expect(page.getByRole('alert')).toHaveCount(0); };
async function mutate(action) { await settled(); const before = await current(); await action(); await expect.poll(async () => (await current()).revision).toBeGreaterThan(before.revision); await settled(); return current(); }
const undo = () => mutate(() => page.getByRole('button', { name: 'Undo (⌘Z)', exact: true }).click());
function checkpoint(message) { checkpoints.push(message); console.log(`Verified: ${message}`); }
try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' }); await expect(page.locator('.artboard img')).toBeVisible();
  await page.getByLabel('Open document').selectOption(documentId); await settled(); await page.locator('.inspector-tabs').getByRole('button', { name: 'Layers', exact: true }).click();
  await page.getByRole('button', { name: 'Select layers', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Align layers left', exact: true })).toBeDisabled();
  await page.getByLabel('Select layer A', { exact: true }).check();
  await expect(page.getByRole('button', { name: 'Align layers left', exact: true })).toBeEnabled();
  await page.getByLabel('Layer alignment reference').selectOption('layers'); await expect(page.getByRole('button', { name: 'Align layers left', exact: true })).toBeDisabled();
  for (const name of ['B', 'C']) await page.getByLabel(`Select layer ${name}`, { exact: true }).check();
  await expect(page.getByRole('button', { name: 'Group selected (3)', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Align layers left', exact: true })).toBeEnabled();
  for (const [name, hint] of [['Neutral group', 'Groups and adjustments'], [adjustmentName, 'Groups and adjustments'], ['Masked leaf', 'additional layer mask'], ['Faded child', 'Parent groups must']]) {
    await page.getByLabel(`Select layer ${name}`, { exact: true }).check();
    await expect(page.getByRole('button', { name: 'Align layers left', exact: true })).toBeDisabled();
    await expect(page.locator('.arrangement-eligibility')).toContainText(hint);
    await page.getByLabel(`Select layer ${name}`, { exact: true }).uncheck();
  }
  await mutate(() => page.getByRole('button', { name: 'Hide A', exact: true }).click());
  await expect(page.locator('.arrangement-eligibility')).toContainText('Show every selected layer'); await undo();
  checkpoint('selection count, nonadjacent neutral nested leaves, group/adjustment/mask/hidden/ancestor eligibility and independent grouping rules');

  await page.getByLabel('Layer alignment reference').selectOption('canvas');
  for (const [label, key, target] of [['left', 'left', 0], ['center', 'centerX', width / 2], ['right', 'right', width], ['top', 'top', 0], ['middle', 'centerY', height / 2], ['bottom', 'bottom', height]]) {
    await mutate(() => page.getByRole('button', { name: `Align layers ${label}`, exact: true }).click());
    const next = await allBounds(); unchangedContent();
    for (const name of Object.keys(ids)) { assert.ok(Math.abs(next[name][key] - target) <= (key.startsWith('center') ? .5 : 0), `${name} ${label}`); assert.equal(next[name].width, baseline[name].width); assert.equal(next[name].height, baseline[name].height); }
    await undo(); assert.deepEqual(await allBounds(), baseline);
  }
  await page.getByLabel('Layer alignment reference').selectOption('layers');
  await mutate(() => page.getByRole('button', { name: 'Align layers center', exact: true }).click());
  for (const item of Object.values(await allBounds())) assert.ok(Math.abs(item.centerX - 80) <= .5);
  await undo(); assert.deepEqual(await allBounds(), baseline);
  checkpoint('six canvas alignments and selected-bounds alignment use real alpha geometry, preserve dimensions, and undo exactly');

  for (const spacing of ['centers', 'gaps']) for (const axis of ['horizontal', 'vertical']) {
    await page.getByLabel('Layer distribution spacing').selectOption(spacing);
    await mutate(() => page.getByRole('button', { name: `Distribute layers ${axis}`, exact: true }).click());
    const next = await allBounds(); unchangedContent(); assert.deepEqual(next.A, baseline.A); assert.deepEqual(next.C, baseline.C);
    const center = axis === 'horizontal' ? 'centerX' : 'centerY', start = axis === 'horizontal' ? 'left' : 'top', end = axis === 'horizontal' ? 'right' : 'bottom';
    const firstInterval = spacing === 'centers' ? next.B[center] - next.A[center] : next.B[start] - next.A[end];
    const secondInterval = spacing === 'centers' ? next.C[center] - next.B[center] : next.C[start] - next.B[end];
    assert.ok(Math.abs(firstInterval - secondInterval) <= 1); assert.ok(firstInterval >= 0 && secondInterval >= 0);
    await undo(); assert.deepEqual(await allBounds(), baseline);
  }
  assert.deepEqual((await current()).layers, originalLayers);
  for (const [hash, data] of assets) assert.deepEqual(await fs.readFile(path.join(companion.native.assetsDir, hash)), data);
  for (const request of requests.filter(item => ['align_layers', 'distribute_layers'].includes(item.command))) { assert.equal(request.backend, 'native'); assert.ok(Number.isInteger(request.args.expectedRevision)); assert.deepEqual(new Set(request.args.layerIds), new Set(Object.values(ids))); }
  checkpoint('horizontal/vertical center and gap distribution fixes endpoints, preserves protected/source-alpha assets and every soft-alpha pixel, and undoes as one edit');

  await page.setViewportSize({ width: 900, height: 1000 }); await page.locator('.layer-arrangement').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.equal(await page.locator('.inspector').evaluate(element => element.scrollWidth <= element.clientWidth), true);
  await page.screenshot({ path: path.join(artifacts, 'layer-arrangement.png'), animations: 'disabled' });
  await mutate(() => page.getByRole('button', { name: 'Distribute layers horizontal', exact: true }).click()); const persisted = await allBounds();
  await page.reload({ waitUntil: 'networkidle' }); await expect(page.locator('.artboard img')).toBeVisible(); await page.getByLabel('Open document').selectOption(documentId); await settled(); assert.deepEqual(await allBounds(), persisted);
  assert.equal(keyReads, 0); assert.equal(providerCalls, 0); assert.deepEqual(errors, []);
  checkpoint('arrangement persists on reopen, compact layout has no overflow, and no browser errors or AI calls occur');
  await fs.writeFile(path.join(artifacts, 'arrangement-browser-report.json'), JSON.stringify({ passed: checkpoints, keyReads, providerCalls, browserErrors: errors }, null, 2));
  console.log(`Layer-arrangement browser checks passed (${checkpoints.length} workflows).`);
} catch (error) { await page.screenshot({ path: path.join(artifacts, 'arrangement-browser-failure.png'), animations: 'disabled' }).catch(() => {}); console.error('Visible alerts:', await page.getByRole('alert').allTextContents().catch(() => [])); throw error; }
finally { await browser.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
