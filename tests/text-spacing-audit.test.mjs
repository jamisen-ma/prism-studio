import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { ensureBundledFonts } from '../server/fonts.mjs';

const common = extra => ({ id: randomUUID(), name: 'Typography audit', visible: true, opacity: 1, blendMode: 'normal', ...extra });
const textLayer = extra => common({ type: 'text', width: 520, height: 320, transforms: [], text: 'AUTUMN', x: 80, y: 12, fontSize: 48, color: '#b78251', fontFamily: 'Fraunces', fontWeight: 'normal', fontStyle: 'normal', align: 'left', ...extra });
const getLayer = (doc, id) => doc.layers.find(layer => layer.id === id);
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const files = async directory => Object.fromEntries(await Promise.all((await fs.readdir(directory)).sort().map(async file => [file, await fs.readFile(path.join(directory, file))])));
const currentGraph = (native, doc) => { const p = native.project(doc.id); return structuredClone(p.states[p.cursor].graph); };
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-text-spacing-audit-'));
  const native = await new NativeBackend({ dataDir, segmentSubject: () => assert.fail('Typography must not invoke a model') }).init();
  t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { native, dataDir };
}
const project = async (native, layers, extra = {}) => (await native.newProject({ name: 'Independent typography', width: 520, height: 320, layers, selection: null, ...extra }, 'Audit fixture')).document;
const alpha = pixels => Buffer.from(Array.from({ length: pixels.length / 4 }, (_, i) => pixels[4 * i + 3]));
const unpack = mask => { const bytes = Buffer.alloc(mask.width * mask.height); for (let i = 0; i < mask.runs.length; i += 3) bytes.fill(mask.runs[i + 2], mask.runs[i], mask.runs[i] + mask.runs[i + 1]); return bytes; };
const escapeXml = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);

// Captured legacy SVG contract before the production typography extension.
// Layout is assembled independently; glyph rasterization intentionally uses
// the same installed SVG/font engine, not a purported independent font engine.
async function referenceText(layer, { legacy = false } = {}) {
  if (layer.fontFamily === 'Fraunces') await ensureBundledFonts();
  const lines = layer.text.split('\n').map((line, i) => {
    const baseline = legacy || layer.leading === undefined ? layer.y + layer.fontSize + i * layer.fontSize * 1.2 : layer.y + layer.fontSize + i * layer.leading;
    return `<tspan x="${layer.x}" y="${baseline}">${escapeXml(line)}</tspan>`;
  }).join('');
  const tracking = !legacy && layer.tracking ? ` letter-spacing="${layer.fontSize * layer.tracking / 1000}"` : '';
  const anchor = { left: 'start', center: 'middle', right: 'end' }[layer.align ?? 'left'];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${layer.width}" height="${layer.height}"><text font-family="${layer.fontFamily ?? 'sans-serif'}" font-weight="${layer.fontWeight ?? 'normal'}" font-style="${layer.fontStyle ?? 'normal'}" text-anchor="${anchor}" font-size="${layer.fontSize}" fill="${layer.color}" xml:space="preserve"${tracking}>${lines}</text></svg>`;
  return sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();
}
function alphaBounds(pixels, width) {
  let left = Infinity, top = Infinity, right = -1, bottom = -1;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) { const index = (i - 3) / 4, x = index % width, y = Math.floor(index / width); left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
  return right < 0 ? null : { left, top, width: right - left + 1, height: bottom - top + 1 };
}

test('captured legacy renderer stays byte-exact with absent or zero tracking and Auto leading, preserving Unicode and blank lines', async t => {
  const { native } = await fixture(t);
  for (const fontFamily of ['sans-serif', 'serif', 'Fraunces']) for (const align of ['left', 'center', 'right']) {
    const layer = textLayer({ text: 'A<&"\'  AVA\n\nCafe\u0301 🛰\n office A A', fontSize: 37.3, x: align === 'left' ? 5 : align === 'center' ? 260 : 515, y: 9.75, align, fontFamily });
    const expected = await referenceText(layer, { legacy: true }); assert.ok(alpha(expected).some(Boolean));
    assert.deepEqual(await native.renderLayer(layer), expected);
    assert.deepEqual(await native.renderLayer({ ...layer, tracking: 0 }), expected);
    const doc = await project(native, [layer]), changed = await edit(native, doc, 'update_text', { layerId: layer.id, tracking: 0, leading: null });
    assert.equal(Object.hasOwn(getLayer(changed, layer.id), 'tracking'), false); assert.equal(Object.hasOwn(getLayer(changed, layer.id), 'leading'), false);
    assert.deepEqual(await native.renderLayer(getLayer(changed, layer.id)), expected);
  }
});

