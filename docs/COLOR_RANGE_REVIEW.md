# Color Range: independent design and prototype review

Status: **implementation checkpoint for manual testing: independent native audits8/8 pass; client/browser and full integrated acceptance unfinished**, 2026-09-19. Root approved and released the final [native design](COLOR_RANGE_DESIGN.md), [UI design](COLOR_RANGE_UI_DESIGN.md) and [MCP contract](COLOR_RANGE_MCP_DESIGN.md). This reviewer made no production edits and owns the independent fixtures, audit and this memo. At the user's stopping point, work is limited to closing the two already identified client source issues and recording the checkpoint; no further feature or test expansion is planned.

The proposed sampled-RGB soft selection is a useful bounded next feature. It produces graded coverage across disconnected regions with one to eight authored colors, while using the completed exact mask storage and consumer paths. Keep the old Magic Wand unchanged: its current `selectColorAlpha` measures maximum **RGBA** difference, emits binary coverage and optionally flood-fills. Color Range's RGB membership followed by source-alpha attenuation is a separate, explicit policy.

Adobe's current workflow supports sampled colors, additional/removable samples, adjustable fuzziness, grayscale partial-selection previews and inversion. Its additional tonal, skin, gamut and localization controls are unnecessary for this first slice. The documentation does not specify a distance metric or alpha formula; it supports the workflow comparison, not arithmetic or Photoshop pixel parity. [Adobe Color Range, updated February 23, 2026](https://helpx.adobe.com/photoshop/desktop/make-selections/freehand-selections/select-a-color-range-in-photoshop.html).

## Exact arithmetic and authored settings

For each RGB8 pixel, take the minimum, over all authored swatches, of the maximum absolute R/G/B component difference. This is encoded-byte Chebyshev distance `D`, not a perceptual, hue-only or linear-light distance. Full tolerance `T` and additional falloff width `F` are integers in `0..255`.

Use inclusive full coverage for `D≤T`; use zero for `D≥T+F` outside that plateau, or any `D>T` when `F=0`. Interior membership is the exact half-up byte for `255*(T+F-D)/F`. Next compute the exact half-up byte for membership times alpha divided by255. Inversion complements this final byte. Do not fuse these two roundings.

The proposed Number implementation is exact for this integer contract. All numerators before division are integers below `2^17`; denominators are at most510 and quotients at most255.5. An integral quotient is representable exactly. A nonintegral rational is at least `1/510` from an integer boundary, far greater than the conservative binary64 division error bound `2^-44` at this scale. Consequently `Math.floor` of the proposed shifted rational agrees with exact integer half-up. No per-pixel BigInt or near-half fallback is needed.

The independent [reference](../test-results/color-range-evaluation/review-reference.mjs) uses BigInt division and imports no implementation. [Arithmetic evidence](../test-results/color-range-evaluation/review-report.json) covers all **16,777,216** `(T,F,D)` triples, including5,527,040 interior cases and115,122 exact membership half ties; all65,536 membership/alpha pairs and their inversions;11 literal goldens; and sample-order/hidden-RGB cases. Important fixed outcomes are:

| Input | Required result |
| --- | --- |
| `T0/F4/D1/A2` | Membership191, final1; a fused calculation would give2. Inversion gives254. |
| `T0/F2/D1/A255` |128, the exact membership half-up tie. |
| `T32/F0`, distances32 and33 |255 and0 before alpha. |
| `T200/F100/D255/A255` |115; the tail is not truncated to a width of55. |
| `T255`, any falloff/swatches | Exactly the final-composite alpha channel before inversion. |
| Any hidden RGB with alpha0 |0, or255 after inversion. |
| RGB midway between two swatches, each giving128 |128; sample union is nearest distance, not additive coverage. |

Allow `T+F` through510. This follows full tolerance plus additional width, and can leave nonzero coverage even at the greatest possible RGB distance. Preserve the plateau-first branch when `F=0`. Fully matching RGB with alpha128 produces128, not255.

Require one to eight distinct exact seven-character hex strings. Normalize hex letters to lowercase, then reject duplicates; retain authored order in settings and response metadata even though permutation does not change pixels. Do not coerce strings, silently deduplicate or accept a terminal newline. Strict own data properties and ordinary dense arrays must be checked before reading accessors or a generic schema snapshot. Explicit undefined is invalid; omission supplies a default. Normalize scalar negative zero to zero.

