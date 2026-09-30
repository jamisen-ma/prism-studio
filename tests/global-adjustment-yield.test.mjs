import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';

const byte = value => Math.max(0, Math.min(255, Math.round(value)));

test('legacy global Curves yields between bounded batches while preserving every masked/protected/hidden byte', async () => {
  for (const [width, height] of [[8192, 128], [128, 8192]]) {
    const input = Buffer.alloc(width * height * 4), protectedPixels = Buffer.alloc(width * height);
    for (let p = 0; p < protectedPixels.length; p++) { input.set([p % 256, p * 7 % 256, 255 - p % 256, [0, 1, 128, 255][p % 4]], p * 4); protectedPixels[p] = p % 17 === 0 ? 1 : 0; }
    const original = Buffer.from(input), points = [{ x: 0, y: 255 }, { x: 255, y: 0.49999999999999994 }];
    const layer = { kind: 'curves', value: 0, opacity: .375, parameters: { points, channel: 'rgb' }, mask: { shape: 'rectangle', x: 0, y: 0, width: width / 2, height }, maskDensity: .5 };
    let pending = true, beats = 0, immutable = true;
    const tick = () => { if (!pending) return; beats++; immutable &&= input.equals(original); setImmediate(tick); };
    setImmediate(tick);
    const output = await NativeBackend.prototype.applyAdjustment.call({}, input, width, height, layer, protectedPixels);
    pending = false; await turn();
    assert.ok(beats >= Math.floor(width * height / 65_536));
    assert.equal(immutable, true); assert.deepEqual(input, original);
    for (let p = 0; p < protectedPixels.length; p++) {
      const i = p * 4, amount = .375 * (p % width < width / 2 ? 1 : .5);
      for (let c = 0; c < 3; c++) {
        // The unchanged legacy expression intentionally returns byte1 at255.
        const mapped = byte(255 + (points[1].y - 255) * input[i + c] / 255);
        assert.equal(output[i + c], protectedPixels[p] ? input[i + c] : byte(input[i + c] + (mapped - input[i + c]) * amount));
      }
      assert.equal(output[i + 3], input[i + 3]);
    }
  }
  const identity = Buffer.from([90, 20, 30, 0]);
  assert.equal(await NativeBackend.prototype.applyAdjustment.call({}, identity, 1, 1, { kind: 'brightness', value: 0, opacity: 1 }), identity);
});

test('a mutation queued during a global adjustment yield cannot change an in-flight export or bypass revision order', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-global-yield-')), native = await new NativeBackend({ dataDir }).init();
  t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  let document = (await native.execute('create_document', { name: 'Yield ownership', width: 1024, height: 1024, background: '#204080' })).document;
  document = (await native.execute('add_adjustment', { documentId: document.id, expectedRevision: document.revision, kind: 'curves', value: 0, parameters: { points: [{ x: 0, y: 255 }, { x: 255, y: 0 }] } })).document;
  const stableRevision = document.revision, gradeId = document.layers.at(-1).id, originalApply = native.applyAdjustment;
  let mutation, sawPending = false, pixelFinished = false, scheduled = false, revisionDuringYield;
  native.applyAdjustment = async function (...args) {
    if (scheduled) return originalApply.apply(this, args);
    scheduled = true;
    setImmediate(() => {
      sawPending = !pixelFinished; revisionDuringYield = native.project(document.id).revision;
      mutation = native.execute('update_adjustment', { documentId: document.id, expectedRevision: stableRevision, layerId: gradeId, parameters: { points: [{ x: 0, y: 0 }, { x: 255, y: 255 }] } });
    });
    const result = await originalApply.apply(this, args); pixelFinished = true; return result;
  };
  const exported = await native.execute('export_document', { documentId: document.id, format: 'png' });
  assert.equal(sawPending, true); assert.equal(revisionDuringYield, stableRevision); assert.ok(mutation);
  document = (await mutation).document; assert.equal(document.revision, stableRevision + 1);
  const decode = result => sharp(Buffer.from(result.data, 'base64')).ensureAlpha().raw().toBuffer();
  const before = await decode(exported), after = await decode(await native.execute('export_document', { documentId: document.id, format: 'png' }));
  for (let i = 0; i < before.length; i += 4) {
    assert.equal(before[i], 223); assert.equal(before[i + 1], 191); assert.equal(before[i + 2], 127); assert.equal(before[i + 3], 255);
    assert.equal(after[i], 32); assert.equal(after[i + 1], 64); assert.equal(after[i + 2], 128); assert.equal(after[i + 3], 255);
  }
  await assert.rejects(native.execute('update_adjustment', { documentId: document.id, expectedRevision: stableRevision, layerId: gradeId, parameters: { interpolation: 'smooth' } }), { code: 'REVISION_CONFLICT' });
});
