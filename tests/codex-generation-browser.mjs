import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { createCompanion } from '../server/index.mjs';

// Real browser + companion + saved handoff + native import. Synthetic PNGs
// stand in for the conversation's image tool; no API or CLI process is used.
const artifacts = path.resolve('test-results');
await fs.mkdir(artifacts, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-codex-browser-'));
let providerCalls = 0, keyChecks = 0;
const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => { keyChecks++; return null; }, imageProvider: async () => { providerCalls++; throw new Error('Conversation handoffs must never call the API provider.'); } });
const baseUrl = `http://127.0.0.1:${await companion.listen()}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
page.setDefaultTimeout(12000);
const errors = [], requests = [], submissions = [], checkpoints = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('request', request => {
  if (/^https?:/.test(request.url()) && !request.url().startsWith(baseUrl)) requests.push(request.url());
  if (request.method() === 'POST' && request.url() === `${baseUrl}/api/ai/jobs`) submissions.push(request.postDataJSON());
});
await page.route('https://**', route => route.abort());
const width = 160, height = 120;
const original = Buffer.alloc(width * height * 4), edited = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  original.set([(x * 3) % 256, (y * 5) % 256, (x + y) % 256, 255], (y * width + x) * 4);
  edited.set([35, 189, 112, 255], (y * width + x) * 4);
}
const image = await sharp(original, { raw: { width, height, channels: 4 } }).png().toBuffer();
const fill = await sharp(edited, { raw: { width, height, channels: 4 } }).png().toBuffer();
const headers = { 'content-type': 'application/json', authorization: `Bearer ${companion.token}` };
const dialog = page.getByRole('dialog');
async function json(route, body) {
  const response = await fetch(`${baseUrl}${route}`, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
}
async function current() { return (await companion.native.execute('get_document', { documentId: await page.getByLabel('Open document').inputValue() })).document; }
async function pixels() { const result = await companion.native.execute('get_preview', { documentId: (await current()).id, maxWidth: width }); return sharp(Buffer.from(result.data, 'base64')).ensureAlpha().raw().toBuffer(); }
async function openPanel() { await page.locator('.inspector-tabs').getByRole('button', { name: 'Chat', exact: true }).click(); await page.getByRole('button', { name: 'Open image generation', exact: true }).click(); await expect(dialog.getByLabel('Image generation provider')).toHaveValue('codex'); }
async function prepare(prompt) {
  await dialog.getByLabel('Image generation prompt').fill(prompt);
  await dialog.getByRole('button', { name: 'Prepare Codex request', exact: false }).click();
  await expect(dialog.locator('.job-state-pill.state-awaiting_image')).toBeVisible();
  const job = (await json('/api/ai/jobs')).jobs.find(item => item.prompt === prompt);
  assert.equal(job.status, 'awaiting_image'); assert.equal(job.provider, 'codex');
  return job;
}
function checkpoint(message) { checkpoints.push(message); console.log(`Verified: ${message}`); }

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await expect(page.locator('.artboard img')).toBeVisible();
  const initial = await current();
  await openPanel();
  await expect(dialog.getByLabel('Image generation model')).toHaveCount(0);
  await expect(dialog.getByLabel('Image generation quality')).toHaveCount(0);
  await expect(dialog.locator('.generation-configuration-note')).toHaveCount(0);
  assert.equal(keyChecks, 0, 'Default Codex status must not read API credentials');
  await dialog.getByLabel('Image generation provider').selectOption('openai');
  await expect(dialog.getByText('API not configured', { exact: true })).toBeVisible();
  assert.equal(keyChecks, 1, 'Only explicit API selection checks credentials');
  await dialog.getByLabel('Image generation prompt').fill('Optional API is unavailable');
  await expect(dialog.locator('.generation-submit')).toBeDisabled();
  await dialog.getByLabel('Image generation provider').selectOption('codex');
  await dialog.getByLabel('Generated result name').fill('Synthetic Codex handoff');
  const generated = await prepare('Synthetic colorful image from this conversation');
  assert.equal(submissions[0].provider, 'codex'); assert.equal(submissions[0].model, undefined); assert.equal(submissions[0].quality, undefined);
  assert.match(submissions[0].requestId, /^[a-f0-9-]{36}$/);
  assert.equal((await current()).id, initial.id); assert.equal(providerCalls, 0);
  const handoff = await json(`/api/ai/jobs/${generated.id}/handoff`);
  assert.equal(handoff.request.prompt, generated.prompt); assert.equal(handoff.image, undefined); assert.equal(handoff.mask, undefined);
  await dialog.getByRole('button', { name: 'Copy instruction for Codex', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Instruction copied', exact: true })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(copied.includes(generated.id)); assert.ok(copied.includes('prism_get_generation_handoff')); assert.ok(copied.includes('prism_complete_generation')); assert.ok(copied.includes('built-in image generation tool'));
  await page.setViewportSize({ width: 900, height: 1000 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await dialog.locator('.generation-handoff').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(artifacts, 'codex-generation-handoff.png'), animations: 'disabled' });
  await page.reload({ waitUntil: 'networkidle' }); await expect(page.locator('.artboard img')).toBeVisible();
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Chat', exact: true }).click(); await expect(page.getByRole('button', { name: 'Open image generation', exact: true }).locator('.generation-count')).toHaveText('1');
  await expect(page.getByRole('button', { name: 'Open image generation', exact: true }).locator('.spin')).toHaveCount(0);
  await openPanel(); await expect(dialog.locator('.job-state-pill.state-awaiting_image')).toBeVisible();
  checkpoint('Codex is default without an API key; saved waiting job, copyable instruction, reload and compact layout work without a provider');

  const completed = await json(`/api/ai/jobs/${generated.id}/complete`, { data: image.toString('base64') });
  assert.equal(completed.job.status, 'succeeded');
  await expect(dialog.locator('.job-state-pill.state-succeeded')).toBeVisible();
  await expect(dialog.getByAltText('Generated result preview')).toBeVisible();
  await expect(dialog.getByLabel('Codex image request instruction')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Open result', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByLabel('Open document')).toHaveValue(completed.job.documentId);
  assert.equal((await current()).name, 'Synthetic Codex handoff'); assert.deepEqual(await pixels(), original);
  checkpoint('returned PNG arrives through authenticated completion and automatic polling, opens a real document and preserves exact pixels');

  await openPanel(); await dialog.getByRole('button', { name: 'Selection fill', exact: true }).click();
  await dialog.getByLabel('Image generation prompt').fill('Fill the selected area with green');
  await expect(dialog.locator('.generation-submit')).toBeDisabled();
  await dialog.getByRole('button', { name: 'Select area', exact: true }).click();
  const board = await page.locator('.artboard').boundingBox(); assert.ok(board);
  await page.mouse.move(board.x + board.width * .25, board.y + board.height * .25); await page.mouse.down();
  await page.mouse.move(board.x + board.width * .75, board.y + board.height * .75, { steps: 10 }); await page.mouse.up();
  await expect.poll(async () => Boolean((await current()).selection)).toBe(true);
  await openPanel(); await dialog.getByRole('button', { name: 'Selection fill', exact: true }).click();
  const editJob = await prepare('Fill the selected area with green');
  const editHandoff = await json(`/api/ai/jobs/${editJob.id}/handoff`);
  assert.ok(editHandoff.image.data); assert.ok(editHandoff.mask.data); assert.equal(editHandoff.snapshot.documentId, completed.job.documentId);
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Layers', exact: true }).click(); await page.getByLabel('Layer name', { exact: true }).fill('Manual change retained'); await page.getByLabel('Layer name', { exact: true }).press('Enter');
  await expect.poll(async () => (await current()).layers[0].name).toBe('Manual change retained');
  const before = await current();
  const stale = await json(`/api/ai/jobs/${editJob.id}/complete`, { data: fill.toString('base64') });
  assert.equal(stale.job.status, 'ready'); assert.equal((await current()).layers.length, before.layers.length);
  await openPanel(); await expect(dialog.locator('.job-state-pill.state-ready')).toBeVisible();
  await expect(dialog.locator('.generation-ready-note')).toContainText('document changed');
  await dialog.getByRole('button', { name: 'Apply to latest document', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const after = await current(); assert.equal(after.layers.length, before.layers.length + 1); assert.equal(after.layers[0].name, 'Manual change retained');
  const rendered = await pixels();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    const expected = x >= 40 && x < 120 && y >= 30 && y < 90 ? edited : original;
    assert.deepEqual(rendered.subarray(offset, offset + 4), expected.subarray(offset, offset + 4), `pixel ${x},${y}`);
  }
  checkpoint('selection handoff captures image/mask; stale completion waits for explicit apply and all outside-selection pixels stay unchanged');

  await openPanel(); const cancelled = await prepare('Cancel this conversation image request');
  await dialog.getByRole('button', { name: 'Cancel request', exact: true }).click();
  await expect(dialog.locator('.job-state-pill.state-cancelled')).toBeVisible();
  assert.equal((await json(`/api/ai/jobs/${cancelled.id}`)).job.status, 'cancelled');
  await expect(dialog.getByLabel('Codex image request instruction')).toHaveCount(0);
  assert.equal(keyChecks, 1, 'Codex job creation, handoff, polling and completion do not reread credentials');
  assert.equal(providerCalls, 0); assert.deepEqual(requests, []); assert.deepEqual(errors, []);
  checkpoint('waiting request cancellation leaves the document intact, with zero provider calls, external requests or browser errors');
  await fs.writeFile(path.join(artifacts, 'codex-generation-browser-report.json'), JSON.stringify({ passed: checkpoints, providerCalls, explicitApiConfigurationChecks: keyChecks, paidApiCalls: 0, browserErrors: errors }, null, 2));
  console.log(`Codex generation browser checks passed (${checkpoints.length} workflows; synthetic image-tool output only).`);
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, 'codex-generation-browser-failure.png'), animations: 'disabled' }).catch(() => {});
  console.error('Visible alerts:', await page.getByRole('alert').allTextContents().catch(() => [])); throw error;
} finally { await browser.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