## Actual prototype and photographs

The [prototype probe](../test-results/color-range-evaluation/review-prototype-probe.mjs) compares the callable owner helper against the independent reference. Its [report](../test-results/color-range-evaluation/review-prototype-report.json) records all16,777,216 actual membership results,131,072 actual scalar/LUT callback bytes,22 literal strategy cases,23 strict refusals with zero getter invocation,16,384 bytes unaffected by caller settings mutations after an asynchronous yield, and524,288 full-photo exact-reference bytes. Both the scalar and256-entry lookup implement the same arithmetic. Eight swatches yield after8192 pixels, or65,536 sample comparisons. These are functional observations, not latency measurements.

I inspected the owner's [coverage montage](../test-results/color-range-evaluation/architecture-photo-coverage-comparison.png) and [dark-matte montage](../test-results/color-range-evaluation/architecture-photo-matte-comparison.png). **32/32 is an appropriate default.** It gives more continuous coverage across the orange suit than hard32/0 and fewer textured gaps than16/32. The soft boundary remains adjustable. A skin-colored swatch also includes similarly colored background; broad dark-blue settings include near-black surroundings. Those limitations are useful to show explicitly and are consistent with RGB cube distance. Do not label the operation skin, object or sky detection. The photo input remains SHA-256 `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`.

## Ownership, preview and output semantics

Use a fresh **final visible composite**, independent of active selection and selected layer. Existing masks, filters, Fill, outside effects, clipping, isolated groups, protected/context rendering and generated content determine that composite through the existing renderer. The new matcher must not create a second approximate source renderer or reinterpret protected pixels. Authoring a selection does not grant permission to alter protected content afterward.

Preview shows the new candidate **before** Replace/Add/Subtract/Intersect. It should sample the exact full-resolution pixel at each existing nearest-pixel-center coordinate, then evaluate membership, alpha and inversion. It is an opaque grayscale coverage image, not RGB and not an antialiased/downsampled selection. Echo the canonical settings and order, policy, document/revision, source/output dimensions, maximum edge and sampling identity. Capture owned settings before queueing/awaiting. The current `NativeBackend.execute` serializes read and mutation dispatch through its queue; I found no preview revision race in that supported path. Keep the new command within that ordering and capture its response identity explicitly.

Use positive expectedRevision for Load and enclosing transactions. Preview may retain the channel read's optional positive expectedRevision, while the UI always pins its request. Image decode completion must still match the captured document/revision, settings, capability signature, request and epoch before display. Sample edits, deletion/reordering or capability withdrawal invalidate a read. Merely selecting another layer does not retarget a document-scoped operation.

Manual swatches and **Add foreground color** are sufficient. The old `sample_color` has no server expectedRevision or result identity, and an alpha-zero sample produces black. The UI's existing stale-response guard does not make that read an atomic revision-pinned sampling operation. Do not silently add black from a transparent click or claim a new in-panel sampler. An authored black swatch is valid.

Freeze a complete submitted draft. Pending/unconfirmed Load ownership must remain document-owned across panel teardown; changing settings or closing the panel cannot make an ambiguous prior submission safe to repeat. Reuse explicit refresh/inspection, without automatic retry or a new receipt claim. A preview never stores assets or creates history.

`combineMaskAlpha` already supplies the intended continuous left-hand coverage: Add=max, Subtract=left×(1−right), Intersect=left×right, then final byte rounding. Do not quantize an existing geometric selection before combining: the retained `1/6 × 69` fixture must give11. Replace/Add without an active selection use the candidate; Subtract/Intersect refuse before rendering. An all-zero result is an explicit empty selection, not null/unrestricted coverage.

## Memory, work and persistence boundaries

Force `validateDenseMaskOperation` on both commands even when the input graph has no alpha8, LUT or Distort. Reuse its whole-graph phase estimate and operation-scoped mask-preparation budget; this covers existing source/global/style/noise/protection/callback lifetimes. Do not claim that every24MP graph fits merely because matching itself is bounded.

