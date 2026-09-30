import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createCompanion } from '../server/index.mjs';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-psd-import-browser-'));
const artifacts = path.resolve('test-results'); await fs.mkdir(artifacts, { recursive: true });
const fixtureDir = path.resolve('tests/fixtures/psd-import');
const fixtures = JSON.parse(await fs.readFile(path.join(fixtureDir, 'expected.json'), 'utf8'));
const rawBytes = await fs.readFile(path.join(fixtureDir, 'flat-raw.psd')), rleBytes = await fs.readFile(path.join(fixtureDir, 'flat-rle.psd'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const profile = (await sharp(await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).withIccProfile('srgb').png().toBuffer()).metadata()).icc;
// Add one known ICC resource to an independently produced PSD; no production PSD writer is used.
function tagged(input, icc = profile) {
  const resourceAt = 26 + 4 + input.readUInt32BE(26), bytes = input.readUInt32BE(resourceAt), resource = Buffer.concat([Buffer.from('8BIM'), Buffer.from([4, 15, 0, 0]), u32(icc.length), icc, Buffer.alloc(icc.length % 2)]);
  return Buffer.concat([input.subarray(0, resourceAt), u32(bytes + resource.length), input.subarray(resourceAt + 4, resourceAt + 4 + bytes), resource, input.subarray(resourceAt + 4 + bytes)]);
}
const taggedBytes = tagged(rawBytes), unsupportedBytes = Buffer.from(taggedBytes);
let blendAt = -1; for (let i = 0; i < 3; i++) blendAt = unsupportedBytes.indexOf(Buffer.from('8BIMnorm'), blendAt + 1); assert.ok(blendAt >= 0); unsupportedBytes.write('mul ', blendAt + 4, 'ascii');
const unknownProfile = Buffer.from(profile); unknownProfile[unknownProfile.length - 1] ^= 1; const unknownBytes = tagged(rawBytes, unknownProfile);
const paths = { raw: path.join(fixtureDir, 'flat-raw.psd'), rle: path.join(fixtureDir, 'flat-rle.psd'), tagged: path.join(dataDir, 'Tagged independent original.psd'), unsupported: path.join(dataDir, 'Unsupported multiply layer.psd'), unknown: path.join(dataDir, 'Unknown embedded profile.psd') };
await fs.writeFile(paths.tagged, taggedBytes); await fs.writeFile(paths.unsupported, unsupportedBytes); await fs.writeFile(paths.unknown, unknownBytes);
let keyReads = 0, providerCalls = 0, companion, port;
async function start() { companion = await createCompanion({ dataDir, port: port || 0, getImageKey: async () => { keyReads++; return null; }, imageProvider: async () => { providerCalls++; throw Error('PSD import must stay local.'); } }); port = await companion.listen(); }
await start();
const existing = (await companion.native.execute('create_document', { name: 'Existing document stays intact', width: 9, height: 6, background: '#123456' })).document;
const browser = await chromium.launch({ headless: true, channel: 'chrome' }), page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(12000);
const errors = [], requests = [], checkpoints = [];
page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('request', request => { if (request.url().includes('/api/psd/') || request.url().includes('/api/projects/')) requests.push({ url: request.url(), method: request.method(), headers: request.headers(), bytes: request.postDataBuffer() }); });
await page.route('https://**', route => route.abort());
const dialog = page.getByRole('dialog');
const docs = async () => (await companion.native.execute('list_documents', {})).documents;
const current = async () => (await companion.native.execute('get_document', { documentId: await page.getByLabel('Open document').inputValue() })).document;
const pixels = async documentId => sharp(Buffer.from((await companion.native.execute('get_preview', { documentId, maxWidth: 32 })).data, 'base64')).ensureAlpha().raw().toBuffer();
const settled = async () => { await expect(page.locator('.save-status .spin')).toHaveCount(0); await expect(page.getByRole('alert')).toHaveCount(0); };
const menu = async () => page.getByRole('button', { name: 'File', exact: true }).click();
async function pick(file) { await menu(); const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: 'Open PSD', exact: true }).click(); await (await chooser).setFiles(file); await expect(dialog.getByRole('heading', { name: 'Open layered PSD.', exact: true })).toBeVisible(); }
async function compatible() { await expect(dialog.getByRole('status').filter({ hasText: 'Compatible with this PSD subset' })).toBeVisible(); await expect(dialog.getByRole('button', { name: 'Import as new document', exact: true })).toBeEnabled(); }
async function importReview() { const before = (await docs()).length; await dialog.getByRole('button', { name: 'Import as new document', exact: true }).click(); await expect(dialog).toHaveCount(0); await settled(); assert.equal((await docs()).length, before + 1); return current(); }
async function download(action, name) { const waiting = page.waitForEvent('download'); await action(); const result = await waiting, filename = path.join(dataDir, name); await result.saveAs(filename); return { bytes: await fs.readFile(filename), filename, suggested: result.suggestedFilename() }; }
function compose(fixture) {
  const out = Buffer.alloc(fixture.width * fixture.height * 4);
  for (const l of fixture.layers.filter(layer => layer.visible)) {
    const [left, top, right, bottom] = l.bounds;
    for (let y = 0; y < fixture.height; y++) for (let x = 0; x < fixture.width; x++) {
      if (x < left || x >= right || y < top || y >= bottom) continue;
      const source = ((y - top) * (right - left) + x - left) * 4, at = (y * fixture.width + x) * 4;
      const mask = !l.mask ? 255 : x >= l.maskBounds[0] && x < l.maskBounds[2] && y >= l.maskBounds[1] && y < l.maskBounds[3] ? l.mask[(y - l.maskBounds[1]) * (l.maskBounds[2] - l.maskBounds[0]) + x - l.maskBounds[0]] : l.maskDefault;
      const a = l.rgba[source + 3] * l.opacity * mask / (255 ** 3), b = out[at + 3] / 255, total = a + b * (1 - a);
      if (!total) continue;
      for (let c = 0; c < 3; c++) out[at + c] = Math.round((l.rgba[source + c] * a + out[at + c] * b * (1 - a)) / total); out[at + 3] = Math.round(total * 255);
    }
  }
  return out;
}
async function verifyDocument(document, expected, archiveBytes) {
  assert.equal(document.layers.length, expected.layers.length); assert.deepEqual(document.layers.map(layer => layer.name), expected.layers.map(layer => layer.name)); assert.equal(document.sourceDocument.asset, hash(archiveBytes)); assert.equal(document.sourceDocument.bytes, archiveBytes.length);
  for (const [index, layer] of document.layers.entries()) { const original = expected.layers[index]; assert.equal(layer.visible, original.visible); assert.equal(layer.opacity, original.opacity / 255); assert.equal(layer.type, 'raster'); assert.equal(layer.blendMode, 'normal'); assert.ok(!layer.protected); const png = await fs.readFile(path.join(companion.native.assetsDir, layer.sourceAsset)); assert.deepEqual(await sharp(png).ensureAlpha().raw().toBuffer(), Buffer.from(original.rgba)); }
  assert.deepEqual(await pixels(document.id), compose(expected));
}
function checkpoint(message) { checkpoints.push(message); console.log(`Verified: ${message}`); }
try {
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle' }); await settled(); const initialFiles = await fs.readdir(companion.native.assetsDir), initialCount = (await docs()).length;
  await pick(paths.raw); await expect(dialog.getByRole('button', { name: 'Import as new document', exact: true })).toBeDisabled(); await expect(dialog.getByLabel('Interpret untagged RGB as sRGB')).not.toBeChecked(); assert.equal((await docs()).length, initialCount); assert.deepEqual(await fs.readdir(companion.native.assetsDir), initialFiles);
  await dialog.getByLabel('Interpret untagged RGB as sRGB').check(); await compatible(); await dialog.getByLabel('Interpret untagged RGB as sRGB').uncheck(); await expect(dialog.getByRole('button', { name: 'Import as new document', exact: true })).toBeDisabled(); await expect(dialog.getByRole('status').filter({ hasText: 'This PSD cannot be imported' })).toBeVisible(); await dialog.getByLabel('Interpret untagged RGB as sRGB').check(); await compatible();
  await expect(dialog).toContainText('Hidden Ω 🌿'); await expect(dialog).toContainText('Raster pixels and transparency'); await expect(dialog).toContainText('Nothing is silently flattened');
  const beforeArchive = await download(() => dialog.getByRole('button', { name: 'Download original PSD', exact: true }).click(), 'before-import.psd'); assert.deepEqual(beforeArchive.bytes, rawBytes); assert.equal((await docs()).length, initialCount);
  await dialog.getByLabel('PSD document name').fill('Reviewed independent raw'); await page.setViewportSize({ width: 900, height: 1000 }); await dialog.getByRole('button', { name: 'Import as new document' }).scrollIntoViewIfNeeded(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await dialog.locator('.psd-import-review').evaluate(element => { element.scrollTop = 0; }); await page.screenshot({ path: path.join(artifacts, 'psd-import-compatible.png'), animations: 'disabled' });
  let imported = await importReview(); assert.equal(imported.name, 'Reviewed independent raw'); assert.equal(imported.canUndo, false); assert.equal(imported.history.length, 1); await verifyDocument(imported, fixtures[0], rawBytes);
  const rawId = imported.id; await page.locator(`.layer-row[data-layer-id="${imported.layers[0].id}"]`).click(); await page.getByLabel('Layer name', { exact: true }).fill('Renamed after import'); await page.getByLabel('Layer name', { exact: true }).press('Enter'); await expect.poll(async () => (await current()).layers[0].name).toBe('Renamed after import');
  await menu(); const afterArchive = await download(() => page.getByRole('button', { name: 'Download original PSD', exact: true }).click(), 'after-edit.psd'); assert.deepEqual(afterArchive.bytes, rawBytes); await settled();
  checkpoint('foreign raw PSD review is read-only, explicit untagged sRGB choice re-inspects, all layers/source RGBA and independently composed pixels import intact, and the original archive stays exact after editing');

  await pick(paths.unsupported); await expect(dialog.getByRole('status').filter({ hasText: 'This PSD cannot be imported' })).toBeVisible(); await expect(dialog.getByRole('button', { name: 'Import as new document' })).toBeDisabled(); await expect(dialog).toContainText('Independent alpha and offset mask'); await expect(dialog).toContainText(/normal|blend/i); await expect(dialog.getByLabel('Interpret untagged RGB as sRGB')).toHaveCount(0); const countBeforeReject = (await docs()).length;
  await expect(dialog.getByRole('heading', { name: 'Preserved editable properties' })).toHaveCount(0); if (await page.getByLabel('Dismiss notification').count()) await page.getByLabel('Dismiss notification').click(); await page.screenshot({ path: path.join(artifacts, 'psd-import-unsupported.png'), animations: 'disabled' }); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal((await docs()).length, countBeforeReject);
  await pick(paths.unknown); await expect(dialog.getByRole('status').filter({ hasText: 'This PSD cannot be imported' })).toBeVisible(); await expect(dialog.getByLabel('Interpret untagged RGB as sRGB')).toHaveCount(0); await expect(dialog.getByRole('button', { name: 'Import as new document' })).toBeDisabled(); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  let releaseInspection, startedInspection; const delayed = new Promise(resolve => releaseInspection = resolve), started = new Promise(resolve => startedInspection = resolve); let delayOnce = true;
  await page.route('**/api/psd/inspect-import?**', async route => { if (delayOnce) { delayOnce = false; startedInspection(); await delayed; } await route.continue().catch(() => {}); });
  await pick(paths.tagged); await started; await expect(dialog.getByText('Inspecting PSD…', { exact: true })).toBeVisible(); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); releaseInspection(); await expect(dialog).toHaveCount(0); assert.equal((await docs()).length, countBeforeReject); await page.unroute('**/api/psd/inspect-import?**');
  await pick(paths.tagged); await compatible(); await expect(dialog.getByLabel('Interpret untagged RGB as sRGB')).toHaveCount(0); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  checkpoint('named incompatible blend/profile reports block import without flattening; known sRGB needs no assumption; cancelling a delayed inspection cannot publish or replace the active document');

  // Transport fault fixtures exercise recovery states without publishing a document.
  let inspectionCount = 0, rejectCode = 'INSPECTION_STALE', latestReport;
  await page.route('**/api/psd/inspect-import?**', async route => { const response = await route.fetch(); latestReport = await response.json(); inspectionCount++; await route.fulfill({ response, json: { ...latestReport, issuesOmitted: 3, warningsOmitted: 7, comparison: { reference: 'stored-merged-rgb', comparedWith: 'native-flat-recomposition', differingChannels: inspectionCount === 1 ? 2 : 0, maxChannelDifference: inspectionCount === 1 ? 4 : 0, transparentPixels: 1, alphaComparable: false } } }); });
  await page.route('**/api/psd/import?**', async route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: rejectCode, message: 'Import rejected before publication.' }, ...(rejectCode === 'PSD_UNSUPPORTED' ? { report: { ...latestReport, supported: false, validation: 'rejected', issues: [{ code: 'LAYER_BLEND_UNSUPPORTED', message: 'This layer is outside the editable subset.', layerIndex: 2 }] } } : {}) }) }));
  await pick(paths.tagged); await compatible(); await expect(dialog).toContainText('3 additional unsupported issues'); await expect(dialog).toContainText('7 additional review warnings'); await expect(dialog).toContainText('2 RGB channel values'); await expect(dialog).toContainText('Transparency could not be compared');
  await dialog.getByRole('button', { name: 'Import as new document', exact: true }).click(); await expect(dialog.getByRole('button', { name: 'Inspect this file again', exact: true })).toBeEnabled(); await expect(dialog.getByRole('button', { name: 'Choose another PSD', exact: true })).toBeEnabled(); assert.equal((await docs()).length, countBeforeReject);
  await dialog.getByRole('button', { name: 'Inspect this file again', exact: true }).click(); await compatible(); assert.equal(inspectionCount, 2); await expect(dialog).toContainText('Transparency could not be compared'); await expect(dialog).not.toContainText('RGB channel values'); await expect(dialog.getByLabel('PSD document name')).toBeEnabled();
  rejectCode = 'PSD_UNSUPPORTED'; await dialog.getByRole('button', { name: 'Import as new document', exact: true }).click(); await expect(dialog.getByRole('button', { name: 'Choose another PSD', exact: true })).toBeEnabled(); await expect(dialog.getByRole('heading', { name: 'Preserved editable properties' })).toHaveCount(0); await expect(dialog).toContainText('Independent alpha and offset mask');
  const replacement = page.waitForEvent('filechooser'); await dialog.getByRole('button', { name: 'Choose another PSD', exact: true }).click(); await (await replacement).setFiles(paths.raw); await expect(dialog.getByLabel('Interpret untagged RGB as sRGB')).not.toBeChecked(); await expect(dialog.getByRole('button', { name: 'Import as new document', exact: true })).toBeDisabled(); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal((await docs()).length, countBeforeReject); await page.unroute('**/api/psd/import?**'); await page.unroute('**/api/psd/inspect-import?**');
  checkpoint('bounded omissions and RGB/transparency diagnostics stay visible; definitive stale/unsupported import failures permit review or replacement without publication or false preservation claims');

  let lost = false, laterRefusal = false; await page.route('**/api/psd/import?**', async route => { if (lost && !laterRefusal) { laterRefusal = true; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'PSD_UNSUPPORTED', message: 'A later retry was refused; the earlier response is still uncertain.' } }) }); return; } const response = await route.fetch(); if (!lost) { lost = true; assert.equal(response.status(), 200); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: 'The import succeeded but its reply was lost. Retry the same request.' } }) }); } else await route.fulfill({ response }); });
  await pick(paths.rle); await dialog.getByLabel('Interpret untagged RGB as sRGB').check(); await compatible(); const beforeLost = (await docs()).length; await dialog.getByRole('button', { name: 'Import as new document', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('reply was lost'); assert.equal((await docs()).length, beforeLost + 1); await expect(dialog.getByLabel('PSD document name')).toBeDisabled(); await expect(dialog.getByLabel('Interpret untagged RGB as sRGB')).toBeDisabled(); await expect(dialog.getByRole('button', { name: 'Choose another PSD' })).toBeDisabled();
  const lostRequest = requests.filter(r => new URL(r.url).pathname === '/api/psd/import').at(-1); await dialog.getByRole('button', { name: 'Close review' }).click(); await menu(); await page.getByRole('button', { name: 'Open PSD', exact: true }).click(); await expect(dialog.getByRole('button', { name: 'Retry same PSD import' })).toBeEnabled();
  await companion.close(); await start(); await dialog.getByRole('button', { name: 'Retry same PSD import' }).click(); await expect(dialog.getByRole('alert')).toContainText('earlier response is still uncertain'); await expect(dialog.getByRole('button', { name: 'Choose another PSD', exact: true })).toBeDisabled(); await expect(dialog.getByRole('button', { name: 'Inspect this file again', exact: true })).toHaveCount(0); await dialog.getByRole('button', { name: 'Retry same PSD import' }).click(); await expect(dialog).toHaveCount(0); await settled(); imported = await current(); await verifyDocument(imported, fixtures[1], rleBytes); assert.equal((await docs()).length, beforeLost + 1);
  const retryRequest = requests.filter(r => new URL(r.url).pathname === '/api/psd/import').at(-1); assert.equal(retryRequest.url, lostRequest.url); assert.equal(retryRequest.headers['x-prism-request-id'], lostRequest.headers['x-prism-request-id']); assert.equal(retryRequest.headers['x-prism-expected-sha256'], hash(rleBytes)); assert.equal(retryRequest.headers['x-prism-importer-version'], '1'); assert.deepEqual(retryRequest.bytes, lostRequest.bytes); await page.unroute('**/api/psd/import?**');
  checkpoint('foreign PackBits data imports intact; a lost successful reply freezes file/name/interpretation, survives dialog close and companion restart, and exact-ID retry recovers one document');

  await menu(); await page.getByRole('button', { name: 'Download project', exact: true }).click(); const bundle = await download(() => dialog.getByRole('button', { name: 'Download .prism project', exact: true }).click(), 'with-original.prism'); await expect(dialog).toHaveCount(0); await settled(); await page.getByLabel('Open Prism project file').setInputFiles(bundle.filename); await expect.poll(async () => (await current()).id).not.toBe(imported.id); await settled(); const portable = await current(); assert.deepEqual(portable.sourceDocument, imported.sourceDocument);
  await page.reload({ waitUntil: 'networkidle' }); await page.getByLabel('Open document').selectOption(portable.id); await settled(); await menu(); const restoredArchive = await download(() => page.getByRole('button', { name: 'Download original PSD', exact: true }).click(), 'portable-original.psd'); assert.deepEqual(restoredArchive.bytes, rleBytes); await settled();
  assert.deepEqual((await companion.native.execute('get_document', { documentId: existing.id })).document, existing); assert.equal((await companion.native.execute('get_document', { documentId: rawId })).document.layers[0].name, 'Renamed after import');
  const reads = requests.filter(r => new URL(r.url).pathname.endsWith('/original')); assert.ok(reads.length >= 2); for (const r of reads) { assert.ok(r.headers.authorization?.startsWith('Bearer ')); assert.ok(new URL(r.url).searchParams.has('expectedRevision')); }
  for (const r of requests.filter(r => r.method === 'POST' && new URL(r.url).pathname.startsWith('/api/psd/'))) assert.equal(r.headers['content-type'], 'image/vnd.adobe.photoshop');
  assert.equal(keyReads, 0); assert.equal(providerCalls, 0); assert.deepEqual(errors, []);
  checkpoint('portable .prism download/open and browser reload preserve the original PSD archive; authenticated binary transport, existing documents and compact layout remain correct without provider calls');
  await fs.writeFile(path.join(artifacts, 'psd-import-browser-report.json'), JSON.stringify({ passed: checkpoints, keyReads, providerCalls, browserErrors: errors }, null, 2)); console.log(`PSD import browser checks passed: ${checkpoints.length} workflows.`);
} catch (error) { await page.screenshot({ path: path.join(artifacts, 'psd-import-browser-failure.png'), animations: 'disabled' }).catch(() => {}); console.error('Browser errors:', errors); console.error('Visible alerts:', await page.getByRole('alert').allTextContents()); throw error; }
finally { await browser.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
