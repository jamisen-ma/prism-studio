const fail = (message, code = 'INVALID_ARGUMENT') => { throw Object.assign(new Error(message), { code }); };
const whole = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function checked({ items, width, height, axis }, minimum) {
  if (!whole(width, 1, 8192) || !whole(height, 1, 8192) || width * height > 24_000_000) fail('Arrangement canvas exceeds native image limits.', 'LIMIT_EXCEEDED');
  if (!['horizontal', 'vertical'].includes(axis)) fail('Arrangement axis must be horizontal or vertical.');
  if (!Array.isArray(items) || items.length < minimum || items.length > 64) fail(`Choose ${minimum}–64 content layers for this arrangement.`);
  const seen = new Set();
  return items.map((item, index) => {
    if (!item || typeof item.id !== 'string' || !item.id || seen.has(item.id)) fail('Arrangement layer identifiers must be unique.');
    seen.add(item.id);
    const box = item.bounds;
    if (!box || !whole(box.x, 0, width - 1) || !whole(box.y, 0, height - 1) || !whole(box.width, 1, width) || !whole(box.height, 1, height) || box.x + box.width > width || box.y + box.height > height) fail('Each content bound must be a nonempty integer rectangle inside the canvas.');
    return { ...item, bounds: { ...box }, index, start: axis === 'horizontal' ? box.x : box.y, size: axis === 'horizontal' ? box.width : box.height };
  });
}

function plan(items, axis, width, height, targetStart) {
  return items.map((item, index) => {
    const amount = Math.round(targetStart(item, index) - item.start) || 0;
    const x = axis === 'horizontal' ? amount : 0, y = axis === 'vertical' ? amount : 0;
    if (item.bounds.x + x < 0 || item.bounds.y + y < 0 || item.bounds.x + x + item.bounds.width > width || item.bounds.y + y + item.bounds.height > height) fail('This arrangement would clip layer content at the canvas edge. Move the endpoints or expand the canvas first.');
    return { layerId: item.id, x, y };
  });
}

export function planAlignment({ items, width, height, axis, alignment, relativeTo = 'canvas' }) {
  if (!['canvas', 'layers'].includes(relativeTo)) fail('Alignment reference must be canvas or layers.');
  if (!['start', 'center', 'end'].includes(alignment)) fail('Alignment must be start, center or end.');
  const checkedItems = checked({ items, width, height, axis }, relativeTo === 'layers' ? 2 : 1);
  const start = relativeTo === 'canvas' ? 0 : Math.min(...checkedItems.map((item) => item.start));
  const end = relativeTo === 'canvas' ? (axis === 'horizontal' ? width : height) : Math.max(...checkedItems.map((item) => item.start + item.size));
  return plan(checkedItems, axis, width, height, (item) => alignment === 'start' ? start : alignment === 'end' ? end - item.size : (start + end - item.size) / 2);
}

export function planDistribution({ items, width, height, axis, spacing = 'gaps' }) {
  if (!['centers', 'gaps'].includes(spacing)) fail('Distribution spacing must be centers or gaps.');
  // Input order is canonical document order, independent of click/request
  // order. Equal centers retain that order deterministically.
  const ordered = checked({ items, width, height, axis }, 3).sort((a, b) => (a.start + a.size / 2) - (b.start + b.size / 2) || a.index - b.index);
  const first = ordered[0], last = ordered.at(-1);
  let target;
  if (spacing === 'centers') {
    const start = first.start + first.size / 2, end = last.start + last.size / 2;
    target = (item, index) => start + (end - start) * index / (ordered.length - 1) - item.size / 2;
  } else {
    const span = last.start + last.size - first.start, occupied = ordered.reduce((sum, item) => sum + item.size, 0);
    if (span < occupied) fail('The fixed endpoints leave insufficient room for nonoverlapping equal gaps. Move them farther apart or use center spacing.');
    const gap = (span - occupied) / (ordered.length - 1), starts = []; let cursor = first.start;
    for (const item of ordered) { starts.push(cursor); cursor += item.size + gap; }
    target = (item, index) => starts[index];
  }
  const result = plan(ordered, axis, width, height, target);
  // Mathematical endpoints already coincide; retain exact zero translations
  // instead of allowing accumulated floating-point error to affect them.
  result[0].x = result[0].y = result.at(-1).x = result.at(-1).y = 0;
  return result;
}
