import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createCompanion } from '../server/index.mjs';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-psd-ui-'));
const artifacts = path.resolve('test-results'); await fs.mkdir(artifacts, { recursive: true });
let keyReads = 0, providerCalls = 0;
const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => { keyReads++; return null; }, imageProvider: async () => { providerCalls++; throw Error('PSD export cannot generate images.'); } });
const width = 48, height = 32;
let supported = (await companion.native.execute('create_document', { name: 'Supported layered fixture', width, height, background: '#446688' })).document;
const supportedId = supported.id;
async function seed(command, args) { supported = (await companion.native.execute(command, { documentId: supportedId, ...args })).document; }
await seed('add_paint_layer', { name: 'Protected subject Ω' }); const subjectId = supported.layers.at(-1).id;
await seed('paint_stroke', { layerId: subjectId, tool: 'brush', points: [{ x: 17, y: 14 }, { x: 27, y: 17 }], size: 12, hardness: 1, opacity: 1, color: '#d67a42' });
await seed('transform_layer', { layerId: subjectId, x: 2, y: 1 });
await seed('set_layer_mask', { layerId: subjectId, mask: { shape: 'rectangle', x: 8, y: 4, width: 29, height: 24 } });
await seed('set_layer_protection', { layerId: subjectId, protected: true });
let unsupported = (await companion.native.execute('create_document', { name: 'Native features fixture', width, height, background: '#e0d0b0' })).document;
unsupported = (await companion.native.execute('add_text', { documentId: unsupported.id, name: 'Editable headline', text: 'AUTUMN', x: 2, y: 2, fontSize: 8, color: '#663355' })).document;
const titleId = unsupported.layers.at(-1).id;
unsupported = (await companion.native.execute('create_group', { documentId: unsupported.id, name: 'Headline group' })).document;
unsupported = (await companion.native.execute('move_layer', { documentId: unsupported.id, layerId: titleId, parentId: unsupported.layers.at(-1).id })).document;
const current = async id => (await companion.native.execute('get_document', { documentId: id })).document;
const composite = async id => sharp(Buffer.from((await companion.native.execute('get_preview', { documentId: id, maxWidth: width })).data, 'base64')).ensureAlpha().raw().toBuffer();
const url = `http://127.0.0.1:${await companion.listen()}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(12000);
const errors = [], requests = [], checks = [], downloads = [];
page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error' && !message.text().includes('409')) errors.push(message.text()); });
page.on('request', request => { if (request.url().includes('/api/psd/')) requests.push({ url: request.url(), method: request.method(), authenticated: Boolean(request.headers().authorization) }); });
page.on('download', download => downloads.push(download));
await page.route('https://**', route => route.abort());
const settled = async () => expect(page.locator('.save-status .spin')).toHaveCount(0);
const panel = page.getByRole('region', { name: 'Layered PSD compatibility' });
async function open(id) { await page.getByLabel('Open document').selectOption(id); await settled(); await page.getByRole('button', { name: 'Export', exact: true }).click(); await page.getByRole('button', { name: 'Layered PSD', exact: true }).click(); }
async function downloadPsd() { const event = page.waitForEvent('download'); await panel.getByRole('button', { name: 'Download layered PSD', exact: true }).click(); const download = await event; assert.match(download.suggestedFilename(), /\.psd$/); const file = path.join(dataDir, `download-${downloads.length}.psd`); await download.saveAs(file); return fs.readFile(file); }
function checkPsd(data, expected, layers) {
  assert.equal(data.toString('ascii', 0, 4), '8BPS'); assert.equal(data.readUInt16BE(4), 1); assert.equal(data.readUInt16BE(12), 3); assert.equal(data.readUInt32BE(14), height); assert.equal(data.readUInt32BE(18), width); assert.equal(data.readUInt16BE(22), 8); assert.equal(data.readUInt16BE(24), 3);
  let offset = 26; offset += 4 + data.readUInt32BE(offset); offset += 4 + data.readUInt32BE(offset);
  const sectionLength = data.readUInt32BE(offset); offset += 4; assert.equal(Math.abs(data.readInt16BE(offset + 4)), layers);
  offset += sectionLength; assert.equal(data.readUInt16BE(offset), 0); offset += 2;
  for (let channel = 0; channel < 3; channel++) for (let i = 0; i < width * height; i++) assert.equal(data[offset + channel * width * height + i], expected[i * 4 + channel]);
  assert.equal(offset + width * height * 3, data.length);
}
function checkpoint(message) { checks.push(message); console.log(`Verified: ${message}`); }
try {
  await page.goto(url, { waitUntil: 'networkidle' }); await expect(page.locator('.artboard img')).toBeVisible();
  await open(supportedId); await expect(panel).toContainText('Compatible with this PSD subset');
  await expect(panel).toContainText(`Inspected revision ${supported.revision}`); await expect(panel).toContainText('Protected subject Ω'); await expect(panel).toContainText('Prism pixel protection is not a PSD editing restriction');
  await expect(panel).toContainText('Current geometry is baked'); await expect(panel).toContainText('editable alpha8 raster mask'); await expect(panel).toContainText('Import compatible PSD files separately through File → Open PSD');
  const expected = await composite(supportedId), before = await current(supportedId);
  const data = await downloadPsd(); checkPsd(data, expected, 2); assert.deepEqual(await current(supportedId), before);
  const inspection = requests.find(request => request.url.includes(`/${supportedId}/inspect`)), exported = requests.find(request => request.url.includes(`/${supportedId}/export`));
  assert.ok(inspection && exported); assert.equal(new URL(inspection.url).searchParams.get('expectedRevision'), String(before.revision)); assert.equal(new URL(exported.url).searchParams.get('expectedRevision'), String(before.revision)); assert.ok(requests.every(request => request.method === 'GET' && request.authenticated));
  checkpoint('explicit limited PSD option, layer-specific warnings, authenticated revision-matched download, valid layers/header and exact saved composite with no project mutation');

  await page.getByRole('button', { name: 'Close dialog', exact: true }).click(); await open(unsupported.id);
  await expect(panel).toContainText('This document cannot be exported as layered PSD'); await expect(panel.locator('.psd-issues')).toContainText('Editable headline'); await expect(panel.locator('.psd-issues')).toContainText('Headline group'); await expect(panel.locator('.psd-issues')).toContainText('Ungroup this layer');
  await expect(panel.getByRole('button', { name: 'Download layered PSD' })).toBeDisabled(); assert.equal(downloads.length, 1); assert.deepEqual(await current(unsupported.id), unsupported);
  await page.setViewportSize({ width: 900, height: 900 }); await panel.locator('.psd-issues').scrollIntoViewIfNeeded(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(artifacts, 'psd-unsupported.png'), animations: 'disabled' });
  await panel.getByRole('button', { name: 'Download the full .prism project instead' }).click(); await expect(page.getByRole('button', { name: 'Download .prism project' })).toBeEnabled(); assert.deepEqual(await current(unsupported.id), unsupported);
  checkpoint('unsupported text/groups identify exact layers, block export without flattening, retain full .prism option and fit compact layout');

  await page.getByRole('button', { name: 'Close dialog', exact: true }).click(); await open(supportedId); await expect(panel).toContainText('Compatible with this PSD subset');
  let changedExternally, intercept = true;
  await page.route(`**/api/psd/${supportedId}/export?*`, async route => { if (intercept) { intercept = false; const original = await current(supportedId); changedExternally = (await companion.native.execute('set_layer', { documentId: supportedId, expectedRevision: original.revision, layerId: subjectId, name: 'Externally renamed subject' })).document; } await route.continue(); });
  await panel.getByRole('button', { name: 'Download layered PSD' }).click(); await expect(panel.getByRole('alert')).toContainText('The document changed'); await expect(panel.getByRole('button', { name: 'Download layered PSD' })).toBeDisabled(); assert.equal(downloads.length, 1); assert.deepEqual(await current(supportedId), changedExternally);
  await panel.getByRole('button', { name: 'Refresh compatibility' }).click(); await expect(panel).toContainText(`Inspected revision ${changedExternally.revision}`); await expect(panel).toContainText('Externally renamed subject'); await expect(panel.getByRole('alert')).toHaveCount(0);
  const recovered = await downloadPsd(); checkPsd(recovered, expected, 2); assert.deepEqual(await current(supportedId), changedExternally);
  await panel.locator('.psd-compatibility-state').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(artifacts, 'psd-compatible.png'), animations: 'disabled' });
  checkpoint('change between inspection/download rejects old revision, clears download eligibility and explicitly refreshes/reinspects before recovery');

  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  const fileInput = page.getByLabel('Import image file'); assert.ok(!(await fileInput.getAttribute('accept')).includes('psd'));
  assert.equal(keyReads, 0); assert.equal(providerCalls, 0); assert.deepEqual(errors, []);
  await fs.writeFile(path.join(artifacts, 'psd-browser-report.json'), JSON.stringify({ passed: checks, downloads: downloads.length, keyReads, providerCalls, browserErrors: errors }, null, 2));
  console.log(`PSD browser checks passed: ${checks.length} workflows.`);
} catch (error) { await page.screenshot({ path: path.join(artifacts, 'psd-failure.png'), animations: 'disabled' }).catch(() => {}); console.error('Alerts:', await page.getByRole('alert').allTextContents().catch(() => [])); throw error; }
finally { await browser.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
