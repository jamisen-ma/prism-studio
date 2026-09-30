import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createCompanion } from '../server/index.mjs';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-color-browser-'));
const artifacts = path.resolve('test-results'); await fs.mkdir(artifacts, { recursive: true });
let keyReads = 0, providerCalls = 0;
const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => { keyReads++; return null; }, imageProvider: async () => { providerCalls++; throw Error('Color editing must stay local.'); } });
const width = 64, height = 48, raw = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set([(x * 13 + y) % 256, (y * 11 + x) % 256, (x * 7 + y * 3) % 256, [0, 1, 128, 255][(x + y) % 4]], (y * width + x) * 4);
const source = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
const make = async name => { let d = (await companion.native.execute('import_image', { name, data: source.toString('base64'), mimeType: 'image/png' })).document; return (await companion.native.execute('select_region', { documentId: d.id, x: 0, y: 0, width: width / 2, height, shape: 'rectangle' })).document; };
const adjustmentDoc = await make('Color adjustment fixture'), filterDoc = await make('Source color filter fixture');
const sparseDoc = await make('Imported sparse color settings'), sparseLayerId = sparseDoc.layers[0].id;
for (const kind of ['channel_mixer', 'gradient_map']) await companion.native.execute('add_layer_filter', { documentId: sparseDoc.id, layerId: sparseLayerId, kind, value: 0 });
const sparseProject = companion.native.projects.get(sparseDoc.id), sparseGraph = structuredClone(sparseProject.states[sparseProject.cursor].graph);
sparseGraph.layers[0].filters[0].parameters = { red: [0, 100, 0, 0] };
sparseGraph.layers[0].filters[1].parameters = { reverse: true };
await companion.native.commit(sparseProject, sparseGraph, 'Imported partial parameters fixture');
const sparseAdjustmentDoc = await make('Imported partial adjustments');
for (const kind of ['channel_mixer', 'gradient_map']) await companion.native.execute('add_adjustment', { documentId: sparseAdjustmentDoc.id, kind, value: 0 });
const sparseAdjustmentProject = companion.native.projects.get(sparseAdjustmentDoc.id), sparseAdjustmentGraph = structuredClone(sparseAdjustmentProject.states[sparseAdjustmentProject.cursor].graph);
sparseAdjustmentGraph.layers[1].parameters = { red: [0, 100, 0, 0] };
sparseAdjustmentGraph.layers[2].parameters = { reverse: true };
await companion.native.commit(sparseAdjustmentProject, sparseAdjustmentGraph, 'Imported partial adjustment parameters');
let documentId = adjustmentDoc.id;
const current = async () => (await companion.native.execute('get_document', { documentId })).document;
const pixels = async () => sharp(Buffer.from((await companion.native.execute('get_preview', { documentId, maxWidth: width })).data, 'base64')).ensureAlpha().raw().toBuffer();
const baseline = await pixels();
const clamp = value => Math.round(Math.max(0, Math.min(255, value)));
function reference(input, parameters, kind, selected = false) {
  const out = Buffer.from(input);
  for (let i = 0; i < out.length; i += 4) {
    if (!input[i + 3] || selected && (i / 4) % width >= width / 2) continue;
    const channels = [...input.subarray(i, i + 3)];
    if (kind === 'channel_mixer') {
      const result = row => clamp((channels.reduce((sum, value, index) => sum + value * Math.round(row[index] * 100), 0) + 255 * Math.round(row[3] * 100)) / 10000);
      if (parameters.monochrome) out.fill(result(parameters.gray), i, i + 3);
      else ['red', 'green', 'blue'].forEach((key, channel) => out[i + channel] = result(parameters[key]));
    } else {
      const total = 2550000, tone = channels[0] * 2126 + channels[1] * 7152 + channels[2] * 722;
      const t = (parameters.reverse ? total - tone : tone) / total;
      let at = 0; while (at + 1 < parameters.stops.length - 1 && t > parameters.stops[at + 1].offset) at++;
      const a = parameters.stops[at], b = parameters.stops[at + 1], fraction = (t - a.offset) / (b.offset - a.offset);
      for (let c = 0; c < 3; c++) { const start = parseInt(a.color.slice(1 + c * 2, 3 + c * 2), 16), end = parseInt(b.color.slice(1 + c * 2, 3 + c * 2), 16); out[i + c] = clamp(start + (end - start) * fraction); }
    }
  }
  return out;
}
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(12000);
const errors = [], requests = [], checkpoints = [];
page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/command')) requests.push(request.postDataJSON()); });
await page.route('https://**', route => route.abort());
const settled = async () => { await expect(page.locator('.save-status .spin')).toHaveCount(0); await expect(page.getByRole('alert')).toHaveCount(0); };
async function mutate(action) { await settled(); const revision = (await current()).revision; await action(); await expect.poll(async () => (await current()).revision).toBeGreaterThan(revision); await settled(); const result = await current(); assert.equal(result.revision, revision + 1); return result; }
const undo = () => mutate(() => page.getByRole('button', { name: 'Undo (⌘Z)', exact: true }).click());
const tab = name => page.locator('.inspector-tabs').getByRole('button', { name, exact: true }).click();
const select = id => page.locator(`.layer-row[data-layer-id="${id}"]`).click();
const color = async (scope, label, value) => { await scope.getByLabel(label, { exact: true }).fill(value); };
function checkpoint(message) { checkpoints.push(message); console.log(`Verified: ${message}`); }
try {
  await page.goto(`http://127.0.0.1:${await companion.listen()}`, { waitUntil: 'networkidle' }); await page.getByLabel('Open document').selectOption(documentId); await settled();
  await tab('Adjustments'); const workbench = page.locator('.professional-color'); await workbench.getByRole('button', { name: 'Channel Mixer', exact: true }).click();
  await workbench.getByLabel('Mixer red coefficient').fill('0.001'); await expect(workbench.getByRole('button', { name: 'Add Channel Mixer layer' })).toBeDisabled();
  const unchanged = (await current()).revision, count = requests.filter(r => r.command === 'add_adjustment').length;
  await workbench.getByLabel('Mixer red coefficient').fill('201'); await expect(workbench.getByRole('button', { name: 'Add Channel Mixer layer' })).toBeDisabled(); assert.equal((await current()).revision, unchanged); assert.equal(requests.filter(r => r.command === 'add_adjustment').length, count);
  await workbench.getByLabel('Mixer red coefficient').fill('0'); await workbench.getByLabel('Mixer blue coefficient').fill('100');
  await workbench.getByLabel('Mixer output channel').selectOption('blue'); await workbench.getByLabel('Mixer blue coefficient').fill('0'); await workbench.getByLabel('Mixer red coefficient').fill('100');
  let state = await mutate(() => workbench.getByRole('button', { name: 'Add Channel Mixer layer' }).click()); const mixerId = state.layers.at(-1).id;
  let mixer = state.layers.at(-1); assert.equal(mixer.value, 0); assert.ok(mixer.mask); assert.deepEqual(await pixels(), reference(baseline, mixer.parameters, mixer.kind, true));
  await tab('Layers'); await select(mixerId); const editor = page.locator('.editable-adjustment');
  await editor.getByLabel('Mixer monochrome').check(); await editor.getByLabel('Mixer constant coefficient').fill('3.25'); state = await mutate(() => editor.getByRole('button', { name: 'Update Channel Mixer', exact: true }).click()); mixer = state.layers.find(l => l.id === mixerId);
  assert.deepEqual(mixer.parameters.red, [0, 0, 100, 0]); assert.deepEqual(mixer.parameters.blue, [100, 0, 0, 0]); assert.deepEqual(await pixels(), reference(baseline, mixer.parameters, mixer.kind, true));
  await editor.getByLabel('Mixer monochrome').uncheck(); await mutate(() => editor.getByRole('button', { name: 'Update Channel Mixer', exact: true }).click()); assert.equal((await current()).layers.at(-1).parameters.gray[3], 3.25); await undo();
  mixer = (await current()).layers.at(-1); const monochromePixels = await pixels(); assert.equal(mixer.id, mixerId); assert.equal(mixer.parameters.monochrome, true);
  checkpoint('selection-masked Channel Mixer runs at value zero, exact RGB/alpha match independent integer arithmetic, color and mono rows survive toggles, invalid precision/range dispatch nothing, and editing keeps one layer ID');

  await tab('Adjustments'); await workbench.getByRole('button', { name: 'Gradient Map', exact: true }).click();
  await color(workbench, 'Gradient map stop 1 color', '#102040'); await color(workbench, 'Gradient map stop 2 color', '#ffeedd');
  await workbench.getByRole('button', { name: 'Add gradient map stop', exact: true }).click(); await color(workbench, 'Gradient map stop 2 color', '#c050a0'); await workbench.getByLabel('Gradient map stop 2 position').fill('0'); await expect(workbench.getByRole('button', { name: 'Add Gradient Map layer' })).toBeDisabled();
  await workbench.getByLabel('Gradient map stop 2 position').fill('37.5'); await workbench.getByLabel('Reverse gradient map').check();
  state = await mutate(() => workbench.getByRole('button', { name: 'Add Gradient Map layer' }).click()); const gradientId = state.layers.at(-1).id; let gradient = state.layers.at(-1);
  assert.equal(gradient.value, 0); assert.deepEqual(await pixels(), reference(monochromePixels, gradient.parameters, gradient.kind, true));
  await tab('Layers'); await select(gradientId); await editor.getByLabel('Reverse gradient map').uncheck(); state = await mutate(() => editor.getByRole('button', { name: 'Update Gradient Map', exact: true }).click()); gradient = state.layers.at(-1); assert.equal(gradient.id, gradientId); assert.equal(gradient.parameters.stops.length, 3); assert.deepEqual(await pixels(), reference(monochromePixels, gradient.parameters, gradient.kind, true));
  await undo(); await expect(editor.getByLabel('Reverse gradient map')).toBeChecked();
  for (let i = 3; i < 16; i++) await editor.getByRole('button', { name: 'Add gradient map stop' }).click(); await expect(editor.getByRole('button', { name: 'Add gradient map stop' })).toBeDisabled(); await expect(editor.getByLabel('Gradient map stop 1 position')).toBeDisabled(); await expect(editor.getByLabel('Gradient map stop 16 position')).toBeDisabled();
  await editor.getByRole('button', { name: 'Delete gradient map stop 2', exact: true }).click(); await expect(editor.getByRole('button', { name: 'Add gradient map stop' })).toBeEnabled();
  await page.reload({ waitUntil: 'networkidle' }); await page.getByLabel('Open document').selectOption(documentId); await tab('Layers'); await select(gradientId); assert.equal((await current()).layers.at(-1).parameters.stops.length, 3); assert.deepEqual(await pixels(), reference(monochromePixels, gradient.parameters = { ...gradient.parameters, reverse: true }, gradient.kind, true));
  checkpoint('Gradient Map matches exact nonuniform tone interpolation and reverse, rejects coincident stops, bounds its editable library to 16 stops, retains IDs and masks, and undo/reopen discard uncommitted drafts');

  documentId = filterDoc.id; await page.getByLabel('Open document').selectOption(documentId); await settled(); const sourceLayer = filterDoc.layers[0], panel = page.getByRole('region', { name: 'Layer filters', exact: true }); await select(sourceLayer.id);
  assert.equal(await panel.getByLabel('New layer filter kind').locator('option').count(), 32); await panel.getByLabel('New layer filter kind').selectOption('channel_mixer'); await panel.getByLabel('Mixer red coefficient').fill('-100'); await panel.getByLabel('Mixer constant coefficient').fill('100');
  state = await mutate(() => panel.getByRole('button', { name: 'Add layer filter', exact: true }).click()); let filters = state.layers[0].filters; const filterMixerId = filters[0].id; let mixed = reference(baseline, filters[0].parameters, 'channel_mixer'); assert.deepEqual(await pixels(), mixed); assert.deepEqual(state.selection, filterDoc.selection);
  await panel.getByRole('button', { name: 'New filter', exact: true }).click(); await panel.getByLabel('New layer filter kind').selectOption('gradient_map'); await color(panel, 'Gradient map stop 1 color', '#102040'); await color(panel, 'Gradient map stop 2 color', '#ffeedd');
  state = await mutate(() => panel.getByRole('button', { name: 'Add layer filter', exact: true }).click()); filters = state.layers[0].filters; const filterGradientId = filters[1].id; const ordered = reference(mixed, filters[1].parameters, 'gradient_map'); assert.deepEqual(await pixels(), ordered);
  await mutate(() => panel.getByRole('button', { name: 'Move filter 2 earlier', exact: true }).click()); assert.deepEqual(await pixels(), reference(reference(baseline, filters[1].parameters, 'gradient_map'), filters[0].parameters, 'channel_mixer')); assert.notDeepEqual(await pixels(), ordered); await undo();
  await mutate(() => panel.getByLabel('Enable filter 2 Gradient Map').click()); assert.deepEqual(await pixels(), mixed); await mutate(() => panel.getByLabel('Enable filter 2 Gradient Map').click());
  await panel.getByRole('button', { name: 'Edit filter 2 Gradient Map' }).click(); await panel.getByLabel('Layer filter opacity').fill('0'); await mutate(() => panel.getByRole('button', { name: 'Apply filter changes' }).click()); assert.deepEqual(await pixels(), mixed); await undo();
  assert.deepEqual((await current()).layers[0].filters.map(f => f.id), [filterMixerId, filterGradientId]);
  checkpoint('the same parameter editors create source filters across the full image despite selection, preserve alpha, reorder with independently checked pixel changes, bypass on disable/zero opacity, and retain stable filter IDs');

  const final = await current(), finalPixels = await pixels(); await page.reload({ waitUntil: 'networkidle' }); await page.getByLabel('Open document').selectOption(documentId); await tab('Layers'); await select(sourceLayer.id); assert.deepEqual((await current()).layers[0].filters, final.layers[0].filters); assert.deepEqual(await pixels(), finalPixels);
  await page.setViewportSize({ width: 900, height: 1100 }); await panel.getByRole('button', { name: 'Edit filter 2 Gradient Map' }).click(); for (let i = 0; i < 25; i++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click(); await panel.scrollIntoViewIfNeeded(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.equal(await page.locator('.inspector').evaluate(element => element.scrollWidth <= element.clientWidth), true); await page.screenshot({ path: path.join(artifacts, 'color-mapping-controls.png'), animations: 'disabled' }); await panel.getByRole('button', { name: 'Edit filter 1 Channel Mixer' }).click(); await panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(artifacts, 'channel-mixer-controls.png'), animations: 'disabled' });
  assert.deepEqual(await fs.readFile(path.join(companion.native.assetsDir, sourceLayer.sourceAsset)), source); const original = await companion.native.execute('get_layer_preview', { documentId, layerId: sourceLayer.id, view: 'source', maxWidth: width }); assert.deepEqual(await sharp(Buffer.from(original.data, 'base64')).ensureAlpha().raw().toBuffer(), raw);
  documentId = sparseDoc.id; await page.getByLabel('Open document').selectOption(documentId); await settled(); await select(sparseLayerId);
  await expect(panel.getByLabel('Mixer red coefficient')).toHaveValue('0'); await expect(panel.getByLabel('Mixer green coefficient')).toHaveValue('100'); await expect(panel.getByLabel('Mixer monochrome')).not.toBeChecked();
  await panel.getByLabel('Mixer output channel').selectOption('green'); await expect(panel.getByLabel('Mixer red coefficient')).toHaveValue('0'); await expect(panel.getByLabel('Mixer green coefficient')).toHaveValue('100'); await panel.getByLabel('Mixer output channel').selectOption('blue'); await expect(panel.getByLabel('Mixer blue coefficient')).toHaveValue('100');
  await panel.getByLabel('Mixer monochrome').check(); await expect(panel.getByLabel('Mixer red coefficient')).toHaveValue('21.26'); await expect(panel.getByLabel('Mixer green coefficient')).toHaveValue('71.52'); await expect(panel.getByLabel('Mixer blue coefficient')).toHaveValue('7.22');
  await panel.getByRole('button', { name: 'Edit filter 2 Gradient Map' }).click(); await expect(panel.getByLabel('Reverse gradient map')).toBeChecked(); await expect(panel.getByLabel('Gradient map stop 1 color')).toHaveValue('#000000'); await expect(panel.getByLabel('Gradient map stop 2 color')).toHaveValue('#ffffff');
  await panel.getByRole('button', { name: 'Edit filter 1 Channel Mixer' }).click(); await panel.getByLabel('Mixer output channel').selectOption('red'); await panel.getByLabel('Mixer constant coefficient').fill('1.25');
  const sparseBefore = await current(); state = await mutate(() => panel.getByRole('button', { name: 'Apply filter changes' }).click()); const sparseFilter = state.layers[0].filters[0]; assert.equal(sparseFilter.id, sparseBefore.layers[0].filters[0].id); assert.deepEqual(sparseFilter.parameters, { monochrome: false, red: [0, 100, 0, 1.25], green: [0, 100, 0, 0], blue: [0, 0, 100, 0], gray: [21.26, 71.52, 7.22, 0] });
  assert.deepEqual(await pixels(), reference(reference(baseline, sparseFilter.parameters, 'channel_mixer'), { reverse: true, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] }, 'gradient_map'));
  documentId = sparseAdjustmentDoc.id; await page.getByLabel('Open document').selectOption(documentId); await settled(); const sparseMixerId = sparseAdjustmentGraph.layers[1].id, sparseMapId = sparseAdjustmentGraph.layers[2].id;
  await select(sparseMixerId); await expect(editor.getByLabel('Mixer red coefficient')).toHaveValue('0'); await expect(editor.getByLabel('Mixer green coefficient')).toHaveValue('100'); await editor.getByLabel('Mixer constant coefficient').fill('99');
  await select(sparseMapId); await expect(editor.getByLabel('Reverse gradient map')).toBeChecked(); await expect(editor.getByLabel('Gradient map stop 1 color')).toHaveValue('#000000'); await color(editor, 'Gradient map stop 2 color', '#abcdef');
  await select(sparseMixerId); await expect(editor.getByLabel('Mixer constant coefficient')).toHaveValue('0'); await expect(editor.getByLabel('Mixer green coefficient')).toHaveValue('100'); await editor.getByLabel('Mixer constant coefficient').fill('2.5');
  state = await mutate(() => editor.getByRole('button', { name: 'Update Channel Mixer', exact: true }).click()); assert.deepEqual(state.layers[1].parameters.red, [0, 100, 0, 2.5]); assert.deepEqual(state.layers[2].parameters, { reverse: true });
  await editor.getByLabel('Mixer constant coefficient').fill('70'); await undo(); await expect(editor.getByLabel('Mixer constant coefficient')).toHaveValue('0'); await expect(editor.getByLabel('Mixer green coefficient')).toHaveValue('100');
  await select(sparseMapId); await expect(editor.getByLabel('Gradient map stop 2 color')).toHaveValue('#ffffff');
  for (const request of requests.filter(r => ['add_adjustment', 'update_adjustment', 'add_layer_filter', 'update_layer_filter'].includes(r.command) && r.args.parameters)) { assert.ok(Number.isInteger(request.args.expectedRevision)); assert.equal(request.args.value, 0); }
  assert.deepEqual(errors, []); assert.equal(keyReads, 0); assert.equal(providerCalls, 0);
  checkpoint('source bytes/views remain exact; sparse imported rows and reverse-only parameters display retained settings plus native defaults and normalize on edit; reopening, revision guards, and 900px layout pass without provider/browser errors');
  await fs.writeFile(path.join(artifacts, 'color-mixer-browser-report.json'), JSON.stringify({ passed: checkpoints, keyReads, providerCalls, browserErrors: errors }, null, 2)); console.log(`Color mapping browser checks passed: ${checkpoints.length} workflows.`);
} catch (error) { await page.screenshot({ path: path.join(artifacts, 'color-mixer-browser-failure.png'), animations: 'disabled' }).catch(() => {}); console.error('Browser errors:', errors); console.error('Visible alerts:', await page.getByRole('alert').allTextContents()); throw error; }
finally { await browser.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
