import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCompanion } from '../server/index.mjs';

// Focused independent creation-lifecycle checks. The owner's browser suite
// already covers normal edit/reset, source coordinates, protection and layout.
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-text-ui-audit-'));
let keyReads = 0, providerCalls = 0;
const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => { keyReads++; return null; }, imageProvider: async () => { providerCalls++; assert.fail('Local text cannot invoke generation'); } });
const native = companion.native;
const a = (await native.execute('create_document', { name: 'Creation target A', width: 200, height: 180 })).document;
const b = (await native.execute('create_document', { name: 'Creation target B', width: 96, height: 120 })).document;
const get = async id => (await native.execute('get_document', { documentId: id })).document;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(12000);
const errors = [], requests = [], checkpoints = [];
let allowConflict = false;
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error' && !(allowConflict && message.text().includes('409'))) errors.push(message.text()); });
page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/command')) requests.push(request.postDataJSON()); });
await page.route('https://**', route => route.abort());
const dialog = page.getByRole('dialog');
const settled = () => expect(page.locator('.save-status .spin')).toHaveCount(0);
const submit = () => dialog.getByRole('button', { name: 'Add text layer', exact: true }).click();
try {
  await page.goto(`http://127.0.0.1:${await companion.listen()}`, { waitUntil: 'networkidle' });
  await page.getByLabel('Open document').selectOption(a.id); await settled();
  // The sidebar opens on Chat; Add text lives in the Layers tab's quick edits.
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Layers', exact: true }).click();
  await page.getByRole('button', { name: 'Add text', exact: true }).click();
  await dialog.getByLabel('Your text', { exact: true }).fill('Abandoned A draft');
  await dialog.getByLabel('Text tracking').fill('333');
  await dialog.getByLabel('Text line spacing mode').selectOption('explicit');
  await dialog.getByLabel('Text line spacing pixels').fill('55.25');
  const beforeA = await get(a.id), beforeB = await get(b.id), count = requests.filter(request => request.command === 'add_text').length;
  // A context change can arrive via workspace navigation while a local form
  // exists. Trigger the real select's handler; no React state is patched.
  await page.getByLabel('Open document').selectOption(b.id); await settled();
  await expect(dialog.getByLabel('Your text', { exact: true })).not.toHaveValue('Abandoned A draft');
  await expect(dialog.getByLabel('Text tracking')).toHaveValue('0');
  await expect(dialog.getByLabel('Text line spacing mode')).toHaveValue('auto');
  await expect(dialog.getByLabel('X position, px', { exact: true })).toHaveAttribute('max', '95');
  assert.equal(requests.filter(request => request.command === 'add_text').length, count);
  assert.deepEqual(await get(a.id), beforeA); assert.deepEqual(await get(b.id), beforeB);
  await dialog.getByLabel('Your text', { exact: true }).fill('Intentional B title');
  await dialog.getByLabel('X position, px', { exact: true }).fill('2');
  await dialog.getByLabel('Y position, px', { exact: true }).fill('2');
  await submit(); await expect(dialog).toHaveCount(0); await settled();
  const created = await get(b.id), add = requests.filter(request => request.command === 'add_text').at(-1);
  assert.equal(add.args.documentId, b.id); assert.equal(add.args.expectedRevision, beforeB.revision);
  assert.equal(created.layers.length, beforeB.layers.length + 1); assert.equal(created.layers.at(-1).text, 'Intentional B title');
  assert.equal(created.layers.at(-1).tracking, undefined); assert.equal(created.layers.at(-1).leading, undefined); assert.deepEqual(await get(a.id), beforeA);
  checkpoints.push('creation context switch discards abandoned text/spacing drafts without dispatch, clamps source bounds and creates only in the explicitly chosen document');

  await page.getByLabel('Open document').selectOption(a.id); await settled();
  await page.getByRole('button', { name: 'Add text', exact: true }).click();
  await dialog.getByLabel('Your text', { exact: true }).fill('Stale add must not publish');
  await dialog.getByLabel('Text tracking').fill('-225');
  await dialog.getByLabel('Text line spacing mode').selectOption('explicit');
  await dialog.getByLabel('Text line spacing pixels').fill('61.75');
  let release, received;
  const pause = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { received = resolve; });
  let once = true;
  await page.route('**/api/command', async route => { if (once && route.request().postDataJSON()?.command === 'add_text') { once = false; received(); await pause; } await route.continue(); });
  const before = await get(a.id); allowConflict = true; await submit(); await started;
  await expect(page.getByLabel('Open document')).toBeDisabled(); await expect(dialog.getByLabel('Text tracking')).toBeDisabled();
  const external = (await native.execute('set_layer', { documentId: a.id, expectedRevision: before.revision, layerId: before.layers[0].id, name: 'External change while adding text' })).document;
  release(); await expect(page.getByRole('alert')).toContainText('document changed before the text was saved'); await settled();
  assert.deepEqual(await get(a.id), external); assert.equal((await get(a.id)).layers.length, before.layers.length);
  await expect(dialog.getByLabel('Your text', { exact: true })).toHaveValue('Intentional B title');
  await expect(dialog.getByLabel('Text tracking')).toHaveValue('0'); await expect(dialog.getByLabel('Text line spacing mode')).toHaveValue('auto');
  await page.getByLabel('Dismiss notification').click(); await page.unroute('**/api/command'); allowConflict = false;
  await dialog.getByLabel('Your text', { exact: true }).fill('Explicit recovered title');
  await dialog.getByLabel('Text tracking').fill('75'); await submit(); await expect(dialog).toHaveCount(0); await settled();
  const recovered = await get(a.id), retry = requests.filter(request => request.command === 'add_text').at(-1);
  assert.equal(retry.args.expectedRevision, external.revision); assert.equal(recovered.layers.length, before.layers.length + 1);
  assert.equal(recovered.layers.at(-1).text, 'Explicit recovered title'); assert.equal(recovered.layers.at(-1).tracking, 75);
  assert.deepEqual(await get(b.id), created);
  checkpoints.push('paused stale add rejects without a layer or duplicate, preserves the external revision, discards stale drafts and succeeds only on explicit fresh-revision retry');
  assert.equal(keyReads, 0); assert.equal(providerCalls, 0); assert.deepEqual(errors, []);
  await fs.mkdir('test-results', { recursive: true });
  await fs.writeFile('test-results/text-spacing-ui-audit-report.json', JSON.stringify({ passed: checkpoints, keyReads, providerCalls, browserErrors: errors }, null, 2));
  console.log(`Independent text creation lifecycle audit: ${checkpoints.length} workflows passed.`);
} finally {
  await browser.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true });
}
