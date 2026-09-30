# Document resize resampling

Status: implemented native backend, 2026-09-19. Root approved the contract and independent review found no production blocker. The owner, independent, schema and official MCP suites pass 21 tests together. Full-suite and client acceptance are coordinated separately by root.

## Implemented first slice

The existing document image resize now accepts an explicit interpolation choice. The current default and existing mask, selection, guide, protection and history semantics remain. This is a document-wide geometry operation; it does not replace individual affine transforms, change source pixels, reflow text, alter canvas-bounds resizing or add automatic image enhancement.

```ts
resize_document({
  documentId,
  expectedRevision?,
  width, height,
  resample?: 'nearest' | 'cubic' | 'mitchell' | 'lanczos3'
})
```

Omitted `resample` means `lanczos3`, exactly as today. Explicit `lanczos3` is equivalent to omission, including the persisted transform. Reject unknown values, null and nonstrings rather than choosing a fallback. The shared command schema, MCP description and direct native entry all validate the field. Explicit resampling is native-only; an older bridge must reject it rather than ignore it.

Capabilities are `documentResizeMethods: ['nearest','cubic','mitchell','lanczos3']` and `documentResizeDefault: 'lanczos3'`. Existing `limits.maxDimension`, `limits.maxPixels` and transform-count admission remain authoritative; no new command is added. UI labels can be “Nearest neighbor”, “Cubic”, “Mitchell” and “Lanczos3 (default)”. Explain that the interpolation choice applies to layer image pixels; masks and selections retain their existing resize behavior. The nearest option is useful for pixel art, while the other choices offer different image-reduction filters. No Photoshop pixel-parity claim is made.

## Current engine and compatibility boundary

`NativeBackend.renderLayer` decodes the current working RGBA, combines the separate source cutout alpha, evaluates editable source-space filters, and calls `renderLayerGeometry`. Existing geometry then replays each crop, canvas translation, affine or resize in order. Every legacy resize uses a separate Sharp raw pipeline with `fit:'fill', kernel:'lanczos3'`. Text/vector/gradient/solid layers are rendered at their retained source dimensions before the same geometry is applied. Multiple resizes remain separate stages: do not fuse, reorder or replace earlier stages.

Adding an ignored `kernel` property to the existing persisted `type:'resize'` would be unsafe: older readers accept the type and silently use Lanczos3. Persist nondefault choices under a new type:

```ts
// Omitted or explicit default: unchanged legacy representation.
{ type: 'resize', width, height }

// Nondefault command choices: old readers reject the unknown type.
{ type: 'resample', width, height, kernel: 'nearest' | 'cubic' | 'mitchell' }
```

The new `resample` validator accepts only the four supported kernel values and exactly the keys `type,width,height,kernel`; it accepts `lanczos3` in a manually authored current-format graph, but normal command writes use the legacy representation for that choice. Missing kernels and surplus fields reject. Both `kernel` and `resample` on legacy `resize` reject rather than silently ignoring an apparent request. Other legacy transform field validation remains unchanged.

No project-bundle container version change is required: old native graph validators already reject unknown transform types before reading image assets. Verify that with a captured legacy-validation fixture. The `.prism` codec calls native graph validation before asset validation/publication; invalid or unsupported transforms must fail there. Current duplicate, undo/redo, reopen and bundle paths preserve the full retained list. Source images and their hashes remain unchanged. Existing PSD export renders geometry into exported copies under its normal warning; original imported PSD archives remain unchanged.

## Exact nearest behavior

Sharp's nearest resize is unsuitable for an exact pixel-copy promise. In the installed 0.35.4 pipeline, resize premultiplies alpha in the input band format and later unpremultiplies. A local four-pixel fixture `[240,7,9,0], [4,121,230,1], [11,23,117,128], [20,40,60,255]` enlarged to 8×2 becomes samples `[0,0,0,0], [0,0,0,1], [9,21,115,128], [20,40,60,255]` through Sharp nearest. Its enlargement coordinate mapping also differs from the existing native bitmap-mask center sampling.

Implement nearest using a small bounded asynchronous native RGBA copy helper. For output integer coordinates `(x,y)`:

```
sx = floor(((2*x + 1) * inputWidth)  / (2*outputWidth))
sy = floor(((2*y + 1) * inputHeight) / (2*outputHeight))
outputRGBA(x,y) = inputRGBA(sx,sy)
```

Copy all four bytes exactly, including nonzero hidden RGB, alpha 1 and alpha 128. Products are exact safe integers under the existing 8192-axis limits. For 3→5, horizontal samples are `[0,0,1,2,2]`; for 3→4, `[0,1,1,2]`. This is Prism's pixel-center rule, not a promise of Sharp nearest output equivalence. Integer enlargement replicates exact pixels. Reduction chooses samples and can discard small details. Same-size copies are byte-identical.

