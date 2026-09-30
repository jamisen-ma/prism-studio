# Imported Color Lookup

Color Lookup applies a reusable photographic look from an original `.cube` file. It is available as a global adjustment or an editable raster filter. Native, independent and full regression checks pass, along with91 focused/adjacent browser workflows and the production build.

## Import and replace

Choose **Color Lookup**, select a `.cube` file, choose **Encoded sRGB (0–1)** as its input/output interpretation, then apply. File selection stays local until Apply. A new global adjustment adopts the current selection as its mask; a source filter runs on that raster's working source pixels before transforms and uses the filter stack's effect mask.

The inspector shows the original filename, optional title, grid size and byte count. Use opacity and mask controls to combine the look with your image. Source filters also support the existing entry blend modes; global adjustment layers retain Normal blending. There is no separate intensity parameter. Original image pixels and the original lookup file stay intact.

**Replace lookup file** changes the saved look while preserving the existing layer/filter ID, name, position, opacity, blend, enabled/visible state and masks. Apply or reset pending source-filter settings before replacing the file. Choosing another file does not apply it automatically. Each successful import or replacement is one Undo step.

If the document changed while choosing a file, review the current target before applying. If a reply or preview could not be confirmed, refresh and inspect the saved layers: an accepted edit may already have committed. The editor does not retry that upload automatically.

## Supported files and interpretation

This release accepts strict UTF-8 3D `.cube` files up to 4 MiB, with grids from 2 through 33. Samples are RGB triplets, red changing fastest, in the exact authored range 0–1. Input domains must be absent or exactly 0–1. Optional title/comments, a leading BOM, LF/CRLF and ordinary decimal/exponent notation are supported within the documented parser bounds.

Larger grids, 1D/shaper combinations, extended output ranges, nonidentity domains and escaped title syntax are unsupported. Unsupported files are rejected without silently resampling their grid or clamping authored samples. Full grammar is in [the native design](COLOR_LOOKUP_DESIGN.md).

Both input and output are interpreted as **encoded sRGB**. A normalized table may have been designed for log, HDR or scene-linear images; its syntax cannot establish that intent. Prism performs no such color-space conversion. Choose a look intended for encoded sRGB, or deliberately accept that interpretation.

Native trilinear interpolation retains parsed Float64 samples and applies one final candidate-byte rounding in a fixed operation order. It preserves alpha and hidden alpha-zero RGB. Source blend/opacity follows the completed candidate, then the effect mask mixes the whole stack before geometry. Global adjustments respect existing protected content. This is an RGB8 workflow with a declared native algorithm, without Photoshop or OpenColorIO pixel-parity claims.

## Saved projects, Bake and recipes

The immutable original lookup file travels inside `.prism` projects and is verified when reopening. Replacing or deleting a look does not remove assets still needed by Undo. Flattened PNG/JPEG/WebP/TIFF exports contain the evaluated appearance. Explicit [Bake](FILTER_BAKING.md) writes evaluated source RGB to the working raster while preserving the separate cutout alpha and retained geometry; Undo remains available.

Recipes cannot carry lookup-file dependencies in this first release. Capturing a stack with a lookup requires explicitly opting out of Filters to capture other available styles. Lookup-bearing definitions are refused, including disabled entries. Ordinary recipes can still operate on a document containing a lookup; they retain existing unrelated entries and masks.

## MCP

Inspect capabilities for `colorLookupPolicy:'cube3d-f64-trilinear-srgb-v1'`, `colorLookupFormats:['cube-3d']`, `colorLookupInputSpaces:['srgb']`, advertised limits, the context's kind and `import_color_lookup` command. Source editing also requires source coordinates.

For a local file, call `prism_import_color_lookup_file`:

```json
{
  "path": "/absolute/path/Warm-look.cube",
  "documentId": "current-document-id",
  "expectedRevision": 4,
  "target": "layer-filter",
  "layerId": "current-raster-layer-id",
  "inputSpace": "srgb",
  "requestId": "stable-id-for-this-file-and-target"
}
```

Use `target:'adjustment'` without `layerId` to add a global adjustment. Supply its existing `layerId` to replace a global lookup. For source replacement, supply both `layerId` and the existing `filterId`. The result includes the document and affected IDs. The file helper reads one regular, non-symlink `.cube` file and never treats saved metadata as a path.

`prism_import_color_lookup` accepts original canonical base64 `data` and `sourceName` instead of a local path, with `backend:'native'`. Existing add/update commands can reuse a verified complete descriptor `{asset,bytes,gridSize,inputSpace,sourceName,title?}`. Creation requires a complete descriptor; update `parameters:{}` retains it, and any nonempty parameter update completely replaces it. Partial hash/size changes are rejected.

Transactions support lookup imports with a positive enclosing revision and at most 4 MiB of aggregate decoded lookup bytes. They commit together and roll back newly owned assets on failure. Reuse the same request ID and identical arguments for an uncertain-response retry only within the same companion session; this is not a durable receipt across restarts.

## Resource limits

One active Normal source lookup admits at most 12 MP under the existing weighted-work budget, or 9.6 MP with an evaluating effect mask, before other limits. Additional filters, nonnormal blending, masks and retained geometry can lower that limit. Global rendering retains the native 24 MP dimension ceiling and the joint memory admission rules.

Each evaluating occurrence is parsed independently, with no persistent compiled-table cache. The graph admits at most 32 MiB of declared original lookup bytes per nominal pass, counting repeated and hidden active entries. Retained history admits at most 128 distinct lookup files and 64 MiB of their unique original bytes. Repeated use of the same file counts once in history.

The new renderer admission combines live decoded content, root/group/clipping surfaces, masks and lookup preparation within a 256 MiB named-allocation limit. This is not a total process-memory guarantee. Existing image codecs, styles and global spatial-filter internals retain their prior limits. See [the allocation and lifetime design](COLOR_LOOKUP_DESIGN.md), [independent review](COLOR_LOOKUP_REVIEW.md), [UI acceptance plan](COLOR_LOOKUP_UI_DESIGN.md) and [MCP transport evidence](COLOR_LOOKUP_MCP_DESIGN.md).
