// Explicit, offline integration check against the installed real model.
// Usage: npm run verify:segmentation -- path/to/photo.png [output-directory]
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { SegmentationService } from '../server/segmentation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv[2];
if (!input) {
  console.error('Usage: npm run verify:segmentation -- path/to/photo.png [output-directory]');
  process.exit(1);
}
const output = path.resolve(process.argv[3] || path.join(root, 'test-results/real-segmentation'));
const dataDir = process.env.PRISM_DATA_DIR || path.join(root, '.prism');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-real-segmentation-'));
const service = new SegmentationService({ dataDir });
try {
  const status = await service.status();
  assert.equal(status.installed, true, 'Run npm run setup:segmentation first.');
  const originalBytes = await fs.readFile(path.resolve(input));
  const metadata = await sharp(originalBytes, { limitInputPixels: 24_000_000 }).metadata();
  const mimeType = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', tiff: 'image/tiff' }[metadata.format];
  const native = await new NativeBackend({ dataDir: temporary, segmentSubject: bytes => service.segment(bytes) }).init();
  const imported = (await native.execute('import_image', { data: originalBytes.toString('base64'), mimeType, name: 'Real local segmentation verification' })).document;
  const source = imported.layers[0];
  const originalPixels = await native.renderLayer(source);
  const start = performance.now();
  const document = (await native.execute('extract_subject', {
    documentId: imported.id, expectedRevision: imported.revision, layerId: source.id,
  })).document;
  const elapsedMs = Math.round(performance.now() - start);
  const cutout = document.layers.at(-1);
  const actual = await native.renderLayer(cutout);
  assert.equal(actual.length, originalPixels.length);
  let foreground = 0, background = 0, partial = 0;
  for (let offset = 0; offset < actual.length; offset += 4) {
    assert.deepEqual(actual.subarray(offset, offset + 3), originalPixels.subarray(offset, offset + 3), 'Source RGB must remain exact at every pixel.');
    const alpha = actual[offset + 3];
    if (alpha === 0) background++;
    else if (alpha === 255) foreground++;
    else partial++;
  }
  assert.deepEqual(await fs.readFile(path.join(temporary, 'assets', source.sourceAsset)), originalBytes);
  const reopened = await new NativeBackend({ dataDir: temporary }).init();
  const reopenedDocument = (await reopened.execute('get_document', { documentId: document.id })).document;
  assert.deepEqual(await reopened.renderLayer(reopenedDocument.layers.at(-1)), actual);
  const raw = { width: document.width, height: document.height, channels: 4 };
  const mask = await native.readAlpha(cutout.alphaAsset, document.width, document.height);
  await fs.mkdir(output, { recursive: true });
  await sharp(actual, { raw }).png().toFile(path.join(output, 'cutout.png'));
  await sharp(actual, { raw }).flatten({ background: '#f5eadd' }).png().toFile(path.join(output, 'preview.png'));
  await sharp(mask, { raw: { ...raw, channels: 1 } }).png().toFile(path.join(output, 'mask.png'));
  const report = {
    ok: true, model: status.model, runtime: status.runtime, elapsedMs,
    width: document.width, height: document.height,
    foregroundPixels: foreground, backgroundPixels: background, partialPixels: partial,
    originalAssetBytesUnchanged: true, allSourceRgbUnchanged: true, reopenedPixelsExact: true,
    note: 'Mask quality still requires visual inspection. No image generation or provider calls were used.',
  };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  console.log(`Preview, cutout and mask saved in ${output}`);
} finally {
  await service.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
