# Dense alpha8 masks: smallest complete storage and preparation slice

Status: **read-only architecture recommendation**, 2026-09-19. No runtime, fixture, benchmark, limit, command or capability changed. Photo Filter implementation takes priority when released. This note follows [DENSE_MASK_SEAMS.md](DENSE_MASK_SEAMS.md) and the actual photographic RLE failures in [CHANNEL_WORKFLOW_EVALUATION.md](CHANNEL_WORKFLOW_EVALUATION.md).

## Recommendation

Use a new strictly tagged mask shape backed by a **framed raw alpha8 immutable asset**, with explicit asynchronous preparation at each consuming operation. Keep existing geometric and RLE descriptors and their arithmetic unchanged. Do not add an optional asset field to `shape:'bitmap'`: an old reader could ignore it or interpret missing runs incorrectly. An unknown new shape provides an ordinary fail-closed boundary.

The first complete user workflow is exact continuous composite-channel selection, saving/loading/combining that selection, using it as an adjustment mask or paint boundary, inspecting it, changing canvas bounds, and retaining it through Undo/restart/portable transfer. Supporting only a new selection loader is incomplete: `add_adjustment` and `import_color_lookup` copy the active selection into a layer mask, and existing mask editing commands can move that same descriptor into other lifetime contexts. Storage support therefore needs the shared mask consumers below before the producer is advertised.

The feature can stay bounded without implementing a generic asset browser, PNG upload, editable RGB channels, channel calculations, vector paths, a new morphology algorithm or a decoded-mask cache. The first producer takes pixels already available from the native composite. Existing byte-plane producers can use a deterministic lossless storage fallback when their exact RLE would exceed the existing ceiling. No thresholding, resampling, run-limit increase or metadata-budget increase is implied.

## Raw versus lossless encoded storage

| Choice | Advantages | Required costs and risks |
|---|---|---|
| Header plus raw alpha8 | Exact fixed length; bounded byte read and SHA; header verifies frame; no image decoder or color metadata; read payload itself can become owned coverage | Stores one byte per pixel even for compressible photographs; retained-history and bundle byte limits become visible sooner |
| Strict lossless grayscale PNG | Often smaller persisted blobs for smooth masks | Must constrain bit depth/channel count/palette/transparency/animation/chunks; bounded decode and dimensions; encoded E plus decoded N coexist; native codec allocations remain outside a pure JS ledger; noise can still approach or exceed raw size |
| Deflated private alpha format | Small implementation surface compared with PNG; no color interpretation | Still requires bounded decompression/output verification and encoded+decoded phases; adds format/version and decompression failure surface without eliminating worst-case N bytes |

Choose framed raw for the first slice. At512² it is262144 payload bytes; a1024² mask is1048576 bytes. These are routine immutable blobs and avoid the600000-number metadata expansion that fails on normal channel coverage. Compression is a later storage optimization, not necessary for exact512²/1MP usability. It should be a distinct declared encoding with its own decoder and ledger, not an unadvertised change behind a raw policy.

A small fixed header should include magic, format version, width, height and payload length, followed by row-major bytes. A24- or32-byte header is enough; byte layout and endianness must be frozen in the later implementation design. Require exact `headerBytes+width*height` length, existing8192-axis/24MP dimension bounds, matching descriptor/header dimensions and SHA-256 of the complete framed blob. Framing prevents the same flat byte sequence from being silently reinterpreted as incompatible2×3 and3×2 assets. Raw bytes have no ICC, transfer function, premultiplication or grayscale color-space conversion: they are coverage alpha8.

A proposed descriptor is `{shape:'alpha8',asset,width,height,bytes,feather,invert}` with strict own data fields and no paths/URLs. `bytes` includes the fixed header. Density stays where it belongs today: `layer.maskDensity` or the source-filter-mask wrapper, never inside raw coverage. A positioned additional mask retains its existing source frame/translation/domain wrapper around the new descriptor. A source filter mask requires its exact working-source frame; active/saved selections and ordinary additional masks require the current canvas frame. Older readers reject the unknown shape.

