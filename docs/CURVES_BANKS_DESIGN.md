# Independent Master and RGB Curves banks

Status: **approved for implementation**, 2026-09-19. Root accepted the representation, byte composition, work/table bounds and photographic example after independent proposal review. Production acceptance remains pending. This extends the existing `curves` kind and value0, with no new commands or kind-count changes:26 global and30 source. The [independent review](CURVES_BANKS_REVIEW.md) and [UI design](CURVES_BANKS_UI_DESIGN.md) describe their separate acceptance responsibilities.

## Purpose and scope

A single Curves entry can retain independent Master, Red, Green and Blue point sets. This lets a user combine tonal contrast and channel color balance under one blend, opacity and mask, without consuming four of the source stack's eight entries. Existing single-curve records and default authoring remain unchanged; upgrading is explicit.

Adobe documents individual channel Curves editing. That supports this workflow, not a promise about Prism's composition order, interpolation or Photoshop byte equivalence. [Adobe Curves documentation](https://helpx.adobe.com/photoshop/using/curves-adjustment.html) The new representation reuses the reviewed native Linear and Smooth algorithms. It introduces no curve fitting, 16-bit/HDR processing, new color space, automatic color correction or imported LUT asset.

## Stored and authored representations

Legacy canonical parameters remain exactly the existing `{points, channel, interpolation?}` representation. Linear omits its marker; Smooth retains `interpolation:'smooth'`. Reading a document never inserts a mode, upgrades points, materializes banks or changes a recipe hash.

New banked parameters use this strict mutually exclusive representation:

```js
{
  mode: 'banks',
  banks: {
    master: { points: [{x:0,y:0},{x:255,y:255}], interpolation:'linear' },
    red:    { points: [{x:0,y:0},{x:255,y:255}], interpolation:'linear' },
    green:  { points: [{x:0,y:0},{x:255,y:255}], interpolation:'linear' },
    blue:   { points: [{x:0,y:0},{x:255,y:255}], interpolation:'linear' }
  }
}
```

Authoring and recipe normalization materialize all four independent banks and both fields per bank. Sparse valid externally supplied bank metadata uses those effective defaults during validation/rendering but is not rewritten solely on read. The `mode:'banks'` discriminator stays even when all banks are identity, ensuring old strict Curves readers refuse it rather than render a silent substitute.

Each bank accepts2–16 finite points in0–255, strict increasing X and X endpoints0/255. It accepts the same fractional, adjacent and subnormal X coordinates as current Curves; no epsilon, minimum spacing or rounding is introduced. Each bank's interpolation is Linear or Smooth, default Linear. Bank objects accept only points/interpolation, the banks object only master/red/green/blue, and banked parameters only mode/banks. No top-level channel or points accompany banks.

New bank records use plain/null-prototype data objects, own enumerable string properties, dense ordinary point arrays and strict point keys x/y. Accessors, symbols, holes, unknown keys and malformed/null structures reject with structured argument errors; helper validation does not invoke getters. Optional undefined members behave as omitted, consistent with existing optional command fields; a supplied mode must select a recognized representation. These stricter bank rules do not tighten the old unmarked single-curve normalization branch. Outputs own their arrays and point objects.

## Partial updates and explicit conversion

Both source and global update paths must use a dedicated Curves merge helper; the existing shallow parameter spread is insufficient.

| Existing representation and patch | Behavior |
| --- | --- |
| Either representation, `{}` | No change to effective parameters. |
| Single, ordinary legacy fields | Existing partial merge and canonical omission remain unchanged. |
| Single, explicit `mode:'single'` | Existing partial merge; marker is removed canonically. |
| Single, `mode:'banks'` | Replace from submitted bank settings plus identity/Linear defaults. No implicit copying of the old curve. |
| Banks, `mode:'banks'` | Omitted banks retain; fields within a supplied bank merge; points replaces the whole list; explicit Linear resets only that bank. |
| Banks, top-level legacy fields without mode | Reject, preventing accidental loss of the other banks. |
| Banks, explicit `mode:'single'` | Replace from submitted/default single settings, discarding banks; marker is removed canonically. |

