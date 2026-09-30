import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transformWithOxc } from 'vite';
import { COLOR_LOOKUP_POLICY, COLOR_LOOKUP_LIMITS } from '../shared/color-lookup.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'prism-color-lookup-client-audit-'));
after(() => rm(temporary, { recursive: true, force: true }));
const { code } = await transformWithOxc(await readFile(new URL('../client/color-lookup.ts', import.meta.url), 'utf8'), 'color-lookup.ts');
await writeFile(join(temporary, 'color-lookup.mjs'), code.replaceAll('../shared/', new URL('../shared/', import.meta.url).href));
const { colorLookupCapabilityKey, supportsColorLookup, supportsLookupEntry, colorLookupFileError, lookupParameters, recipeHasLookup } = await import(pathToFileURL(join(temporary, 'color-lookup.mjs')).href);
const caps = () => ({ id: 'native', colorLookupPolicy: COLOR_LOOKUP_POLICY, colorLookupFormats: ['cube-3d'], colorLookupInputSpaces: ['srgb'], colorLookupLimits: { ...COLOR_LOOKUP_LIMITS }, adjustmentKinds: ['color_lookup'], layerFilterKinds: ['color_lookup'], layerFilterCoordinates: 'source', commands: ['import_color_lookup', 'get_document'] });
const descriptor = () => ({ asset: 'a'.repeat(64), bytes: 512, gridSize: 3, inputSpace: 'srgb', sourceName: '🌈 original.cube', title: 'Original # literal title' });

test('actual lookup client independently gates global/source policy, complete limits and saved metadata under lower advertised bounds', () => {
  const good = caps();
  for (const scope of ['global', 'source']) {
    assert.equal(supportsColorLookup(good, 'native', scope), true); assert.equal(supportsLookupEntry(good, 'native', scope, descriptor()), true);
    assert.equal(supportsColorLookup({ ...good, commands: [] }, 'native', scope), true, 'Semantic support is separate from individual command availability.');
    assert.notEqual(colorLookupCapabilityKey({ ...good, commands: [] }), colorLookupCapabilityKey(good));
    for (const patch of [{ id: 'photoshop' }, { colorLookupPolicy: undefined }, { colorLookupPolicy: 'future' }, { colorLookupFormats: [] }, { colorLookupFormats: ['cube-3d', false] }, { colorLookupInputSpaces: ['linear'] }, { colorLookupLimits: undefined }]) {
      assert.equal(supportsColorLookup({ ...good, ...patch }, 'native', scope), false); assert.notEqual(colorLookupCapabilityKey({ ...good, ...patch }), colorLookupCapabilityKey(good));
    }
    assert.equal(supportsColorLookup(good, 'photoshop', scope), false);
    for (const key of Object.keys(COLOR_LOOKUP_LIMITS)) for (const value of [undefined, NaN, Infinity, 0, -1, .5, '1', Number.MAX_SAFE_INTEGER + 1]) {
      const bad = { ...good, colorLookupLimits: { ...good.colorLookupLimits, [key]: value } };
      assert.equal(supportsColorLookup(bad, 'native', scope), false, `${scope} ${key} ${value}`);
    }
    for (const patch of [{ maxBytes: 511 }, { minGridSize: 4 }, { maxGridSize: 2 }, { maxSourceNameLength: 2 }, { maxTitleLength: 2 }]) {
      const lower = { ...good, colorLookupLimits: { ...good.colorLookupLimits, ...patch } };
      assert.equal(supportsColorLookup(lower, 'native', scope), true); assert.equal(supportsLookupEntry(lower, 'native', scope, descriptor()), false);
    }
  }
  assert.equal(supportsColorLookup({ ...good, adjustmentKinds: [] }, 'native', 'source'), true);
  assert.equal(supportsColorLookup({ ...good, adjustmentKinds: [] }, 'native', 'global'), false);
  assert.equal(supportsColorLookup({ ...good, layerFilterKinds: [], layerFilterCoordinates: 'canvas' }, 'native', 'global'), true);
  assert.equal(supportsColorLookup({ ...good, layerFilterCoordinates: 'canvas' }, 'native', 'source'), false);
  for (const limits of [{ minGridSize: 1 }, { maxGridSize: 34 }, { minGridSize: 5, maxGridSize: 4 }]) assert.equal(supportsColorLookup({ ...good, colorLookupLimits: { ...good.colorLookupLimits, ...limits } }, 'native', 'source'), false);
});

test('actual lookup client preserves literal descriptors and validates local file boundaries without parsing or mutating metadata', () => {
  const p = descriptor(), result = lookupParameters(p); assert.deepEqual(result, p); assert.notEqual(result, p); result.sourceName = 'changed'; assert.equal(p.sourceName, '🌈 original.cube');
  let invoked = 0; const accessor = { ...p }; Object.defineProperty(accessor, 'asset', { enumerable: true, get() { invoked++; return p.asset; } });
  assert.equal(lookupParameters(accessor), undefined); assert.equal(invoked, 0);
  for (const bad of [undefined, {}, { ...p, title: null }, { ...p, sourceName: '../file.cube' }, { ...p, gridSize: 34 }, { ...p, inputSpace: 'linear' }]) assert.equal(lookupParameters(bad), undefined);
  const good = caps();
  for (const name of ['sample.cube', ' 🌈 look.cube ', 'x'.repeat(200), 'No extension']) for (const size of [1, COLOR_LOOKUP_LIMITS.maxBytes]) assert.equal(colorLookupFileError({ name, size }, good), undefined);
  for (const name of ['', '  ', '.', '..', 'a/b', 'a\\b', 'a\u0000b', 'a\u007fb', '\ud800', '\udfff', 'x'.repeat(201)]) assert.equal(typeof colorLookupFileError({ name, size: 1 }, good), 'string');
  for (const size of [0, -1, .5, NaN, Infinity, COLOR_LOOKUP_LIMITS.maxBytes + 1]) assert.equal(typeof colorLookupFileError({ name: 'file.cube', size }, good), 'string');
  const lower = { ...good, colorLookupLimits: { ...good.colorLookupLimits, maxBytes: 16, maxSourceNameLength: 8 } };
  assert.equal(colorLookupFileError({ name: 'one.cube', size: 16 }, lower), undefined);
  assert.equal(typeof colorLookupFileError({ name: 'one.cube', size: 17 }, lower), 'string');
  assert.equal(typeof colorLookupFileError({ name: 'longer.cube', size: 1 }, lower), 'string');
});

test('actual lookup recipe detection refuses asset definitions even when disabled without banning dependency-free recipes', () => {
  assert.equal(recipeHasLookup(), false); assert.equal(recipeHasLookup({ slots: [], steps: [] }), false);
  assert.equal(recipeHasLookup({ slots: [{ key: 'grade', type: 'adjustment', kind: 'color_lookup' }], steps: [] }), true);
  assert.equal(recipeHasLookup({ slots: [{ key: 'source', type: 'raster' }], steps: [{ command: 'add_layer_filter', target: 'source', args: { kind: 'color_lookup', parameters: descriptor(), enabled: false, opacity: 0 } }] }), true);
  assert.equal(recipeHasLookup({ slots: [{ key: 'source', type: 'raster' }], steps: [{ command: 'add_layer_filter', target: 'source', args: { kind: 'brightness', value: 5 } }] }), false);
});