## Preparation and ownership, not a graph cache

Split three concerns: metadata-only normalization; verified asynchronous reading/preparation; synchronous sampling over prepared owned bytes. Do not make `maskCoverage` silently read a file or return a promise sometimes. Introduce an explicit async preparation seam used by native operations, while old purely synchronous helpers remain usable for legacy data. An unsupported direct call with the new shape must reject clearly rather than treating it as a rectangle.

The resolver receives a normalized immutable descriptor, opens only its hash through the existing bounded same-file read/SHA path, verifies the header and returns one privately owned buffer. Its payload view may be sampled directly; without feather there is no need to allocate a second N-byte plane. For feather, the private payload can be modified after verification because no caller or cache shares that read buffer. Preserve the exact existing inward chamfer order and Float32 distance values through the yielding implementation already present in `filter-mask.mjs`. The disk blob remains unchanged. If any implementation instead shares read buffers, it must copy before feathering and add that extra N explicitly.

Only the prepared callback and its alpha buffer escape the helper; no graph object, public descriptor or global map receives decoded bytes. Frame transforms and density remain wrappers over that callback. Prepare callbacks serially. `Promise.all` over masks would make multiple distance constructors live simultaneously and invalidate the existing one-constructor maximum. There is no mandatory per-operation dedupe: repeated references may be read again in separate phases; their work is counted as repeated occurrences. A future dedupe must charge every retained decoded plane, not only the maximum.

The current renderer can retain a group's mask callback while recursively rendering its children, retain a clipping base callback across member awaits, and start original-context protection while outer callbacks remain live. Therefore releasing every callback immediately after construction is not an available optimization. Extend the existing conservative two-callback-set estimate to include new raw assets, and use the joint group/clipping/root/resource envelope for graphs opting into dense masks. This remains a named-buffer bound, not a process-RSS or all-legacy-codec guarantee.

## Concrete consumers and required adaptations

| Current code | Complete first-slice change |
|---|---|
| `masks.mjs` normalization/coverage | Metadata-only new-shape validation; prepared-byte sampling with existing feather-then-invert order; clear failure from unprepared synchronous new-shape use |
| `layer-mask.mjs` raw/effective/positioned coverage | Async raw preparation, then existing translation/domain and density wrappers; exact retained source dimensions; include raw asset bytes in storage/callback estimates |
| `native.mjs` rendering/protection | Await mask preparation at content, group, clipping and adjustment scopes; make `ancestorContext` asynchronous because it constructs ancestor callbacks; preserve sequential context lifetimes and protected original rendering |
| `filter-mask.mjs` | Add raw source preparation to the existing awaited mask phase after candidate stack evaluation; include payload/header and distance bytes; maintain alpha8 density LUT and exact finished-stack RGB mix; dense selection capture uses the existing exact geometry predicate |
| `saved-selections.mjs` | Save/replace can share descriptors without I/O; Add/Subtract/Intersect need awaited preparation and exact existing floating byte algebra; explicit empty selection remains a real descriptor rather than null |
| `layer-selection.mjs` | Replace RLE-only final encoder with a storage decision for exact bytes; prepare active and loaded mask inputs asynchronously; preserve its render/materialize versus combination scopes and no source-filter evaluation for transparency loading |
| `raster-ops.mjs` and native paint/fill/mask calls | Kernels accept prepared coverage or byte planes; native prepares before write loops. `paintSelection` must expose byte output instead of forcing immediate RLE. Clone/Heal keeps its frozen per-stroke source and existing protection order |
| `mask-morphology.mjs` / `morphology-commands.mjs` | Core already takes alpha bytes; caller prepares/bakes feather/invert/domain once, calls unchanged morphology, then publishes exact output via adaptive storage. Keep density outside the operation |
| `canvas.mjs`, crop and resize in native | Async transformation when a new descriptor is involved; process active selection, saved selections and layer masks sequentially into staged assets. Preserve bitmap crop feather baking, nearest resize policy and inverted-padding semantics |
| `mask-preview.mjs` | Permit a bounded read of the selected alpha asset only; continue forbidding RGB/source image reads. Existing raw/effective and nearest-pixel-center bytes stay unchanged. Update help/test language from “no asset reader” to “only the selected alpha asset” |
| `psd-native.mjs:exactMask` | Await coverage, keep exact byte-representability checks after layer density, include current preparation plus already retained PSD mask planes. Storage support does not make all fractional density semantics representable |
| Native imports/segmentation/color selection | Existing alpha outputs may choose raw fallback; no algorithm change. Public new descriptors cannot reference unverified external paths or arbitrary file imports |
| Recipes/style capture | Existing recipes intentionally omit masks; masked-stack capture still refuses. Ordinary adjustment recipes do not gain hidden mask dependencies. Keep capability/portable execution rules explicit |

