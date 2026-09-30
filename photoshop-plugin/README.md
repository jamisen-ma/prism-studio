# Prism Studio Photoshop bridge

This is a loadable Adobe UXP panel for desktop Photoshop **25.0 or later**. The companion runs the MCP server; this panel runs a fixed set of document commands inside Photoshop. It does not evaluate arbitrary JavaScript or expose a raw `batchPlay` endpoint.

**Validation status:** helper, protocol, and simulated-host transaction tests pass. Photoshop was not installed in this development environment, so loading the panel, action descriptors, selection fidelity, and export output still require the in-app checks below. This is an initial bridge, not a claim of complete Photoshop feature coverage.

## Load and connect

1. Install/open Photoshop desktop and Adobe's UXP Developer Tool. Enable Photoshop developer mode if prompted by the tool.
2. In UXP Developer Tool, choose **Add Plugin**, select this folder's `manifest.json`, then choose **Load**. For distribution, use the developer tool's package workflow; the source folder itself is the development install.
3. Start the Prism Studio companion as described in the repository README. In Studio, switch to Photoshop and open its connection setup.
4. Open **Plugins → Prism Studio → Prism Studio** in Photoshop. Paste the setup pairing token and select **Connect to Studio**.
5. Leave the panel loaded while using Studio or Codex. If the companion restarts, reconnect with its current token. Tokens are held in memory only, cleared from the field on connection, and are never written to a plugin settings file.

The panel connects only to `ws://127.0.0.1:43120/bridge`, which is the single network destination declared in its manifest. It initiates the socket because UXP cannot host a WebSocket server. A second active panel connection is rejected by the companion. A local socket/permission failure is reported in the panel; there is no remote-service fallback.

## Implemented command surface

| Area | Commands / behavior |
| --- | --- |
| Inspection | `capabilities`, `list_documents`, `get_document`, `get_preview` |
| Documents | `create_document`, `crop_document`, `resize_document` |
| Layers | `set_layer`, `duplicate_layer`, `delete_layer`, `reorder_layer` |
| Adjustments | `add_adjustment`: exposure, brightness, contrast, saturation as editable adjustment layers |
| Masks | Adjustment rectangles, feathering, inversion; an existing pixel selection is restored after adjustment creation |
| Text | `add_text`, editable text with visible top-left position, pixel font size and hex color |
| Selections | `select_rectangle`, `clear_selection`, `select_subject` through Photoshop's subject-selection command |
| History | `apply_transaction`, `undo`, `redo` |
| Output | `save_document` to an existing local path; `export_document` as PNG/JPEG bytes |

Unsupported commands/kinds return `UNSUPPORTED`: image import through the bridge, temperature, blur, sharpen, generative fill, WebP, cloud saves, and choosing a first save path. Open/import images or choose that first save path in Photoshop itself.

Layer opacity is 0–1 at the bridge and converted to Photoshop percentages. Blend modes are normal, multiply, screen, overlay, darken, lighten, difference, exclusion. Reorder index is zero-based from the top **within that layer's parent group**. New adjustment layers are placed above the top-level stack, so they affect the whole composite. An explicit rectangle mask overrides the current selection. Without an explicit mask, the current selection scopes the adjustment; without either, it applies to the full canvas. Selected layers/channels and the previously active document are restored where they still exist. Create-document intentionally activates the new document; selection commands intentionally replace the document selection.

Preview output is sRGB JPEG, with transparency matted on white, bounded to 4096 pixels on its longest dimension. The Imaging API can trim transparent margins and return cached coordinates; the preview compositor restores full-canvas placement. PNG/JPEG export uses a disposable merged duplicate converted to 8-bit sRGB; the original's color space and layers are preserved. JPEG `quality` is 1–100, mapped to Photoshop's 1–12 scale. Exports over 32 MB are rejected; temporary export files and documents are cleaned up.

## Transactions and change detection

All commands run through serial queues. Mutations enter `executeAsModal`; normal edits suspend history and either commit as one named history step or roll back on failure. `apply_transaction` accepts 1–30 edits against one document. Its members cannot create/import/save/export documents, navigate undo/redo, or nest a transaction. Undo/redo navigate actual Photoshop history separately from history suspension.

