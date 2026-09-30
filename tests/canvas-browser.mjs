import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { createCompanion } from '../server/index.mjs';
import { maskCoverage } from '../server/masks.mjs';

const artifacts = path.resolve('test-results');
await fs.mkdir(artifacts, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-canvas-browser-'));
const width = 49, height = 37, original = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) original.set([x * 5, y * 6, (x + y) * 2, 255], (y * width + x) * 4);
const fixture = path.join(dataDir, 'canvas-pixel-fixture.png');
await sharp(original, { raw: { width, height, channels: 4 } }).png().toFile(fixture);
const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => null, imageProvider: async () => { throw new Error('Canvas bounds tests must not invoke an image provider.'); } });
const baseUrl = `http://127.0.0.1:${await companion.listen()}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
page.setDefaultTimeout(12000);
const errors = [], requests = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/command')) requests.push(request.postDataJSON()); });
await page.route('https://**', route => route.abort());
const dialog = page.getByRole('dialog');
const current = async () => (await companion.native.execute('get_document', { documentId: await page.getByLabel('Open document').inputValue() })).document;
const pixels = async () => { const document = await current(); const result = await companion.native.execute('get_preview', { documentId: document.id, maxWidth: document.width }); return sharp(Buffer.from(result.data, 'base64')).ensureAlpha().raw().toBuffer(); };
async function mutate(action, predicate = () => true) { const before = await current(); await action(); await expect.poll(async () => { const document = await current(); return document.revision > before.revision && predicate(document); }).toBe(true); await expect(page.locator('.save-status .spin')).toHaveCount(0); await expect(page.getByRole('alert')).toHaveCount(0); return current(); }
async function openResize() { await page.locator('.inspector-tabs').getByRole('button', { name: 'Layers', exact: true }).click(); await page.locator('.quick-grid').getByRole('button', { name: 'Resize', exact: true }).click(); await expect(dialog.getByRole('button', { name: 'Scale image', exact: true })).toBeVisible(); }
function checkpoint(message) { checks.push(message); console.log(`Verified: ${message}`); }

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await expect(page.locator('.artboard img')).toBeVisible();
  await page.getByLabel('Import image file').setInputFiles(fixture);
  await expect.poll(async () => (await current()).name).toBe('canvas-pixel-fixture.png');
  assert.ok((await pixels()).equals(original));
  await openResize();
  await dialog.getByRole('button', { name: 'Canvas bounds', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Anchor center', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByRole('group', { name: 'Canvas anchor', exact: true }).getByRole('button')).toHaveCount(9);
  await expect(dialog.getByLabel('Select added space for AI fill')).toBeDisabled();
  await dialog.getByLabel('Width, px', { exact: true }).fill('74');
  await dialog.getByLabel('Height, px', { exact: true }).fill('62');
  await dialog.getByRole('button', { name: 'Anchor bottom right', exact: true }).click();
  await expect(dialog.getByLabel('Select added space for AI fill')).toBeChecked();
  await page.screenshot({ path: path.join(artifacts, 'canvas-browser-expansion-preview.png'), fullPage: true });
  let document = await mutate(() => dialog.getByRole('button', { name: 'Apply canvas bounds', exact: true }).click(), doc => doc.width === 74 && doc.height === 62);
  const expanded = await pixels();
  for (let y = 0; y < 62; y++) for (let x = 0; x < 74; x++) {
    const offset = (y * 74 + x) * 4;
    if (x >= 25 && y >= 25) {
      const sourceOffset = ((y - 25) * width + x - 25) * 4;
      assert.ok(expanded.subarray(offset, offset + 4).equals(original.subarray(sourceOffset, sourceOffset + 4)), `Original pixel changed at ${x},${y}`);
    } else assert.deepEqual([...expanded.subarray(offset, offset + 4)], [0, 0, 0, 0]);
  }
  const coverage = maskCoverage(document.selection);
  assert.equal(coverage(0, 0), 1); assert.equal(coverage(73, 0), 1); assert.equal(coverage(0, 61), 1); assert.equal(coverage(30, 30), 0); assert.equal(coverage(73, 61), 0);
  const expansion = requests.findLast(request => request.command === 'resize_canvas');
  assert.equal(expansion.args.anchor, 'bottom-right'); assert.equal(expansion.args.selectPadding, true);
  await expect(page.locator('.canvas-selection')).toHaveCount(1);
  await page.screenshot({ path: path.join(artifacts, 'canvas-browser-expanded.png'), fullPage: true });
  checkpoint('nine anchors, transparent expansion, byte-exact shifted pixels and automatic padding-only selection');

  await openResize();
  await dialog.getByRole('button', { name: 'Canvas bounds', exact: true }).click();
  await dialog.getByLabel('Width, px', { exact: true }).fill(String(width));
  await dialog.getByLabel('Height, px', { exact: true }).fill(String(height));
  await dialog.getByRole('button', { name: 'Anchor bottom right', exact: true }).click();
  await expect(dialog.getByLabel('Select added space for AI fill')).toBeDisabled();
  await mutate(() => dialog.getByRole('button', { name: 'Apply canvas bounds', exact: true }).click(), doc => doc.width === width && doc.height === height);
  assert.ok((await pixels()).equals(original));
  assert.equal(requests.findLast(request => request.command === 'resize_canvas').args.selectPadding, undefined);
  await mutate(() => page.getByRole('button', { name: 'Undo (⌘Z)', exact: true }).click(), doc => doc.width === 74);
  assert.ok((await pixels()).equals(expanded));
  await mutate(() => page.getByRole('button', { name: 'Redo (⇧⌘Z)', exact: true }).click(), doc => doc.width === width);
  assert.ok((await pixels()).equals(original));
  checkpoint('shrinking crops reversibly, never sends a padding-selection request, and undo/redo restore exact pixels');

  await openResize();
  await dialog.getByLabel('Width, px', { exact: true }).fill('98');
  await dialog.getByRole('button', { name: 'Match original aspect ratio', exact: true }).click();
  await expect(dialog.getByLabel('Height, px', { exact: true })).toHaveValue('74');
  await mutate(() => dialog.getByRole('button', { name: 'Apply dimensions', exact: true }).click(), doc => doc.width === 98 && doc.height === 74);
  const scale = requests.findLast(request => request.command === 'resize_document');
  assert.equal(scale.args.anchor, undefined); assert.equal(scale.args.selectPadding, undefined);
  checkpoint('Scale image retains the existing resampling command and aspect-ratio helper');

  await page.setViewportSize({ width: 900, height: 850 });
  await openResize();
  await dialog.getByRole('button', { name: 'Canvas bounds', exact: true }).click();
  await dialog.getByLabel('Width, px', { exact: true }).fill('8192');
  await dialog.getByLabel('Height, px', { exact: true }).fill('8192');
  await expect(dialog.getByRole('button', { name: 'Apply canvas bounds', exact: true })).toBeDisabled();
  await expect(dialog.getByText('Use dimensions from 1–8,192 px, up to 24 million pixels total.', { exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  checkpoint('oversized canvases are gated before mutation; compact layout has no overflow or browser errors');
  await fs.writeFile(path.join(artifacts, 'canvas-browser-report.json'), JSON.stringify({ passed: checks, paidApiCalls: 0, browserErrors: errors }, null, 2));
  console.log(`Canvas browser checks passed (${checks.length} workflows; no paid API calls).`);
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, 'canvas-browser-failure.png'), fullPage: true }).catch(() => {});
  console.error('Visible alerts:', await page.getByRole('alert').allTextContents().catch(() => [])); throw error;
} finally { await browser.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
