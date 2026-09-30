import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PHOTO_FILTER_POLICY, PHOTO_FILTER_DEFAULTS, normalizePhotoFilterParameters as normalize, mergePhotoFilterParameters as merge, photoFilterIsIdentity as identity, photoFilterTransform as compile } from '../server/photo-filter.mjs';
import { PHOTO_FILTER_GOLDENS } from './fixtures/photo-filter/reference.mjs';
const invalid = error => error.code === 'INVALID_ARGUMENT';

test('Photo Filter normalization owns canonical defaults, patches and compiled scalar state', () => {
  assert.equal(PHOTO_FILTER_POLICY, 'rgb-transmission-luma-fit-v1');
  assert.ok(Object.isFrozen(PHOTO_FILTER_DEFAULTS));
  assert.deepEqual(normalize(), { color: '#ff9500', density: 25, preserveLuminosity: true });
  const p = Object.assign(Object.create(null), { color: '#AAff33', density: -0, preserveLuminosity: false });
  assert.deepEqual(normalize(p), { color: '#aaff33', density: 0, preserveLuminosity: false });
  assert.equal(Object.getPrototypeOf(p), null); assert.equal(p.color, '#AAff33');
  const prior = { color: '#010203', density: 13.37, preserveLuminosity: false };
  assert.deepEqual(merge(prior, {}), prior); assert.deepEqual(merge(prior, { density: 0 }), { ...prior, density: 0 });
  assert.deepEqual(merge(prior, { color: undefined }), { ...prior, color: '#ff9500' });
  const fn = compile(prior), expected = fn(200,150,100); prior.color = '#ffffff'; prior.density = 0;
  assert.deepEqual(fn(200,150,100), expected); expected[0] = 0; assert.notDeepEqual(fn(200,150,100), expected);
  assert.deepEqual(Reflect.ownKeys(fn), ['length','name']);
});

test('Photo Filter rejects malformed values and patch accessors before invoking them', () => {
  let reads = 0; const accessor = Object.defineProperty({}, 'density', { enumerable: true, get() { reads++; return 25; } });
  for (const input of [null, [], 1, { unknown: 1 }, { color: '#fff' }, { color: '#abcdef\n' }, { color: '#gg0000' }, { color: null }, { density: null }, { density: -.01 }, { density: 100.01 }, { density: .001 }, { density: NaN }, { density: Infinity }, { preserveLuminosity: 1 }, { preserveLuminosity: null }, Object.create({ color: '#ff0000' }), { [Symbol()]: true }, accessor, Object.defineProperty({}, 'color', { value: '#000000' })]) {
    assert.throws(() => normalize(input), invalid); assert.throws(() => merge({}, input), invalid);
  }
  assert.equal(reads, 0); assert.throws(() => identity({ density: .001 }), invalid);
});

test('exact candidate identities, zero-transmission endpoints and rational half ties retain their byte contract', () => {
  for (const fixture of PHOTO_FILTER_GOLDENS) assert.deepEqual(compile(fixture.parameters)(...fixture.rgb), fixture.expected);
  let seed = 0x51db284; const next = () => seed = (Math.imul(seed,1664525)+1013904223)>>>0;
  for (let gray=0;gray<256;gray++) {
    const h=gray.toString(16).padStart(2,'0'), color=`#${h}${h}${h}`;
    for (const density of [0,.01,25,99.99,100]) {
      assert.equal(identity({color,density}),true); const fn=compile({color,density});
      for(let n=0;n<8;n++){const rgb=[next()>>>24,next()>>>24,next()>>>24];assert.deepEqual(fn(...rgb),rgb);}
    }
  }
  assert.equal(identity({color:'#000000',preserveLuminosity:false}),false);
  assert.equal(identity({color:'#ffffff',preserveLuminosity:false}),true);
  assert.equal(identity({color:'#010203',density:0,preserveLuminosity:false}),true);
  assert.equal(identity(),false);
  for (const density of [0,.01,25,99.99,100]) for (const rgb of [[255,0,0],[0,255,0],[0,0,255],[0,0,0],[255,255,255]])
    assert.deepEqual(compile({color:'#ff9500',density})(...rgb),rgb);
});

test('Photo Filter literal rational bytes stay stable across two fresh ordinary optimized processes', async () => {
  const run=promisify(execFile),worker=new URL('./fixtures/photo-filter/cold-worker.mjs',import.meta.url);
  const first=await run(process.execPath,[worker.pathname],{timeout:15000}),second=await run(process.execPath,[worker.pathname],{timeout:15000});
  assert.equal(first.stderr,'');assert.equal(second.stderr,'');assert.match(first.stdout.trim(),/^[a-f0-9]{64}$/);assert.equal(first.stdout,second.stdout);
});
