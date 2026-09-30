import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transformWithOxc } from 'vite';

const temporary = await mkdtemp(join(tmpdir(), 'prism-curves-banks-client-audit-'));
after(() => rm(temporary, { recursive: true, force: true }));
const { code } = await transformWithOxc(await readFile(new URL('../client/curves.ts', import.meta.url), 'utf8'), 'curves.ts');
await writeFile(join(temporary, 'curves.mjs'), code.replaceAll('../shared/', new URL('../shared/', import.meta.url).href));
const { CURVE_BANK_NAMES, curveParameters, curveCommandParameters, toCurvesEditorDraft, parseCurvesEditorDraft, invalidCurveBanks,
  upgradeCurvesDraft, collapseCurvesDraft, resetCurvesEditorDraft, supportsCurveBanks, supportsCurves, curvesCapabilityKey } = await import(pathToFileURL(join(temporary, 'curves.mjs')).href);
const identity = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
const precise = [{ x: 0, y: .25 }, { x: Number.MIN_VALUE, y: .5 }, { x: 1, y: 70.125 }, { x: 1 + 2 ** -52, y: 200.75 }, { x: 255, y: 254.5 }];
const complete = () => curveParameters({ mode: 'banks', banks: Object.fromEntries(CURVE_BANK_NAMES.map((name, i) => [name, { points: structuredClone(precise), interpolation: i % 2 ? 'smooth' : 'linear' }])) });

test('actual banks client retains every exact hidden draft and validates/reset banks without collapsing representation', () => {
  const parameters = complete(), draft = toCurvesEditorDraft(parameters);
  for (const name of CURVE_BANK_NAMES) {
    draft.banks[name].points[1].x = '5e-324';
    draft.banks[name].points[2].y = '7.0125e1';
  }
  const snapshot = structuredClone(draft);
  assert.deepEqual(parseCurvesEditorDraft(draft), parameters);
  assert.deepEqual(invalidCurveBanks(draft), []);
  for (const name of CURVE_BANK_NAMES) for (const axis of ['x', 'y']) {
    const invalid = structuredClone(draft); invalid.banks[name].points[2][axis] = '1e';
    assert.equal(parseCurvesEditorDraft(invalid), null); assert.deepEqual(invalidCurveBanks(invalid), [name]);
    assert.equal(invalid.banks[name].points[2][axis], '1e');
  }
  const both = structuredClone(draft);
  both.banks.red.points[2].x = both.banks.red.points[1].x;
  both.banks.blue.points.at(-1).x = '254.99';
  assert.deepEqual(invalidCurveBanks(both), ['red', 'blue']); assert.equal(parseCurvesEditorDraft(both), null);
  assert.deepEqual(draft, snapshot);
  const reset = resetCurvesEditorDraft(draft); assert.equal(reset.mode, 'banks');
  for (const name of CURVE_BANK_NAMES) assert.deepEqual(parseCurvesEditorDraft(reset).banks[name], { points: identity, interpolation: 'linear' });
  reset.banks.master.points[0].y = '99'; assert.equal(reset.banks.red.points[0].y, '0');
  assert.deepEqual(draft, snapshot);
  const parsed = parseCurvesEditorDraft(draft); parsed.banks.green.points[2].y = 1;
  assert.equal(draft.banks.green.points[2].y, '7.0125e1');
});

