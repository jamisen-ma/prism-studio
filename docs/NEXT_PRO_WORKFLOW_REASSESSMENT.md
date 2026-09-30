# Next professional workflow: reassessment after channel storage probes

Status: independent design review, 2026-09-19. **No next-feature production change.** Curves banks is accepted: integrated1076, focused8 plus adjacent75 browser workflows, maintained client6, build and the separate accessibility review are green. This review reads the current asset/evaluator/recipe seams and the actual reports supporting [the channel candidate](CHANNEL_WORKFLOW_CANDIDATE.md) and [architecture's comparison](CHANNEL_WORKFLOW_EVALUATION.md).

## Recommendation

Advance a narrowly specified **imported 3D color lookup** next. Its complete first slice should include an immutable original `.cube` asset, typed metadata, atomic import-and-attach or replacement, source/global evaluation, Undo, restart and editable-project transfer. Explicitly refuse recipes that contain a LUT dependency until a transferable recipe dependency format exists. No library, persistent table cache or mask storage redesign is necessary.

Keep separately named tonal-range selection as a later candidate. Do not ship continuous channel loading with an implicit threshold/downsample fallback, and do not enlarge the existing RLE/history limits to make it fit. Channel inspection alone is useful but a smaller workflow improvement than importing reusable looks after the recently completed HSL, Selective Color and Curves banks controls.

Adobe describes reusable CUBE look export, including a grid-size/quality choice. This supports the interchange workflow, not Photoshop numerical parity or acceptance of every exported size. Adobe's Color Range workflow separately supports tonal selections and partial coverage; that is a legitimate distinct feature, not a substitute name for copying a continuous component channel. [Adobe LUT export](https://helpx.adobe.com/photoshop/using/export-color-lookup-tables.html), [Adobe Color Range](https://helpx.adobe.com/photoshop/desktop/make-selections/freehand-selections/select-a-color-range-in-photoshop.html)

## Why the channel result changes the earlier roadmap

`test-results/channel-workflow-evaluation/coverage-report.json` measures all four color/luma channels of the existing512² photo above200000 nonzero runs: Red208343, Green204368, Blue210469 and luma205876. All are invalid under the current600000-scalar limit. At1024², the color/luma counts are724712–769209. Opaque alpha needs only one run, which does not rescue the intended color-separation workflow.

Architecture's separate `tonal-report.json` shows the tradeoff, rather than hiding it:

| Selection on the photograph | 512² runs | 1024² runs |
| --- | ---: | ---: |
| Continuous luma | 205876, rejected | 732853, rejected |
| Explicit64–192 ramp | 122353 | 439911, rejected |
| Explicit112–144 ramp | 41643 | 145968 |
| Explicit threshold128 | 6086 | 12162 |

Even threshold128 exceeds the bound on the1MP gray-noise and near-threshold-noise examples, at262030 and262207 runs. Partial transparency can introduce more coverage values. Thus a tonal-range tool must preserve authored endpoints/falloff and report a real complexity refusal. It cannot promise arbitrary photographic selections merely because the thresholded astronaut fits.

An asset-backed alpha mask would solve a broader storage problem but is a larger project. Current `maskCoverage`/`layerMaskCoverage` consumers are synchronous across render, source/global masks, selections, painting, geometry and preview paths. A new opaque reference cannot be inserted into this metadata without changing preparation/lifetime assumptions throughout those existing APIs. A LUT asset instead introduces two new-kind preparation seams while leaving existing mask representations alone.

## Smallest useful LUT contract

Use a distinct native global/source kind with value0 and a strict descriptor carrying the content hash, original byte length, grid size and an explicit input/numerical policy. Preserve the sole durable original text asset; do not invent a second stored compiled-table asset in the first slice. Old readers must reject the unknown kind rather than ignore the reference. Names of commands, descriptor fields and policy remain architecture's design responsibility.

A defensible starting format is3D-only grids2–33, red-fastest RGB triplets, absent or identity `DOMAIN_MIN/MAX`, finite output samples in[0,1], and encoded-sRGB RGB8 input. Reject unsupported1D/combined shapers, other domains, extended samples, duplicate/conflicting headers, wrong row counts and trailing data. Reject rather than silently clamp or resample the imported table. Grid33 is a proposed bounded subset, not a `.cube` standard maximum; document that larger valid files are unsupported initially.

**A normalized domain does not identify a LUT's intended color space.** Log-input LUTs may also use0–1 domains and samples. Require explicit encoded-sRGB interpretation and disclose that no log/HDR/scene-linear conversion occurs; do not claim the parser can recognize and reject every log-intended file. The primary OpenColorIO format reader permits separate1D/3D tables, optional domains and out-of-range outputs, so the proposed scope intentionally accepts less than that reader. [OpenColorIO Iridas Cube reader](https://github.com/AcademySoftwareFoundation/OpenColorIO/blob/main/src/OpenColorIO/fileformats/FileFormatIridasCube.cpp)

Pin comment/whitespace/exponent/BOM/newline handling and bounded title/numeric-token/line lengths. Avoid a complete split/token array. An8MiB original-byte ceiling is a candidate to benchmark, not a frozen requirement; bound every accepted parser path independently of grid size because comments and numeric spellings can dominate the file. Validate sample interpretation and useful licensed real-file examples before claiming interchange acceptance.

## Numerical choice: Float64 favored, Q16 viable but different

The independent design-only probe is `test-results/color-lookup-review/numeric-probe.mjs`, with no production/prototype imports. Its saved `numeric-report.json` compares a declared weighted-sum Float64 order and a Q16 table against exact BigInt references for100000 sets of eight exact dyadic samples. It also checks all256 input levels for every identity grid size2–33, yielding8192 checks.

| Representation at33³ | Table bytes | Changes from exact original samples in this corpus |
| --- | ---: | ---: |
| Q16 unsigned samples | 215622 | 49 of100000 output bytes |
| Float64 samples | 862488 | 0 of100000 output bytes |

The Float64 result is corpus evidence, not an exact-real guarantee. A final implementation must freeze corner accumulation/interpolation order, conversion to byte space, clamping and final `Math.round`; adjacent-value and exact-half fixtures should pin native behavior. No per-pixel BigInt is needed for that declared policy. Preserve the original text even when its decimal values require binary64 parsing.

Q16 has a short exact interpolation proof. For RGB8 input and gridK, use the exact quotient/remainder of `C*(K-1)` over255, with a valid final cell at C255. Eight nonnegative integer weights sum to255³. With samples0–65535, numerator `U<=65535*255³=1086660410625<2^40`; output denominator `D=65535*255²=4261413375<2^32`. Every sum and `(2U+D)` is an exact Number integer. The distance of a nonintegral quotient from an integer is at least `1/(2D)>2^-33`, far larger than binary64 division rounding below256, so `floor((2U+D)/(2D))` is exact half-up. All100000 Q16 comparisons match the independent BigInt result.

The cost is a new sample-quantization stage. Ideal nearest Q16 samples have maximum pre-byte error `255/(2*65535)=0.00194553` in byte units under convex trilinear interpolation, but final rounding can still differ by one byte. This occurs on a simple useful gain, not only an artificial discontinuous table: size2, red output endpoints0 and`255/256=0.99609375`, input red128. Original interpolation gives127.5→128; Q16 rounds the upper endpoint to65279 and produces a value just below127.5→127. The fixture is retained in the report. The bound refers to nearest quantization of the interpreted samples; a `Number(token)`/multiplication quantizer must declare its own native setup order rather than claim exact decimal quantization.

My preference is Float64 for preserving imported samples and avoiding that extra stage. The additional646866 bytes at33³ are bounded and often smaller than encoded-text/parser preparation. Q16 remains an honest alternative if its distinct policy is selected explicitly after photo/throughput comparison. Neither choice implies OpenColorIO or Adobe pixel parity; trilinear versus tetrahedral interpolation is itself a meaningful policy choice.

## Required ownership and phase changes

The current source confirms the following concrete work. This is a bounded integration, not just adding a transform to the kind registry.

| Seam | Required behavior |
| --- | --- |
| `server/project-bundle.mjs` reference walker | Add kind-aware LUT references from global layers and source entries, including mask wrappers; current enumeration only carries raster fields and the preserved source document. Keep exact referenced-asset matching and unchanged bundle limits. |
| Native `projectAssetUses`/`validateProjectAsset` | Validate every typed use; a hash must not bypass raster or PSD checks by also being called a LUT. Match declared bytes/grid/policy to verified original bytes before publication. Repeated compatible uses can share a hash. |
| Startup/history | Validate LUT metadata in every retained state and define bounded verification of referenced LUT assets, including inactive/history-only references. Do not validate only the current visible graph. |
| `readProjectAsset`/`storeAsset` | Reuse bounded same-fd read/hash verification and atomic immutable publication. Verify descriptor exact length as well as maximum. Import arguments/bytes must be owned at call time, and the queued operation must check revision/target before attachment. |
| `applyLayerFilters` and global `applyAdjustment` | Accept an explicit bounded asynchronous resolver/preparation path for this kind. Never do file I/O from `adjustmentTransform` or per pixel. Missing resolver must fail clearly. Finish one entry's table before preparing another; no graph-wide table map/cache. |
| Bake, Distort and ordinary render estimates | Admit metadata/work before reading images or LUT bytes. Include preparation bytes/text/table, then retained table with the actual image phase. A table and Gaussian ring from sequential entries use a phase maximum; persistent noise remains a separate reserve. |
| Recipes | Reject LUT-bearing definitions/slots/steps at shared/native validation and capture, not merely in the browser. Preserve unrelated recipe capture and explicit filter opt-out. An unrelated recipe appending an ordinary filter to a document already containing a LUT need not be prohibited if its own definition carries no dependency. |

The graph may already retain original/effective source, working output, ancestor/clipping surfaces and mask callbacks when parsing starts. Therefore `3*encodedBytes+tableBytes` is only a possible **parser component**, not a total peak. A whole UTF-8 Buffer plus worst-case two-byte decoded string plus table gives that named component only if no full second string/token array is retained; stream/slice parsing may lower it. Include bounded token/setup storage. Parser text must be out of scope before the pixel loop, and the current table must be out of scope before the deferred source-stack mask. Separate helpers can make those lifetimes reviewable. These are named reachable allocations, not instantaneous-GC/RSS promises.

Global tables need a named graph-wide serial reserve, including hidden positive-opacity metadata when current admission is intentionally conservative. Source tables feed direct-stack, full masked-source, Bake filtering and Distort leaf estimates. Bake keeps its already counted encoded source/alpha inputs; LUT encoded bytes add to preparation, not to every later phase. Import/portable paths already retain their own request/bundle payloads and must account those separately rather than reuse the render formula blindly. Measure parsing and pixel loops independently, with bounded cooperative yields and repeated-entry cumulative work; a small image with many maximum-length LUTs must not evade preparation admission merely because pixel work is cheap.

For alpha, source RGB skips zero-alpha pixels and preserves all alpha exactly. Recommend the same color-mapping hidden-RGB policy for the new global kind. Candidate bytes are established before existing source blend/opacity; whole-stack effect masks remain deferred; spatial transforms follow source evaluation. Identity tables remain structurally active, including nonnormal blends and protected-source restrictions. Disabled/zero-opacity entries may skip table preparation during evaluation but still require valid metadata and durable referenced assets for transfer/restart.

Do not delete an old asset when replacing, clearing or Baking a LUT: another entry, history state or document may retain it. Failure cleanup should unlink only newly created assets owned by the failed publication. Add real save failure and late transaction failure tests with a pre-existing shared LUT as well as a newly written one.

## Release gate for the next design

Freeze strict parser/descriptor/API, explicit input interpretation, numeric policy and measured work/prepare limits before production. Require independent identity/asymmetric channel-order/half/boundary fixtures; real source/global alpha and blend/deferred-mask/Bake/Distort checks; protected/generated/group/clipping contexts; disabled activation and metadata admission before reads; canonical malformed portable manifests with valid controls; original asset byte preservation through Undo/restart/transfer; recipe refusal without silently dropping a step; and atomic import/replacement rollback. A compact file/size/input-policy/opacity UI with guarded explicit Apply and accessible unavailable-state inspection completes this slice.

No external preset service, broad OpenColorIO dependency, full color-management pipeline or asset-backed selection migration is needed. If implementation code is copied from a reference, its license obligations remain; prefer an independent small parser/sampler using primary format documentation. The channel/RLE evidence should remain as a concrete requirement for a future mask-storage design.
