import { chromium, expect as baseExpect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createCompanion } from '../server/index.mjs';

const expect = baseExpect.configure({ timeout: 12000 });
const artifacts = path.resolve('test-results');
await fs.mkdir(artifacts, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-eyedropper-ui-'));
let forbiddenCalls = 0;
const forbidden = async () => { forbiddenCalls++; throw Error('Eyedropper is local.'); };
const companion = await createCompanion({ dataDir, port: 0, getImageKey: forbidden, imageProvider: forbidden, segmentSubject: forbidden });
const native = companion.native, width = 64, height = 48;
const raw = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set(x < width / 2 ? [210, 30, 50, 255] : [20, 180, 90, 255], 4 * (y * width + x));
const png = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
const create = async name => (await native.execute('import_image', { name, data: png.toString('base64'), mimeType: 'image/png' })).document;
const first = await create('Eyedropper ownership'), other = await create('Other document');
const get = async id => (await native.execute('get_document', { documentId: id })).document;
const baseline = await get(first.id);
const browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { channel: 'chrome' } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [], requests = [], checks = [], outstanding = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('status of 400')) errors.push(m.text()); });
page.on('request', r => { if (r.url().endsWith('/api/command')) requests.push(r.postDataJSON()); });
await page.route('https://**', r => r.abort());
const swatch = () => page.getByLabel('Text foreground color', { exact: true });
const eyedropper = () => page.getByRole('button', { name: 'Eyedropper (I)', exact: true });
const settled = () => expect(page.locator('.save-status .spin')).toHaveCount(0);
async function open(doc) { await page.getByLabel('Open document').selectOption(doc.id); await settled(); }
async function click(x = 12, y = 12) {
  const box = await page.locator('.artboard').boundingBox();
  assert.ok(box); await page.mouse.click(box.x + (x + .5) * box.width / width, box.y + (y + .5) * box.height / height);
}
async function hold({ failure = false } = {}) {
  let release, started, finish, captured;
  const gate = new Promise(r => release = r), start = new Promise(r => started = r), done = new Promise(r => finish = r);
  let once = true;
  const handler = async route => {
    const args = route.request().postDataJSON();
    if (!once || args.command !== 'sample_color') { await route.fallback(); return; }
    once = false; captured = args;
    const response = await route.fetch(); assert.equal(response.status(), 200, await response.text());
    started(); await gate;
    if (failure) await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'SAMPLE_FAILED', message: 'Sample failed for verification.' } }) });
    else await route.fulfill({ response });
    finish();
  };
  await page.route('**/api/command', handler);
  const releaseRead = async () => { release(); await done; await page.unroute('**/api/command', handler); await page.waitForTimeout(150); };
  outstanding.push(release);
  return { start, release: releaseRead, captured: () => captured };
}
const check = message => { checks.push(message); console.log(`Verified: ${message}`); };
try {
  await page.goto(`http://127.0.0.1:${await companion.listen()}`, { waitUntil: 'networkidle' });
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Layers', exact: true }).click();
  await open(first); await eyedropper().click();
  const older = await hold(); await click(); await older.start;
  await click(48); await expect(swatch()).toHaveValue('#14b45a');
  await older.release(); await expect(swatch()).toHaveValue('#14b45a');
  assert.equal(Object.hasOwn(older.captured().args, 'expectedRevision'), false);
  check('The latest click wins when older native color reads arrive afterward; the existing read command contract remains unchanged');

  for (const failure of [false, true]) {
    const pending = await hold({ failure }); await click(); await pending.start;
    await swatch().fill('#123abc'); await pending.release();
    await expect(swatch()).toHaveValue('#123abc'); await expect(page.getByRole('alert')).toHaveCount(0);
  }
  check('Manual foreground choices survive late success and failure without obsolete errors');

  for (const change of [
    async () => { await page.getByRole('button', { name: 'Brush (B)', exact: true }).click(); await eyedropper().click(); },
    async () => { await open(other); await open(first); },
    async () => { await page.getByLabel('Eyedropper sample radius').fill('2'); await page.getByLabel('Eyedropper sample radius').fill('0'); },
  ]) {
    const pending = await hold(); await click(); await pending.start; await change(); await pending.release();
    await expect(swatch()).toHaveValue('#123abc');
  }
  check('Tool, document and sample-radius changes invalidate old reads even after returning to identical settings');

  let sampleAvailable = false;
  const statusHandler = async route => {
    const response = await route.fetch(), body = await response.json();
    if (!sampleAvailable) for (const backend of body.backends) backend.commands = backend.commands.filter(c => c !== 'sample_color');
    await route.fulfill({ response, json: body });
  };
  const unavailable = await hold(); await click(); await unavailable.start;
  await page.route('**/api/status', statusHandler); await expect(eyedropper()).toBeDisabled();
  sampleAvailable = true; await expect(eyedropper()).toBeEnabled();
  await unavailable.release(); await expect(swatch()).toHaveValue('#123abc');
  await page.unroute('**/api/status', statusHandler);
  check('Withdrawing and restoring the sampling capability cannot revive an abandoned read');

  const revisionRead = await hold(); await click(); await revisionRead.start;
  const changed = (await native.execute('add_adjustment', { documentId: first.id, expectedRevision: first.revision, kind: 'invert', value: 100 })).document;
  await expect(page.locator('.layer-row')).toHaveCount(2);
  await revisionRead.release(); await expect(swatch()).toHaveValue('#123abc');
  const failed = await hold({ failure: true }); await click(); await failed.start; await failed.release();
  await expect(page.getByRole('alert')).toContainText('Sample failed for verification.');
  await page.getByLabel('Dismiss notification').click();
  await click(); await expect(swatch()).toHaveValue('#2de1cd');
  assert.equal((await get(first.id)).revision, changed.revision);
  check('Unrelated revisions discard obsolete colors; current failures stay visible and a fresh click samples updated pixels');

  await page.getByRole('button', { name: 'Brush (B)', exact: true }).click();
  await expect(page.getByLabel('Brush color', { exact: true })).toHaveValue('#2de1cd');
  const final = await get(first.id);
  assert.equal(final.revision, baseline.revision + 1); assert.equal(final.history.length, baseline.history.length + 1);
  assert.deepEqual(final.layers[0], baseline.layers[0]);
  assert.deepEqual(await fs.readFile(path.join(native.assetsDir, final.layers[0].sourceAsset)), png);
  assert.ok(requests.every(r => ['get_document', 'get_preview', 'get_layer_preview', 'get_histogram', 'sample_color', 'list_documents', 'capabilities'].includes(r.command)), JSON.stringify([...new Set(requests.map(r => r.command))]));
  assert.deepEqual(errors, []); assert.equal(forbiddenCalls, 0);
  await fs.writeFile(path.join(artifacts, 'eyedropper-browser-report.json'), JSON.stringify({ passed: checks, browserErrors: errors, forbiddenCalls, colorReads: requests.filter(r => r.command === 'sample_color').length }, null, 2));
  console.log(`${checks.length} Eyedropper workflows passed.`);
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, 'eyedropper-browser-failure.png'), fullPage: true });
  throw error;
} finally {
  for (const release of outstanding) release();
  await browser.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true });
}
