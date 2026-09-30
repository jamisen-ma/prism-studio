import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createCompanion } from '../server/index.mjs';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-layer-styles-browser-'));
const artifacts = path.resolve('test-results'); await fs.mkdir(artifacts, { recursive: true });
let keyReads = 0, providerCalls = 0;
const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => { keyReads++; return null; }, imageProvider: async () => { providerCalls++; throw Error('Styles must not generate images.'); } });
const width = 96, height = 72, raw = Buffer.alloc(width * height * 4);
for (let y = 12; y < 32; y++) for (let x = 10; x < 30; x++) raw.set([60 + x * 3, 90 + y, 140, (x + y) % 11 === 0 ? 1 : (x + y) % 7 === 0 ? 128 : 255], (y * width + x) * 4);
const source = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
let document = (await companion.native.execute('import_image', { name: 'Layer styles fixture', data: source.toString('base64'), mimeType: 'image/png' })).document;
const documentId = document.id, sourceId = document.layers[0].id;
const seed = async (command, args) => { document = (await companion.native.execute(command, { documentId, ...args })).document; return document; };
await seed('set_layer', { layerId: sourceId, name: 'Hidden protected source' });
await seed('set_layer_outline', { layerId: sourceId, width: 2, color: '#ffffff' });
await seed('set_layer_effects', { layerId: sourceId, effects: { shadow: { color: '#321c41', opacity: .6, blur: 2, x: 3, y: 4 } } });
await seed('duplicate_layer', { layerId: sourceId }); const targetId = document.layers.at(-1).id;
await seed('set_layer', { layerId: targetId, name: 'Filtered masked target', opacity: .7 });
await seed('transform_layer', { layerId: targetId, x: 42, y: 8 });
await seed('set_layer_mask', { layerId: targetId, mask: { shape: 'rectangle', x: 50, y: 18, width: 18, height: 21 } });
await seed('add_layer_filter', { layerId: targetId, kind: 'brightness', value: 8 });
await seed('set_layer_outline', { layerId: targetId, width: 4, color: '#3377ff' });
await seed('set_layer_effects', { layerId: targetId, effects: { glow: { color: '#ee9955', opacity: .7, blur: 2 } } });
await seed('set_layer_protection', { layerId: sourceId, protected: true });
await seed('set_layer', { layerId: sourceId, visible: false });
await seed('add_shape', { name: 'Plain shape', shape: 'ellipse', x: 74, y: 8, width: 12, height: 12, fill: '#799955' }); const plainId = document.layers.at(-1).id;
await seed('create_group', { name: 'Group ineligible' }); const groupId = document.layers.at(-1).id;
await seed('add_adjustment', { kind: 'brightness', value: 0 }); const adjustmentId = document.layers.at(-1).id;
const secondDocument = (await companion.native.execute('create_document', { name: 'Independent style library', width: 24, height: 24, background: '#8899aa' })).document;
const assets = new Map(); for (const layer of document.layers) for (const key of ['asset', 'sourceAsset', 'alphaAsset']) if (layer[key]) assets.set(layer[key], await fs.readFile(path.join(companion.native.assetsDir, layer[key])));
const baseUrl = `http://127.0.0.1:${await companion.listen()}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(12000);
const errors = [], checkpoints = [], requests = [];
page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/command')) requests.push(request.postDataJSON()); });
await page.route('https://**', route => route.abort());
const current = async () => (await companion.native.execute('get_document', { documentId })).document;
const panel = page.getByRole('region', { name: 'Saved layer styles', exact: true });
const settled = async () => { await expect(page.locator('.save-status .spin')).toHaveCount(0); await expect(page.getByRole('alert')).toHaveCount(0); };
async function mutate(action) { await settled(); const before = await current(); await action(); await expect.poll(async () => (await current()).revision).toBeGreaterThan(before.revision); await settled(); const after = await current(); assert.equal(after.revision, before.revision + 1, 'One UI action must commit once'); return after; }
const undo = () => mutate(() => page.getByRole('button', { name: 'Undo (⌘Z)', exact: true }).click());
const select = async id => { await page.locator(`.layer-row[data-layer-id="${id}"]`).click(); await expect(page.locator(`.layer-row[data-layer-id="${id}"]`)).toHaveClass(/selected/); };
const open = async () => { if (await panel.getByRole('button', { name: /Saved layer styles/ }).getAttribute('aria-expanded') !== 'true') await panel.getByRole('button', { name: /Saved layer styles/ }).click(); };
const layersTab = async () => { await page.locator('.inspector-tabs').getByRole('button', { name: 'Layers', exact: true }).click(); };
const contentOnly = layers => layers.map(({ outline, effects, ...rest }) => rest);
const preview = async () => Buffer.from((await companion.native.execute('get_preview', { documentId, maxWidth: width })).data, 'base64');
function checkpoint(message) { checkpoints.push(message); console.log(`Verified: ${message}`); }
try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' }); await page.getByLabel('Open document').selectOption(documentId); await expect(page.locator('.artboard img')).toBeVisible(); await layersTab(); await settled();
  await select(plainId); await open(); await expect(panel.getByRole('button', { name: 'Save style from selected layer', exact: true })).toBeDisabled();
  await select(sourceId); await expect(panel.getByRole('button', { name: 'Save style from selected layer', exact: true })).toBeEnabled();
  const beforeDraft = await current(); await panel.getByLabel('New layer style name', { exact: true }).fill('White outline + plum shadow'); assert.equal((await current()).revision, beforeDraft.revision);
  await mutate(() => panel.getByRole('button', { name: 'Save style from selected layer', exact: true }).click());
  let state = await current(), firstStyle = structuredClone(state.layerStyles[0]); const firstId = firstStyle.id;
  assert.equal(firstStyle.name, 'White outline + plum shadow'); assert.deepEqual(firstStyle.outline, beforeDraft.layers.find(layer => layer.id === sourceId).outline); assert.deepEqual(firstStyle.effects, beforeDraft.layers.find(layer => layer.id === sourceId).effects); assert.deepEqual(state.layers, beforeDraft.layers);
  await page.getByRole('region', { name: 'Layer effects', exact: true }).getByRole('button', { name: 'Clear effects', exact: true }).click(); await expect.poll(async () => (await current()).layers.find(layer => layer.id === sourceId).effects ?? null).toBeNull(); await settled();
  await panel.getByLabel('New layer style name', { exact: true }).fill('White outline only'); await mutate(() => panel.getByRole('button', { name: 'Save style from selected layer', exact: true }).click());
  const secondId = (await current()).layerStyles[1].id; assert.equal((await current()).layerStyles[1].effects, undefined); assert.deepEqual((await current()).layerStyles[0], firstStyle);
  checkpoint('enabled settings save from hidden protected content; drafts are local, styles retain stable IDs and independent copied settings');

  await select(targetId); const beforeApply = await current(), beforePixels = await preview();
  await expect(panel).toContainText('Missing settings clear existing effects');
  await mutate(() => panel.getByRole('button', { name: 'Apply style to selected layer', exact: true }).click());
  state = await current(); let target = state.layers.find(layer => layer.id === targetId);
  assert.deepEqual(target.outline, firstStyle.outline); assert.equal(target.effects, undefined); assert.deepEqual(contentOnly(state.layers), contentOnly(beforeApply.layers)); assert.deepEqual(state.layerStyles, beforeApply.layerStyles); assert.notDeepEqual(await preview(), beforePixels);
  await undo(); assert.deepEqual((await current()).layers, beforeApply.layers); assert.deepEqual(await preview(), beforePixels);
  await panel.getByLabel('Saved layer style', { exact: true }).selectOption(firstId);
  await page.getByRole('button', { name: 'Select layers', exact: true }).click(); await expect(panel.getByRole('button', { name: 'Apply style to checked layers (0)', exact: true })).toBeDisabled();
  for (const name of ['Hidden protected source', 'Filtered masked target']) await page.getByLabel(`Select layer ${name}`, { exact: true }).check();
  for (const id of [groupId, adjustmentId]) { const name = (await current()).layers.find(layer => layer.id === id).name; await page.getByLabel(`Select layer ${name}`, { exact: true }).check(); await expect(panel.getByRole('button', { name: 'Apply style to checked layers (3)', exact: true })).toBeDisabled(); await expect(panel).toContainText('Groups and adjustments cannot receive styles'); await page.getByLabel(`Select layer ${name}`, { exact: true }).uncheck(); }
  const beforeMulti = await current(); await mutate(() => panel.getByRole('button', { name: 'Apply style to checked layers (2)', exact: true }).click());
  state = await current(); for (const id of [sourceId, targetId]) { const layer = state.layers.find(layer => layer.id === id); assert.deepEqual(layer.outline, firstStyle.outline); assert.deepEqual(layer.effects, firstStyle.effects); }
  assert.deepEqual(contentOnly(state.layers), contentOnly(beforeMulti.layers)); assert.deepEqual(new Set(requests.filter(request => request.command === 'apply_layer_style').at(-1).args.layerIds), new Set([sourceId, targetId]));
  await undo(); assert.deepEqual((await current()).layers, beforeMulti.layers); await mutate(() => page.getByRole('button', { name: 'Redo (⇧⌘Z)', exact: true }).click());
  await page.getByRole('button', { name: 'Cancel selection', exact: true }).click();
  checkpoint('single and exact checked-set apply replace all outside-style slots, retain pixels/assets/masks/filters/protection, reject group/adjustment targets and undo atomically');

  await select(sourceId); await panel.getByLabel('Saved layer style', { exact: true }).selectOption(secondId); await mutate(() => panel.getByRole('button', { name: 'Apply style to selected layer', exact: true }).click());
  await panel.getByLabel('Saved layer style', { exact: true }).selectOption(firstId); const beforeOverwrite = await current();
  await mutate(() => panel.getByRole('button', { name: 'Overwrite style from selected layer', exact: true }).click());
  state = await current(); assert.equal(state.layerStyles.length, 2); assert.equal(state.layerStyles[0].id, firstId); assert.equal(state.layerStyles[0].name, firstStyle.name); assert.equal(state.layerStyles[0].effects, undefined); assert.deepEqual(state.layers, beforeOverwrite.layers); assert.deepEqual(state.layers.find(layer => layer.id === targetId).effects, firstStyle.effects);
  await panel.getByLabel('Saved layer style name', { exact: true }).fill('Reusable white edge'); await mutate(() => panel.getByRole('button', { name: 'Rename style', exact: true }).click());
  const beforeDelete = await current(); assert.equal(beforeDelete.layerStyles[0].name, 'Reusable white edge');
  await mutate(() => panel.getByRole('button', { name: 'Delete saved style', exact: true }).click()); assert.equal((await current()).layerStyles.length, 1); assert.deepEqual((await current()).layers, beforeDelete.layers);
  await undo(); assert.deepEqual((await current()).layerStyles, beforeDelete.layerStyles); assert.deepEqual((await current()).layers, beforeDelete.layers);
  for (const [hash, bytes] of assets) assert.deepEqual(await fs.readFile(path.join(companion.native.assetsDir, hash)), bytes);
  checkpoint('overwrite preserves preset ID/name without changing prior applications; rename/delete are independent and reversible, and all source asset bytes remain intact');

  const persisted = await current(); await page.reload({ waitUntil: 'networkidle' }); await page.getByLabel('Open document').selectOption(documentId); await layersTab(); await settled(); await open(); assert.deepEqual((await current()).layerStyles, persisted.layerStyles);
  await select(targetId); await panel.getByLabel('Saved layer style', { exact: true }).selectOption(firstId); await page.setViewportSize({ width: 900, height: 1100 }); await panel.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.equal(await page.locator('.inspector').evaluate(element => element.scrollWidth <= element.clientWidth), true); await page.screenshot({ path: path.join(artifacts, 'saved-layer-styles.png'), animations: 'disabled' });
  await page.getByLabel('Open document').selectOption(secondDocument.id); await layersTab(); await settled(); await open(); await expect(panel).toContainText('No styles saved in this document yet'); await expect(panel.getByLabel('Saved layer style', { exact: true })).toHaveCount(0);
  await companion.native.execute('set_layer_outline', { documentId: secondDocument.id, layerId: secondDocument.layers[0].id, width: 1, color: '#ffffff' });
  for (let index = 0; index < 32; index++) await companion.native.execute('save_layer_style', { documentId: secondDocument.id, layerId: secondDocument.layers[0].id, name: `Saved style ${index + 1}` });
  await page.reload({ waitUntil: 'networkidle' }); await page.getByLabel('Open document').selectOption(secondDocument.id); await layersTab(); await settled(); await open();
  await expect(panel).toContainText('All 32 slots are used'); await expect(panel.getByRole('button', { name: 'Save style from selected layer', exact: true })).toBeDisabled(); await expect(panel.getByRole('button', { name: 'Overwrite style from selected layer', exact: true })).toBeEnabled();
  for (const request of requests.filter(request => ['save_layer_style', 'apply_layer_style', 'rename_layer_style', 'delete_layer_style'].includes(request.command))) { assert.equal(request.backend, 'native'); assert.equal(request.args.documentId, documentId); assert.ok(Number.isInteger(request.args.expectedRevision)); }
  assert.equal(keyReads, 0); assert.equal(providerCalls, 0); assert.deepEqual(errors, []);
  checkpoint('library survives reopening, stays scoped to its document, enforces 32 slots while allowing overwrite, uses revision guards, and fits 900px without browser errors or AI calls');
  await fs.writeFile(path.join(artifacts, 'layer-styles-browser-report.json'), JSON.stringify({ passed: checkpoints, keyReads, providerCalls, browserErrors: errors }, null, 2)); console.log(`Layer styles browser checks passed: ${checkpoints.length} workflows.`);
} catch (error) { await page.screenshot({ path: path.join(artifacts, 'layer-styles-browser-failure.png'), animations: 'disabled' }).catch(() => {}); console.error('Visible alerts:', await page.getByRole('alert').allTextContents().catch(() => [])); throw error; }
finally { await browser.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
