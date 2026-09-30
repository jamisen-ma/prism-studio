import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createCompanion } from '../server/index.mjs';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-layer-selection-browser-'));
const artifacts = path.resolve('test-results'); await fs.mkdir(artifacts, { recursive: true });
const width = 48, height = 36, raw = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set([30 + x * 3, 20 + y * 4, 170, x < 3 || y < 3 || x > 40 || y > 28 ? 0 : [0, 1, 128, 255][(x + y) % 4]], (y * width + x) * 4);
const sourcePng = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
let keyReads = 0, providerCalls = 0, segmentCalls = 0;
const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => { keyReads++; return null; }, imageProvider: async () => { providerCalls++; throw Error('Layer selection must remain local.'); }, segmentSubject: async () => { segmentCalls++; throw Error('Layer selection must not segment.'); } });
const native = companion.native;
const seed = async (id, command, args = {}) => (await native.execute(command, { documentId: id, ...args })).document;
const doc = async id => (await native.execute('get_document', { documentId: id })).document;
let content = (await native.execute('import_image', { name: 'Working transparency, ignored display settings', data: sourcePng.toString('base64'), mimeType: 'image/png' })).document;
const contentId = content.id, rasterId = content.layers[0].id;
content = await seed(contentId, 'paint_stroke', { layerId: rasterId, tool: 'eraser', points: [{ x: 18, y: 15 }], size: 5, opacity: 1, hardness: 1 });
const workingLayer = content.layers[0], working = await sharp(await fs.readFile(path.join(native.assetsDir, workingLayer.asset))).ensureAlpha().raw().toBuffer(); assert.notEqual(workingLayer.asset, workingLayer.sourceAsset);
await seed(contentId, 'transform_layer', { layerId: rasterId, x: 3, y: 2 });
await seed(contentId, 'set_layer_mask', { layerId: rasterId, mask: { shape: 'rectangle', x: 0, y: 0, width: 1, height: 1 } });
await seed(contentId, 'set_layer_effects', { layerId: rasterId, effects: { shadow: { opacity: 1, blur: 0, x: 10, y: 8 } } });
await seed(contentId, 'add_layer_filter', { layerId: rasterId, kind: 'invert', value: 100 });
await seed(contentId, 'set_layer', { layerId: rasterId, opacity: 0, visible: false });
content = await seed(contentId, 'create_group', { name: 'Hidden masked ancestor' }); const parentId = content.layers.find(layer => layer.type === 'group').id;
await seed(contentId, 'move_layer', { layerId: rasterId, parentId }); await seed(contentId, 'set_layer', { layerId: parentId, opacity: .25, visible: false }); await seed(contentId, 'set_layer_mask', { layerId: parentId, mask: { shape: 'rectangle', x: 0, y: 0, width: 2, height: 2 } });
content = await seed(contentId, 'add_shape', { name: 'Protected vector silhouette', shape: 'rectangle', x: 7, y: 6, width: 13, height: 10, fill: '#c98344', stroke: null, strokeWidth: 0 }); const shapeId = content.layers.find(layer => layer.type === 'shape').id; await seed(contentId, 'set_layer_protection', { layerId: shapeId, protected: true });
const contentBaseline = await doc(contentId), sourceBytes = await fs.readFile(path.join(native.assetsDir, workingLayer.sourceAsset));
const shifted = Buffer.alloc(width * height); for (let y = 2; y < height; y++) for (let x = 3; x < width; x++) shifted[y * width + x] = working[((y - 2) * width + x - 3) * 4 + 3];
const rectangle = Buffer.alloc(width * height); for (let y = 6; y < 16; y++) rectangle.fill(255, y * width + 7, y * width + 20);