test('nonzero tracking and authored baseline spacing match independent SVG layout for every anchor and bounded extremes', async t => {
  const { native } = await fixture(t);
  for (const align of ['left', 'center', 'right']) for (const tracking of [-1000, -125, 125, 1000]) for (const leading of [1, 21.25, 2000]) {
    const layer = textLayer({ text: 'AV A<&\n\nCafe\u0301🛰', x: align === 'left' ? 5 : align === 'center' ? 260 : 515, fontSize: 50.5, tracking, leading, align });
    assert.deepEqual(await native.renderLayer(layer), await referenceText(layer));
  }
  const baseline = textLayer({ text: 'AUTUMN', x: 10, fontSize: 48 }), bounds = [];
  for (const tracking of [-100, 0, 100]) bounds.push(alphaBounds(await native.renderLayer({ ...baseline, tracking }), baseline.width));
  assert.ok(bounds[0].width < bounds[1].width && bounds[1].width < bounds[2].width, 'positive/negative spacing actually changes glyph layout');
  const single = textLayer({ text: 'First baseline', tracking: 125 });
  assert.deepEqual(await native.renderLayer(single), await native.renderLayer({ ...single, leading: 3.75 }), 'leading does not move the first authored baseline');
  const withBlank = textLayer({ text: 'A\n\nA', fontSize: 24, leading: 45 });
  const noBlank = textLayer({ text: 'A\nA', fontSize: 24, leading: 90 });
  assert.deepEqual(await native.renderLayer(withBlank), await native.renderLayer(noBlank), 'blank lines advance the baseline without drawing ink');
});

test('partial edits, explicit resets, font-size semantics, duplicate, undo and portable reopen preserve editable text without asset writes', async t => {
  const { native, dataDir } = await fixture(t), initial = textLayer({ text: 'AUTO\nLEADING', tracking: 150, leading: 67.5 });
  let doc = await project(native, [initial]); const assets = await files(native.assetsDir);
  doc = await edit(native, doc, 'update_text', { layerId: initial.id, color: '#854e2b' });
  assert.equal(getLayer(doc, initial.id).tracking, 150); assert.equal(getLayer(doc, initial.id).leading, 67.5);
  doc = await edit(native, doc, 'update_text', { layerId: initial.id, fontSize: 32.5 });
  assert.equal(getLayer(doc, initial.id).leading, 67.5); assert.deepEqual(await native.renderLayer(getLayer(doc, initial.id)), await referenceText(getLayer(doc, initial.id)));
  const authored = structuredClone(getLayer(doc, initial.id)), authoredPixels = await native.renderLayer(authored);
  doc = await edit(native, doc, 'update_text', { layerId: initial.id, tracking: 0 });
  assert.equal(Object.hasOwn(getLayer(doc, initial.id), 'tracking'), false); assert.equal(getLayer(doc, initial.id).leading, 67.5);
  doc = await edit(native, doc, 'update_text', { layerId: initial.id, leading: null });
  assert.equal(Object.hasOwn(getLayer(doc, initial.id), 'leading'), false);
  assert.deepEqual(await native.renderLayer(getLayer(doc, initial.id)), await referenceText(getLayer(doc, initial.id), { legacy: true }));
  doc = await edit(native, doc, 'undo'); doc = await edit(native, doc, 'undo');
  assert.deepEqual(getLayer(doc, initial.id), authored); assert.deepEqual(await native.renderLayer(getLayer(doc, initial.id)), authoredPixels);
  doc = await edit(native, doc, 'duplicate_layer', { layerId: initial.id }); const copy = doc.layers.find(layer => layer.id !== initial.id);
  assert.equal(copy.tracking, authored.tracking); assert.equal(copy.leading, authored.leading);
  doc = await edit(native, doc, 'update_text', { layerId: copy.id, tracking: -150, leading: null });
  assert.equal(getLayer(doc, initial.id).tracking, 150); assert.equal(getLayer(doc, initial.id).leading, 67.5);
  const reopened = await new NativeBackend({ dataDir }).init(); t.after(() => reopened.close());
  assert.deepEqual((await get(reopened, doc)).layers, doc.layers);
  const imported = await native.importProject({ data: (await native.exportProject({ documentId: doc.id })).data });
  assert.deepEqual(imported.document.layers, doc.layers); assert.deepEqual(await native.render(native.project(imported.document.id)), await native.render(native.project(doc.id)));
  assert.deepEqual(await files(native.assetsDir), assets);
});

