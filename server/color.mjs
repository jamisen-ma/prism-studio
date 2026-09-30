import { normalizeColorLookupParameters } from '../shared/color-lookup.mjs';
import { TONAL_COLOR_KINDS, normalizeTonalParameters, tonalColorTransform } from './tonal-color.mjs';
import { CURVES_INTERPOLATION_MODES, compileSmoothCurveLookup } from '../shared/smooth-curves.mjs';
import { CURVES_BANKS_CACHE_BYTES, normalizeCurvesBanksParameters, mergeCurvesBanksParameters, compileCurvesBanksLookup } from '../shared/curves-banks.mjs';
import { normalizeSelectiveColorParameters, selectiveColorTransform } from './selective-color.mjs';
import { normalizeHueSaturationParameters, hueSaturationTransform } from './hue-saturation.mjs';
import { normalizePhotoFilterParameters, photoFilterTransform } from './photo-filter.mjs';

export const ADJUSTMENTS = { exposure: [-5, 5], brightness: [-100, 100], contrast: [-100, 100], saturation: [-100, 100], temperature: [-100, 100], blur: [0, 50], sharpen: [0, 10], vibrance: [-100, 100], hue: [-180, 180], highlights: [-100, 100], shadows: [-100, 100], levels: [0, 0], curves: [0, 0] };
Object.assign(ADJUSTMENTS,{invert:[0,100],grayscale:[0,100],sepia:[0,100],posterize:[2,256],threshold:[0,255],median:[1,15],mosaic:[1,128]});
Object.assign(ADJUSTMENTS, { channel_mixer: [0, 0], gradient_map: [0, 0], color_balance: [0, 0], black_white: [0, 0], selective_color: [0, 0], hue_saturation: [0, 0], color_lookup: [0, 0], photo_filter: [0, 0] });
export const PARAMETERIZED_ADJUSTMENTS = Object.freeze(['levels', 'curves', 'channel_mixer', 'gradient_map', ...TONAL_COLOR_KINDS, 'selective_color', 'hue_saturation', 'color_lookup', 'photo_filter']);
export const COLOR_MAPPING_KINDS = Object.freeze(['channel_mixer', 'gradient_map', ...TONAL_COLOR_KINDS, 'selective_color', 'hue_saturation', 'color_lookup', 'photo_filter']);
// Bound the costlier pointwise color paths even on an 8192-pixel row.
export const colorTransformYieldRows = (kind, width) => ['color_lookup', 'photo_filter'].includes(kind) ? Math.max(1, Math.floor(16_384 / width)) : ['color_balance', 'selective_color', 'hue_saturation'].includes(kind) ? Math.min(32, Math.max(1, Math.floor(65_536 / width))) : 32;
const fail = (message) => { throw Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' }); };
const finite = (n, label, min, max) => { if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) fail(`${label} must be between ${min} and ${max}.`); return n; };
const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));

