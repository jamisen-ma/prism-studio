import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createCompanion } from '../server/index.mjs';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-mask-edges-ui-'));
const artifacts = path.resolve('test-results'); await fs.mkdir(artifacts, { recursive: true });
let keyReads = 0, providerCalls = 0;
const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => { keyReads++; return null; }, imageProvider: async () => { providerCalls++; throw Error('Mask editing must not generate images.'); } });
const width = 96, height = 72, raw = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set([40 + x, 50 + y * 2, (x + y) % 2 ? 80 : 140, 255], (y * width + x) * 4);
const source = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
const initial = (await companion.native.execute('import_image', { name: 'Selection edge fixture', data: source.toString('base64'), mimeType: 'image/png' })).document;
const documentId = initial.id, layerId = initial.layers[0].id, sourceAsset = initial.layers[0].sourceAsset;
const url = `http://127.0.0.1:${await companion.listen()}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(12000);
const errors = [], checkpoints = [], requests = [];
page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/command')) requests.push(request.postDataJSON()); });
await page.route('https://**', route => route.abort());
const current = async () => (await companion.native.execute('get_document', { documentId })).document;
const pixels = async () => sharp(Buffer.from((await companion.native.execute('get_preview', { documentId, maxWidth: width })).data, 'base64')).ensureAlpha().raw().toBuffer();
const settled = async () => { await expect(page.locator('.save-status .spin')).toHaveCount(0); await expect(page.getByRole('alert')).toHaveCount(0); };
async function mutate(action) { await settled(); const revision = (await current()).revision; await action(); await expect.poll(async () => (await current()).revision).toBeGreaterThan(revision); await settled(); return current(); }
const undo = () => mutate(() => page.getByRole('button', { name: 'Undo (⌘Z)', exact: true }).click());
const tab = name => page.locator('.inspector-tabs').getByRole('button', { name, exact: true }).click();
// Independent square-neighborhood oracle; browser assertions decode public RLE
// directly instead of using the implementation's coverage/morphology helpers.
function decode(mask) {
  const result = Buffer.alloc(width * height);
  assert.equal(mask.shape, 'bitmap');
  for (let i = 0; i < mask.runs.length; i += 3) result.fill(mask.runs[i + 2], mask.runs[i], mask.runs[i] + mask.runs[i + 1]);
  return result;
}
function extrema(input, radius, max) {
  const result = Buffer.alloc(input.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let value = max ? 0 : 255;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const xx = x + dx, yy = y + dy, sample = xx < 0 || yy < 0 || xx >= width || yy >= height ? 0 : input[yy * width + xx];
      value = max ? Math.max(value, sample) : Math.min(value, sample);
    }
    result[y * width + x] = value;
  }
  return result;
}
function reference(input, operation, radius) {
  if (operation === 'expand') return extrema(input, radius, true);
  if (operation === 'contract') return extrema(input, radius, false);
  if (operation === 'smooth') return extrema(extrema(extrema(extrema(input, radius, false), radius, true), radius, true), radius, false);
  const outer = extrema(input, radius, true), inner = extrema(input, radius, false); return Buffer.from(outer.map((value, index) => value - inner[index]));
}
function checkpoint(message) { checkpoints.push(message); console.log(`Verified: ${message}`); }
try {
  await page.goto(url, { waitUntil: 'networkidle' }); await expect(page.locator('.artboard img')).toBeVisible(); await tab('Select');
  const selectionPanel = page.getByRole('region', { name: 'Selection edges', exact: true });
  await expect(selectionPanel.getByRole('button', { name: 'Apply selection edges' })).toBeDisabled();
  await page.getByRole('button', { name: 'Rectangle selection (M)', exact: true }).click();
  const box = await page.locator('.artboard').boundingBox();
  const selected = await mutate(async () => { await page.mouse.move(box.x + 20, box.y + 18); await page.mouse.down(); await page.mouse.move(box.x + 60, box.y + 46, { steps: 8 }); await page.mouse.up(); });
  const originalSelection = structuredClone(selected.selection), baseline = Buffer.alloc(width * height);
  for (let y = originalSelection.y; y < originalSelection.y + originalSelection.height; y++) baseline.fill(255, y * width + originalSelection.x, y * width + originalSelection.x + originalSelection.width);
  await page.getByLabel('New saved selection name').fill('Original edges'); await mutate(() => page.getByRole('button', { name: 'Save current selection', exact: true }).click());
  const saved = structuredClone((await current()).savedSelections);
  await selectionPanel.getByLabel('Selection edge radius').fill('2.5'); await expect(selectionPanel.getByRole('button', { name: 'Apply selection edges' })).toBeDisabled();
  await selectionPanel.getByLabel('Selection edge radius').fill('101'); await expect(selectionPanel.getByRole('button', { name: 'Apply selection edges' })).toBeDisabled();
  await selectionPanel.getByLabel('Selection edge radius').fill('3');
  for (const operation of ['expand', 'contract', 'border', 'smooth']) {
    await selectionPanel.getByLabel('Selection edge operation').selectOption(operation);
    const modified = await mutate(() => selectionPanel.getByRole('button', { name: 'Apply selection edges' }).click());
    assert.deepEqual(decode(modified.selection), reference(baseline, operation, 3)); assert.deepEqual(modified.savedSelections, saved); assert.deepEqual(await pixels(), raw);
    await undo(); assert.deepEqual((await current()).selection, originalSelection);
  }
  checkpoint('missing-selection and radius guards; all four selection operations match independent pixel oracle, preserve saved copies and image pixels, and undo exactly');

  await tab('Layers'); await expect(page.getByRole('region', { name: 'Layer mask edges', exact: true })).toHaveCount(0);
  await mutate(() => page.getByRole('button', { name: 'Mask from selection', exact: true }).click());
  await mutate(() => page.getByLabel('Protect original pixels', { exact: true }).click());
  const maskPanel = page.getByRole('region', { name: 'Layer mask edges', exact: true });
  await maskPanel.getByLabel('Layer mask edge radius').fill('3');
  for (const operation of ['expand', 'contract', 'border', 'smooth']) {
    await maskPanel.getByLabel('Layer mask edge operation').selectOption(operation);
    const modified = await mutate(() => maskPanel.getByRole('button', { name: 'Apply layer mask edges' }).click());
    const expected = reference(baseline, operation, 3), rendered = await pixels();
    assert.equal(modified.layers[0].protected, true); assert.deepEqual(decode(modified.layers[0].mask), expected); assert.deepEqual(modified.selection, originalSelection); assert.deepEqual(modified.savedSelections, saved);
    for (let i = 0; i < expected.length; i++) { assert.equal(rendered[i * 4 + 3], expected[i]); if (expected[i]) assert.deepEqual(rendered.subarray(i * 4, i * 4 + 3), raw.subarray(i * 4, i * 4 + 3)); }
    await undo(); assert.deepEqual((await current()).layers[0].mask, originalSelection);
  }
  checkpoint('all four protected-layer mask operations render exact alpha and unchanged RGB, leave active/saved selections independent, and undo as one edit');

  await maskPanel.getByLabel('Layer mask edge operation').selectOption('expand');
  await mutate(() => maskPanel.getByRole('button', { name: 'Apply layer mask edges' }).click()); const final = structuredClone((await current()).layers[0].mask), finalPixels = await pixels();
  await page.reload({ waitUntil: 'networkidle' }); await expect(page.locator('.artboard img')).toBeVisible(); await tab('Layers'); assert.deepEqual((await current()).layers[0].mask, final); assert.deepEqual(await pixels(), finalPixels);
  await page.setViewportSize({ width: 900, height: 900 }); await maskPanel.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.equal(await page.locator('.inspector').evaluate(element => element.scrollWidth <= element.clientWidth), true);
  await page.screenshot({ path: path.join(artifacts, 'layer-mask-edges.png'), animations: 'disabled' });
  await tab('Select'); await selectionPanel.getByLabel('Selection edge operation').selectOption('smooth'); await selectionPanel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(artifacts, 'selection-edges.png'), animations: 'disabled' });
  for (const request of requests.filter(item => ['morph_selection', 'morph_layer_mask'].includes(item.command))) { assert.equal(request.backend, 'native'); assert.equal(request.args.documentId, documentId); assert.ok(Number.isInteger(request.args.expectedRevision)); if (request.command === 'morph_layer_mask') assert.equal(request.args.layerId, layerId); }
  assert.deepEqual(await fs.readFile(path.join(companion.native.assetsDir, sourceAsset)), source); assert.equal(keyReads, 0); assert.equal(providerCalls, 0); assert.deepEqual(errors, []);
  checkpoint('reopened masks/pixels, native revision guards, unchanged original assets, compact layout and zero provider/key/browser errors');
  await fs.writeFile(path.join(artifacts, 'morphology-browser-report.json'), JSON.stringify({ passed: checkpoints, keyReads, providerCalls, browserErrors: errors }, null, 2));
  console.log(`Morphology browser checks passed: ${checkpoints.length} workflows.`);
} catch (error) { await page.screenshot({ path: path.join(artifacts, 'morphology-failure.png'), animations: 'disabled' }).catch(() => {}); console.error('Visible alerts:', await page.getByRole('alert').allTextContents().catch(() => [])); throw error; }
finally { await browser.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
