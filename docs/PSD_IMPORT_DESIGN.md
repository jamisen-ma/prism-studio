# Bounded editable PSD import

Status: approved backend implemented and verified, 2026-09-19. Owner checks pass 11/11, independent audit passes 12/12, and the combined owner/audit/official SDK/route run passes 30/30. The existing strict PSD exporter remains separate. This importer is a bounded third-party raster subset, not a general Photoshop document interpreter. Client and transport workstreams maintain their own browser/integration evidence.

## Recommendation

Implement a small PSD v1 RGB8 parser in a terminable worker, supporting flat normal raster layers, independent transparency and simple user masks, raw channels and bounded row-by-row PackBits. Use a stateless inspect → import flow bound to the exact input SHA-256 and importer policy. Preserve the complete original PSD as a separate immutable document archive, including inside `.prism`; never put PSD bytes into a raster `sourceAsset` or pass the archive to an image decoder during normal editing.

Keep unsupported documents unsupported. Do not silently flatten a rejected file, import just its visible pixel caches, omit an unknown rendering record, replace the editable graph with its merged preview, or call ag-psd. ZIP/PSB, alternative color spaces/depths, groups, clipping, effects, vector/text/smart-object/adjustment records, parameterized masks and transparent merged images belong to later slices with their own fixtures.

## Evidence and interpretation boundaries

Adobe's specification separates layer channels from the stored merged image. It defines length-delimited records, optional transparency/user masks, mask rectangles/defaults/flags, and raw or row-compressed channel data. ICC is an explicit resource; an RGB header alone is not color-space evidence. A negative layer count signals merged transparency. Use the specification for byte structure, not as proof that every rendering behavior has been implemented. [Adobe PSD specification](https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/).

Independent upstream code interprets layer flag bit 1 as hidden; follow that independently tested behavior despite the Adobe table's terse wording. Its layer creation API can store supplied RGBA alpha in a separate user mask. These are reasons to test actual foreign-produced files rather than only the native writer. [psd-tools layer records](https://psd-tools.readthedocs.io/en/latest/_modules/psd_tools/psd/layer_and_mask.html), [psd-tools layer API](https://psd-tools.readthedocs.io/en/latest/reference/psd_tools.api.layers.html).

The local isolated evaluation already includes independent Pillow/psd-tools decoders and producer fixtures. A fresh in-memory psd-tools 1.19.0 fixture was also examined during this review: RGB8 canvas 7×5, one hidden 4×3 raster at (-1,1), opacity 255, separate transparency and user-mask channels, RLE per layer channel, raw merged RGB, resource 1057, no extra layer records. It was 463 bytes and used normal default blending ranges. This is outside our own writer's full-canvas/raw-channel dialect and within the proposed subset. Its mask default was black and its mask origin matched the negative layer origin. The existing [codec evaluation](PSD_CODEC_EVALUATION.md) documents why ag-psd's lazy allocation, boundary handling and unsupported-record behavior are unsuitable as the production security boundary.

## Exact first subset

| Input feature | Proposed decision |
| --- | --- |
| Header | `8BPS`, version 1, zero reserved bytes, RGB mode, depth 8, **three merged channels**. Native canvas limits still apply. |
| Layers | 1–64 flat pixel layers. Zero-layer merged-only import is deferred. Normal blending only; no clipping links. Reject zero-size layer rectangles, rather than invent source dimensions. |
| Individual channels | Exactly RGB IDs 0/1/2, optional independent -1 transparency, optional -2 user mask; each at most once. Missing transparency means 255. Channel ordering is arbitrary; decode by ID. Reject extra/real/vector/spot channels. |
| Compression | Raw or PackBits, independently selected per layer channel and for merged image. No ZIP or ZIP prediction. |
| Geometry | Integer layer origins, including negatives, bounded to the native canvas-transform offset range ±8192. Each source rectangle is independently at most 8192 per axis/24 MP. Preserve its entire decoded rectangle in the source PNG; do not crop it to the document before archival/source creation. |
| Alpha and masks | Preserve layer alpha, including 0/1/128/255 and invisible RGB, separately from an editable additional user mask. Never bake a user mask into alpha and also keep that mask. |
| Mask forms | Initially no mask or the simple 20-byte mask payload with one -2 channel. Support default black/white, absolute document rectangle, inversion and disabled mask. Reject relative-position, rendered/vector-origin, parameter, real-mask and unknown flags/extended payloads until independently proven. |
| Opacity/visibility | Native opacity is exactly the stored byte divided by 255. Visibility follows independently verified hidden-bit semantics. |
| Names | Prefer validated `luni` UTF-16, preserving non-BMP code units correctly. Without it, use the documented legacy MacRoman fallback, warn `LEGACY_NAME_ENCODING`, and keep the exact original bytes in the archive. Names must fit native 200-code-unit constraints; explicitly reject oversized/malformed names. Empty names receive deterministic `Layer N` with warning. |
| Lock metadata | PSD transparency/position lock semantics do not become Prism pixel protection. Known lock flags may be ignored with a named warning; imported raster layers are initially unprotected. |
| Merged image | Require complete bounded raw/RLE RGB data, not merely a valid layer section. It is a stored compatibility image, not the source of imported layered rendering. |

