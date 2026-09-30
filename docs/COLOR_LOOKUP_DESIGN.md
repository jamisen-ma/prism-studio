# Native Color Lookup: original .cube assets and bounded trilinear evaluation

Status: **closed;1109 backend tests and91 browser workflows plus build passed**, 2026-09-19. This completes the next-feature recommendation in [CHANNEL_WORKFLOW_EVALUATION.md](CHANNEL_WORKFLOW_EVALUATION.md). The native kind, atomic command, typed asset validation and capabilities now follow this contract. Independent review is [COLOR_LOOKUP_REVIEW.md](COLOR_LOOKUP_REVIEW.md); transport ownership is [COLOR_LOOKUP_MCP_DESIGN.md](COLOR_LOOKUP_MCP_DESIGN.md).

## Useful first scope and primary references

Add one native `color_lookup` kind to global adjustments and source filters: import a bounded 3D `.cube` file and attach it atomically, or replace an existing lookup file while preserving its surrounding settings. The file itself is the sole immutable asset; `.prism` carries it, Undo and restart retain it, and Bake writes the evaluated RGB to the existing working raster. There is no mandatory library, new dependency, generated preset inventory, persistent compiled-table cache, 1D shaper, tetrahedral option, automatic color-space inference or asset-backed recipe package in this slice.

