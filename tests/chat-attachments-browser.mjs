import { chromium, expect as baseExpect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createCompanion } from '../server/index.mjs';

// Real browser -> imports -> chat manager -> scoped tools -> native previews.
// The injected agent follows authored plans by call order, never keywords.
// All input images are local fixtures. No model, CLI or provider is contacted.
const startedAt = Date.now(), expect = baseExpect.configure({ timeout: 20000 });
const artifacts = path.resolve('test-results'), dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-chat-attachments-'));
await fs.mkdir(artifacts, { recursive: true });
const photo = await fs.readFile('tests/fixtures/tonal-color/astronaut.png');
const swatch = Buffer.alloc(64 * 48 * 4);
for (let i = 0; i < swatch.length; i += 4) swatch.set([28, 89, 164, 255], i);
const encode = () => sharp(swatch, { raw: { width: 64, height: 48, channels: 4 } });
const png = await encode().png().toBuffer(), jpeg = await encode().jpeg({ quality: 90 }).toBuffer();
const webp = await encode().webp({ lossless: true }).toBuffer(), tiff = await encode().tiff({ compression: 'lzw' }).toBuffer();
const file = (name, mimeType, buffer) => ({ name, mimeType, buffer });
const fixtures = [file('portrait.png', 'image/png', photo), file('reference.jpg', 'image/jpeg', jpeg), file('palette.webp', 'image/webp', webp)];
const expectedPixels = new Map();
for (const image of fixtures) expectedPixels.set(image.name, await sharp(image.buffer).ensureAlpha().raw().toBuffer());
const retryFileName = `reference-${'x'.repeat(220)}.png`, retryImportName = retryFileName.slice(0, 200);
expectedPixels.set('pasted.png', swatch); expectedPixels.set('dropped.tiff', swatch); expectedPixels.set(retryImportName, swatch);
const plans = [], agentCalls = [], errors = [], external = [], submissions = [], operations = [], passed = [];
let providerCalls = 0, keyReads = 0;
async function call(ctx, name, args) {
  const response = await fetch(`${ctx.toolContext.baseUrl}/api/chat/${ctx.turn.id}/tool`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.toolContext.capabilityToken}` },
    body: JSON.stringify({ name, arguments: args, callId: randomUUID() }),
  });
  const result = await response.json(); assert.equal(response.ok, true); assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
  return result;
}
const execute = async (ctx, name, args) => (await call(ctx, 'prism_execute', { name, args })).structuredContent;
async function inspectAttachments(ctx, names) {
  assert.deepEqual(ctx.turn.attachments.map(item => item.name), names);
  for (const attachment of ctx.turn.attachments) {
    assert.deepEqual(Object.keys(attachment).sort(), ['documentId', 'name']);
    const { document } = await execute(ctx, 'get_document', { documentId: attachment.documentId });
    assert.equal(document.layers.length, 1);
    const preview = await call(ctx, 'prism_execute', { name: 'get_preview', args: { documentId: document.id, maxWidth: 700 } });
    const image = preview.content.find(item => item.type === 'image'); assert.ok(image, 'Agent receives an actual image preview');
    assert.deepEqual(await sharp(Buffer.from(image.data, 'base64')).ensureAlpha().raw().toBuffer(), expectedPixels.get(attachment.name));
  }
}
const companion = await createCompanion({ dataDir, port: 0, chatEnabled: true,
  chatAdapter: { check: async () => ({ available: true }), run: async ctx => { agentCalls.push(ctx); const plan = plans.shift(); assert.ok(plan, 'Each agent turn has an explicit fixture plan'); return plan(ctx); } },
  getImageKey: async () => { keyReads++; return null; }, imageProvider: async () => { providerCalls++; throw Error('No provider in attachment browser test'); },
});
const base = (await companion.native.execute('import_image', { name: 'Existing project stays intact', data: png.toString('base64'), mimeType: 'image/png' })).document;
const baseUrl = `http://127.0.0.1:${await companion.listen()}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(20000);
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
  if (/^https?:/.test(request.url()) && !request.url().startsWith(baseUrl)) external.push(request.url());
  if (request.method() !== 'POST') return;
  const body = request.postDataJSON();
  if (request.url() === `${baseUrl}/api/chat`) { submissions.push(body); operations.push({ type: 'chat', requestId: body.requestId }); }
  if (body?.command === 'import_image') operations.push({ type: 'import', name: body.args.name });
});
await page.route('https://**', route => route.abort());
const panel = page.getByRole('region', { name: 'Chat with Codex', exact: true });
const input = () => panel.getByLabel('Message Codex', { exact: true });
const files = () => panel.getByLabel('Attach images to chat', { exact: true });
const send = () => panel.getByRole('button', { name: 'Send message to Codex', exact: true });
const draft = () => panel.locator('.chat-draft-attachments');
const turn = message => panel.getByRole('article', { name: `Request: ${message}`, exact: true });
const tab = name => page.locator('.inspector-tabs').getByRole('button', { name, exact: true }).click();
const list = async () => (await companion.native.execute('list_documents', {})).documents;
const current = async id => (await companion.native.execute('get_document', { documentId: id })).document;
const imports = () => operations.filter(item => item.type === 'import');
const ready = message => expect(turn(message).locator('.chat-turn-status')).toHaveText('Reply ready');
const remove = name => draft().getByRole('button', { name: `Remove ${name}`, exact: true }).click();
const checkpoint = text => { passed.push(text); console.log('Verified:', text); };
async function clipboardOrDrop(kind, image) {
  await panel.locator(kind === 'drop' ? '.chat-messages' : '.chat-composer').evaluate((element, value) => {
    const transfer = new DataTransfer(), bytes = Uint8Array.from(atob(value.data), character => character.charCodeAt(0));
    transfer.items.add(new File([bytes], value.name, { type: value.mimeType }));
    element.dispatchEvent(value.kind === 'paste'
      ? new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
      : new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, { kind, name: image.name, mimeType: image.mimeType, data: image.buffer.toString('base64') });
}
async function decodedThumbs(locator) {
  await expect.poll(async () => locator.locator('img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
}
try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' }); await expect(panel).toBeVisible();
  await expect(page.getByLabel('Open document')).toHaveValue(base.id);
  assert.notEqual(await files().getAttribute('multiple'), null);
  const choose = page.waitForEvent('filechooser'); await panel.getByRole('button', { name: 'Attach images', exact: true }).click();
  await (await choose).setFiles([...fixtures, file('remove-me.png', 'image/png', png)]);
  await expect(draft().getByRole('button', { name: /^Remove / })).toHaveCount(4); await remove('remove-me.png');
  await expect(draft().getByRole('button', { name: /^Remove / })).toHaveCount(3); await expect(draft().locator('img')).toHaveCount(3); await decodedThumbs(draft());
  await input().fill('Inspect these three references, then invert only the portrait.'); await tab('Layers'); await tab('Chat');
  await expect(input()).toHaveValue('Inspect these three references, then invert only the portrait.'); await expect(draft().getByRole('button', { name: /^Remove / })).toHaveCount(3);
  assert.equal(imports().length, 0); assert.equal((await list()).length, 1); assert.equal(submissions.length, 0);
  await page.screenshot({ path: path.join(artifacts, 'chat-attachments-staged-1440.png'), animations: 'disabled' });
  checkpoint('Multi-file chooser stages PNG/JPEG/WebP locally; removal, thumbnails and exact prompt survive tab changes without importing documents or sending chat');

  const message = await input().inputValue();
  plans.push(async ctx => {
    await inspectAttachments(ctx, fixtures.map(image => image.name));
    const portrait = ctx.turn.attachments.find(item => item.name === 'portrait.png');
    const { document } = await execute(ctx, 'get_document', { documentId: portrait.documentId });
    await execute(ctx, 'add_adjustment', { documentId: document.id, expectedRevision: document.revision, kind: 'invert', value: 100 });
    return { reply: 'Inspected all three references and added an editable Invert adjustment to the portrait.' };
  });
  await send().click(); await ready(message);
  const sent = submissions.at(-1); assert.equal(sent.message, message); assert.equal(sent.attachments.length, 3); assert.equal(new Set(sent.attachments.map(item => item.documentId)).size, 3);
  assert.deepEqual(operations.map(item => item.type), ['import', 'import', 'import', 'chat']);
  const portraitId = sent.attachments.find(item => item.name === 'portrait.png').documentId;
  await expect(page.getByLabel('Open document')).toHaveValue(portraitId);
  const edited = await current(portraitId); assert.equal(edited.layers.length, 2); assert.equal(edited.layers.at(-1).kind, 'invert'); assert.equal((await current(base.id)).revision, base.revision);
  const wanted = Buffer.from(expectedPixels.get('portrait.png')); for (let i = 0; i < wanted.length; i += 4) for (let c = 0; c < 3; c++) wanted[i + c] = 255 - wanted[i + c];
  const exported = await companion.native.execute('export_document', { documentId: portraitId, format: 'png' }); assert.deepEqual(await sharp(Buffer.from(exported.data, 'base64')).ensureAlpha().raw().toBuffer(), wanted);
  await expect.poll(async () => { const src = await page.locator('.artboard img').getAttribute('src'); return Boolean(src && (await sharp(Buffer.from(src.split(',')[1], 'base64')).ensureAlpha().raw().toBuffer()).equals(wanted)); }).toBe(true);
  await expect(draft().getByRole('button', { name: /^Remove / })).toHaveCount(0); await expect(turn(message).locator('.chat-sent-attachments img')).toHaveCount(3); await decodedThumbs(turn(message).locator('.chat-sent-attachments'));
  await page.screenshot({ path: path.join(artifacts, 'chat-attachments-result-1440.png'), animations: 'disabled' });
  checkpoint('Send imports each image before posting document references; the injected agent inspects actual decoded previews and edits only the portrait, whose exact native pixels and editable result appear automatically');

  await clipboardOrDrop('paste', file('pasted.png', 'image/png', png)); await clipboardOrDrop('drop', file('dropped.tiff', 'image/tiff', tiff));
  await expect(draft().getByRole('button', { name: /^Remove / })).toHaveCount(2); const beforeImageOnly = imports().length;
  assert.equal((await list()).length, 4); assert.equal(imports().length, beforeImageOnly);
  plans.push(async ctx => { await inspectAttachments(ctx, ['pasted.png', 'dropped.tiff']); return { reply: 'Both attached image documents are available. What would you like to change?' }; });
  await expect(input()).toHaveValue(''); await expect(send()).toBeEnabled(); await send().click();
  await expect.poll(() => submissions.length).toBe(2); const imageOnly = submissions.at(-1);
  assert.equal(imageOnly.message, 'Please inspect the attached images and ask what I would like to do with them.'); await ready(imageOnly.message);
  assert.equal(imports().length, beforeImageOnly + 2); await expect(turn(imageOnly.message).locator('.chat-sent-attachments img')).toHaveCount(2); await decodedThumbs(turn(imageOnly.message).locator('.chat-sent-attachments'));
  checkpoint('Composer paste and dropping onto message history stage PNG/TIFF without navigation or eager imports; an image-only send uses an honest inspection request and the agent receives exact pixels from both formats');

  const beforeInvalid = imports().length; await input().fill('Keep this draft through rejected files.');
  await files().setInputFiles(file('not-an-image.txt', 'text/plain', Buffer.from('Do not import this file.')));
  await expect(panel).toContainText(/PNG|JPEG|WebP|TIFF/); await expect(draft().getByRole('button', { name: /^Remove / })).toHaveCount(0);
  await files().setInputFiles(file('oversized.png', 'image/png', Buffer.alloc(20 * 1024 * 1024 + 1)));
  await expect(panel).toContainText(/20\s*(?:MiB|MB)/); await expect(draft().getByRole('button', { name: /^Remove / })).toHaveCount(0);
  await files().setInputFiles(Array.from({ length: 9 }, (_, index) => file(`slot-${index + 1}.png`, 'image/png', png)));
  await expect(draft().getByRole('button', { name: /^Remove / })).toHaveCount(8); await expect(panel).toContainText(/8|eight/);
  await expect(draft().getByRole('button', { name: 'Remove slot-9.png', exact: true })).toHaveCount(0);
  await expect(input()).toHaveValue('Keep this draft through rejected files.'); assert.equal(imports().length, beforeInvalid);
  while (await draft().getByRole('button', { name: /^Remove / }).count()) await draft().getByRole('button', { name: /^Remove / }).first().click();
  checkpoint('Unsupported types, files over 20 MiB and the ninth attachment are rejected without import; valid first-eight files and the prompt remain available for explicit removal');

  await input().fill('Inspect the attached retry reference once.'); await files().setInputFiles(file(retryFileName, 'image/png', png));
  let intercept = true;
  const uncertainRoute = async route => { if (intercept && route.request().method() === 'POST') { intercept = false; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TIMEOUT', message: 'Synthetic unconfirmed delivery' } }) }); } else await route.fallback(); };
  await page.route('**/api/chat', uncertainRoute); const beforeRetry = imports().length;
  plans.push(async ctx => { await inspectAttachments(ctx, [retryImportName]); return { reply: 'Inspected the existing attached reference once.' }; });
  await send().click(); await expect(panel).toContainText('Delivery is unconfirmed'); const firstAttempt = structuredClone(submissions.at(-1)); assert.equal(imports().length, beforeRetry + 1);
  await expect(draft().getByRole('button', { name: `Remove ${retryFileName}`, exact: true })).toBeDisabled(); await tab('Layers'); await tab('Chat');
  await expect(panel).toContainText('Delivery is unconfirmed'); await panel.getByRole('button', { name: 'Retry same message', exact: true }).click();
  await ready(firstAttempt.message); assert.deepEqual(submissions.at(-1), firstAttempt); assert.equal(imports().length, beforeRetry + 1);
  assert.equal((await companion.chat.list()).turns.filter(item => item.requestId === firstAttempt.requestId).length, 1); await page.unroute('**/api/chat', uncertainRoute);
  checkpoint('Long filenames import under a stable bounded name; uncertain delivery retains attachments across tabs and retries the exact requestId/document references without importing or executing twice');

  await page.reload({ waitUntil: 'networkidle' }); await expect(panel).toBeVisible();
  // Each canvas shows its own conversation, so return to the canvas this request was sent from.
  const earlier = (await companion.chat.list()).turns.find(item => item.message === message); await page.getByLabel('Open document').selectOption(earlier.documentId);
  await turn(message).locator('.chat-sent-attachments').scrollIntoViewIfNeeded();
  await expect(turn(message).locator('.chat-sent-attachments img')).toHaveCount(3); await decodedThumbs(turn(message).locator('.chat-sent-attachments'));
  assert.deepEqual((await companion.chat.list()).turns.find(item => item.message === message).attachments, sent.attachments);
  let releasePreview, previewReached; const heldPreview = new Promise(resolve => releasePreview = resolve), seenPreview = new Promise(resolve => previewReached = resolve);
  const busyRoute = async route => { const body = route.request().postDataJSON(); if (body?.command === 'get_preview' && body.args.documentId === portraitId) { previewReached(); await heldPreview; } await route.fallback(); };
  await page.route('**/api/command', busyRoute); await page.getByLabel('Open document').selectOption(portraitId); await seenPreview;
  for (const button of await panel.locator('.chat-sent-attachments button').all()) await expect(button).toBeDisabled();
  releasePreview(); await expect(page.locator('.save-status .spin')).toHaveCount(0); await page.unroute('**/api/command', busyRoute);
  await expect(turn(message).getByRole('button', { name: 'Open attachment portrait.png', exact: true })).toBeEnabled();
  await files().setInputFiles(file('next-portrait.png', 'image/png', photo)); await input().fill('The next reference is staged locally.');
  await page.setViewportSize({ width: 900, height: 1000 }); await expect(input()).toBeInViewport(); await expect(send()).toBeInViewport();
  const removeNext = draft().getByRole('button', { name: 'Remove next-portrait.png', exact: true }); await removeNext.focus(); await expect(removeNext).toBeFocused();
  await page.screenshot({ path: path.join(artifacts, 'chat-attachments-900.png'), animations: 'disabled' }); await removeNext.press('Enter'); await expect(draft().getByRole('button', { name: /^Remove / })).toHaveCount(0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); assert.ok(await page.locator('.inspector').evaluate(element => element.scrollWidth <= element.clientWidth));
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(providerCalls, 0); assert.equal(keyReads, 0); assert.equal(plans.length, 0);
  checkpoint('Sent references and lazy native thumbnails survive reload, thumbnail navigation disables during canvas work, and narrow-width staging, keyboard removal and composer stay reachable with no overflow, browser errors, external traffic or real model/provider calls');
  await fs.writeFile(path.join(artifacts, 'chat-attachments-browser-report.json'), JSON.stringify({ passed, durationMs: Date.now() - startedAt, agentCalls: agentCalls.length, imports: imports().length, actualCliCalls: 0, providerCalls, keyReads, browserErrors: errors, externalRequests: external }, null, 2));
  console.log(`Chat attachment browser passed ${passed.length} workflows.`);
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, 'chat-attachments-browser-failure.png'), animations: 'disabled' }).catch(() => {});
  console.error('Alerts:', await page.getByRole('alert').allTextContents().catch(() => [])); throw error;
} finally { await browser.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