Header channels 4 and negative layer counts are recognized valid PSD features but rejected as `MERGED_TRANSPARENCY_UNSUPPORTED`, not called corrupt. That keeps the known transparent-merged matte ambiguity out of this first fidelity contract. Individual layers and the resulting native composition can still contain transparency. Positive three-channel PSDs need not have an opaque recomposition; the stored RGB compatibility image may include a matte.

An absent or explicitly invalid real merged image is unsupported even if the layer data looks usable. The initial scope trades some files saved without compatibility data for full inspection of every claimed channel. Later layers-only import should be a separate explicit policy, not an accidental EOF fallback.

### Mask conversion

Decode the user mask at its own width/height, never at the layer's width/height. Construct a document-space bitmap initialized to the mask default; overlay the intersection of the absolute mask rectangle with the canvas. Keep inversion as the native bitmap `invert` property; evaluate the default consistently outside the mask rectangle. A disabled mask becomes the same editable raw mask with `maskDensity:0`, with `MASK_DISABLE_MAPPED_TO_DENSITY` warning. Every raw channel is still validated when disabled, invisible or fully transparent.

Do not map Photoshop feather/density parameters to the recently added native controls merely because the property names match. This milestone rejects them; their feather algorithms/order have not been shown equivalent. Relative mask origins are also explicitly unsupported initially. Imported simple masks have feather zero; enabled masks omit maskDensity.

The native bitmap format permits at most 600,000 run scalars (200,000 triples). Count and bound run output while scanning, before building an unbounded JavaScript array. Full-white backgrounds can be encoded compactly, but highly variable masks can exceed this budget even on a valid small PSD. Report `MASK_COMPLEXITY_LIMIT`; do not silently bake the mask into source alpha to make import fit. Serialize the complete candidate project and require ≤16 MiB before publication.

### Native geometry limitation

Represent each layer using a lossless PNG of its actual source rectangle and an integer `canvas` transform into the document, omitting the transform only when dimensions/origin already match. This preserves source RGB/alpha and initial document geometry without resampling.

The current native transform pipeline clips at each canvas stage. A later move cannot reveal source pixels clipped by the initial canvas stage, even though the complete source PNG and PSD archive still contain them. Masks become document-sized editable bitmaps, so their out-of-canvas samples survive only in the archive. Emit `OFF_CANVAS_GEOMETRY_CLIPPED` for either case and describe this as the current native geometry limitation, not Photoshop-equivalent unrestricted movement. Expanding later canvas bounds does not resurrect the already-clipped region. Original source preview still exposes the full raster source rectangle.

## Color policy

Use `assumeSrgb:false` by default. No hidden automatic conversion and no inference from channel count, an ICC description string, a filename, profile class or generic RGB signature.

1. A single bounded resource 1039 that matches a versioned **known sRGB profile byte/hash registry** is accepted without changing RGB samples. Start with the exact standard profile used by the app's current strict exporter; additional audited standard sRGB profiles can be added independently. Validate its declared length/tag bounds before matching. Header-valid unknown RGB profiles still reject as `ICC_PROFILE_UNSUPPORTED`.
2. With no ICC, inspect returns `UNTAGGED_COLOR_REQUIRES_ASSUMPTION` unless the caller explicitly chooses `assumeSrgb:true`. A second inspection with that choice can succeed and returns `UNTAGGED_ASSUMED_SRGB`. This also applies to a file explicitly marked intentionally untagged. The assumption assigns interpretation; it does not change source bytes.
3. `assumeSrgb:true` cannot override an embedded unknown/conflicting profile. Duplicate profiles, malformed ICC, contradictory resource 1041/1039 state or unsupported conversion metadata reject.
4. Each working/source PNG uses the accepted or assigned sRGB interpretation without a color transform. The archive retains the original profile and all original metadata bytes.

