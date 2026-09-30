# Limited layered PSD export

Prism can export a strict Photoshop PSD v1 copy without installing Photoshop. A separate [bounded PSD importer](PSD_IMPORT.md) supports RGB8 flat raster files. PSB and general round-trip compatibility remain unavailable. Keep the native `.prism` project for source archives, every native editing feature and reusable selections.

The exporter inspects the requested document revision and returns a compatibility report before downloading it. Unsupported layers or settings reject explicitly; the exporter does not automatically flatten the document, delete features or modify the saved project.

| Supported | Behavior in the PSD copy |
| --- | --- |
| Flat raster and solid layers | Separate full-canvas RGBA8 layers, in original order with Unicode names and visibility. Solids become raster layers. |
| Normal blending | Other blend modes reject. |
| Layer opacity | Must be exactly representable as an integer 0–255 divided by 255. For example, 128/255 works; 0.5 rejects. |
| Own layer masks | Separate editable alpha8 mask channels. Effective feather/invert/clip/density coverage must be exactly representable; fractional coverage rejects. These settings are baked into the editable mask pixels in the PSD copy. |
| Native geometry | Current transforms render into each exported raster copy. Native source assets and transforms remain unchanged. |
| Transparency | Individual layer alpha, including RGB beneath zero alpha, is retained. The final merged composite must be opaque. |
| Color | 8-bit RGB with the built-in sRGB ICC profile. |

Groups, text, vectors, gradients, adjustment layers, nonempty filter stacks (including disabled entries), outside effects/outlines and layers carrying contextual generation provenance are outside this subset. Hidden unsupported layers also reject: a layered file must account for its hidden editing state. Prism protection is reported but cannot constrain editing in another application.

The file stores exact supplied layer channels and exact saved merged RGB pixels. Independent Pillow and psd-tools fixtures verify those bytes, masks, names, ICC profile and record order. Recomputing the composite in another editor may round differently; observed independent fixtures differed by at most one 8-bit channel value. This is not a Photoshop compositor-parity guarantee.

## Browser and MCP

Choose **Export → Layered PSD** to inspect compatibility. Review the layer-specific issues and warnings. Download becomes available only after a supported result for the current document revision. After changing the document, refresh compatibility before downloading. **Editable project** remains the complete native project option.

MCP exposes:

```js
prism_inspect_psd_export({ documentId, expectedRevision })
prism_export_psd({ documentId, expectedRevision })
```

Both accept an optional positive expected revision. Export always downloads the exact inspected revision, even when the caller omitted it. A concurrent edit returns `REVISION_CONFLICT` and creates no exported file. Unsupported exports return `PSD_UNSUPPORTED` with the report. Successful MCP exports create unique private `.psd` files beneath the configured `exports` directory and return their paths, byte counts and reports.

The companion's authenticated binary routes are `GET /api/psd/:documentId/inspect` and `GET /api/psd/:documentId/export`, with optional `?expectedRevision=N`. Download MIME is `image/vnd.adobe.photoshop`; response headers identify the document, revision and layer count. Two concurrent inspections/downloads are allowed. Host, Origin and session validation happen before dispatch.

## Bounds and evidence

Native dimension/node limits still apply. The uncompressed file is capped at 64 MiB, with a separate 256 MiB accounting budget for caller frames, owned writer snapshots and output. That accounting does not measure or bound whole-process resident memory. Output size is calculated before pixel allocation; fresh rendering validates mask representability and composite opacity. Preview-cache entries are not export evidence.

The writer has no parser, decompressor, filesystem access or network access. It emits raw channels and known metadata using Adobe's [PSD file-format specification](https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/). The evaluated third-party codec remains isolated under ignored test artifacts; see [codec evaluation](PSD_CODEC_EVALUATION.md).

Focused verification: `node --test tests/psd-*.test.mjs`. Browser verification: `npm run test:psd-browser`. Transport tests include authenticated downloads, unsupported reports, revision races, unique private outputs, disconnected-slot recovery and unchanged native projects. Independent byte walkers and optional isolated Pillow/psd-tools checks cover one-pixel dimensions, odd rows, low alpha, hidden RGB, masks, Unicode and ICC data.

Editable native clipping chains report `CLIPPING_UNSUPPORTED` during metadata preflight, before pixel rendering or writing. Keep `.prism` for their relationships, or export a flattened image. Guide lines and rulers never enter PSD pixels; guides and saved style presets remain native metadata.
