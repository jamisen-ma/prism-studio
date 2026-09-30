import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { NativeBackend } from '../server/native.mjs';
import { maskCoverage, bitmapMask } from '../server/masks.mjs';
import { combineSelections, validateSavedSelections } from '../server/saved-selections.mjs';

const coded = (code) => (cause) => cause.code === code;
const edit = async (native, doc, command, args = {}) => (await native.execute(command, { documentId: doc.id, expectedRevision: doc.revision, ...args })).document;
const get = async (native, doc) => (await native.execute('get_document', { documentId: doc.id })).document;
const bytes = (mask, width, height) => { const coverage = maskCoverage(mask); return Uint8Array.from({ length: width * height }, (_, i) => Math.round(coverage(i % width, Math.floor(i / width)) * 255)); };
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-saved-selection-'));
  const native = await new NativeBackend({ dataDir }).init();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const document = (await native.execute('create_document', { width: 8, height: 8, background: '#804020' })).document;
  return { dataDir, native, document };
}

test('saved selections own independent editable masks and never change source pixels or assets', async (t) => {
  const { dataDir, native, document: initial } = await fixture(t);
  assert.deepEqual(initial.savedSelections, []);
  const original = await native.renderGraph(initial), assets = await fs.readdir(path.join(dataDir, 'assets'));
  let doc = await edit(native, initial, 'select_region', { shape: 'ellipse', x: 1, y: 1, width: 5, height: 5, feather: 1, invert: true });
  const mask = structuredClone(doc.selection);
  doc = await edit(native, doc, 'save_selection', { name: 'Subject edge' }); const id = doc.savedSelections[0].id;
  assert.deepEqual(doc.savedSelections[0].mask, mask); assert.equal(doc.savedSelections[0].name, 'Subject edge');
  doc = await edit(native, doc, 'modify_selection', { feather: 2, invert: false });
  assert.deepEqual(doc.savedSelections[0].mask, mask);
  doc = await edit(native, doc, 'clear_selection');
  doc = await edit(native, doc, 'load_selection', { selectionId: id }); assert.deepEqual(doc.selection, mask);
  doc = await edit(native, doc, 'modify_selection', { feather: 3 });
  doc = await edit(native, doc, 'save_selection', { selectionId: id });
  assert.equal(doc.savedSelections.length, 1); assert.equal(doc.savedSelections[0].id, id); assert.equal(doc.savedSelections[0].name, 'Subject edge'); assert.equal(doc.savedSelections[0].mask.feather, 3);
  assert.deepEqual(await native.renderGraph(doc), original); assert.deepEqual(await fs.readdir(path.join(dataDir, 'assets')), assets);
  doc.savedSelections[0].mask.feather = 77;
  assert.equal((await get(native, doc)).savedSelections[0].mask.feather, 3, 'returned metadata is detached from the engine');
});

test('partial alpha selection combinations have defined endpoints and never alias inputs', () => {
  const active = bitmapMask(Uint8Array.from([0, 64, 128, 255]), 4, 1), saved = bitmapMask(Uint8Array.from([255, 128, 64, 0]), 4, 1);
  const originalA = structuredClone(active), originalB = structuredClone(saved);
  assert.deepEqual([...bytes(combineSelections(active, saved, 4, 1, 'add'), 4, 1)], [255, 128, 128, 255]);
  assert.deepEqual([...bytes(combineSelections(active, saved, 4, 1, 'subtract'), 4, 1)], [0, 32, 96, 255]);
  assert.deepEqual([...bytes(combineSelections(active, saved, 4, 1, 'intersect'), 4, 1)], [0, 32, 32, 0]);
  const copy = combineSelections(null, saved, 4, 1, 'add'); copy.runs[2] = 7;
  assert.deepEqual(active, originalA); assert.deepEqual(saved, originalB);
  for (const mode of ['subtract', 'intersect']) assert.throws(() => combineSelections(null, saved, 4, 1, mode), { code: 'NO_SELECTION' });
  assert.throws(() => combineSelections(active, saved, 9000, 1, 'add'), { code: 'LIMIT_EXCEEDED' });
});