Record `color:{policy:'known-srgb'|'assumed-srgb',profileSha256?}` in the report. Persist the bounded accepted interpretation as informational per-layer import provenance, for example `provenance:{sourceFormat:'psd',colorPolicy:'assumed-srgb'}`; it has no generation `jobId` and cannot trigger generated-layer protection behavior. The sourceDocument archive retains its small strict identity schema, and the durable request fingerprint also binds the explicit assumption. No profile interpreter or color-management conversion engine is added to the PSD parser.

## Record policy and compatibility report

Use explicit allowlists in both image resources and additional layer/global records. Unknown records are unsupported even if their current effect appears absent. Before decoding pixels, scan every safely traversable record and return named issues with section, record/resource identifier and layer index. Stop on malformed bounds; do not continue through attacker-chosen offsets to improve the report.

Initial parsed records are ICC/untagged/version information, Unicode names and optional layer IDs. Known document-only resolution, captions/copyright/EXIF/XMP and preview thumbnails can be bounded, archived and omitted from the editable native graph with warnings; never parse embedded XML or decode a thumbnail. Candidate omitted resource IDs must be enumerated in code and fixtures, not inferred from a numeric range. Document guides/saved paths/selection metadata may likewise be omitted only when explicitly named and warned; unknown appearance-affecting resources reject.

For layer records, allow `luni`, `lyid`, known label/lock metadata with warnings, and explicitly verified neutral appearance records only. Accept absent/default blending ranges; recognize bounded repeated source/destination ranges with exact neutral bytes `00 00 ff ff`, including the independently observed 40-byte form. Nondefault ranges reject. An `iOpa` fill-opacity record may be accepted only at the independently verified identity value 255; all other values reject. Do not silently accept `lsct`/`lsdk`, `TySh`, vector masks, `SoCo`/other adjustments, object/link records, effects, knockout, channel restrictions, alternate layer blocks or unknown global blocks, even on hidden layers.

Report a rejected known feature as `PSD_UNSUPPORTED`, malformed/truncated/ambiguous input as `INVALID_PSD`, and budgets as `LIMIT_EXCEEDED`. Keep error messages static except bounded normalized layer names/record keys. No binary metadata dump, file path, raw XMP, source buffer or decoder stack enters public errors. Cap returned issues/warnings at 128 with an explicit truncated count; never truncate validation itself.

## Parser and resource boundary

The parser needs a real parent-bounded cursor (`start`, `offset`, `end`), not a read that checks only the underlying ArrayBuffer. Every length multiplication/addition is checked as a safe integer and against the enclosing section before slicing or allocating. Own caller bytes at API entry, including while another operation is queued. Work on an exact buffer/ArrayBuffer, not a pooled view that exposes adjacent bytes.

Metadata scan precedes any full raster allocation. It validates all record/channel lengths and IDs, independent layer/mask rectangles, count/depth/profile policy and the aggregate budget. It also builds row span descriptors without copying compressed channel payloads. All lengths must end on documented boundaries; section padding is consumed only at the recognized boundary, not treated as a generic license to ignore trailing data. Require file EOF after the merged stream. Duplicate semantic records/IDs are rejected when their meaning would be ambiguous; file-provided layer IDs remain informational and are never reused as native UUIDs.

PackBits rows each have an explicit source end and exact expected output width. Literal and repeated packets check both source and destination bounds before writing. A -128 no-op consumes input and produces none; valid no-ops are allowed without permitting row/channel overrun or an infinite loop. Every row must produce exactly its width and exhaust only its declared bytes; subsequent rows cannot supply missing data. Check the complete row-length table and sum before decoding. Raw channels likewise require their exact expected payload length. Odd image widths and section padding need independent fixtures; do not implement a blanket per-row pad based on an ambiguous sentence in the format documentation.

Proposed limits:

| Resource | Limit / required accounting |
| --- | --- |
| Input | 64 MiB including archive bytes; limit before copying and at authenticated HTTP body collection. |
| Canvas and each raster/mask rectangle | 8192 per axis, 24,000,000 pixels; coordinate sums/negative origins validated independently. |
| Layers | 1–64, including hidden layers. Zero-layer files are outside this slice. |
| ICC | 64 KiB, exact profile policy above. |
| Metadata input | 8 MiB cumulative non-channel sections; ≤4096 resource/additional records; each name ≤200 native code units after decoding. |
| Decoded work | 256 MiB conservative **accounted buffers across caller snapshot, worker input, decoded frames, merged frame, masks, candidate PNG assets and bounded transfer overlap**. Not just V8 heap or compressed file size. |
| Output/staging | Original archive plus normalized image assets and manifest must fit the existing 256 MiB editable bundle bound; each encoded image stays within its 128 MiB bundle asset limit. Reject before asset publication if actual encoded sizes exceed the estimate/cap. |
| Native metadata | 600,000 run scalars per mask and 16 MiB complete project JSON, including the initial history entry. |
| CPU / queue | One PSD worker active, at most two pending bounded tasks, 30-second decode/encode deadline, with total input ownership counted for pending calls. Weighted pixel work is capped at 384 million visits. Fail promptly rather than accumulate many 64 MiB uploads. |

Use a reservation ledger for simultaneous buffers rather than claiming that 256 MiB is whole-process RSS. Metadata preflight must cover all layers regardless visibility. The worker decodes/encodes one source rectangle at a time and releases temporary planes before moving on; never allocate a full document RGBA frame per imported layer. Count cached normalized PNGs and mask arrays that remain owned. Bound scan work by the input/record budgets and mask scans by canvas×mask count, and terminate on deadline. A constrained decoded-pixel-work allowance can reject pathological many-mask cases before starting a long scan.

The implemented conservative reservation is `2*inputBytes + 2*pngUpperBound + 9*largestSourcePixels + largestMaskPixels + 8*canvasPixels + 64MiB`. The two PNG bounds include original Sharp output buffers and exclusive exact transfer copies; source/native-validation frames and comparison planes are included. User masks are converted to bounded runs by scanning document coordinates, without allocating a separate full-canvas alpha buffer for each mask. Metadata/run counts and the worker's 128 MiB old-generation/16 MiB young-generation limits supplement this accounted-buffer budget; it is not a process RSS promise. Large valid PSDs may reject the import working budget even when their compressed input or the separate export budget fits.

Direct native callers use the same admission gate as HTTP/MCP, before copying the input. Reserve the caller/input overlap and the exact worker-owned snapshot conservatively; transferring that owned ArrayBuffer avoids an additional transfer copy but does not make the original request allocation disappear from accounting. Pending calls hold reserved input bytes; the count limit does not guarantee admission of two large waiting files when the byte budget is already full. If a copied transfer or DTO clone is used, explicitly reserve the overlap until its source is released. Full-canvas user-mask expansion and cumulative PNG staging count too. Retain the reservation through the queued publication stage until staged buffers are released.

The worker sends only validated bounded DTOs and transferable owned buffers. Parent revalidates output structure, dimensions, hashes, resource counts and native graph before file writes. A worker V8 heap limit is supplementary; external Buffer memory requires the ledger. Cancellation/timeout waits for worker termination and cannot publish later. Native publication is serialized with edits/generation; worker parsing occurs outside the native queue because it has no project or asset writes. Capture immutable input, and make the final queue stage recheck policy and candidate metadata.

## Stateless API and reusable preview

Proposed native methods:

```js
inspectPsdImport({ data, assumeSrgb = false, sourceName?, name?, signal? })
  // -> report; no writes, project creation or server-retained upload token

importPsd({ data, expectedSha256, importerVersion: 1, requestId,
            assumeSrgb = false, sourceName?, name?, signal? })
  // -> { document, report, historyIncluded: false }

exportOriginalPsd({ documentId, expectedRevision? })
  // -> { data: originalBuffer, filename, mimeType: 'application/octet-stream',
  //      documentId, revision, sha256, bytes }
```

Shared root exports are `PSD_IMPORT_VERSION = 1`, `PSD_IMPORT_SUBSET = 'rgb8-flat-raster-v1'`, `PSD_IMPORT_MAX_BYTES = 64 * 1024 * 1024` and `psdImportFingerprint(...)` from `shared/psd-import.mjs`.

`sourceName` is a sanitized display/download basename retained with the archive, always ending in `.psd` within 160 characters; `name` changes only the new document title. Neither determines format or disk paths. HTTP/MCP coalesces matching requests, while native durable request-ID dedup handles restart. Its shared fingerprint includes bytes hash, importer version, explicit color choice and both original name arguments. A repeated ID with different interpretation or names conflicts; a retry of identical bytes/options returns the original result without creating another document.