test('actual banks client stages explicit exact conversions and emits a complete single replacement after banks', () => {
  for (const channel of ['rgb', 'red', 'green', 'blue']) for (const interpolation of ['linear', 'smooth']) {
    const single = toCurvesEditorDraft({ points: precise, channel, interpolation });
    single.single.points[2].y = '7.0125e1'; const saved = structuredClone(single);
    const bankName = channel === 'rgb' ? 'master' : channel, upgraded = upgradeCurvesDraft(single);
    assert.equal(upgraded.mode, 'banks');
    assert.deepEqual(upgraded.banks[bankName], { points: single.single.points, interpolation });
    for (const name of CURVE_BANK_NAMES.filter(name => name !== bankName)) assert.deepEqual(parseCurvesEditorDraft(upgraded).banks[name], { points: identity, interpolation: 'linear' });
    assert.deepEqual(collapseCurvesDraft(upgraded, bankName), single);
    assert.deepEqual(single, saved);
    const back = parseCurvesEditorDraft(collapseCurvesDraft(upgraded, bankName));
    assert.deepEqual(curveCommandParameters(back, parseCurvesEditorDraft(upgraded)), { mode: 'single', points: precise, channel, interpolation });
    upgraded.banks[bankName].points[2].y = '3'; assert.equal(single.single.points[2].y, '7.0125e1');
  }
  const invalidSingle = toCurvesEditorDraft(); invalidSingle.single.points[0].y = '1e';
  assert.equal(upgradeCurvesDraft(invalidSingle), null);
  const invalidBanks = toCurvesEditorDraft(complete()); invalidBanks.banks.blue.points[0].y = '1e';
  assert.equal(collapseCurvesDraft(invalidBanks, 'master'), null);
  const banks = complete(); assert.deepEqual(curveCommandParameters(banks, { points: identity }), banks);
  const single = { points: identity, channel: 'red' };
  assert.deepEqual(curveCommandParameters(single, { ...single, interpolation: 'smooth' }), { ...single, interpolation: 'linear' });
  assert.deepEqual(curveCommandParameters(single, single), single);
  assert.equal(resetCurvesEditorDraft(toCurvesEditorDraft(single)).mode, 'single');
});

test('actual banks semantic gates include every hidden Smooth bank and keep old single/global/source support independent', () => {
  const caps = { id: 'native', curvesBanksPolicy: 'master-byte-then-channel-byte-v1', curvesBankNames: [...CURVE_BANK_NAMES],
    curvesInterpolationPolicy: 'shape-preserving-pchip-v1', curvesInterpolationModes: ['linear', 'smooth'],
    adjustmentKinds: ['curves'], layerFilterKinds: ['curves'], layerFilterCoordinates: 'source' };
  const linear = curveParameters({ mode: 'banks' });
  for (const scope of ['global', 'source']) {
    assert.equal(supportsCurveBanks(caps, 'native', scope), true);
    assert.equal(supportsCurveBanks({ ...caps, curvesBankNames: [...CURVE_BANK_NAMES, 'future'] }, 'native', scope), true);
    const noSmooth = { ...caps, curvesInterpolationPolicy: undefined, curvesInterpolationModes: undefined };
    assert.equal(supportsCurves(noSmooth, 'native', linear, scope), true);
    for (const name of CURVE_BANK_NAMES) {
      const hidden = structuredClone(linear); hidden.banks[name].interpolation = 'smooth';
      assert.equal(supportsCurves(caps, 'native', hidden, scope), true);
      assert.equal(supportsCurves(noSmooth, 'native', hidden, scope), false);
    }
    for (const patch of [{ curvesBanksPolicy: undefined }, { curvesBanksPolicy: 'future' }, { curvesBankNames: undefined },
      { curvesBankNames: [] }, { curvesBankNames: CURVE_BANK_NAMES.slice(1) }, { curvesBankNames: [...CURVE_BANK_NAMES, false] }, { id: 'photoshop' }]) {
      const bad = { ...caps, ...patch };
      assert.equal(supportsCurves(bad, 'native', linear, scope), false);
      assert.notEqual(curvesCapabilityKey(bad), curvesCapabilityKey(caps));
    }
    assert.equal(supportsCurves(undefined, 'native', { points: identity }, scope), true);
    assert.equal(supportsCurves({ ...caps, curvesBanksPolicy: undefined, curvesBankNames: undefined }, 'native', { points: identity, interpolation: 'smooth' }, scope), true);
    assert.equal(supportsCurves(caps, 'photoshop', linear, scope), false);
  }
  assert.equal(supportsCurves({ ...caps, adjustmentKinds: [] }, 'native', linear, 'source'), true);
  assert.equal(supportsCurves({ ...caps, adjustmentKinds: [] }, 'native', linear, 'global'), false);
  assert.equal(supportsCurves({ ...caps, layerFilterKinds: [], layerFilterCoordinates: undefined }, 'native', linear, 'global'), true);
  assert.equal(supportsCurves({ ...caps, layerFilterCoordinates: 'canvas' }, 'native', linear, 'source'), false);
});