test('tracking drives text clipping and source selection, while rasterization retains chain identity and immutable photo bytes', async t => {
  const { native } = await fixture(t), base = textLayer({ text: 'AUTO\nOUTFITS', tracking: 120, leading: 62.5, x: 260, align: 'center', fontSize: 48 });
  const photoBytes = await sharp({ create: { width: 520, height: 320, channels: 4, background: '#1d879b' } }).png().toBuffer(), asset = await native.storeAsset(photoBytes);
  const member = common({ type: 'raster', width: 520, height: 320, transforms: [], asset, sourceAsset: asset, sourceFormat: 'png' });
  let doc = await project(native, [base, member]);
  doc = await edit(native, doc, 'set_clipping_chain', { baseLayerId: base.id, layerIds: [member.id] });
  doc = await edit(native, doc, 'update_text', { layerId: base.id, tracking: -60, leading: 78.25 });
  const text = getLayer(doc, base.id), source = await referenceText(text), composite = await native.render(native.project(doc.id));
  assert.deepEqual(alpha(composite), alpha(source));
  for (let i = 0; i < composite.length; i += 4) if (composite[i + 3]) assert.deepEqual([...composite.subarray(i, i + 3)], [29, 135, 155]);
  doc = await edit(native, doc, 'load_layer_selection', { layerId: base.id }); assert.deepEqual(unpack(doc.selection), alpha(source));
  const before = await native.render(native.project(doc.id));
  doc = await edit(native, doc, 'rasterize_layer', { layerId: base.id });
  assert.equal(getLayer(doc, base.id).type, 'raster'); assert.equal(getLayer(doc, base.id).tracking, undefined); assert.equal(getLayer(doc, base.id).leading, undefined);
  assert.equal(getLayer(doc, member.id).clipBaseId, base.id); assert.deepEqual(await native.render(native.project(doc.id)), before);
  assert.deepEqual(await fs.readFile(path.join(native.assetsDir, asset)), photoBytes);
  doc = await edit(native, doc, 'undo'); assert.equal(getLayer(doc, base.id).type, 'text'); assert.equal(getLayer(doc, base.id).tracking, -60); assert.equal(getLayer(doc, base.id).leading, 78.25);
});