export function normalizeParameters(kind, parameters) {
  if (kind === 'photo_filter') return normalizePhotoFilterParameters(parameters);
  if (kind === 'color_lookup') return normalizeColorLookupParameters(parameters);
  if (kind === 'hue_saturation') return normalizeHueSaturationParameters(parameters);
  if (kind === 'selective_color') return normalizeSelectiveColorParameters(parameters);
  if (TONAL_COLOR_KINDS.includes(kind)) return normalizeTonalParameters(kind, parameters);
  if (parameters !== undefined && (!parameters || typeof parameters !== 'object' || Array.isArray(parameters))) fail('Adjustment parameters must be an object.');
  if (kind === 'channel_mixer') {
    const input = { monochrome: false, red: [100, 0, 0, 0], green: [0, 100, 0, 0], blue: [0, 0, 100, 0], gray: [21.26, 71.52, 7.22, 0], ...parameters };
    if (Object.keys(input).some(key => !['monochrome', 'red', 'green', 'blue', 'gray'].includes(key))) fail('Unsupported channel mixer parameter.');
    if (typeof input.monochrome !== 'boolean') fail('Channel mixer monochrome must be boolean.');
    const result = { monochrome: input.monochrome };
    for (const channel of ['red', 'green', 'blue', 'gray']) {
      const row = input[channel];
      if (!Array.isArray(row) || row.length !== 4) fail(`Channel mixer ${channel} requires exactly four percentages: red, green, blue and constant.`);
      result[channel] = Array.from(row, value => {
        finite(value, 'Channel mixer percentage', -200, 200);
        if (Math.round(value * 100) / 100 !== value) fail('Channel mixer percentages must use 0.01% increments.');
        return value;
      });
    }
    return result;
  }
  if (kind === 'gradient_map') {
    const input = { stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }], reverse: false, ...parameters };
    if (Object.keys(input).some(key => !['stops', 'reverse'].includes(key))) fail('Unsupported gradient map parameter.');
    if (typeof input.reverse !== 'boolean') fail('Gradient map reverse must be boolean.');
    if (!Array.isArray(input.stops) || input.stops.length < 2 || input.stops.length > 16) fail('Gradient maps require 2–16 RGB color stops.');
    const stops = Array.from(input.stops, stop => {
      if (!stop || typeof stop !== 'object' || Array.isArray(stop) || Object.keys(stop).some(key => !['offset', 'color'].includes(key))) fail('A gradient map stop accepts offset and color only.');
      const offset = finite(stop.offset, 'Gradient map offset', 0, 1);
      if (typeof stop.color !== 'string' || !/^#[a-f0-9]{6}$/i.test(stop.color)) fail('Gradient map colors must use #RRGGBB.');
      return { offset, color: stop.color.toLowerCase() };
    });
    if (stops[0].offset !== 0 || stops.at(-1).offset !== 1 || stops.some((stop, index) => index && stop.offset <= stops[index - 1].offset)) fail('Gradient map offsets must increase strictly from zero to one.');
    return { stops, reverse: input.reverse };
  }
  if (kind === 'levels') {
    const input = { black: 0, white: 255, gamma: 1, outputBlack: 0, outputWhite: 255, ...parameters };
    if (Object.keys(input).some((key) => !['black', 'white', 'gamma', 'outputBlack', 'outputWhite'].includes(key))) fail('Unsupported levels parameter.');
    const result = { black: finite(input.black, 'black', 0, 254), white: finite(input.white, 'white', 1, 255), gamma: finite(input.gamma, 'gamma', 0.1, 10), outputBlack: finite(input.outputBlack, 'outputBlack', 0, 255), outputWhite: finite(input.outputWhite, 'outputWhite', 0, 255) };
    if (result.black >= result.white || result.outputBlack > result.outputWhite) fail('Levels require black < white and outputBlack <= outputWhite.');
    return result;
  }
  if (kind === 'curves') {
    const marked = markedCurvesParameters(parameters);
    if (marked?.mode === 'banks') return normalizeCurvesBanksParameters(marked);
    if (marked) { const { mode, ...single } = marked; parameters = single; }
    const input = { points: [{ x: 0, y: 0 }, { x: 255, y: 255 }], channel: 'rgb', ...parameters };
    if (Object.keys(input).some((key) => !['points', 'channel', 'interpolation'].includes(key))) fail('Unsupported curves parameter.');
    const interpolation = input.interpolation === undefined ? 'linear' : input.interpolation;
    if (!CURVES_INTERPOLATION_MODES.includes(interpolation)) fail('Curves interpolation must be linear or smooth.');
    if (!['rgb', 'red', 'green', 'blue'].includes(input.channel)) fail('Curves channel must be rgb, red, green or blue.');
    if (!Array.isArray(input.points) || input.points.length < 2 || input.points.length > 16) fail('Curves require 2–16 points.');
    const points = input.points.map((p) => ({ x: finite(p?.x, 'curve x', 0, 255), y: finite(p?.y, 'curve y', 0, 255) }));
    if (points[0].x !== 0 || points.at(-1).x !== 255 || points.some((p, i) => i && p.x <= points[i - 1].x)) fail('Curve x values must increase strictly, with endpoints at 0 and 255.');
    return { points, channel: input.channel, ...(interpolation === 'smooth' ? { interpolation } : {}) };
  }
  if (parameters && Object.keys(parameters).length) fail(`${kind} does not accept additional parameters.`);
  return undefined;
}

// Only new marked representations use strict data-property validation. The
// unmarked legacy normalizer and its point acceptance remain unchanged.
function markedCurvesParameters(parameters) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) || (!Object.hasOwn(parameters, 'mode') && !Object.hasOwn(parameters, 'banks'))) return null;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(parameters))) fail('Marked Curves parameters must be a plain object.');
  for (const key of Reflect.ownKeys(parameters)) {
    const descriptor = Object.getOwnPropertyDescriptor(parameters, key);
    if (typeof key !== 'string' || !['mode', 'banks', 'points', 'channel', 'interpolation'].includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('Unsupported marked Curves parameter.');
  }
  if (parameters.mode !== 'single' && parameters.mode !== 'banks') fail('Curves mode must be single or banks.');
  if (parameters.mode === 'single' && Object.hasOwn(parameters, 'banks')) fail('Single Curves cannot contain banks.');
  if (parameters.mode === 'banks' && ['points', 'channel', 'interpolation'].some(key => Object.hasOwn(parameters, key))) fail('Banked and single Curves fields cannot mix.');
  return parameters;
}

