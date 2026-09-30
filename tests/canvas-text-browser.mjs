// On-canvas Type tool: click for point text, drag for box text, click existing type to edit it in place.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createCompanion } from '../server/index.mjs';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-canvas-text-browser-'));
const artifacts = path.resolve('test-results'); await fs.mkdir(artifacts, { recursive: true });
const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => null, imageProvider: async () => { throw Error('Typing must stay local.'); } });
const native = companion.native, getDoc = async id => (await native.execute('get_document', { documentId: id })).document;
// A second document whose text layer was moved with the Move tool (translation transform).
let moved = (await native.execute('create_document', { name: 'Moved type', width: 400, height: 300, background: '#223344' })).document;
moved = (await native.execute('add_text', { documentId: moved.id, text: 'Moved title', x: 20, y: 20, fontSize: 36, color: '#ffeeaa' })).document;
const movedTextId = moved.layers.at(-1).id;
moved = (await native.execute('transform_layer', { documentId: moved.id, layerId: movedTextId, x: 120, y: 150, expectedRevision: moved.revision })).document;
const base = (await native.execute('create_document', { name: 'Canvas type fixture', width: 600, height: 400, background: '#336699' })).document;
const documentId = base.id;

const browser = await chromium.launch({ headless: true, channel: 'chrome' }), page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(12000);
const errors = [], requests = [];
page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/command')) requests.push(request.postDataJSON()); }); await page.route('https://**', route => route.abort());
const artboard = page.locator('.artboard'), editor = page.getByLabel('Canvas text', { exact: true }), overlay = page.locator('.canvas-text');
const settled = async () => { await expect(page.locator('.save-status .spin')).toHaveCount(0); await expect(page.getByRole('alert')).toHaveCount(0); };
const current = async () => getDoc(await page.getByLabel('Open document').inputValue());
async function mutate(action) { await settled(); const before = await current(); await action(); await expect.poll(async () => (await getDoc(before.id)).revision).toBeGreaterThan(before.revision); await settled(); return current(); }
async function screen(x, y) { const box = await artboard.boundingBox(), doc = await current(); return { x: box.x + x * box.width / doc.width, y: box.y + y * box.height / doc.height, scale: box.width / doc.width }; }
async function clickAt(x, y) { const p = await screen(x, y); await page.mouse.click(p.x, p.y); }
async function dragAt(x1, y1, x2, y2) { const a = await screen(x1, y1), b = await screen(x2, y2); await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 }); await page.mouse.move(b.x, b.y, { steps: 4 }); await page.mouse.up(); }
const count = name => requests.filter(request => request.command === name).length;
async function inkIn(region) { const doc = await current(), preview = await native.execute('get_preview', { documentId: doc.id, maxWidth: doc.width }); const { data, info } = await sharp(Buffer.from(preview.data, 'base64')).raw().toBuffer({ resolveWithObject: true }); let ink = 0; for (let y = region.y; y < region.y + region.height; y++) for (let x = region.x; x < region.x + region.width; x++) { const i = (y * info.width + x) * info.channels; if (Math.abs(data[i] - 0x33) + Math.abs(data[i + 1] - 0x66) + Math.abs(data[i + 2] - 0x99) > 90) ink++; } return ink; }
const checkpoint = message => console.log(`Verified: ${message}`);

