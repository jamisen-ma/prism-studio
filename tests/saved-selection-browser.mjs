import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createCompanion } from '../server/index.mjs';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-selection-library-browser-'));
const artifacts = path.resolve('test-results'); await fs.mkdir(artifacts, { recursive: true });
let keyReads = 0, providerCalls = 0;
const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => { keyReads++; return null; }, imageProvider: async () => { providerCalls++; throw Error('Selection editing never generates images.'); } });
const width = 160, height = 120;
const initial = (await companion.native.execute('create_document', { name: 'Reusable selection fixture', width, height, background: '#315f8c' })).document;
const url = `http://127.0.0.1:${await companion.listen()}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(12000);
const errors = [], checkpoints = [], mutations = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/command')) mutations.push(request.postDataJSON()); });
await page.route('https://**', route => route.abort());
const current = async () => (await companion.native.execute('get_document', { documentId: initial.id })).document;
const pixels = async () => { const preview = await companion.native.execute('get_preview', { documentId: initial.id, maxWidth: width }); return sharp(Buffer.from(preview.data, 'base64')).ensureAlpha().raw().toBuffer(); };
const settled = async () => { await expect(page.locator('.save-status .spin')).toHaveCount(0); await expect(page.getByRole('alert')).toHaveCount(0); };
async function mutate(action, predicate = () => true) { await settled(); const before = await current(); await action(); await expect.poll(async () => { const document = await current(); return document.revision > before.revision && predicate(document); }).toBe(true); await settled(); return current(); }
const tab = name => page.locator('.inspector-tabs').getByRole('button', { name, exact: true }).click();
const undo = () => mutate(() => page.getByRole('button', { name: 'Undo (⌘Z)', exact: true }).click());
async function rectangle(x1, y1, x2, y2) {
  await page.getByRole('button', { name: 'Rectangle selection (M)', exact: true }).click();
  const box = await page.locator('.artboard').boundingBox(); assert.ok(box);
  return mutate(async () => { await page.mouse.move(box.x + x1 / width * box.width, box.y + y1 / height * box.height); await page.mouse.down(); await page.mouse.move(box.x + x2 / width * box.width, box.y + y2 / height * box.height, { steps: 10 }); await page.mouse.up(); }, document => Boolean(document.selection));
}
function checkpoint(message) { checkpoints.push(message); console.log(`Verified: ${message}`); }
try {
  await page.goto(url, { waitUntil: 'networkidle' }); await expect(page.locator('.artboard img')).toBeVisible(); await settled();
  await tab('Select'); await expect(page.getByRole('button', { name: 'Save current selection', exact: true })).toBeDisabled();
  const selected = await rectangle(40, 30, 120, 90);
  await tab('Layers'); await page.getByRole('button', { name: 'Saved selections', exact: true }).click();
  await page.getByLabel('New saved selection name', { exact: true }).fill('Central subject');
  const saved = await mutate(() => page.getByRole('button', { name: 'Save current selection', exact: true }).click(), document => document.savedSelections?.length === 1);
  const selectionId = saved.savedSelections[0].id;
  assert.equal(saved.savedSelections[0].name, 'Central subject'); assert.deepEqual(saved.savedSelections[0].mask, selected.selection);
  await page.getByLabel('Selection feather', { exact: true }).fill('5');
  const refined = await mutate(() => page.getByRole('button', { name: 'Apply to selection', exact: true }).click(), document => document.selection.feather === 5);
  assert.deepEqual(refined.savedSelections[0].mask, saved.savedSelections[0].mask);
  const updated = await mutate(() => page.getByRole('button', { name: 'Update from active selection', exact: true }).click(), document => document.savedSelections[0].mask.feather === 5);
  assert.equal(updated.savedSelections.length, 1); assert.equal(updated.savedSelections[0].id, selectionId);
  await undo(); assert.deepEqual((await current()).savedSelections[0].mask, saved.savedSelections[0].mask);
  await undo(); assert.deepEqual((await current()).selection, selected.selection);
  await page.getByLabel('Saved selection name', { exact: true }).fill('Main subject');
  await mutate(() => page.getByRole('button', { name: 'Rename', exact: true }).click(), document => document.savedSelections[0].name === 'Main subject');
  await page.getByLabel('Saved selection name', { exact: true }).fill('   '); await expect(page.getByRole('button', { name: 'Rename', exact: true })).toBeDisabled();
  await page.getByLabel('Saved selection name', { exact: true }).fill('Main subject');
  checkpoint('selection save, editable independent copy, same-ID update, rename validation and undo');

  await mutate(() => page.getByRole('button', { name: 'Deselect', exact: true }).click(), document => !document.selection);
  await page.getByLabel('Saved selection combination').selectOption('subtract'); await expect(page.locator('.saved-selection-properties').getByRole('button', { name: 'Load selection', exact: true })).toBeDisabled();
  await page.getByLabel('Saved selection combination').selectOption('intersect'); await expect(page.locator('.saved-selection-properties').getByRole('button', { name: 'Load selection', exact: true })).toBeDisabled();
  await page.getByLabel('Saved selection combination').selectOption('replace');
  const loaded = await mutate(() => page.locator('.saved-selection-properties').getByRole('button', { name: 'Load selection', exact: true }).click(), document => Boolean(document.selection));
  assert.deepEqual(loaded.selection, saved.savedSelections[0].mask); await expect(page.locator('.canvas-selection')).toHaveCount(1);
  await rectangle(0, 0, 80, 120);
  for (const mode of ['add', 'subtract', 'intersect']) {
    await tab('Select'); await page.getByLabel('Saved selection combination').selectOption(mode);
    await mutate(() => page.locator('.saved-selection-properties').getByRole('button', { name: 'Load selection', exact: true }).click(), document => document.selection?.shape === 'bitmap');
    await tab('Layers'); await mutate(() => page.getByRole('button', { name: 'Mask from selection', exact: true }).click(), document => Boolean(document.layers[0].mask));
    const rendered = await pixels();
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const a = x >= 40 && x < 120 && y >= 30 && y < 90, b = x < 80;
      const visible = mode === 'add' ? a || b : mode === 'subtract' ? b && !a : a && b;
      const offset = (y * width + x) * 4;
      assert.equal(rendered[offset + 3], visible ? 255 : 0, `${mode} alpha ${x},${y}`);
      if (visible) assert.deepEqual([...rendered.subarray(offset, offset + 3)], [49, 95, 140]);
    }
    await undo(); await undo();
  }
  checkpoint('restore and missing-active guards; add/subtract/intersect produce exact real layer-mask pixels');

  await tab('Select'); const beforeDelete = await current();
  await mutate(() => page.getByRole('button', { name: 'Delete saved selection', exact: true }).click(), document => !document.savedSelections.length);
  assert.deepEqual((await current()).selection, beforeDelete.selection); await undo();
  assert.deepEqual((await current()).savedSelections, beforeDelete.savedSelections);
  await page.reload({ waitUntil: 'networkidle' }); await expect(page.locator('.artboard img')).toBeVisible(); await tab('Select');
  await expect(page.getByRole('option', { name: /Main subject/ })).toBeVisible();
  assert.deepEqual((await current()).savedSelections, beforeDelete.savedSelections);
  await page.setViewportSize({ width: 900, height: 1000 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('.inspector').evaluate(element => element.scrollWidth <= element.clientWidth), true);
  await page.screenshot({ path: path.join(artifacts, 'saved-selection-library.png'), animations: 'disabled' });
  for (const request of mutations.filter(item => ['save_selection', 'load_selection', 'rename_selection', 'delete_selection'].includes(item.command))) { assert.equal(request.backend, 'native'); assert.equal(request.args.documentId, initial.id); assert.ok(Number.isInteger(request.args.expectedRevision)); }
  assert.equal(keyReads, 0); assert.equal(providerCalls, 0); assert.deepEqual(errors, []);
  checkpoint('delete/undo, saved reopen, native revision guards, compact layout and no browser errors or AI calls');
  await fs.writeFile(path.join(artifacts, 'saved-selection-browser-report.json'), JSON.stringify({ passed: checkpoints, keyReads, providerCalls, browserErrors: errors }, null, 2));
  console.log(`Saved-selection browser checks passed (${checkpoints.length} workflows).`);
} catch (error) { await page.screenshot({ path: path.join(artifacts, 'saved-selection-browser-failure.png'), animations: 'disabled' }).catch(() => {}); console.error('Visible alerts:', await page.getByRole('alert').allTextContents().catch(() => [])); throw error; }
finally { await browser.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