Persist `project.psdImportReceipt:{requestId,fingerprint}` atomically in the new project envelope, outside the portable graph and history. Validate receipt shape and duplicate/conflicting IDs during startup. Inside the final native queue stage, check all existing receipts before any writes and return the existing document on an identical retry; rerun the bounded report if needed. The ephemeral transport receipt map remains capped at 200. A crash after project publication but before response delivery or a separate transport receipt write therefore cannot create a second document on retry. A portable clone does not inherit the receipt.

Read-only inspection accepts an AbortSignal. The HTTP route cancels inspection on disconnect and keeps admission reserved until worker termination. Accepted HTTP imports intentionally finish after a single caller disconnects, because another same-ID waiter may still be attached and the durable receipt recovers the result. Direct native import may provide a signal to cancel before publication; after the durable commit boundary the successful document identity remains authoritative.

Inspect returns a bounded JSON report, for example:

```js
{
  format: 'psd', importerVersion: 1, subsetId: 'rgb8-flat-raster-v1',
  input: { sha256, bytes }, options: { assumeSrgb: false },
  supported: true, validation: 'complete', requiresSrgbAssumption: false,
  document: { width, height, layerCount, bitsPerChannel: 8,
              colorMode: 'RGB', mergedChannels: 3 },
  color: { policy: 'known-srgb', profileSha256 },
  layers: [{ index, name, bounds: { x, y, width, height },
             visible, opacity, hasTransparency, hasMask }],
  issues: [], warnings: [{ code, message, layerIndex?, recordKey?, resourceId? }],
  preserves: ['raster-rgb-alpha', 'editable-user-masks', 'layer-order',
              'opacity-visibility', 'original-psd-archive'],
  omits: ['photoshop-history', 'photoshop-editing-lock-semantics'],
  estimatedWorkingBytes, estimatedProjectBytes,
  originalArchiveIncluded: true
}
```

Only return `supported:true`/`validation:'complete'` after full raw/RLE decoding, all policy checks, run complexity and candidate-native-graph/serialized-size validation. For rejected early/unsupported files use `validation:'rejected'` with the bounded partial metadata available; never imply the remaining channels were checked. Set `requiresSrgbAssumption:true` only when the absent/intentionally untagged profile needs the explicit policy choice; an embedded unsupported profile must not expose this as an override. An untagged color assumption requires reinspection before a complete supported result is available.

Import does not trust the report supplied by a browser or MCP caller. It hashes the repeated exact bytes, checks expected hash/version/options and reruns the entire validation under the current importer. Changing the file or policy invalidates the earlier review. New unsupported metadata cannot be smuggled through a favorable earlier report.

No pre-import bitmap preview method, report field or route is implemented in this slice. Parsed merged pixels are used for complete validation and measured diagnostics, then released. Normal `get_preview` after import shows the actual editable graph; it never substitutes the saved merged image. Do not stash an upload token or return large base64 images inside report JSON. The report includes `comparison:{reference:'stored-merged-rgb',comparedWith:'native-flat-recomposition',maxChannelDifference,differingChannels,transparentPixels,alphaComparable}`. The independent producer differs by at most one channel value in seven channels; these measurements describe the fixture, not a guarantee about other files. Transparent native pixels are explicitly reported because the saved RGB composite has no alpha to compare.

Root's proposed routes fit: binary `POST /api/psd/inspect-import`, binary `POST /api/psd/import` with required `X-Prism-Expected-Sha256`, `X-Prism-Importer-Version` and `X-Prism-Request-Id`, and `GET /api/psd/:documentId/original?expectedRevision=N`. Query values are `assumeSrgb=true|false`, `sourceName` and optional document `name`. Existing .prism and flattened image opening remain distinct format choices.

## Immutable archive and atomic publication

Persist optional strict graph metadata:

```js
sourceDocument: {
  format: 'psd', asset: sha256, bytes: inputByteLength, name: safeSourceBasename
}
```

The archive is passive, byte-identical and belongs to the document. Native source PNGs are newly encoded lossless working/source assets extracted from its independent raster channels; their `sourceFormat` is PNG, not PSD. Give all native layers new UUIDs, no generated provenance and no protection by default. Keep original PSD layer IDs only as bounded informational provenance if needed. New document revision 1 has a single initial history entry, not invented Photoshop undo history.

