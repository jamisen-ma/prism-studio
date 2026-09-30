// Editable vector settings are normalized before emitting SVG. No user-supplied
// markup, resource references, CSS, font names or path strings enter the SVG.
const COORD_MIN = -8192;
const COORD_MAX = 16384;
const MAX_PIXELS = 24_000_000;
export const SHAPES = ['rectangle', 'ellipse', 'triangle', 'polygon', 'star', 'line'];
export const GRADIENTS = ['linear', 'radial', 'angle', 'reflected', 'diamond'];
const fail = (message, code = 'INVALID_ARGUMENT') => { throw Object.assign(new Error(message), { code }); };
function number(value, label, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail(`${label} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}.`);
  return value;
}
function point(input, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(`${label} must be a point.`);
  return { x: number(input.x, `${label} x`, COORD_MIN, COORD_MAX), y: number(input.y, `${label} y`, COORD_MIN, COORD_MAX) };
}
function color(value, label, nullable = true) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) fail(`${label} must be #RRGGBB${nullable ? ' or null' : ''}.`);
  return value;
}
function canvas(width, height) {
  number(width, 'canvas width', 1, 8192, true); number(height, 'canvas height', 1, 8192, true);
  if (width * height > MAX_PIXELS) fail('Canvas exceeds the 24-megapixel limit.', 'LIMIT_EXCEEDED');
}
function styles(input, defaults) {
  return { fill: color(input.fill === undefined ? defaults.fill : input.fill, 'fill'), stroke: color(input.stroke === undefined ? defaults.stroke : input.stroke, 'stroke'), strokeWidth: number(input.strokeWidth ?? 2, 'strokeWidth', 0, 100) };
}

export function normalizeShape(input) {
  if (!input || !SHAPES.includes(input.shape)) fail('Unsupported shape.');
  return {
    shape: input.shape,
    ...point(input, 'shape'),
    width: number(input.width, 'shape width', 1, 8192), height: number(input.height, 'shape height', 1, 8192),
    ...styles(input, { fill: '#ffffff', stroke: input.shape === 'line' ? '#ffffff' : null }),
    radius: number(input.radius ?? 0, 'radius', 0, 4096),
    sides: number(input.sides ?? 5, 'sides', 3, 100, true),
    innerRadius: number(input.innerRadius ?? 0.5, 'innerRadius', 0.01, 1),
  };
}

export function normalizePath(input) {
  if (!input || !Array.isArray(input.nodes) || input.nodes.length < 2 || input.nodes.length > 256) fail('A path requires 2–256 nodes.');
  if (input.closed !== undefined && typeof input.closed !== 'boolean') fail('closed must be boolean.');
  const nodes = input.nodes.map((node, index) => ({
    ...point(node, `node ${index}`),
    ...(node.in === undefined ? {} : { in: point(node.in, `node ${index} incoming control`) }),
    ...(node.out === undefined ? {} : { out: point(node.out, `node ${index} outgoing control`) }),
  }));
  return { nodes, closed: input.closed ?? false, ...styles(input, { fill: null, stroke: '#ffffff' }) };
}

export function normalizeGradient(input) {
  if (!input || !GRADIENTS.includes(input.kind)) fail('Unsupported gradient kind.');
  const start = point(input.start, 'gradient start'), end = point(input.end, 'gradient end');
  if (Math.hypot(end.x - start.x, end.y - start.y) < 0.000001) fail('Gradient start and end must be different.');
  if (!Array.isArray(input.stops) || input.stops.length < 2 || input.stops.length > 16) fail('A gradient requires 2–16 stops.');
  const stops = input.stops.map((stop) => {
    if (!stop || typeof stop !== 'object') fail('Invalid gradient stop.');
    return { offset: number(stop.offset, 'stop offset', 0, 1), color: color(stop.color, 'stop color', false), opacity: number(stop.opacity ?? 1, 'stop opacity', 0, 1) };
  });
  if (stops[0].offset !== 0 || stops.at(-1).offset !== 1 || stops.some((stop, index) => index > 0 && stop.offset <= stops[index - 1].offset)) fail('Gradient stops must increase strictly with endpoints at 0 and 1.');
  return { kind: input.kind, start, end, stops };
}

