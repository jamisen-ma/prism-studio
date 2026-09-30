# Next workflow: channel selections or imported color looks

Status: **design and isolated probes only**,2026-09-19. No new command, asset type, adjustment kind, mask format or budget change is implemented. Curves banks backend acceptance is closed with1076 passing integrated tests; its remaining UI acceptance is owned separately. This evaluates [the composite-channel candidate](CHANNEL_WORKFLOW_CANDIDATE.md) against the LUT dependency path in [the earlier comparison](NEXT_PRO_WORKFLOW_REVIEW.md).

## Recommendation

Prioritize a bounded imported **3D color lookup** design over an exact composite-channel-to-selection loader. The decisive issue is existing selection storage: its200000 nonzero-run limit rejects all continuous color/luma channels of our original512×512 reference photograph. That is a routine image, not an adversarial limit case. A new full-resolution channel loader would therefore fail in the first useful photographic example even though its arithmetic and pixel memory are cheap.

A separately named **tonal-range selection** can be useful with explicit threshold/falloff controls, and a read-only channel view has inspection value. Neither should be described as complete channel loading or silently substituted for it. Broad falloffs still exceed the existing limit on an ordinary1MP image; hard thresholds can exceed it on high-frequency/noisy content. Do not raise RLE/history budgets, automatically reduce resolution, quantize coverage or change thresholds to make a failed operation fit.

A typed LUT asset is a substantive but contained addition: only the new color-lookup kind needs a table reader, asset-reference validation and asynchronous preparation. An asset-backed mask redesign would affect every existing synchronous coverage consumer, plus mask geometry, painting, saved selections, brush selection, previews and source/global masks. It is a larger prerequisite than one new LUT type.

## Primary workflow and format references

