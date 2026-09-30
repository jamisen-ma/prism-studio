# Limited layered PSD import

Prism opens a supported subset of Photoshop PSD files without requiring Photoshop. The importer preserves compatible raster layers, their transparency, simple additional masks, names, order, visibility and byte opacity. It also keeps the original PSD file unchanged as a separate archive.

This is a limited RGB8 raster workflow. Groups, text, vectors, effects, adjustment layers, Smart Objects, clipping, nonnormal blending, ZIP compression, PSB and high-depth/color-mode workflows remain unsupported. A compatibility report explains which records prevent import. The importer never silently flattens an unsupported document or substitutes its saved merged image for editable layers.

## Open a file

Choose **File → Open PSD**, or drop a PSD into the Native workspace. Prism inspects the file without adding a document or publishing assets. Review the named issues and warnings; a fully supported report enables **Import as new document**.

For an untagged RGB file, **Interpret untagged RGB as sRGB** is an explicit color interpretation choice. Changing it repeats inspection. A recognized sRGB profile needs no assumption. An unknown embedded ICC profile remains unsupported; the checkbox does not override it. The initial recognized profile is the exact sRGB profile used by Prism's own exporter, so other valid sRGB profiles can still be rejected by this narrow policy.

The new document has a fresh undo history. Its original PSD archive stays separate from the imported layer PNGs and survives ordinary edits, reopening and portable `.prism` transfer. **File → Download original PSD** returns the unchanged container. **Export → Layered PSD** instead creates a new file from the current native document, subject to the separate [export limits](PSD_EXPORT.md).

An interrupted import retains the same file, interpretation and request identity for retry. A successful import has a durable receipt in its native project, so recovering its response after a companion restart does not create a second document. Read-only inspection can be cancelled. Once final import is accepted, a disconnected browser does not cancel the shared operation; retry recovers its result.

## Exact scope

| Supported input | Native result |
| --- | --- |
| PSD version 1, RGB, eight-bit channels | An eight-bit sRGB native document under the recognized-profile or explicit untagged policy. |
| 1–64 flat normal raster layers | Fresh native layer IDs with retained names, order, visibility and stored opacity divided by 255. |
| Raw or PackBits compression | Fully decoded source channels; truncated rows and incorrect lengths reject. No ZIP fallback. |
| RGB with optional transparency and simple user mask | Source RGB/alpha remain independent of the editable additional mask, including invisible RGB. |
| Absolute simple masks, black/white outside default, inversion | Document-space editable bitmap masks. Disabled masks are retained with density zero and a named warning. |
| Cropped or offset source rectangles | Lossless full source PNG plus integer canvas placement. Current visible placement is preserved without resampling. |
| Known metadata records | Retained where supported, or explicitly reported as archive-only metadata. Unknown appearance records reject. |

Each file must contain three stored merged RGB channels. Transparent merged-image conventions, negative layer counts and four-channel merged data are deferred, even though individual layers can be transparent. The saved merged image is fully decoded for validation and comparison, but Prism renders the editable layers itself. Reported recomposition differences are measurements, not a promise of Photoshop-identical rendering.

The current native geometry pipeline clips at canvas stages. Later movement or canvas expansion cannot reveal pixels that were outside the original document stage. Those source pixels remain in the full source PNG and original PSD archive. Off-canvas mask samples remain in the archive because native additional masks are document-sized. Inspection warns about these limits.

Parameterized, relative, rendered/vector-origin and real-mask variants reject. Photoshop mask feather/density settings are not silently mapped to native settings with similar names. Highly detailed masks can also exceed native bitmap metadata limits and reject without altering source alpha.

## MCP

```js
const report = prism_inspect_psd_import_file({
  path: '/absolute/path/input.psd',
  assumeSrgb: true // only when explicitly choosing this interpretation
});

prism_import_psd_file({
  path: '/absolute/path/input.psd',
  assumeSrgb: true,
  expectedSha256: report.input.sha256,
  importerVersion: report.importerVersion,
  requestId: 'stable-import-request'
});

prism_export_original_psd({ documentId, expectedRevision });
```

Import only after `supported:true` and `validation:'complete'`. Reinspect if the file or color interpretation changes. Reuse the same request ID, bytes, source filename, document name and options after an uncertain response. The import tool reads the exact local file and returns metadata; it does not send file bytes through text context. Original download writes a unique private file and returns its SHA-256.

Capabilities expose `layeredImportFormats:['psd']`, `psdImportPolicy:'rgb8-flat-raster-v1'` and import limits. Import and export support different subsets.

## Limits and validation

Input and original archive are each bounded to 64 MiB. Native canvas and source/mask rectangles stay within 8192 pixels per axis and 24 MP. There are at most 64 layers, 8 MiB of input metadata, 4096 records, 200,000 nonzero bitmap runs per mask and 16 MiB of complete native project metadata. Combined source assets/archive must fit the 256 MiB portable project limit.

A dedicated worker uses a 30-second processing deadline, one active task and at most two pending tasks. A 256 MiB accounting limit covers reserved input/decoded/encoded/transfer buffers; it is not a measurement of total process memory. Inputs exceeding aggregate pixel work, mask complexity or staging limits reject before publication. Parent-side graph, asset and archive validation runs before storage, and failed publication removes newly created files while preserving shared assets and existing projects.

The archive is passive. Portable project validation checks its bounded header, length and immutable hash without invoking the PSD parser or raster decoder. Attaching an archive does not certify that a portable project's independently editable graph was produced from it.

Independent raw and PackBits fixtures are in `tests/fixtures/psd-import`, produced by psd-tools and checked with Pillow. The implementation follows Adobe's [PSD format specification](https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/). See the [design](PSD_IMPORT_DESIGN.md), [independent review](PSD_IMPORT_REVIEW.md) and [transport contract](PSD_IMPORT_TRANSPORT_DESIGN.md) for detailed boundaries.