test('spacing remains in source units through crop and resize and source-coordinate text edits do not reflow to the canvas', async t => {
  const { native } = await fixture(t), layer = textLayer({ text: 'AVA\nAUTUMN', x: 300, y: 24, fontSize: 48, tracking: 150, leading: 56.5, align: 'right' });
  let doc = await project(native, [layer]);
  doc = await edit(native, doc, 'crop_document', { x: 40, y: 20, width: 260, height: 220 });
  doc = await edit(native, doc, 'resize_document', { width: 130, height: 110 });
  doc = await edit(native, doc, 'update_text', { layerId: layer.id, x: 300, tracking: -125, leading: 61.25 });
  const edited = getLayer(doc, layer.id);
  assert.equal(edited.width, 520); assert.equal(edited.height, 320); assert.equal(edited.x, 300); assert.equal(edited.fontSize, 48); assert.equal(edited.tracking, -125); assert.equal(edited.leading, 61.25);
  const source = await referenceText(edited), cropped = Buffer.alloc(260 * 220 * 4);
  for (let y = 0; y < 220; y++) source.copy(cropped, y * 260 * 4, ((y + 20) * 520 + 40) * 4, ((y + 20) * 520 + 300) * 4);
  const expected = await sharp(cropped, { raw: { width: 260, height: 220, channels: 4 } }).resize(130, 110, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer();
  assert.deepEqual(await native.renderLayer(edited), expected); assert.ok(alpha(expected).some(Boolean));
  doc = await edit(native, doc, 'load_layer_selection', { layerId: layer.id }); assert.deepEqual(unpack(doc.selection), alpha(expected));
  assert.deepEqual(await files(native.assetsDir), {});
});

test('invalid spacing, protected targets, stale calls and persistence failure leave graph, history, assets and cache unchanged', async t => {
  const { native, dataDir } = await fixture(t), layer = textLayer({ tracking: 50, leading: 71.75 });
  let doc = await project(native, [layer]); await native.execute('get_preview', { documentId: doc.id });
  const before = structuredClone(native.project(doc.id)), disk = await files(native.projectsDir), assets = await files(native.assetsDir), cache = native.previewCache.stats();
  for (const tracking of [-1001, 1001, 0.5, NaN, Infinity, null, '10']) await assert.rejects(edit(native, doc, 'update_text', { layerId: layer.id, tracking }));
  for (const leading of [0, 2000.1, NaN, Infinity, '10']) await assert.rejects(edit(native, doc, 'update_text', { layerId: layer.id, leading }));
  await assert.rejects(edit(native, doc, 'update_text', { layerId: layer.id, tracking: 100, expectedRevision: doc.revision - 1 }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(edit(native, doc, 'apply_transaction', { operations: [{ command: 'update_text', args: { layerId: layer.id, tracking: 300 } }, { command: 'update_text', args: { layerId: layer.id, leading: 0 } }] }));
  const directory = native.projectsDir; native.projectsDir = path.join(dataDir, 'missing', 'projects');
  try { await assert.rejects(edit(native, doc, 'update_text', { layerId: layer.id, tracking: -300, leading: null })); } finally { native.projectsDir = directory; }
  assert.deepEqual(native.project(doc.id), before); assert.deepEqual(await files(native.projectsDir), disk); assert.deepEqual(await files(native.assetsDir), assets); assert.deepEqual(native.previewCache.stats(), cache);
  doc = await edit(native, doc, 'set_layer_protection', { layerId: layer.id, protected: true }); const protectedState = structuredClone(native.project(doc.id));
  await assert.rejects(edit(native, doc, 'update_text', { layerId: layer.id, tracking: 0, leading: null }), { code: 'PROTECTED_LAYER' });
  assert.deepEqual(native.project(doc.id), protectedState);
});

test('portable malformed null, fractional tracking and misplaced fields reject before any image processing or publication', async t => {
  const { native } = await fixture(t), { native: target } = await fixture(t);
  const text = textLayer({ tracking: 150, leading: 68.25 }), solid = common({ type: 'solid', width: 520, height: 320, transforms: [], color: '#2d4559' });
  const doc = await project(native, [solid, text]), original = (await native.exportProject({ documentId: doc.id })).data;
  const length = original.readUInt32BE(8), manifest = JSON.parse(original.subarray(12, 12 + length));
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  target.validateProjectAsset = target.storeAsset = () => assert.fail('Invalid typography reached asset processing');
  for (const change of [
    graph => { graph.layers[1].leading = null; }, graph => { graph.layers[1].tracking = 0.5; }, graph => { graph.layers[1].tracking = '0'; }, graph => { graph.layers[1].leading = 0; },
    graph => { graph.layers[0].tracking = 0; }, graph => { graph.layers[0].leading = 20; }, graph => { graph.layers[0].leading = null; },
  ]) {
    const modified = structuredClone(manifest); change(modified.graph); const body = Buffer.from(JSON.stringify(canonical(modified))), prefix = Buffer.from(original.subarray(0, 12)); prefix.writeUInt32BE(body.length, 8);
    await assert.rejects(target.importProject({ data: Buffer.concat([prefix, body, original.subarray(12 + length)]) }), { code: 'INVALID_PROJECT_BUNDLE' });
  }
  assert.equal(target.projects.size, 0); assert.deepEqual(await files(target.assetsDir), {}); assert.deepEqual(await files(target.projectsDir), {});
  // Legacy metadata outside the two newly reserved fields is still accepted.
  const graph = currentGraph(native, doc); graph.layers[0].legacyNote = { retained: true }; graph.layers[1].tracking = 0; native.validateGraph(graph);
});