test('load combines feathered/inverted regions without changing the stored mask or rendered document', async (t) => {
  const { native, document: initial } = await fixture(t);
  let doc = await edit(native, initial, 'select_region', { shape: 'rectangle', x: 2, y: 0, width: 4, height: 8, feather: 2, invert: true });
  doc = await edit(native, doc, 'save_selection', { name: 'Inverted soft strip' }); const saved = structuredClone(doc.savedSelections[0]);
  doc = await edit(native, doc, 'select_rectangle', { x: 0, y: 0, width: 4, height: 8 });
  const left = maskCoverage(doc.selection), right = maskCoverage(saved.mask);
  doc = await edit(native, doc, 'load_selection', { selectionId: saved.id, mode: 'intersect' });
  const actual = bytes(doc.selection, 8, 8);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) assert.equal(actual[y * 8 + x], Math.round(left(x, y) * right(x, y) * 255));
  assert.equal(doc.selection.shape, 'bitmap'); assert.equal(doc.selection.feather, 0); assert.equal(doc.selection.invert, false);
  assert.deepEqual(doc.savedSelections[0], saved); assert.deepEqual(await native.renderGraph(doc), await native.renderGraph(initial));
  doc = await edit(native, doc, 'clear_selection');
  await assert.rejects(edit(native, doc, 'load_selection', { selectionId: saved.id, mode: 'subtract' }), coded('NO_SELECTION'));
  doc = await edit(native, doc, 'load_selection', { selectionId: saved.id, mode: 'add' }); assert.deepEqual(doc.selection, saved.mask);
});

test('save/update/rename/delete are reversible, persisted, and independent of the active selection', async (t) => {
  const { dataDir, native, document: initial } = await fixture(t);
  let doc = await edit(native, initial, 'select_rectangle', { x: 1, y: 1, width: 2, height: 2 });
  doc = await edit(native, doc, 'save_selection', { name: 'First' }); const id = doc.savedSelections[0].id, mask = doc.selection;
  doc = await edit(native, doc, 'rename_selection', { selectionId: id, name: 'Renamed' });
  const reopened = await new NativeBackend({ dataDir }).init(); assert.equal(reopened.loadWarnings.length, 0);
  assert.equal((await get(reopened, doc)).savedSelections[0].name, 'Renamed');
  doc = await edit(reopened, doc, 'delete_selection', { selectionId: id }); assert.deepEqual(doc.savedSelections, []); assert.deepEqual(doc.selection, mask);
  doc = await edit(reopened, doc, 'undo'); assert.equal(doc.savedSelections[0].id, id); assert.equal(doc.savedSelections[0].name, 'Renamed');
  doc = await edit(reopened, doc, 'undo'); assert.equal(doc.savedSelections[0].name, 'First');
  doc = await edit(reopened, doc, 'redo'); assert.equal(doc.savedSelections[0].name, 'Renamed');
});

test('all saved masks follow canvas expansion/crop and resize once, including feathered inverted bitmaps', async (t) => {
  const { dataDir, native, document: initial } = await fixture(t);
  let doc = initial;
  for (const mask of [
    { shape: 'rectangle', x: 1, y: 1, width: 4, height: 4, feather: 1, invert: true },
    { shape: 'ellipse', x: 1, y: 2, width: 4, height: 4, feather: 1 },
    { shape: 'polygon', points: [{ x: 1, y: 1 }, { x: 6, y: 2 }, { x: 3, y: 6 }], feather: 1 },
  ]) { doc = await edit(native, doc, 'select_region', mask); doc = await edit(native, doc, 'save_selection'); }
  doc = await edit(native, doc, 'paint_selection', { mode: 'replace', points: [{ x: 4, y: 4 }], size: 6, hardness: 0.3, opacity: 0.6 });
  doc = await edit(native, doc, 'modify_selection', { feather: 1, invert: true });
  doc = await edit(native, doc, 'save_selection', { name: 'Soft inverted bitmap' });
  const originals = doc.savedSelections.map((saved) => bytes(saved.mask, 8, 8));
  doc = await edit(native, doc, 'resize_canvas', { width: 12, height: 12, anchor: 'center' });
  for (let index = 0; index < doc.savedSelections.length; index++) {
    const actual = bytes(doc.savedSelections[index].mask, 12, 12);
    for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) assert.equal(actual[y * 12 + x], x >= 2 && y >= 2 && x < 10 && y < 10 ? originals[index][(y - 2) * 8 + x - 2] : 0);
  }
  doc = await edit(native, doc, 'crop_document', { x: 2, y: 2, width: 8, height: 8 });
  for (let index = 0; index < doc.savedSelections.length; index++) assert.deepEqual(bytes(doc.savedSelections[index].mask, 8, 8), originals[index]);
  const last = doc.savedSelections.at(-1), before = bytes(last.mask, 8, 8);
  doc = await edit(native, doc, 'resize_document', { width: 16, height: 16 });
  const resized = doc.savedSelections.at(-1); assert.equal(resized.id, last.id); assert.equal(resized.mask.width, 16); assert.equal(resized.mask.height, 16);
  const after = bytes(resized.mask, 16, 16);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) assert.equal(after[y * 16 + x], before[Math.floor(y / 2) * 8 + Math.floor(x / 2)]);
  const reopened = await new NativeBackend({ dataDir }).init(); assert.equal(reopened.loadWarnings.length, 0); assert.deepEqual((await get(reopened, doc)).savedSelections, doc.savedSelections);
});

