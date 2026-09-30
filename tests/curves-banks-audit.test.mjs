import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { COLOR_MAPPING_KINDS, normalizeParameters, mergeCurvesParameters, adjustmentTransform, globalCurvesBanksCacheBytes } from '../server/color.mjs';
import { CURVES_BANKS_POLICY, CURVES_BANKS_CACHE_BYTES, CURVES_BANK_NAMES, normalizeCurvesBanksParameters, compileCurvesBankLookup, compileCurvesBanksLookup } from '../shared/curves-banks.mjs';
import { applyLayerFilters, filterWork, layerFilterSpatialCacheBytes, layerFilterSharedBytes, validateLayerFilterResources } from '../server/layer-filters.mjs';
import { estimateFilterBakeBytes } from '../server/filter-bake.mjs';
import { estimateDistortResources } from '../server/distort-resources.mjs';
import { layerTree } from '../server/groups.mjs';
import { editRecipeHash } from '../server/edit-recipes.mjs';
import { encodeProjectBundle, decodeProjectBundle } from '../server/project-bundle.mjs';
import { curvesBanksReference, CURVES_BANKS_POLYNOMIAL, CURVES_BANKS_PHOTO, CURVES_BANKS_GOLDENS, CURVES_IDENTITY_POINTS } from './fixtures/curves-banks/reference.mjs';

