import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCompanion } from '../server/index.mjs';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-capture-ui-'));
const artifacts = path.resolve('test-results'); await fs.mkdir(artifacts, { recursive: true });
let keyReads = 0, providerCalls = 0;
const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => { keyReads++; return null; }, imageProvider: async () => { providerCalls++; throw Error('Capture tests cannot generate.'); } });
let document = (await companion.native.execute('create_document', { name: 'Pointer capture', width: 320, height: 240, background: '#305580' })).document;
const documentId = document.id;
document = (await companion.native.execute('add_paint_layer', { documentId, name: 'Paint target' })).document; const paintId = document.layers.at(-1).id;
document = (await companion.native.execute('add_path', { documentId, name: 'Anchor target', nodes: [{ x: 80, y: 60 }, { x: 160, y: 120 }], stroke: '#ffffff', strokeWidth: 4 })).document; const pathId = document.layers.at(-1).id;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(12000);
const errors = [], requests = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/command')) requests.push(request.postDataJSON()); });
await page.route('https://**', route => route.abort());
const current = async () => (await companion.native.execute('get_document', { documentId })).document;
const settled = async () => { await expect(page.locator('.save-status .spin')).toHaveCount(0); await expect(page.getByRole('alert')).toHaveCount(0); };
const artboard = page.locator('.artboard');
async function point(x, y) { const box = await artboard.boundingBox(); return { x: box.x + x / 320 * box.width, y: box.y + y / 240 * box.height }; }
async function begin(x = 80, y = 60) { const p = await point(x, y); await page.mouse.move(p.x, p.y); await page.mouse.down(); }
async function move(x, y) { const p = await point(x, y); await page.mouse.move(p.x, p.y, { steps: 3 }); }
async function click(x, y) { const p = await point(x, y); await page.mouse.click(p.x, p.y); }
async function selectLayer(id) { const layer = (await current()).layers.find(item => item.id === id); await page.locator('.layer-row').filter({ has: page.getByText(layer.name, { exact: true }) }).click(); }
const choose = name => page.getByRole('button', { name, exact: true }).click();
function checkpoint(message) { checks.push(message); console.log(`Verified: ${message}`); }
async function loseCapture({ finish = true } = {}) {
  const before = await artboard.evaluate(element => { const audit = element.__captureAudit; if (!element.hasPointerCapture(audit.pointerId)) throw Error('Expected real captured pointer'); element.releasePointerCapture(audit.pointerId); return audit.lost; });
  await move(180, 145); // Real pointer dispatch processes the pending lost event.
  await expect.poll(() => artboard.evaluate(element => element.__captureAudit.lost)).toBeGreaterThan(before);
  if (finish) await page.mouse.up();
}
try {
  await page.goto(`http://127.0.0.1:${await companion.listen()}`, { waitUntil: 'networkidle' }); await expect(artboard).toBeVisible();
  await artboard.evaluate(element => {
    element.__captureAudit = { pointerId: null, lost: 0 };
    element.addEventListener('pointerdown', event => { element.__captureAudit.pointerId = event.pointerId; });
    element.addEventListener('lostpointercapture', () => { element.__captureAudit.lost++; });
  });
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Layers', exact: true }).click();
  await selectLayer(paintId);
  for (const button of ['Rectangle selection (M)', 'Ellipse selection', 'Lasso selection (L)', 'Brush (B)', 'Vector shape (U)', 'Crop (C)']) {
    await choose(button); await settled(); const before = await current(), count = requests.length;
    await begin(); await move(160, 65); await move(150, 140); await loseCapture();
    assert.deepEqual(await current(), before, `${button} must abandon lost capture`); assert.equal(requests.length, count);
    await expect(page.locator('.crop-selection')).toHaveCount(0);
    if (button.includes('Crop')) await expect(page.getByRole('button', { name: 'Apply crop', exact: true })).toHaveCount(0);
  }
  await page.keyboard.press('g'); let before = await current(), count = requests.length;
  await begin(); await move(210, 150); await loseCapture(); assert.deepEqual(await current(), before); assert.equal(requests.length, count);
  checkpoint('real capture loss cancels rectangle, ellipse, lasso, brush, shape, crop and gradient with no command or history change');

  await choose('Pen (P)'); await click(50, 40); await expect(page.locator('.vector-options')).toContainText('1 anchors');
  await begin(90, 70); await move(100, 85); before = await current(); count = requests.length; await loseCapture();
  await expect(page.locator('.vector-options')).toContainText('0 anchors'); assert.deepEqual(await current(), before); assert.equal(requests.length, count);
  await selectLayer(pathId); await choose('Edit anchors on canvas'); before = await current(); count = requests.length;
  await begin(); await move(105, 90); await loseCapture(); assert.deepEqual(await current(), before); assert.equal(requests.length, count);
  checkpoint('capture loss clears a pending multi-anchor path and cancels existing-anchor movement');

  // A foreign pointer's lost event must not cancel the real captured drag.
  await selectLayer(paintId);
  for (const [button, command] of [['Rectangle selection (M)', 'select_region'], ['Brush (B)', 'paint_stroke'], ['Vector shape (U)', 'add_shape']]) {
    await choose(button); const revision = (await current()).revision, startRequest = requests.length;
    await begin(); await move(150, 120);
    await artboard.dispatchEvent('lostpointercapture', { pointerId: 99, pointerType: 'touch' });
    assert.equal((await current()).revision, revision); await page.mouse.up();
    await expect.poll(async () => (await current()).revision).toBeGreaterThan(revision); await settled();
    assert.equal(requests.slice(startRequest).filter(item => item.command === command).length, 1);
    const changed = (await current()).revision; await choose('Undo (⌘Z)'); await expect.poll(async () => (await current()).revision).toBeGreaterThan(changed); await settled(); await selectLayer(paintId);
  }
  await choose('Pen (P)'); const revision = (await current()).revision;
  await click(70, 50); await expect(page.locator('.vector-options')).toContainText('1 anchors');
  await click(160, 130); await expect(page.locator('.vector-options')).toContainText('2 anchors');
  await choose('Create path ↵'); await expect.poll(async () => (await current()).revision).toBeGreaterThan(revision); await settled();
  assert.equal(requests.filter(item => item.command === 'add_path').length, 1); assert.equal((await current()).layers.at(-1).vector.nodes.length, 2);
  await choose('Crop (C)'); await begin(30, 30); await move(240, 180); await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Apply crop', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  checkpoint('unrelated lost events leave the real gesture intact; normal releases commit drawing and preserve pending pen anchors and crop');

  for (let step = 0; step < 20; step++) await choose('Zoom in');
  await choose('Hand tool (H)');
  const viewport = page.locator('.canvas-viewport');
  await viewport.evaluate(element => { element.scrollLeft = 150; element.scrollTop = 150; });
  before = await current(); count = requests.length;
  await begin(120, 100); await move(100, 90); await loseCapture({ finish: false });
  const scroll = await viewport.evaluate(element => [element.scrollLeft, element.scrollTop]);
  await move(80, 70); assert.deepEqual(await viewport.evaluate(element => [element.scrollLeft, element.scrollTop]), scroll);
  await page.mouse.up();
  assert.deepEqual(await current(), before); assert.equal(requests.length, count);
  assert.equal(keyReads, 0); assert.equal(providerCalls, 0); assert.deepEqual(errors, []);
  checkpoint('hand panning stops after capture loss without a document mutation or stale later movement');
  await fs.writeFile(path.join(artifacts, 'pointer-capture-browser-report.json'), JSON.stringify({ passed: checks, keyReads, providerCalls, browserErrors: errors }, null, 2));
  console.log(`Pointer capture checks passed: ${checks.length} workflows.`);
} catch (error) {
  console.error('Browser errors:', errors);
  await page.mouse.up().catch(() => {}); await page.screenshot({ path: path.join(artifacts, 'pointer-capture-failure.png'), animations: 'disabled' }).catch(() => {}); throw error;
} finally { await browser.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