Adobe describes RGB color channels as grayscale information and alpha channels as stored selections. That supports the proposed inspection/selection workflow without specifying Prism's transparency or byte arithmetic. [Adobe channel basics](https://helpx.adobe.com/photoshop/using/channel-basics.html) Adobe's Calculations tool can combine individual channels into a channel, image or selection; the proposed first slice would cover only a small subset. [Adobe channel calculations](https://helpx.adobe.com/photoshop/using/channel-calculations.html)

OpenColorIO's maintained Iridas Cube reader recognizes separate1D/3D size headers and optional input domains; its3D array is red-fastest. This is a primary format reference, not an implementation to copy or a requirement to support every variant. [OpenColorIO reader](https://github.com/AcademySoftwareFoundation/OpenColorIO/blob/main/src/OpenColorIO/fileformats/FileFormatIridasCube.cpp) Adobe's export workflow establishes practical interchange value for `.cube` looks; a filename does not establish whether a table expects encoded sRGB, log, linear-light or HDR input. [Adobe LUT export](https://helpx.adobe.com/photoshop/using/export-color-lookup-tables.html)

## Measured selection-storage blocker

`test-results/channel-workflow-evaluation/coverage-probe.mjs` extracts alpha-weighted RGB and encoded Rec.709 luma bytes from the existing astronaut fixture. Its original PNG SHA256 is `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`. The512² case uses the original decoded image;256² and1024² are declared resamples for the size comparison. The probe counts exactly the nonzero constant runs used by current `encodeSelectionAlpha`/`bitmapMask`; the limit is200000 runs or600000 scalar entries.

| Image | Red runs | Green runs | Blue runs | Luma runs | Accepted color channels |
| --- | ---: | ---: | ---: | ---: | --- |
|256×256|52504|51797|52735|52238|All four|
|512×512 original|208343|204368|210469|205876|None|
|1024×1024 resample|741908|724712|769209|732853|None|

The opaque alpha channel has one run and succeeds; that does not rescue the intended color-separation workflow. Direct per-pixel binary/byte memory is not the limiting resource. Metadata expansion, repeated history snapshots and graph transfer are exactly what the RLE guard protects. Candidate validation occurs before selection combination, so intersecting a complicated channel with a simple active selection does not bypass the limit.

Current durable selection storage has several connected constraints: native project JSON is bounded at16MiB, recipes have independent32KiB/256KiB limits, saved selections are limited to16, and current masks are synchronously evaluated through `maskCoverage`. Adding an opaque asset reference only to the channel command would leave those consumers unable to read the result. Enlarging only this command's RLE bound would produce metadata rejected by the existing normalizer or shift the same problem into history.

## Tonal-range alternative and its real limits

`tonal-probe.mjs` compares continuous luma, explicit linear ramps64→192 and112→144, and a hard `luma>=128` threshold. Ramps clip below/above their authored endpoints and preserve byte coverage between them. These are illustrative distinct selection policies, not a frozen API. The cases are opaque; partial transparency would add further byte variation.

| Fixture | Continuous | Ramp64–192 | Ramp112–144 | Hard128 |
| --- | ---: | ---: | ---: | ---: |
|512² astronaut|205876 fail|122353|41643|6086|
|1024² astronaut|732853 fail|439911 fail|145968|12162|
|1024² full-range gray noise|1040298 fail|715033 fail|384589 fail|262030 fail|
|1024² near-threshold noise120–135|983114 fail|983114 fail|983114 fail|262207 fail|
|1024² one-pixel checkerboard|523776 fail|523776 fail|523776 fail|523776 fail|

A narrow tonal band has standalone value for selecting highlights, shadows or chromatic contrast and is distinct from the existing click-seeded Chebyshev color selector. Its UI would need an exact full-resolution preview, explicit endpoints/falloff and truthful complexity refusal. It must preserve user settings after refusal rather than soften, shrink or threshold them automatically. This is a credible later small feature, but its limited photographic ramp range and storage-sensitive failure cases make it a weaker next milestone than reusable LUT looks.

## If channel inspection proceeds separately

Use freshly rendered full document pixels, including visible groups/clipping, source filters and their masks, global adjustments, effects and protected/generated composition. The current selection must not gate measurement; it is used only during an explicit Replace/Add/Subtract/Intersect mutation. Do not sample a reduced browser preview or conflate this with the existing layer-alpha loader, which intentionally excludes source filters/compositing.

The most truthful selection preview is opaque grayscale of the exact prospective byte coverage. Unassociated component intensity displayed with alpha is a different view and must be labeled separately. Candidate encoded luma can be defined using integer coefficients2126/7152/722 and half-up byte rounding, followed by a separately rounded channel×alpha/255 coverage stage. It is encoded luma, not perceptual lightness or linear-light luminance.

Inversion is not settled by a generic checkbox: at channel64/alpha128, normal coverage is32, inverted intensity followed by alpha gives96, and inverted final coverage gives223. At alpha0 those two inversion choices produce0 versus255. A future contract must name the stage explicitly; preserving the existing selection inversion convention favors final coverage inversion, but it intentionally selects transparent canvas. Avoid claiming Adobe equivalence for either policy.

Preview can avoid any full-resolution selection/RLE materialization by sampling the fresh RGBA buffer directly into a bounded grayscale plane with the established nearest-pixel-center rule. The rendered4N buffer must become unreachable before encoding/base64 transfer; sizing, extraction, transfer and graph rendering are separate phases. New reads need revision ownership and stale-result guards even though they do not mutate graph/history/assets. Reusing the existing no-RGB-read mask-preview command would blur an important contract; a separate channel-inspection operation is clearer.

Current renderer scratch checks are not a complete RSS or decoded-render proof, particularly for global spatial adjustments and outside styles. A new scoped render preflight may reuse the stronger Distort phase analysis only after checking those additional phases. Merely forcing the current Distort estimator and adding one plane must not be advertised as full-render memory accounting. Existing canvas/source preview bytes and legacy admissions should remain unchanged.

## A smaller complete LUT asset path

The promising first scope is one new native global/source color-lookup kind with3D `.cube` sizes2–33, encoded-sRGB RGB8 input, no1D shaper, no combined pipeline, absent/identity input domain and finite RGB samples in0–1. Unsupported domains, shapers and extended samples reject. A log-intended LUT may also use an identity domain and bounded samples; the file cannot establish its intended color space. Require explicit encoded-sRGB interpretation and provide no log/HDR conversion. Preserve the original verified `.cube` bytes as the sole immutable content-addressed asset, with canonical metadata for grid size, byte length and input/pixel policy. No shared look library, migration or persistent table cache is required.

An atomic import-and-attach operation can parse/validate the file before publishing the asset and graph reference. It should support creating or replacing a source/global look, retain the original source image assets, and clean newly owned files after persistence or late-transaction failure. Reusing a look within a project can reference the existing immutable asset; Undo/history and duplication retain it. Public names/payloads are not frozen here.

The actual integration prerequisites are bounded:

1. Extend the kind-aware project asset walker and `.prism` reference enumeration to include LUT assets. `projectAssetUses`, `validateProjectAsset`, startup/restart, bundle import/export and typed digest/size checks must agree. Do not weaken image/PSD validation or disguise table text as an image.
2. Prepare a verified table asynchronously once per evaluating entry, before its synchronous pixel loop. Current `adjustmentTransform` cannot open files. Source `applyLayerFilters` and Bake need an explicit bounded table resolver; direct callers without a required resolver should fail clearly. Metadata validation estimates work/cache without reading assets or parsing tables.
3. Parse with bounded input/token/line lengths, exact row count/order and no enormous token arrays. Keep parser/text/table lifetimes explicit, release preparation state before the pixel candidate, and use the maximum across sequential entries. Global preparation needs its own conservative graph reserve. No process-wide cache or unbounded retained table map is needed in the first slice.
4. Pin a mathematical interpolation/rounding policy and prove its table/preparation/work bounds before implementation. No Adobe or OpenColorIO byte-parity promise follows from parsing the same file format.
5. Make recipe limitations explicit. Initially refuse capture/save/execution of recipes containing a LUT step, while preserving unrelated recipe workflows and the existing source-filter opt-out. A local asset hash is not a portable recipe dependency. Full recipe packages can be a later feature; `.prism` must already carry every referenced LUT in the first release.

The original asset avoids a second durable canonical-table format and preserves the imported bytes. Repeated entry preparation incurs bounded parse cost, but is simpler to reason about than a persistent cache whose table may coexist with other leaves, masks and Bake phases. A later cache would require separate lifetime/resource policy and measurement.

One numerical option worth probing is a declared Q16 sample table plus integer trilinear interpolation. At size33 its RGB table is215622 bytes. With RGB8 input, cell remainders and all eight trilinear weights can be exact integers over255³; table quantization is explicit and original text is retained. This could provide exact final rational byte rounding without per-pixel BigInt. It would intentionally differ from an arbitrary floating-table interpretation near byte ties, so it must be compared with a simpler fixed binary64 policy before freezing. This document does not approve that quantization or a work weight.

The asset scope is narrower than alpha-mask assets: LUT preparation is asynchronous at two new-kind evaluation seams, while dense mask assets would need asynchronous preparation or new caches for a broad existing family of synchronous coverage APIs. That is why the previously identified LUT dependencies now look like the better investment rather than a reason to ship an unusable continuous-channel loader.

## Next review gate

Advance a bounded LUT design/prototype: verified original-text asset contract, strict parser subset, numerical identity/asymmetric cube fixtures, useful photo look, asynchronous caller ownership, exact cache-phase accounting, native alpha/protection behavior, typed bundle/restart/history ownership and explicit recipe refusal. Benchmark parser and actual worst-case pixel work only in a coordinated window. Preserve this channel/RLE evidence so a later mask-storage design starts from the real photographic requirement. No next-feature production work is authorized by this recommendation.
