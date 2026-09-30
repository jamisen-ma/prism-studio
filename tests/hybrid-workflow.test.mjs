import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCompanion } from '../server/index.mjs';

// Synthetic regression fixtures only: no user photographs, model download,
// configured credentials, remote inference, or paid image API are involved.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIDTH = 240, HEIGHT = 320;
const TEST_KEY = 'sk-test-only-hybrid-workflow-not-a-real-credential';
const TITLE = 'AUTUMN\nOUTFITS';

function result(response) {
  assert.notEqual(response.isError, true, JSON.stringify(response.content));
  return response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text);
}
async function until(check, label) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${label}`);
}
function bounds(alpha, width, height) {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (alpha[y * width + x]) {
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}
async function makeOriginal(directory, index) {
  const subjectWidth = 18 + index * 2, subjectHeight = 50 + index * 2;
  const width = subjectWidth + 12, height = subjectHeight + 12;
  const rgba = Buffer.alloc(width * height * 4), alpha = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    // Different bright textile-like patterns make substitutions observable.
    rgba.set([30 + index * 42 + (x % 4) * 8, 35 + (y % 5) * 30, 190 - index * 33 + (x % 3) * 7, 255], (y * width + x) * 4);
    const sx = x - 6, sy = y - 6, middle = Math.floor(subjectWidth / 2);
    const head = (sx - middle) ** 2 + (sy - 5) ** 2 <= 25;
    const body = sx >= 5 && sx < subjectWidth - 5 && sy >= 10 && sy < subjectHeight - 12;
    const hands = sx >= 0 && sx < subjectWidth && sy >= 19 && sy <= 22;
    const bag = sx >= subjectWidth - 5 && sx < subjectWidth && sy >= 28 && sy <= 35;
    const legs = sy >= subjectHeight - 15 && sy < subjectHeight && ((sx >= 3 && sx <= 7) || (sx >= subjectWidth - 8 && sx <= subjectWidth - 4));
    if (sx >= 0 && sx < subjectWidth && sy >= 0 && sy < subjectHeight && (head || body || hands || bag || legs)) alpha[y * width + x] = 255;
  }
  alpha[6 * width + 6 + Math.floor(subjectWidth / 2)] = 128; // A soft hair edge must remain protected too.
  const png = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const filename = path.join(directory, `synthetic-patterned-subject-${index + 1}.png`);
  await fs.writeFile(filename, png);
  const subjectBounds = { left: 6, top: 6, width: subjectWidth, height: subjectHeight };
  assert.deepEqual(bounds(alpha, width, height), subjectBounds);
  return { filename, png, rgba, alpha, width, height, subjectBounds };
}

test('hybrid MCP cover preserves four original subjects through extraction, layout, hostile AI output, export and reopen', { timeout: 10000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-hybrid-workflow-'));
  const originals = await Promise.all(Array.from({ length: 4 }, (_, index) => makeOriginal(dataDir, index)));
  const calls = [], segmentations = [];
  const backgroundRaw = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    backgroundRaw.set([190 + Math.floor(y / 10), 106 + Math.floor(x / 5), 48 + Math.floor(y / 8), 255], (y * WIDTH + x) * 4);
  }
  const background = await sharp(backgroundRaw, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } }).png().toBuffer();
  const hostileOutput = await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: '#cc00ff' } }).png().toBuffer();
  const imageProvider = async args => {
    calls.push(args);
    if (!args.image) assert.equal(args.mask, undefined, 'Background generation must receive neither original people nor an edit mask');
    return { data: args.image ? hostileOutput : background, mimeType: 'image/png', model: args.model, requestId: `synthetic-provider-${calls.length}` };
  };
  const segmentSubject = async png => {
    const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const original = originals.find(item => item.width === decoded.info.width && item.height === decoded.info.height);
    assert.ok(original, 'Segmentation must only receive one of the four imported originals');
    assert.deepEqual(decoded.data, original.rgba);
    segmentations.push(original.filename);
    return { alpha: Buffer.from(original.alpha), width: original.width, height: original.height, model: 'synthetic-known-subject-mask' };
  };
  let companion, client, stderr = '';
  async function connect() {
    companion = await createCompanion({ dataDir, port: 0, imageProvider, getImageKey: async () => TEST_KEY, segmentSubject });
    const port = await companion.listen();
    client = new Client({ name: 'prism-synthetic-hybrid-regression', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root,
      env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe',
    });
    transport.stderr.on('data', bytes => { stderr += bytes.toString(); });
    await client.connect(transport);
  }
  t.after(async () => {
    await client?.close();
    await companion?.close();
    await fs.rm(dataDir, { recursive: true, force: true });
    assert.ok(!stderr.includes(TEST_KEY), 'MCP must not log the injected test credential');
  });
  await connect();
  const call = (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: ['generate_image', 'edit_image'].includes(name) ? { provider: 'openai', ...args } : args });
  const read = async documentId => result(await call('get_document', { backend: 'native', documentId })).document;
  const edit = async (document, name, args = {}) => result(await call(name, { backend: 'native', documentId: document.id, expectedRevision: document.revision, ...args })).document;
  const preview = async documentId => {
    const response = await call('get_preview', { backend: 'native', documentId, maxWidth: WIDTH });
    result(response);
    const block = response.content.find(item => item.type === 'image');
    assert.equal(block?.mimeType, 'image/png');
    return sharp(Buffer.from(block.data, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  };
  const complete = jobId => until(async () => {
    const job = result(await call('get_generation_job', { jobId })).job;
    assert.ok(!['failed', 'cancelled'].includes(job.status), JSON.stringify(job));
    return job.status === 'succeeded' && job;
  }, 'controlled generation to apply');
  const assetFile = asset => path.join(dataDir, 'native', 'assets', asset);

  for (const [index, original] of originals.entries()) {
    let document = result(await call('import_file', { path: original.filename, name: `Synthetic original ${index + 1}`, requestId: `hybrid-import-${index}` })).document;
    original.sourceAsset = document.layers[0].sourceAsset;
    document = await edit(document, 'extract_subject', { layerId: document.layers[0].id, name: `Protected subject ${index + 1}` });
    original.document = document;
    original.cutout = document.layers.at(-1);
    assert.equal(document.layers[0].visible, false);
    assert.equal(original.cutout.protected, true);
    assert.equal(original.cutout.asset, document.layers[0].asset);
    assert.equal(original.cutout.sourceAsset, original.sourceAsset);
    assert.deepEqual(await sharp(await fs.readFile(assetFile(original.cutout.alphaAsset))).extractChannel(0).raw().toBuffer(), original.alpha);
  }
  assert.equal(segmentations.length, 4);
  assert.equal(new Set(segmentations).size, 4);
  let cover = result(await call('create_document', { backend: 'native', name: 'Synthetic hybrid workflow fixture — not user photos', width: WIDTH, height: HEIGHT, background: '#b26b40' })).document;
  const generationArgs = { documentId: cover.id, expectedRevision: cover.revision, requestId: 'hybrid-background-once', prompt: 'Autumn editorial background only, warm burnt orange and gold; no people, no text.', fit: 'cover', quality: 'low', name: 'Synthetic autumn background' };
  const started = result(await call('generate_image', generationArgs)).job;
  await complete(started.id);
  assert.equal(result(await call('generate_image', generationArgs)).job.id, started.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].image, undefined, 'The background provider must never receive any of the four original images');
  assert.equal(calls[0].mask, undefined);
  cover = await read(cover.id);

  const boxes = [8, 60, 116, 176].map((x, index) => ({ x, y: 175, width: originals[index].subjectBounds.width * 2 + 8, height: originals[index].subjectBounds.height * 2 }));
  // A stale inspected source must be rejected before any target mutation.
  const stale = await call('place_layer', { backend: 'native', documentId: cover.id, expectedRevision: cover.revision, sourceDocumentId: originals[0].document.id, sourceLayerId: originals[0].cutout.id, sourceExpectedRevision: originals[0].document.revision - 1, ...boxes[0] });
  assert.equal(stale.isError, true);
  assert.equal(JSON.parse(stale.content.find(item => item.type === 'text').text).code, 'REVISION_CONFLICT');
  assert.deepEqual(await read(cover.id), cover);
  for (const [index, original] of originals.entries()) {
    cover = await edit(cover, 'place_layer', { sourceDocumentId: original.document.id, sourceLayerId: original.cutout.id, sourceExpectedRevision: original.document.revision, ...boxes[index], name: `Cover subject ${index + 1}` });
    const layer = cover.layers.at(-1), box = boxes[index];
    original.placed = layer;
    assert.equal(layer.protected, true);
    assert.deepEqual(layer.origin, { documentId: original.document.id, layerId: original.cutout.id });
    assert.equal(layer.sourceAsset, original.sourceAsset);
    assert.deepEqual(layer.placement, { x: box.x + 4, y: box.y, width: original.subjectBounds.width * 2, height: original.subjectBounds.height * 2, sourceBounds: original.subjectBounds });
    const placedAlpha = await sharp(await fs.readFile(assetFile(layer.alphaAsset))).extractChannel(0).raw().toBuffer();
    original.placedAlpha = placedAlpha;
    assert.deepEqual(bounds(placedAlpha, WIDTH, HEIGHT), { left: layer.placement.x, top: layer.placement.y, width: layer.placement.width, height: layer.placement.height }, 'Complete head, hands, bag and feet must fit inside the lower rectangle');
    assert.equal(layer.placement.width * original.subjectBounds.height, layer.placement.height * original.subjectBounds.width, 'Each subject retains its original proportions');
    const masked = Buffer.from(original.rgba);
    for (let i = 0; i < original.alpha.length; i++) masked[i * 4 + 3] = original.alpha[i];
    const expected = await sharp(masked, { raw: { width: original.width, height: original.height, channels: 4 } }).extract(original.subjectBounds).resize(layer.placement.width, layer.placement.height, { kernel: 'lanczos3' }).raw().toBuffer();
    const placed = await sharp(await fs.readFile(assetFile(layer.asset))).extract({ left: layer.placement.x, top: layer.placement.y, width: layer.placement.width, height: layer.placement.height }).ensureAlpha().raw().toBuffer();
    for (let y = 0; y < layer.placement.height; y++) for (let x = 0; x < layer.placement.width; x++) {
      const local = (y * layer.placement.width + x) * 4, global = (y + layer.placement.y) * WIDTH + x + layer.placement.x;
      assert.equal(placedAlpha[global], expected[local + 3]);
      assert.deepEqual(placed.subarray(local, local + 3), expected.subarray(local, local + 3), 'Placement preserves the original patterned subject RGB');
    }
  }
  const beforeType = (await preview(cover.id)).data;
  cover = await edit(cover, 'apply_transaction', { label: 'Outline all four subjects and add editable cover title', operations: [
    ...originals.map(original => ({ command: 'set_layer_outline', args: { layerId: original.placed.id, width: 2, color: '#ffffff' } })),
    { command: 'add_text', args: { name: 'Editable autumn title', text: TITLE, x: 120, y: 22, fontSize: 39, fontFamily: 'Fraunces', fontWeight: 'bold', align: 'center', color: '#ffffff' } },
  ] });
  const protectedLayers = cover.layers.filter(layer => layer.protected);
  assert.equal(protectedLayers.length, 4);
  for (const layer of protectedLayers) assert.deepEqual(layer.outline, { width: 2, color: '#ffffff' });
  const title = cover.layers.find(layer => layer.type === 'text');
  assert.equal(title.text, TITLE); assert.equal(title.fontFamily, 'Fraunces'); assert.equal(title.fontWeight, 'bold');
  assert.equal(cover.layers.filter(layer => layer.type === 'text').length, 1);
  const finished = await preview(cover.id);
  assert.equal(finished.info.width, WIDTH); assert.equal(finished.info.height, HEIGHT);
  assert.notDeepEqual(finished.data.subarray(0, 140 * WIDTH * 4), beforeType.subarray(0, 140 * WIDTH * 4), 'Editable Fraunces title must actually render');

  // The provider deliberately ignores every selection/protection mask and
  // returns solid magenta. Local compositing still has to preserve originals.
  cover = await edit(cover, 'select_rectangle', { x: 0, y: 150, width: WIDTH, height: HEIGHT - 150 });
  const editArgs = { documentId: cover.id, expectedRevision: cover.revision, scope: 'selection', requestId: 'hybrid-hostile-mask-provider', prompt: 'Change the lower background only; preserve all subjects exactly.' };
  const adversarial = result(await call('edit_image', editArgs)).job;
  await complete(adversarial.id);
  assert.equal(calls.length, 2); assert.ok(Buffer.isBuffer(calls[1].image)); assert.ok(Buffer.isBuffer(calls[1].mask));
  const mask = await sharp(calls[1].mask).ensureAlpha().raw().toBuffer();
  const afterHostile = (await preview(cover.id)).data;
  let protectedCount = 0, outlineCount = 0;
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const index = y * WIDTH + x, offset = index * 4;
    const subject = originals.some(original => original.placedAlpha[index] > 0);
    const outline = y >= 150 && finished.data[offset] === 255 && finished.data[offset + 1] === 255 && finished.data[offset + 2] === 255;
    if (subject || outline) {
      assert.equal(mask[offset + 3], 255, 'The supplied edit mask must protect every visible subject/outline pixel');
      assert.deepEqual(afterHostile.subarray(offset, offset + 4), finished.data.subarray(offset, offset + 4), `Protected visible pixel changed at ${x},${y}`);
      protectedCount += Number(subject); outlineCount += Number(outline);
    }
    if (y < 150) assert.deepEqual(afterHostile.subarray(offset, offset + 4), finished.data.subarray(offset, offset + 4), 'Pixels outside the selection, including title, must remain unchanged');
  }
  assert.ok(protectedCount > 5000); assert.ok(outlineCount > 1000);
  assert.deepEqual([...afterHostile.subarray((HEIGHT - 1) * WIDTH * 4, (HEIGHT - 1) * WIDTH * 4 + 4)], [204, 0, 255, 255], 'The selected unprotected background really changes');
  cover = await edit(await read(cover.id), 'undo');
  assert.deepEqual((await preview(cover.id)).data, finished.data, 'One undo restores the complete original cover');
  cover = await edit(cover, 'clear_selection');
  const saved = result(await call('save_document', { backend: 'native', documentId: cover.id }));
  assert.equal(saved.saved, true);
  const exported = result(await call('export_document', { backend: 'native', documentId: cover.id, format: 'png' }));
  const exportedPNG = await fs.readFile(exported.path);
  const decodedExport = await sharp(exportedPNG).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(decodedExport.info.width * 4, decodedExport.info.height * 3);
  assert.deepEqual(decodedExport.data, finished.data);
  await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
  await fs.writeFile(path.join(root, 'test-results', 'hybrid-workflow-fixture.png'), exportedPNG);

  await client.close(); await companion.close();
  await connect();
  const reopened = await read(cover.id);
  assert.deepEqual(reopened, saved.document, 'Editable layers, separate alpha, protection, typography and provenance survive reopening');
  assert.deepEqual((await preview(cover.id)).data, finished.data);
  assert.equal(result(await call('generate_image', generationArgs)).job.id, started.id, 'Background retry identity survives restarting both MCP and companion');
  assert.equal(calls.filter(args => !args.image).length, 1, 'Exactly one background generation was issued');
  assert.equal(calls.length, 2, 'Reopening/retrying must not invoke either fake provider job again');
  for (const original of originals) {
    assert.deepEqual(await fs.readFile(original.filename), original.png, 'Original local PNG remains byte-identical');
    assert.deepEqual(await fs.readFile(assetFile(original.sourceAsset)), original.png, 'The immutable imported source asset remains byte-identical');
    assert.deepEqual(await read(original.document.id), original.document, 'Placing and editing the cover never changes source documents');
  }
});
