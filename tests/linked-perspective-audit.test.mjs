import test from 'node:test';
import assert from 'node:assert/strict';
import { LINKED_PERSPECTIVE_AXES, perspectivePartner, linkedPerspectiveCorners } from '../shared/linked-perspective.mjs';
import { addBinary64Reference, linkedPerspectiveReference, LINKED_PERSPECTIVE_RECTANGLE, LINKED_PERSPECTIVE_GOLDENS } from './fixtures/linked-perspective/reference.mjs';

const options = extra => ({ cornerIndex: 0, axis: 'horizontal', delta: 1, ...extra });
const rectangle = () => LINKED_PERSPECTIVE_RECTANGLE.map(point => ({ ...point }));
const fail = operation => assert.throws(operation, error => error instanceof TypeError && error.code === 'INVALID_ARGUMENT');

test('linked Perspective agrees with independent literal pairs and preserves arbitrary baselines, zero and bounded invalid candidates', () => {
  assert.deepEqual(LINKED_PERSPECTIVE_AXES, ['horizontal', 'vertical']); assert.equal(Object.isFrozen(LINKED_PERSPECTIVE_AXES), true);
  for (const golden of LINKED_PERSPECTIVE_GOLDENS) {
    const input = { cornerIndex: golden.cornerIndex, axis: golden.axis, delta: golden.delta };
    const expected = { corners: golden.corners, partnerIndex: golden.partnerIndex, withinBounds: true };
    assert.deepEqual(linkedPerspectiveReference(LINKED_PERSPECTIVE_RECTANGLE, input), expected);
    assert.deepEqual(linkedPerspectiveCorners(LINKED_PERSPECTIVE_RECTANGLE, input), expected);
    assert.equal(perspectivePartner(golden.cornerIndex, golden.axis), golden.partnerIndex);
  }
  const arbitrary = [{ x: 7.25, y: 11.5 }, { x: 103.5, y: -2.25 }, { x: 94, y: 83 }, { x: -5, y: 79.75 }];
  assert.deepEqual(linkedPerspectiveCorners(arbitrary, options({ cornerIndex: 1, delta: -8.375 })).corners,
    [{ x: 15.625, y: 11.5 }, { x: 95.125, y: -2.25 }, { x: 94, y: 83 }, { x: -5, y: 79.75 }]);
  assert.deepEqual(linkedPerspectiveCorners(arbitrary, options({ cornerIndex: 3, axis: 'vertical', delta: -5.625 })).corners,
    [{ x: 7.25, y: 17.125 }, { x: 103.5, y: -2.25 }, { x: 94, y: 83 }, { x: -5, y: 74.125 }]);
  const original = [{ x: -0, y: Number.MIN_VALUE }, { x: 1, y: -0 }, { x: 1, y: 1 }, { x: -0, y: 1 }];
  for (const delta of [0, -0]) {
    const result = linkedPerspectiveCorners(original, options({ delta }));
    assert.deepEqual(result.corners, original); assert.notEqual(result.corners, original);
    for (let i = 0; i < 4; i++) assert.notEqual(result.corners[i], original[i]);
    result.corners[0].x = 123; assert.equal(Object.is(original[0].x, -0), true);
  }
  const edge = rectangle(); edge[1].x = 16384;
  const out = linkedPerspectiveCorners(edge, options({ delta: -32768 }));
  assert.equal(out.withinBounds, false); assert.equal(out.corners[0].x, -32768); assert.equal(out.corners[1].x, 49152);
  const low = linkedPerspectiveCorners(rectangle(), options({ delta: -200, limit: 100 }));
  assert.equal(low.withinBounds, false); assert.equal(low.corners[0].x, -200); assert.equal(low.corners[1].x, 300);
  // The authoring helper checks the coordinate bound, not native convexity.
  assert.equal(linkedPerspectiveCorners(rectangle(), options({ delta: 60 })).withinBounds, true);
});

