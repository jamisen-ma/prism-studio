"use strict";

const EDIT_COMMANDS = Object.freeze([
  "add_adjustment", "set_layer", "duplicate_layer", "delete_layer", "reorder_layer",
  "add_text", "crop_document", "resize_document", "select_subject", "select_rectangle", "clear_selection"
]);
const COMMANDS = Object.freeze([
  "capabilities", "list_documents", "get_document", "create_document", "get_preview",
  ...EDIT_COMMANDS, "apply_transaction", "undo", "redo", "save_document", "export_document"
]);
const LIMITATIONS = Object.freeze([
  "Requires Photoshop desktop 25.0+ running with this panel connected. In-app validation is pending.",
  "Adjustment kinds: exposure, brightness, contrast, saturation. Temperature, blur and sharpen are not implemented.",
  "Import images using Photoshop File > Open. PNG/JPEG export only; no WebP export or generative fill.",
  "JPEG previews show transparency against white; exports preserve transparency in PNG.",
  "Reordering is within the current parent group. Text uses Photoshop's default available font.",
  "History timestamps are first observed times, not Photoshop creation times. Revision tracking uses document/layer/history/selection observations and resets when the plugin reloads.",
  "Save requires an existing local file path. Cloud documents and unsaved documents must first be saved in Photoshop.",
  "Subject selection depends on Photoshop's available subject-selection processing and document mode."
]);

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function number(value, name, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    fail("INVALID_ARGUMENT", `${name} must be a finite number between ${min} and ${max}.`);
  }
  return value;
}
function integer(value, name, min, max) {
  number(value, name, min, max);
  if (!Number.isInteger(value)) fail("INVALID_ARGUMENT", `${name} must be an integer.`);
  return value;
}
function color(value) {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) fail("INVALID_ARGUMENT", "Color must be #RRGGBB.");
  return value.slice(1);
}
function rectangle(args, doc) {
  const x = number(args.x, "x", 0, doc.width);
  const y = number(args.y, "y", 0, doc.height);
  const width = number(args.width, "width", 1, doc.width);
  const height = number(args.height, "height", 1, doc.height);
  if (x + width > doc.width || y + height > doc.height) fail("INVALID_ARGUMENT", "Rectangle must fit inside the document.");
  return {left: x, top: y, right: x + width, bottom: y + height};
}
function adjustmentDescriptor(kind, value, name) {
  let type;
  if (kind === "exposure") {
    number(value, "exposure", -5, 5);
    type = {_obj: "exposure", exposure: value, offset: 0, gammaCorrection: 1};
  } else if (kind === "brightness" || kind === "contrast") {
    number(value, kind, -100, 100);
    type = {_obj: "brightnessEvent", brightness: kind === "brightness" ? value : 0, contrast: kind === "contrast" ? value : 0, useLegacy: false};
  } else if (kind === "saturation") {
    number(value, kind, -100, 100);
    type = {_obj: "hueSaturation", colorize: false, adjustment: [{_obj: "hueSatAdjustmentV2", hue: 0, saturation: value, lightness: 0}]};
  } else fail("UNSUPPORTED", `Photoshop adjustment '${kind}' is not implemented. Supported: exposure, brightness, contrast, saturation.`);
  return {_obj: "make", _target: [{_ref: "adjustmentLayer"}], using: {_obj: "adjustmentLayer", name: name || `Prism ${kind}`, type}, _options: {dialogOptions: "silent"}};
}
function transactionOperations(args) {
  if (!Array.isArray(args.operations) || args.operations.length < 1 || args.operations.length > 30) fail("INVALID_ARGUMENT", "A transaction needs 1–30 operations.");
  return args.operations.map(operation => {
    if (!operation || !EDIT_COMMANDS.includes(operation.command)) fail("UNSUPPORTED", `Command '${operation && operation.command}' is not allowed inside a transaction.`);
    const memberArgs = operation.args || {};
    if (memberArgs.documentId !== undefined && String(memberArgs.documentId) !== String(args.documentId)) fail("INVALID_ARGUMENT", "All transaction operations must target the same document.");
    if (memberArgs.expectedRevision !== undefined) fail("INVALID_ARGUMENT", "Set expectedRevision on the transaction, not its operations.");
    return {command: operation.command, args: Object.assign({}, memberArgs, {documentId: args.documentId})};
  });
}
function assertRevision(expected, current) {
  if (expected !== undefined && expected !== current) fail("REVISION_CONFLICT", `Document changed: expected revision ${expected}, current revision ${current}. Refresh the document before editing.`);
}
function assertBatchSuccess(results) {
  for (const result of results || []) {
    if (result && (String(result._obj).toLowerCase() === "error" || (typeof result.result === "number" && result.result < 0))) {
      fail(result.result === -128 ? "CANCELLED" : "PHOTOSHOP_ERROR", result.message || `Photoshop returned ${result.result}.`);
    }
  }
  return results;
}
function encodeBase64(buffer) {
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const parts = [];
  for (let start = 0; start < data.length; start += 12288) {
    let part = "";
    for (let index = start; index < Math.min(data.length, start + 12288); index += 3) {
      const a = data[index], b = data[index + 1], c = data[index + 2];
      part += table[a >> 2] + table[((a & 3) << 4) | ((b || 0) >> 4)]
        + (index + 1 < data.length ? table[((b & 15) << 2) | ((c || 0) >> 6)] : "=")
        + (index + 2 < data.length ? table[c & 63] : "=");
    }
    parts.push(part);
  }
  return parts.join("");
}
function makeQueue() {
  let tail = Promise.resolve();
  return task => {
    const next = tail.then(task);
    tail = next.catch(() => {});
    return next;
  };
}

function composePreview({width, height, scale, source, bytes}) {
  const image = source.imageData;
  const output = new Uint8Array(width * height * 3); output.fill(255);
  if (!image.width || !image.height) return output;
  const levelScale = Math.pow(2, source.level || 0);
  const bounds = source.sourceBounds;
  const left = Math.round(bounds.left * levelScale * scale), top = Math.round(bounds.top * levelScale * scale);
  const contentWidth = Math.max(0, Math.round((bounds.right - bounds.left) * levelScale * scale));
  const contentHeight = Math.max(0, Math.round((bounds.bottom - bounds.top) * levelScale * scale));
  for (let y = 0; y < contentHeight && top + y < height; y++) {
    if (top + y < 0) continue;
    const sourceY = Math.min(image.height - 1, Math.floor(y * image.height / contentHeight));
    for (let x = 0; x < contentWidth && left + x < width; x++) {
      if (left + x < 0) continue;
      const sourceX = Math.min(image.width - 1, Math.floor(x * image.width / contentWidth));
      const from = (sourceY * image.width + sourceX) * image.components;
      const to = ((top + y) * width + left + x) * 3;
      output[to] = bytes[from]; output[to + 1] = bytes[from + 1]; output[to + 2] = bytes[from + 2];
    }
  }
  return output;
}

module.exports = {COMMANDS, EDIT_COMMANDS, LIMITATIONS, fail, number, integer, color, rectangle, adjustmentDescriptor, transactionOperations, assertRevision, assertBatchSuccess, encodeBase64, makeQueue, composePreview};