Every bank-specific payload requires explicit `mode:'banks'`, including a nested patch to an already banked target. `{mode:'banks'}`, an empty banks object or an empty supplied bank are no-ops on an existing banked target. Cross-representation replacement resets all unmentioned settings to the destination defaults. For example, `{mode:'single',channel:'blue'}` on a banked target creates a Linear identity Blue curve, while the same patch on a single target retains that target's points and interpolation.

A pixel-preserving **Upgrade to channel banks** is a client operation that submits complete settings: RGB maps to Master, a component maps to its matching bank, and the other banks become Linear identities. Exact authored points and interpolation are retained. A generic API `mode:'banks'` request is a representation switch, not an implicit upgrade.

An arbitrary bank configuration cannot generally collapse losslessly into one existing16-point curve. The UI's explicit replacement chooses one bank and discloses that the other banks and composed appearance will be discarded on Apply. No silent fitting or approximation is provided. Undo restores the complete prior representation.

## Byte composition and caller policies

Compile each bank using its existing byte lookup. For source input bytes r/g/b:

```text
candidate.r = red[master[r]]
candidate.g = green[master[g]]
candidate.b = blue[master[b]]
```

Master is rounded to a byte before component lookup. Two half-scale Linear banks map input1 to1; a single delayed round would give0 and is not this policy. Entry blend and opacity apply once after this complete candidate. The shared source filter-stack mask remains deferred after every entry, followed by retained geometry, Distort, contextual restoration and layer coverage.

This equals four existing full-strength Normal unmasked Curves entries in Master→Red→Green→Blue order. It does not equal four entries with separate partial opacities, masks or nonnormal blends. The old Linear lookup loop remains literal in `server/color.mjs`; a new bank Linear compiler uses the same arithmetic and branch order. Smooth calls the unchanged shared Smooth compiler. In particular, the valid endpoint `{x:255,y:0.49999999999999994}` after `{x:0,y:255}` maps to1 in old Linear and0 in Smooth; upgrading preserves each algorithm, without correcting Linear silently.

Global Curves retain their established hidden-alpha-zero RGB behavior, while source Curves skip alpha-zero RGB and retain original source alpha. Curves must not enter the global `COLOR_MAPPING_KINDS` alpha-skip set. All-identity banks and cancellation configurations remain structurally active source filters; a nonnormal blend can still change their RGB. Master inversion plus inversion in all three component banks is an exact identity candidate, but its Multiply blend maps128 to64.

## Capabilities and older companions

Native advertises:

```js
curvesBanksPolicy: 'master-byte-then-channel-byte-v1'
curvesBankNames: ['master','red','green','blue']
```

Bank authoring requires Native, the exact policy, a well-formed complete recognized bank-name set, the existing Curves kind and relevant command; source authoring also requires source coordinates. Future string names may accompany the complete recognized set; malformed mixed-type or incomplete lists authorize no bank mode. No redundant mode capability is introduced.

Every Smooth bank, including an unselected or identity bank, additionally requires `curvesInterpolationPolicy:'shape-preserving-pchip-v1'` and the existing Smooth interpolation mode. All-Linear banks do not need Smooth. Single Linear/Smooth keep their current gates. Saved unsupported banks remain inspectable and preserve their drafts; entry mutation, enable/reorder and recipe execution require all applicable semantics. Independently advertised removal and Bake retain their existing gates. The optional Photoshop bridge rejects new mode/banks parameters explicitly. Older native normalizers reject new fields before assets; legacy records continue opening without migration.

Recipe definition capture/import/save remains capability-independent, subject to existing scope rules. Execution Validate/Apply checks every bank and the current bound target. Capability signatures include the bank policy/name list and every bank's Smooth requirement; changing the inspected bank alone is not a request-context change.

## Recipes, persistence and rollback

Complete bank recipes materialize all four point lists and explicit interpolation values, so replay resets every setting rather than inheriting omitted fields from a target. Legacy recipe bodies and hashes stay unchanged. During execution only, a legacy Curves update step receives transient `mode:'single'` plus the existing explicit Linear reset when its interpolation marker is omitted. This resets banked targets to the saved single recipe without storing an execution marker in that definition. A banked recipe must bypass the legacy top-level interpolation injection.