test('linked Perspective fixed binary64 order matches an exact-dyadic nearest-even oracle without reconstructing rounded deltas', () => {
  for (const [left, right, expected] of [[.1, .2, .30000000000000004], [.3, -.2, .09999999999999998], [1, 2 ** -53, 1],
    [1, 3 * 2 ** -53, 1 + 2 ** -51], [Number.MIN_VALUE, Number.MIN_VALUE, 1e-323], [-0, -0, -0], [1, -1, 0]])
    assert.equal(addBinary64Reference(left, right), expected);
  const tiny = [{ x: 16384, y: -0 }, { x: 0, y: 0 }, { x: 1, y: Number.MIN_VALUE }, { x: -0, y: 1 }];
  const result = linkedPerspectiveCorners(tiny, options({ delta: 1e-12 }));
  assert.equal(result.corners[0].x, 16384); assert.equal(result.corners[1].x, -1e-12);
  assert.equal(Object.is(result.corners[0].y, -0), true); assert.equal(Object.is(result.corners[3].x, -0), true);
  const pool = [0, -0, Number.MIN_VALUE, -Number.MIN_VALUE, 127 * Number.MIN_VALUE, 2 ** -1022, 1e-300, -1e-300,
    .1, -.3, 2 ** -53, -(2 ** -53), 1, -1, 1 + 2 ** -52, 8192, -8192, 16384 - 2 ** -39, 16384, -16384];
  const deltas = [...pool, 32768, -32768, 32768 - 2 ** -38];
  let state = 0x71942f31;
  const next = length => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % length; };
  for (let i = 0; i < 2048; i++) {
    const baseline = Array.from({ length: 4 }, () => ({ x: pool[next(pool.length)], y: pool[next(pool.length)] }));
    const input = options({ cornerIndex: next(4), axis: i % 2 ? 'horizontal' : 'vertical', delta: deltas[next(deltas.length)] });
    const saved = structuredClone(baseline);
    assert.deepEqual(linkedPerspectiveCorners(baseline, input), linkedPerspectiveReference(baseline, input), `dyadic case ${i}`);
    assert.deepEqual(baseline, saved);
  }
  const baseline = rectangle(), saved = structuredClone(baseline);
  for (const delta of [1, 5, -7, 13.25, -.125, 1e-12, 0]) linkedPerspectiveCorners(baseline, options({ delta }));
  assert.deepEqual(linkedPerspectiveCorners(baseline, options({ delta: 13.25 })), linkedPerspectiveReference(saved, options({ delta: 13.25 })));
  assert.deepEqual(baseline, saved, 'Intermediate events never modify the captured baseline.');
});

test('linked Perspective strictly refuses malformed ownership and bounded inputs before invoking any getter', () => {
  let reads = 0;
  const getter = () => { reads++; return 1; };
  const point = () => ({ x: 0, y: 0 });
  const invalidPoints = [null, [], { x: 0 }, { x: 0, y: 0, z: 0 }, { x: '0', y: 0 }, { x: NaN, y: 0 }, { x: 0, y: Infinity }, { x: 16384.1, y: 0 },
    Object.assign(Object.create({ inherited: true }), point()), Object.defineProperty(point(), 'x', { enumerable: true, get: getter }),
    Object.defineProperty(point(), 'extra', { value: 1 }), { ...point(), [Symbol('extra')]: true }];
  const inheritedPoint = Object.create(null); Object.defineProperty(inheritedPoint, 'x', { enumerable: true, get: getter }); inheritedPoint.y = 0; invalidPoints.push(inheritedPoint);
  for (const bad of invalidPoints) { const baseline = rectangle(); baseline[0] = bad; fail(() => linkedPerspectiveCorners(baseline, options())); }
  const hole = rectangle(); delete hole[1];
  const accessor = rectangle(); Object.defineProperty(accessor, '1', { enumerable: true, get: getter });
  const hidden = rectangle(); Object.defineProperty(hidden, '1', { enumerable: false, value: point() });
  const custom = rectangle(); Object.setPrototypeOf(custom, Object.create(Array.prototype));
  const extra = rectangle(); extra.extra = true;
  const symbol = rectangle(); symbol[Symbol('extra')] = true;
  for (const baseline of [null, {}, [], [...rectangle(), point()], hole, accessor, hidden, custom, extra, symbol]) fail(() => linkedPerspectiveCorners(baseline, options()));
  const invalidOptions = [undefined, null, [], {}, options({ axis: 'x' }), options({ axis: new String('horizontal') }),
    ...[-1, 4, .5, NaN, Infinity, '0'].map(cornerIndex => options({ cornerIndex })),
    ...[undefined, null, NaN, Infinity, -Infinity, '1', 32768.1, -32768.1].map(delta => options({ delta })),
    ...[undefined, null, 0, -1, .5, 16385, Infinity, '100'].map(limit => options({ limit })),
    options({ coordinate: 1 }), { ...options(), [Symbol('extra')]: true }, Object.assign(Object.create({ inherited: true }), options()),
    Object.defineProperty(options(), 'delta', { enumerable: true, get: getter }), Object.defineProperty(options(), 'limit', { enumerable: true, get: getter }),
    Object.defineProperty(options(), 'delta', { enumerable: false, value: 1 })];
  for (const input of invalidOptions) fail(() => linkedPerspectiveCorners(rectangle(), input));
  for (const axis of [null, undefined, 'x', {}, true]) fail(() => perspectivePartner(0, axis));
  for (const index of [-1, 4, .1, '0', undefined]) fail(() => perspectivePartner(index, 'vertical'));
  const own = rectangle().map(item => Object.freeze(Object.assign(Object.create(null), item)));
  Object.freeze(own);
  const input = Object.freeze(Object.assign(Object.create(null), options({ delta: .5 })));
  assert.deepEqual(linkedPerspectiveCorners(own, input), linkedPerspectiveReference(own, input));
  assert.equal(reads, 0);
});