let masked = (await native.execute('create_document', { name: 'Additional masks and density', width, height, background: '#526b87' })).document;
const maskId = masked.id, solidId = masked.layers[0].id;
const maskPixels = Buffer.alloc(width * height), runs = [];
for (let y = 0; y < height; y++) { runs.push(y * width + 16, 16, 128, y * width + 32, 16, 255); maskPixels.fill(128, y * width + 16, y * width + 32); maskPixels.fill(255, y * width + 32, (y + 1) * width); }
const ownMask = { shape: 'bitmap', x: 0, y: 0, width, height, runs, invert: true, feather: 0 };
const groupMask = { shape: 'rectangle', x: 6, y: 4, width: 24, height: 16, invert: true, feather: 0 };
const groupRaw = Buffer.alloc(width * height); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (!(x >= 6 && x < 30 && y >= 4 && y < 20)) groupRaw[y * width + x] = 255;
const rawMask = Buffer.from(maskPixels.map(value => 255 - value));
const effective = Buffer.from(rawMask.map(value => Math.round(127.5 + value / 2)));
await seed(maskId, 'set_layer_mask', { layerId: solidId, mask: ownMask }); await seed(maskId, 'modify_layer_mask', { layerId: solidId, density: .5 });
masked = await seed(maskId, 'create_group', { name: 'Group with zero-density own mask' }); const groupId = masked.layers.find(layer => layer.type === 'group').id; await seed(maskId, 'set_layer_mask', { layerId: groupId, mask: groupMask }); await seed(maskId, 'modify_layer_mask', { layerId: groupId, density: 0 });
masked = await seed(maskId, 'add_adjustment', { kind: 'invert', value: 60 }); const adjustmentId = masked.layers.find(layer => layer.type === 'adjustment').id; await seed(maskId, 'set_layer_mask', { layerId: adjustmentId, mask: ownMask }); await seed(maskId, 'modify_layer_mask', { layerId: adjustmentId, density: .5 });
const maskBaseline = await doc(maskId);
let empty = (await native.execute('import_image', { name: 'Explicit empty selection', data: sourcePng.toString('base64'), mimeType: 'image/png' })).document;
const emptyId = empty.id, emptyBaseId = empty.layers[0].id; empty = await seed(emptyId, 'add_paint_layer', { name: 'Transparent source' }); const emptyLayerId = empty.layers.at(-1).id;

