import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCompanion } from '../server/index.mjs';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-gesture-ui-'));
const artifacts = path.resolve('test-results'); await fs.mkdir(artifacts, { recursive: true });
let keyReads = 0, providerCalls = 0;
const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => { keyReads++; return null; }, imageProvider: async () => { providerCalls++; throw Error('Gesture tests cannot generate.'); } });
let doc = (await companion.native.execute('create_document', { name: 'Gesture A', width: 320, height: 240, background: '#305580' })).document;
const documentId = doc.id;
doc = (await companion.native.execute('add_paint_layer', { documentId, name: 'Paint target' })).document; const paintId = doc.layers.at(-1).id;
doc = (await companion.native.execute('add_path', { documentId, name: 'Path target', nodes: [{ x: 80, y: 60 }, { x: 160, y: 120 }], stroke: '#ffffff', strokeWidth: 4 })).document; const pathId = doc.layers.at(-1).id;
const other = (await companion.native.execute('create_document', { name: 'Gesture B', width: 320, height: 240, background: '#883377' })).document;
const url = `http://127.0.0.1:${await companion.listen()}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(12000);
const errors = [], requests = [], conflicts = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error' && !message.text().includes('409')) errors.push(message.text()); });
page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/command')) requests.push(request.postDataJSON()); });
page.on('response', response => { if (response.status() === 409 && response.url().endsWith('/api/command')) conflicts.push(response); });
await page.route('https://**', route => route.abort());
const current = async (id = documentId) => (await companion.native.execute('get_document', { documentId: id })).document;
const settled = async () => { await expect(page.locator('.save-status .spin')).toHaveCount(0); };
async function selectLayer(id) { const layer = (await current()).layers.find(item => item.id === id); await page.locator('.layer-row').filter({ has: page.getByText(layer.name, { exact: true }) }).click(); }
async function point(x, y) { const box = await page.locator('.artboard').boundingBox(); return { x: box.x + x / 320 * box.width, y: box.y + y / 240 * box.height }; }
async function begin(x = 80, y = 60) { const p = await point(x, y); await page.mouse.move(p.x, p.y); await page.mouse.down(); }
async function move(x, y) { const p = await point(x, y); await page.mouse.move(p.x, p.y, { steps: 5 }); }
async function clickPoint(x, y) { const p = await point(x, y); await page.mouse.click(p.x, p.y); }
const choose = name => page.getByRole('button', { name, exact: true }).click();
async function externalEdit() {
  const before = await current();
  return (await companion.native.execute('set_layer', { documentId, expectedRevision: before.revision, layerId: paintId, name: `Paint target ${before.revision}` })).document;
}
async function conflictCommit(command, start, finish) {
  await settled(); await expect(page.getByRole('alert')).toHaveCount(0);
  const before = await current(), previous = conflicts.length;
  await start(); const changed = await externalEdit(); await finish();
  await expect(page.getByRole('alert')).toContainText('document changed while you were drawing'); await settled();
  assert.equal(conflicts.length, previous + 1); const sent = requests.filter(request => request.command === command).at(-1);
  assert.equal(sent.args.documentId, documentId); assert.equal(sent.args.expectedRevision, before.revision);
  assert.deepEqual(await current(), changed, `${command} must not modify the externally revised document`);
  await expect(page.locator('.layer-row').filter({ has: page.getByText(changed.layers.find(item => item.id === paintId).name, { exact: true }) })).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss notification' }).click();
}
function checkpoint(message) { checks.push(message); console.log(`Verified: ${message}`); }
try {
  await page.goto(url, { waitUntil: 'networkidle' }); await expect(page.locator('.artboard img')).toBeVisible();
  await page.getByLabel('Open document').selectOption(documentId); await settled();
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Layers', exact: true }).click(); await selectLayer(paintId);
  for (const [button, command] of [['Rectangle selection (M)', 'select_region'], ['Ellipse selection', 'select_region'], ['Lasso selection (L)', 'select_region'], ['Brush (B)', 'paint_stroke'], ['Vector shape (U)', 'add_shape']]) {
    await choose(button);
    await conflictCommit(command, async () => { await begin(); await move(160, 65); await move(150, 140); }, () => page.mouse.up());
  }
  await page.keyboard.press('g');
  await conflictCommit('add_gradient', async () => { await begin(); await move(210, 150); }, () => page.mouse.up());
  checkpoint('rectangle, ellipse, lasso, brush, shape and gradient reject the captured stale revision, preserve external edits and refresh for recovery');

  await choose('Pen (P)');
  await conflictCommit('add_path', async () => { await clickPoint(80, 60); await clickPoint(160, 120); }, () => choose('Create path ↵'));
  await expect(page.locator('.vector-options')).toContainText('0 anchors');
  await selectLayer(pathId); await choose('Edit anchors on canvas');
  await conflictCommit('update_path', async () => { await begin(); await move(100, 90); }, () => page.mouse.up());
  const anchorRequest = requests.filter(request => request.command === 'update_path').at(-1); assert.equal(anchorRequest.args.layerId, pathId);
  await choose('Crop (C)');
  await conflictCommit('crop_document', async () => { await begin(30, 30); await move(260, 200); await page.mouse.up(); }, () => choose('Apply crop'));
  await expect(page.getByRole('button', { name: 'Apply crop', exact: true })).toHaveCount(0);
  checkpoint('multi-click path retains its first revision, anchor drags retain target identity, and deferred crop keeps the original revision');

  await selectLayer(paintId); await choose('Brush (B)');
  let before = await current(), beforeOther = await current(other.id), count = requests.filter(item => item.command === 'paint_stroke').length;
  await begin(); await move(140, 130);
  // Keyboard-style select change while the pointer is captured must discard A's gesture.
  await page.getByLabel('Open document').selectOption(other.id); await settled(); await page.mouse.up();
  assert.deepEqual(await current(), before); assert.deepEqual(await current(other.id), beforeOther); assert.equal(requests.filter(item => item.command === 'paint_stroke').length, count);
  await page.getByLabel('Open document').selectOption(documentId); await settled(); await selectLayer(pathId); await choose('Edit anchors on canvas');
  before = await current(); count = requests.filter(item => item.command === 'update_path').length;
  await begin(); await move(120, 110);
  const paintName = before.layers.find(item => item.id === paintId).name;
  await page.locator('.layer-row').filter({ has: page.getByText(paintName, { exact: true }) }).focus(); await page.keyboard.press('Enter'); await page.mouse.up();
  assert.deepEqual(await current(), before); assert.equal(requests.filter(item => item.command === 'update_path').length, count);
  await choose('Rectangle selection (M)'); before = await current(); await begin(); await move(150, 120); await page.keyboard.press('v'); await page.mouse.up(); assert.deepEqual(await current(), before);
  checkpoint('document switches, selected-target switches and tool changes discard in-progress gestures without editing either graph');

  for (const button of ['Rectangle selection (M)', 'Ellipse selection', 'Brush (B)', 'Vector shape (U)', 'Pen (P)', 'Crop (C)']) {
    await choose(button); before = await current(); await begin(); await move(170, 140);
    await page.locator('.artboard').dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' }); await page.mouse.up();
    assert.deepEqual(await current(), before); await expect(page.locator('.crop-selection')).toHaveCount(0);
  }
  for (const [button, command] of [['Brush (B)', 'paint_stroke'], ['Vector shape (U)', 'add_shape']]) {
    await choose(button); const initialRevision = (await current()).revision; await begin(); await move(170, 140);
    for (const event of ['pointerdown', 'pointermove', 'pointercancel', 'pointerup']) await page.locator('.artboard').dispatchEvent(event, { pointerId: 99, pointerType: 'touch', button: 0, clientX: 9999, clientY: 9999 });
    assert.equal((await current()).revision, initialRevision, 'Foreign pointer cannot end or replace the active gesture');
    await page.mouse.up(); await expect.poll(async () => (await current()).revision).toBeGreaterThan(initialRevision); await settled();
    const sent = requests.filter(item => item.command === command).at(-1);
    if (command === 'paint_stroke') assert.ok(sent.args.points.every(point => point.x >= 80 && point.x <= 170 && point.y >= 60 && point.y <= 140));
    else { assert.equal(sent.args.x, 80); assert.equal(sent.args.y, 60); assert.equal(sent.args.width, 90); assert.equal(sent.args.height, 80); }
    const undoRevision = (await current()).revision; await choose('Undo (⌘Z)'); await expect.poll(async () => (await current()).revision).toBeGreaterThan(undoRevision); await settled();
    await selectLayer(paintId);
  }
  await choose('Rectangle selection (M)'); const revision = (await current()).revision; await begin(40, 40); await move(190, 150); await page.locator('.artboard').dispatchEvent('pointerdown', { pointerId: 99, pointerType: 'touch', button: 0, clientX: 0, clientY: 0 }); await page.locator('.artboard').dispatchEvent('pointermove', { pointerId: 99, pointerType: 'touch', clientX: 9999, clientY: 9999 }); await page.locator('.artboard').dispatchEvent('pointercancel', { pointerId: 99, pointerType: 'touch' }); await page.locator('.artboard').dispatchEvent('pointerup', { pointerId: 99, pointerType: 'touch' }); assert.equal((await current()).revision, revision, 'An unrelated pointer must not commit the captured gesture'); await page.mouse.up();
  await expect.poll(async () => (await current()).revision).toBeGreaterThan(revision); await settled(); assert.ok((await current()).selection);
  assert.equal((await current()).selection.width, 150);
  assert.equal(keyReads, 0); assert.equal(providerCalls, 0); assert.deepEqual(errors, []);
  checkpoint('pointer cancellation clears every gesture family and a fresh gesture commits normally after conflict recovery');
  await fs.writeFile(path.join(artifacts, 'gesture-browser-report.json'), JSON.stringify({ passed: checks, conflicts: conflicts.length, keyReads, providerCalls, browserErrors: errors }, null, 2));
  console.log(`Gesture browser checks passed: ${checks.length} workflows, ${conflicts.length} deliberate conflicts.`);
} catch (error) { await page.mouse.up().catch(() => {}); await page.screenshot({ path: path.join(artifacts, 'gesture-failure.png'), animations: 'disabled' }).catch(() => {}); console.error('Alerts:', await page.getByRole('alert').allTextContents().catch(() => [])); throw error; }
finally { await browser.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
