import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';

// Resolve the actual shipped helper and its transitive client dependencies.
// A manually copied subset silently goes stale when clipping adds a dependency.
const server = await createServer({ configFile: false, root: new URL('..', import.meta.url).pathname,
  server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
let helper;
try { helper = await server.ssrLoadModule('/client/guide-snapping.ts'); }
finally { await server.close(); }
const { uniqueGuides, moveSnapReason, snapMove } = helper;

const bounds = Object.freeze({ x: 20, y: 20, width: 10, height: 10 });
const guide = (id, axis, position) => Object.freeze({ id, axis, position });
const resolve = (x, y, guides, options = {}) => snapMove(x, y, options.bounds || bounds, guides, options.sx ?? 1, options.sy ?? 1, options.width ?? 100, options.height ?? 100);

test('actual client guide deduplication and snapping ties are stable, axis-aware and input-preserving', () => {
  const guides = Object.freeze([
    guide('z', 'vertical', 21), guide('b', 'horizontal', 21),
    guide('a', 'vertical', 21), guide('c', 'vertical', 39),
  ]);
  const original = JSON.stringify(guides);
  assert.deepEqual(uniqueGuides(guides).map(item => item.id), ['a', 'b', 'c']);
  assert.deepEqual(uniqueGuides([...guides].reverse()).map(item => item.id), ['a', 'b', 'c']);
  // Both edge candidates are four pixels away. Start edge wins over end edge,
  // independent of original guide order; the same-position stable ID is 'a'.
  for (const candidates of [guides, [...guides].reverse()]) {
    const result = resolve(5, 20, uniqueGuides(candidates));
    assert.equal(result.x, 1);
    assert.equal(result.guides[0].id, 'a');
  }
  const coordinateTie = resolve(5, 20, [guide('z', 'vertical', 29), guide('a', 'vertical', 21)], { bounds: { ...bounds, width: 100 }, width: 200 });
  assert.equal(coordinateTie.x, 1);
  const centerTie = resolve(5, 20, [guide('center', 'vertical', 31), guide('start', 'vertical', 24)]);
  assert.equal(centerTie.x, 4, 'edge beats equally distant center');
  assert.equal(JSON.stringify(guides), original);
});

test('whole-pixel centers can snap; half-pixel centers never cause fractional moves', () => {
  const even = resolve(7, 0, [guide('center', 'vertical', 32)], { sx: 2 });
  assert.equal(even.x, 7);
  assert.equal(even.guides[0].id, 'center');
  const odd = resolve(7, 0, [guide('half-center', 'vertical', 32)], { sx: 2, bounds: { ...bounds, width: 11 } });
  assert.deepEqual(odd, { x: 7, y: 0, guides: [] });
  for (let width = 1; width <= 13; width++) {
    const result = resolve(7, -2, [guide('x', 'vertical', 32), guide('y', 'horizontal', 27)], { bounds: { ...bounds, width, height: width } });
    assert.ok(Number.isInteger(result.x) && Number.isInteger(result.y));
  }
});

test('six CSS pixels is an inclusive threshold at multiple and independent zoom scales', () => {
  // Huge bounds keep the other edge/center candidates outside the tolerance.
  const large = { x: 1000, y: 1000, width: 1000, height: 1000 };
  for (const scale of [0.125, 0.25, 0.5, 1, 2, 3, 6]) {
    const raw = 30, delta = raw + 6 / scale;
    const candidates = [guide('x', 'vertical', large.x + delta)];
    const options = { bounds: large, width: 5000, height: 5000, sx: scale };
    assert.equal(resolve(raw, 10, candidates, options).x, delta, `boundary accepted at ${scale}`);
    assert.deepEqual(resolve(raw - 1, 10, candidates, options), { x: raw - 1, y: 10, guides: [] }, `outside rejected at ${scale}`);
  }
  const anisotropic = resolve(10, 10, [guide('x', 'vertical', 1022), guide('y', 'horizontal', 1013)], { bounds: large, width: 5000, height: 5000, sx: 0.5, sy: 2 });
  assert.deepEqual(anisotropic, { x: 22, y: 13, guides: [guide('x', 'vertical', 1022), guide('y', 'horizontal', 1013)] });
});

test('no-op clicks, rejected clipped candidates and free-move clipping retain their contracts', () => {
  const nearby = [guide('x', 'vertical', 21), guide('y', 'horizontal', 21)];
  assert.deepEqual(resolve(0, 0, nearby), { x: 0, y: 0, guides: [] });
  assert.deepEqual(resolve(-0, 0, nearby), { x: 0, y: 0, guides: [] });
  const edge = resolve(-18, 1, [guide('edge', 'vertical', 0)]);
  assert.equal(edge.x, -20, 'exact canvas contact is allowed');
  const wouldClip = resolve(-23, 1, [guide('invalid', 'vertical', 5)]);
  assert.equal(wouldClip.x, -20, 'nearest clipped trailing candidate is discarded in favor of a valid center');
  const allClipped = resolve(-30, 1, [guide('invalid', 'vertical', 0)]);
  assert.deepEqual(allClipped, { x: -30, y: 1, guides: [] });
  const otherAxisClips = resolve(5, -30, [guide('x', 'vertical', 26)]);
  assert.deepEqual(otherAxisClips, { x: 5, y: -30, guides: [] }, 'do not advertise an X snap when final bounds are clipped on Y');
  assert.deepEqual(resolve(12, 13, []), { x: 12, y: 13, guides: [] });
});

test('snapping eligibility checks mask and dissolve ancestry, generated provenance and all four edges', () => {
  const root = { id: 'root', type: 'group', blendMode: 'normal' };
  const group = { id: 'group', type: 'group', parentId: 'root', blendMode: 'multiply' };
  const leaf = { id: 'leaf', type: 'raster', parentId: 'group', blendMode: 'normal' };
  const document = { width: 100, height: 100, layers: [root, group, leaf] };
  const reason = (changes = {}, layer = leaf, box = bounds) => moveSnapReason({ ...document, ...changes }, layer, box);
  assert.equal(reason(), '');
  for (const index of [0, 1, 2]) {
    const masked = document.layers.map((layer, n) => n === index ? { ...layer, mask: { type: 'rectangle' } } : layer);
    assert.match(reason({ layers: masked }, masked[2]), /document-anchored masks/);
    const dissolved = document.layers.map((layer, n) => n === index ? { ...layer, blendMode: 'dissolve' } : layer);
    assert.match(reason({ layers: dissolved }, dissolved[2]), /dissolve/);
  }
  for (const metadata of [{ role: 'generated' }, { provenance: { jobId: 'saved-job' } }, { provenance: { jobId: 'saved-job', imported: true } }]) {
    assert.match(reason({}, { ...leaf, ...metadata }), /generated layers/);
    assert.equal(reason({}, { ...leaf, ...metadata, protected: true }), '');
  }
  const clipped = { ...leaf, id: 'clipped', clipBaseId: leaf.id };
  const clippingDocument = { ...document, layers: [...document.layers, clipped] };
  assert.match(moveSnapReason(clippingDocument, leaf, bounds), /clipping-chain participants/);
  assert.match(moveSnapReason(clippingDocument, clipped, bounds), /clipping-chain participants/);
  for (const box of [{ ...bounds, x: 0 }, { ...bounds, y: 0 }, { ...bounds, x: 90 }, { ...bounds, y: 90 }, { ...bounds, x: -1 }]) assert.match(reason({}, leaf, box), /canvas edge/);
  assert.match(moveSnapReason(null, leaf, bounds), /Select/);
  assert.match(moveSnapReason(document, undefined, bounds), /Select/);
  assert.match(moveSnapReason(document, leaf, null), /Select/);
});

// Independent oracle: scan integer candidate translations rather than building
// a guide/anchor Cartesian product. Integer valid bounds make this exhaustive.
function reference(x, y, box, guides, sx, sy, width, height) {
  if (x === 0 && y === 0) return { x: 0, y: 0, guides: [] };
  function axis(raw, start, size, limit, scale, orientation) {
    const eligible = [];
    for (let delta = -start; delta <= limit - start - size; delta++) {
      if (Math.abs(delta - raw) * scale > 6) continue;
      for (const [priority, anchor] of [start, start + size, start + size / 2].entries()) {
        if (!Number.isInteger(anchor)) continue;
        for (const item of guides) if (item.axis === orientation && item.position === anchor + delta) eligible.push({ delta, distance: Math.abs(delta - raw) * scale, priority, item });
      }
    }
    eligible.sort((a, b) => a.distance - b.distance || a.priority - b.priority || a.item.position - b.item.position || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0));
    return eligible[0];
  }
  const a = axis(x, box.x, box.width, width, sx, 'vertical');
  const b = axis(y, box.y, box.height, height, sy, 'horizontal');
  const dx = a?.delta ?? x, dy = b?.delta ?? y;
  if (box.x + dx < 0 || box.y + dy < 0 || box.x + box.width + dx > width || box.y + box.height + dy > height) return { x, y, guides: [] };
  return { x: dx, y: dy, guides: [a?.item, b?.item].filter(Boolean) };
}

test('seeded small-canvas cases match an exhaustive translation oracle across zoom, ties and clipping', () => {
  let state = 0x607e91;
  const random = max => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % max; };
  for (let trial = 0; trial < 360; trial++) {
    const width = 12 + random(18), height = 12 + random(18);
    const box = { x: 1 + random(4), y: 1 + random(4), width: 1 + random(6), height: 1 + random(6) };
    const x = random(39) - 19, y = random(39) - 19;
    const scales = [0.25, 0.5, 1, 1.25, 2, 3];
    const sx = scales[random(scales.length)], sy = scales[random(scales.length)];
    const guides = Array.from({ length: 12 }, (_, index) => {
      const axis = random(2) ? 'horizontal' : 'vertical';
      return guide(`g${String(index).padStart(2, '0')}`, axis, random((axis === 'horizontal' ? height : width) + 1));
    });
    const expected = reference(x, y, box, guides, sx, sy, width, height);
    assert.deepEqual(snapMove(x, y, box, guides, sx, sy, width, height), expected, `seeded case ${trial}`);
    assert.deepEqual(snapMove(x, y, box, [...guides].reverse(), sx, sy, width, height), expected, `reversed case ${trial}`);
  }
});
