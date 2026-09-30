import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createCompanion } from '../server/index.mjs';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-move-ui-'));
const artifacts = path.resolve('test-results'); await fs.mkdir(artifacts, { recursive: true });
const width = 160, height = 120, raw = Buffer.alloc(width * height * 4);
for (let y = 30; y < 60; y++) for (let x = 30; x < 60; x++) raw.set([40 + x, 50 + y, (x + y) % 2 ? 80 : 140, (x + y) % 7 === 0 ? 1 : (x + y) % 3 === 0 ? 128 : 255], (y * width + x) * 4);
const source = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
let keyReads = 0, providerCalls = 0;
const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => { keyReads++; return null; }, imageProvider: async () => { providerCalls++; throw Error('Move cannot generate.'); }, segmentSubject: async () => ({ alpha: Buffer.alloc(width * height, 255), width, height, model: 'synthetic-full-alpha' }) });
let document = (await companion.native.execute('import_image', { name: 'Move fixture', data: source.toString('base64'), mimeType: 'image/png' })).document;
const documentId = document.id;
const seed = async (command, args) => { document = (await companion.native.execute(command, { documentId, ...args })).document; };
await seed('extract_subject', { layerId: document.layers[0].id, name: 'Protected subject', hideOriginal: true, protect: true }); const subjectId = document.layers.at(-1).id;
await seed('duplicate_layer', { layerId: subjectId }); const filteredId = document.layers.at(-1).id;
await seed('set_layer_protection', { layerId: filteredId, protected: false }); await seed('set_layer', { layerId: filteredId, name: 'Filtered tile' });
await seed('transform_layer', { layerId: filteredId, x: 60, y: 20 }); await seed('add_layer_filter', { layerId: filteredId, kind: 'brightness', value: 20 });
await seed('set_layer_mask', { layerId: filteredId, mask: { shape: 'rectangle', x: 90, y: 50, width: 15, height: 30 } });
await seed('create_group', { name: 'Parent group' }); const groupId = document.layers.at(-1).id;
await seed('move_layer', { layerId: filteredId, parentId: groupId });
await seed('add_adjustment', { kind: 'brightness', value: 0 }); const adjustmentId = document.layers.at(-1).id;
await seed('add_paint_layer', { name: 'Empty paint' }); const emptyId = document.layers.at(-1).id;
const other = (await companion.native.execute('create_document', { name: 'Other canvas', width, height, background: '#775599' })).document;
const assets = new Map(); for (const layer of document.layers) for (const key of ['asset', 'sourceAsset', 'alphaAsset']) if (layer[key]) assets.set(layer[key], await fs.readFile(path.join(companion.native.assetsDir, layer[key])));
const current = async (id = documentId) => (await companion.native.execute('get_document', { documentId: id })).document;
const pixels = async (layerId = subjectId) => sharp(Buffer.from((await companion.native.execute('get_layer_preview', { documentId, layerId, view: 'layer', maxWidth: width })).data, 'base64')).ensureAlpha().raw().toBuffer();
const baseline = await pixels();
const url = `http://127.0.0.1:${await companion.listen()}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(12000);
const errors = [], requests = [], checks = [];
page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error' && !message.text().includes('409')) errors.push(message.text()); });
page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/command')) requests.push(request.postDataJSON()); });
await page.route('https://**', route => route.abort());
const settled = async () => { await expect(page.locator('.save-status .spin')).toHaveCount(0); };
const ready = async () => { await settled(); await expect(page.locator('.move-options')).not.toContainText('Reading layer bounds'); await expect(page.locator('.move-guide')).toBeVisible(); };
const select = id => page.locator(`.layer-row[data-layer-id="${id}"]`).click();
async function point(x, y) { const box = await page.locator('.artboard').boundingBox(); return { x: box.x + x / width * box.width, y: box.y + y / height * box.height }; }
async function begin(x = 45, y = 45) { await ready(); const p = await point(x, y); await page.mouse.move(p.x, p.y); await page.mouse.down(); }
async function move(x, y) { const p = await point(x, y); await page.mouse.move(p.x, p.y, { steps: 5 }); }
async function mutate(action) { await settled(); const revision = (await current()).revision; await action(); await expect.poll(async () => (await current()).revision).toBeGreaterThan(revision); await settled(); return current(); }
const undo = () => mutate(() => page.getByRole('button', { name: 'Undo (⌘Z)', exact: true }).click());
function checkpoint(message) { checks.push(message); console.log(`Verified: ${message}`); }
try {
  await page.goto(url, { waitUntil: 'networkidle' }); await page.getByLabel('Open document').selectOption(documentId); await settled(); await page.locator('.inspector-tabs').getByRole('button', { name: 'Layers', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Move layer (V)', exact: true })).toHaveClass(/active/);
  for (const [id, text] of [[groupId, 'Groups and adjustments cannot be dragged'], [adjustmentId, 'Groups and adjustments cannot be dragged'], [emptyId, 'no visible pixels']]) { await select(id); await expect(page.locator('.move-options')).toContainText(text); await expect(page.locator('.move-guide')).toHaveCount(0); }
  await select(filteredId); await ready();
  await mutate(() => page.getByRole('button', { name: 'Hide Parent group', exact: true }).click()); await expect(page.locator('.move-options')).toContainText('Show the parent groups'); await undo();
  await select(subjectId); await ready();
  const before = await current(), previewBefore = await page.locator('.artboard>img').getAttribute('src');
  await begin(); await move(62, 36); await expect(page.locator('.move-guide')).toHaveAttribute('data-delta-x', '17'); await expect(page.locator('.move-guide')).toHaveAttribute('data-delta-y', '-9');
  assert.equal((await current()).revision, before.revision); assert.equal(await page.locator('.artboard>img').getAttribute('src'), previewBefore, 'Bounds guide must not pretend to move the composite');
  await expect(page.locator('.move-guide')).toContainText('pixels update on release');
  await page.screenshot({ path: path.join(artifacts, 'move-layer-guide.png'), animations: 'disabled' });
  const translated = await mutate(() => page.mouse.up());
  assert.equal(translated.revision, before.revision + 1); assert.equal(translated.layers.find(layer => layer.id === subjectId).protected, true);
  const movedPixels = await pixels();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = x - 17, sy = y + 9, expected = sx >= 0 && sy >= 0 && sx < width && sy < height ? baseline.subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4) : Buffer.alloc(4);
    assert.deepEqual(movedPixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), expected, `translated pixel ${x},${y}`);
  }
  await undo(); assert.deepEqual((await current()).layers, before.layers); assert.deepEqual(await pixels(), baseline);
  checkpoint('visible-content eligibility, honest movement guide, exact protected/source-alpha translation including alpha 1/128, one-step undo and unchanged dimensions');

  await select(filteredId); await ready(); const filterBefore = structuredClone((await current()).layers.find(layer => layer.id === filteredId));
  await begin(97, 65); await move(92, 65); await mutate(() => page.mouse.up());
  const filtered = (await current()).layers.find(layer => layer.id === filteredId); assert.deepEqual(filtered.mask, filterBefore.mask); assert.deepEqual(filtered.filters, filterBefore.filters); assert.equal(filtered.parentId, groupId); assert.equal(filtered.asset, filterBefore.asset); await undo();
  await select(subjectId); await ready();
  for (const cancellation of ['escape', 'pointercancel', 'noop']) {
    const state = await current(); await begin();
    if (cancellation !== 'noop') await move(60, 60);
    if (cancellation === 'escape') await page.keyboard.press('Escape');
    if (cancellation === 'pointercancel') await page.locator('.artboard').dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' });
    await page.mouse.up(); assert.deepEqual(await current(), state);
  }
  checkpoint('filtered nested layers keep filter parameters and document-anchored masks; Escape, pointercancel and zero delta create no history');

  await ready(); const stale = await current(); await begin(); await move(60, 55);
  const external = (await companion.native.execute('set_layer', { documentId, expectedRevision: stale.revision, layerId: subjectId, name: 'Protected subject revised externally' })).document;
  await page.mouse.up(); await expect(page.getByRole('alert')).toContainText('document changed while you were drawing'); await settled(); assert.deepEqual(await current(), external);
  const rejected = requests.filter(item => item.command === 'transform_layer').at(-1); assert.equal(rejected.args.expectedRevision, stale.revision); assert.equal(rejected.args.layerId, subjectId);
  await page.getByRole('button', { name: 'Dismiss notification' }).click(); await ready();
  const unchanged = await current(), otherBefore = await current(other.id);
  await begin(); await move(60, 55); await page.getByLabel('Open document').selectOption(other.id); await settled(); await page.mouse.up(); assert.deepEqual(await current(), unchanged); assert.deepEqual(await current(other.id), otherBefore);
  await page.getByLabel('Open document').selectOption(documentId); await select(subjectId); await ready(); await begin(); await move(60, 55);
  await page.locator(`.layer-row[data-layer-id="${filteredId}"]`).focus(); await page.keyboard.press('Enter'); await page.mouse.up(); assert.deepEqual(await current(), unchanged); await ready();
  checkpoint('external edits reject stale movement and refresh; document and keyboard target switches cannot redirect a captured drag');

  let releaseOld, oldFetched, oldFinished;
  const finished = new Promise(resolve => { oldFinished = resolve; }); const fetched = new Promise(resolve => { oldFetched = resolve; }); const held = new Promise(resolve => { releaseOld = resolve; }); let hold = true;
  await page.route('**/api/command', async route => { const body = route.request().postDataJSON(); if (hold && body.command === 'get_layer_preview' && body.args.layerId === subjectId) { hold = false; const response = await route.fetch(); oldFetched(); await held; await route.fulfill({ response }); oldFinished(); } else await route.continue(); });
  await select(subjectId); await fetched; await expect(page.locator('.move-options')).toContainText('Reading layer bounds');
  await select(filteredId); await ready(); const guide = await page.locator('.move-guide').getAttribute('style'); releaseOld(); await finished; await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('.move-options')).toContainText('Filtered tile'); await expect(page.locator('.move-guide')).toHaveAttribute('style', guide);
  await page.setViewportSize({ width: 900, height: 900 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(artifacts, 'move-layer-compact.png'), animations: 'disabled' });
  for (const [asset, bytes] of assets) assert.deepEqual(await fs.readFile(path.join(companion.native.assetsDir, asset)), bytes);
  assert.equal(keyReads, 0); assert.equal(providerCalls, 0); assert.deepEqual(errors, []);
  checkpoint('late bounds reads cannot replace another layer guide; compact layout, immutable source/alpha assets and zero provider/key/browser errors');
  await fs.writeFile(path.join(artifacts, 'move-browser-report.json'), JSON.stringify({ passed: checks, keyReads, providerCalls, browserErrors: errors }, null, 2));
  console.log(`Move browser checks passed: ${checks.length} workflows.`);
} catch (error) { await page.mouse.up().catch(() => {}); await page.screenshot({ path: path.join(artifacts, 'move-failure.png'), animations: 'disabled' }).catch(() => {}); console.error('Alerts:', await page.getByRole('alert').allTextContents().catch(() => [])); throw error; }
finally { await browser.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
