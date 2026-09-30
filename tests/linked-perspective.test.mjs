import test from 'node:test';
import assert from 'node:assert/strict';
import { LINKED_PERSPECTIVE_AXES, perspectivePartner, linkedPerspectiveCorners } from '../shared/linked-perspective.mjs';

const rectangle = () => [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }];
const move = (baseline, cornerIndex, axis, delta, extra = {}) => linkedPerspectiveCorners(baseline, { cornerIndex, axis, delta, ...extra });
const invalid = action => assert.throws(action, { code: 'INVALID_ARGUMENT' });

test('Linked Perspective pins every corner pairing and arbitrary saved quad without rectification', () => {
  assert.deepEqual(LINKED_PERSPECTIVE_AXES, ['horizontal', 'vertical']);
  assert.ok(Object.isFrozen(LINKED_PERSPECTIVE_AXES));
  const goldens = [
    ['horizontal', 0, [10, 90, 100, 0]], ['horizontal', 1, [-10, 110, 100, 0]],
    ['horizontal', 2, [0, 100, 110, -10]], ['horizontal', 3, [0, 100, 90, 10]],
    ['vertical', 0, [10, 0, 80, 70]], ['vertical', 1, [0, 10, 70, 80]],
    ['vertical', 2, [0, -10, 90, 80]], ['vertical', 3, [-10, 0, 80, 90]]
  ];
  for (const [axis, index, values] of goldens) {
    const baseline = rectangle(), output = move(baseline, index, axis, 10), coordinate = axis === 'horizontal' ? 'x' : 'y';
    assert.deepEqual(output.corners.map(point => point[coordinate]), values);
    const other = coordinate === 'x' ? 'y' : 'x';
    assert.deepEqual(output.corners.map(point => point[other]), baseline.map(point => point[other]));
    assert.equal(output.partnerIndex, (axis === 'horizontal' ? [1, 0, 3, 2] : [3, 2, 1, 0])[index]);
    assert.equal(output.withinBounds, true);
  }
  const arbitrary = [{ x: 7.25, y: 11.5 }, { x: 103.5, y: -2.25 }, { x: 94, y: 83 }, { x: -5, y: 79.75 }];
  assert.deepEqual(move(arbitrary, 1, 'horizontal', -8.375).corners, [{ x: 15.625, y: 11.5 }, { x: 95.125, y: -2.25 }, { x: 94, y: 83 }, { x: -5, y: 79.75 }]);
  assert.deepEqual(move(arbitrary, 3, 'vertical', -5.625).corners, [{ x: 7.25, y: 17.125 }, { x: 103.5, y: -2.25 }, { x: 94, y: 83 }, { x: -5, y: 74.125 }]);
});