Source recipe entries append fresh complete entries and preserve a destination's filter-mask wrapper. Capturing a masked stack remains refused under the existing scope contract; banks do not loosen it. Metadata changes, validation and recipe planning require no image reads, table compilation or asset writes. Portable validation inspects all nested banks before asset access. Save/reopen, process restart, Undo/Redo and portable transfer preserve representation and full point precision. Actual metadata-save, Bake-publication and late pixel-transaction failures must restore graph/history/assets and the prior representation.

## Setup, work and scheduling

Compile an owned768-byte output table, one256-byte Master table and one256-byte component table at a time. Compose that component into the corresponding output slice before releasing its raw table. The transform retains only the final768 bytes and returns fresh pixel tuples. The public preview compiler returns a fresh owned table, never a shared mutable runtime view.

Peak named table allocation is **1280 bytes**:768+256+256. Smooth's8-byte setup view dies before that bank's256-byte LUT allocation; with output+Master retained, that smaller setup phase is1032 bytes. At most64 authored points and four256-entry compilers are processed. Bounded JavaScript metadata/segment objects are not part of the typed-buffer count. No new image plane, persistent shared cache or dependency is required.

The source candidate work remains **1×sourcePixels** per active banked entry, like current Curves: compilation reduces the pixel loop to three byte lookups. Disabled/zero-opacity entries have zero work/cache, but still validate every bank. Identity/cancelling banks remain1S and compile normally. Existing nonnormal blend adds40S, and an evaluating shared source mask adds8S. The document still has the384M source-work budget,64 entries and8 entries per layer. This consolidates four curve operations into one entry; it does not grant four separate blend/opacity operations.

Setup is synchronous and fixed at four bounded tables; no per-pixel BigInt or unbounded fallback exists. For new banked source Curves, use the smaller of the existing32-row batch and `floor(65536/width)` rows; nonnormal blends retain their smaller16384-pixel bound. Existing single Curves batching is unchanged. The global loop already yields after at most65536 pixels for all kinds and stays untouched. Allocation, codec and GC latency are not hard event-loop deadlines.

## Resource ledger and metadata boundaries

Source bank compilation contributes1280 to the existing sequential candidate-cache maximum, including active identity banks. Across entries use `max(spatialRing, localToneCache, bankCompileBytes)`, never the sum of sequential caches. The current helper name `layerFilterSpatialCacheBytes` may remain for compatibility, with documentation explaining its broader candidate-cache meaning. Metadata estimates must not allocate a LUT.

That maximum feeds ordinary source-filter graph scratch, direct stack admission, the complete masked-source preread gate, Bake's filter phase and Distort's decoded leaf phase. The later source-mask callback and geometry are separate phases: the bank transform must become unreachable before either begins. Source-only Bake adds bank bytes in its filter phase; decode, source-mask, encoding and publication phases do not retain them. Existing64KiB filter workspace and persistent Gaussian-noise table reservations remain unchanged.

A global banked adjustment also compiles tables. Add one conservative1280-byte reserve if any global banked Curves adjustment has positive opacity, including hidden adjustments for stable metadata admission. Charge it once after the existing graph scratch maximum, before the existing positioned-mask callback combination, and once in the stronger Distort graph envelope. It is not per adjustment, and adjustment layers cannot be omitted merely because Distort's decoded leaf traversal excludes them. If source banks also exist, charging their candidate cache plus this conservative global reserve is intentional; it does not imply the sequential compilers actually coexist. Do not add the global reserve to source-only Bake phases.

Legacy-only graphs retain their current estimates. The ordinary graph ledger remains its declared additional-scratch/callback scope; the new constant does not turn it into a full image-buffer, codec or process-RSS bound. Distort retains its separately documented6N+retained-surface+callback+shared-table+decoded-leaf envelope. PSD and preparation paths must inherit the corresponding graph estimate; no new full-frame PSD allocation is introduced.

Useful maintained metadata boundary fixtures after integration:

- Masked source8191×2731, rectangle effect mask, one active Curves entry:12S=268435452 bytes, four bytes below256MiB. Bank compilation adds1280 and must refuse before decode; the ordinary9S graph scratch and9S work are below their limits.
- Unfiltered identity Distort2410×7956:14N=268435440,16 bytes below256MiB. A positive-opacity global bank adjustment adds1280 and must fail metadata admission; opacity0 does not compile it. Multiple global banks still add only1280.
- Filtered Distort1490×8189:22N=268435420,36 bytes below256MiB. The global reserve must tip the full envelope even when source candidate1280 is hidden below a larger geometry phase.
- Bake with separate alpha and a filter-dominant chosen encoded-size boundary: bank cache adds exactly1280 to the filter phase and zero to other phases; unrelated global bank layers add zero to every source-only Bake phase.
- A larger spatial ring followed by banks reserves the ring once, not ring+1280; a tiny/no ring followed by banks reserves1280. Shared noise remains separate and once. Combine the global constant with retained groups/clipping and positioned masks near the existing limit.

## Proposed helper and integration seams

`shared/curves-banks.mjs` is environment-neutral and owns these exports:

- `CURVES_BANKS_POLICY`, frozen `CURVES_BANK_NAMES`, `CURVES_BANKS_CACHE_BYTES=1280`.
- `normalizeCurvesBanksParameters(parameters)`: explicit bank representation to complete owned canonical banks.
- `mergeCurvesBanksParameters(previous, patch)`: explicit bank-mode patch over an already banked configuration; strict nested validation before reading/spreading.
- `compileCurvesBankLookup(spec)`: fresh256-byte lookup for selected-bank preview, using native Linear/Smooth arithmetic.
- `compileCurvesBanksLookup(parameters)`: fresh768-byte composed RGB lookup.

`server/color.mjs` routes only new marked parameters to the helper and retains its old unmarked normalizer and Linear/Smooth branches. A Curves-specific merge wrapper owns the full representation transition policy using the old legacy normalizer. Both `NativeBackend` global updates and `editedFilterStack` source updates call that wrapper for Curves; unrelated kinds keep their old merge paths. The bank transform branch precedes existing Curves branches, retaining a private compiled table. A metadata-only global-bank reserve predicate is available to resource consumers without compiler invocation.

`server/layer-filters.mjs` owns source cache max and bounded bank scheduling. `server/distort-resources.mjs` adds the global constant after its phase maximum. Existing Bake/PSD consumers inherit source/global estimates through their established helpers. `server/edit-recipes.mjs` adds the execution-only single reset and excludes banks from old interpolation injection. Native discovery adds only the two new capability fields and updates limitation prose, with no counts/kinds changed. Root owns shared command unions/kind-aware checks, status forwarding, bridge guards, MCP help and public schema/SDK tests; UI owns the discriminated drafts and capability behavior.

## Proposal evidence

The isolated implementation lives only in `test-results/curves-banks-evaluation/`; no production import uses it. `probe.mjs` passes268 configurations and205824 composition bytes against four current transforms,30720 upgrade bytes across all channels and both interpolations,18 malformed configurations, getter-call count0 and14 merge/recipe cases. It pins byte-stage ordering, exact inversion cancellation, independent ownership and a stable legacy recipe body/hash. The independent review currently passes46 actual-prototype compatibility checks and74496 bytes, including a separate polynomial Smooth oracle and all adversarial point spacing cases. [Independent evidence](CURVES_BANKS_REVIEW.md)

`benchmark.mjs` on Node22.14.0/darwin-arm64 measures worst16-point-bank setup over7000 iterations: median0.0552ms for four Linear banks and0.0631ms for four Smooth banks. The prototype source-like loop includes owned output copying, alpha-zero skip and bounded yields, excluding codecs/full stack/global rendering. Bank medians are6.58ms at1024²,6.63ms at8192×128,10.85ms at128×8192 and150.96ms at24MP. The corresponding warmed legacy Master loop is7.17ms wide,11.55ms tall and155.76ms at24MP; the initial monomorphic1024² legacy case is2.74ms. These are measured samples, not a performance guarantee. Maximum observed5ms heartbeat gap during measured loops was7.21ms. Input fixture generation and post-render hashing are excluded from that heartbeat window. `benchmark.json` preserves every sample summary; actual integrated measurements remain required.