export function mergeCurvesParameters(current, patch) {
  const previous = normalizeParameters('curves', current);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('Curves parameters must be an object.');
  const marked = markedCurvesParameters(patch);
  if (Reflect.ownKeys(patch).length === 0) {
    if (previous.mode === 'banks' && ![Object.prototype, null].includes(Object.getPrototypeOf(patch))) fail('Curve banks require plain parameter patches.');
    return previous;
  }
  if (!marked) {
    if (previous.mode === 'banks') fail('Choose mode single explicitly to replace curve banks.');
    return normalizeParameters('curves', { ...previous, ...patch });
  }
  if (marked.mode === 'banks') return previous.mode === 'banks' ? mergeCurvesBanksParameters(previous, marked) : normalizeCurvesBanksParameters(marked);
  const { mode, ...single } = marked;
  return normalizeParameters('curves', previous.mode === 'banks' ? single : { ...previous, ...single });
}

/** Conservative once-per-graph setup reserve, including hidden adjustments.
 * No LUT allocation during metadata admission; source-only Bake excludes it. */
export const globalCurvesBanksCacheBytes = graph => graph.layers.some(layer => layer.type === 'adjustment' && layer.kind === 'curves' && layer.parameters?.mode === 'banks' && layer.opacity > 0) ? CURVES_BANKS_CACHE_BYTES : 0;

