import { randomUUID } from 'node:crypto';

export const MAX_GUIDES = 64;
export const GUIDE_AXES = Object.freeze(['horizontal', 'vertical']);
export const GUIDE_COMMANDS = Object.freeze(['add_guide', 'update_guide', 'delete_guide', 'clear_guides']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = (message, code = 'INVALID_ARGUMENT') => { throw Object.assign(new Error(message), { code }); };
const check = (condition, message, code) => { if (!condition) fail(message, code); };
function dimensions(width, height) {
  check(Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && width <= 8192 && height <= 8192 && width * height <= 24_000_000, 'Guide canvas dimensions exceed native image limits.', 'LIMIT_EXCEEDED');
}
function position(value, axis, width, height) {
  check(GUIDE_AXES.includes(axis), 'Guide axis must be horizontal or vertical.');
  const limit = axis === 'horizontal' ? height : width;
  check(Number.isInteger(value) && value >= 0 && value <= limit, `Guide position must be an integer between 0 and ${limit}, including canvas edges.`);
  return value;
}

export function normalizeGuides(guides = [], width, height) {
  dimensions(width, height);
  check(Array.isArray(guides), 'Document guides must be an array.');
  check(guides.length <= MAX_GUIDES, 'Documents support up to 64 guides.', 'LIMIT_EXCEEDED');
  const seen = new Set();
  return guides.map(guide => {
    check(guide && typeof guide === 'object' && !Array.isArray(guide) && Object.keys(guide).every(key => ['id', 'axis', 'position'].includes(key)), 'Invalid document guide fields.');
    check(typeof guide.id === 'string' && UUID.test(guide.id) && !seen.has(guide.id), 'Guide identifiers must be unique UUIDs.'); seen.add(guide.id);
    return { id: guide.id, axis: guide.axis, position: position(guide.position, guide.axis, width, height) };
  });
}

export function validateGuides(graph) {
  if (graph.guides !== undefined) normalizeGuides(graph.guides, graph.width, graph.height);
}

/** Pure metadata edit; coordinates may coincide and preserve distinct IDs. */
export function updatedGuides(graph, command, args) {
  check(GUIDE_COMMANDS.includes(command), 'Unsupported guide command.', 'UNSUPPORTED');
  const fields = ['documentId', 'expectedRevision', ...({ add_guide: ['axis', 'position'], update_guide: ['guideId', 'position'], delete_guide: ['guideId'], clear_guides: [] })[command]];
  check(args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).every(key => fields.includes(key)), 'Invalid guide command fields. A guide’s axis cannot be changed.');
  const guides = normalizeGuides(graph.guides, graph.width, graph.height);
  if (command === 'clear_guides') return { guides: [], label: 'Clear guides' };
  if (command === 'add_guide') {
    check(guides.length < MAX_GUIDES, 'Documents support up to 64 guides. Delete a guide before adding another.', 'LIMIT_EXCEEDED');
    guides.push({ id: randomUUID(), axis: args.axis, position: position(args.position, args.axis, graph.width, graph.height) });
    return { guides, label: 'Add guide' };
  }
  check(typeof args.guideId === 'string' && UUID.test(args.guideId), 'Choose an existing guide UUID.');
  const guide = guides.find(item => item.id === args.guideId);
  check(guide, 'Guide was not found.', 'NOT_FOUND');
  if (command === 'delete_guide') return { guides: guides.filter(item => item.id !== guide.id), label: 'Delete guide' };
  check(args.axis === undefined, 'A guide’s axis is fixed. Add a new guide to change its orientation.');
  guide.position = position(args.position, guide.axis, graph.width, graph.height);
  return { guides, label: 'Move guide' };
}

/** Transform from old document geometry exactly once. Clipped guides are
 * removed, not clamped onto unrelated edges; ordinary history restores them. */
export function transformGuides(guides, transform, oldWidth, oldHeight) {
  const source = normalizeGuides(guides, oldWidth, oldHeight);
  check(transform && ['crop', 'resize', 'canvas'].includes(transform.type), 'Unsupported guide geometry transform.');
  dimensions(transform.width, transform.height);
  if (transform.type === 'crop') check(Number.isInteger(transform.x) && Number.isInteger(transform.y) && transform.x >= 0 && transform.y >= 0 && transform.x + transform.width <= oldWidth && transform.y + transform.height <= oldHeight, 'Guide crop must fit within the previous canvas.');
  if (transform.type === 'canvas') check(Number.isInteger(transform.x) && Number.isInteger(transform.y) && Math.abs(transform.x) <= 8192 && Math.abs(transform.y) <= 8192, 'Guide canvas offsets must be bounded integers.');
  return source.map(guide => {
    const horizontal = guide.axis === 'horizontal', oldSize = horizontal ? oldHeight : oldWidth, newSize = horizontal ? transform.height : transform.width;
    const shift = horizontal ? transform.y : transform.x;
    const value = transform.type === 'resize' ? Math.max(0, Math.min(newSize, Math.round(guide.position * newSize / oldSize)))
      : guide.position + (transform.type === 'crop' ? -shift : shift);
    return { ...guide, position: value };
  }).filter(guide => guide.position >= 0 && guide.position <= (guide.axis === 'horizontal' ? transform.height : transform.width));
}