Adobe demonstrates a Color Lookup adjustment as a reusable photographic look, and exports adjustment results as lookup files. These establish workflow value, not a byte algorithm. [Adobe Color Lookup workflow](https://www.adobe.com/learn/photoshop/web/edit-photo-color-lookup-adjustment), [Adobe LUT export](https://helpx.adobe.com/photoshop/using/export-color-lookup-tables.html). OpenColorIO's primary Iridas Cube reader documents optional input domains and red-fastest 3D data. We independently implement a narrower grammar and the arithmetic below; no source implementation is copied. [OpenColorIO Iridas Cube reader](https://github.com/AcademySoftwareFoundation/OpenColorIO/blob/main/src/OpenColorIO/fileformats/FileFormatIridasCube.cpp).

Both LUT input and output are explicitly interpreted as **encoded sRGB components in [0,1]**, applied to native RGB8. No linear-light, log, wide-gamut or HDR conversion occurs. A log-intended cube may still contain only [0,1] samples and an identity domain; syntax cannot detect intent. Users must choose the encoded-sRGB interpretation explicitly. Do not label such files as automatically identified or safely converted.

## Frozen contract: policy, limits and descriptor

The new kind has `value:0`, complete descriptor parameters, no scalar strength inside the descriptor, and uses the existing source-entry/global-layer opacity. Native counts become 27 global and 31 source kinds. Existing kinds and their algorithms remain unchanged; old readers reject the unknown kind before reading assets.

Root owns `shared/color-lookup.mjs` and its declaration file, exporting `COLOR_LOOKUP_POLICY`, `COLOR_LOOKUP_FORMATS`, `COLOR_LOOKUP_INPUT_SPACES`, `COLOR_LOOKUP_LIMITS`, `normalizeColorLookupParameters(value)`, `mergeColorLookupParameters(previous, patch)` and `colorLookupBase64Bytes(data)`. The native server owns parsing, evaluation, resources and typed asset use.

```js
COLOR_LOOKUP_POLICY = 'cube3d-f64-trilinear-srgb-v1'
COLOR_LOOKUP_FORMATS = ['cube-3d']
COLOR_LOOKUP_INPUT_SPACES = ['srgb']
COLOR_LOOKUP_LIMITS = {
  maxBytes: 4194304,
  minGridSize: 2,
  maxGridSize: 33,
  maxLineLength: 4096,
  maxNumberLength: 64,
  maxTitleLength: 200,
  maxSourceNameLength: 200,
  maxPrepareBytes: 33554432,
  maxHistoryAssets: 128,
  maxHistoryBytes: 67108864,
  maxTransactionBytes: 4194304,
  maxWorkingBytes: 268435456
}
```

Native advertises `colorLookupPolicy`, `colorLookupFormats`, `colorLookupInputSpaces` and `colorLookupLimits` using those values. Source authoring additionally requires source coordinates, the kind and relevant source command; global authoring requires its adjustment kind/command. The optional Photoshop bridge refuses this native descriptor/import contract. UI does not infer support from a generic adjustment enum alone.

Canonical parameters are exactly:

```js
{
  asset: '<lowercase SHA-256 of original file bytes>',
  bytes: 1 /* through maxBytes */,
  gridSize: 2 /* through 33 */,
  inputSpace: 'srgb',
  sourceName: 'warm-look.cube',
  title: 'Optional exact TITLE header'
}
```

`sourceName` is display provenance, a well-formed nonempty string of at most 200 UTF-16 code units, without U+0000–001F, U+007F, slash or backslash. Require `sourceName.trim().length>0`, but preserve the submitted characters; it is never a path. A single `.` or `..` is rejected. There is no suffix-based content trust. `title` is absent if the file has no TITLE; otherwise it is the exact parsed string, including a permitted empty string, at most 200 UTF-16 units, well formed, without controls, quote or backslash. Optional authored `title:undefined` normalizes to omission; null does not. Same hash may have different source names, but byte length/grid/interpretation/title must agree across every typed use.

The normalizer accepts only plain or null-prototype records with own enumerable data properties and the exact key set. It rejects accessors, symbols, hidden fields, custom prototypes and unknown keys before reading their values. It returns a fresh record. Missing/default lookup parameters are invalid: there is no implicit identity asset. Updates retain parameters when absent or `{}`; any nonempty parameter patch requires a **complete replacement descriptor**. Never shallow-merge a new hash with an old size/title. Changing only opacity/blend/visibility is still supported by ordinary commands.

## Atomic add, replace and reuse

`import_color_lookup` is a native mutation with positive `expectedRevision`, `documentId`, canonical base64 `data`, `sourceName`, required `inputSpace:'srgb'`, and one target form:

| Target | Required identifiers | Optional identifier | Effect |
|---|---|---|---|
|`adjustment`|none|`layerId`|Absent: add lookup adjustment. Present: replace file of that existing lookup adjustment.|
|`layer-filter`|`layerId`|`filterId`|Absent filterId: append lookup filter. Present: replace file of that existing lookup entry.|

Reject irrelevant IDs and non-lookup replacement targets. New global adjustment inherits the active selection mask exactly as `add_adjustment`; new source entry ignores selection, uses Normal, opacity 1 and enabled true. A new layer name derives from sourceName through the established bounded layer-name path. Replacement preserves ID, layer name, order, visibility/enabled, opacity, blend, all masks, source geometry and every other entry. A disappeared replacement target never turns into an append. Return `{document, layerId, filterId?}` with the stable resulting IDs.

Validation/snapshot happens at call time before the native queue, including import operations and descriptor-bearing add/update calls inside transactions. Scalar descriptor fields and immutable JS base64 strings are copied through the strict command schema. Native additionally validates canonical alphabet, padding placement and zero pad bits, and obtains exact decoded length before allocation; at most `4*ceil(4194304/3)=5592408` base64 characters is necessary but not sufficient. The existing 42 MiB HTTP limit is unchanged. Read files only in the explicit MCP file wrapper, never from a descriptor.

Inside the queue, first check revision and target/protection, then decoded-size aggregate, syntax/descriptor and candidate graph/history resource admission. Publish original bytes only after these checks. Use the current content-addressed private write/link path and owned-created-assets scope, followed by one project commit and one Undo step. Dedupe identical bytes; verify an existing destination before reuse. Save failure or a later transaction failure removes only newly created files from this operation, never an existing shared blob. Errors must not echo LUT contents or unrelated paths.

Transactions support the import command with positive enclosing revision and a **4 MiB sum of decoded import bytes across the entire submitted transaction**, checked before any decode/write. Reusing an existing descriptor does not consume upload bytes. Every staged mutation while the prior or resulting graph contains a lookup validates the graph immediately, so an over-budget activation cannot be hidden by a later deletion before a pixel operation. Prospective history validation must run before any publication, including Bake's early commit preflight. File replacements preserve unrelated settings even within the transaction.

Ordinary add/update commands can reuse a complete descriptor: verify its bounded existing asset, exact bytes/digest/grid/title before publishing a newly attached or changed descriptor. They may read LUT text but never need source image pixels for this check. Unchanged metadata-only opacity/blend changes need no LUT read; render still verifies every active table before evaluation. Missing/corrupt files never fall back to identity. Metadata graph validation itself remains synchronous and I/O-free.

There is no new durable native receipt. Existing companion request deduplication remains session-scoped. An ambiguous response leaves the client draft owned by its captured target; refresh and inspect current graph/revision before offering further work. Do not automatically retry an uncertain upload or claim that a lost response means failure. Cancel before submission writes no asset. Cancel/navigation after dispatch invalidates local completion but cannot undo an already accepted mutation.

## Strict parser subset

The original file has 1–4 MiB bytes, strict UTF-8, optional one leading UTF-8 BOM, LF or CRLF lines, tabs/spaces between tokens and `#` comments. Bare interior CR, NUL, other C0 controls, DEL and a later BOM reject, including in comments. Lines contain at most 4096 UTF-16 code units excluding their CR/LF terminator. The parser scans lines rather than splitting the whole file into arrays; each line creates at most five token substrings. Comments and empty lines count toward preparation yields and byte admission.

Headers are case-insensitive and occur before the first sample row. Require exactly one `LUT_3D_SIZE` with an ordinary unsigned decimal integer 2–33, no leading-zero or floating representation. Permit at most one `TITLE "..."`, one `DOMAIN_MIN` triple and one `DOMAIN_MAX` triple. TITLE supports a literal `#` inside the quoted title and an optional trailing comment; escaped quotes/backslashes are unsupported. Duplicate/late/unknown headers reject. Omitted domains mean exact [0,1]. Authored DOMAIN_MIN must equal decimal zero in every channel; DOMAIN_MAX must equal decimal one. Nonidentity values that merely round to 0/1 in binary64 reject.

Every sample line has exactly three decimal tokens, at most 64 characters each, using sign, decimal point and optional `e/E` exponent. Reject hex, NaN, Infinity, missing values, extra values, 1D/combined shapers and range extensions. Before `Number(token)`, bounded significand/decimal-position checks prove the exact authored decimal is in [0,1]; signed literal zero is allowed and canonicalized. Reject a nonzero authored value that underflows to zero. Thus `-1e-999`, `1e-999`, `1.000000000000000001` and a `.999999999999999999` DOMAIN_MAX do not silently become allowed endpoints. Accepted ordinary decimal values are deliberately rounded by `Number`, not interpreted as exact-decimal pixel arithmetic.

Require exactly `gridSize³` rows, with red changing fastest, green next and blue slowest. Allocate one dedicated Float64 table directly from a validated size; do not retain a JS sample array or a second full table. When an expected persisted descriptor exists, compare byte length before parsing and compare the size header **before table allocation**. Verify exact title presence/value before returning. Import derives these metadata fields from the file. All paths use this same grammar.

Yield before a line would make the current batch exceed 65,536 visited UTF-16 units (including comments/terminators); maximum line bounds setup. The strict UTF-8 decode and SHA-256 each operate on at most 4 MiB in native code and are separately bounded, not claimed to be interruptible on every character. Runtime bounded reads use the same nonblocking/no-follow regular-file descriptor for stat/read/restat and verify digest; declared bytes must equal actual bytes. Detect truncation/growth, do not read an arbitrary file to discover its size. The external file helper's one sentinel byte is a transport allocation, not retained by the renderer.

## Pixel arithmetic and the rejected Q16 alternative

For a byte component `c` and grid `n`, compute exact integers `p=c*(n-1)`, `i=min(n-2,floor(p/255))`, `f=p-255*i`. Lower/upper weights are `255-f` and `f`. This puts byte 255 in the last cell at fraction 255. The three axis lookups share one 512-byte Uint8 array, containing 256 cell indices and 256 fractions. Flatten sample RGB at `3*(r+n*(g+n*b))`.

The eight corner weights are integer products of three axis weights. Each is nonnegative, at most 255³, and their exact sum is 255³. For each output channel, start `sum=0` and append `sample*weight` in this fixed order:

`000, 100, 010, 110, 001, 101, 011, 111`.

The candidate byte is `clamp(Math.round(sum/65025),0,255)`. This is one final candidate-byte rounding, because multiplying a normalized sample by the weights and dividing by 255² incorporates the output scale of 255. All input indices, fractions and weights are exact integers; samples/products/sums/division follow native binary64. Do not rearrange into nested lerps, fuse different arithmetic, quantize table samples, add an epsilon, use per-pixel BigInt, or claim exact-real tie/Adobe/OCIO parity. Parsed-value trilinear error is bounded at the scale of a few 1e-13 byte units; half-neighbor outputs can differ by one byte from exact real arithmetic. The policy intentionally pins operation order instead.

Identity tables reproduce every RGB8 component for all supported grids in owner and independent fixtures. This is a tested property of actual identity tables, not a metadata fast path: all active tables pay full work and preparation, including identity-looking files. Alpha is never table input or output. Both new global and source paths preserve alpha and bypass RGB at alpha zero, as the existing modern color-mapping family does. Existing Curves/global scalar hidden-RGB policies remain untouched.

Q16 was evaluated independently: its table saves 646866 bytes at grid33 and permits exact integer final rounding with no BigInt. Its sample quantization changes a legitimate size2 red gain `255/256` at input128 from native Float64 127.5→128 to 127.499992…→127. The independent 100000-case corpus found 49 Q16 differences against exact original dyadic samples and zero for the declared Float64 order, without a universal exactness claim. The photographic grid33 comparison found 314 component-byte differences. Preserving imported sample precision is more valuable than that sub-MiB saving, so Q16 is not in the shipped policy or UI.

The candidate byte then enters unchanged existing caller stages: source entry blend and opacity, subsequent source entries, one final source-stack filter mask, source geometry/Distort and contextual protection, then composition; global lookup uses its existing mask/opacity/protected-pixel behavior. Additional layer masks affect coverage later and never become LUT input. Source working/cutout alpha, generated-content constraints and protected source-edit guards retain their present semantics. Raw Bake writes evaluated working RGB while restoring original working alpha; the separate cutout-alpha asset remains independent.

## Work, yields and named allocation bounds

Source work is **32*S** for each enabled positive-opacity lookup, including identity files, plus existing 40*S for nonnormal entry blend and 8*S for an evaluating whole-stack mask. It joins the existing 384000000 source-work limit. One Normal lookup therefore admits at most 12MP by work, or 9.6MP with an evaluating filter mask, before other limits; two Normal looks admit 6MP. Disabled/zero-opacity entries cost no pixel/preparation work but remain strict typed references. No value-zero identity shortcut applies to this parameterized kind.

Pixel loops yield at most every 16384 visits, using complete bounded rows and the minimum of an existing stricter color/blend cadence. Global lookup retains existing global scheduling/protection/opacity arithmetic with this tighter new-kind cadence. Existing global adjustments do not acquire a new weighted-work limit; global rendering remains bounded by existing graph/dimension/layer limits plus the new preparation cap, not a claimed 384M whole-render bound.

Independently require `sum(descriptor.bytes) <=32MiB` over every active global/source lookup occurrence in graph metadata. Repeated hashes count because each evaluating entry reparses; hidden positive entries count conservatively. A direct source stack checks its own sum before allocation. Protection/inspection can perform repeated graph passes, so this is a nominal per-pass admission, not a promised total wall-time bound. All active evaluations read/parse once per entry, with no retained graph-wide table map.

Let `E` be one LUT's original bytes, `T=24*n³`, `A=512`, `J=65536` bounded scan/token setup allowance, `P=3E+T+J`, `S` source pixels, `N` canvas pixels. `P` covers original bytes E, worst-case UTF-16 text2E, tableT and bounded temporary strings/axis setup; J also covers the small-file case where A>3E. Table33 is 862488 bytes and retained table+axis is 863000. Maximum P is 13510936 bytes. These are named reachable allocation allowances, not engine object/RSS/native-codec limits or immediate-GC promises.

The parser owns text before its first yield. Copy a returned TITLE through at most200 UTF-16 code units into an independent string; a regex/substring title can otherwise retain the whole decoded text. Runtime's separate awaited preparation helper checks expected metadata and returns only the closure over table/axes, so bytes/text/tokens cannot remain captured during pixel work. Import may return the independently stored small metadata. There is no extra full-image candidate plane for this pointwise kind. Compile a source entry after its working output exists and before its pixel loop; the previous entry's ring/table is dead before the next preparation. Compile global lookup before allocating its output or constructing its own mask coverage.

Resource helpers must show these explicit phases:

| Path | Additional new-kind treatment |
|---|---|
|Sequential source candidate cache|`K=max(existing rings/local-tone/Curves compiler, P of each active lookup)`; no sum across entries.|
|Direct source stack|`8S+K+sharedNoise <=256MiB` before preparation; preserve existing work checks.|
|Complete masked source|`max(12S+K, 8S+sourceMaskCoverage+sourceMaskLUT)+sharedNoise`; mirror in graph before decoding.|
|Ordinary graph source|Existing `max(8*largestGeometry,8S+K,4S+maskCoverage+maskLUT)+N` plus retained ancestors/clipping.|
|Global lookup phase|`G=max(P,4N+T+A)`: parse before output/own coverage, then output and retained table coexist.|
|Global direct/preread predicate|`5N+max(P,4N+T+A+ownAdditionalMaskStorage) <=256MiB`, conservatively reserving input4N and protected footprintN. Mirror before all graph RGB I/O.|
|Global lookup phase maximum|`Gmax=max(G across active global lookups)`, zero when absent; it joins the new joint graph envelope below, not an independent passing cap.|
|Any active-LUT graph callbacks|Force existing ordinary-and-positioned additional bitmap callback estimate `C=2*sum(bitmapSourcePixels)+max(feather?4*sourcePixels:0)` once, even without a positioned wrapper. This includes global own coverage and cross-branch protected inspection.|
|New active-LUT joint graph gate|`6N+Rmax+C+sharedNoise+max(Dmax,Gmax)+globalCurvesBytes <=256MiB`. Dmax is the existing alias-aware decoded leaf phase over **all** content leaves, including legacy siblings and procedural reserves. Rmax is global maximum retained group/clipping surfaces; globalCurvesBytes is existing once-only1280 if applicable.|
|Distort|Keep existing Distort work/graph gate unchanged. SourceP naturally joins its candidate cache maximum. The new LUT joint gate also runs and covers global G; no new global G is added to the legacy Distort formula.|
|Bake source filter phase|`encodedWorking+encodedAlpha+(hasAlpha?17:12)S+K+existing64KiB+sharedNoise`. Keep decode, deferred-mask, encode and publication phases as existing maxima. No unrelated global lookup reserve.|

Graph validation mirrors every new direct admission condition before assets/source pixels are read. Whenever any positive enabled source or positive-opacity global lookup exists (hidden entries included conservatively), a joint graph gate combines root6N (RGBA plus base/context footprints), global ancestor/clipping retention, all ordinary/positioned callbacks, shared noise, and the larger sequential decoded-content/global-lookup phase. This closes cross-branch original-context inspection, including a large legacy sibling. Source/global compiled tables do not coexist across awaited entry scopes, so Dmax and Gmax use a maximum. Adding the existing global Curves1280 once is a deliberate small conservative reserve. Do not add a lookup's global own-mask storage again inside Gmax: C already covers its construction and retained callback sets. The standalone direct predicate retains its own-mask term.

For example,4096² canvas, one isolated group and a global33-grid lookup with ordinary full-canvas feathered bitmap mask previously passed separate additional (252521240B) and direct (235744024B) checks. Root/group/output/feather buffers can exceed the cap together. The joint formula charges21N+863000=353184536B and rejects before I/O. A plain24MP raster plus global33-grid lookup instead needs10N+863000=240863000B and remains admitted. A source12MP Normal lookup at maximum preparation size has18N+13510936=229510936B, with work384M. With source geometry dominating, the table stays inside the phase maximum rather than being incorrectly retained through later geometry. These examples do not include additional masks/groups/noise unless stated.

Existing legacy-only graphs retain exactly their prior admission. Purely inactive lookup records do not opt into evaluation buffers/callback reserve, but always undergo strict metadata/history/portable validation. Global own bitmap mask storage is1 source plane or5 during feather preparation, density zero bypasses it; C is a separate conservative simultaneous graph allowance. Global legacy spatial adjustments, outside-style internals, encoded image inputs and codec allocations remain outside the scope of this named content/lookup ledger; do not claim it bounds every renderer phase or total RSS.

The import transport has its own bounded data: base64 at most5592408 chars (worst-case11184816 string bytes), decoded original≤4MiB, strict parserP, and candidate metadata. Transaction aggregate imports stay4MiB. Metadata/history, protocol caches and original native image-codec allocations remain outside renderer named-buffer claims; do not present the new ledger as complete process RSS.

## Typed assets, history and portable files

Create one shared-in-server kind-aware reference walker used by native asset validation and bundle enumeration. It walks global lookup adjustments and source entries through both legacy arrays and the strict masked-stack wrapper, including disabled/hidden entries. Accumulate all uses of each hash, never overwrite raster/source-document uses with a LUT use. Reject mixed raster/PSD/LUT aliases before reads; compatible LUT uses agree on bytes/grid/input/title, with sourceName allowed to vary. Paths/URLs are never durable references.

For every prospective commit, form retained states exactly as current buildCommit does: truncate redo after the cursor, append the candidate, then retain the latest100 states. Across those states admit at most **128 unique LUT hashes and64MiB total unique declared LUT bytes**, after descriptor/typed compatibility checks and before any asset publication. Startup applies the identical bounds before reads, gathers every retained history reference, then verifies each unique asset serially without retaining compiled tables. New project/import and every later commit must use the same predicate so no accepted save becomes unloadable solely because of this new history limit. Reusing a file counts once; replacing often with unique files can reach the explicit limit until old history falls out. Undo/Redo changes no assets and must not evade retained-history checks.

Current-state `.prism` export includes each referenced original LUT exactly once. Import checks metadata/reference/type and aggregate limits first, then validates every LUT's bytes/digest/grammar/descriptor before publishing **any** asset. Preserve current bundle version and limits (193 assets,256MiB bundle,16MiB manifest); a diverse project may legitimately hit them. No special raster decoder may see cube text. Export checks corrupt/missing tables too. Startup/portable validation checks inactive/history-only references; runtime can skip inactive evaluation reads.

Original LUT bytes are never rewritten into a normalized text or secondary binary asset. No lookup GC/library migration is introduced. Existing immutable storage, project/history ownership and rollback protect existing shared blobs. Project asset collection must include lookup refs when deciding whether a newly created blob can be cleaned after a failure; a published project cannot lose a referenced asset because a late exception occurred.

## Recipes and compatibility

First-slice recipes cannot transport assets. Shared recipe kinds/slots and native recipe normalization therefore reject lookup-bearing definitions and capture, including disabled steps, before I/O. A bare hash must not become a supposedly portable recipe. Capturing unrelated layer-style fields remains possible with the existing explicit Filters opt-out. Applying an ordinary dependency-free recipe to a target whose existing stack contains a lookup is allowed and preserves that lookup, subject to full cumulative metadata resource/history validation. Do not silently omit it during capture.

Explicit add/update reuse and `.prism` are sufficient for this first workflow. Existing command parameters, source filter masks, geometry and file export remain compatible. Read-time normalization never invents a missing table, migrates old records or changes existing algorithms. Persisted malformed descriptors and mixed aliases reject before image decoding.

## Implementation seam map after approval

1. Root: shared constants/strict normalizer/base64 checker/declarations, command union and transaction inclusion, new kind/value0, recipe kind exclusions, bridge refusal, status four fields, MCP ordinary help and explicit local-file helper, schema/official SDK tests.
2. Native owner: `server/color-lookup.mjs` for strict parser, metadata-only plans/aggregate helpers, async verified prepare and private sampler; `server/lookup-assets.mjs` or equally narrow typed walker shared by native/bundle. Export `parseColorLookupBytes`, `prepareColorLookup`, `colorLookupCacheBytes`, `validateColorLookupPreparation`, `validateColorLookupHistory` with no exported mutable table in the production public seam.
3. `server/color.mjs`: add parameterized color-mapping kind/normalization/full descriptor merge only. Synchronous `adjustmentTransform` refuses an unprepared lookup; it must not open files or silently use identity.
4. `server/layer-filters.mjs`: optional fifth `{prepareColorLookup}` resolver, propagated through masked recursion; await only active lookup entries; work/cache/preparation/preread validation and16384pixel cadence. Existing callers without a resolver continue unchanged for old kinds and fail clearly for active lookup. Metadata validation allocates no LUT table and reads no asset.
5. `server/native.mjs`: call-time snapshot, atomic add/replace and reused descriptor verification, owned asset transaction scope, commit-history gate, capabilities, bounded runtime resolver passed to source render/Bake, new global pre-output preparation, typed startup/export/import checks. Preserve existing global loop arithmetic and legacy branches.
6. `server/filter-bake.mjs`: inject resolver through bake/materialize, cache max in existing phases; preserve original Aw/Ac semantics and output ownership. Reuse or narrowly extract `server/distort-resources.mjs` content/ancestor phase calculation for the new LUT joint gate, while its old gate stays unchanged; force complete callback reserve for the new scope, keep source cache inside leaf maximum. PSD export, layer inspection, protected-context rendering and generic preview all use the same resolver/validation; audit no alternate synchronous lookup path.
7. `server/project-bundle.mjs`: same typed walker, exact expected assets, validate all before publication. `server/edit-recipes.mjs`: explicit asset-bearing refusal while ordinary recipes preserve existing stack dependencies.
8. UI owner: atomic local draft/import workflow, encoded-sRGB choice, source/global capability partitions, read-only unsupported records, stable async ownership/reconciliation and honest recipe limitations. No duplicate full parser or arbitrary URL downloader.

## Prototype evidence and final acceptance gate

Artifacts are `test-results/color-lookup-evaluation/{prototype.mjs,probe.mjs,probe-report.json,benchmark.mjs,benchmark.json}`. The prototype's `quantized` branch is comparison-only and must not be promoted. Owner checks:40 malformed/grammar/ownership cases,73728 identity and73728 channel-permutation bytes across grids2–33, exact gain-half discriminator, source alpha0/1/128/255 and caller-input ownership. The independent parser/sampler fixture checks and exact arithmetic comparison are in `test-results/color-lookup-review/` and its review document.

The original512² photograph is `test-results/segmentation-public-fixture.png`, SHA256 `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`. Independently authored warm-highlight/cool-shadow fixtures are `warm-cool-17.cube` (263353 bytes; SHA256 `08d7cea13104b5026b9b91175c768660a097c849f03560680751625b4af61d42`) and `warm-cool-33.cube` (2017938 bytes; SHA256 `d68123f7b8a5c2aec8d27f2c17815610f33231e80091dd4292d558360a22af0f`). Their `photo-17.png`/`photo-33.png` show a restrained useful look. Grid33 differs from the analytic authoring function at934 component bytes by at most1, a declared sampled-grid approximation. It is not a bundled preset or third-party LUT claim.

Coordinated Node22.14.0/darwin-arm64 prototype medians:1MP square/wide/tall21.90–22.09ms;24MP512.28ms;33-grid2.02MB file31.57ms preparation;4MiB33-grid file35.68ms;long-number33-grid file31.25ms;64-character token27-grid file21.63ms. Eight4MiB occurrences prepare in287.60ms. Timed5ms heartbeat maximum6.09ms includes input/output copy and parser setup, excludes fixture construction/hash measurement. These are prototype observations, not a latency/RSS guarantee or substitutes for integrated benchmarks.32S is deliberately conservative relative to this fixed24table-load interpolation loop.

The strict-decimal/parser/API/resource design review and metadata boundary fixtures passed before implementation. Release acceptance covers all-axis order/identity/half cases, fresh-process determinism; strict caller ownership; no-I/O work/graph/global/masked/Bake/Distort/history boundaries; repeated preparation and disabled references; exact original file retention; add/replace/default selection; source/global alpha/blend/masks/protection/generated/clipping; PSD/layer inspection; recipe refusal and unrelated recipe preservation; restart/current/history/portable corruption and cross-kind aliases; real ENOTDIR/publish/late transaction cleanup; uncertain response and stale UI ownership. Final browser acceptance remains separate from the backend evidence below.

## Integrated backend acceptance and production measurements

The maintained owner suites `tests/color-lookup.test.mjs` and `tests/color-lookup-native.test.mjs` pass all eight tests. They include two ordinary fresh Node processes, each checking 983040 output bytes; strict parser ownership and all 26 entry blend modes; atomic add/replace, exact descriptor reuse and queue snapshots; transaction byte admission, real persistence and late Bake failures; and inactive/history-only original-file retention through restart and portable files. Independent `tests/color-lookup-audit.test.mjs` passes all eleven tests, including the joint graph counterexample and exact admission boundaries, typed aliases, private compiled tables, source/global pixels, protection, generated content and rollback. Canonical malformed portable descriptors now consistently report `INVALID_PROJECT_BUNDLE` before asset access.

The combined owner/independent/Curves-banks/Hue-Saturation sweep passes 32/32 in 1.145s (`test-results/color-lookup-evaluation/owner-final.log`). The final native plus independent rerun after the lookup-only direct-dispatch ownership and inactive-global refinements passes 15/15 in 0.715s (`native-final.log`). An earlier source blend/filter-mask/Bake catalog sweep passes 31/31 with an actual lookup fixture and resolver in each all-kind loop. Root reports eleven new shared/schema/file/official-SDK tests passing and all 82 schema tests passing. These checks preserve legacy algorithms and scope stronger validation to actual lookup edits.

The final complete regression passes **1109/1109 in21.695s**. The first run exposed one old malformed-filter-mask test that tried to construct its malformed bundle through the now-stricter typed writer. The reviewer changed that fixture to a valid encoded control plus canonical manifest mutation; the production validator was correct and needed no weakening. Color Lookup browser acceptance closed at8 focused plus83 adjacent workflows, with the final client build passing.

Actual optimized Node v22.14.0 on darwin-arm64 measurements are in `test-results/color-lookup-evaluation/production-benchmark.{mjs,json,log}`. Every timed source/global invocation performs its verified bounded asset read, SHA-256 check and strict parse; no persistent table cache is used.

| Production workload | Median |
|---|---:|
| Source 1MP square / wide / tall | 83.98 / 78.45 / 74.60 ms |
| Global 1MP square / wide / tall | 81.99 / 85.25 / 85.91 ms |
| Source 12MP | 496.30 ms |
| Global 12MP | 610.11 ms |
| Global 24MP | 1117.93 ms |
| Eight maximum-size preparations, 32MiB total | 310.92 ms |

The maximum observed 5ms heartbeat gap was 10.39ms. Measurement includes preparation/output copying and excludes fixture construction, measurement hashes and PNG encoding. Matching source/global frame hashes confirm identical full-strength lookup output on these fixtures. The production photograph `photo-production.png` is byte-identical to the prototype photograph, SHA256 `1b4768e893d5e5a46f1d05c278a41d8a3b361236ecf17b00df6238b43afafb00`. Production timings include the existing caller loops and their RGB tuple handling, unlike the faster precompiled prototype loop; neither set promises latency or RSS. The measured bounded setup and yielding loops support the frozen 32S source charge.