The source filter-mask slot is comparatively cheap to support because preparation is already asynchronous. Deferring it while allowing dense active selections would make the existing “capture selection as filter mask” command unexpectedly unusable. Supporting it in the first storage slice is preferable to inventing a conversion through oversized RLE. Likewise, a dense selection must survive both brush use and selection painting; supporting only one direction is not complete.

## Phase and lifetime map

Use `H` for the fixed header, `N` for the descriptor's source pixel count, `Q` for output canvas pixels, `P` for preview pixels, and `B=N+H` for verified raw bytes. Each allowance below must be joined with the operation's existing live RGB, root, group, clipping, protection and source-candidate buffers before admission. Independently passing256MiB checks are insufficient.

| Phase | New raw storage and lifetime |
|---|---|
| Metadata validation / history planning | No payload read or allocation; validate descriptor/frame/type/quotas |
| One coverage preparation, no feather | B; verified read buffer is the sampled plane |
| One feathered coverage preparation | B+4N distance; distance dies in a separate awaited helper, B remains in callback |
| Retained rendering callbacks | Conservative `2*sum(B for evaluated callback sources)+max(4N for feather construction)`; density-zero bypass can skip reading, but metadata/persistence validation still applies |
| Source filter mask | Its existing deferred phase becomes `8S + preparedCoverage + densityLUT`, maximum with candidate/filter cache; it must not overlap the spatial ring |
| Selection combination | Prepared left/right source coverage plus Q output. Use sequential preparation, then combine. Constructor maxima include the already retained other side; do not add two distance planes when preparation is serial |
| Channel extraction | Native render phase first; then rendered4Q plus extractedQ. Return only Q from a separate materializer before combining/publishing, so the rendered RGBA cannot survive accidentally |
| Adaptive output publication | OutputQ plus framed publication bufferQ+H if concatenated; avoid an extra copy only with a documented bounded write interface. No successful asset is attached before candidate graph/history gates pass |
| Mask painting | Existing4Q initial RGBA, stroke output/sampling scratch and prepared starting coverage coexist; this path needs an explicit new-graph preflight, not just the mask callback cap |
| Morphology | Input materializationQ plus the existing threeQ kernel planes and max-axis deque; release coverage before invoking the kernel through a separate helper where possible; publication is a later phase |
| Canvas crop/resize/pad | One prepared source plus one new output and publication frame; process each saved/layer mask serially and retain only descriptors between masks |
| Grayscale inspection | Prepared chosen coverage plus sampledP, existing encoder/transfer reserves; do not read unrelated alpha or RGB assets |
| PSD export | Prepared current mask plus all previously collected retainedQ masks and existing collectedRGBA/codec phases |
| Restart / bundle import | Verify unique raw blobs serially after metadata/aggregate admission; do not keep decoded callbacks or invoke a raster decoder |