test('capacity, bad identifiers and transaction failures preserve the existing project atomically; overwrite remains allowed at capacity', async (t) => {
  const { dataDir, native, document: initial } = await fixture(t);
  await assert.rejects(edit(native, initial, 'save_selection'), coded('NO_SELECTION'));
  let doc = await edit(native, initial, 'select_rectangle', { x: 0, y: 0, width: 4, height: 4 });
  for (let i = 0; i < 16; i++) doc = await edit(native, doc, 'save_selection', { name: `Region ${i}` });
  const file = path.join(dataDir, 'projects', `${doc.id}.json`), persisted = await fs.readFile(file);
  await assert.rejects(edit(native, doc, 'save_selection'), coded('LIMIT_EXCEEDED'));
  await assert.rejects(edit(native, doc, 'load_selection', { selectionId: randomUUID() }), coded('NOT_FOUND'));
  await assert.rejects(edit(native, doc, 'apply_transaction', { operations: [
    { command: 'rename_selection', args: { selectionId: doc.savedSelections[0].id, name: 'Rolled back' } },
    { command: 'delete_selection', args: { selectionId: randomUUID() } },
  ] }), coded('NOT_FOUND'));
  assert.deepEqual(await get(native, doc), doc); assert.deepEqual(await fs.readFile(file), persisted);
  const id = doc.savedSelections[0].id;
  doc = await edit(native, doc, 'modify_selection', { invert: true });
  doc = await edit(native, doc, 'save_selection', { selectionId: id, name: 'Overwritten' });
  assert.equal(doc.savedSelections.length, 16); assert.equal(doc.savedSelections[0].id, id); assert.equal(doc.savedSelections[0].mask.invert, true);
});

test('persisted saved-selection masks reject duplicate IDs, canvas mismatch and invalid names without rewriting files', async (t) => {
  const id = randomUUID(), saved = { id, name: 'Valid', mask: bitmapMask(Uint8Array.from([255, 0, 0, 255]), 2, 2) };
  for (const savedSelections of [[saved, saved], [{ ...saved, name: ' ' }], [{ ...saved, id: 'not-uuid' }]]) assert.throws(() => validateSavedSelections({ width: 2, height: 2, savedSelections }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => validateSavedSelections({ width: 3, height: 2, savedSelections: [saved] }), { code: 'INVALID_ARGUMENT' });
  const { dataDir, native, document: initial } = await fixture(t);
  let doc = await edit(native, initial, 'select_rectangle', { x: 0, y: 0, width: 2, height: 2 });
  doc = await edit(native, doc, 'save_selection');
  const file = path.join(dataDir, 'projects', `${doc.id}.json`), project = JSON.parse(await fs.readFile(file, 'utf8'));
  project.states.at(-1).graph.savedSelections[0].mask = saved.mask;
  const corrupted = JSON.stringify(project); await fs.writeFile(file, corrupted);
  const reopened = await new NativeBackend({ dataDir }).init(); assert.equal(reopened.loadWarnings.length, 1); assert.equal((await reopened.execute('list_documents')).documents.length, 0);
  assert.equal(await fs.readFile(file, 'utf8'), corrupted);
});