The exactness claim applies to the RGBA entering this geometry stage. Earlier decoding, separate-alpha multiplication, filters, previous transforms and later styles/compositing retain their existing behavior. In particular this does not promise arbitrary soft-alpha layer compositing is a source-byte copy.

The helper seam in `server/resampling.mjs` is `resamplePixels(input, oldWidth, oldHeight, {type:'resample',width,height,kernel}) -> Promise<Buffer>`, with `normalizeResampleTransform`, `normalizeDocumentResizeMethod`, `DOCUMENT_RESIZE_METHODS` and `DOCUMENT_RESIZE_DEFAULT`. Nearest allocates one output RGBA frame, uses integer arithmetic per sample and yields every `min(32,floor(65536/outputWidth))` rows. It allocates no per-pixel objects or coordinate map. Other methods use the existing Sharp raw pipeline with the chosen kernel.

## Photo interpolation semantics

Installed Sharp supports cubic, Mitchell and Lanczos3 reduction. Its documented upsampling behavior maps unmatched reduction kernels to cubic; these three choices can therefore produce identical results for enlargement. Mixed-axis resizing uses the chosen reduction kernel on shrinking axes and the inferred interpolator on enlarging axes. Keep those backend semantics rather than introducing a second photo resampling implementation. [Sharp resize reference](https://sharp.pixelplumbing.com/api-resize/), [libvips resize reference](https://www.libvips.org/API/current/method.Image.resize.html).

Use exactly the existing raw RGBA/sRGB pipeline; do not add a gamma conversion, alpha normalization, different shrink-on-load behavior or implicit sharpening. The current implementation's alpha premultiplication/rounding remains observable for these methods. The explicit default and omitted default must produce byte-equal legacy results across downsample, enlarge, mixed-axis and repeated-transform cases. Dependency versions should continue to be pinned and tested; retained method metadata does not freeze every future libvips implementation detail.

## All geometry consumers

Build two descriptors for a resize: the persisted content transform (`resize` or `resample`) and a separate ordinary `{type:'resize',width,height}` descriptor for document-coordinate metadata. Never pass `resample` to helpers that distinguish resize by type; doing so would accidentally leave geometric masks and guides unscaled.

| Consumer | Behavior for every method |
| --- | --- |
| Raster working RGB / working alpha | Replay the chosen method once at this point in the retained geometry list. No asset writes. |
| Separate `alphaAsset` | Multiply into working alpha before filters and geometry as today. Never independently resize it and multiply again. |
| Source filters / protected restoration | Evaluate filters before geometry. Both filtered and original geometry use the same chosen method before lower-protected RGB restoration. Source work weights remain based on source dimensions. |
| Solid, text, shape, path, gradient | Render original source content then resample with the same document method. Text typography and source coordinates remain editable; this is not text reflow or font-size editing. |
| Additional bitmap masks, including group/adjustment masks | Existing center-nearest raw alpha sampling; preserve invert and multiply feather by the smaller dimension ratio. Preserve separate density. |
| Geometric masks | Existing analytical scale of bounds, points and persisted clip; feather scales by the smaller ratio. No alpha quantization is added. |
| Positioned additional masks | Existing `MASK_POSITION_REQUIRES_RASTERIZE` for any actual dimension change, including hidden/density-zero masks. User can explicitly rasterize them first. A same-size operation retains the existing identity treatment. |
| Active/saved selections | The same existing bitmap/geometric mask transforms, independent of image method. Empty active bitmap stays non-null. |
| Guides | Existing proportional rounded positions, IDs and order retained; method does not alter rounding. |
| Groups, clipping, styles, generated protection | Normal render ordering remains. Additional mask/effect parameters remain in their existing spaces; do not bake groups or flatten clipping. |
| Selection loading / isolated previews / arrangement / source inspection | Consumers that render geometry automatically use the new transform. Raw original/source-alpha previews remain unresized. |
| PSD export / bitmap export / generation snapshots | Existing native rendering produces the chosen geometry. PSD is still subject to its current subset/precision restrictions. No new provider call. |

Protection remains explicit: if any protected content exists, keep the existing proportional-dimension test `abs(newW*oldH-newH*oldW) <= .5*max(oldW,oldH)`. It permits ordinary proportional image resampling, which can change sampled RGB/alpha; it does not unprotect layers or permit an anisotropic edit. Hidden protected nodes count. Do not change the protected test to key on the new persisted type: branch on the resize command or ordinary metadata transform.

## Resources and atomicity

Retain all current dimension (8192 axes, 24 MP), layer (64), retained-transform (500), source-filter, group/clipping and positioned-mask resource checks. The new nearest helper owns `4*outputPixels` bytes alongside its caller's input; the two RGBA frames are at most 192,000,000 bytes under the existing per-stage limits. Original source and contextual renderer frames may also coexist. This is an incremental-buffer statement, not a new 256 MiB whole-operation or process-RSS guarantee. Photo resampling continues to execute inside the existing native codec bounds.

`estimateLayerSelectionBytes` and PSD preparation already enumerate each transform's dimensions while retaining original/current/next geometry; their non-affine logic naturally includes `resample`. `validateLayerFilterResources` already uses maximum retained-stage area. Audit both paths with new transforms rather than adding another independent allowance. Legacy bitmap resize/RLE helpers are synchronous; the new nearest yields do not make the whole metadata resize or every legacy affine transform nonblocking.

Resize remains a metadata-only mutation until later rendering: it creates no source assets and requires no new rollback collector. Stage all layer transforms, masks, selections and guides on the existing private graph; a bad method, positioned mask, protection violation, transform count, RLE complexity or final graph/history-size failure must discard the whole edit. Normal revision checking, session retry dedupe and one-step undo apply. Transaction behavior stays unchanged, including scoped intermediate validation when positioned masks exist. Repeated scale-down/scale-up is sequential resampling and cannot recover previously discarded samples merely because original source assets are retained.

## Scope and acceptance

Production ownership can remain small: one resampling helper plus native graph validation/dispatch/render integration; shared argument schema and MCP/capability forwarding; client type and Resize panel control; owner and independent tests. No mask, guide, filter, recipe or project-container format rewrite is expected. If the implementation discovers that an existing estimator assumes only old transform names, update that specific consumer before advertising capability.

Acceptance requires:

1. Legacy omission and explicit Lanczos3 exactly match captured existing native renders across all content types, alpha, filters, geometry, masks, groups and clipping. Existing graphs remain unchanged on reopen.
2. Independent BigInt center-index oracle proves exact nearest RGBA for odd dimensions, up/down/mixed ratios, one-pixel axes, all 256 alpha values and hidden RGB. Same-size nearest and integer pixel-art enlargement are exact. Test async heartbeat at maximum width without claiming a scheduling deadline.
3. Actual native cubic/Mitchell/Lanczos3 reduction fixtures differ where expected, enlargement follows documented backend mapping, and default remains equal. Do not use the production helper as its own expected-output oracle.
4. Every mask type, inversion/feather/density, active/saved selection and guide remains equal to the existing resize-metadata oracle for every image method. Include additional masks on hidden groups/adjustments. All positioned wrappers block actual scaling before image I/O.
5. Separate source alpha combines only once before spatial/source filters; contextual lower protection uses identical resampling for original and filtered surfaces. Proportional protected resize succeeds, incompatible proportions fail atomically.
6. Strict new transform fields/methods and missing/invalid method rejection occur before asset reads on portable import. A captured old validator rejects `resample`; no default substitution. Dimensions and 500-stage/resource boundaries remain enforced.
7. Undo/redo, one-step transactions, stale revision, actual persistence failure, duplicate, reopen, `.prism`, native exports and recipe-inert metadata remain intact; original/working/source-alpha files are byte-identical.
8. Client hides unsupported choices, preserves the chosen method while reviewing positioned masks, dispatches captured dimensions/method only to the intended revision, and does not offer a resize-method control in canvas-bounds mode.

## Feasibility evidence

`test-results/resize-resampling-evaluation/probe.mjs` and `report.json` record the installed Sharp/libvips versions and all supported kernels. Eight dimension fixtures pass independent BigInt exact-nearest indexing, eight pass legacy bitmap resize/feather/inversion comparisons, and eight pass geometric-mask/guide checks. Omitted Sharp kernel equals explicit Lanczos3 in all eight. Actual outputs document the soft-alpha counterexample and pure-enlargement versus reduction/mixed-axis kernel behavior.

The production owner suite `tests/resampling.test.mjs` passes 10 cases. It adds strict descriptor/hostile-object checks, all 256 alpha values, odd center mappings, an 8192-wide yielding fixture, actual native legacy/default equivalence, every editable content type, independent mask/guide geometry, separate cutout/filter ordering, full generated clipping and isolated-group traversal over protected soft-alpha footprints, source-byte preservation, stale/portable/reopen/Undo/transaction behavior and actual `ENOTDIR` rollback. A retained-source/frame estimator check verifies new stages remain in existing admission calculations.

The independent `tests/resize-resampling-audit.test.mjs` passes eight cases, including 87 independent nearest fixtures, sequential legacy Sharp rendering, a 500-transform boundary, invalid bundles before assets, and metadata-only large intermediate-frame admission for selection/filter/PSD paths. Root's two shared-schema cases and official MCP workflow pass. All four files pass together (21/21). Root owns full regression, public usage documentation and client acceptance.