For canvas pixels `Q`, preview pixels `P` and authored swatches `K`, charge `K×Q` comparisons for Load and `K×P` for Preview. Charge every swatch even for alpha0, `T255` or an early zero-distance exit. This is separate from mask preparation work; freeze its named limit and advertised policy before implementation. At the current dimensional ceilings, eight swatches require at most192 million comparisons. Yield after at most65,536 comparisons, including wide/tall and final partial batches. This does not promise a total render or transaction CPU bound.

The normalized RGB table needs at most24 bytes; a membership LUT needs256. The proposed **280-byte** reserve is sufficient for these named typed buffers. Compile after awaited rendering inside an extraction-only scope. Neither compiled callbacks nor rendered RGB should escape into combination/publication.

| Phase | Named live byte requirement |
| --- | --- |
| Render | Existing forced dense joint graph estimate. |
| Full extraction | `5Q + 280`. |
| Combine | `2Q + Kactive`, with the prepared existing selection omitted for Replace. |
| Publish/deduplicate | `3Q + 64`, including the second existing frame read on a dedup hit. |
| Preview sampling | `4Q + P + 280`. |
| Preview encode/transfer | Existing channel `5P + encodedReserve + transferReserve`; RGB and matcher have left scope. |

Use separate awaited helper return boundaries as in `extractChannel`, `materializeChannelSelection` and `sampleChannelPreview`. A promise that garbage collection will notice unused locals is not a buffer-lifetime contract. Combine uses its existing preparation work in addition to the render schedule. Publication returns only the final owned coverage to the adaptive publisher, which retains prospective history, typed-alias, JSON, graph and commit validation and rollback of newly owned links.

The resulting selection is already representable as exact RLE or framed raw alpha8. Keep the200,000 nonzero-run switch,256-unique/3GiB retained dense-reference quota,16MiB metadata limit and current193-asset/256MiB portable bundle limits. These have different scopes. No new mask consumer, external asset class, recipe dependency or PSD format is required. Saved output is reusable coverage, not a retained editable Color Range recipe. No disk-GC guarantee follows from retained-history limits.

## Concrete integration source checklist

The existing paths are suitable, with several distinctions that must not be lost when reusing them:

- [`NativeBackend.execute`](../server/native.mjs) currently snapshots channel **loads**, not channel preview arguments, before enqueueing. The two new commands both contain a mutable swatch array and should both obtain an owned canonical snapshot at call time. A fresh normalization only after rendering is too late. Direct dispatch should apply the same strict validation before its first await.
- [`validateCommand`](../shared/commands.mjs) parses a transaction's outer `z.record` arguments before recursively validating each command, and then spreads those parsed arguments. Validate raw new-command settings through property descriptors before that outer parse can invoke an accessor or erase hidden/symbol/prototype evidence. Keep the new scope narrow; do not promise a generic hostile-object framework. The positive outer revision must be added through the existing revision-pinned transaction set, and reads must remain disallowed as transaction operations.
- [`withMaskPreparationBudget`](../server/dense-mask.mjs) is an operation-scoped runtime invariant in addition to metadata admission. `dispatch` explicitly enables it for channel read/load on graphs without dense masks; `mutate` separately enables a load's scope for transaction steps. Extend both conditions for Color Range. Only adding `force:true` to the resource estimator would leave the runtime preparation counter inactive on legacy-only graphs.
- Native mutation dispatch already supplies `withRepairAssets`, and both ordinary edits and transactions pass a prospective `validateCommit` callback into the adaptive publisher. Reuse those paths. A new helper should return owned coverage, never store a frame inside the RGB-render scope or bypass the outer asset rollback mechanism.
- Preview sampling visits only `P×K` comparisons even though it still renders and admits the full `Q`-pixel graph. Its matcher and RGBA must leave the sampling helper before PNG/base64 work. A cached full candidate or a render-before-budget shortcut would invalidate the proposed phases.
- [`ChannelSelection`](../client/ChannelSelection.tsx) validates echoed metadata, awaits a request-owned `Image.decode`, checks natural dimensions and rechecks a monotonic owner before displaying. Its busy/capability changes invalidate reads without automatically issuing another request when busy clears. Preserve those properties. Color Range adds canonical swatch order, tolerance and falloff to the read identity; combination mode need not invalidate candidate pixels because it is excluded from preview semantics.
- [`useChannelSelection`](../client/useChannelSelection.ts) lives in App, retaining pending/unconfirmed submissions across panel teardown. Root and UI agreed that Channel and Color Range should share this document-level selection-load record. Switching producer sections, changing a draft or closing a panel cannot bypass an uncertain prior load. Keep a finite definite-refusal allowlist; timeout, unknown errors, obsolete success and revision conflict require explicit Review. A successful result must match the submitted document, dimensions and next revision before metadata and preview acceptance. Its owner excludes selected-layer changes and the command's own busy/revision transition.
- [`denseCommandMasks`](../client/dense-mask.ts) should treat the new load like existing channel Load: only a non-Replace mode consumes the old selection. Replace must not be blocked solely by an unsupported old selection it will replace. Keep preview and load command availability independent, validate policy/limits before use, and permit lower valid advertised limits without silently changing requested swatches or settings.
- Register preview as a read in shared command classification and companion tracking, advertise its bounded limits, return its image through the MCP image path, and explicitly refuse both new native commands on the Photoshop bridge. These are transport/capability additions, not renderer or saved-mask-format changes.

