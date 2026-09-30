"use strict";

const H = require("./helpers.js");
const BLENDS = {normal: "NORMAL", multiply: "MULTIPLY", screen: "SCREEN", overlay: "OVERLAY", darken: "DARKEN", lighten: "LIGHTEN", difference: "DIFFERENCE", exclusion: "EXCLUSION"};
const asArray = collection => Array.from(collection || []);
const safe = (read, fallback = null) => { try { return read(); } catch (_) { return fallback; } };

class PhotoshopEngine {
  constructor(photoshop, uxp) {
    this.ps = photoshop;
    this.uxp = uxp;
    this.revisions = new Map();
    this.observedHistory = new Map();
    this.enqueue = H.makeQueue();
  }

  capabilities() { return {backend: "photoshop", commands: [...H.COMMANDS], limitations: [...H.LIMITATIONS]}; }
  document(id) {
    const doc = asArray(this.ps.app.documents).find(item => String(item.id) === String(id));
    if (!doc) H.fail("DOCUMENT_NOT_FOUND", `Photoshop document '${id}' is no longer open.`);
    return doc;
  }
  layer(doc, id) {
    const visit = layers => {
      for (const layer of asArray(layers)) {
        if (String(layer.id) === String(id)) return layer;
        const found = visit(safe(() => layer.layers, []));
        if (found) return found;
      }
    };
    const layer = visit(doc.layers);
    if (!layer) H.fail("LAYER_NOT_FOUND", `Layer '${id}' is no longer present.`);
    return layer;
  }
  serializeLayers(layers, parentId = null) {
    return asArray(layers).map(layer => {
      const kind = String(layer.kind);
      const blendMode = Object.keys(BLENDS).find(key => this.ps.constants.BlendMode[BLENDS[key]] === layer.blendMode) || String(layer.blendMode);
      const item = {
        id: String(layer.id), name: layer.name, type: kind, visible: layer.visible,
        opacity: layer.opacity / 100, blendMode, parentId, locked: layer.allLocked,
        bounds: safe(() => ({left: layer.bounds.left, top: layer.bounds.top, right: layer.bounds.right, bottom: layer.bounds.bottom}))
      };
      const children = safe(() => layer.layers, []);
      if (children && children.length) item.children = this.serializeLayers(children, item.id);
      return item;
    });
  }
  snapshot(doc) {
    const id = String(doc.id);
    const states = asArray(doc.historyStates).filter(state => !state.snapshot);
    const activeId = safe(() => String(doc.activeHistoryState.id));
    const position = states.findIndex(state => String(state.id) === activeId);
    const layers = this.serializeLayers(doc.layers);
    const selection = safe(() => doc.selection.bounds);
    const selectionBounds = selection ? {left: selection.left, top: selection.top, right: selection.right, bottom: selection.bottom} : null;
    const fingerprint = JSON.stringify([doc.name, doc.width, doc.height, activeId, states.map(state => state.id), layers, selectionBounds]);
    let tracking = this.revisions.get(id);
    if (!tracking) tracking = {fingerprint, revision: 1};
    else if (tracking.fingerprint !== fingerprint) tracking = {fingerprint, revision: tracking.revision + 1};
    this.revisions.set(id, tracking);
    const history = states.map(state => {
      const key = `${id}:${state.id}`;
      if (!this.observedHistory.has(key)) this.observedHistory.set(key, new Date().toISOString());
      return {id: String(state.id), label: state.name, timestamp: this.observedHistory.get(key), active: String(state.id) === activeId};
    });
    return {
      id, name: doc.name, width: doc.width, height: doc.height, revision: tracking.revision,
      backend: "photoshop", layerOrder: "top-to-bottom", layers, history, canUndo: position > 0,
      canRedo: position >= 0 && position < states.length - 1,
      selection: selectionBounds, activeHistoryId: activeId,
      saved: safe(() => doc.saved, false), colorMode: String(doc.mode),
      limitations: ["History timestamps are first observation times.", "Revision tokens are scoped to the current plugin session."]
    };
  }
  async batch(descriptors) {
    return H.assertBatchSuccess(await this.ps.action.batchPlay(descriptors, {continueOnError: false}));
  }
  async activate(doc) {
    if (safe(() => this.ps.app.activeDocument.id) !== doc.id) await this.batch([{_obj: "select", _target: [{_ref: "document", _id: doc.id}], _options: {dialogOptions: "silent"}}]);
  }
  async selectLayers(doc, ids) {
    const available = ids.filter(id => safe(() => this.layer(doc, id), null));
    if (!available.length) return;
    const descriptors = available.map((id, index) => {
      const descriptor = {_obj: "select", _target: [{_ref: "layer", _id: Number(id)}], makeVisible: false, _options: {dialogOptions: "silent"}};
      if (index) descriptor.selectionModifier = {_enum: "selectionModifierType", _value: "addToSelection"};
      return descriptor;
    });
    await this.batch(descriptors);
  }

