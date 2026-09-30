const test = require("node:test");
const assert = require("node:assert/strict");
const {PhotoshopEngine} = require("../engine.js");

function fixture() {
  const history = [{id: 1, name: "Opened", snapshot: false}];
  const layer = {id: 5, name: "Original", kind: "pixel", visible: true, opacity: 100, blendMode: "normal", allLocked: false, bounds: {left: 0, top: 0, right: 100, bottom: 80}, layers: []};
  const doc = {id: 1, name: "Fixture.psd", width: 100, height: 80, layers: [layer], activeLayers: [layer], activeChannels: [], historyStates: history, activeHistoryState: history[0], selection: {bounds: null, async deselect() { this.bounds = null; }}, mode: "RGB", saved: false};
  layer.parent = null;
  const calls = {scopes: 0, commits: 0, rollbacks: 0, batches: []};
  let frozen;
  const ps = {
    app: {documents: [doc], activeDocument: doc},
    constants: {BlendMode: {NORMAL: "normal", MULTIPLY: "multiply"}},
    action: {async batchPlay(descriptors) { calls.batches.push(descriptors); return descriptors.map(() => ({})); }},
    core: {async executeAsModal(callback) {
      calls.scopes++;
      const control = {
        async suspendHistory() { frozen = {name: layer.name, opacity: layer.opacity, visible: layer.visible}; return {id: 1}; },
        async resumeHistory(_, commit) {
          if (commit) { calls.commits++; const state = {id: history.length + 1, name: "Prism edit", snapshot: false}; history.push(state); doc.activeHistoryState = state; }
          else { calls.rollbacks++; Object.assign(layer, frozen); }
        }
      };
      await callback({isCancelled: false, hostControl: control});
    }}
  };
  return {engine: new PhotoshopEngine(ps, {}), doc, layer, calls, ps};
}

test("multi-edit transaction uses one modal scope and one undo state", async () => {
  const {engine, calls, layer} = fixture();
  const result = await engine.execute("apply_transaction", {documentId: "1", expectedRevision: 1, label: "Editorial finish", operations: [
    {command: "set_layer", args: {layerId: "5", name: "Edited"}},
    {command: "set_layer", args: {layerId: "5", opacity: 0.4}}
  ]});
  assert.equal(layer.name, "Edited"); assert.equal(layer.opacity, 40);
  assert.equal(calls.scopes, 1); assert.equal(calls.commits, 1); assert.equal(calls.rollbacks, 0);
  assert.equal(result.document.revision, 2); assert.equal(result.document.canUndo, true);
});
test("failed transaction rolls back earlier edits", async () => {
  const {engine, calls, layer} = fixture();
  await assert.rejects(engine.execute("apply_transaction", {documentId: "1", operations: [
    {command: "set_layer", args: {layerId: "5", name: "Temporary"}},
    {command: "set_layer", args: {layerId: "absent", opacity: 0.4}}
  ]}), {code: "LAYER_NOT_FOUND"});
  assert.equal(layer.name, "Original"); assert.equal(calls.commits, 0); assert.equal(calls.rollbacks, 1);
});
test("external Photoshop edits cause stale revision failure before mutation", async () => {
  const {engine, calls, layer} = fixture();
  const initial = await engine.execute("get_document", {documentId: "1"});
  layer.name = "Changed directly in Photoshop";
  await assert.rejects(engine.execute("set_layer", {documentId: "1", expectedRevision: initial.document.revision, layerId: "5", name: "Clobber"}), {code: "REVISION_CONFLICT"});
  assert.equal(layer.name, "Changed directly in Photoshop"); assert.equal(calls.scopes, 0);
});
test("revision check repeats after entering Photoshop modal scope", async () => {
  const {engine, ps, layer} = fixture();
  const original = ps.core.executeAsModal;
  ps.core.executeAsModal = async callback => { layer.opacity = 80; return original(callback); };
  await assert.rejects(engine.execute("set_layer", {documentId: "1", expectedRevision: 1, layerId: "5", name: "Clobber"}), {code: "REVISION_CONFLICT"});
  assert.equal(layer.name, "Original");
});
test("unsupported commands and unsaved file paths never open modal UI", async () => {
  const {engine, calls} = fixture();
  await assert.rejects(engine.execute("run_script", {script: "anything"}), {code: "UNSUPPORTED"});
  await assert.rejects(engine.execute("save_document", {documentId: "1"}), {code: "UNSUPPORTED"});
  assert.equal(calls.scopes, 0);
});
test("top-level layers have null parent and can be reordered within document", async () => {
  const {engine, doc, layer, ps} = fixture();
  const lower = {...layer, id: 6, name: "Lower"}; doc.layers.push(lower);
  let moved;
  layer.move = (target, placement) => { moved = {target: target.id, placement}; };
  ps.constants.ElementPlacement = {PLACEBEFORE: "before", PLACEAFTER: "after"};
  await engine.execute("reorder_layer", {documentId: "1", layerId: "5", index: 1});
  assert.deepEqual(moved, {target: 6, placement: "after"});
});

test("an existing subject selection scopes adjustments when no explicit mask is supplied", async () => {
  const {engine, doc, ps} = fixture();
  const bounds = {left: 20, top: 10, right: 70, bottom: 60};
  doc.selection.bounds = bounds;
  let createdWithSelection, restored = false, disposed = false;
  ps.imaging = {
    async getSelection() { return {imageData: {dispose() { disposed = true; }}, sourceBounds: bounds}; },
    async putSelection() { restored = true; doc.selection.bounds = bounds; },
  };
  ps.action.batchPlay = async descriptors => {
    if (descriptors.some(item => item._obj === 'make')) createdWithSelection = doc.selection.bounds;
    return descriptors.map(() => ({}));
  };
  await engine.execute('add_adjustment', {documentId:'1',kind:'exposure',value:0.5});
  assert.deepEqual(createdWithSelection, bounds);
  assert.equal(restored, true);
  assert.equal(disposed, true);
});
