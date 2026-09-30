const test = require("node:test");
const assert = require("node:assert/strict");
const H = require("../helpers.js");

test("base64 includes correct padding across chunk boundaries", () => {
  for (const length of [0, 1, 2, 3, 12287, 12288, 12289, 24580]) {
    const bytes = Uint8Array.from({length}, (_, index) => index % 256);
    assert.equal(H.encodeBase64(bytes), Buffer.from(bytes).toString("base64"));
  }
});
test("transaction cannot write files, cross documents, nest, or bypass revision guard", () => {
  for (const command of ["save_document", "export_document", "create_document", "import_image", "apply_transaction", "undo", "redo", "eval"]) {
    assert.throws(() => H.transactionOperations({documentId: "1", operations: [{command, args: {}}]}), {code: "UNSUPPORTED"});
  }
  assert.throws(() => H.transactionOperations({documentId: "1", operations: [{command: "set_layer", args: {documentId: "2"}}]}), {code: "INVALID_ARGUMENT"});
  assert.throws(() => H.transactionOperations({documentId: "1", operations: [{command: "set_layer", args: {expectedRevision: 1}}]}), {code: "INVALID_ARGUMENT"});
  assert.deepEqual(H.transactionOperations({documentId: "1", operations: [{command: "clear_selection"}]}), [{command: "clear_selection", args: {documentId: "1"}}]);
});
test("adjustments are neutral in untouched channels and reject unsupported edits", () => {
  assert.deepEqual(H.adjustmentDescriptor("contrast", 22).using.type, {_obj: "brightnessEvent", brightness: 0, contrast: 22, useLegacy: false});
  assert.equal(H.adjustmentDescriptor("exposure", 1.5).using.type.exposure, 1.5);
  assert.throws(() => H.adjustmentDescriptor("exposure", NaN), {code: "INVALID_ARGUMENT"});
  assert.throws(() => H.adjustmentDescriptor("temperature", 20), {code: "UNSUPPORTED"});
});
test("rectangles reject overflow and revisions reject stale requests", () => {
  assert.throws(() => H.rectangle({x: 90, y: 0, width: 20, height: 10}, {width: 100, height: 100}), {code: "INVALID_ARGUMENT"});
  assert.throws(() => H.assertRevision(3, 4), {code: "REVISION_CONFLICT"});
  H.assertRevision(undefined, 4);
});
test("resolved batchPlay error descriptors cause command failure", () => {
  assert.throws(() => H.assertBatchSuccess([{_obj: "error", result: -25922, message: "Target unavailable"}]), {code: "PHOTOSHOP_ERROR"});
  assert.throws(() => H.assertBatchSuccess([{_obj: "error", result: -128}]), {code: "CANCELLED"});
});
test("trimmed cached previews keep their full-canvas position", () => {
  const output = H.composePreview({width: 4, height: 3, scale: 0.5, source: {level: 1, sourceBounds: {left: 1, top: 1, right: 3, bottom: 2}, imageData: {width: 2, height: 1, components: 3}}, bytes: new Uint8Array([255, 0, 0, 0, 0, 255])});
  assert.deepEqual(Array.from(output.slice(12, 24)), [255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
  assert.equal(output.length, 36);
});
test("serial queue survives failure and never overlaps operations", async () => {
  const queue = H.makeQueue(); const events = [];
  const first = queue(async () => { events.push("one start"); await Promise.resolve(); events.push("one end"); throw Error("nope"); });
  const second = queue(async () => { events.push("two"); return 2; });
  await assert.rejects(first); assert.equal(await second, 2);
  assert.deepEqual(events, ["one start", "one end", "two"]);
});
