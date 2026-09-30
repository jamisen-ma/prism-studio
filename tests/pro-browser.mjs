import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { createCompanion } from '../server/index.mjs';

const artifacts = path.resolve('test-results');
await fs.mkdir(artifacts, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-pro-browser-'));
const fixturePath = path.join(dataDir, 'pro-browser-fixture.png');
const width = 320, height = 240;
const original = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const red = y >= 70 && y < 150 && ((x >= 60 && x < 120) || (x >= 200 && x < 260));
  original.set(red ? [220, 40, 55, 255] : [64, 96, 128, 255], (y * width + x) * 4);
}
await sharp(original, { raw: { width, height, channels: 4 } }).png().toFile(fixturePath);
const companion = await createCompanion({ dataDir, port: 0 });
const baseUrl = `http://127.0.0.1:${await companion.listen()}`;
const browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { channel: 'chrome' } : {}) });
const page = await browser.newPage({ viewport: { width: 1536, height: 1000 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(12000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const checkpoints = [];
const readOnly = new Set(['get_document', 'get_preview', 'get_histogram', 'sample_color']);

async function read(command, args = {}) {
  assert.ok(readOnly.has(command), 'Browser tests must perform document mutations through the UI');
  const documentId = await page.getByLabel('Open document').inputValue();
  const response = await fetch(`${baseUrl}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${companion.token}` }, body: JSON.stringify({ backend: 'native', command, args: { documentId, ...args } }) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.result;
}
const current = async () => (await read('get_document')).document;
async function pixels() {
  const preview = await read('get_preview', { maxWidth: 320 });
  return sharp(Buffer.from(preview.data, 'base64')).ensureAlpha().raw().toBuffer();
}
function rgba(data, x, y) { return [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)]; }
async function settled() {
  await expect(page.locator('.save-status .spin')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
}
async function mutate(label, action, predicate = () => true) {
  await settled();
  const before = await current();
  await action();
  await expect.poll(async () => {
    const doc = await current();
    return doc.revision > before.revision && predicate(doc);
  }, { message: label, timeout: 15000 }).toBe(true);
  await settled();
  return current();
}
async function point(x, y) {
  const box = await page.locator('.artboard').boundingBox();
  assert.ok(box);
  return { x: box.x + x / width * box.width, y: box.y + y / height * box.height };
}
async function drag(from, to) {
  const start = await point(...from), end = await point(...to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
}
async function clickCanvas(x, y) { const position = await point(x, y); await page.mouse.click(position.x, position.y); }
async function chooseTool(name) {
  await settled();
  await page.getByRole('button', { name: 'Browse all tools', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Search editing tools').fill(name);
  const entry = dialog.locator('.catalog-entry').filter({ has: page.locator('strong').getByText(name, { exact: true }) });
  await expect(entry).toHaveCount(1);
  await expect(entry.locator('.catalog-tool')).toBeEnabled();
  await entry.locator('.catalog-tool').click();
  await expect(dialog).toHaveCount(0);
}
async function tab(name) { await page.locator('.inspector-tabs').getByRole('button', { name, exact: true }).click(); }
async function undo() { return mutate('Undo must restore a real history state', () => page.getByRole('button', { name: 'Undo (⌘Z)', exact: true }).click()); }
function checkpoint(name) { checkpoints.push(name); console.log(`Verified: ${name}`); }

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('.artboard img').waitFor({ state: 'visible' });
  await page.getByLabel('Import image file').setInputFiles(fixturePath);
  await expect.poll(async () => (await current()).name).toBe('pro-browser-fixture.png');
  await settled();
  assert.deepEqual(await pixels(), original);
  const initial = await current();

  await page.getByRole('button', { name: 'Brush (B)', exact: true }).click();
  await page.getByLabel('Brush size', { exact: true }).fill('24');
  await page.getByLabel('Brush color', { exact: true }).fill('#ff00ff');
  await page.getByLabel('Brush hardness', { exact: true }).press('End');
  await page.getByLabel('Brush opacity', { exact: true }).press('End');
  const painted = await mutate('Brush gesture must alter the imported raster', () => drag([60, 180], [250, 180]), doc => doc.layers[0].asset !== initial.layers[0].asset);
  assert.equal(painted.layers.length, 1);
  assert.deepEqual(rgba(await pixels(), 155, 180), [255, 0, 255, 255]);
  await undo();
  assert.deepEqual(await pixels(), original);
  checkpoint('canvas brush stroke changes real pixels and undo restores every byte');

  await page.getByRole('button', { name: 'Ellipse selection', exact: true }).click();
  await mutate('Ellipse drag creates backend selection', () => drag([40, 30], [280, 210]), doc => doc.selection?.shape === 'ellipse');
  await expect(page.locator('.canvas-selection')).toHaveCount(1);
  await tab('Layers');
  await mutate('Selection becomes a real layer mask', () => page.getByRole('button', { name: 'Mask from selection', exact: true }).click(), doc => Boolean(doc.layers[0].mask));
  const masked = await pixels();
  assert.equal(rgba(masked, 0, 0)[3], 0);
  assert.equal(rgba(masked, 160, 120)[3], 255);
  await undo();
  assert.deepEqual(await pixels(), original);
  await mutate('Deselect clears active ellipse', () => page.getByRole('button', { name: 'Deselect', exact: true }).click(), doc => !doc.selection);
  checkpoint('ellipse selection and mask-from-selection affect the actual composite');

  await page.getByRole('button', { name: 'Magic wand (W)', exact: true }).click();
  await page.getByLabel('Region tolerance').fill('0');
  await mutate('Magic wand selects only a matching connected region', () => clickCanvas(80, 100), doc => doc.selection?.shape === 'bitmap');
  await chooseTool('Paint Bucket');
  await page.getByLabel('Fill color', { exact: true }).fill('#00ff00');
  await expect(page.getByLabel('Fill opacity')).toHaveValue('100'); // Bucket defaults to 100%, independent of brush opacity
  await mutate('Bucket fills the selected color region', () => clickCanvas(80, 100));
  const filled = await pixels();
  assert.deepEqual(rgba(filled, 80, 100), [0, 255, 0, 255]);
  assert.deepEqual(rgba(filled, 220, 100), rgba(original, 220, 100));
  assert.deepEqual(rgba(filled, 160, 120), rgba(original, 160, 120));
  const filledRevision = (await current()).revision;
  await page.getByRole('button', { name: 'Eyedropper (I)', exact: true }).click();
  await clickCanvas(80, 100);
  await expect(page.getByText('Sampled #00FF00 from the composite.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Text foreground color')).toHaveValue('#00ff00');
  assert.equal((await current()).revision, filledRevision);
  await undo();
  await mutate('Deselect clears the magic-wand selection', () => page.getByRole('button', { name: 'Deselect', exact: true }).click(), doc => !doc.selection);
  assert.deepEqual(await pixels(), original);
  checkpoint('magic wand, bucket, and eyedropper use actual selected composite pixels');

  await chooseTool('Gradient');
  await page.locator('.vector-options').getByLabel('Gradient start', { exact: true }).fill('#101b37');
  await page.locator('.vector-options').getByLabel('Gradient end', { exact: true }).fill('#ae78dd');
  let document = await mutate('Gradient drag adds an editable gradient layer', () => drag([20, 120], [300, 120]), doc => doc.layers.at(-1).type === 'gradient');
  const gradient = document.layers.at(-1);
  assert.notDeepEqual(rgba(await pixels(), 30, 120), rgba(await pixels(), 290, 120));
  await page.getByLabel('Edit gradient type').selectOption('radial');
  document = await mutate('Gradient properties update the same layer', () => page.getByRole('button', { name: 'Update gradient', exact: true }).click(), doc => doc.layers.find(layer => layer.id === gradient.id).gradient.kind === 'radial');
  assert.equal(document.layers.length, 2);
  document = await mutate('Dragging the selected gradient end handle edits it in place', () => drag([300, 120], [260, 60]), doc => doc.layers.find(layer => layer.id === gradient.id).gradient.end.y === 60);
  assert.equal(document.layers.length, 2);
  assert.deepEqual(document.layers.find(layer => layer.id === gradient.id).gradient.end, { x: 260, y: 60 });
  await undo();
  document = await mutate('Shift-drag snaps a new gradient to 45 degrees', async () => { await page.keyboard.down('Shift'); await drag([60, 200], [200, 190]); await page.keyboard.up('Shift'); }, doc => doc.layers.length === 3);
  assert.deepEqual([document.layers.at(-1).gradient.start, document.layers.at(-1).gradient.end], [{ x: 60, y: 200 }, { x: 200, y: 200 }]);
  await undo();
  checkpoint('gradient drawing and property editing preserve a single editable layer; end handles edit on canvas and Shift snaps direction');

  await chooseTool('Star');
  await expect(page.getByLabel('Shape type', { exact: true })).toHaveValue('star');
  document = await mutate('Star catalog entry draws the correct shape variant', () => drag([40, 40], [150, 150]), doc => doc.layers.at(-1).type === 'shape');
  const shape = document.layers.at(-1);
  assert.equal(shape.vector.shape, 'star');
  await page.locator('.shape-properties').getByLabel('Shape width', { exact: true }).fill('100');
  await page.locator('.shape-properties').getByLabel('Shape fill', { exact: true }).fill('#ffb666');
  document = await mutate('Shape properties revise the existing shape', () => page.getByRole('button', { name: 'Update shape', exact: true }).click(), doc => doc.layers.find(layer => layer.id === shape.id).vector.fill === '#ffb666');
  assert.equal(document.layers.length, 3);
  assert.equal(document.layers.find(layer => layer.id === shape.id).vector.width, 100);
  assert.equal(await page.getByLabel('Layer blend mode').locator('option').count(), 27);
  document = await mutate('Soft light blend mode is supported by the actual layer', () => page.getByLabel('Layer blend mode').selectOption('soft_light'), doc => doc.layers.find(layer => layer.id === shape.id).blendMode === 'soft_light');
  await mutate('Restore normal blend', () => page.getByLabel('Layer blend mode').selectOption('normal'));
  checkpoint('Star opens the right variant; existing shape updates and all 27 blend modes are exposed');

  await page.getByRole('button', { name: 'Pen (P)', exact: true }).click();
  await drag([180, 70], [200, 40]);
  await clickCanvas(270, 100);
  await clickCanvas(210, 190);
  document = await mutate('Pen gesture commits an editable Bezier path', () => page.getByRole('button', { name: 'Create path ↵', exact: true }).click(), doc => doc.layers.at(-1).type === 'path');
  const vectorPath = document.layers.at(-1);
  assert.equal(vectorPath.vector.nodes.length, 3);
  assert.ok(vectorPath.vector.nodes[0].out && vectorPath.vector.nodes[0].in);
  await page.getByLabel('Path anchor x', { exact: true }).fill('170');
  document = await mutate('Path coordinates update the existing path', () => page.getByRole('button', { name: 'Update path', exact: true }).click(), doc => doc.layers.find(layer => layer.id === vectorPath.id).vector.nodes[0].x === 170);
  assert.equal(document.layers.length, 4);
  await page.getByRole('button', { name: 'Edit anchors on canvas', exact: true }).click();
  document = await mutate('Dragging an existing anchor changes its stored geometry', () => drag([170, 70], [165, 80]), doc => doc.layers.find(layer => layer.id === vectorPath.id).vector.nodes[0].y === 80);
  assert.equal(document.layers.length, 4);
  assert.equal(document.layers.find(layer => layer.id === vectorPath.id).vector.nodes[0].x, 165);
  checkpoint('Pen handles, numeric edits, and canvas anchor dragging update one editable path');

  await tab('Adjustments');
  await page.getByLabel('Midtone gamma', { exact: true }).fill('1.4');
  document = await mutate('Levels control adds a levels adjustment', () => page.getByRole('button', { name: 'Add levels layer', exact: true }).click(), doc => doc.layers.at(-1).kind === 'levels');
  const levels = document.layers.at(-1);
  await tab('Layers');
  await page.getByLabel('Midtone gamma', { exact: true }).fill('0.85');
  document = await mutate('Levels properties revise the selected adjustment', () => page.getByRole('button', { name: 'Update levels', exact: true }).click(), doc => doc.layers.find(layer => layer.id === levels.id).parameters.gamma === 0.85);
  assert.equal(document.layers.filter(layer => layer.kind === 'levels').length, 1);
  await tab('Adjustments');
  await page.locator('.color-mode-tabs').getByRole('button', { name: 'Curves', exact: true }).click();
  const curveBox = await page.locator('.curve-editor').boundingBox();
  assert.ok(curveBox);
  await page.mouse.click(curveBox.x + curveBox.width * 0.5, curveBox.y + curveBox.height * 0.3);
  document = await mutate('Curve gesture adds a real curve point', () => page.getByRole('button', { name: 'Add curves layer', exact: true }).click(), doc => doc.layers.at(-1).kind === 'curves');
  const curves = document.layers.at(-1);
  assert.equal(curves.parameters.points.length, 3);
  await tab('Layers');
  await page.getByLabel('Curve channel', { exact: true }).selectOption('blue');
  await page.getByLabel('Curve point output', { exact: true }).fill('20');
  document = await mutate('Curve properties revise the selected adjustment', () => page.getByRole('button', { name: 'Update curves', exact: true }).click(), doc => doc.layers.find(layer => layer.id === curves.id).parameters.channel === 'blue');
  assert.equal(document.layers.filter(layer => layer.kind === 'curves').length, 1);
  assert.equal(document.layers.length, 6);
  assert.equal(document.layers.find(layer => layer.id === curves.id).parameters.points[0].y, 20);
  checkpoint('levels and interactive curves remain editable without duplicate adjustment layers');

  if (await page.getByRole('button', { name: 'Dismiss notification', exact: true }).count()) await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
  for (let index = 0; index < 3; index++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.locator('.editable-adjustment').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(artifacts, 'pro-workspace.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Browse all tools', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Search editing tools').fill('Remove');
  const planned = dialog.locator('.catalog-entry').filter({ has: page.locator('strong').getByText('Remove', { exact: true }) });
  await expect(planned.locator('.catalog-tool')).toBeDisabled();
  await expect(planned).toContainText('Not implemented yet');
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: path.join(artifacts, 'pro-tools.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.setViewportSize({ width: 900, height: 800 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: path.join(artifacts, 'pro-compact-workspace.png'), fullPage: true, animations: 'disabled' });
  await settled();
  assert.deepEqual(errors, [], 'Professional tool journey must produce no browser or console errors');
  checkpoint('planned Remove tool stays disabled and the 900px workspace has no horizontal overflow');
  console.log(`Professional browser checks passed (${checkpoints.length} journeys). Screenshots: ${artifacts}`);
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, 'pro-failure.png'), fullPage: true, animations: 'disabled' }).catch(() => {});
  console.error('Completed journeys:', checkpoints.join('; '));
  console.error('Visible alerts:', await page.getByRole('alert').allTextContents().catch(() => []));
  throw error;
} finally {
  await browser.close();
  await companion.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