const url = `http://127.0.0.1:${await companion.listen()}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' }), page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(12000);
const errors = [], requests = [], checkpoints = []; let expectingConflict = false;
page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error' && !expectingConflict) errors.push(message.text()); });
page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/command')) requests.push(request.postDataJSON()); });
await page.route('https://**', route => route.abort());
const panel = page.getByRole('region', { name: 'Selection from a layer', exact: true });
const activeSummary = page.locator('.saved-selections-panel > .panel-section').first().locator(':scope > .property-hint').first();
const current = async () => doc(await page.getByLabel('Open document').inputValue());
const pixels = async id => sharp(Buffer.from((await native.execute('get_preview', { documentId: id, maxWidth: width })).data, 'base64')).ensureAlpha().raw().toBuffer();
const settled = async () => { await expect(page.locator('.save-status .spin')).toHaveCount(0); await expect(page.getByRole('alert')).toHaveCount(0); };
const tab = name => page.locator('.inspector-tabs').getByRole('button', { name, exact: true }).click();
async function open(id, layerId) { await page.getByLabel('Open document').selectOption(id); await settled(); await tab('Select'); if (layerId) await panel.getByLabel('Selection source layer').selectOption(layerId); await expect(panel).toBeVisible(); }
async function mutate(action) { await settled(); const before = await current(); await action(); await expect.poll(async () => (await doc(before.id)).revision).toBeGreaterThan(before.revision); await settled(); return current(); }
async function load({ source = 'content', maskMode = 'effective', mode = 'replace', invert = false } = {}) { await panel.getByLabel('Layer selection source', { exact: true }).selectOption(source); if (source === 'layer-mask') await panel.getByLabel('Layer selection mask coverage').selectOption(maskMode); await panel.getByLabel('Layer selection combination').selectOption(mode); await panel.getByLabel('Invert layer selection source').setChecked(invert); return mutate(() => panel.getByRole('button', { name: 'Load from layer', exact: true }).click()); }
const undo = () => mutate(() => page.getByRole('button', { name: 'Undo (⌘Z)', exact: true }).click());
function decode(mask) { assert.ok(mask); assert.equal(mask.shape, 'bitmap'); assert.equal(mask.invert, false); const result = Buffer.alloc(width * height); for (let i = 0; i < mask.runs.length; i += 3) result.fill(mask.runs[i + 2], mask.runs[i], mask.runs[i] + mask.runs[i + 1]); return result; }
function combined(a, b, mode) { return Buffer.from(a.map((value, i) => mode === 'add' ? Math.max(value, b[i]) : mode === 'subtract' ? Math.round(value * (1 - b[i] / 255)) : Math.round(value * b[i] / 255))); }
function checkpoint(message) { checkpoints.push(message); console.log(`Verified: ${message}`); }
try {
  await page.goto(url, { waitUntil: 'networkidle' }); await open(contentId, rasterId); await expect(panel).toContainText('Ignores visibility, opacity, layer masks and effects');
  await panel.getByLabel('Layer selection combination').selectOption('subtract'); await expect(panel.getByRole('button', { name: 'Load from layer' })).toBeDisabled(); await expect(panel).toContainText('Create an active selection'); const beforeContent = await pixels(contentId);
  let state = await load({ mode: 'add' }); assert.deepEqual(decode(state.selection), shifted); assert.deepEqual(state.layers, contentBaseline.layers); assert.deepEqual(await pixels(contentId), beforeContent);
  await page.getByLabel('New saved selection name').fill('Working alpha copy'); await mutate(() => page.getByRole('button', { name: 'Save current selection', exact: true }).click()); const saved = structuredClone((await current()).savedSelections);
  await panel.getByLabel('Layer selection source', { exact: true }).selectOption('layer-mask'); await panel.getByLabel('Layer selection mask coverage').selectOption('raw'); await panel.getByLabel('Layer selection combination').selectOption('subtract'); await panel.getByLabel('Invert layer selection source').check(); await panel.getByLabel('Selection source layer').selectOption(shapeId); await expect(panel.getByLabel('Layer selection source', { exact: true })).toHaveValue('content'); await expect(panel.getByLabel('Layer selection combination')).toHaveValue('replace'); await expect(panel.getByLabel('Invert layer selection source')).not.toBeChecked(); await expect(panel.getByLabel('Layer selection source', { exact: true }).locator('option[value="layer-mask"]')).toHaveJSProperty('disabled', true);
  state = await load(); assert.deepEqual(decode(state.selection), rectangle); assert.deepEqual(state.savedSelections, saved); assert.equal(state.layers.find(layer => layer.id === shapeId).protected, true); await undo(); assert.deepEqual(decode((await current()).selection), shifted); assert.deepEqual(await fs.readFile(path.join(native.assetsDir, workingLayer.sourceAsset)), sourceBytes);
  checkpoint('working alpha0/1/128/255 follows integer geometry despite hidden/faded/masked/styled/filtered context; protected vector content also loads exactly; layers/pixels/source assets remain unchanged and target changes reset drafts');

  await open(maskId, solidId); await expect(panel.getByLabel('Invert layer selection source')).not.toBeChecked(); state = await load({ source: 'layer-mask' }); assert.deepEqual(decode(state.selection), effective); state = await load({ source: 'layer-mask', maskMode: 'raw' }); assert.deepEqual(decode(state.selection), rawMask);
  state = await load({ source: 'layer-mask', invert: true }); assert.deepEqual(decode(state.selection), Buffer.from(effective.map(value => 255 - value))); assert.equal(decode(state.selection)[32], 127);
  for (const mode of ['add', 'subtract', 'intersect']) { await load({ source: 'layer-mask', maskMode: 'raw' }); state = await load({ source: 'layer-mask', mode }); assert.deepEqual(decode(state.selection), combined(rawMask, effective, mode)); }
  await panel.getByLabel('Selection source layer').selectOption(groupId); await expect(panel.getByLabel('Layer selection source', { exact: true })).toHaveValue('layer-mask'); await expect(panel.getByLabel('Layer selection source', { exact: true }).locator('option[value="content"]')).toHaveJSProperty('disabled', true); state = await load({ source: 'layer-mask' }); assert.deepEqual(decode(state.selection), Buffer.alloc(width * height, 255)); state = await load({ source: 'layer-mask', maskMode: 'raw' }); assert.deepEqual(decode(state.selection), groupRaw);
  await panel.getByLabel('Selection source layer').selectOption(adjustmentId); state = await load({ source: 'layer-mask' }); assert.deepEqual(decode(state.selection), effective); assert.deepEqual(state.layers, maskBaseline.layers);
  await page.setViewportSize({ width: 900, height: 1100 }); for (let i = 0; i < 20; i++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click(); await panel.scrollIntoViewIfNeeded(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.equal(await page.locator('.inspector').evaluate(element => element.scrollWidth <= element.clientWidth), true); await page.screenshot({ path: path.join(artifacts, 'layer-selection-mask.png'), animations: 'disabled' });
  checkpoint('raw/effective inverted bitmap and geometric masks and density0/.5 match independent bytes; inversion complements quantized128 to127; all four combines work on content/group/adjustment masks without modifying those nodes');

  await open(emptyId, emptyLayerId); state = await load(); assert.deepEqual(decode(state.selection), Buffer.alloc(width * height)); await expect(activeSummary).toHaveText('Empty selection · no pixels selected'); await page.getByLabel('New saved selection name').fill('Explicit empty'); await mutate(() => page.getByRole('button', { name: 'Save current selection', exact: true }).click()); const emptySaved = structuredClone((await current()).savedSelections); await panel.getByLabel('Selection source layer').selectOption(emptyBaseId);
  const beforePaint = await pixels(emptyId); await page.getByRole('button', { name: 'Brush (B)', exact: true }).click(); const box = await page.locator('.artboard').boundingBox(); await mutate(async () => { await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width * 2 / 3, box.y + box.height / 2, { steps: 5 }); await page.mouse.up(); }); assert.deepEqual(await pixels(emptyId), beforePaint); assert.deepEqual(decode((await current()).selection), Buffer.alloc(width * height)); assert.deepEqual((await current()).savedSelections, emptySaved);
  await panel.getByLabel('Selection source layer').selectOption(emptyLayerId); state = await load({ invert: true }); assert.deepEqual(decode(state.selection), Buffer.alloc(width * height, 255)); await expect(activeSummary).not.toContainText('Empty selection'); await undo(); await expect(activeSummary).toHaveText('Empty selection · no pixels selected');
  await page.reload({ waitUntil: 'networkidle' }); await open(emptyId, emptyLayerId); assert.deepEqual((await current()).savedSelections, emptySaved); assert.deepEqual(decode((await current()).selection), Buffer.alloc(width * height));
  checkpoint('empty results stay active/non-null and are named explicitly; a real brush gesture changes no image pixels; inversion/undo/save/reopen preserve empty coverage and independent saved copies');

  await open(maskId, solidId); const conflictBaseline = await current(); let started, release; const requestStarted = new Promise(resolve => started = resolve), paused = new Promise(resolve => release = resolve); let blockOnce = true;
  await page.route('**/api/command', async route => { if (blockOnce && route.request().postDataJSON()?.command === 'load_layer_selection') { blockOnce = false; started(); await paused; } await route.continue(); });
  expectingConflict = true; await panel.getByRole('button', { name: 'Load from layer', exact: true }).click(); await requestStarted; const external = await seed(maskId, 'select_region', { shape: 'rectangle', x: 3, y: 4, width: 5, height: 6 }); release(); await expect(page.getByRole('alert')).toContainText('document changed before the selection was loaded'); assert.equal((await doc(maskId)).revision, external.revision); assert.deepEqual((await doc(maskId)).selection, external.selection); assert.equal(external.revision, conflictBaseline.revision + 1); await page.getByLabel('Dismiss notification').click(); await settled(); expectingConflict = false; await page.unroute('**/api/command'); state = await load({ source: 'layer-mask' }); assert.deepEqual(decode(state.selection), effective);
  const loadingRequests = requests.filter(request => request.command === 'load_layer_selection'); assert.ok(loadingRequests.length >= 15); for (const request of loadingRequests) { assert.equal(request.backend, 'native'); assert.ok(request.args.documentId && request.args.layerId); assert.ok(Number.isInteger(request.args.expectedRevision)); if (request.args.source === 'content') assert.equal(request.args.maskMode, undefined); }
  let gate = 'source-only'; await page.route('**/api/status', async route => { const response = await route.fetch(), status = await response.json(); for (const backend of status.backends) if (backend.id === 'native') { if (gate === 'source-only') backend.commands = backend.commands.filter(command => !['save_selection', 'load_selection', 'rename_selection', 'delete_selection'].includes(command)); else { delete backend.layerSelectionSources; delete backend.layerSelectionMaskModes; delete backend.layerSelectionContentTypes; } } await route.fulfill({ response, json: status }); });
  await page.reload({ waitUntil: 'networkidle' }); await open(maskId, solidId); await expect(panel).toBeVisible(); await expect(page.getByRole('button', { name: 'Save current selection', exact: true })).toHaveCount(0); gate = 'absent'; await page.reload({ waitUntil: 'networkidle' }); await page.getByLabel('Open document').selectOption(maskId); await settled(); await tab('Select'); await expect(panel).toHaveCount(0); await expect(page.getByRole('button', { name: 'Save current selection', exact: true })).toBeVisible();
  assert.deepEqual(errors, []); assert.equal(keyReads, 0); assert.equal(providerCalls, 0); assert.equal(segmentCalls, 0); assert.deepEqual(await fs.readFile(path.join(native.assetsDir, workingLayer.sourceAsset)), sourceBytes);
  checkpoint('captured revisions reject external changes without replacing their selection, explicit retry succeeds; capability gates handle source-only and absent support, compact layout fits, and no provider/segmentation/credential work runs');
  await fs.writeFile(path.join(artifacts, 'layer-selection-browser-report.json'), JSON.stringify({ passed: checkpoints, keyReads, providerCalls, segmentCalls, browserErrors: errors }, null, 2)); console.log(`Layer-selection browser checks passed: ${checkpoints.length} workflows.`);
} catch (error) { await page.screenshot({ path: path.join(artifacts, 'layer-selection-browser-failure.png'), animations: 'disabled' }).catch(() => {}); console.error('Browser errors:', errors); console.error('Visible alerts:', await page.getByRole('alert').allTextContents()); throw error; }
finally { await browser.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
