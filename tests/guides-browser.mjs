import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createCompanion } from '../server/index.mjs';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-guides-browser-'));
const artifacts = path.resolve('test-results'); await fs.mkdir(artifacts, { recursive: true });
let keyReads = 0, providerCalls = 0;
const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => { keyReads++; return null; }, imageProvider: async () => { providerCalls++; throw Error('Guides must not generate images.'); } });
const width = 240, height = 180, raw = Buffer.alloc(width * height * 4);
for (let y = 40; y < 70; y++) for (let x = 60; x < 101; x++) raw.set([40 + x, 60 + y, (x + y) % 2 ? 80 : 140, (x + y) % 7 === 0 ? 1 : (x + y) % 3 === 0 ? 128 : 255], (y * width + x) * 4);
const source = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
let document = (await companion.native.execute('import_image', { name: 'Guided layout fixture', data: source.toString('base64'), mimeType: 'image/png' })).document;
const documentId = document.id, oddId = document.layers[0].id;
const seed = async (command, args) => { document = (await companion.native.execute(command, { documentId, ...args })).document; return document; };
await seed('set_layer', { layerId: oddId, name: 'Protected odd-width subject' }); await seed('set_layer_protection', { layerId: oddId, protected: true });
async function shape(name, x = 60, y = 40, w = 40, h = 30) { await seed('add_shape', { name, shape: 'rectangle', x, y, width: w, height: h, fill: '#aa6677' }); return document.layers.at(-1).id; }
const evenId = await shape('Even-width target');
const maskedId = await shape('Masked target'); await seed('set_layer_mask', { layerId: maskedId, mask: { shape: 'rectangle', x: 62, y: 42, width: 34, height: 26 } });
const dissolveId = await shape('Dissolve target'); await seed('set_layer', { layerId: dissolveId, blendMode: 'dissolve', opacity: .5 });
const edgeId = await shape('Edge target', 0, 20, 20, 20);
const nestedId = await shape('Masked ancestor target'); await seed('create_group', { name: 'Masked parent' }); const groupId = document.layers.at(-1).id; await seed('move_layer', { layerId: nestedId, parentId: groupId }); await seed('set_layer_mask', { layerId: groupId, mask: { shape: 'rectangle', x: 62, y: 42, width: 34, height: 26 } });
const generatedRaw = Buffer.alloc(width * height * 4); for (let y = 110; y < 130; y++) for (let x = 150; x < 180; x++) generatedRaw.set([40, 140, 100, 255], (y * width + x) * 4);
document = (await companion.native.installGeneratedImage({ documentId, expectedRevision: document.revision, data: await sharp(generatedRaw, { raw: { width, height, channels: 4 } }).png().toBuffer(), provenance: { jobId: randomUUID(), mode: 'generate' } })).document; const generatedId = document.layers.at(-1).id;
const other = (await companion.native.execute('create_document', { name: 'Guide limit fixture', width, height, background: '#667788' })).document;
for (let i = 0; i < 64; i++) await companion.native.execute('add_guide', { documentId: other.id, axis: 'vertical', position: i });
const originalAssets = new Map(); for (const layer of document.layers) for (const key of ['asset', 'sourceAsset', 'alphaAsset']) if (layer[key]) originalAssets.set(layer[key], await fs.readFile(path.join(companion.native.assetsDir, layer[key])));
const current = async (id = documentId) => (await companion.native.execute('get_document', { documentId: id })).document;
const pixels = async (layerId = oddId) => sharp(Buffer.from((await companion.native.execute('get_layer_preview', { documentId, layerId, view: 'layer', maxWidth: width })).data, 'base64')).ensureAlpha().raw().toBuffer();
const baseline = await pixels();
const preview = async () => (await companion.native.execute('get_preview', { documentId, maxWidth: width })).data;
const png = async () => (await companion.native.execute('export_document', { documentId, format: 'png' })).data;
const initialPreview = await preview(), initialPng = await png(), initialLayers = structuredClone(document.layers);
const baseUrl = `http://127.0.0.1:${await companion.listen()}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(12000);
const errors = [], checkpoints = [], requests = [];
page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error' && !message.text().includes('409')) errors.push(message.text()); });
page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/command')) requests.push(request.postDataJSON()); });
await page.route('https://**', route => route.abort());
const panel = page.getByRole('region', { name: 'Canvas layout', exact: true });
const settled = async () => { await expect(page.locator('.save-status .spin')).toHaveCount(0); };
const ready = async () => { await settled(); await expect(page.locator('.move-options')).not.toContainText('Reading layer bounds'); await expect(page.locator('.move-guide')).toBeVisible(); };
const layout = async () => { await page.getByRole('button', { name: 'Canvas layout and guides', exact: true }).click(); await expect(panel).toBeVisible(); };
const select = async id => { if (await panel.count()) await panel.getByRole('button', { name: 'Back to layers', exact: true }).click(); await page.locator('.inspector-tabs').getByRole('button', { name: 'Layers', exact: true }).click(); await page.locator(`.layer-row[data-layer-id="${id}"]`).click(); await ready(); };
async function mutate(action) { await settled(); const before = await current(); await action(); await expect.poll(async () => (await current()).revision).toBeGreaterThan(before.revision); await settled(); const after = await current(); assert.equal(after.revision, before.revision + 1); return after; }
const undo = () => mutate(() => page.getByRole('button', { name: 'Undo (⌘Z)', exact: true }).click());
async function add(axis, value) { await panel.getByLabel('New guide orientation').selectOption(axis); await panel.getByLabel('New guide position', { exact: true }).fill(String(value)); return mutate(() => panel.getByRole('button', { name: 'Add guide', exact: true }).click()); }
async function coordinates(x, y) { const box = await page.locator('.artboard').boundingBox(); return { x: box.x + x / width * box.width, y: box.y + y / height * box.height }; }
async function begin(x = 75, y = 55) { await ready(); const p = await coordinates(x, y); await page.mouse.move(p.x, p.y); await page.mouse.down(); return p; }
async function dragPreview(dx, dy, { upOnly = false } = {}) { const p = await begin(), box = await page.locator('.artboard').boundingBox(); const target = { x: p.x + dx * box.width / width, y: p.y + dy * box.height / height }; if (!upOnly) await page.mouse.move(target.x, target.y, { steps: 3 }); return target; }
async function commitDrag(dx, dy, expectedX, expectedY) { await dragPreview(dx, dy); await expect(page.locator('.move-guide')).toHaveAttribute('data-delta-x', String(expectedX)); await expect(page.locator('.move-guide')).toHaveAttribute('data-delta-y', String(expectedY)); const before = await current(); await mutate(() => page.mouse.up()); const request = requests.filter(item => item.command === 'transform_layer').at(-1); assert.equal(request.args.x, expectedX); assert.equal(request.args.y, expectedY); assert.equal(request.args.expectedRevision, before.revision); }
async function rulerGeometry() {
  await expect.poll(async () => page.locator('.horizontal-ruler line').count()).toBeGreaterThan(0);
  await expect.poll(async () => page.evaluate(() => {
    const board = document.querySelector('.artboard').getBoundingClientRect(), horizontal = document.querySelector('.horizontal-ruler'), vertical = document.querySelector('.vertical-ruler');
    let error = 0;
    for (const [ruler, axis, origin, size, dimension] of [[horizontal, 'x1', board.left, board.width, 240], [vertical, 'y1', board.top, board.height, 180]]) { const rect = ruler.getBoundingClientRect(); for (const node of ruler.querySelectorAll('[data-ruler-position]')) { const value = Number(node.getAttribute('data-ruler-position')), coordinate = Number(node.querySelector('line').getAttribute(axis)) + (axis === 'x1' ? rect.left : rect.top); error = Math.max(error, Math.abs(coordinate - origin - value * size / dimension)); } }
    for (const line of document.querySelectorAll('.canvas-guide')) { const rect = line.getBoundingClientRect(), x = line.dataset.guideAxis === 'vertical', value = Number(line.dataset.guidePosition); error = Math.max(error, Math.abs((x ? rect.left + rect.width / 2 - board.left : rect.top + rect.height / 2 - board.top) - value * (x ? board.width / 240 : board.height / 180))); }
    return error;
  })).toBeLessThan(.2);
}
function checkpoint(message) { checkpoints.push(message); console.log(`Verified: ${message}`); }
try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' }); await page.getByLabel('Open document').selectOption(documentId); await select(oddId); await layout();
  await expect(panel.getByLabel('Show rulers')).not.toBeChecked(); await expect(panel.getByLabel('Show guides')).toBeChecked(); await expect(panel.getByLabel('Snap Move to guides')).not.toBeChecked();
  await panel.getByLabel('New guide position', { exact: true }).fill('1.5'); await expect(panel.getByRole('button', { name: 'Add guide', exact: true })).toBeDisabled(); await panel.getByLabel('New guide position', { exact: true }).fill('241'); await expect(panel.getByRole('button', { name: 'Add guide', exact: true })).toBeDisabled();
  await add('vertical', 160); const firstId = (await current()).guides[0].id; await add('horizontal', 100);
  await panel.getByLabel('Saved guide', { exact: true }).selectOption(firstId); await panel.getByLabel('Saved guide position', { exact: true }).fill('154'); await mutate(() => panel.getByRole('button', { name: 'Update guide position', exact: true }).click()); assert.equal((await current()).guides[0].id, firstId); assert.equal((await current()).guides[0].position, 154); await undo();
  const beforeDelete = (await current()).guides; await mutate(() => panel.getByRole('button', { name: 'Delete guide', exact: true }).click()); await undo(); assert.deepEqual((await current()).guides, beforeDelete);
  await add('vertical', 160); await add('vertical', 0); await add('vertical', width); await add('vertical', 166); await expect(page.locator('.canvas-guide')).toHaveCount(5);
  const saved = (await current()).guides; await mutate(() => panel.getByRole('button', { name: 'Clear all guides', exact: true }).click()); await expect(page.locator('.canvas-guide')).toHaveCount(0); await undo(); assert.deepEqual((await current()).guides, saved);
  assert.deepEqual((await current()).layers, initialLayers); assert.equal(await preview(), initialPreview); assert.equal(await png(), initialPng);
  const preferenceRevision = (await current()).revision; await panel.getByLabel('Show rulers').check(); await rulerGeometry(); await panel.getByLabel('Snap Move to guides').check(); assert.equal((await current()).revision, preferenceRevision);
  checkpoint('native numeric CRUD validates whole pixels and inclusive edges, retains IDs, deduplicates lines, undoes atomically, and leaves preview/export pixels unchanged');

  const beforeMove = await current(), beforeReads = requests.filter(item => item.command === 'get_layer_preview').length;
  await dragPreview(95, 25); await expect(page.locator('.move-guide')).toHaveAttribute('data-delta-x', '100'); await expect(page.locator('.move-guide')).toHaveAttribute('data-delta-y', '30'); await expect(page.locator('.canvas-guide.snapped')).toHaveCount(2); assert.equal((await current()).revision, beforeMove.revision); assert.equal(requests.filter(item => item.command === 'get_layer_preview').length, beforeReads);
  await mutate(() => page.mouse.up()); const moved = await pixels(); const expected = Buffer.alloc(raw.length); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const sx = x - 100, sy = y - 30; if (sx >= 0 && sy >= 0 && sx < width && sy < height) baseline.copy(expected, (y * width + x) * 4, (sy * width + sx) * 4, (sy * width + sx) * 4 + 4); } assert.deepEqual(moved, expected); await undo(); assert.deepEqual(await pixels(), baseline);
  await commitDrag(103, 25, 100, 30); await undo(); // equal distance to X160/X166: lower coordinate wins
  await commitDrag(78, 25, 78, 30); await undo(); // width41 center80.5 is intentionally skipped
  await select(evenId); await commitDrag(78, 25, 80, 30); await undo(); await select(oddId); await layout();
  await dragPreview(95, 25); await page.keyboard.down('Alt'); await expect(page.locator('.move-guide')).toHaveAttribute('data-delta-x', '95'); await expect(page.locator('.canvas-guide.snapped')).toHaveCount(0); await page.keyboard.up('Alt'); await expect(page.locator('.move-guide')).toHaveAttribute('data-delta-x', '100'); await page.keyboard.down('Alt'); await mutate(() => page.mouse.up()); await page.keyboard.up('Alt'); assert.equal(requests.filter(item => item.command === 'transform_layer').at(-1).args.x, 95); await undo();
  await panel.getByLabel('Show guides').uncheck(); await expect(page.locator('.canvas-guide')).toHaveCount(0); await commitDrag(95, 25, 95, 25); await undo(); await panel.getByLabel('Show guides').check();
  const noOp = await current(); await begin(); await page.mouse.up(); assert.deepEqual(await current(), noOp);
  checkpoint('snapping uses deterministic nearest edges/integer centers, preserves every protected alpha-1/128 pixel, shares preview/commit math, honors Alt/hidden-guide bypass and performs no per-move image reads');

  for (let step = 0; step < 10; step++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click(); await expect(page.locator('.zoom-value')).toHaveText('200%'); await rulerGeometry();
  await commitDrag(97, 25, 100, 25); await undo(); await commitDrag(96, 25, 96, 25); await undo();
  for (const [id, hint] of [[maskedId, 'document-anchored masks'], [nestedId, 'document-anchored masks'], [dissolveId, 'dissolve blending'], [generatedId, 'contextual clipping'], [edgeId, 'starting bounds touch']]) { await select(id); await expect(page.locator('.move-options')).toContainText(hint); await commitDrag(5, 2, 5, 2); await undo(); }
  await select(oddId); await layout();
  const lostState = await current(); await dragPreview(95, 25); await page.locator('.artboard').evaluate(element => element.releasePointerCapture(1)); await page.mouse.move(5, 5); await page.mouse.up(); await expect(page.locator('.move-guide.dragging')).toHaveCount(0); await page.locator('.artboard').dispatchEvent('pointerup', { pointerId: 1, pointerType: 'mouse', clientX: 400, clientY: 300 }); assert.deepEqual(await current(), lostState);
  const beforeCancel = await current(); await dragPreview(95, 25); await page.getByRole('button', { name: 'Zoom in', exact: true }).focus(); await page.keyboard.press('Enter'); await page.mouse.up(); assert.deepEqual(await current(), beforeCancel); await expect(page.locator('.move-guide.dragging')).toHaveCount(0);
  await page.setViewportSize({ width: 900, height: 1000 }); for (let step = 0; step < 10; step++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click(); await expect(page.locator('.zoom-value')).toHaveText('300%');
  await rulerGeometry(); const scrollBefore = await page.locator('.canvas-viewport').evaluate(element => element.scrollLeft); await begin(); await page.mouse.wheel(90, 0); await expect.poll(() => page.locator('.canvas-viewport').evaluate(element => element.scrollLeft)).toBeGreaterThan(scrollBefore); await page.mouse.up(); await expect(page.getByRole('alert')).toContainText('canvas view changed'); await page.getByRole('button', { name: 'Dismiss notification' }).click(); assert.deepEqual(await current(), beforeCancel); await rulerGeometry();
  checkpoint('6 CSS-pixel threshold remains correct after zoom; masks, dissolve, generated context and edge bounds disable only snapping; lost pointer capture and zoom/scroll changes cancel without edits');

  await page.getByRole('button', { name: 'Fit', exact: true }).click(); await ready(); const stale = await current(); await dragPreview(95, 25); const external = (await companion.native.execute('update_guide', { documentId, expectedRevision: stale.revision, guideId: firstId, position: 150 })).document; await page.mouse.up(); await expect(page.getByRole('alert')).toContainText('document changed while you were drawing'); assert.deepEqual(await current(), external); assert.equal(requests.filter(item => item.command === 'transform_layer').at(-1).args.expectedRevision, stale.revision); await page.getByRole('button', { name: 'Dismiss notification' }).click();
  const retained = await current(); await page.reload({ waitUntil: 'networkidle' }); await page.getByLabel('Open document').selectOption(documentId); await select(oddId); await layout(); await expect(panel.getByLabel('Show rulers')).toBeChecked(); await expect(panel.getByLabel('Snap Move to guides')).toBeChecked(); assert.deepEqual((await current()).guides, retained.guides); await rulerGeometry();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.equal(await page.locator('.inspector').evaluate(element => element.scrollWidth <= element.clientWidth), true); await page.screenshot({ path: path.join(artifacts, 'guides-layout.png'), animations: 'disabled' });
  await page.getByLabel('Open document').selectOption(other.id); await settled(); await expect(panel).toContainText('All 64 guides are used'); await expect(panel.getByRole('button', { name: 'Add guide', exact: true })).toBeDisabled(); await panel.getByLabel('Saved guide position', { exact: true }).fill('100'); await expect(panel.getByRole('button', { name: 'Update guide position', exact: true })).toBeEnabled();
  for (const [hash, bytes] of originalAssets) assert.deepEqual(await fs.readFile(path.join(companion.native.assetsDir, hash)), bytes);
  assert.equal(keyReads, 0); assert.equal(providerCalls, 0); assert.deepEqual(errors, []);
  checkpoint('captured revisions reject stale snap guides, document guides and local preferences reopen correctly, the 64-guide limit preserves editing, compact layout fits and assets remain byte-identical');
  await fs.writeFile(path.join(artifacts, 'guides-browser-report.json'), JSON.stringify({ passed: checkpoints, keyReads, providerCalls, browserErrors: errors }, null, 2)); console.log(`Guides browser checks passed: ${checkpoints.length} workflows.`);
} catch (error) { await page.screenshot({ path: path.join(artifacts, 'guides-browser-failure.png'), animations: 'disabled' }).catch(() => {}); console.error('Visible alerts:', await page.getByRole('alert').allTextContents().catch(() => [])); throw error; }
finally { await browser.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