  execute(command, args = {}) { return this.enqueue(() => this.dispatch(command, args)); }

  async dispatch(command, args) {
    if (!H.COMMANDS.includes(command)) H.fail("UNSUPPORTED", `Photoshop command '${command}' is not implemented.`);
    if (command === "capabilities") return this.capabilities();
    if (command === "list_documents") return {documents: asArray(this.ps.app.documents).map(doc => this.snapshot(doc))};
    if (command === "create_document") return this.createDocument(args);
    const doc = this.document(args.documentId);
    const before = this.snapshot(doc);
    if (command === "get_document") return {document: before};
    if (command === "get_preview") return this.preview(doc, args);
    if (command === "export_document") return this.exportDocument(doc, args);
    H.assertRevision(args.expectedRevision, before.revision);
    if (command === "save_document") return this.saveDocument(doc);
    const operations = command === "apply_transaction" ? H.transactionOperations(args) : [{command, args}];
    await this.ps.core.executeAsModal(async context => {
      // Recheck inside Photoshop's exclusive scope, after any time spent waiting for it.
      H.assertRevision(args.expectedRevision, this.snapshot(doc).revision);
      const previousDocument = safe(() => this.ps.app.activeDocument);
      const activeLayers = asArray(doc.activeLayers).map(layer => String(layer.id));
      const activeChannels = safe(() => asArray(doc.activeChannels));
      let suspension;
      await this.activate(doc);
      try {
        if (command === "undo" || command === "redo") {
          const states = asArray(doc.historyStates).filter(state => !state.snapshot);
          const current = states.findIndex(state => state.id === doc.activeHistoryState.id);
          const target = states[current + (command === "undo" ? -1 : 1)];
          if (!target || current < 0) H.fail("NO_HISTORY", `Nothing to ${command}.`);
          doc.activeHistoryState = target;
        } else {
          suspension = await context.hostControl.suspendHistory({documentID: doc.id, name: args.label || `Prism: ${command.replace(/_/g, " ")}`});
          for (const operation of operations) {
            if (context.isCancelled) H.fail("CANCELLED", "Photoshop cancelled the edit.");
            await this.edit(doc, operation.command, operation.args);
          }
          await this.selectLayers(doc, activeLayers);
          // A requested deletion can remove the previously selected mask/channel.
          if (activeChannels && activeChannels.length) { try { doc.activeChannels = activeChannels; } catch (_) {} }
          await context.hostControl.resumeHistory(suspension, true);
          suspension = null;
        }
      } catch (error) {
        if (suspension) {
          // A cancelled modal scope also rolls back automatically on exception.
          try { await context.hostControl.resumeHistory(suspension, false); } catch (_) {}
        }
        try { await this.selectLayers(doc, activeLayers); } catch (_) {}
        throw error;
      } finally {
        if (previousDocument && previousDocument.id !== doc.id) {
          try { await this.activate(this.document(previousDocument.id)); } catch (_) {}
        }
      }
    }, {commandName: args.label || `Prism ${command.replace(/_/g, " ")}`});
    return {document: this.snapshot(doc)};
  }

  solidColor(hex) {
    const value = new this.ps.app.SolidColor();
    value.rgb.hexValue = H.color(hex);
    return value;
  }
  async createDocument(args) {
    H.integer(args.width, "width", 1, 30000);
    H.integer(args.height, "height", 1, 30000);
    if (args.width * args.height > 100000000) H.fail("INVALID_ARGUMENT", "New documents are limited to 100 megapixels.");
    const fillColor = this.solidColor(args.background || "#FFFFFF");
    let doc;
    await this.ps.core.executeAsModal(async () => {
      doc = await this.ps.app.documents.add({name: args.name || "Untitled Prism", width: args.width, height: args.height, resolution: 72, mode: this.ps.constants.NewDocumentMode.RGB, depth: 8, fill: this.ps.constants.DocumentFill.COLOR, fillColor, profile: "sRGB IEC61966-2.1"});
    }, {commandName: "Prism create document"});
    return {document: this.snapshot(doc)};
  }