The NASA/scikit-image astronaut fixture is512² with input PNG SHA256 `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`. `photo-comparison.png` shows original, Master contrast, then restrained Master+component treatment. `photo-master.png` and `photo-upgraded.png` are exactly identical, SHA256 `4114a29d8b8175143c08ea2cc8d7fec3ed6ab2edd61ed4b60ccf4472cd7b643f`; full banks SHA256 is `dfe61a3aeeb83504b0a2a47f597aba7e92301966cfa457c95bb260c62a1331dd`. `photo-report.json` records exact parameters. Root visually reviewed the restrained result and accepted the demonstrated workflow.

Production closure requires pure/helper and native owner tests, an independent native audit, schema/official SDK coverage, ordinary fresh-process legacy-versus-upgrade comparisons, all resource preread boundaries, actual rollback/Bake/portable contexts, client source review, focused browser workflows and integrated timing. No existing algorithm's output or old record's serialization is authorized to change.

## Production implementation checkpoint

The shared helper, strict bank normalizer, explicit `mergeCurvesParameters` transition wrapper, source/global dispatch, recipe execution reset and resource integration are implemented. `shared/curves-banks.d.mts` declares the environment-neutral helper interface for the client. The old Linear/Smooth loops, `COLOR_MAPPING_KINDS` and global `applyAdjustment` pixel/yield path are unchanged. New banked source entries receive the bounded batch rule, and the direct source candidate gate includes their1280-byte cache. Native advertises exactly the two approved capability fields; counts remain26/30.

Owner acceptance is **11/11**: five pure tests in `tests/curves-banks.test.mjs` and six native tests in `tests/curves-banks-native.test.mjs`. These cover strict metadata/accessor ownership, actual legacy composition/full point precision, nested merges and explicit conversion, native alpha/mask/protection behavior, all26 source blend modes, real source/global metadata boundaries, source-cache geometry negative control, source-only Bake estimates, transformed/masked Bake and immutable assets, portable replay, recipe canonical reset/hash retention and real save/late-transaction rollback. Two ordinary fresh Node processes each verify2359296 upgrade bytes while exercising repeated optimized calls. Root's two official SDK workflows and all78 schema tests pass. Independent native audit and full-suite/UI closure are recorded separately when complete.

`production-benchmark.mjs` measures the actual `applyLayerFilters` and `NativeBackend.applyAdjustment` paths, with opaque inputs and allocations included but no codec in the timed region. Four16-point bank compilation over5000 iterations has median0.0381ms Linear and0.0481ms Smooth. Source/global median milliseconds are:

| Dimensions | Source | Global |
| --- | ---: | ---: |
|1024×1024|13.84|15.94|
|8192×128|13.02|16.07|
|128×8192|17.30|17.12|
|6000×4000 (24MP)|299.11|365.28|

The maximum observed5ms heartbeat gap is8.57ms; this remains a measurement, not a wall-clock deadline. Source/global output hashes match at all four sizes. `photo-banks-production.png` exactly matches the approved prototype PNG SHA256 `dfe61a3aeeb83504b0a2a47f597aba7e92301966cfa457c95bb260c62a1331dd`. Reports/logs are under `test-results/curves-banks-evaluation/`, with no running measurement process.

Independent maintained production audit is **10/10** in `tests/curves-banks-audit.test.mjs`, with no production finding. It closes actual helper normalization/composition, both representation recipe resets, alpha/context/Bake/portable/rollback behavior and the source/global resource boundaries, including once-only positioned callbacks and the active-Distort geometry negative control. Backend ownership is released; root owns the subsequent single full regression run, and the UI owner owns browser/build closure. No duplicate broad adjacent sweep was run after the owner/audit/SDK acceptance.

Root's subsequent integrated regression is **1076/1076 passing** in21.56s. Focused bank browser8, build and three pure-client checks also pass; broader adjacent browser/accessibility closure remains with the UI owner/root. Native/core source ownership stays released.