These are concrete implementation recommendations from the current source, not claims of defects in the already accepted channel workflow.

## Decision and remaining integration acceptance

The final design freezes policy `sampled-rgb-chebyshev-alpha-v1`, the private256-byte membership table,192M comparison ceiling,65,536-comparison batch and separate preview/authoring capability gates. Independent source review found no native integration blocker. Preview uses the Color Range policy and bounded read contract independently of dense authoring; Load additionally requires the dense authoring contract. Both native paths retain full graph/mask admission.

## Maintained implementation checkpoint

The independent [maintained fixture](../tests/fixtures/color-range/reference.mjs) imports no production or prototype algorithm. It exposes single-pixel, full-plane and nearest-center preview BigInt references, eleven literal cases and two fixed photographic coverage hashes. The complete [native audit](../tests/color-range-audit.test.mjs) passes **8/8 in739.146917 milliseconds**. Coverage includes:

- Actual private lookup versus independent selected complete ramps, all65,536 membership/alpha products and literal roundings; strict getter refusal and owned compiled settings.
- Helper settings ownership across a held renderer and continuous geometric-left combination, including `1/6 × 69 → 11`.
- Queued Preview, Load and transaction snapshots of mutable settings/arrays, plus direct/TX getter refusal without invocation.
- Actual photo previews and full selections versus fixed full-plane goldens, with unchanged source assets and read-only state.
- Legacy-only graph rejection before rendering, actual operation-scope activation before a nested helper, exact384M versus384M+1 preparation work, and independent transaction-step scopes.
- Exact1MP high-frequency alpha8 output, authored frame/hash verification, saved selection, Undo, portable transfer and restart.
- Real `ENOTDIR` publication failure for new and deduplicated frames, plus late Load/paint transaction failure preserving project/history and prior assets.
- Fresh final-composite measurement through protected/generated content, isolated groups, clipping, source filters, Distort, Fill/outside styles and a global spatial adjustment; selection changes leave rendered pixels and layers unchanged.

Root separately reports schema4/all97 and official SDK3/3 green. Those do not constitute final browser or full integrated acceptance. No actual-client audit file was created, and no incomplete registered test is left in the suite. All reviewer-owned runs exited.

Two bounded client source findings were corrected by the UI owner and independently source-reviewed at the stopping point. Color Range capability keys now serialize descriptor-inspected numeric values or an invalid sentinel, so refused limit accessors are not invoked by key generation. The shared selection controller now uses a dedicated Channel submission key containing Channel command membership and existing Channel/dense semantics, so withdrawing only Color Range commands no longer invalidates a held Channel load. The existing Channel preview key remains unchanged. These final fixes were reviewed in source only; no additional reviewer tests or build ran after the stop instruction.

The incomplete browser harness is preserved outside registration at `test-results/color-range-browser.incomplete.txt`; there is no runnable partial browser suite or package alias, and no incomplete actual-client audit. Root's final build passed in0.587 seconds (Vite178ms); doctor reports healthy105 commands and both app URLs return200. Automated Color Range browser acceptance, independent actual-client execution and a full integrated regression remain unfinished. All reviewer-owned processes are closed; the app is left running for the user's manual testing. Work stops at this checkpoint.
