import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { createCompanion } from '../server/index.mjs';

// The real HTTP service, job manager, native engine and UI run together. Only
// the paid provider is replaced; this test never reads production credentials.
const artifacts = path.resolve('test-results');
await fs.mkdir(artifacts, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-generation-browser-'));
const width = 320, height = 240;
const artwork = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#171d45"/><stop offset="1" stop-color="#a475a2"/></linearGradient></defs><path fill="url(#sky)" d="M0 0h320v240H0z"/><circle cx="219" cy="76" r="38" fill="#ffd194"/><path d="M0 171L90 104l77 69 42-37 111 52v52H0" fill="#4b456f"/><path d="M0 213l109-57 85 41 62-24 64 45v22H0" fill="#c57f78"/><path d="M0 231l123-28 94 25 103-8v20H0" fill="#e7ad8a"/></svg>`)).png().toBuffer();
const green = await sharp({ create: { width, height, channels: 4, background: '#21c789' } }).png().toBuffer();
const calls = [];
const imageProvider = (args) => new Promise((resolve, reject) => {
  const abort = () => reject(Object.assign(new Error('Cancelled fake request'), { code: 'AI_CANCELLED' }));
  args.signal.addEventListener('abort', abort, { once: true });
  calls.push({ args, resolve: (data = artwork) => { args.signal.removeEventListener('abort', abort); resolve({ data, mimeType: 'image/png', model: args.model, usage: { input_tokens: 12, output_tokens: 20 } }); }, reject });
});
const companion = await createCompanion({ dataDir, port: 0, imageProvider, getImageKey: async () => 'test-only-injected-key' });
let cancelDuringInstallation = false;
const install = companion.native.installGeneratedImage.bind(companion.native);
companion.native.installGeneratedImage = async (args) => {
  if (!cancelDuringInstallation) return install(args);
  cancelDuringInstallation = false;
  // Control this narrow race at the engine boundary: the image has been saved
  // but cancellation arrives before the new document or layer is committed.
  return new Promise((resolve, reject) => {
    args.signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled before installation'), { code: 'AI_CANCELLED' })), { once: true });
    void companion.generation.cancel(args.provenance.jobId);
  });
};
const baseUrl = `http://127.0.0.1:${await companion.listen()}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
page.setDefaultTimeout(12000);
const errors = [], submissions = [], externalRequests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('request', request => {
  if (request.method() === 'POST' && request.url() === `${baseUrl}/api/ai/jobs`) submissions.push(request.postDataJSON());
  if (/^https?:/.test(request.url()) && !request.url().startsWith(baseUrl)) externalRequests.push(request.url());
});
await page.route('https://**', route => route.abort());
const checkpoints = [];
const dialog = page.getByRole('dialog');
const headers = { 'content-type': 'application/json', authorization: `Bearer ${companion.token}` };
async function getJson(route) { const response = await fetch(`${baseUrl}${route}`, { headers }); assert.equal(response.status, 200); return response.json(); }
async function current() {
  const documentId = await page.getByLabel('Open document').inputValue();
  const response = await fetch(`${baseUrl}/api/command`, { method: 'POST', headers, body: JSON.stringify({ backend: 'native', command: 'get_document', args: { documentId } }) });
  const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result.result.document;
}
async function openPanel() { await page.locator('.inspector-tabs').getByRole('button', { name: 'Chat', exact: true }).click(); await page.getByRole('button', { name: 'Open image generation', exact: true }).click(); await dialog.getByLabel('Image generation provider').selectOption('openai'); await expect(dialog.getByText('OpenAI configured', { exact: true })).toBeVisible(); }
async function submit(prompt, button = 'Generate image') {
  await dialog.getByLabel('Image generation prompt').fill(prompt);
  await dialog.locator('.generation-submit').filter({ hasText: button }).click();
  await expect(dialog.getByRole('button', { name: 'Cancel request', exact: true })).toBeVisible();
}
async function jobState(prompt, status) {
  await expect.poll(async () => (await getJson('/api/ai/jobs')).jobs.find(job => job.prompt === prompt)?.status).toBe(status);
  await dialog.getByRole('button', { name: 'Refresh generation jobs', exact: true }).click();
  await expect(dialog.locator(`.job-state-pill.state-${status}`)).toBeVisible();
  return (await getJson('/api/ai/jobs')).jobs.find(job => job.prompt === prompt);
}
async function providerCall(index) { await expect.poll(() => calls.length).toBe(index + 1); return calls[index]; }
function checkpoint(name) { checkpoints.push(name); console.log(`Verified: ${name}`); }

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await expect(page.locator('.artboard img')).toBeVisible();
  const initial = await current();
  await openPanel();
  await expect(dialog.getByLabel('Image generation quality').locator('option')).toHaveCount(6);
  await dialog.getByLabel('Image generation model').selectOption('gpt-image-2');
  await expect(dialog.getByLabel('Image generation quality').locator('option')).toHaveCount(4);
  await dialog.getByLabel('Image generation model').selectOption('gpt-image-2.5-sunburst');
  await dialog.getByLabel('Generated result name').fill('Imagined landscape');
  await submit('A geometric landscape at dusk');
  const first = await providerCall(0);
  assert.equal(first.args.image, undefined); assert.equal(first.args.quality, 'medium');
  assert.equal(submissions[0].provider, 'openai'); assert.equal(submissions[0].documentId, undefined); assert.equal(submissions[0].expectedRevision, undefined);
  assert.match(submissions[0].requestId, /^[a-f0-9-]{36}$/);
  first.resolve();
  const created = await jobState('A geometric landscape at dusk', 'succeeded');
  await expect(dialog.getByAltText('Generated result preview')).toBeVisible();
  assert.notEqual(created.documentId, initial.id);
  await page.screenshot({ path: path.join(artifacts, 'generation-browser-result.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Open result', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Open document')).toHaveValue(created.documentId);
  let document = await current();
  assert.equal(document.name, 'Imagined landscape'); assert.equal(document.width, width); assert.equal(document.layers.length, 1);
  checkpoint('model qualities, authenticated generation, real new document and preview/open result');

  // Selection fill is gated, and the drawn selection becomes the provider mask.
  await openPanel();
  await dialog.getByRole('button', { name: 'Selection fill', exact: true }).click();
  await dialog.getByLabel('Image generation prompt').fill('Add a green meadow');
  await expect(dialog.locator('.generation-submit')).toBeDisabled();
  await dialog.getByRole('button', { name: 'Select area', exact: true }).click();
  const board = await page.locator('.artboard').boundingBox();
  assert.ok(board);
  await page.mouse.move(board.x + board.width * .1, board.y + board.height * .1);
  await page.mouse.down();
  await page.mouse.move(board.x + board.width * .5, board.y + board.height * .8, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => Boolean((await current()).selection)).toBe(true);
  await openPanel();
  await dialog.getByRole('button', { name: 'Selection fill', exact: true }).click();
  await submit('Add a green meadow', 'Generate selection fill');
  const selected = await providerCall(1);
  assert.ok(Buffer.isBuffer(selected.args.image)); assert.ok(Buffer.isBuffer(selected.args.mask));
  assert.equal(submissions[1].documentId, created.documentId); assert.equal(submissions[1].scope, 'selection');
  const mask = await sharp(selected.args.mask).ensureAlpha().raw().toBuffer();
  assert.equal(mask[(120 * width + 80) * 4 + 3], 0); assert.equal(mask[(120 * width + 280) * 4 + 3], 255);
  selected.resolve(green);
  await jobState('Add a green meadow', 'succeeded');
  await dialog.getByRole('button', { name: 'Open result', exact: true }).click();
  await expect.poll(async () => (await current()).layers.length).toBe(2);
  const render = await companion.native.execute('get_preview', { documentId: created.documentId, maxWidth: width });
  const pixels = await sharp(Buffer.from(render.data, 'base64')).ensureAlpha().raw().toBuffer();
  const original = await sharp(artwork).ensureAlpha().raw().toBuffer();
  assert.deepEqual([...pixels.subarray((120 * width + 80) * 4, (120 * width + 80) * 4 + 4)], [33, 199, 137, 255]);
  assert.deepEqual(pixels.subarray((120 * width + 280) * 4, (120 * width + 280) * 4 + 4), original.subarray((120 * width + 280) * 4, (120 * width + 280) * 4 + 4));
  checkpoint('selection guard, real captured provider mask and pixel-limited result layer');

  // Work continues while the panel is closed, and changed documents retain
  // their results until explicit application with the latest revision.
  await openPanel();
  await dialog.getByRole('button', { name: 'Edit canvas', exact: true }).click();
  await submit('Reimagine the entire composition', 'Generate edit');
  const stale = await providerCall(2);
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Layers', exact: true }).click(); await page.getByLabel('Layer name', { exact: true }).fill('Preserved manual edit');
  await page.getByLabel('Layer name', { exact: true }).press('Enter');
  await expect.poll(async () => (await current()).layers.at(-1).name).toBe('Preserved manual edit');
  document = await current();
  stale.resolve();
  await expect.poll(async () => (await getJson('/api/ai/jobs')).jobs.find(job => job.prompt === 'Reimagine the entire composition')?.status).toBe('ready');
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Chat', exact: true }).click(); await expect(page.getByRole('button', { name: 'Open image generation', exact: true }).locator('.generation-count')).toHaveText('1');
  await openPanel();
  await expect(dialog.getByRole('button', { name: 'Apply to latest document', exact: true })).toBeVisible();
  await expect(dialog.locator('.generation-ready-note')).toContainText('document changed');
  assert.equal((await current()).layers.length, document.layers.length);
  await page.screenshot({ path: path.join(artifacts, 'generation-browser-retained.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Apply to latest document', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await current()).layers.length).toBe(document.layers.length + 1);
  assert.equal(calls.length, 3);
  checkpoint('background polling, revision-conflict retention and explicit apply without regeneration');

  await openPanel();
  await submit('Cancelled test image');
  const cancelled = await providerCall(3);
  await dialog.getByRole('button', { name: 'Cancel request', exact: true }).click();
  await jobState('Cancelled test image', 'cancelled');
  assert.equal(cancelled.args.signal.aborted, true);
  assert.equal((await current()).layers.length, document.layers.length + 1);
  assert.equal(calls.length, 4); assert.equal(submissions.length, 4);
  checkpoint('cancellation aborts the provider and adds no output layer');

  await submit('A saved image returned before cancellation');
  const savedCancellation = await providerCall(4);
  cancelDuringInstallation = true;
  savedCancellation.resolve();
  const retainedCancelled = await jobState('A saved image returned before cancellation', 'cancelled');
  assert.equal(retainedCancelled.outputAvailable, true);
  await expect(dialog.locator('.generation-ready-note')).toContainText('makes no new provider request');
  await dialog.getByRole('button', { name: 'Create document from result', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await current()).id).not.toBe(created.documentId);
  assert.equal(calls.length, 5); assert.equal(submissions.length, 5);
  checkpoint('a cancelled request with saved output can be recovered without a second provider call');

  await openPanel();
  await page.setViewportSize({ width: 900, height: 850 });
  await expect(dialog.getByLabel('Image generation prompt')).toBeVisible();
  await expect(dialog.locator('.generation-submit')).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(artifacts, 'generation-browser-compact.png'), fullPage: true });
  assert.deepEqual(externalRequests, []); assert.deepEqual(errors, []);
  checkpoint('compact layout, no browser errors and no external network requests');
  await fs.writeFile(path.join(artifacts, 'generation-browser-report.json'), JSON.stringify({ passed: checkpoints, providerCalls: calls.length, paidApiCalls: 0, browserErrors: errors }, null, 2));
  console.log(`Generation browser checks passed (${checkpoints.length} workflows; no paid API calls).`);
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, 'generation-browser-failure.png'), fullPage: true }).catch(() => {});
  console.error('Visible alerts:', await page.getByRole('alert').allTextContents().catch(() => []));
  throw error;
} finally {
  await browser.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true });
}
