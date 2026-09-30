import { randomUUID } from 'node:crypto';
import { normalizeMask, maskCoverage, bitmapMask } from './masks.mjs';

export const MAX_SAVED_SELECTIONS = 16;
export const SAVED_SELECTION_COMMANDS = ['save_selection', 'load_selection', 'rename_selection', 'delete_selection'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = (message, code = 'INVALID_ARGUMENT') => { throw Object.assign(new Error(message), { code }); };
function selectionName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) fail('Selection name must contain 1–200 characters.');
  return value.trim();
}
function validateMask(mask, width, height) {
  const normalized = normalizeMask(mask, width, height, { persisted: true });
  if (['bitmap', 'alpha8'].includes(normalized.shape) && (normalized.width !== width || normalized.height !== height)) fail('Saved bitmap selection dimensions must match the canvas.');
}

export function validateSavedSelections(graph) {
  if (graph.savedSelections === undefined) return;
  if (!Array.isArray(graph.savedSelections)) fail('Saved selections must be an array.');
  if (graph.savedSelections.length > MAX_SAVED_SELECTIONS) fail('Documents support up to 16 saved selections.', 'LIMIT_EXCEEDED');
  const seen = new Set();
  for (const saved of graph.savedSelections) {
    if (!saved || !UUID.test(saved.id) || seen.has(saved.id)) fail('Saved selection identifiers must be unique UUIDs.');
    seen.add(saved.id); selectionName(saved.name); validateMask(saved.mask, graph.width, graph.height);
  }
}

export function combineSelections(active, saved, width, height, mode) {
  if (!['replace', 'add', 'subtract', 'intersect'].includes(mode)) fail('Selection mode must be replace, add, subtract or intersect.');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 24_000_000) fail('Selection dimensions exceed native image limits.', 'LIMIT_EXCEEDED');
  validateMask(saved, width, height);
  if (mode === 'replace' || (!active && mode === 'add')) return structuredClone(saved);
  if (!active) fail('Create an active selection before subtracting or intersecting a saved selection.', 'NO_SELECTION');
  validateMask(active, width, height);
  const a = maskCoverage(active), b = maskCoverage(saved), pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const left = a(x, y), right = b(x, y);
    const amount = mode === 'add' ? Math.max(left, right) : mode === 'subtract' ? left * (1 - right) : left * right;
    pixels[y * width + x] = Math.max(0, Math.min(255, Math.round(amount * 255)));
  }
  // Combining bakes feather/inversion/clipping once into reusable RGBA8 alpha;
  // the existing run-count limit prevents oversized metadata graphs.
  return bitmapMask(pixels, width, height);
}

export function mutateSavedSelection(graph, command, args) {
  const saved = graph.savedSelections ?? [], existing = saved.find((item) => item.id === args.selectionId);
  if (args.selectionId !== undefined) {
    if (typeof args.selectionId !== 'string' || !UUID.test(args.selectionId)) fail('Invalid saved selection identifier.');
    if (!existing) fail('Saved selection was not found.', 'NOT_FOUND');
  }
  if (command === 'save_selection') {
    if (!graph.selection) fail('Create an active selection before saving it.', 'NO_SELECTION');
    if (!existing && saved.length >= MAX_SAVED_SELECTIONS) fail('Documents support up to 16 saved selections. Overwrite or delete an existing selection.', 'LIMIT_EXCEEDED');
    validateMask(graph.selection, graph.width, graph.height);
    const entry = { id: existing?.id ?? randomUUID(), name: selectionName(args.name ?? existing?.name ?? `Selection ${saved.length + 1}`), mask: structuredClone(graph.selection) };
    graph.savedSelections = existing ? saved.map((item) => item === existing ? entry : item) : [...saved, entry];
    return existing ? 'Update saved selection' : 'Save selection';
  }
  if (!existing) fail('Select a saved selection first.', 'NOT_FOUND');
  if (command === 'load_selection') {
    graph.selection = combineSelections(graph.selection, existing.mask, graph.width, graph.height, args.mode ?? 'replace');
    return args.mode && args.mode !== 'replace' ? `Load selection (${args.mode})` : 'Load saved selection';
  }
  if (command === 'rename_selection') {
    graph.savedSelections = saved.map((item) => item === existing ? { ...item, name: selectionName(args.name) } : item);
    return 'Rename saved selection';
  }
  if (command === 'delete_selection') {
    graph.savedSelections = saved.filter((item) => item !== existing);
    return 'Delete saved selection';
  }
  fail('Unsupported saved selection command.', 'UNSUPPORTED');
}
