import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createCompanion } from '../server/index.mjs';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-isolated-groups-browser-'));
const artifacts = path.resolve('test-results'); await fs.mkdir(artifacts, { recursive: true });
let keyReads = 0, providerCalls = 0;
const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => { keyReads++; return null; }, imageProvider: async () => { providerCalls++; throw Error('Groups must not generate images.'); } });
const width = 32, height = 24, background = [80, 120, 160];
let document = (await companion.native.execute('create_document', { name: 'Isolated adjustment fixture', width, height, background: '#5078a0' })).document;
const documentId = document.id;
const seed = async (command, args) => { document = (await companion.native.execute(command, { documentId, ...args })).document; return document; };
await seed('add_shape', { name: 'Colored subject', shape: 'rectangle', x: 8, y: 6, width: 12, height: 10, fill: '#c04020' }); const subjectId = document.layers.at(-1).id;
await seed('add_adjustment', { kind: 'invert', value: 100 }); const adjustmentId = document.layers.at(-1).id;
await seed('group_layers', { layerIds: [subjectId, adjustmentId], name: 'Adjustment group' }); const groupId = document.layers.find(layer => layer.type === 'group').id;
await seed('create_group', { name: 'Other isolated group' }); const otherId = document.layers.at(-1).id;
await seed('set_group_compositing', { layerId: otherId, mode: 'isolated' });
await seed('select_region', { shape: 'rectangle', x: 0, y: 0, width: 14, height });
const secondDocument = (await companion.native.execute('create_document', { name: 'Placement destination', width, height, background: '#ffffff' })).document;
const baseUrl = `http://127.0.0.1:${await companion.listen()}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(12000);
const errors = [], checkpoints = [], requests = [];
page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/command')) requests.push(request.postDataJSON()); });
await page.route('https://**', route => route.abort());
const current = async () => (await companion.native.execute('get_document', { documentId })).document;
const settled = async () => { await expect(page.locator('.save-status .spin')).toHaveCount(0); await expect(page.getByRole('alert')).toHaveCount(0); };
async function mutate(action) { await settled(); const before = await current(); await action(); await expect.poll(async () => (await current()).revision).toBeGreaterThan(before.revision); await settled(); const after = await current(); assert.equal(after.revision, before.revision + 1); return after; }
const undo = () => mutate(() => page.getByRole('button', { name: 'Undo (⌘Z)', exact: true }).click());
const select = async id => { await page.locator(`.layer-row[data-layer-id="${id}"]`).click(); await expect(page.locator(`.layer-row[data-layer-id="${id}"]`)).toHaveClass(/selected/); };
const group = () => page.getByLabel('Group compositing', { exact: true });
async function pixels() { return sharp(Buffer.from((await companion.native.execute('get_preview', { documentId, maxWidth: width })).data, 'base64')).ensureAlpha().raw().toBuffer(); }
const sample = (data, x, y) => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
const near = (actual, expected) => expected.forEach((value, index) => assert.ok(Math.abs(actual[index] - value) <= 1, `${actual} should approximate ${expected}`));
function checkpoint(message) { checkpoints.push(message); console.log(`Verified: ${message}`); }
try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' }); await page.getByLabel('Open document').selectOption(documentId); await page.locator(".inspector-tabs").getByRole("button", { name: "Layers", exact: true }).click(); await expect(page.locator('.artboard img')).toBeVisible(); await settled(); await select(groupId);
  assert.equal(await group().locator('option').count(), 28); await expect(group().locator('option[value="isolated:soft_light"]')).toHaveCount(1); await expect(group()).toHaveValue('pass-through');
  const pass = await pixels(); assert.deepEqual(sample(pass, 2, 2), [175, 135, 95, 255]); assert.deepEqual(sample(pass, 10, 10), [63, 191, 223, 255]);
  const initial = await current(); await mutate(() => group().selectOption('isolated:normal'));
  let isolated = await pixels(); assert.deepEqual(sample(isolated, 2, 2), [...background, 255]); assert.deepEqual(sample(isolated, 10, 10), [63, 191, 223, 255]);
  await expect(page.locator('.group-compositing')).toContainText('Adjustments stay inside this group'); await expect(page.getByRole('button', { name: 'Ungroup', exact: true })).toBeDisabled();
  await undo(); assert.deepEqual(await pixels(), pass); assert.deepEqual((await current()).layers, initial.layers);
  await mutate(() => group().selectOption('isolated:normal'));
  checkpoint('Pass through and all 27 isolated blends are exposed; an actual grouped invert changes the outside backdrop only in Pass through, with exact undo');

  await mutate(() => group().selectOption('isolated:multiply')); let multiplied = await pixels();
  near(sample(multiplied, 10, 10), [20, 90, 140, 255]); assert.deepEqual(sample(multiplied, 2, 2), [...background, 255]);
  await select(subjectId); await expect(page.getByLabel('Protect original pixels', { exact: true })).toBeDisabled(); await expect(page.locator('.cutout-properties')).toContainText('normal blending'); await select(groupId);
  await mutate(async () => { await page.getByLabel('Layer opacity', { exact: true }).fill('50'); await page.getByLabel('Layer opacity', { exact: true }).press('Enter'); });
  let translucent = await pixels(); near(sample(translucent, 10, 10), [50, 105, 150, 255]);
  await mutate(() => page.getByRole('button', { name: 'Mask from selection', exact: true }).click());
  const masked = await pixels(); near(sample(masked, 10, 10), [50, 105, 150, 255]); assert.deepEqual(sample(masked, 16, 10), [...background, 255]);
  await undo(); assert.deepEqual(await pixels(), translucent); await undo(); assert.deepEqual(await pixels(), multiplied); await mutate(() => group().selectOption('isolated:normal'));
  checkpoint('group multiply, opacity and mask each affect real composite pixels once; undo restores each state and nonnormal ancestry blocks protection');

  await mutate(() => page.getByRole('button', { name: 'New group', exact: true }).click());
  const nested = (await current()).layers.find(layer => layer.type === 'group' && layer.parentId === groupId); assert.ok(nested);
  await select(subjectId); await mutate(() => page.getByLabel('Protect original pixels', { exact: true }).click()); await expect(page.getByLabel('Protect original pixels', { exact: true })).toBeChecked(); const protectedPixels = await pixels();
  await expect(page.getByLabel('Move to group').locator('option[value=""]')).toHaveJSProperty('disabled', true); await expect(page.getByLabel('Move to group').locator(`option[value="${otherId}"]`)).toHaveJSProperty('disabled', true); await expect(page.getByLabel('Move to group').locator(`option[value="${nested.id}"]`)).toHaveJSProperty('disabled', false);
  await page.getByLabel('Move to group').selectOption(nested.id); await mutate(() => page.getByRole('button', { name: 'Move to selected group', exact: true }).click()); assert.equal((await current()).layers.find(layer => layer.id === subjectId).parentId, nested.id); assert.deepEqual(await pixels(), protectedPixels);
  await select(groupId); await expect(group()).toBeDisabled(); await expect(page.locator('.group-compositing')).toContainText('Protected descendants lock group compositing'); await expect(page.getByLabel('Layer opacity', { exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: 'Delete selected layer', exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: 'Ungroup', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Select layers', exact: true }).click(); await page.getByLabel('Select layer Colored subject', { exact: true }).check(); await expect(page.getByRole('button', { name: 'Align layers left', exact: true })).toBeDisabled(); await expect(page.locator('.arrangement-eligibility')).toContainText('outside isolated groups'); await page.getByRole('button', { name: 'Cancel selection', exact: true }).click();
  checkpoint('protected descendants lock mode/opacity/deletion, cannot cross isolation boundaries, can move within the same context, and cannot be arranged through isolation');

  const persisted = await current(), persistedPixels = await pixels(); await page.reload({ waitUntil: 'networkidle' }); await page.getByLabel('Open document').selectOption(documentId); await page.locator(".inspector-tabs").getByRole("button", { name: "Layers", exact: true }).click(); await settled(); await select(groupId); assert.deepEqual((await current()).layers, persisted.layers); assert.deepEqual(await pixels(), persistedPixels); await expect(group()).toHaveValue('isolated:normal');
  await page.setViewportSize({ width: 900, height: 1000 }); for (let step = 0; step < 20; step++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click(); await expect(page.locator('.zoom-value')).toHaveText('300%'); await page.locator('.layer-group-properties').scrollIntoViewIfNeeded(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.equal(await page.locator('.inspector').evaluate(element => element.scrollWidth <= element.clientWidth), true); await page.screenshot({ path: path.join(artifacts, 'isolated-group-controls.png'), animations: 'disabled' });
  await page.getByLabel('Open document').selectOption(secondDocument.id); await settled(); await page.getByRole('button', { name: 'Open Cutouts', exact: true }).click(); const dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: 'Place in this document', exact: true }).click(); await dialog.getByLabel('Placement source document').selectOption(documentId); await dialog.getByLabel('Placement source layer').selectOption(subjectId); await expect(dialog.getByRole('button', { name: 'Place layer', exact: true })).toBeDisabled(); await expect(dialog).toContainText('isolated, masked or faded group');
  for (const request of requests.filter(request => request.command === 'set_group_compositing')) { assert.equal(request.backend, 'native'); assert.equal(request.args.documentId, documentId); assert.ok(Number.isInteger(request.args.expectedRevision)); }
  assert.equal(keyReads, 0); assert.equal(providerCalls, 0); assert.deepEqual(errors, []);
  checkpoint('isolation/blending persist on reopen, compact inspector has no overflow, source placement is blocked with guidance and no browser errors or AI calls occur');
  await fs.writeFile(path.join(artifacts, 'isolated-groups-browser-report.json'), JSON.stringify({ passed: checkpoints, keyReads, providerCalls, browserErrors: errors }, null, 2)); console.log(`Isolated group browser checks passed: ${checkpoints.length} workflows.`);
} catch (error) { await page.screenshot({ path: path.join(artifacts, 'isolated-groups-browser-failure.png'), animations: 'disabled' }).catch(() => {}); console.error('Visible alerts:', await page.getByRole('alert').allTextContents().catch(() => [])); throw error; }
finally { await browser.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