The engine checks `expectedRevision` before entering and again inside Photoshop's modal scope. Revision observations include the current history ID, history state IDs, layer tree/properties, document size, and selection bounds. Direct Photoshop changes are therefore observed on the next request; action notifications also prompt the companion to refresh. This is not a content hash of every pixel or selection mask. Revision counters are scoped to the loaded plugin session, so fetch a fresh document after reconnect/reload. History labels and IDs come from Photoshop; timestamps indicate when the plugin first observed each state, not when Photoshop created it.

The panel never retries a mutation automatically. Duplicate request IDs on a connection are rejected. If the socket closes or the companion times out during an edit, inspect the document/history before issuing another edit because completion may be uncertain.

## Verification

Run the host-independent tests from the repository root:

```sh
node --test photoshop-plugin/test/*.test.cjs
```

They verify protocol payloads, no commands before pairing, duplicate request rejection, serial execution, adjustment argument bounds, raw Photoshop error descriptors, rectangle overflow, full-canvas preview geometry, revision conflicts (including changes while waiting for modal access), one history commit for multiple operations, rollback on failure, top-level reorder behavior, and base64 encoding.

Manual validation before calling the bridge production-ready:

1. Load the manifest in Photoshop 25+ on the target OS; check panel layout and socket permission behavior. Connect with the correct token, reject a wrong token, and reject a second active panel.
2. Open an RGB layered document with transparent margins and nested groups. Verify document dimensions, recursive layer IDs, opacity, blend modes, history, and the full-canvas preview.
3. Apply a transaction with two layer changes; confirm one Photoshop undo step. Undo and redo and confirm both the image and layer values. Force a later member to fail by targeting a missing layer; verify the earlier edit rolled back.
4. Fetch a revision, paint directly in Photoshop, then send an edit with the old revision. Confirm `REVISION_CONFLICT` and unchanged pixels from the rejected edit.
5. Add each adjustment kind. Verify live adjustment settings and editability. Test rectangular, feathered, and inverted masks while an unrelated existing selection is active; verify the unrelated selection is restored. Test a fully inverted canvas mask and rejection of empty/overflow masks.
6. Add text and confirm top-left pixel bounds and font size. Reorder top-level and grouped layers. Rename, hide, set opacity, duplicate, delete, crop and resize, undoing each afterward.
7. Select a subject in a supported document. Confirm an actual Photoshop selection and an explicit error for a document where the command is unavailable.
8. Export transparent PNG and JPEG and open the returned files. Verify dimensions, transparent margins, JPEG quality and sRGB conversion. Confirm the original document, active tab, layer stack and history are unchanged. Exercise CMYK/16-bit/32-bit inputs and any Photoshop conversion dialogs before advertising those cases.
9. Save an already-saved PSD and reopen it to check edits; confirm unsaved/cloud documents receive a clear unsupported error without a Save dialog.
10. Cancel a modal edit with Escape, disconnect during a transaction, and restart the companion. Verify rollback where Photoshop reports cancellation, visible connection errors, no automatic mutation replay, and recoverable reconnection.

## Adobe API references

- [BatchPlay descriptors and error results](https://developer.adobe.com/photoshop/uxp/ps_reference/media/batchplay/)
- [Modal execution, cancellation and history rollback](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/media/executeasmodal)
- [Imaging API: pixels, masks, selections and preview encoding](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/media/imaging)
- [Document DOM](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/classes/document), [Layer DOM](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/classes/layer), [Selection DOM](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/classes/selection)
- [Text creation options and baseline positioning](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/objects/createoptions/textlayercreateoptions)
- [Manifest v5 permissions](https://developer.adobe.com/photoshop/uxp/2022/guides/uxp-guide/uxp-misc/manifest-v5/), [UXP networking](https://developer.adobe.com/uxp/guides/how-to/recipes/network/)
- [Adobe autoCutout ActionJSON example](https://developer.adobe.com/firefly-services/docs/photoshop/guides/photoshop-v2/v1-to-v2/convenience-apis/product-crop)
