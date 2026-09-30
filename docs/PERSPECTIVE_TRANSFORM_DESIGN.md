# Editable four-corner Distort

Status: backend implemented and independently accepted, 2026-09-19. Owner tests8/8, independent audit10/10 and the combined adjacent regression175/175 pass under ordinary Node. Root owns the complete regression and UI acceptance. This slice adds an editable fixed-frame projective stage and preserves every existing affine/resize algorithm.

Adobe describes Distort as independent corner/edge movement and Perspective as symmetric opposite-corner movement. This feature is named **Distort** and defines its own native mapping and bilinear sampling; it does not claim Photoshop algorithm equivalence. [Adobe transformation options](https://helpx.adobe.com/photoshop/desktop/crop-resize-transform/transform-manipulate-reshape/transformation-options-in-adobe-photoshop.html)

## Frames, records and commands

Persist a strict record `{type:'distort',width,height,corners:[TL,TR,BR,BL]}`. Each corner is exactly `{x,y}`. Width and height equal the immediately preceding retained geometry frame. Corners are the destination images of the source's outer pixel edges `(0,0),(W,0),(W,H),(0,H)`. The output retains that same width and height. Outside output pixels are clipped at each stage. Editing or removing a stage replays the retained source; appending an inverse stage cannot recover samples clipped earlier.

Three native-only commands require a positive `expectedRevision`: `add_layer_distort` takes document/layer IDs and four corners; `update_layer_distort` additionally takes `transformIndex` and replaces all corners; `delete_layer_distort` takes the same index without corners. The index addresses the complete transforms array and must identify a Distort record. A containing transaction requires its positive outer revision and follows the existing revision-injection/step-stripping convention. Arguments are validated and copied at call time before queued execution.

Add appends in the current final canvas frame. Update/delete can target any Distort, including a middle stage: its fixed input/output dimensions preserve every later frame. Corners for a historical stage belong to that historical frame. The UI can edit every stage numerically; handles may be shown only where the displayed frame makes them truthful. There is no automatic append, rasterization, conversion from affine, or write on drag.

Raster, solid, text, shape, path and gradient content are supported; groups and adjustments reject. A protected target rejects all three mutations, including identity. A graph distorted first and protected later remains valid and preserves current appearance. Existing proportional affine protection behavior is unchanged. Commands are metadata-only, create no assets, use one revision/Undo, and preserve layer ID, masks, source/cutout files, provenance, group/clipping links, styles and selection. Candidate graphs validate before assignment. Transactions validate each staged mutation when either prior or resulting graph contains Distort, preventing an intermediate over-budget graph from reaching pixel I/O or being concealed by later deletion.

Capability contract:

- `layerDistortPolicy: 'fixed-frame-projective-bilinear-v1'`
- `layerDistortCoordinates: 'stage-pixel-edges'`
- `layerDistortContentTypes: ['raster','solid','text','shape','path','gradient']`
- limits `maxDistortCorner:16384`, `maxDistortWork:384000000`, `maxDistortWorkingBytes:268435456`.

The existing 500 geometry records per layer, 8192 per axis and 24-million-pixel frame limits still apply. Missing/unknown policy does not authorize authoring. All corner/record keys, prototypes and array entries are checked; reject holes, accessors, symbols, unknown fields, null, nonfinite coordinates and mismatched frames. Canonical authored negative zero becomes zero. Validation does not rewrite imported valid records or legacy descriptors. Old readers reject the unknown transform type before asset reads; native/portable persistence retains it. No recipe geometry extension is included.

## Numerical admission

Coordinates are finite binary64 numbers within ±16384. An exact integer translation is recognized when the corners equal `(dx,dy)+(0,0),(W,0),(W,H),(0,H)` with integer dx/dy. That branch copies clipped RGBA rows exactly, including invisible RGB and alpha 1. It includes identity.

For other quads, normalize coordinates around the bounding-box center using its longest span. Require span at least 0.25 pixel, four positive screen-clockwise consecutive cross products at least `2^-20`, and the infinity-norm condition estimate `norm(H)*norm(inverse(H)) <= 1e6`. This rejects mirrored, crossed, concave, collapsed and poorly conditioned quads without silently moving their corners. Existing affine flips remain available.

The homography maps the unit square to the normalized ordered quad. Its last row is `(g,h,1)`, found by the ordinary closed-form square-to-quadrilateral solve; invert with the explicit adjugate/determinant. All coefficients and determinant-derived values must be finite. Require a positive forward denominator over the expanded support rectangle `[-.5/W,1+.5/W] × [-.5/H,1+.5/H]`, with largest/smallest corner denominator at most 64. The affine denominator reaches its extrema at these corners. This expanded region corresponds exactly to the half-pixel bilinear fringe, preventing a projective pole inside sample support.

These are native binary64 admission predicates, not exact-real geometry promises. Matrices are derived, never persisted. Direct coefficient evaluation at each destination pixel prevents accumulated scanline coordinate drift.

## Sampling and alpha

Evaluate destination center `(x+.5,y+.5)`, normalize by the quad center/span, apply the inverse homography, then compute source indices `sx=u*W-.5`, `sy=v*H-.5`. Nonpositive/nonfinite inverse denominators and nonfinite/outside-support coordinates return transparent black. Support is `-1<sx<W`, `-1<sy<H`. There is no hard quad clip; bilinear samples can contribute through its half-pixel fringe. Outside source neighbors contribute zero, never a clamped border.

Visit the four neighbors in fixed y-then-x order. For each, calculate `w=wx*wy*alphaByte`; accumulate A and `w*R/G/B` in binary64. If A is positive, write clamped `Math.round(R/A)` etc and `Math.round(A)`. If A is zero, write transparent black. A positive A that rounds to alpha zero still retains its computed RGB. Input alpha-zero colors contribute nothing. This explicit operation order can differ by one byte from exact-real arithmetic at a half tie; it also differs from legacy affine's normalized-alpha arithmetic. The old affine implementation is untouched.

Geometry changes coverage. It does not promise unchanged alpha or invisible RGB except in the exact copy branch. No extra full coordinate/premultiplication plane is allocated: the helper retains input and one RGBA output. General loops yield after at most 16,384 destination pixels; copy loops after at most 65,536 copied row-width pixels. Allocation/codec latency is not a scheduling guarantee. Bilinear-only minification can alias; area prefiltering, selectable warp kernels, mesh/liquify and automatic canvas expansion are outside this slice.

## Pipeline and consumer semantics

Ordering remains working source → separate cutout alpha → complete editable source filter stack and its shared source mask → retained geometry → contextual protected RGB restoration → existing compositing/masks/styles. Distort is one geometry stage. Additional layer/group/adjustment masks remain in document coordinates; their independent positions/domains are unchanged. Selections, saved selections and guides are unchanged by an individual layer's geometry.

Source filter-mask capture rejects any Distort, including exact-copy records, in this first slice; direct source-space masks and source previews remain available. No approximate inverse selection capture is introduced. Cutout refinement/source placement/paint guards keep their established behavior. Bake fixes source RGB and retains every geometry record. Existing paint/rasterize operations can materialize geometry under their own explicit contracts.

Content previews, clipping/generated protection, layer transparency selection, arranging bounds, retouch sampling, flattened exports and PSD pixels must all use the same new geometry branch. PSD retains its geometry-rasterized warning and native files stay editable. PSD preparation must reserve its retained mask planes in addition to the new graph peak. Filter stacks still require the existing explicit Bake/Clear before compatible PSD export.

## Work and named buffers

Every retained Distort charges `16*width*height`, including hidden layers and exact-copy/identity records. Sum over the graph and reject above 384 million. This separately named budget bounds authored new-stage work; it is not a bound on all legacy geometry, renderer passes or codec work. Constant charge makes edits between general and exact-copy quads stable. Old 500-record bounds also apply.

**Whenever any Distort exists, one stronger graph-level named-buffer envelope applies to all content leaves. Legacy-only graph admission is unchanged.** Use safe-integer arithmetic and validate before any image read/allocation:

`6*N + Rmax + C + T + max(Dleaf) <= 256 MiB`.

N is final canvas area. `6*N` reserves root RGBA, root protection and a contextual protection footprint. `Rmax` is the global maximum retained ancestor surface path: five bytes per canvas pixel for each isolated/masked/translucent group, plus the existing five-byte clipping-chain reserve. It is global because inspecting one branch can render a protected sibling from another branch. Empty groups are included.

C is `2*sum(bitmap source areas)+max(4*feathered source area)` across all effective additional layer/group/adjustment masks, including ordinary and positioned descriptors and hidden nodes. Density zero skips callback storage but never metadata validation. Two sets cover render ancestors and original-context protection; one synchronous feather construction transient is live at a time. Source filter-mask callbacks are separate deferred leaf phases below.

T is the existing shared 4096-byte Gaussian-noise table reserve, once after the graph peak if any active computing Gaussian-noise entry exists anywhere. It is not added once per leaf. Spatial rings remain sequential caches and do not coexist with later source-mask or geometry phases.

For each content leaf, S is retained source area, F is whether its stack has active entries, R is the maximum sequential spatial cache, and P is the procedural input reserve (gradient `4*S`, text/shape/path 1 MiB, raster/solid zero). Compute D as P plus the maximum of:

| Phase | Named bytes excluding P |
|---|---:|
| Source decode/alpha combination | `alphaAsset ? 9*S : 4*S` |
| Active source candidate | `12*S+R` |
| Evaluating shared source mask | `8*S+coverageBytes+LUTBytes` |
| First geometry stage | `(F ? 8 : 4)*S+4*next` |
| Later geometry stage | `(F ? 8 : 4)*S+4*previous+4*next` |
| Active original-context restoration, first stage | `8*S+4*N+4*next` |
| Active original-context restoration, later stage | `8*S+4*N+4*previous+4*next` |

The first previous frame aliases the source argument; later previous frames are distinct. Native retains original and, when active, filtered source, while geometry retains its input argument. Restoration conservatively retains the already filtered final RGBA while replaying original geometry, even if the current graph has no positive protected footprint. Source mask coverage/LUT are evaluated only when the active stack, enabled flag and density require them. Original/candidate/mask phases are maxima, not sums. No extra contextual N is added inside D. Every legacy content leaf is included because original-context rendering can enter a protected legacy sibling while a Distort branch is inspected.

This named envelope includes decoded content, filter candidates/known caches, retained geometry frames and the listed concurrent renderer surfaces. It excludes encoded input bytes, native codec allocations, global adjustment/style internals, allocator retention and total RSS. It must not be advertised as a complete process-memory bound. Existing selection/Bake/PSD actual-size and phase ledgers remain independent operation checks and are not relaxed.

Illustrative flat raster bounds, without callbacks/caches: one unfiltered same-size stage costs 14N (8000×2396 fits, 8000×2397 refuses); an active filtered same-size stage conservatively costs 22N (8000×1525 fits, 8000×1526 refuses). Two unfiltered same-size stages cost 18N. Thus the work cap permits one 24 MP general stage in isolation, but the graph memory gate can reject it. A 24 MP retained source cropped to 512² then distorted costs 99,670,016 named bytes before masks/groups, demonstrating that crop never erases source memory from admission.

PSD preparation for a graph with Distort adds retained output mask planes to the complete graph envelope during composite rendering; also check mask-construction and retained-layer-collection phases against its existing writer/output limit. Layer-selection loading continues to charge original/previous/next frames and actual encoded source sizes, using the fixed dimensions of the new record. No unknown transform may fall through to the legacy resize branch.

## Implementation seams and acceptance

`server/distort.mjs` owns strict records, matrix compilation, constants and sampling. `server/distort-resources.mjs` owns pure leaf/graph estimates and new work checks, importing the existing filter/mask/group helpers. Native validates the stronger gate after legacy graph checks, implements three metadata commands and explicit render dispatch, and widens the existing retained-mask transaction validation trigger to include Distort. The mask callback estimator gains an explicit force option for the new envelope; legacy calls retain their old behavior. PSD preparation uses the same graph estimator rather than duplicating phases. Shared schemas/status/MCP and client controls are separately owned.

Acceptance must cover all six content types; exact integer copy and clipping; finite fringe/soft-alpha/hidden-color behavior; source filter and stack-mask ordering; arbitrary middle update/remove with later crop/resize/affine; protection/clipping/generated behavior; selection/retouch/export/Bake; unknown/malformed metadata before reads; 500-stage, work and every concurrent-memory boundary; cross-branch protected legacy sources; hidden nodes, disabled filters and density-zero masks; call-time queued argument copying; actual disk failure and late transaction rollback; portable/restart/Undo; legacy-only pixel/admission regression. Production timings must rerun the prototype workloads before release.

## Prototype evidence

Owner artifacts are `test-results/perspective-evaluation/{prototype.mjs,probe.mjs,report.json,worst-benchmark.mjs,worst-benchmark.json,photo-distort.png}`. Apple M5 Max, macOS arm64, Node v22.14.0: three-run medians for fully covered projective sampling were 28.10 ms at 1024², 28.93 ms at 8192×128, 37.68 ms at 128×8192 and 725.35 ms at 24 MP. Fractional translations were 22.57/21.88/22.40/483.60 ms. Largest observed five-millisecond timer gap was 8.69 ms. These measure helper behavior, not a latency promise or admission exception.

The independent exact-rational oracle tested 306 images: 305 matched exactly, and one alpha half-tie produced native127 versus exact128; maximum source-coordinate difference was 8.81e-13. All 304 hidden-color perturbation cases and eight invalid/pole cases passed. This evidence supports the explicitly binary64 contract rather than an exact-real claim. See [independent review](PERSPECTIVE_TRANSFORM_REVIEW.md).

The inspected asymmetric photo maps the maintained 512² astronaut fixture to `(70,40),(470,100),(420,470),(100,390)`. Source `test-results/segmentation-public-fixture.png` SHA-256 is `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`. No new provider, asset download or dependency is needed.

## Production acceptance evidence

The callable implementation uses `server/distort.mjs` and `server/distort-resources.mjs`; no matrix or coordinate map is persisted. `tests/distort.test.mjs` passes8/8 and the independent `tests/distort-audit.test.mjs` passes10/10. The combined175-test sweep covers those plus resampling, canvas, additional/source masks, selection, PSD, groups, clipping and the fresh-process scalar-tone regression (`test-results/distort-adjacent.log`). Root separately reports four schema tests and two actual MCP SDK workflows passing. No production discrepancy was found; the initial owner-test failures were missing required transaction labels in fixtures.

Actual production helper measurements are in `test-results/perspective-evaluation/production-benchmark.{mjs,json}` using ordinary Node v22.14.0 on Apple M5 Max/macOS arm64. Three-run projective medians were29.59ms at1024²,32.06ms at8192×128,40.16ms at128×8192 and754.86ms at24MP. Fractional translations were22.04/23.01/23.98/501.33ms. The largest observed five-millisecond timer gap was8.25ms. The24MP run exercises standalone sampler scheduling; it does not bypass or expand the stricter graph memory admission.

The production photo `test-results/perspective-evaluation/photo-production.png` is byte-identical after RGBA decoding to the inspected prototype image, SHA-256 `5fb4dee187ccafa160ce5ceb7f7c2c1c6ba5dc355fb7b5eac939774f3c0921af`. No photo/provider/dependency changes were needed.
