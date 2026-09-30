import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createCompanion } from '../server/index.mjs';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-clipping-browser-'));
const artifacts = path.resolve('test-results'); await fs.mkdir(artifacts, { recursive: true });
let keyReads = 0, providerCalls = 0;
const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => { keyReads++; return null; }, imageProvider: async () => { providerCalls++; throw Error('Clipping must not generate images.'); } });
const width = 128, height = 96;
const png = raw => sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
let document = (await companion.native.execute('import_image', { name: 'Image inside editable type', data: (await png(Buffer.alloc(width * height * 4))).toString('base64'), mimeType: 'image/png' })).document;
const documentId = document.id;
const seed = async (command, args) => { document = (await companion.native.execute(command, { documentId, ...args })).document; return document; };
await seed('add_text', { name: 'Editable AI title', text: 'AI', x: 12, y: 15, fontSize: 65, fontFamily: 'Fraunces', color: '#f5cc80' }); const baseId = document.layers.at(-1).id;
const pattern = Buffer.from(Array.from({ length: width * height }, (_, index) => [40 + index % width, 90 + Math.floor(index / width), index % 2 ? 170 : 80, 255]).flat());
const sourcePng = await png(pattern), sourceDocument = (await companion.native.execute('import_image', { name: 'Pattern original', data: sourcePng.toString('base64'), mimeType: 'image/png' })).document;
await seed('place_layer', { sourceDocumentId: sourceDocument.id, sourceLayerId: sourceDocument.layers[0].id, sourceExpectedRevision: sourceDocument.revision, x: 0, y: 0, width, height, protect: false, name: 'Pattern image' }); const firstId = document.layers.at(-1).id;
await seed('add_gradient', { name: 'Cool tint', kind: 'linear', start: { x: 0, y: 0 }, end: { x: width, y: 0 }, stops: [{ offset: 0, color: '#204080' }, { offset: 1, color: '#204080' }] }); const secondId = document.layers.at(-1).id; await seed('set_layer', { layerId: secondId, opacity: .5 });
await seed('add_shape', { name: 'Protected hidden layer', shape: 'rectangle', x: 4, y: 4, width: 12, height: 12, fill: '#778899' }); const protectedId = document.layers.at(-1).id; await seed('set_layer_protection', { layerId: protectedId, protected: true }); await seed('set_layer', { layerId: protectedId, visible: false });
await seed('add_shape', { name: 'Styled hidden layer', shape: 'rectangle', x: 4, y: 4, width: 12, height: 12, fill: '#778899' }); const styledId = document.layers.at(-1).id; await seed('set_layer_outline', { layerId: styledId, width: 2, color: '#ffffff' }); await seed('save_layer_style', { layerId: styledId, name: 'Outside edge preset' }); await seed('set_layer', { layerId: styledId, visible: false });
await seed('create_group', { name: 'Unsupported group' }); const badGroupId = document.layers.at(-1).id;
await seed('add_adjustment', { kind: 'brightness', value: 0 }); const badAdjustmentId = document.layers.at(-1).id; await seed('set_layer', { layerId: badAdjustmentId, visible: false });
await seed('add_guide', { axis: 'vertical', position: 50 });
// Valid persisted defaults need not be normalized before the inspector sees them.
const persisted = companion.native.projects.get(documentId), graph = structuredClone(persisted.states[persisted.cursor].graph);
const defaultStyled = graph.layers.find(layer => layer.id === styledId); delete defaultStyled.outline; defaultStyled.effects = { shadow: {}, glow: {} };
document = (await companion.native.commit(persisted, graph, 'Imported effect defaults fixture')).document;
const current = async () => (await companion.native.execute('get_document', { documentId })).document;
const layerPixels = async layerId => sharp(Buffer.from((await companion.native.execute('get_layer_preview', { documentId, layerId, view: 'layer', maxWidth: width })).data, 'base64')).ensureAlpha().raw().toBuffer();
const pixels = async () => sharp(Buffer.from((await companion.native.execute('get_preview', { documentId, maxWidth: width })).data, 'base64')).ensureAlpha().raw().toBuffer();
const basePixels = await layerPixels(baseId), beforeClip = await current(), unlinkedPixels = await pixels(); assert.ok(basePixels.some((value, index) => index % 4 === 3 && value > 0 && value < 255));
const assets = new Map(); for (const layer of document.layers) for (const key of ['asset', 'sourceAsset', 'alphaAsset']) if (layer[key]) assets.set(layer[key], await fs.readFile(path.join(companion.native.assetsDir, layer[key])));
const baseUrl = `http://127.0.0.1:${await companion.listen()}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(12000);
const errors = [], checkpoints = [], requests = [];
page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/command')) requests.push(request.postDataJSON()); });
await page.route('https://**', route => route.abort());
const panel = page.getByRole('region', { name: 'Layer clipping', exact: true });
const settled = async () => { await expect(page.locator('.save-status .spin')).toHaveCount(0); await expect(page.getByRole('alert')).toHaveCount(0); };
async function mutate(action) { await settled(); const before = await current(); await action(); await expect.poll(async () => (await current()).revision).toBeGreaterThan(before.revision); await settled(); const after = await current(); assert.equal(after.revision, before.revision + 1); return after; }
const undo = () => mutate(() => page.getByRole('button', { name: 'Undo (⌘Z)', exact: true }).click());
const select = id => page.locator(`.layer-row[data-layer-id="${id}"]`).click();
async function checked(id, value) { const name = (await current()).layers.find(layer => layer.id === id).name; await page.getByLabel(`Select layer ${name}`, { exact: true }).setChecked(value); }
function alphaSame(actual, expected = basePixels) { for (let i = 3; i < actual.length; i += 4) assert.equal(actual[i], expected[i], `silhouette alpha ${i / 4}`); }
function checkpoint(message) { checkpoints.push(message); console.log(`Verified: ${message}`); }
try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' }); await page.getByLabel('Open document').selectOption(documentId); await page.locator('.inspector-tabs').getByRole('button', { name: 'Layers', exact: true }).click(); await settled(); await select(baseId);
  await panel.getByRole('button', { name: 'Choose layers for clipping', exact: true }).click(); await expect(panel.getByRole('button', { name: 'Create clipping chain', exact: true })).toBeDisabled();
  await checked(baseId, true); await checked(firstId, true); await checked(secondId, true); await expect(panel).toContainText('Lowest checked layer: Editable AI title');
  for (const [id, hint] of [[protectedId, 'remove protection'], [styledId, 'Remove outside outlines'], [badGroupId, 'Groups and adjustment'], [badAdjustmentId, 'Groups and adjustment']]) { await checked(id, true); await expect(panel.getByRole('button', { name: 'Create clipping chain', exact: true })).toBeDisabled(); await expect(panel).toContainText(hint); await checked(id, false); }
  await checked(firstId, false); await expect(panel).toContainText('consecutive direct siblings'); await checked(firstId, true);
  await mutate(() => panel.getByRole('button', { name: 'Create clipping chain', exact: true }).click());
  let state = await current(); for (const id of [firstId, secondId]) assert.equal(state.layers.find(layer => layer.id === id).clipBaseId, baseId);
  await select(protectedId); await expect(page.getByRole('button', { name: 'Move layer down', exact: true })).toBeDisabled();
  await select(state.layers[0].id); await expect(page.getByRole('button', { name: 'Move layer up', exact: true })).toBeDisabled();
  await select(styledId); const defaultStyles = page.getByRole('region', { name: 'Saved layer styles', exact: true }); await defaultStyles.getByRole('button', { name: /Saved layer styles/ }).click(); await expect(defaultStyles.getByRole('button', { name: 'Save style from selected layer', exact: true })).toBeEnabled(); await defaultStyles.getByRole('button', { name: /Saved layer styles/ }).click(); await select(baseId);
  const clipped = await pixels(); alphaSame(clipped); assert.deepEqual(await layerPixels(baseId), clipped); const member = await layerPixels(secondId); for (let i = 3; i < member.length; i += 4) assert.equal(member[i], Math.round(basePixels[i] * .5));
  for (let i = 0; i < clipped.length; i += 4) if (basePixels[i + 3]) for (let channel = 0; channel < 3; channel++) assert.ok(Math.abs(clipped[i + channel] - Math.round((pattern[i + channel] + [32, 64, 128][channel]) / 2)) <= 1);
  await undo(); assert.deepEqual(await pixels(), unlinkedPixels); assert.deepEqual((await current()).layers, beforeClip.layers); await mutate(() => page.getByRole('button', { name: 'Redo (⇧⌘Z)', exact: true }).click()); assert.deepEqual(await pixels(), clipped);
  checkpoint('checked canonical siblings create image-inside-editable Fraunces text, validate unsupported/protected/styled targets, preserve every soft-alpha edge and correct member/base previews, and undo once');

  await checked(secondId, false); await expect(page.getByRole('button', { name: 'Group selected (2)', exact: true })).toBeDisabled(); await mutate(() => panel.getByRole('button', { name: 'Replace clipping chain', exact: true }).click()); assert.equal((await current()).layers.find(layer => layer.id === secondId).clipBaseId, undefined); assert.equal((await current()).layers.find(layer => layer.id === firstId).clipBaseId, baseId); await undo();
  await checked(secondId, true); await mutate(() => page.getByRole('button', { name: 'Group selected (3)', exact: true }).click()); const containing = (await current()).layers.find(layer => layer.type === 'group' && layer.id !== badGroupId); assert.ok(containing); assert.deepEqual(await pixels(), clipped); await undo();
  await select(firstId); await expect(page.getByRole('button', { name: 'Duplicate selected layer', exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: 'Delete selected layer', exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: 'Move layer up', exact: true })).toBeDisabled(); await expect(page.getByLabel('Move to group', { exact: true })).toBeDisabled(); await expect(page.getByLabel('Protect original pixels', { exact: true })).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Layer effects', exact: true }).getByLabel('Drop shadow', { exact: true })).toBeDisabled(); await page.getByLabel('Outside outline width', { exact: true }).fill('2'); await expect(page.getByRole('button', { name: 'Apply outline', exact: true })).toBeDisabled();
  const styles = page.getByRole('region', { name: 'Saved layer styles', exact: true }); await styles.getByRole('button', { name: /Saved layer styles/ }).click(); await expect(styles.getByRole('button', { name: 'Apply style to selected layer', exact: true })).toBeDisabled(); await expect(styles).toContainText('Release clipping');
  await page.getByRole('button', { name: 'Canvas layout and guides', exact: true }).click(); await page.getByLabel('Snap Move to guides').check(); await expect(page.locator('.move-options')).toContainText('clipping-chain participants'); await page.getByRole('button', { name: 'Back to layers', exact: true }).click();
  await expect(page.locator('.move-options')).not.toContainText('Reading layer bounds'); const artboard = await page.locator('.artboard').boundingBox(); await page.mouse.move(artboard.x + 30, artboard.y + 40); await page.mouse.down(); await page.mouse.move(artboard.x + 33, artboard.y + 42); await mutate(() => page.mouse.up()); alphaSame(await pixels()); assert.notDeepEqual(await pixels(), clipped); await undo(); assert.deepEqual(await pixels(), clipped);
  checkpoint('explicit replacement releases omitted members; complete-chain grouping works, partial structural edits and member styles/protection are disabled, and free Move works while snapping is off');

  await select(baseId); const idsBefore = (await current()).layers.map(layer => layer.id); await page.getByLabel('Edit text content', { exact: true }).fill('HI'); await mutate(() => page.getByRole('button', { name: 'Update text layer', exact: true }).click()); assert.deepEqual((await current()).layers.map(layer => layer.id), idsBefore); assert.equal((await current()).layers.find(layer => layer.id === baseId).text, 'HI'); assert.notDeepEqual(await pixels(), clipped); assert.equal((await current()).layers.find(layer => layer.id === firstId).clipBaseId, baseId); await undo(); assert.deepEqual(await pixels(), clipped);
  await select(firstId); await mutate(() => panel.getByRole('button', { name: 'Release clipping chain', exact: true }).click()); assert.ok((await current()).layers.every(layer => !layer.clipBaseId)); assert.deepEqual(await pixels(), unlinkedPixels); await undo(); assert.deepEqual(await pixels(), clipped);
  const final = await current(); await page.reload({ waitUntil: 'networkidle' }); await page.getByLabel('Open document').selectOption(documentId); await page.locator('.inspector-tabs').getByRole('button', { name: 'Layers', exact: true }).click(); await settled(); await select(baseId); assert.deepEqual((await current()).layers, final.layers); assert.deepEqual(await pixels(), clipped);
  await page.setViewportSize({ width: 900, height: 1100 }); for (let i = 0; i < 15; i++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click(); await panel.scrollIntoViewIfNeeded(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.equal(await page.locator('.inspector').evaluate(element => element.scrollWidth <= element.clientWidth), true); await page.screenshot({ path: path.join(artifacts, 'clipping-editable-type.png'), animations: 'disabled' });
  for (const [hash, bytes] of assets) assert.deepEqual(await fs.readFile(path.join(companion.native.assetsDir, hash)), bytes); for (const request of requests.filter(request => request.command === 'set_clipping_chain')) { assert.equal(request.backend, 'native'); assert.equal(request.args.documentId, documentId); assert.ok(Number.isInteger(request.args.expectedRevision)); }
  assert.equal(keyReads, 0); assert.equal(providerCalls, 0); assert.deepEqual(errors, []);
  checkpoint('text remains editable without new IDs, explicit release reveals the original fills, undo/reopen restore exact pixels, and source assets plus compact layout remain intact');
  await fs.writeFile(path.join(artifacts, 'clipping-browser-report.json'), JSON.stringify({ passed: checkpoints, keyReads, providerCalls, browserErrors: errors }, null, 2)); console.log(`Clipping browser checks passed: ${checkpoints.length} workflows.`);
} catch (error) { await page.screenshot({ path: path.join(artifacts, 'clipping-browser-failure.png'), animations: 'disabled' }).catch(() => {}); console.error('Visible alerts:', await page.getByRole('alert').allTextContents().catch(() => [])); throw error; }
finally { await browser.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
