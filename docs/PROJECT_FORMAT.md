# Portable editable Prism projects

Use **File → Download project** or **Export → Editable project** to download a `.prism` file. Open it with **File → Open project**. Import creates a separate document and leaves existing documents unchanged.

The file preserves the current document's layers, pass-through and isolated groups, text, vectors, gradients, adjustments, layer styles, selections, named selections, masks, protection settings, and all required original/working/alpha image assets. Original asset bytes are retained exactly. Documents imported from supported PSD files also retain their exact original PSD as a separate passive source archive. Undo history is deliberately omitted: the imported document begins with a single import entry. This is Prism's native portable format, not Photoshop PSD or a flattened raster export.

## MCP workflow

1. Inspect `prism_get_document` and its current revision.
2. Call `prism_export_project({documentId,expectedRevision})`. The tool writes a new unique file under the configured exports directory and returns its absolute path.
3. Call `prism_import_project_file({path,requestId,name?})` to open that exact file as a new project. Keep `requestId` stable after an uncertain response. The companion retains the latest 200 import receipts during its session; restarting clears those import receipts. A retry within that window recovers the same document instead of duplicating it.
4. Inspect the imported document and preview. Layers and saved selections remain editable; their IDs are scoped by the new document ID.

Generated layers retain their source job IDs as informational provenance and are marked as imported. They cannot satisfy or replace a live generation job's installation receipt.

Nondefault image-resize methods retain strict `type:'resample'` geometry with an explicit kernel. Older readers reject this new type instead of silently using their default. Omitted/default Lanczos3 keeps the original `type:'resize'` representation. The bundle container remains version 1; its graph validator determines supported editing semantics. See [resize methods and precision](RESAMPLING.md).

## Format version 1

The dependency-free format uses no compression and contains no paths or executable content:

| Segment | Encoding |
| --- | --- |
| Magic | Eight ASCII bytes: `PRISMB01` |
| Manifest length | Four-byte unsigned big-endian integer |
| Manifest | Canonical UTF-8 JSON |
| Assets | Raw blobs concatenated in manifest-table order |

The manifest has exactly `format:'prism-project'`, `version:1`, `history:'current-state-only'`, `graph` and `assets`. The asset table contains sorted, unique `{sha256,bytes}` entries. Graph image references are bare lowercase SHA-256 hashes. Every reference must be present, every blob must be referenced, and each digest and length must match. Canonical JSON sorts object keys recursively, preserves array order and contains no whitespace. Duplicate keys, unsupported metadata, invalid UTF-8 and trailing bytes are rejected.

An optional graph `sourceDocument` identifies a PSD archive by format, hash, byte count and safe filename. Its role is separate from raster assets: a source archive cannot also be a layer image. Portable transfer checks its bounded header, length and hash without executing the PSD parser or using the archive as rendered content. The original remains downloadable after native edits; it does not represent those edits. PSD import retry receipts and document history are not portable metadata.

Limits are 256 MiB per bundle, 128 MiB per asset, 16 MiB of manifest metadata, 193 referenced assets, and the native 8192-pixel edge/24-megapixel image limits. The full persisted project must also fit the native 16 MiB metadata limit. These are bounded current-state files; large production document support remains separate work.

## Validation and transport

Export takes a serialized native snapshot, checks asset integrity and does not modify the source document. Import validates the entire graph and fully decodes all referenced raster images before publishing assets. It rejects unsupported, malformed, animated, multipage or dimension-mismatched images. Import persists a new document atomically and removes newly written assets if saving fails; existing shared assets remain untouched.

HTTP uses authenticated binary endpoints rather than expanding the normal JSON-body limit:

- `GET /api/projects/:documentId/export?expectedRevision=N` returns `application/x-prism-project` with attachment filename, revision and `X-Prism-History-Included:false` headers.
- `POST /api/projects/import?name=optionalName` accepts the raw file with `Content-Type:application/x-prism-project` and a stable `X-Prism-Request-Id`. It returns `{document,historyIncluded:false}`.

Both routes use the same loopback Host, Origin and token validation as editing commands. At most two project transfers run concurrently. A cancelled download releases its transfer slot. A successful import receipt remains available for retry even if its response is lost.
