import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createCompanion } from '../server/index.mjs';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-mask-density-browser-'));
const artifacts = path.resolve('test-results'); await fs.mkdir(artifacts, { recursive: true });
const width = 80, height = 60, raw = Buffer.alloc(width * height * 4), sourceAlpha = Buffer.alloc(width * height);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { raw.set([40 + x, 30 + y * 2, 140, 255], (y * width + x) * 4); sourceAlpha[y * width + x] = x < 8 || x > 72 || y < 8 || y > 52 ? 0 : [1, 128, 255][(x + y) % 3]; }
const source = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
let keyReads = 0, providerCalls = 0;
const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => { keyReads++; return null; }, imageProvider: async () => { providerCalls++; throw Error('Mask density must stay local.'); }, segmentSubject: async () => ({ alpha: sourceAlpha, width, height, model: 'synthetic-mask-density-fixture' }) });
const imported = async name => (await companion.native.execute('import_image', { name, data: source.toString('base64'), mimeType: 'image/png' })).document;
const seed = async (id, command, args) => (await companion.native.execute(command, { documentId: id, ...args })).document;
const selection = { shape: 'rectangle', x: 0, y: 0, width: width / 2, height };
const contentDoc = await imported('Protected subject mask density');
let doc = await seed(contentDoc.id, 'extract_subject', { layerId: contentDoc.layers[0].id }); const cutoutId = doc.layers.at(-1).id;
await seed(contentDoc.id, 'select_region', selection); await seed(contentDoc.id, 'save_selection', { name: 'Independent raw selection' }); await seed(contentDoc.id, 'mask_from_selection', { layerId: cutoutId });
const groupDoc = await imported('Group mask density'); doc = await seed(groupDoc.id, 'create_group', { name: 'Masked group' }); const groupId = doc.layers.at(-1).id; await seed(groupDoc.id, 'move_layer', { layerId: groupDoc.layers[0].id, parentId: groupId }); await seed(groupDoc.id, 'set_layer_mask', { layerId: groupId, mask: selection });
const adjustmentDoc = await imported('Adjustment mask density'); doc = await seed(adjustmentDoc.id, 'select_region', selection); doc = await seed(adjustmentDoc.id, 'add_adjustment', { kind: 'invert', value: 100 }); const adjustmentId = doc.layers.at(-1).id;
let documentId = contentDoc.id;
const current = async () => (await companion.native.execute('get_document', { documentId })).document;
const pixels = async () => sharp(Buffer.from((await companion.native.execute('get_preview', { documentId, maxWidth: width })).data, 'base64')).ensureAlpha().raw().toBuffer();
const view = async mode => (await companion.native.execute('get_layer_preview', { documentId: contentDoc.id, layerId: cutoutId, view: mode, maxWidth: width })).data;
const sourceView = await view('source'), alphaView = await view('mask'), initial = await current(), originalMask = initial.layers.find(layer => layer.id === cutoutId).mask;
const assets = new Map(); for (const layer of initial.layers) for (const key of ['asset', 'sourceAsset', 'alphaAsset']) if (layer[key]) assets.set(layer[key], await fs.readFile(path.join(companion.native.assetsDir, layer[key])));
const browser = await chromium.launch({ headless: true, channel: 'chrome' }); const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(12000);
const errors = [], requests = [], checkpoints = [];
page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/command')) requests.push(request.postDataJSON()); }); await page.route('https://**', route => route.abort());
const panel = page.getByRole('group', { name: 'Additional layer mask density', exact: true });
const percent = () => panel.getByLabel('Layer mask density percent', { exact: true });
const apply = () => panel.getByRole('button', { name: 'Apply mask density', exact: true });
const settled = async () => { await expect(page.locator('.save-status .spin')).toHaveCount(0); await expect(page.getByRole('alert')).toHaveCount(0); };
const select = id => page.locator(`.layer-row[data-layer-id="${id}"]`).click();
async function open(id, layerId) { documentId = id; await page.getByLabel('Open document').selectOption(id); await settled(); await page.locator('.inspector-tabs').getByRole('button', { name: 'Layers', exact: true }).click(); await select(layerId); }
async function mutate(action) { await settled(); const before = await current(); await action(); await expect.poll(async () => (await current()).revision).toBeGreaterThan(before.revision); await settled(); const after = await current(); assert.equal(after.revision, before.revision + 1); return after; }
const undo = () => mutate(() => page.getByRole('button', { name: 'Undo (⌘Z)', exact: true }).click());
async function density(value) { await percent().fill(String(value)); return mutate(() => apply().click()); }
function maskedPixels(alpha, amount, invert = false) { const expected = Buffer.from(raw); for (let i = 0; i < alpha.length; i++) { const inside = i % width < width / 2, coverage = invert ? !inside : inside; expected[i * 4 + 3] = Math.round(alpha[i] * (coverage ? 1 : 1 - amount)); } return expected; }
function assertVisible(actual, expected) { for (let i = 0; i < actual.length; i += 4) { assert.equal(actual[i + 3], expected[i + 3], `alpha ${i / 4}`); if (expected[i + 3]) assert.deepEqual(actual.subarray(i, i + 3), expected.subarray(i, i + 3), `RGB ${i / 4}`); } }
function checkpoint(message) { checkpoints.push(message); console.log(`Verified: ${message}`); }
try {
  await page.goto(`http://127.0.0.1:${await companion.listen()}`, { waitUntil: 'networkidle' }); await open(contentDoc.id, cutoutId); await expect(percent()).toHaveValue('100'); await expect(apply()).toBeDisabled(); await expect(panel).toContainText('Source cutout alpha and layer opacity stay separate');
  const beforeInvalid = await current(), beforeRequests = requests.length;
  for (const value of ['', '-1', '101']) { await percent().fill(value); await expect(apply()).toBeDisabled(); }
  assert.equal((await current()).revision, beforeInvalid.revision); assert.equal(requests.length, beforeRequests);
  let state = await density(50), cutout = state.layers.find(layer => layer.id === cutoutId); assert.equal(cutout.maskDensity, .5); assert.equal(cutout.protected, true); assert.deepEqual(cutout.mask, originalMask); assert.deepEqual(state.selection, initial.selection); assert.deepEqual(state.savedSelections, initial.savedSelections); assertVisible(await pixels(), maskedPixels(sourceAlpha, .5));
  await percent().fill('75'); await select(contentDoc.layers[0].id); await expect(panel).toHaveCount(0); await select(cutoutId); await expect(percent()).toHaveValue('50');
  await percent().fill('75'); await undo(); await expect(percent()).toHaveValue('100'); assertVisible(await pixels(), maskedPixels(sourceAlpha, 1));
  await density(0); assertVisible(await pixels(), maskedPixels(sourceAlpha, 0)); assert.equal(await view('source'), sourceView); assert.equal(await view('mask'), alphaView);
  await density(37.5); assert.equal((await current()).layers.find(layer => layer.id === cutoutId).maskDensity, .375); assertVisible(await pixels(), maskedPixels(sourceAlpha, .375));
  checkpoint('density applies once to protected subject alpha1/128/255, zero disables only the extra mask, fractional percent works, invalid/empty drafts dispatch nothing, and layer switching plus undo reset unapplied drafts');

  await mutate(() => page.getByRole('button', { name: 'Invert mask', exact: true }).click()); state = await current(); assert.equal(state.layers.find(layer => layer.id === cutoutId).maskDensity, .375); assertVisible(await pixels(), maskedPixels(sourceAlpha, .375, true)); await undo();
  await density(0); const edges = page.getByRole('region', { name: 'Layer mask edges', exact: true }); await edges.getByLabel('Layer mask edge operation').selectOption('expand'); await edges.getByLabel('Layer mask edge radius').fill('2'); await mutate(() => edges.getByRole('button', { name: 'Apply layer mask edges', exact: true }).click()); state = await current(); assert.equal(state.layers.find(layer => layer.id === cutoutId).maskDensity, 0); assert.notDeepEqual(state.layers.find(layer => layer.id === cutoutId).mask, originalMask); assertVisible(await pixels(), maskedPixels(sourceAlpha, 0)); await undo();
  await mutate(() => page.getByRole('button', { name: 'Replace mask from selection', exact: true }).click()); state = await current(); assert.equal(state.layers.find(layer => layer.id === cutoutId).maskDensity, undefined); await expect(percent()).toHaveValue('100'); assert.deepEqual(state.layers.find(layer => layer.id === cutoutId).mask, originalMask); await undo(); await expect(percent()).toHaveValue('0');
  await mutate(() => page.locator('.layer-mask-properties').getByRole('button', { name: 'Remove', exact: true }).click()); state = await current(); assert.equal(state.layers.find(layer => layer.id === cutoutId).maskDensity, undefined); assert.equal(state.layers.find(layer => layer.id === cutoutId).mask, null); await expect(panel).toHaveCount(0); await undo(); await expect(percent()).toHaveValue('0');
  await density(50); const contentFinal = await current(); await page.reload({ waitUntil: 'networkidle' }); await open(contentDoc.id, cutoutId); await expect(percent()).toHaveValue('50'); assert.deepEqual((await current()).layers, contentFinal.layers); assert.deepEqual((await current()).savedSelections, initial.savedSelections); assert.equal(await view('mask'), alphaView);
  checkpoint('invert and raw-mask morphology retain density, replacement resets it, removal clears it, undo/reopen restore exact metadata and pixels, while saved selections and raw source-alpha views remain independent');

  await open(groupDoc.id, groupId); await expect(percent()).toHaveValue('100'); state = await density(25); assert.equal(state.layers.find(layer => layer.id === groupId).maskDensity, .25); assertVisible(await pixels(), maskedPixels(Buffer.alloc(width * height, 255), .25)); await undo(); await expect(percent()).toHaveValue('100');
  await open(adjustmentDoc.id, adjustmentId); state = await density(50); const adjusted = await pixels(); for (let i = 0; i < adjusted.length; i += 4) { assert.equal(adjusted[i + 3], 255); for (let c = 0; c < 3; c++) assert.equal(adjusted[i + c], (i / 4) % width < width / 2 ? 255 - raw[i + c] : 128); } assert.equal(state.layers.find(layer => layer.id === adjustmentId).maskDensity, .5);
  await percent().fill('10'); await open(contentDoc.id, cutoutId); await expect(percent()).toHaveValue('50'); await page.setViewportSize({ width: 900, height: 1100 }); for (let i = 0; i < 25; i++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click(); await panel.scrollIntoViewIfNeeded(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.equal(await page.locator('.inspector').evaluate(element => element.scrollWidth <= element.clientWidth), true); await page.screenshot({ path: path.join(artifacts, 'layer-mask-density.png'), animations: 'disabled' });
  for (const [hash, bytes] of assets) assert.deepEqual(await fs.readFile(path.join(companion.native.assetsDir, hash)), bytes); assert.equal(await view('source'), sourceView); assert.equal(await view('mask'), alphaView);
  for (const request of requests.filter(request => request.command === 'modify_layer_mask' && request.args.density !== undefined)) { assert.ok(Number.isInteger(request.args.expectedRevision)); assert.ok(request.args.density >= 0 && request.args.density <= 1); assert.equal(request.args.mask, undefined); }
  assert.deepEqual(errors, []); assert.equal(keyReads, 0); assert.equal(providerCalls, 0);
  checkpoint('content, group and adjustment masks share truthful density controls; independent group-alpha and adjustment-RGB references match; source assets remain byte exact; compact layout and revision-guarded writes pass without provider calls');
  await fs.writeFile(path.join(artifacts, 'mask-density-browser-report.json'), JSON.stringify({ passed: checkpoints, keyReads, providerCalls, browserErrors: errors }, null, 2)); console.log(`Mask density browser checks passed: ${checkpoints.length} workflows.`);
} catch (error) { await page.screenshot({ path: path.join(artifacts, 'mask-density-browser-failure.png'), animations: 'disabled' }).catch(() => {}); console.error('Browser errors:', errors); console.error('Visible alerts:', await page.getByRole('alert').allTextContents()); throw error; }
finally { await browser.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