try {
  await page.goto(`http://127.0.0.1:${await companion.listen()}`, { waitUntil: 'networkidle' });
  await page.getByLabel('Open document').selectOption(documentId); await settled();
  await page.getByRole('button', { name: 'Add text (T)' }).click();

  // Point text: click, type two lines, commit with Cmd/Ctrl+Enter.
  await clickAt(50, 60); await expect(editor).toBeFocused(); await page.keyboard.type('Hello'); await page.keyboard.press('Enter'); await page.keyboard.type('World');
  let state = await mutate(() => page.keyboard.press('ControlOrMeta+Enter')); await expect(overlay).toHaveCount(0);
  const hello = state.layers.at(-1); assert.equal(hello.type, 'text'); assert.equal(hello.text, 'Hello\nWorld'); assert.equal(hello.x, 50); assert.equal(hello.y, 60); assert.equal(hello.align, 'left');
  assert.ok(await inkIn({ x: 50, y: 60, width: 150, height: 150 }) > 200, 'point text renders at the clicked position');
  checkpoint('click creates multi-line point text at the clicked source position');

  // Box text: drag a frame, choose center/bold/size/color on the floating bar, type long words, click outside to commit.
  await dragAt(300, 100, 560, 320); await expect(overlay).toHaveClass(/box/);
  await page.getByLabel('Canvas text size').fill('40'); await page.getByRole('button', { name: 'Bold' }).click(); await page.getByRole('button', { name: 'Align center' }).click(); await page.getByLabel('Canvas text color').fill('#ffcc00');
  await editor.click(); await page.keyboard.type('Supercalifragilisticexpialidocious wraps inside the box');
  state = await mutate(() => clickAt(100, 360)); await expect(overlay).toHaveCount(0);
  const boxed = state.layers.at(-1); assert.equal(boxed.align, 'center'); assert.equal(boxed.x, 430); assert.equal(boxed.fontWeight, 'bold'); assert.equal(boxed.fontSize, 40); assert.equal(boxed.color, '#ffcc00');
  assert.ok(boxed.text.split('\n').length >= 3, `long words wrap inside the box: ${JSON.stringify(boxed.text)}`); assert.equal(boxed.text.replace(/\s/g, ''), 'Supercalifragilisticexpialidociouswrapsinsidethebox');
  assert.ok(await inkIn({ x: 300, y: 100, width: 260, height: 220 }) > 300, 'box text renders inside its frame');
  assert.equal(await inkIn({ x: 570, y: 100, width: 30, height: 200 }), 0, 'box text does not spill past its frame');
  checkpoint('drag creates wrapped, centered, bold box text with bar styling; clicking outside commits it');

  // Click existing type: edits that layer in place with its own typography.
  const layersBefore = state.layers.length, addsBefore = count('add_text');
  await clickAt(70, 80); await expect(editor).toBeFocused(); await expect(editor).toHaveValue('Hello\nWorld'); await expect(editor).toHaveAttribute('data-layer-id', hello.id); await expect(overlay).toHaveClass(/editing/);
  await expect(page.getByLabel('Canvas text size')).toHaveValue(String(hello.fontSize));
  await page.screenshot({ path: path.join(artifacts, 'canvas-text-edit.png') });
  await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type('Edited');
  await page.getByRole('button', { name: 'Italic' }).click();
  state = await mutate(() => page.getByRole('button', { name: 'Commit text' }).click()); await expect(overlay).toHaveCount(0);
  let edited = state.layers.find(layer => layer.id === hello.id); assert.equal(edited.text, 'Edited'); assert.equal(edited.fontStyle, 'italic'); assert.equal(edited.x, 50); assert.equal(edited.y, 60);
  assert.equal(state.layers.length, layersBefore); assert.equal(count('add_text'), addsBefore); assert.equal(requests.filter(request => request.command === 'update_text').at(-1).args.layerId, hello.id);
  checkpoint('clicking existing type opens it in place (selected, prefilled, own styles) and commits via update_text without adding a layer');

  // Escape cancels an in-place edit; committing unchanged text sends nothing.
  let revision = (await current()).revision, updates = count('update_text');
  await clickAt(60, 80); await expect(editor).toHaveValue('Edited'); await page.keyboard.type('zzz'); await page.keyboard.press('Escape'); await expect(overlay).toHaveCount(0);
  await clickAt(60, 80); await expect(editor).toHaveValue('Edited'); await page.keyboard.press('ControlOrMeta+Enter'); await expect(overlay).toHaveCount(0);
  await settled(); assert.equal((await current()).revision, revision); assert.equal(count('update_text'), updates);
  checkpoint('Escape discards in-place edits and unchanged commits are no-ops');

  // Box text layers (center aligned) are editable in place too, and undo restores the previous text.
  const boxBounds = { x: 430, y: 130 };
  await clickAt(boxBounds.x, boxBounds.y); await expect(editor).toHaveAttribute('data-layer-id', boxed.id); await expect(page.getByRole('button', { name: 'Align center' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type('Short');
  state = await mutate(() => page.keyboard.press('ControlOrMeta+Enter')); assert.equal(state.layers.find(layer => layer.id === boxed.id).text, 'Short'); assert.equal(state.layers.find(layer => layer.id === boxed.id).align, 'center');
  state = await mutate(() => page.getByRole('button', { name: 'Undo (⌘Z)', exact: true }).click()); assert.match(state.layers.find(layer => layer.id === boxed.id).text, /Supercal/);
  checkpoint('centered box text edits in place and undo restores it');

  // Zoomed in: the in-place editor sits on the layer's anchor at the current zoom.
  await page.getByRole('button', { name: 'Zoom in' }).click(); await page.getByRole('button', { name: 'Zoom in' }).click(); await settled();
  await clickAt(60, 75); await expect(editor).toHaveAttribute('data-layer-id', hello.id);
  { const anchor = await screen(50, 60), frame = await overlay.boundingBox(); assert.ok(Math.abs(frame.x - anchor.x) < 2 && Math.abs(frame.y - anchor.y) < 2, `editor frame ${frame.x},${frame.y} at anchor ${anchor.x},${anchor.y}`); const font = parseFloat(await editor.evaluate(element => getComputedStyle(element).fontSize)); assert.ok(Math.abs(font - edited.fontSize * anchor.scale) < 0.5, 'editor font scales with zoom'); }
  await page.screenshot({ path: path.join(artifacts, 'canvas-text-zoomed-edit.png') });
  await page.keyboard.press('Escape'); await expect(overlay).toHaveCount(0);
  checkpoint('in-place editor tracks zoom');

  // Clicking empty canvas still starts new text; the panel editor still works.
  await clickAt(200, 350); await expect(editor).toHaveValue(''); await expect(editor).not.toHaveAttribute('data-layer-id', /./); await page.keyboard.press('Escape');
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Layers', exact: true }).click(); await page.locator(`.layer-row[data-layer-id="${hello.id}"]`).click();
  const panel = page.locator('.editable-text'); await panel.getByLabel('Edit text content').fill('From panel');
  state = await mutate(() => panel.getByRole('button', { name: 'Update text layer', exact: true }).click()); assert.equal(state.layers.find(layer => layer.id === hello.id).text, 'From panel');
  await clickAt(60, 75); await expect(editor).toHaveValue('From panel'); await page.keyboard.press('Escape');
  checkpoint('empty canvas click creates new text and panel editing keeps working alongside in-place editing');

  // Moved text layers are hit and edited at their moved position.
  await page.getByLabel('Open document').selectOption(moved.id); await settled(); await page.getByRole('button', { name: 'Add text (T)' }).click();
  await page.getByRole('button', { name: 'Fit' }).click().catch(() => {});
  await clickAt(60, 55); await expect(editor).toHaveValue(''); await page.keyboard.press('Escape');
  await clickAt(180, 190); await expect(editor).toHaveValue('Moved title'); await page.keyboard.press('End'); await page.keyboard.type('!');
  state = await mutate(() => page.keyboard.press('ControlOrMeta+Enter')); const movedLayer = state.layers.find(layer => layer.id === movedTextId); assert.equal(movedLayer.text, 'Moved title!'); assert.equal(movedLayer.x, 20); assert.equal(movedLayer.transforms.length, 1);
  checkpoint('moved text layers are edited at their rendered position, keeping source coordinates and transforms');

  assert.deepEqual(errors, []);
  console.log('Canvas text browser flows passed.');
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, 'canvas-text-failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser.close(); await companion.close?.(); await fs.rm(dataDir, { recursive: true, force: true });
}