export function adjustmentTransform(layer) {
  if (layer.kind === 'photo_filter') return photoFilterTransform(layer.parameters);
  const { kind, value } = layer;
  if (kind === 'color_lookup') fail('Color Lookup must be prepared with a verified asset reader.');
  if (kind === 'hue_saturation') return hueSaturationTransform(layer.parameters);
  if (kind === 'selective_color') return selectiveColorTransform(layer.parameters);
  if (TONAL_COLOR_KINDS.includes(kind)) return tonalColorTransform(kind, layer.parameters);
  if (kind === 'invert') {
    // Compile this scalar branch once, preserving the original arithmetic.
    // Avoid the nested per-pixel map/switch closure on optimized cold renders.
    return (r, g, b) => [clamp(r + (255 - 2 * r) * value / 100), clamp(g + (255 - 2 * g) * value / 100), clamp(b + (255 - 2 * b) * value / 100)];
  }
  if (kind === 'shadows' || kind === 'highlights') {
    // Compile the tonal branch once. Keep the established arithmetic order,
    // without a per-pixel map callback capturing the scalar switch context.
    const highlights = kind === 'highlights';
    return (r, g, b) => {
      const luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
      const tonalAmount = highlights ? (luma / 255) ** 2 : (1 - luma / 255) ** 2;
      const offset = value * 1.275 * tonalAmount;
      return [clamp(r + offset), clamp(g + offset), clamp(b + offset)];
    };
  }
  if (kind === 'channel_mixer') {
    const parameters = normalizeParameters(kind, layer.parameters);
    const rows = (parameters.monochrome ? [parameters.gray] : [parameters.red, parameters.green, parameters.blue])
      .map(row => row.map(percentage => Math.round(percentage * 100)));
    // The signed numerator is an exact integer, at most 20,400,000 in
    // magnitude. Compile once; clamp only after the complete channel sum.
    return (r, g, b) => {
      const output = rows.map(([red, green, blue, constant]) => clamp((r * red + g * green + b * blue + 255 * constant) / 10000));
      return parameters.monochrome ? [output[0], output[0], output[0]] : output;
    };
  }
  if (kind === 'gradient_map') {
    const parameters = normalizeParameters(kind, layer.parameters);
    const stops = parameters.stops.map(stop => ({ offset: stop.offset, position: stop.offset * 2550000, rgb: [1, 3, 5].map(index => parseInt(stop.color.slice(index, index + 2), 16)) }));
    return (r, g, b) => {
      const numerator = 2126 * r + 7152 * g + 722 * b;
      const position = parameters.reverse ? 2550000 - numerator : numerator;
      const tone = position / 2550000;
      let low = 0, high = stops.length - 1;
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (tone <= stops[middle].offset) high = middle;
        else low = middle;
      }
      const a = stops[low], z = stops[high];
      // Compare the authored offsets before scaling: multiplying a very close
      // arbitrary offset by the tone denominator can round its position.
      if (tone === a.offset) return [...a.rgb];
      if (tone === z.offset) return [...z.rgb];
      const interval = z.position - a.position, distance = position - a.position;
      if (interval === 0) {
        // Distinct finite authored offsets may collapse to one scaled float.
        // Keep that valid narrow interval finite using its original spacing.
        const amount = (tone - a.offset) / (z.offset - a.offset);
        return a.rgb.map((channel, index) => clamp(channel + (z.rgb[index] - channel) * amount));
      }
      // Avoid an early normalized-tone division, which can turn exact x.5
      // byte ties into x.499999999. Integer stop positions have exact weighted
      // numerators; arbitrary finite stops retain native floating interpolation.
      return a.rgb.map((channel, index) => clamp((channel * interval + (z.rgb[index] - channel) * distance) / interval));
    };
  }
  if (kind === 'curves' && markedCurvesParameters(layer.parameters)?.mode === 'banks') {
    const lookup = compileCurvesBanksLookup(layer.parameters);
    return (r, g, b) => [lookup[r], lookup[256 + g], lookup[512 + b]];
  }
  if (kind === 'curves' && layer.parameters?.interpolation === 'smooth') {
    const parameters = normalizeParameters(kind, layer.parameters), lookup = compileSmoothCurveLookup(parameters.points), channel = parameters.channel;
    return (r, g, b) => [channel === 'rgb' || channel === 'red' ? lookup[r] : r, channel === 'rgb' || channel === 'green' ? lookup[g] : g, channel === 'rgb' || channel === 'blue' ? lookup[b] : b];
  }
  if (kind === 'curves' || kind === 'levels') {
    const parameters = normalizeParameters(kind, layer.parameters), lookup = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      if (kind === 'levels') {
        const scaled = Math.max(0, Math.min(1, (i - parameters.black) / (parameters.white - parameters.black)));
        lookup[i] = clamp(parameters.outputBlack + scaled ** (1 / parameters.gamma) * (parameters.outputWhite - parameters.outputBlack));
      } else {
        const points = parameters.points;
        let segment = 1; while (segment < points.length - 1 && points[segment].x < i) segment++;
        const a = points[segment - 1], b = points[segment];
        lookup[i] = clamp(a.y + (b.y - a.y) * (i - a.x) / (b.x - a.x));
      }
    }
    const channel = kind === 'levels' ? 'rgb' : parameters.channel;
    return (r, g, b) => [channel === 'rgb' || channel === 'red' ? lookup[r] : r, channel === 'rgb' || channel === 'green' ? lookup[g] : g, channel === 'rgb' || channel === 'blue' ? lookup[b] : b];
  }
  const factor = kind === 'exposure' ? 2 ** value : kind === 'contrast' ? (value >= 0 ? 1 + 3 * value / 100 : 1 + value / 100) : 1;
  return (r, g, b) => {
    const luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
    if (kind === 'hue') return rotateHue(r, g, b, value);
    if (kind === 'threshold') { const tone = clamp(luma) >= value ? 255 : 0; return [tone,tone,tone]; }
    if (kind === 'sepia') {
      const tones = [clamp(.393*r+.769*g+.189*b),clamp(.349*r+.686*g+.168*b),clamp(.272*r+.534*g+.131*b)];
      return [r,g,b].map((channel,index)=>clamp(channel+(tones[index]-channel)*value/100));
    }
    let saturation = 1 + value / 100;
    if (kind === 'vibrance') saturation = 1 + value / 100 * (1 - (Math.max(r, g, b) - Math.min(r, g, b)) / 255);
    return [r, g, b].map((channel, index) => {
      switch (kind) {
        case 'exposure': return clamp(channel * factor);
        case 'brightness': return clamp(channel + value * 2.55);
        case 'contrast': return clamp((channel - 127.5) * factor + 127.5);
        case 'saturation': case 'vibrance': return clamp(luma + (channel - luma) * saturation);
        case 'temperature': return clamp(channel + (index === 0 ? value * 0.4 : index === 2 ? -value * 0.4 : 0));
        case 'grayscale': return clamp(channel + (luma - channel) * value / 100);
        case 'posterize': return clamp(Math.round(channel * (value - 1) / 255) * 255 / (value - 1));
        default: return channel;
      }
    });
  };
}

function rotateHue(red, green, blue, degrees) {
  const r = red / 255, g = green / 255, b = blue / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  if (delta === 0 || degrees === 0) return [red, green, blue];
  let hue = max === r ? (g - b) / delta : max === g ? 2 + (b - r) / delta : 4 + (r - g) / delta;
  hue = ((hue * 60 + degrees) % 360 + 360) % 360 / 60;
  const x = delta * (1 - Math.abs(hue % 2 - 1));
  const channels = hue < 1 ? [delta, x, 0] : hue < 2 ? [x, delta, 0] : hue < 3 ? [0, delta, x] : hue < 4 ? [0, x, delta] : hue < 5 ? [x, 0, delta] : [delta, 0, x];
  return channels.map((channel) => clamp((channel + min) * 255));
}