Separate image/archive asset roles throughout `projectAssetUses`, bundle collection, import validation and original download. Add sourceDocument to the bundle graph allowlist and asset references; raise maximum distinct assets from 192 to **193** for 64×3 image references plus one archive, preserving the existing total-byte cap. Reject the same hash used as archive and raster/alpha/source image. Dedup archive hashes between separate documents is safe because blobs remain immutable.

For `.prism` import/reopen/download the archive is not rerun through the PSD parser and cannot certify the editable graph. Validate exact sourceDocument fields, bounded length/hash and a bounded supported PSD header, with no decode or recursion. Validate raster assets and graph independently as today. Unknown/currently unsupported internals can remain in a passive archived original without executing a parser. A fresh original download re-reads and verifies bytes/hash, returning a safe attachment filename; it never exports the edited document under the guise of its original.

Before publication: validate every candidate raster/mask and archive role; complete graph, bitmap and project-size checks; preflight total staged bytes; create all content-addressed assets and record only newly created hashes. Atomically persist a new project, then publish it in memory and the dedup receipt. On any failure, remove the new project and only newly created unshared assets using the proven editable-bundle import rollback pattern; never remove preexisting deduplicated assets. Check cancellation before the commit boundary. After a successful commit, a later network disconnect affects response delivery, not project identity or receipt recoverability.

Metadata transactions, undo, geometry and future exports keep sourceDocument unchanged. A current-state `.prism` export retains the original archive even after all imported layers are edited or deleted. Exported PNG/JPEG/WebP/TIFF/PSD remain new documents/images; downloading the original is a separate explicitly labeled action.

## Acceptance before advertising

1. Independently produced psd-tools files, not just own exports: mixed raw/RLE; odd/one-pixel dimensions; independently confirmed bottom-to-top record order; nonuniform RGB; alpha 0/1/128/255; -1 and -2 independently and together; hidden layers; byte opacity; negative/different layer/mask origins; default white/black masks; Unicode and fallback names. Compare decoded source bytes and raw mask channels independently before comparing composites.
2. Simple disabled/inverted masks and empty mask intersections: native effective coverage exact, density-zero validation still complete, original/source previews and PSD archive exact, no double alpha application. Negative source pixels retained in PNG despite the documented later-movement limitation.
3. PackBits independent reference/fuzz fixtures: literal/repeat edges, 128-length packets, legal no-ops, short/long rows, corrupt row tables, mismatched dimensions, truncated channel/section/merged bytes, duplicate IDs, overlaps and trailing bytes. Canary-backed subarrays prove no read beyond the supplied input view.
4. Named rejection fixtures for every forbidden mode/depth/compression/record/global block/mask flag, including hidden layers and parameter fields with neutral-looking values. Known neutral ranges from an independent producer must pass.
5. Known sRGB passes unchanged; valid unknown RGB ICC and malformed/duplicate ICC reject; untagged defaults reject, explicit assignment succeeds with warning, changed color choice/request fingerprint cannot replay an old import.
6. Metadata-only huge rectangles/channel claims and cumulative many-layer/mask work reject before allocation. Real worker timeout/cancel stops execution; no late publication. Peak buffer reservations include transfer overlap and masks; queued file snapshots have a bound. Mask run overflow and oversized native metadata reject before asset writes.
7. Stale/tampered hash/version/options, simultaneous identical/different request IDs, lost response/restart, ENOSPC and injected failure before/after asset creation or project rename: no duplicate document, no partial graph, no changed original/shared assets, sanitized errors.
8. Original archive byte equality across edits/undo/reopen/.prism export/import/download; malformed archive roles and archive/image hash collisions reject before image decoding. Independent bundle tests exercise the 193-reference limit and unchanged 256 MiB cap.
9. Actual SDK/MCP and browser inspection/import/original download with compatibility messages, explicit untagged choice and no false general-PSD support claim. Build and existing import/project/generation/protection tests remain green.

## Decisions still requiring implementation proof

The first ICC registry is the exact sRGB profile used by the current Sharp native exporter. The parser's explicit resource/tag allowlists and padding rules are covered by local raw/RLE writer and independent-producer fixtures; expanding any allowlist requires new evidence. Pre-import preview, merged-only documents, more tolerant empty layers, relative/parameterized masks, transparent merged channels, Photoshop geometry recovery and color-profile conversion remain separate contracts. None is implicitly implemented by this document.