  async edit(doc, command, args) {
    const constants = this.ps.constants;
    if (command === "add_adjustment") return this.addAdjustment(doc, args);
    if (command === "set_layer") {
      const layer = this.layer(doc, args.layerId);
      if (args.name !== undefined) layer.name = args.name;
      if (args.visible !== undefined) {
        if (typeof args.visible !== "boolean") H.fail("INVALID_ARGUMENT", "visible must be boolean.");
        layer.visible = args.visible;
      }
      if (args.opacity !== undefined) layer.opacity = H.number(args.opacity, "opacity", 0, 1) * 100;
      if (args.blendMode !== undefined) {
        if (!Object.prototype.hasOwnProperty.call(BLENDS, args.blendMode)) H.fail("UNSUPPORTED", `Unsupported blend mode '${args.blendMode}'.`);
        layer.blendMode = constants.BlendMode[BLENDS[args.blendMode]];
      }
      return;
    }
    if (command === "duplicate_layer") { await this.layer(doc, args.layerId).duplicate(); return; }
    if (command === "delete_layer") { this.layer(doc, args.layerId).delete(); return; }
    if (command === "reorder_layer") {
      const layer = this.layer(doc, args.layerId);
      const siblings = asArray(layer.parent ? layer.parent.layers : doc.layers);
      H.integer(args.index, "index", 0, siblings.length - 1);
      const current = siblings.findIndex(item => item.id === layer.id);
      if (args.index !== current) layer.move(siblings[args.index], args.index < current ? constants.ElementPlacement.PLACEBEFORE : constants.ElementPlacement.PLACEAFTER);
      return;
    }
    if (command === "add_text") {
      if (typeof args.text !== "string" || !args.text.trim() || args.text.length > 10000) H.fail("INVALID_ARGUMENT", "Text must contain 1–10000 characters.");
      H.number(args.x, "x", -30000, 30000); H.number(args.y, "y", -30000, 30000);
      H.number(args.fontSize, "fontSize", 1, 2000);
      const layer = await doc.createTextLayer({name: args.name || args.text.slice(0, 48), contents: args.text, fontSize: args.fontSize, position: {x: args.x, y: args.y + args.fontSize}, textColor: this.solidColor(args.color)});
      // The API positions the baseline. The shared contract positions visible bounds.
      await layer.translate(args.x - layer.bounds.left, args.y - layer.bounds.top);
      return;
    }
    if (command === "crop_document") { await doc.crop(H.rectangle(args, doc)); return; }
    if (command === "resize_document") {
      H.integer(args.width, "width", 1, 30000); H.integer(args.height, "height", 1, 30000);
      if (args.width * args.height > 100000000) H.fail("INVALID_ARGUMENT", "Resized documents are limited to 100 megapixels.");
      await doc.resizeImage(args.width, args.height); return;
    }
    if (command === "select_rectangle") { await doc.selection.selectRectangle(H.rectangle(args, doc), constants.SelectionType.REPLACE); return; }
    if (command === "clear_selection") { await doc.selection.deselect(); return; }
    if (command === "select_subject") {
      await this.batch([{_obj: "autoCutout", sampleAllLayers: true, _options: {dialogOptions: "silent"}}]); return;
    }
    H.fail("UNSUPPORTED", `Command '${command}' cannot run as a document edit.`);
  }

  async addAdjustment(doc, args) {
    const descriptor = H.adjustmentDescriptor(args.kind, args.value, args.name);
    if (args.mask) {
      H.rectangle(args.mask, doc);
      if (args.mask.feather !== undefined) H.number(args.mask.feather, "feather", 0, 1000);
      if (args.mask.invert !== undefined && typeof args.mask.invert !== "boolean") H.fail("INVALID_ARGUMENT", "mask.invert must be boolean.");
    }
    if (doc.quickMaskMode) H.fail("UNSUPPORTED", "Exit Photoshop Quick Mask mode before adding adjustment layers.");
    let savedSelection;
    if (doc.selection.bounds) savedSelection = await this.ps.imaging.getSelection({documentID: doc.id});
    try {
      if (args.mask) {
        await doc.selection.selectRectangle(H.rectangle(args.mask, doc), this.ps.constants.SelectionType.REPLACE, args.mask.feather || 0);
        if (args.mask.invert) await doc.selection.inverse();
        if (!doc.selection.bounds) H.fail("INVALID_ARGUMENT", "The requested mask is empty after feathering or inversion.");
      }
      // Without an explicit mask, the current pixel selection scopes the new
      // adjustment. This makes select_subject -> add_adjustment a local edit.
      // New adjustment layers apply above the full top-level stack, not a selected nested group.
      const top = asArray(doc.layers)[0];
      if (top) await this.selectLayers(doc, [String(top.id)]);
      await this.batch([descriptor]);
      const created = asArray(doc.activeLayers)[0];
      if (created && top && created.id !== top.id) created.move(top, this.ps.constants.ElementPlacement.PLACEBEFORE);
      if (savedSelection) {
        await this.ps.imaging.putSelection({documentID: doc.id, imageData: savedSelection.imageData, replace: true, targetBounds: {left: savedSelection.sourceBounds.left, top: savedSelection.sourceBounds.top}});
      } else await doc.selection.deselect();
    } finally {
      if (savedSelection && savedSelection.imageData) savedSelection.imageData.dispose();
    }
  }

