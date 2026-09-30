import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transformWithOxc } from 'vite';

const temporary = await mkdtemp(join(tmpdir(), 'prism-smooth-client-audit-'));
after(() => rm(temporary, { recursive: true, force: true }));
const source = await readFile(new URL('../client/curves.ts', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source, 'curves.ts');
await writeFile(join(temporary, 'curves.mjs'), code.replace('../shared/smooth-curves.mjs', new URL('../shared/smooth-curves.mjs', import.meta.url).href));
const { toCurvesDraft, parseCurvesDraft, curveParameters, curveCommandParameters, dragCurvePoint, supportsCurves, curvesCapabilityKey } = await import(pathToFileURL(join(temporary, 'curves.mjs')).href);
const p = { points: [{ x: 0, y: .25 }, { x: .1, y: 80.125 }, { x: .2, y: 200.75 }, { x: 255, y: 254.5 }], channel: 'blue', interpolation: 'smooth' };

test('actual curve draft parser preserves narrow fractions, untouched axes and invalid text until deliberate correction', () => {
  const draft = toCurvesDraft(p); draft.points[1].x = '1e-1'; draft.points[1].y = '8.0125e1';
  assert.deepEqual(parseCurvesDraft(draft), p);
  const vertical = dragCurvePoint(draft, 1, 0, 1.5); assert.equal(vertical.points[1].x, '1e-1'); assert.equal(vertical.points[1].y, '82');
  const narrow = dragCurvePoint(draft, 1, 5, 0); assert.deepEqual(narrow, draft); assert.notEqual(narrow, draft);
  assert.deepEqual(dragCurvePoint(draft, 1, 0, 0), draft);
  const horizontal = dragCurvePoint(draft, 2, 4, 0); assert.equal(horizontal.points[2].x, '4'); assert.equal(horizontal.points[2].y, draft.points[2].y);
  const endpoint = dragCurvePoint(draft, 0, 50, 1); assert.equal(endpoint.points[0].x, '0');
  for (const text of ['', '1e', 'Infinity', 'NaN', '0x10', '-1', '256']) { const invalid = structuredClone(draft); invalid.points[1].y = text; assert.equal(parseCurvesDraft(invalid), null); assert.equal(invalid.points[1].y, text); }
  const tiny = toCurvesDraft({ points: [{ x: 0, y: 0 }, { x: Number.MIN_VALUE, y: .5 }, { x: 1, y: 1 }, { x: 1 + 2 ** -52, y: 2 }, { x: 255, y: 255 }], interpolation: 'smooth' });
  assert.equal(parseCurvesDraft(tiny).points[1].x, Number.MIN_VALUE); assert.equal(parseCurvesDraft(tiny).points[3].x, 1 + 2 ** -52);
  const duplicate = structuredClone(draft); duplicate.points[2].x = duplicate.points[1].x; assert.equal(parseCurvesDraft(duplicate), null);
  assert.equal(draft.points[1].y, '8.0125e1');
});

test('actual curve canonicalization separates partial-update Linear reset from saved recipe omission', () => {
  const linear = curveParameters({ ...p, interpolation: 'linear' }); assert.equal(Object.hasOwn(linear, 'interpolation'), false);
  assert.deepEqual(curveCommandParameters(linear, p), { ...linear, interpolation: 'linear' });
  assert.deepEqual(curveCommandParameters(linear, linear), linear); assert.equal(Object.hasOwn(curveCommandParameters(linear), 'interpolation'), false);
  assert.deepEqual(curveCommandParameters(p, linear), p);
  const parsed = parseCurvesDraft(toCurvesDraft(linear)); assert.deepEqual(parsed, linear);
  const copy = curveParameters(p); copy.points[1].x = 30; assert.equal(p.points[1].x, .1);
});

test('actual Smooth capability gates require Native and independent global/source scopes while Linear remains legacy', () => {
  const caps = { id: 'native', curvesInterpolationPolicy: 'shape-preserving-pchip-v1', curvesInterpolationModes: ['linear', 'smooth'], adjustmentKinds: ['curves'], layerFilterKinds: ['curves'], layerFilterCoordinates: 'source' };
  for (const scope of ['global', 'source']) {
    assert.equal(supportsCurves(caps, 'native', p, scope), true);
    for (const fields of [{ curvesInterpolationPolicy: 'unknown' }, { curvesInterpolationModes: [] }, { curvesInterpolationModes: ['future'] }, { curvesInterpolationModes: ['smooth', 1] }, { id: 'photoshop' }]) {
      assert.equal(supportsCurves({ ...caps, ...fields }, 'native', p, scope), false);
      assert.equal(supportsCurves({ ...caps, ...fields }, 'native', { interpolation: 'linear' }, scope), true);
    }
    assert.equal(supportsCurves({ ...caps, id: 'photoshop' }, 'photoshop', p, scope), false);
    assert.equal(supportsCurves(undefined, 'native', {}, scope), true);
  }
  assert.equal(supportsCurves({ ...caps, adjustmentKinds: [] }, 'native', p, 'global'), false);
  assert.equal(supportsCurves({ ...caps, adjustmentKinds: [] }, 'native', p, 'source'), true);
  assert.equal(supportsCurves({ ...caps, layerFilterKinds: [] }, 'native', p, 'global'), true);
  assert.equal(supportsCurves({ ...caps, layerFilterCoordinates: 'canvas' }, 'native', p, 'source'), false);
  assert.notEqual(curvesCapabilityKey(caps), curvesCapabilityKey({ ...caps, curvesInterpolationModes: ['linear'] }));
});