test('Linked Perspective preserves signed zero, tiny displacements and exact baseline ownership', () => {
  const baseline = [{ x: -0, y: -0 }, { x: 16384, y: Number.MIN_VALUE }, { x: 1, y: 2 }, { x: 0, y: 3 }];
  baseline.forEach(Object.freeze); Object.freeze(baseline);
  for (const delta of [0, -0]) {
    const output = move(baseline, 0, 'horizontal', delta).corners;
    assert.deepEqual(output, baseline); assert.notEqual(output, baseline);
    for (let i = 0; i < 4; i++) assert.notEqual(output[i], baseline[i]);
    assert.ok(Object.is(output[0].x, -0)); assert.ok(Object.is(output[0].y, -0));
  }
  const tiny = move(baseline, 1, 'horizontal', 1e-12);
  assert.equal(tiny.corners[1].x, 16384); assert.equal(tiny.corners[0].x, -1e-12);
  assert.ok(Object.is(tiny.corners[0].y, -0)); assert.equal(tiny.corners[1].y, Number.MIN_VALUE);
  const subnormal = move(baseline, 0, 'horizontal', Number.MIN_VALUE);
  assert.equal(subnormal.corners[0].x, Number.MIN_VALUE); assert.equal(subnormal.corners[1].x, 16384);
  const halfUlp = move([{ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], 0, 'horizontal', 2 ** -53);
  assert.equal(halfUlp.corners[0].x, 1); assert.equal(halfUlp.corners[1].x, -(2 ** -53));
  tiny.corners[3].x = 900; assert.equal(baseline[3].x, 0);
  let output;
  for (let i = 0; i <= 1000; i++) output = move(baseline, 1, 'horizontal', i / 100000);
  assert.deepEqual(output, move(baseline, 1, 'horizontal', .01));
});

test('Linked Perspective bounds return the full invalid candidate without geometry or corner clamping', () => {
  const baseline = [{ x: -100, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: -100, y: 80 }];
  assert.deepEqual(move(baseline, 0, 'horizontal', -200, { limit: 100 }), {
    corners: [{ x: -300, y: 0 }, { x: 300, y: 0 }, { x: 100, y: 80 }, { x: -100, y: 80 }], partnerIndex: 1, withinBounds: false
  });
  assert.equal(move(rectangle(), 0, 'horizontal', 60).withinBounds, true); // Native convexity validation remains separate.
  for (const delta of [NaN, Infinity, -Infinity, 32768.00000001, -32768.00000001, '1', null, undefined]) invalid(() => move(rectangle(), 0, 'horizontal', delta));
  for (const limit of [0, -1, 1.5, 16385, '100', undefined]) invalid(() => move(rectangle(), 0, 'horizontal', 1, { limit }));
  invalid(() => move(rectangle(), 0, 'horizontal', 1, { limit: 99 }));
  for (const [index, axis] of [[-1, 'horizontal'], [4, 'horizontal'], [.5, 'vertical'], ['0', 'vertical'], [0, 'x'], [0, null]]) invalid(() => perspectivePartner(index, axis));
});

test('Linked Perspective rejects malformed shape and accessors before invoking input getters', () => {
  let calls = 0;
  const getter = () => { calls++; return 0; };
  for (const key of ['cornerIndex', 'axis', 'delta', 'limit']) {
    const options = { cornerIndex: 0, axis: 'horizontal', delta: 1, limit: 16384 };
    Object.defineProperty(options, key, { enumerable: true, get: getter });
    invalid(() => linkedPerspectiveCorners(rectangle(), options));
  }
  for (const key of ['x', 'y']) {
    const points = rectangle(); Object.defineProperty(points[0], key, { enumerable: true, get: getter });
    invalid(() => move(points, 0, 'horizontal', 1));
  }
  const indexed = rectangle(); Object.defineProperty(indexed, '0', { enumerable: true, get: getter }); invalid(() => move(indexed, 0, 'horizontal', 1));
  const inherited = rectangle(); inherited[0] = Object.create({ get x() { return getter(); }, get y() { return getter(); } }); invalid(() => move(inherited, 0, 'horizontal', 1));
  for (const malformed of [null, [], rectangle().slice(1), [...rectangle(), { x: 0, y: 0 }]]) invalid(() => move(malformed, 0, 'horizontal', 1));
  for (const change of [p => { delete p[1]; }, p => { p.extra = 1; }, p => { p[Symbol('hidden')] = 1; }, p => { Object.setPrototypeOf(p, null); }, p => { Object.defineProperty(p, '2', { enumerable: false }); }, p => { p[0].extra = 1; }, p => { Object.defineProperty(p[0], 'x', { enumerable: false }); }, p => { p[0][Symbol('hidden')] = 1; }]) {
    const points = rectangle(); change(points); invalid(() => move(points, 0, 'horizontal', 1));
  }
  invalid(() => linkedPerspectiveCorners(rectangle(), Object.create({ get axis() { return getter(); } })));
  invalid(() => move(rectangle(), 0, 'horizontal', 1, { extra: true }));
  assert.equal(calls, 0);
  const points = rectangle().map(point => Object.freeze(Object.assign(Object.create(null), point)));
  const options = Object.freeze(Object.assign(Object.create(null), { cornerIndex: 0, axis: 'horizontal', delta: 10 }));
  assert.equal(linkedPerspectiveCorners(Object.freeze(points), options).corners[0].x, 10);
});