const identity = structuredClone(CURVES_IDENTITY_POINTS), treatment = CURVES_BANKS_POLYNOMIAL;
const base = extra => ({ id: randomUUID(), name: 'Independent Curves banks audit', visible: true, opacity: 1, blendMode: 'normal', ...extra });
const filter = (parameters = { mode: 'banks' }, extra = {}) => ({ id: randomUUID(), kind: 'curves', value: 0, enabled: true, opacity: 1, parameters, ...extra });
const fake = (width, height, extra = {}) => base({ type: 'raster', width, height, asset: 'a'.repeat(64), sourceAsset: 'a'.repeat(64), transforms: [], ...extra });
const image = (w, h) => Buffer.from(Array.from({ length: w * h }, (_, p) => [p * 37 % 256, p * 73 % 256, p * 97 % 256, [0, 1, 128, 255][p % 4]]).flat());
const bitmap = (bytes, width, height, extra = {}) => ({ shape: 'bitmap', x: 0, y: 0, width, height, runs: Array.from(bytes).flatMap((v, i) => v ? [i, 1, v] : []), feather: 0, invert: false, ...extra });
const mask = (width, height, extra = {}) => ({ sourceWidth: width, sourceHeight: height, coverage: { shape: 'rectangle', x: 0, y: 0, width, height, feather: 0, invert: false }, density: 1, enabled: true, ...extra });
const graph = (native, doc) => { const p = native.projects.get(doc.id); return structuredClone(p.states[p.cursor].graph); };
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const edit = (native, doc, command, args = {}) => native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...(command === 'apply_transaction' ? { label: 'Curves banks audit' } : {}), ...args });
const project = async (native, width, height, layers, extra = {}) => (await native.newProject({ name: 'Curves banks audit', width, height, selection: null, layers, ...extra }, 'Fixture')).document;
const files = async dir => Object.fromEntries(await Promise.all((await fs.readdir(dir)).sort().map(async name => [name, await fs.readFile(path.join(dir, name))])));
const half = (n, d) => Number((2n * BigInt(n) + BigInt(d)) / (2n * BigInt(d)));
const distort = (w, h) => ({ type: 'distort', width: w, height: h, corners: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }] });
async function fixture(t) { const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-curves-banks-audit-')); const native = await new NativeBackend({ dataDir, segmentSubject: () => assert.fail('No model for Curves banks') }).init(); t.after(async () => { await native.close(); await fs.rm(dataDir, { recursive: true, force: true }); }); return { native }; }
async function raster(native, input, width, height, extra = {}) { const asset = await native.storeAsset(await sharp(input, { raw: { width, height, channels: 4 } }).png().toBuffer()); return fake(width, height, { asset, sourceAsset: asset, ...extra }); }
async function noPixels(native, operation, noIO = false) {
  const saved = [], calls = [];
  for (const key of ['render', 'renderGraph', 'renderLayer', 'readAlpha', 'storeAlpha', 'storeAsset', 'readProjectAsset', 'validateProjectAsset', 'segmentSubject']) { const old = native[key]; native[key] = () => { calls.push(key); assert.fail(`Unexpected pixel access: ${key}`); }; saved.push(() => { native[key] = old; }); }
  if (noIO) for (const key of ['readFile', 'writeFile', 'open', 'rename', 'link', 'unlink', 'mkdir', 'stat']) { const old = fs[key]; fs[key] = () => { calls.push(`fs.${key}`); assert.fail(`Unexpected fs.${key}`); }; saved.push(() => { fs[key] = old; }); }
  const array = globalThis.Uint8Array; globalThis.Uint8Array = new Proxy(array, { construct(target, args, newTarget) { if (typeof args[0] === 'number') { calls.push(`Uint8Array(${args[0]})`); assert.fail('Metadata must not compile curves or pixels'); } return Reflect.construct(target, args, newTarget); } }); saved.push(() => { globalThis.Uint8Array = array; });
  try { return await operation(); } finally { saved.reverse().forEach(restore => restore()); assert.deepEqual(calls, [], 'No forbidden I/O or LUT compilation may be swallowed as validation failure'); }
}

test('bank compiler preserves independent polynomial/byte-stage goldens and every legacy interpolation upgrade', () => {
  assert.equal(CURVES_BANKS_POLICY, 'master-byte-then-channel-byte-v1'); assert.equal(CURVES_BANKS_CACHE_BYTES, 1280); assert.ok(Object.isFrozen(CURVES_BANK_NAMES));
  for (const p of [treatment, CURVES_BANKS_PHOTO, ...CURVES_BANKS_GOLDENS.map(f => f.parameters), { mode: 'banks' }]) {
    const table = compileCurvesBanksLookup(p), transform = adjustmentTransform({ kind: 'curves', value: 0, parameters: p });
    assert.equal(table.byteLength, 768); assert.deepEqual(Object.keys(transform), []);
    for (let i = 0; i < 256; i++) { const rgb = [i, (i * 73 + 11) % 256, (i * 199 + 61) % 256], expected = curvesBanksReference(rgb, p); assert.deepEqual(transform(...rgb), expected); assert.deepEqual(rgb.map((x, c) => table[c * 256 + x]), expected); }
    const expected = transform(31, 127, 199); table.fill(0); const tuple = transform(31, 127, 199); tuple.fill(255); assert.deepEqual(transform(31, 127, 199), expected);
  }
  for (const f of CURVES_BANKS_GOLDENS) assert.deepEqual(adjustmentTransform({ kind: 'curves', value: 0, parameters: f.parameters })(...f.rgb), f.expected);
  const endpoint = [{ x: 0, y: 255 }, { x: 255, y: .5 - 2 ** -54 }];
  const cases = [identity, endpoint, treatment.banks.master.points, [{ x: 0, y: 0 }, { x: Number.MIN_VALUE, y: 250 }, { x: 2 * Number.MIN_VALUE, y: 1 }, { x: 1, y: 200 }, { x: 1 + 2 ** -52, y: 4 }, { x: 255, y: 255 }]];
  for (const points of cases) for (const interpolation of ['linear', 'smooth']) for (const channel of ['rgb', 'red', 'green', 'blue']) {
    const single = { points, channel, interpolation }, p = { mode: 'banks', banks: { [channel === 'rgb' ? 'master' : channel]: { points, interpolation } } };
    const old = adjustmentTransform({ kind: 'curves', value: 0, parameters: single }), upgraded = adjustmentTransform({ kind: 'curves', value: 0, parameters: p });
    for (let i = 0; i < 256; i++) assert.deepEqual(upgraded(i, 255 - i, i ^ 128), old(i, 255 - i, i ^ 128));
  }
  assert.equal(compileCurvesBankLookup({ points: endpoint })[255], 1); assert.equal(compileCurvesBankLookup({ points: endpoint, interpolation: 'smooth' })[255], 0);
});

test('bank validation and representation merges own metadata while preserving unmarked legacy acceptance', () => {
  let calls = 0; const getter = () => { calls++; throw Error('getter'); };
  const malformed = [null, {}, { banks: {} }, { mode: 'single' }, { mode: 'banks', points: identity }, { mode: 'banks', interpolation: 'smooth' },
    { mode: 'banks', banks: { alpha: {} } }, { mode: 'banks', banks: { red: { points: [{ x: 0, y: 0, extra: true }, { x: 255, y: 255 }] } } },
    { mode: 'banks', banks: { red: { points: [identity[0], , identity[1]] } } }, { mode: 'banks', banks: { red: { interpolation: null } } },
    Object.defineProperty({}, 'mode', { enumerable: true, get: getter }), { mode: 'banks', banks: Object.defineProperty({}, 'blue', { enumerable: true, get: getter }) },
    { mode: 'banks', banks: { master: Object.defineProperty({}, 'points', { enumerable: true, get: getter }) } }, { mode: 'banks', [Symbol('bad')]: 1 }];
  for (const p of malformed) assert.throws(() => normalizeCurvesBanksParameters(p), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls, 0); assert.throws(() => normalizeParameters('curves', null), { code: 'INVALID_ARGUMENT' });
  const legacy = { points: [{ x: 0, y: 0, extra: true }, { x: 255, y: 255 }], channel: 'blue', interpolation: 'smooth' };
  assert.deepEqual(normalizeParameters('curves', legacy), { points: identity, channel: 'blue', interpolation: 'smooth' });
  const authored = structuredClone(treatment), normalized = normalizeCurvesBanksParameters(authored), transform = adjustmentTransform({ kind: 'curves', value: 0, parameters: authored });
  const expected = transform(50, 100, 200); authored.banks.master.points[1].y = 0; normalized.banks.master.points[1].y = 1; assert.deepEqual(transform(50, 100, 200), expected);
  const initial = normalizeCurvesBanksParameters(treatment), partial = mergeCurvesParameters(initial, { mode: 'banks', banks: { red: { points: identity } } });
  assert.deepEqual(partial.banks.red, { points: identity, interpolation: initial.banks.red.interpolation }); assert.deepEqual(partial.banks.master, initial.banks.master);
  assert.deepEqual(mergeCurvesParameters(initial, {}), initial); assert.throws(() => mergeCurvesParameters(initial, { points: identity }), { code: 'INVALID_ARGUMENT' });
  assert.deepEqual(mergeCurvesParameters(initial, { mode: 'single', channel: 'green' }), { points: identity, channel: 'green' });
  assert.deepEqual(mergeCurvesParameters(legacy, { mode: 'single', channel: 'red' }), { points: identity, channel: 'red', interpolation: 'smooth' });
  assert.deepEqual(mergeCurvesParameters(legacy, { mode: 'banks' }), normalizeCurvesBanksParameters({ mode: 'banks' }));
});

test('native source/global partial banks and complete recipes use explicit representation replacement without I/O', async t => {
  const { native } = await fixture(t), w = 8, h = 6, scope = mask(w, h), initial = { mode: 'banks', banks: { red: { points: treatment.banks.master.points, interpolation: 'smooth' } } };
  const source = fake(w, h, { filters: { version: 1, entries: [filter(initial)], mask: scope } }), grade = base({ type: 'adjustment', kind: 'curves', value: 0, parameters: initial });
  let doc = await project(native, w, h, [source, grade]); const original = structuredClone(doc);
  await noPixels(native, async () => { native.validateGraph(graph(native, doc)); assert.deepEqual(await get(native, doc), original); }, true);
  assert.deepEqual(graph(native, doc).layers[1].parameters, initial, 'Read does not canonicalize sparse saved banks');
  for (const [command, target] of [['update_layer_filter', { layerId: source.id, filterId: source.filters.entries[0].id }], ['update_adjustment', { layerId: grade.id }]]) {
    doc = (await noPixels(native, () => edit(native, doc, command, { ...target, parameters: { mode: 'banks', banks: { red: { points: identity }, blue: { interpolation: 'smooth' } } } }))).document;
    const p = command === 'update_adjustment' ? doc.layers[1].parameters : doc.layers[0].filters[0].parameters;
    assert.deepEqual(p.banks.red, { points: identity, interpolation: 'smooth' }); assert.equal(p.banks.blue.interpolation, 'smooth');
    await noPixels(native, () => assert.rejects(edit(native, doc, command, { ...target, parameters: { channel: 'rgb' } }), { code: 'INVALID_ARGUMENT' }), true);
  }
  for (const parameters of [{}, { points: treatment.banks.master.points, channel: 'blue', interpolation: 'smooth' }, { mode: 'banks' }, treatment]) {
    const saved = await edit(native, doc, 'save_edit_recipe', { name: 'Complete bank reset', slots: [{ key: 'grade', type: 'adjustment', kind: 'curves' }, { key: 'photo', type: 'raster' }], steps: [
      { command: 'update_adjustment', target: 'grade', args: { value: 0, parameters } }, { command: 'add_layer_filter', target: 'photo', args: { kind: 'curves', value: 0, parameters } },
    ] }); doc = saved.document;
    const recipe = doc.editRecipes.find(r => r.id === saved.recipeId), hash = editRecipeHash(recipe), before = structuredClone(doc), complete = normalizeParameters('curves', parameters), args = { recipeId: saved.recipeId, bindings: { grade: grade.id, photo: source.id } };
    assert.equal((await noPixels(native, () => edit(native, doc, 'validate_edit_recipe', args), true)).valid, true);
    doc = (await noPixels(native, () => edit(native, doc, 'apply_edit_recipe', args))).document;
    assert.deepEqual(doc.layers[1].parameters, complete); assert.deepEqual(doc.layers[0].filters.at(-1).parameters, complete);
    assert.deepEqual(graph(native, doc).layers[0].filters.mask, scope); assert.deepEqual(doc.editRecipes.find(r => r.id === saved.recipeId), recipe); assert.equal(editRecipeHash(recipe), hash); assert.equal(doc.history.length, before.history.length + 1);
    doc = (await edit(native, doc, 'undo')).document; assert.deepEqual(doc.layers, before.layers);
  }
  assert.deepEqual(await fs.readdir(native.assetsDir), []);
});

test('bank source and global resource activation refuse before pixels while geometry keeps its sequential phase maximum', async t => {
  const { native } = await fixture(t), cap = 256 * 1024 * 1024;
  const w = 8191, h = 2731, legacy = filter({}), dormant = filter({ mode: 'banks' }, { enabled: false });
  const source = fake(w, h, { filters: { version: 1, entries: [legacy, dormant], mask: mask(w, h) } });
  let doc = await project(native, w, h, [source]);
  assert.equal(12 * w * h, cap - 4); assert.equal(filterWork(filter(), w * h), w * h);
  assert.equal(layerFilterSpatialCacheBytes([dormant], w, h), 0);
  for (const args of [{ filterId: legacy.id, parameters: { mode: 'banks' } }, { filterId: dormant.id, enabled: true }]) {
    await noPixels(native, () => assert.rejects(edit(native, doc, 'update_layer_filter', { layerId: source.id, ...args }), { code: 'LIMIT_EXCEEDED' }), true);
    assert.deepEqual(await get(native, doc), doc);
  }
  const saved = await edit(native, doc, 'save_edit_recipe', { name: 'Table crosses full source boundary', slots: [{ key: 'photo', type: 'raster' }], steps: [{ command: 'add_layer_filter', target: 'photo', args: { kind: 'curves', value: 0, parameters: { mode: 'banks' } } }] }); doc = saved.document;
  const args = { recipeId: saved.recipeId, bindings: { photo: source.id } }, report = await noPixels(native, () => edit(native, doc, 'validate_edit_recipe', args), true);
  assert.equal(report.valid, false); assert.equal(report.issues[0].code, 'LIMIT_EXCEEDED');
  await noPixels(native, () => assert.rejects(edit(native, doc, 'apply_edit_recipe', args), { code: 'LIMIT_EXCEEDED' }), true); assert.deepEqual(await get(native, doc), doc);

  const dw = 2410, dh = 7956, distorted = fake(dw, dh, { transforms: [distort(dw, dh)] }), grade = base({ type: 'adjustment', kind: 'curves', value: 0, parameters: { mode: 'banks' }, opacity: 0, visible: false });
  const scene = await project(native, dw, dh, [distorted, grade]), before = graph(native, scene);
  assert.equal(estimateDistortResources(before).estimatedWorkingBytes, cap - 16); assert.equal(globalCurvesBanksCacheBytes(before), 0);
  await noPixels(native, () => assert.rejects(edit(native, scene, 'set_layer', { layerId: grade.id, opacity: .001 }), { code: 'LIMIT_EXCEEDED' }), true);
  const activated = structuredClone(before); activated.layers[1].opacity = 1;
  assert.equal(estimateDistortResources(activated).estimatedWorkingBytes, cap - 16 + 1280);
  activated.layers.push({ ...activated.layers[1], id: randomUUID() }); assert.equal(globalCurvesBanksCacheBytes(activated), 1280);
  assert.deepEqual(await get(native, scene), scene);

  const aw = 1490, ah = 8189, active = fake(aw, ah, { filters: [filter({})], transforms: [distort(aw, ah)] });
  let control = await project(native, aw, ah, [active]); const beforeBytes = estimateDistortResources(graph(native, control)).estimatedWorkingBytes;
  assert.equal(beforeBytes, cap - 36);
  control = (await noPixels(native, () => edit(native, control, 'update_layer_filter', { layerId: active.id, filterId: active.filters[0].id, parameters: { mode: 'banks' } }))).document;
  assert.equal(estimateDistortResources(graph(native, control)).estimatedWorkingBytes, beforeBytes, 'Source table must not be added again after larger geometry phase');
  await noPixels(native, () => assert.rejects(edit(native, control, 'add_adjustment', { kind: 'curves', value: 0, parameters: { mode: 'banks' } }), { code: 'LIMIT_EXCEEDED' }), true);
});

test('bank tables join positioned callbacks once and Bake only during its filter phase, with rings and noise kept distinct', async t => {
  const { native } = await fixture(t), cap = 256 * 1024 * 1024;
  const sizes = [...Array.from({ length: 5 }, () => [8192, 2929]), [8192, 1738], [7680, 1]];
  const layers = sizes.map(([w, h]) => base({ type: 'solid', color: '#000000', width: 1, height: 1, transforms: [], mask: { shape: 'positioned', sourceWidth: w, sourceHeight: h, x: 0, y: 0, source: bitmap([], w, h) } }));
  const doc = await project(native, 1, 1, layers), g = graph(native, doc);
  assert.equal(validateLayerFilterResources(g, layerTree(g.layers)).estimatedScratchBytes, cap - 1024);
  await noPixels(native, () => assert.rejects(edit(native, doc, 'add_adjustment', { kind: 'curves', value: 0, parameters: { mode: 'banks' } }), { code: 'LIMIT_EXCEEDED' }), true);
  assert.deepEqual(await get(native, doc), doc);
  const width = 8192, height = 1000, pixels = width * height, encoded = cap - 17 * pixels - 65536;
  const request = { width, height, hasAlpha: true, encodedWorkingBytes: 70_000_000, encodedAlphaBytes: encoded - 70_000_000 };
  const old = estimateFilterBakeBytes({ ...request, filters: [filter({})] }), banks = estimateFilterBakeBytes({ ...request, filters: [filter()] });
  assert.equal(old.estimatedWorkingBytes, cap); assert.equal(banks.estimatedWorkingBytes, cap + 1280); assert.equal(banks.filterBytes - old.filterBytes, 1280);
  for (const key of ['decodeBytes', 'encodeBytes', 'publicationBytes']) assert.equal(banks[key], old[key]);
  const ring = filter(undefined, { kind: 'blur', value: 1, parameters: undefined }), small = { ...ring, value: .001 }, noise = filter(undefined, { kind: 'add_noise', value: 0, parameters: { distribution: 'gaussian', amount: 1 } });
  const ringBytes = layerFilterSpatialCacheBytes([ring], 256, 128); assert.ok(ringBytes > 1280);
  assert.equal(layerFilterSpatialCacheBytes([ring, filter()], 256, 128), ringBytes);
  assert.equal(layerFilterSpatialCacheBytes([small, filter()], 1, 1), 1280);
  assert.equal(layerFilterSpatialCacheBytes([filter({}, { enabled: false }), filter(undefined, { opacity: 0 })], 256, 128), 0);
  assert.equal(layerFilterSharedBytes([ring, filter(), noise]), 4096);
  const plain = estimateFilterBakeBytes({ width: 256, height: 128, filters: [ring, filter()] }), withNoise = estimateFilterBakeBytes({ width: 256, height: 128, filters: [ring, filter(), noise] });
  for (const key of ['decodeBytes', 'filterBytes', 'encodeBytes', 'publicationBytes']) assert.equal(withNoise[key] - plain[key], 4096);
});

test('native global and source Curves banks preserve hidden RGB and alpha with their declared opacity and mask stages',async t=>{
  const {native}=await fixture(t),input=Buffer.from([255,255,255,0,255,128,255,1,200,100,50,128,64,80,120,255]),before=Buffer.from(input),raw=[255,128,0,255];
  const layer={kind:'curves',value:0,parameters:treatment,opacity:.5,mask:bitmap(raw,4,1),maskDensity:.5};
  assert.equal(COLOR_MAPPING_KINDS.includes('curves'),false);
  const result=await native.applyAdjustment(input,4,1,layer,Uint8Array.from([0,0,0,1]));
  for(let p=0;p<4;p++){const rgb=[...input.subarray(p*4,p*4+3)],mapped=curvesBanksReference(rgb,treatment),amount=.5*(255-.5*(255-raw[p]))/255;for(let c=0;c<4;c++)assert.equal(result[p*4+c],c===3||p===3?input[p*4+c]:Math.round(rgb[c]+(mapped[c]-rgb[c])*amount));}
  const source=await applyLayerFilters(input,4,1,[filter(treatment,{opacity:.5})]);
  for(let p=0;p<4;p++){const rgb=[...input.subarray(p*4,p*4+3)],mapped=curvesBanksReference(rgb,treatment);for(let c=0;c<4;c++)assert.equal(source[p*4+c],c===3||!input[p*4+3]?input[p*4+c]:half(rgb[c]+mapped[c],2));}
  assert.deepEqual(input,before);assert.deepEqual(await native.applyAdjustment(input,4,1,{...layer,opacity:0}),input);
  assert.deepEqual(await applyLayerFilters(Buffer.from([128,128,128,255]),1,1,[filter({mode:'banks'}, {blendMode:'multiply'})]),Buffer.from([64,64,64,255]));
  const tie=Buffer.from([1,1,1,1,1,1,1,255]),settings=CURVES_BANKS_GOLDENS[0].parameters,expected=Buffer.from([1,1,1,1,1,1,1,255]);
  assert.deepEqual(await native.applyAdjustment(tie,2,1,{kind:'curves',value:0,parameters:settings,opacity:1}),expected);
  assert.deepEqual(await applyLayerFilters(tie,2,1,[filter(settings)]),expected);
});

test('Curves banks source alpha, sequential candidate/blend and complete-stack mask precede Distort and exact Bake',async t=>{
  const {native}=await fixture(t),w=9,h=7,input=image(w,h),alpha=Uint8Array.from({length:w*h},(_,p)=>[255,128,1,0,199][p%5]),raw=Uint8Array.from({length:w*h},(_,p)=>p*53%256);
  const scope=mask(w,h,{coverage:bitmap(raw,w,h,{invert:true}),density:.1});
  const p2=CURVES_BANKS_PHOTO,entries=[filter(treatment,{opacity:.625}),filter(p2,{opacity:.5,blendMode:'multiply'})];
  const source=await raster(native,input,w,h,{alphaAsset:await native.storeAlpha(Buffer.from(alpha),w,h),filters:{version:1,entries,mask:scope},mask:{shape:'positioned',sourceWidth:w,sourceHeight:h,x:1,y:-1,source:{shape:'ellipse',x:1,y:1,width:5,height:4,feather:1.2,invert:true}},maskDensity:.5});
  let doc=await project(native,w,h,[source]);const corners=[[1,0],[w+1,0],[w+1,h],[1,h]].map(([x,y])=>({x,y}));doc=(await edit(native,doc,'add_layer_distort',{layerId:source.id,corners})).document;
  const wanted=Buffer.from(input);let orderDiffers=0;
  for(let p=0;p<w*h;p++){
    wanted[p*4+3]=half(input[p*4+3]*alpha[p],255);if(!wanted[p*4+3])continue;
    const original=[...input.subarray(p*4,p*4+3)],a=curvesBanksReference(original,treatment),first=original.map((c,i)=>Math.round(c+(a[i]-c)*.625)),b=curvesBanksReference(first,p2);
    const second=first.map((c,i)=>half(255*c+c*b[i],510)),effective=Math.round(255-.1*raw[p]);
    const wrong=curvesBanksReference(original,p2);if(!Buffer.from(wrong).equals(Buffer.from(b)))orderDiffers++;
    for(let c=0;c<3;c++)wanted[p*4+c]=half(original[c]*(255-effective)+second[c]*effective,255);
  }
  assert.ok(orderDiffers>0);assert.deepEqual(await native.renderLayer({...graph(native,doc).layers[0],transforms:[]}),wanted);
  const translated=Buffer.alloc(input.length);for(let y=0;y<h;y++)wanted.copy(translated,(y*w+1)*4,y*w*4,(y*w+w-1)*4);assert.deepEqual(await native.renderLayer(graph(native,doc).layers[0]),translated);
  const assets=await files(native.assetsDir),appearance=await native.renderGraph(graph(native,doc)),previous=graph(native,doc).layers[0];doc=(await edit(native,doc,'bake_layer_filters',{layerId:source.id})).document;
  const baked=graph(native,doc).layers[0],bytes=await sharp(await fs.readFile(path.join(native.assetsDir,baked.asset))).ensureAlpha().raw().toBuffer();
  for(let p=0;p<w*h;p++){assert.deepEqual(bytes.subarray(p*4,p*4+3),wanted.subarray(p*4,p*4+3));assert.equal(bytes[p*4+3],input[p*4+3]);}
  for(const key of Object.keys(previous).filter(k=>!['asset','filters'].includes(k)))assert.deepEqual(baked[key],previous[key]);assert.deepEqual(baked.filters,[]);assert.equal(doc.layers[0].filterMask,undefined);assert.deepEqual(await native.renderGraph(graph(native,doc)),appearance);
  for(const [name,bytes]of Object.entries(assets))assert.deepEqual(await fs.readFile(path.join(native.assetsDir,name)),bytes);
});

test('Curves banks generated clipping and isolated groups retain lower protected pixels and guarded source/Bake behavior',async t=>{
  const {native}=await fixture(t),w=9,h=7,count=w*h;
  const personBytes=Buffer.from(Array.from({length:count},(_,p)=>[31,117,209,p%w>=3&&p%w<=5?[1,128,255][p%3]:0]).flat()),person=await raster(native,personBytes,w,h,{protected:true,outline:{width:1,color:'#ffffff'}}),group=base({type:'group',mode:'isolated',opacity:.7});
  const sourceBytes=image(w,h);for(let p=0;p<count;p++)sourceBytes[p*4+3]=255;
  const source=await raster(native,sourceBytes,w,h,{parentId:group.id}),memberBytes=Buffer.from(Array.from({length:count},()=>[29,157,71,177]).flat()),member=await raster(native,memberBytes,w,h,{parentId:group.id,clipBaseId:source.id,role:'generated',provenance:{jobId:randomUUID(),mode:'generate'},visible:false});
  let doc=await project(native,w,h,[person,group,source,member]);const baseline=await native.renderGraph(graph(native,doc)),footprint=await native.protectedPixels(graph(native,doc)),assets=await files(native.assetsDir);
  for(const layerId of [source.id,member.id])doc=(await edit(native,doc,'add_layer_filter',{layerId,kind:'curves',value:0,parameters:treatment})).document;doc=(await edit(native,doc,'set_layer',{layerId:member.id,visible:true})).document;
  const actual=await native.renderGraph(graph(native,doc));let changed=0;
  const preview=async(layerId,view='layer')=>{const r=await native.execute('get_layer_preview',{documentId:doc.id,layerId,view,maxWidth:32});return sharp(Buffer.from(r.data,'base64')).ensureAlpha().raw().toBuffer();};
  const sourceView=await preview(source.id),memberView=await preview(member.id);
  for(let p=0;p<count;p++)if(footprint[p]){assert.deepEqual(actual.subarray(p*4,p*4+4),baseline.subarray(p*4,p*4+4));assert.deepEqual(sourceView.subarray(p*4,p*4+3),sourceBytes.subarray(p*4,p*4+3));assert.equal(memberView[p*4+3],0);}else if(!actual.subarray(p*4,p*4+4).equals(baseline.subarray(p*4,p*4+4)))changed++;
  assert.ok(changed>0);assert.deepEqual(await preview(member.id,'source'),memberBytes);
  await noPixels(native,()=>assert.rejects(edit(native,doc,'add_layer_filter',{layerId:person.id,kind:'curves',value:0,parameters:{mode:'banks'}}),{code:'PROTECTED_LAYER'}));
  await noPixels(native,()=>assert.rejects(edit(native,doc,'bake_layer_filters',{layerId:source.id}),{code:'FILTER_BAKE_PROTECTED_CONTEXT'}));assert.deepEqual(await files(native.assetsDir),assets);
});

test('malformed Curves banks global/source/recipe portable metadata rejects before assets and commands preserve the prior graph',async t=>{
  const {native}=await fixture(t),w=8,h=6,source=await raster(native,image(w,h),w,h),doc=await project(native,w,h,[source]),assets=await files(native.assetsDir);
  const bundle=await encodeProjectBundle({graph:graph(native,doc),validateGraph:v=>native.validateGraph(v),readAsset:asset=>fs.readFile(path.join(native.assetsDir,asset))}),size=bundle.readUInt32BE(8),manifest=JSON.parse(bundle.subarray(12,12+size));
  const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
  const forged=g=>{const json=Buffer.from(JSON.stringify(canonical({...manifest,graph:g}))),header=Buffer.from(bundle.subarray(0,12));header.writeUInt32BE(json.length,8);return Buffer.concat([header,json,bundle.subarray(12+size)]);};
  assert.deepEqual(decodeProjectBundle(forged(graph(native,doc)),{validateGraph:v=>native.validateGraph(v)}).graph,graph(native,doc),'The forged-container helper itself remains a valid canonical bundle');
  for(const parameters of [{mode:'future'},{banks:{}},{mode:'banks',channel:'rgb'},{mode:'banks',banks:{blue:{interpolation:'future'}}},{mode:'banks',banks:{master:{points:[{x:0,y:0},{x:0,y:1},{x:255,y:255}]}}},{mode:'banks',banks:{alpha:{}}}]){
    for(const command of ['add_adjustment','add_layer_filter'])await noPixels(native,()=>assert.rejects(edit(native,doc,command,{...(command==='add_layer_filter'?{layerId:source.id}:{}),kind:'curves',value:0,parameters}),error=>['INVALID_ARGUMENT','INVALID_ARGUMENTS'].includes(error.code)),true);
    const recipe={id:randomUUID(),version:1,name:'Malformed Curves banks',slots:[{key:'grade',type:'adjustment',kind:'curves'}],steps:[{command:'update_adjustment',target:'grade',args:{value:0,parameters}}]};
    for(const extra of [{layers:[{...source,filters:[filter(parameters)]}]},{layers:[source,base({type:'adjustment',kind:'curves',value:0,parameters})]},{layers:[source],editRecipes:[recipe]}])await noPixels(native,()=>assert.rejects(native.importProject({data:forged({name:'Bad Curves banks',width:w,height:h,selection:null,...extra})}),{code:'INVALID_PROJECT_BUNDLE'}),true);
  }
  for(const command of ['add_adjustment','add_layer_filter'])await noPixels(native,()=>assert.rejects(edit(native,doc,command,{...(command==='add_layer_filter'?{layerId:source.id}:{}),kind:'curves',value:1}),error=>['INVALID_ARGUMENT','INVALID_ARGUMENTS'].includes(error.code)),true);
  assert.deepEqual(await get(native,doc),doc);assert.deepEqual(await files(native.assetsDir),assets);
});

test('Curves banks real publication failure and late Bake/paint transaction failure preserve graph, files and owned assets',async t=>{
  const {native}=await fixture(t),w=8,h=6,source=await raster(native,image(w,h),w,h,{filters:[filter(treatment)]}),grade=base({type:'adjustment',kind:'curves',value:0,parameters:{}}),doc=await project(native,w,h,[source,grade]);
  const assets=await files(native.assetsDir),projects=await files(native.projectsDir),directory=native.projectsDir;
  native.projectsDir=path.join(native.assetsDir,source.asset);try{await assert.rejects(edit(native,doc,'update_adjustment',{layerId:grade.id,parameters:treatment}),{code:'ENOTDIR'});}finally{native.projectsDir=directory;}
  assert.deepEqual(await get(native,doc),doc);assert.deepEqual(await files(native.projectsDir),projects);assert.deepEqual(await files(native.assetsDir),assets);
  const publishedStore=native.storeAsset;let published=0;native.storeAsset=async function(...args){const result=await publishedStore.apply(this,args);if(!Object.hasOwn(assets,result))published++;return result;};
  native.projectsDir=path.join(native.assetsDir,source.asset);try{await assert.rejects(edit(native,doc,'bake_layer_filters',{layerId:source.id}),{code:'ENOTDIR'});}finally{native.projectsDir=directory;native.storeAsset=publishedStore;}
  assert.ok(published>0,'Bake published a new colored asset before the real project save failed');assert.deepEqual(await get(native,doc),doc);assert.deepEqual(await files(native.projectsDir),projects);assert.deepEqual(await files(native.assetsDir),assets);
  const store=native.storeAsset;let writes=0;native.storeAsset=async function(...args){writes++;return store.apply(this,args);};
  try{await assert.rejects(edit(native,doc,'apply_transaction',{operations:[
    {command:'update_adjustment',args:{layerId:grade.id,parameters:treatment}},
    {command:'update_layer_filter',args:{layerId:source.id,filterId:source.filters[0].id,parameters:treatment}},
    {command:'bake_layer_filters',args:{layerId:source.id}},
    {command:'paint_stroke',args:{layerId:source.id,tool:'brush',color:'#cc5522',size:2,opacity:1,hardness:1,points:[{x:3,y:3}]}},
    {command:'set_layer',args:{layerId:randomUUID(),opacity:.5}},
  ]}),{code:'NOT_FOUND'});}finally{native.storeAsset=store;}
  assert.ok(writes>=2);assert.deepEqual(await get(native,doc),doc);assert.deepEqual(await files(native.assetsDir),assets);assert.deepEqual(await files(native.projectsDir),projects);
});