function polygon(settings) {
  const { x, y, width, height, shape, sides, innerRadius } = settings;
  if (shape === 'triangle') return `${x + width / 2},${y} ${x + width},${y + height} ${x},${y + height}`;
  const count = shape === 'star' ? sides * 2 : sides;
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + index * 2 * Math.PI / count;
    const radius = shape === 'star' && index % 2 ? innerRadius : 1;
    return `${x + width / 2 + Math.cos(angle) * width / 2 * radius},${y + height / 2 + Math.sin(angle) * height / 2 * radius}`;
  }).join(' ');
}
function pathData(settings) {
  const { nodes, closed } = settings;
  let data = `M ${nodes[0].x} ${nodes[0].y}`;
  function segment(previous, next) {
    if (previous.out || next.in) {
      const a = previous.out ?? previous, b = next.in ?? next;
      return ` C ${a.x} ${a.y} ${b.x} ${b.y} ${next.x} ${next.y}`;
    }
    return ` L ${next.x} ${next.y}`;
  }
  for (let index = 1; index < nodes.length; index++) data += segment(nodes[index - 1], nodes[index]);
  if (closed) { if (nodes.at(-1).out || nodes[0].in) data += segment(nodes.at(-1), nodes[0]); data += ' Z'; }
  return data;
}

export function vectorSvg(type, input, width, height) {
  canvas(width, height);
  if (!['shape', 'path'].includes(type)) fail('Vector type must be shape or path.');
  const settings = type === 'shape' ? normalizeShape(input) : normalizePath(input);
  const style = `fill="${settings.fill ?? 'none'}" stroke="${settings.stroke ?? 'none'}" stroke-width="${settings.strokeWidth}" stroke-linejoin="round" stroke-linecap="round"`;
  let body;
  if (type === 'path') body = `<path d="${pathData(settings)}" ${style}/>`;
  else {
    const { shape, x, y, width: w, height: h, radius } = settings;
    if (shape === 'rectangle') body = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.min(radius, w / 2, h / 2)}" ${style}/>`;
    else if (shape === 'ellipse') body = `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" ${style}/>`;
    else if (shape === 'line') body = `<line x1="${x}" y1="${y}" x2="${x + w}" y2="${y + h}" ${style}/>`;
    else body = `<polygon points="${polygon(settings)}" ${style}/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

const byte = (value) => Math.max(0, Math.min(255, Math.round(value)));
export function gradientPixels(input, width, height) {
  canvas(width, height);
  const settings = normalizeGradient(input);
  const dx = settings.end.x - settings.start.x, dy = settings.end.y - settings.start.y;
  const squared = dx * dx + dy * dy, length = Math.sqrt(squared), angle = Math.atan2(dy, dx);
  const stops = settings.stops.map((stop) => ({ ...stop, channels: [1, 3, 5].map((offset) => parseInt(stop.color.slice(offset, offset + 2), 16)) }));
  const output = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = x + 0.5 - settings.start.x, py = y + 0.5 - settings.start.y;
    let position;
    switch (settings.kind) {
      case 'radial': position = Math.hypot(px, py) / length; break;
      case 'angle': position = ((Math.atan2(py, px) - angle) / (2 * Math.PI) + 1) % 1; break;
      case 'reflected': position = Math.abs(px * dx + py * dy) / squared; break;
      case 'diamond': position = (Math.abs(px * dx + py * dy) + Math.abs(-px * dy + py * dx)) / squared; break;
      default: position = (px * dx + py * dy) / squared;
    }
    position = Math.max(0, Math.min(1, position));
    let index = 1; while (index < stops.length - 1 && stops[index].offset < position) index++;
    const a = stops[index - 1], b = stops[index], weight = (position - a.offset) / (b.offset - a.offset);
    const alphaA = (1 - weight) * a.opacity, alphaB = weight * b.opacity, alpha = alphaA + alphaB;
    const pixel = (y * width + x) * 4;
    if (alpha > 0) for (let channel = 0; channel < 3; channel++) output[pixel + channel] = byte((a.channels[channel] * alphaA + b.channels[channel] * alphaB) / alpha);
    output[pixel + 3] = byte(alpha * 255);
  }
  return output;
}
