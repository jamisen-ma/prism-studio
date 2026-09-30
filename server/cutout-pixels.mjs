const fail = (message) => { throw Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' }); };
function valid(pixels, width, height) {
  if (!Buffer.isBuffer(pixels) || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 24_000_000 || pixels.length !== width * height * 4) fail('Invalid cutout pixel buffer.');
}

export function combineAlpha(pixels, alpha) {
  if (!Buffer.isBuffer(pixels) || !Buffer.isBuffer(alpha) || pixels.length !== alpha.length * 4) fail('Cutout alpha dimensions do not match the source image.');
  const output = Buffer.from(pixels);
  for (let index = 0; index < alpha.length; index++) output[index * 4 + 3] = Math.round(pixels[index * 4 + 3] * alpha[index] / 255);
  return output;
}

export function alphaBounds(pixels, width, height) {
  valid(pixels, width, height);
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (pixels[(y * width + x) * 4 + 3] > 0) {
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  return right < left ? null : { left, top, width: right - left + 1, height: bottom - top + 1 };
}

// Euclidean outside stroke using a separable squared-distance transform. Its
// cost is linear in canvas pixels rather than proportional to stroke area.
// Every pixel with any subject alpha remains untouched, including soft edges.
export function outsideOutline(pixels, width, height, outline, coverage = () => 1) {
  valid(pixels, width, height);
  if (!outline || !Number.isFinite(outline.width) || outline.width < 0 || outline.width > 64 || !/^#[a-f0-9]{6}$/i.test(outline.color)) fail('Invalid outside outline settings.');
  const output = Buffer.alloc(pixels.length);
  if (outline.width === 0) return output;
  const far = 4356, horizontal = new Uint16Array(width * height), occupied = new Uint8Array(width * height);
  let any = false;
  for (let y = 0; y < height; y++) {
    let distance = 66;
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      occupied[index] = pixels[index * 4 + 3] > 0 && coverage(x, y) > 0 ? 1 : 0;
      if (occupied[index]) { distance = 0; any = true; } else distance = Math.min(66, distance + 1);
      horizontal[index] = distance * distance;
    }
    distance = 66;
    for (let x = width - 1; x >= 0; x--) {
      const index = y * width + x;
      distance = occupied[index] ? 0 : Math.min(66, distance + 1);
      horizontal[index] = Math.min(horizontal[index], distance * distance);
    }
  }
  if (!any) return output;
  const vertices = new Int32Array(height), boundaries = new Float64Array(height + 1), column = new Float64Array(height);
  const rgb = [1, 3, 5].map((offset) => parseInt(outline.color.slice(offset, offset + 2), 16));
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) column[y] = horizontal[y * width + x] ?? far;
    let k = 0; vertices[0] = 0; boundaries[0] = -Infinity; boundaries[1] = Infinity;
    for (let y = 1; y < height; y++) {
      let intersection;
      for (;;) {
        const previous = vertices[k];
        intersection = ((column[y] + y * y) - (column[previous] + previous * previous)) / (2 * (y - previous));
        if (intersection > boundaries[k]) break;
        k--;
      }
      k++; vertices[k] = y; boundaries[k] = intersection; boundaries[k + 1] = Infinity;
    }
    k = 0;
    for (let y = 0; y < height; y++) {
      while (boundaries[k + 1] < y) k++;
      const index = y * width + x;
      if (occupied[index]) continue;
      const squared = (y - vertices[k]) ** 2 + column[vertices[k]];
      const alpha = Math.round(255 * Math.max(0, Math.min(1, outline.width + 1 - Math.sqrt(squared))));
      if (alpha === 0) continue;
      output[index * 4] = rgb[0]; output[index * 4 + 1] = rgb[1]; output[index * 4 + 2] = rgb[2]; output[index * 4 + 3] = alpha;
    }
  }
  return output;
}