  async preview(doc, args) {
    const revision = this.snapshot(doc).revision;
    const maxWidth = H.integer(args.maxWidth === undefined ? 1600 : args.maxWidth, "maxWidth", 1, 4096);
    const scale = Math.min(1, maxWidth / doc.width, 4096 / doc.height);
    const width = Math.max(1, Math.round(doc.width * scale));
    const height = Math.max(1, Math.round(doc.height * scale));
    let source, composed;
    try {
      source = await this.ps.imaging.getPixels({documentID: doc.id, sourceBounds: {left: 0, top: 0, right: doc.width, bottom: doc.height}, targetSize: {width, height}, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1", componentSize: 8, applyAlpha: true});
      const image = source.imageData;
      const bytes = await image.getData({chunky: true});
      // Imaging may trim transparent margins and returns bounds in a cached pyramid level.
      // Composite into the original canvas proportions before JPEG encoding.
      const output = H.composePreview({width, height, scale, source, bytes});
      composed = await this.ps.imaging.createImageDataFromBuffer(output, {width, height, components: 3, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1"});
      const data = await this.ps.imaging.encodeImageData({imageData: composed, base64: true});
      H.assertRevision(revision, this.snapshot(doc).revision);
      return {data, mimeType: "image/jpeg", width, height, revision};
    } finally {
      if (source && source.imageData) source.imageData.dispose();
      if (composed) composed.dispose();
    }
  }

  async saveDocument(doc) {
    if (doc.cloudDocument || !safe(() => doc.path)) H.fail("UNSUPPORTED", "Use File > Save in Photoshop to choose a local document path first.");
    await this.ps.core.executeAsModal(async () => { await doc.save(); }, {commandName: "Prism save document"});
    return {document: this.snapshot(doc), saved: true};
  }
  async exportDocument(doc, args) {
    if (!["png", "jpeg"].includes(args.format)) H.fail("UNSUPPORTED", "Photoshop export supports PNG and JPEG.");
    const quality = H.number(args.quality === undefined ? 92 : args.quality, "quality", 1, 100);
    const extension = args.format === "jpeg" ? "jpg" : "png";
    let duplicate, file, bytes;
    await this.ps.core.executeAsModal(async context => {
      const previousDocument = safe(() => this.ps.app.activeDocument);
      try {
        duplicate = await doc.duplicate(`Prism export ${Date.now()}`, true);
        context.hostControl.registerAutoCloseDocument(duplicate.id);
        if (duplicate.mode !== this.ps.constants.DocumentMode.RGB) await duplicate.changeMode(this.ps.constants.ChangeMode.RGB);
        duplicate.bitsPerChannel = this.ps.constants.BitsPerChannelType.EIGHT;
        await duplicate.convertProfile("sRGB IEC61966-2.1", this.ps.constants.Intent.RELATIVECOLORIMETRIC, true, true);
        const folder = await this.uxp.storage.localFileSystem.getTemporaryFolder();
        file = await folder.createFile(`prism-${doc.id}-${Date.now()}.${extension}`, {overwrite: false});
        if (args.format === "png") await duplicate.saveAs.png(file, {}, true);
        else await duplicate.saveAs.jpg(file, {quality: Math.max(1, Math.round(quality * 12 / 100)), embedColorProfile: true}, true);
        const metadata = await file.getMetadata();
        if (metadata.size > 32 * 1024 * 1024) H.fail("EXPORT_TOO_LARGE", "Export exceeds the 32 MB bridge limit. Save a copy from Photoshop or resize first.");
        bytes = await file.read({format: this.uxp.storage.formats.binary});
      } finally {
        if (duplicate) {
          try { const id = duplicate.id; duplicate.closeWithoutSaving(); context.hostControl.unregisterAutoCloseDocument(id); } catch (_) {}
        }
        if (file) { try { await file.delete(); } catch (_) {} }
        if (previousDocument) { try { await this.activate(this.document(previousDocument.id)); } catch (_) {} }
      }
    }, {commandName: "Prism export copy"});
    const basename = doc.name.replace(/\.[^.]+$/, "").replace(/[^a-z0-9._ -]/gi, "_");
    return {data: H.encodeBase64(bytes), mimeType: args.format === "png" ? "image/png" : "image/jpeg", width: doc.width, height: doc.height, filename: `${basename}.${extension}`};
  }
}

module.exports = {PhotoshopEngine};
