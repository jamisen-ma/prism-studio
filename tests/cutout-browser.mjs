import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { createCompanion } from '../server/index.mjs';

const artifacts = path.resolve('test-results');
await fs.mkdir(artifacts, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-cutout-browser-'));
const width = 240, height = 180, raw = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const subject = x >= 80 && x < 160 && y >= 30 && y < 150;
  const accessory = x >= 160 && x < 177 && y >= 100 && y < 125;
  raw.set(subject ? [137, 52, 92, 255] : accessory ? [240, 176, 55, 255] : [82, 121, 153, 255], (y * width + x) * 4);
}
const photoPath = path.join(dataDir, 'portrait-and-bag.png'), backdropPath = path.join(dataDir, 'cream-composition.png');
await sharp(raw, { raw: { width, height, channels: 4 } }).png().toFile(photoPath);
await sharp({ create: { width, height, channels: 4, background: '#f4ecdb' } }).png().toFile(backdropPath);
let segmentationCalls = 0;
const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => null, imageProvider: async () => { throw new Error('Cutout tests must never invoke an image provider.'); }, segmentSubject: async (data) => {
  segmentationCalls++;
  const metadata = await sharp(data).metadata();
  const alpha = Buffer.alloc(metadata.width * metadata.height);
  for (let y = 30; y < Math.min(150, metadata.height); y++) for (let x = 80; x < Math.min(160, metadata.width); x++) alpha[y * metadata.width + x] = 255;
  return { alpha, width: metadata.width, height: metadata.height, model: 'injected-subject-fixture' };
} });
const baseUrl = `http://127.0.0.1:${await companion.listen()}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
page.setDefaultTimeout(12000);
const errors = [], requests = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/command')) requests.push(request.postDataJSON()); });
let modelInstalled = false;
await page.route('**/api/status', async route => { const response = await route.fetch(); const body = await response.json(); body.segmentation = { installed: modelInstalled, model: 'injected-subject-fixture', local: true, running: false, limitations: [] }; await route.fulfill({ response, json: body }); });
await page.route('https://**', route => route.abort());
const dialog = page.getByRole('dialog');
const current = async () => (await companion.native.execute('get_document', { documentId: await page.getByLabel('Open document').inputValue() })).document;
const pixels = async () => { const result = await companion.native.execute('get_preview', { documentId: (await current()).id, maxWidth: width }); return sharp(Buffer.from(result.data, 'base64')).ensureAlpha().raw().toBuffer(); };
const rgba = (data, x, y) => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
async function settled() { await expect(page.locator('.save-status .spin')).toHaveCount(0); await expect(page.getByRole('alert')).toHaveCount(0); }
async function mutate(action, predicate = () => true) { const before = await current(); await action(); await expect.poll(async () => { const document = await current(); return document.revision > before.revision && predicate(document); }).toBe(true); await settled(); return current(); }
async function openPanel() { await page.getByRole('button', { name: 'Open Cutouts', exact: true }).click(); await expect(dialog.getByText('Keep what matters.', { exact: true })).toBeVisible(); }
async function canvasPoint(x, y) { const bounds = await page.locator('.artboard').boundingBox(); assert.ok(bounds); return { x: bounds.x + x / width * bounds.width, y: bounds.y + y / height * bounds.height }; }
async function dab(x, y) { const at = await canvasPoint(x, y); await page.mouse.click(at.x, at.y); }
function checkpoint(message) { checks.push(message); console.log(`Verified: ${message}`); }

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await expect(page.locator('.artboard img')).toBeVisible();
  await page.getByLabel('Import image file').setInputFiles(photoPath);
  await expect.poll(async () => (await current()).name).toBe('portrait-and-bag.png');
  const original = await current(), sourceId = original.id, originalAsset = original.layers[0].asset;
  await openPanel();
  await expect(dialog.getByText('npm run setup:segmentation', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Extract subject', exact: true })).toBeDisabled();
  assert.equal(segmentationCalls, 0);
  modelInstalled = true;
  await expect(dialog.getByText('Local model ready', { exact: true })).toBeVisible({ timeout: 12000 });
  await dialog.getByLabel('Cutout name', { exact: true }).fill('Subject with original detail');
  let document = await mutate(() => dialog.getByRole('button', { name: 'Extract subject', exact: true }).click(), doc => doc.layers.length === 2);
  const cutoutId = document.layers[1].id;
  assert.equal(document.layers[0].visible, false); assert.equal(document.layers[1].protected, true); assert.equal(document.layers[1].asset, originalAsset); assert.ok(document.layers[1].alphaAsset);
  let data = await pixels();
  assert.deepEqual(rgba(data, 120, 90), [137, 52, 92, 255]); assert.equal(rgba(data, 20, 20)[3], 0); assert.equal(rgba(data, 167, 112)[3], 0);
  await expect(dialog.getByLabel('Cutout source layer')).toHaveValue(cutoutId);
  await expect(dialog.getByAltText('Cutout document preview')).toBeVisible();
  checkpoint('missing-model guard, local extraction, original asset preservation and transparent result');

  await dialog.getByLabel('Outside outline width').fill('5');
  await mutate(() => dialog.getByRole('button', { name: 'Apply outline', exact: true }).click(), doc => doc.layers[1].outline?.width === 5);
  data = await pixels(); assert.deepEqual(rgba(data, 77, 90), [255, 255, 255, 255]); assert.deepEqual(rgba(data, 120, 90), [137, 52, 92, 255]);
  await page.screenshot({ path: path.join(artifacts, 'cutout-browser-extracted.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Refine mask', exact: true }).click();
  await expect(page.getByLabel('Mask brush target')).toHaveValue('cutout_brush');
  await page.getByLabel('Brush size', { exact: true }).fill('10');
  await page.getByLabel('Brush hardness', { exact: true }).press('End');
  await page.getByLabel('Brush opacity', { exact: true }).press('End');
  await page.getByLabel('Mask brush mode').selectOption('add');
  await mutate(() => dab(167, 112));
  data = await pixels(); assert.deepEqual(rgba(data, 167, 112), [240, 176, 55, 255]);
  document = await current(); assert.equal(document.layers[1].asset, originalAsset); assert.equal(document.layers[1].protected, true);
  await page.getByLabel('Mask brush mode').selectOption('subtract');
  await page.getByLabel('Brush size', { exact: true }).fill('24');
  await mutate(() => dab(120, 90));
  assert.equal(rgba(await pixels(), 120, 90)[3], 0);
  await mutate(() => page.getByRole('button', { name: 'Undo (⌘Z)', exact: true }).click());
  assert.deepEqual(rgba(await pixels(), 120, 90), [137, 52, 92, 255]);
  checkpoint('outside outline preserves subject RGB; alpha brush restores missed accessories, removes coverage and undoes');

  await openPanel();
  await mutate(() => dialog.getByRole('button', { name: 'Select subject', exact: true }).click(), doc => doc.selection?.shape === 'bitmap');
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.locator('.bitmap-selection-overlay')).toHaveCount(1);
  await mutate(() => page.getByRole('button', { name: 'Deselect', exact: true }).click(), doc => !doc.selection);
  await expect(page.locator('.layer-row.selected').getByLabel('Original pixels protected')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete selected layer', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Layer blend mode')).toBeDisabled();
  const beforeAdjustment = await pixels();
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Adjustments', exact: true }).click();
  await page.getByRole('button', { name: 'Brightness 0', exact: true }).click();
  await page.getByLabel('Brightness', { exact: true }).fill('30');
  await mutate(() => page.getByRole('button', { name: 'Add adjustment layer', exact: true }).click());
  const afterAdjustment = await pixels();
  for (let offset = 0; offset < beforeAdjustment.length; offset += 4) {
    if (beforeAdjustment[offset + 3]) assert.ok(beforeAdjustment.subarray(offset, offset + 4).equals(afterAdjustment.subarray(offset, offset + 4)), `Protected visible pixel changed at ${offset / 4}`);
    else assert.equal(afterAdjustment[offset + 3], 0);
  }
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Layers', exact: true }).click();
  await page.locator('.layer-row').filter({ hasText: 'Subject with original detail' }).click();
  await mutate(() => page.getByLabel('Protect original pixels', { exact: true }).click(), doc => doc.layers.find(layer => layer.id === cutoutId).protected === false);
  assert.notDeepEqual(rgba(await pixels(), 120, 90), [137, 52, 92, 255]);
  await mutate(() => page.getByLabel('Protect original pixels', { exact: true }).click());
  checkpoint('subject selection and visible protection state; adjustments respect protection and explicit unprotect works');

  await page.getByLabel('Import image file').setInputFiles(backdropPath);
  await expect.poll(async () => (await current()).name).toBe('cream-composition.png');
  const targetId = (await current()).id;
  await openPanel();
  await dialog.getByRole('button', { name: 'Place in this document', exact: true }).click();
  await dialog.getByLabel('Placement source document').selectOption(sourceId);
  await dialog.getByLabel('Placement source layer').selectOption(cutoutId);
  await expect(dialog.getByAltText('Source document preview')).toBeVisible();
  await dialog.getByLabel('Placement x position').fill('40'); await dialog.getByLabel('Placement y position').fill('20');
  await dialog.getByLabel('Placement width').fill('160'); await dialog.getByLabel('Placement height').fill('140');
  await dialog.getByLabel('Placed layer name').fill('Placed subject');
  document = await mutate(() => dialog.getByRole('button', { name: 'Place layer', exact: true }).click(), doc => doc.layers.length === 2);
  assert.equal(document.id, targetId); assert.equal(document.layers[1].origin.documentId, sourceId); assert.equal(document.layers[1].protected, true);
  const placement = requests.findLast(request => request.command === 'place_layer'); assert.ok(placement.args.sourceExpectedRevision);
  assert.equal(document.layers[1].placement.height, 140); assert.ok(document.layers[1].placement.width < 160);
  await page.screenshot({ path: path.join(artifacts, 'cutout-browser-placed.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Refine mask', exact: true }).click();
  await expect(page.getByLabel('Mask brush target')).toHaveValue('mask_brush');
  await expect(page.getByLabel('Mask brush target').locator('option[value="cutout_brush"]')).toHaveAttribute('disabled', '');
  checkpoint('cross-document placement preserves proportions and inspected source revision; placed layers direct restoration to source');

  await page.locator('.quick-grid').getByRole('button', { name: 'Add text', exact: true }).click();
  await dialog.getByLabel('Your text').fill('Made of summer.');
  await dialog.getByLabel('New text typeface').selectOption('Fraunces');
  await dialog.getByLabel('Font size, px', { exact: true }).fill('22');
  await dialog.getByLabel('X position, px', { exact: true }).fill('12'); await dialog.getByLabel('Y position, px', { exact: true }).fill('28');
  await dialog.getByLabel('Bold', { exact: true }).check();
  document = await mutate(() => dialog.getByRole('button', { name: 'Add text layer', exact: true }).click(), doc => doc.layers.at(-1).type === 'text');
  assert.equal(document.layers.at(-1).fontFamily, 'Fraunces'); assert.equal(document.layers.at(-1).fontWeight, 'bold');
  await expect(page.getByLabel('Text typeface', { exact: true })).toHaveValue('Fraunces');
  await page.getByLabel('Italic', { exact: true }).check();
  document = await mutate(() => page.getByRole('button', { name: 'Update text layer', exact: true }).click());
  assert.equal(document.layers.at(-1).fontStyle, 'italic');
  checkpoint('Fraunces add/edit typography sends the bundled family and real weight/style metadata');

  // Read-only generation fixtures exercise retained history and preview retry;
  // no generation request or credential is involved in these recovery checks.
  const jobs = Array.from({ length: 10 }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, mode: 'generate', prompt: index === 9 ? 'Older saved output' : `Recent request ${index + 1}`, model: 'gpt-image-2.5-sunburst', quality: 'medium', size: 'auto', background: 'auto', scope: 'canvas', status: index === 9 ? 'ready' : 'cancelled', createdAt: new Date(Date.now() - index * 60000).toISOString(), updatedAt: new Date(Date.now() - index * 60000).toISOString(), outputAvailable: index === 9 }));
  let previewAttempts = 0;
  await page.route('**/api/ai/status', async route => { const response = await route.fetch(); const body = await response.json(); body.configured = true; await route.fulfill({ response, json: body }); });
  await page.route('**/api/ai/jobs', route => { assert.equal(route.request().method(), 'GET'); return route.fulfill({ json: { jobs } }); });
  await page.route('**/api/ai/jobs/*/preview', async route => {
    previewAttempts++;
    await route.fulfill({ json: previewAttempts === 1 ? { ok: false, error: { message: 'Temporary preview failure for recovery test.' } } : { data: (await fs.readFile(photoPath)).toString('base64'), mimeType: 'image/png', width, height } });
  });
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Chat', exact: true }).click();
  await page.getByRole('button', { name: 'Open image generation', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Retry preview', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Retry preview', exact: true }).click();
  await expect(dialog.getByAltText('Generated result preview')).toBeVisible();
  await expect(dialog.locator('.generation-history-item')).toHaveCount(8);
  await dialog.getByRole('button', { name: 'Show all 10 requests', exact: true }).click();
  await expect(dialog.locator('.generation-history-item')).toHaveCount(10);
  await dialog.locator('.generation-history-item').filter({ hasText: 'Older saved output' }).click();
  await expect(dialog.getByRole('button', { name: 'Create document from result', exact: true })).toBeVisible();
  await dialog.getByLabel('Generation destination').selectOption('layer');
  await dialog.getByLabel('Generated layer canvas fit').selectOption('cover');
  await expect(dialog.getByLabel('Generated layer canvas fit')).toHaveValue('cover');
  await dialog.getByRole('button', { name: 'Edit canvas', exact: true }).click();
  await expect(dialog.getByLabel('Generated layer canvas fit')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  checkpoint('older retained generation remains accessible, failed preview retries, and fit choices only appear for generated layers');

  await page.setViewportSize({ width: 900, height: 850 });
  await openPanel();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await expect(dialog.getByRole('button', { name: 'Rasterize layer', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Extract subject', exact: true })).toBeDisabled();
  await page.screenshot({ path: path.join(artifacts, 'cutout-browser-compact.png'), fullPage: true });
  assert.deepEqual(errors, []); assert.equal(segmentationCalls, 2);
  checkpoint('compact layout, actionable non-raster target state and no browser errors');
  await fs.writeFile(path.join(artifacts, 'cutout-browser-report.json'), JSON.stringify({ passed: checks, segmentationCalls, paidApiCalls: 0, browserErrors: errors }, null, 2));
  console.log(`Cutout browser checks passed (${checks.length} workflows; no paid API calls).`);
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, 'cutout-browser-failure.png'), fullPage: true }).catch(() => {});
  console.error('Visible alerts:', await page.getByRole('alert').allTextContents().catch(() => [])); throw error;
} finally { await browser.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
