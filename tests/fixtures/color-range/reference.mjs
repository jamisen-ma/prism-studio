// Independently authored expected values. No production or prototype imports.
const halfUp = (numerator, denominator) => (2n * numerator + denominator) / (2n * denominator);

export function rangeMembershipReference(distance, tolerance, falloff) {
  if (![distance, tolerance, falloff].every(value => Number.isInteger(value) && value >= 0 && value <= 255)) throw Error('Byte-distance input required');
  if (distance <= tolerance) return 255;
  if (!falloff || distance >= tolerance + falloff) return 0;
  return Number(halfUp(255n * BigInt(tolerance + falloff - distance), BigInt(falloff)));
}

export function rangeAlphaReference(membership, alpha, invert = false) {
  if (![membership, alpha].every(value => Number.isInteger(value) && value >= 0 && value <= 255)) throw Error('Alpha8 input required');
  const value = Number(halfUp(BigInt(membership) * BigInt(alpha), 255n));
  return invert ? 255 - value : value;
}

// Callers supply trusted authored fixtures; this is an arithmetic oracle, not a
// second copy of the public strict settings validator.
function reference(parameters) {
  const { colors, tolerance = 32, falloff = 32, invert = false } = parameters;
  const swatches = colors.map(color => [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16)));
  return (pixels, offset) => {
    let nearest = 255;
    for (const swatch of swatches) {
      let farthest = 0;
      for (let channel = 0; channel < 3; channel++) farthest = Math.max(farthest, Math.abs(pixels[offset + channel] - swatch[channel]));
      nearest = Math.min(nearest, farthest);
    }
    return rangeAlphaReference(rangeMembershipReference(nearest, tolerance, falloff), pixels[offset + 3], invert);
  };
}

export function colorRangeReference(rgba, parameters) { return reference(parameters)(rgba, 0); }

export function colorRangePlaneReference(rgba, parameters) {
  if (rgba.length % 4) throw Error('Complete RGBA8 pixels required');
  const expected = Buffer.alloc(rgba.length / 4), pixel = reference(parameters);
  for (let i = 0; i < expected.length; i++) expected[i] = pixel(rgba, 4 * i);
  return expected;
}

export function colorRangePreviewReference(rgba, sourceWidth, sourceHeight, parameters, maxEdge = 700) {
  if (rgba.length !== 4 * sourceWidth * sourceHeight) throw Error('Matching RGBA8 frame required');
  const longest = Math.max(sourceWidth, sourceHeight);
  const scaled = dimension => maxEdge >= longest ? dimension : Math.max(1, Number(halfUp(BigInt(dimension) * BigInt(maxEdge), BigInt(longest))));
  const width = scaled(sourceWidth), height = scaled(sourceHeight), gray = Buffer.alloc(width * height), pixel = reference(parameters);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = Number(BigInt(2 * x + 1) * BigInt(sourceWidth) / BigInt(2 * width));
    const sy = Number(BigInt(2 * y + 1) * BigInt(sourceHeight) / BigInt(2 * height));
    gray[y * width + x] = pixel(rgba, 4 * (sy * sourceWidth + sx));
  }
  return { width, height, gray };
}

export const COLOR_RANGE_GOLDENS = [
  { rgba: [1, 0, 0, 2], parameters: { colors: ['#000000'], tolerance: 0, falloff: 4 }, expected: 1 },
  { rgba: [1, 0, 0, 2], parameters: { colors: ['#000000'], tolerance: 0, falloff: 4, invert: true }, expected: 254 },
  { rgba: [1, 0, 0, 255], parameters: { colors: ['#000000'], tolerance: 0, falloff: 2 }, expected: 128 },
  { rgba: [2, 0, 0, 255], parameters: { colors: ['#000000'], tolerance: 0, falloff: 2 }, expected: 0 },
  { rgba: [0, 0, 0, 128], parameters: { colors: ['#000000'], tolerance: 0, falloff: 0 }, expected: 128 },
  { rgba: [255, 255, 255, 255], parameters: { colors: ['#000000'], tolerance: 200, falloff: 100 }, expected: 115 },
  { rgba: [255, 255, 255, 255], parameters: { colors: ['#000000'], tolerance: 255, falloff: 255 }, expected: 255 },
  { rgba: [32, 0, 0, 255], parameters: { colors: ['#000000'], tolerance: 32, falloff: 0 }, expected: 255 },
  { rgba: [33, 0, 0, 255], parameters: { colors: ['#000000'], tolerance: 32, falloff: 0 }, expected: 0 },
  { rgba: [13, 97, 201, 0], parameters: { colors: ['#000000'], invert: true }, expected: 255 },
  { rgba: [10, 0, 0, 255], parameters: { colors: ['#000000', '#140000'], tolerance: 0, falloff: 20 }, expected: 128 },
];

// SHA-256 of complete512×512 coverage planes derived with the BigInt oracle.
export const COLOR_RANGE_PHOTO_GOLDENS = [
  { parameters: { colors: ['#e06942'], tolerance: 32, falloff: 32, invert: false }, sha256: '2d25efef20df18a0d6a47e8cf9210e3b2a2ee16844158a4854dd4a6ba27b4b3a' },
  { parameters: { colors: ['#e06942', '#190d38'], tolerance: 32, falloff: 32, invert: false }, sha256: 'ba2b5e03ce0cc97b83e47150405caec44d0750b194ddd068ea2ea83474a49ab5' },
];