The raw read does not add a second N to a callback that already owns its B buffer. Conversely, returning a payload view does retain the entire B backing, so the header cannot be hand-waved away in exact boundaries. Source dimensions can exceed the canvas for positioned masks; use N rather than Q in those rows. Raw and effective previews differ by density/bypass but both share the same storage metadata validation.

No numeric new CPU or history limit is frozen by this read-only note. A full implementation design must count repeated active mask occurrences, feather passes, combination/paint/morph passes and visited rows before reads, then set a bounded preparation/work rule with weighted yields. Existing polygon capture limits remain relevant; new storage does not make expensive polygon sampling free. Validate each intermediate transaction state, not just a final graph that deletes an over-budget mask.

## Persistence, quotas and atomicity

Extend the actual common typed walker currently in `lookup-assets.mjs`; renaming it to a broader asset module is optional, but creating another incomplete walker is not. Enumerate active and saved selections, every direct/positioned layer-mask source, and every source-filter-mask coverage record, including hidden, disabled, zero-density and history-only uses. Reject crosskind image/PSD/LUT/alpha aliases and inconsistent frame/header metadata. Compatible references share one immutable blob. Current bundle193-asset/256MiB and16MiB manifest limits remain unchanged.

Retained-history admission must apply to the prospective100-state history after redo truncation before publication, and identically on restart. Do not copy the LUT64MiB limit blindly: one raw24MP plane is24MB, while100 distinct1MP masks are about100MiB. A separately named alpha-asset byte/count quota should admit the intended512²/1MP editing history and disclose larger-image limits; its exact numbers require an explicit later product/resource decision. Saving the same selection16 times should count one shared blob, not16 copies. Replacing it creates another immutable asset for Undo.

Crucially, a retained-history quota is **not a total disk quota**. The current store does not garbage-collect every asset after a history state falls out; successful old blobs may remain on disk. Raw-mask support must disclose that existing ownership policy or separately design global-reference-aware garbage collection across projects/history/in-flight jobs. A nominal history cap must not be marketed as a bounded disk guarantee. Lossless compression improves common storage but does not resolve this lifecycle question for high-frequency masks.

Use the existing operation-local created-asset scope for every producer and transaction. Stage candidate descriptors/history/resource validation before publishing; if a later mask transform, pixel write or persist fails, delete only newly created owned files. Deduped existing files, other projects and retained Undo states remain intact. Every operation that can publish dense output, including an old command that newly falls back to raw storage, must enter this scope. Publication rollback cannot be attached only to the new channel command.

## Representation choice and completeness boundary

Preserve old RLE results exactly when they fit. A count-only pass can determine whether the exact nonzero run count exceeds200000 before allocating a huge run array; if it fits, use the existing canonical encoder, otherwise frame the exact alpha bytes. Empty results remain explicit empty RLE selections. The new channel producer may choose raw deterministically from the same rule; no image detail changes. Do not normalize legacy stored RLE into assets merely on read.

This is an infrastructure change across several existing commands, although the storage arithmetic itself is simple. The smallest complete slice is the shared raw representation plus all current mask sampling/publication paths needed by the routine channel workflow. A narrower “selection metadata only” implementation would either fail on ordinary adjustment/paint use or require an unsafe hidden decoded cache. Optional future file import, PNG compression, channel painting and general alpha-channel interchange can remain outside the first slice.

Before registration, the full design should freeze header/descriptor/capabilities, exact channel alpha/inversion semantics, retained-history and preparation quotas, and operation-specific joint preflights. Acceptance must include the measured original512² and1MP continuous cases, byte equality through saved combinations/adjustment/paint/crop/pad/filter capture, mixed RLE/raw descriptors, feathered/inverted domains, position sources larger than canvas, protected/generated clipping, inactive malformed metadata, PSD representability, startup/bundle transfer and real late publication rollback. This note deliberately stops at that concrete recommendation and phase map; it adds no runtime or evidence fixtures.
