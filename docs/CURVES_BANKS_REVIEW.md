# Independent review: Master and component Curves banks

Status: **independent production native audit10/10 and actual-client helper audit3/3 pass; root reports full1076/1076, and the owner reports focused8 plus adjacent75 browser workflows/build passing**. Wrapper source review is clear; root's separate accessibility review passed without findings or edits. The final [architecture design](CURVES_BANKS_DESIGN.md) agrees with the reviewed compatibility, composition and resource contract.

## Useful scope

Independent Master, Red, Green and Blue curves consolidate a practical existing workflow under one entry, mask, blend and opacity. Four current full-opacity Normal Curves entries can express the proposed order but consume half the source stack's eight entries. The new entry is not equivalent to arbitrary four-entry stacks with separate masks, blends or opacities.

Adobe documents individual channel selection and component curve overlays. That supports the workflow without establishing Prism's byte order or Photoshop numerical equivalence. [Adobe Curves documentation](https://helpx.adobe.com/photoshop/using/curves-adjustment.html)

## Representation and update ownership

The proposed `{mode:'banks', banks:{master,red,green,blue}}` representation must remain mutually exclusive with legacy `{points,channel,interpolation}`. Canonical banked records retain their discriminator even when every bank is identity. Old strict Curves readers then reject the unknown fields rather than silently rendering a different curve. Ordinary reads must neither upgrade old records nor rewrite their hashes.

Each canonical bank contains its complete point list and explicit `linear` or `smooth` interpolation. Defaults create four independent identity lists; returned metadata and compiled tables must not alias caller-owned arrays.

Current global and source update code shallow-merges parameter objects before normalization. That behavior cannot be reused unmodified for representation changes: it would retain incompatible top-level legacy fields when adding banks, or preserve banks when converting back. Both update paths need the same dedicated merge policy, with validation before evaluating unknown getters or spreading new strict records.

The proposed policy is explicit:

| Update | Required behavior |
| --- | --- |
| Legacy target with ordinary legacy patch | Preserve the existing partial-update behavior and literal legacy canonical form. |
| Legacy to banks | Explicit `mode:'banks'`; replace the representation using submitted bank fields and identity defaults. |
| Banked target, bank patch | Explicit `mode:'banks'`; omitted banks retain; supplied bank fields merge, with `points` replacing the complete list and omitted interpolation retaining its value. |
| Banked to legacy | Explicit `mode:'single'`; discard bank metadata and normalize submitted/default legacy fields. Never infer conversion from a top-level `points` field. |
| Complete recipe | Reset all effective settings; never inherit omitted settings from the bound target. |

The actual proposal helper pins an empty parameter patch as a no-op and same-legacy explicit `mode:'single'` as an ordinary partial update. The important boundary is that changing representations is deliberate and discards the old representation. The independent prototype checks exercise both cases.

A UI **Upgrade to banks** should submit the entire conversion: an old RGB curve becomes Master, an old component curve becomes that component, and every other bank is a default Linear identity. This preserves old bytes, including Smooth behavior and unusual valid point spacing. A generic API mode switch with no submitted banks may intentionally reset to identities; it must not be described as a pixel-preserving upgrade.

There is generally no lossless arbitrary bank-to-single conversion. Component-specific curves cannot be represented by one old RGB curve, and composing two 16-point curves can require more than 16 points. A return-to-single action must explicitly choose replacement settings and disclose that the other banks are discarded; never fit a lossy approximation silently.

## Numerical compatibility

The proposed order is **Master byte LUT, then the matching component byte LUT**. Each bank compiles with its existing Linear or Smooth algorithm. For input `r`, the red candidate is `redLut[masterLut[r]]`; likewise green and blue. Entry blend and opacity apply once after this byte candidate. The stack's shared effect mask remains deferred until the full filter stack returns.

The maintained design-only probe at `test-results/next-pro-workflow-review/curves-banks-probe.mjs` compares 32 mixed Linear/Smooth bank configurations with four sequential existing transforms: **24,576 bytes agree**. It records an order counterexample: `[1,150,66]` becomes `[1,182,99]` in Master-first order versus `[2,182,99]` in reverse order. Two half-scale byte stages map input1 to1; delaying the first byte round gives0. These are contract distinctions, not tolerances.

Keep the old Linear implementation literal. Smooth retains its reviewed exact identity/authored-knot behavior and native binary64 interpolation, without claiming universal old-Linear endpoint equivalence. Each bank accepts the existing 2–16 finite points in0–255, strict increasing X and X endpoints0/255, including adjacent and subnormal spacing. No epsilon, minimum gap, coordinate rounding or hidden linearization is justified by adding banks. New-bank strict JSON validation must not silently tighten unrelated legacy metadata acceptance.

Canonical all-identity banks still constitute an active source filter. Nonnormal entry blending can change an identity candidate; work, protection and source-edit guards must remain structural. The compiler must return fresh pixel tuples and retain private tables, with no mutable lookup or diagnostic-plan property exposed to callers.

## Recipe and capability boundaries

Canonical bank recipes materialize all four point lists and all four interpolation values. Applying one must reset prior target settings. Legacy recipes need the existing transient `interpolation:'linear'` reset plus transient `mode:'single'` so a saved old recipe resets a banked target. Those execution-only fields must not change existing recipe serialization or hashes. Source recipe entries append fresh canonical configurations and preserve the existing filter-stack mask wrapper.

Bank support requires `curvesBanksPolicy:'master-byte-then-channel-byte-v1'` and a well-formed `curvesBankNames` list containing Master/Red/Green/Blue's canonical names `master`, `red`, `green`, `blue`, in addition to the existing Curves kind and command support. Any Smooth bank requires the existing Smooth policy/mode capability, including a nonselected bank. Validation, source reorder/enable, recipe execution, bound-target mutation and late-response signatures must inspect all banks. Unsupported saved banks remain available for inspection. Legacy Linear remains usable without new bank or Smooth capabilities.

Root explicitly retained the existing distinction between inert recipe definition capture/import and execution. Definition capture/import may preserve complete valid banks on a companion unable to execute them; it must not discard a hidden unsupported Smooth bank. Capability gating applies when validating/executing or mutating a bound target, not merely preserving a definition. Captures still exclude unsaved drafts and obey the existing masked-stack scope refusal.

The client must retain exact strings for every bank, validate hidden banks, and avoid resetting their drafts when selecting another bank. Bank selection is local inspection, not a command. A selection change during a point drag must cancel or refuse that drag without allowing its pointerup to edit the newly selected bank. Existing captured SVG matrices, untouched-axis preservation, pointer ownership and exact cancellation rules remain applicable.

Public command schemas and nonnative bridge guards must reject banked parameters before dispatch. Native project/portable/recipe validation must reject malformed bank metadata before source asset reads or any document mutation. Saved bank mode must never degrade into a legacy identity on an older or unsupported companion.

## Buffer and work accounting

The proposed compiler preallocates one768-byte output table, compiles a256-byte Master table and one256-byte raw component at a time, composing into the corresponding output slice. Peak named table allocation is **1280 bytes**, with **768 bytes retained** by the final transform. The existing8-byte Smooth setup view dies before its256-byte LUT allocation; while compiling a component this setup phase is1032 bytes, below the1280 table peak. Bounded point/segment JavaScript objects are additional metadata, not covered by a typed-buffer count.

No new image plane or persistent shared table is needed. The source pipeline should charge1280 as a sequential candidate-cache maximum, including identity banks when enabled and opacity is positive. It must take `max(spatialRing, bankCompileBytes)` across sequential entries rather than sum all banks or all stack entries. The reserve must flow through ordinary graph scratch, direct evaluation, full masked-source preflight, Bake's filter phase and Distort's decoded leaf phase. It must not survive into the later source-mask, geometry, encoding or publication phases unless the implementation actually retains it.

Global banked adjustments also allocate the tables. Distort's content-leaf scan excludes adjustment layers, so source-cache changes alone miss them. The final design adds one1280-byte global-bank reserve to the graph scratch/positioned-mask and Distort envelopes when any banked adjustment has positive opacity, including hidden adjustments. It is not one reserve per adjustment; current renderer adjustments execute serially and their closures do not escape. Source-cache plus this global constant is intentionally conservative. Preserve the stated scope of existing global ledgers: this addition does not make them a full decoded-frame or process-RSS bound. PSD/preparation consumers inherit the corresponding graph estimate; source-only Bake excludes unrelated global banks.

Three final channel lookups do not justify charging four complete image passes. The final work contract retains1S, with synchronous setup bounded to four tables/at most64 points. The owner's isolated measurements support that choice: worst16-point-bank setup medians are0.0552ms Linear/0.0631ms Smooth, and the prototype source-like24MP loop is150.96ms. Those measurements do not include actual integrated rendering. New banked source loops additionally cap the existing32-row batch at65536 pixel visits; blend retains its16384 bound, and legacy single/global cadence is unchanged. Disabled/zero-opacity source entries allocate no tables but still undergo metadata validation.

Independent arithmetic confirms useful phase controls. A masked8191×2731 source has12S=268435452 bytes, only4 below256MiB; bank1280 must tip its full-source preread gate. An unfiltered2410×7956 identity Distort has14N=268435440, so one global-bank reserve must tip the stronger graph envelope. In contrast, an active1490×8189 Distort has a geometry-dominated22N=268435420: a source bank's1280 remains below that phase maximum and must not be charged again after geometry, while a global bank's conservative reserve does tip it. These distinguish correct phase accounting from a blanket post-maximum source-table addition.

## Integration and acceptance constraints

Banked Curves must preserve the two existing alpha policies: global Curves may grade hidden RGB, while source filters skip alpha-zero RGB and preserve original alpha. Do not add Curves to the global color-mapping alpha-skip set merely because the parameter representation grows. Source alpha is combined before bank evaluation; geometry, including Distort, follows the complete stack and shared effect mask. Original/filtered restoration, protected footprints, generated exclusion, isolated groups and clipping keep their current paths.

Bake should materialize the exact new candidate while retaining immutable original source assets, preserving alpha/geometry and consuming the stack mask under existing rules. No metadata-only bank edit needs an asset write. True persistence failure and late pixel-transaction failure must preserve graph/history/assets and the prior representation; canonical recipes and portable/restart round trips must preserve complete bank settings.

Before closure, independently check production/prototype normalization and both merge paths, legacy recipe-to-banked reset, new recipe-to-old target reset, literal old Linear/Smooth goldens, conversion byte identity across all legacy channels, hidden Smooth capability withdrawal, phase-boundary metadata admission before I/O, and the established native protection/Bake/rollback contexts.

## Independent proposal evidence

`node test-results/curves-banks-review/probe.mjs` currently passes **46 actual-prototype compatibility checks and74,496 compared bytes**. Its48 explicit upgrades cover all four legacy channels, both interpolations, simple curves, nonmonotone curves, subnormal/adjacent X and the adversarial endpoint. Existing Linear maps that endpoint to1 while Smooth maps it to0; upgrading preserves each result. A separate direct polynomial oracle checks the symmetric Smooth peak followed by half-scale, inversion and identity component curves.

The prototype checks cover independent default lists and caller snapshots, private compiled state/fresh outputs, points-only and interpolation-only bank edits, omitted-bank retention, both representation changes, empty patches, same-legacy explicit mode, full recipe resets across both target representations, strict mixed-field rejection, accessors rejected without invocation and canonical all-identity banks rejected by the old normalizer.

One small prototype defect was reported to architecture and corrected: `normalize(null)` formerly reached `Object.hasOwn` before the existing structured argument guard. The added negative case now confirms `INVALID_ARGUMENT`, matching legacy behavior. None of these proposal checks modifies or claims acceptance of a production bank implementation.

I read the final architecture/UI designs and inspected `test-results/curves-banks-evaluation/photo-comparison.png`. The restrained component correction produces a useful visible change after Master contrast; the owner's report pins identical Master versus explicit-upgrade PNG hashes. The final UI contract keeps inspection-only bank selection outside Apply ownership, refuses bank switching during active point drag, retains all hidden exact strings, and makes back-conversion deliberately lossy and locally recoverable. Inert recipe capture/import remains distinct from capability-gated execution. No design blocker remains.

## Independent production evidence

`node --test tests/curves-banks-audit.test.mjs` passes **10/10 in approximately0.43 seconds**. No production implementation was edited by this reviewer. The maintained fixture `tests/fixtures/curves-banks/reference.mjs` imports no production code: it composes independently evaluated bank bytes, retains the declared legacy Linear arithmetic, and uses a direct BigInt polynomial for the symmetric Smooth test curve. General Smooth is deliberately outside that fixture rather than copied from the production compiler. Restrained all-Linear photo parameters and literal order/double-round goldens are exported for browser/SDK use.

The maintained audit confirms:

- Exact polynomial/component composition and literal byte-stage goldens, fresh private768-byte output state, and every legacy channel/interpolation upgrade across ordinary, endpoint and adjacent/subnormal point configurations. Existing Linear endpoint1 versus Smooth0 remains unchanged.
- New strict metadata rejects malformed bank keys, points, modes, accessors and symbols without executing getters. Unmarked legacy point-object acceptance remains unchanged. Defaults, normalized results and compiled transforms own their data. Explicit transitions, empty patches and nested partial updates follow the frozen contract.
- Real global and source updates retain hidden banks/interpolation and a stack-mask wrapper. Sparse saved bank records are not rewritten on read. Complete legacy/banked recipes reset either target representation, append complete source entries, preserve canonical hashes, create one Undo entry and validate without image/filesystem access or LUT compilation.
- The8191×2731 masked-source four-byte boundary rejects both conversion and dormant-entry activation before pixels. Its bank recipe reports/refuses the same limit without I/O. Hidden global activation tips the2410×7956 Distort envelope, multiple globals reserve only1280, and source-only banks remain admitted under the1490×8189 geometry-dominated envelope.
- Seven retained positioned bitmap masks place ordinary scratch1024 bytes below the cap; adding one global bank refuses before pixels. Bake's exact filter-dominant boundary adds1280 only to its filter phase. Larger rings use a sequential maximum, small rings defer to1280, and the shared Gaussian-noise table remains a distinct4096-byte reserve in every existing Bake phase.
- Actual global Curves still grade alpha-zero hidden RGB where coverage permits, while source Curves preserve it; every alpha byte remains exact. Mask density, partial opacity and protected footprints retain their existing stages. Identity banks under Multiply remain a real RGB change.
- Independent two-entry source evaluation covers separate alpha, Normal/Multiply opacity, the deferred inverted bitmap stack mask with density0.1, exact integer Distort translation and positioned additional coverage. Raw Bake matches the source oracle, restores original working alpha, preserves immutable source/separate-alpha/geometry/mask fields and keeps composite appearance exact.
- Lower protected alpha1/128/255 content, outline, isolated group and generated clipping member retain contextual restoration and generated exclusion. Protected-target identity and lower-context Bake refusals occur before pixels.
- Malformed global/source/recipe portable bank records reject before asset access. Forged manifest serialization is canonical and an unchanged graph first decodes successfully, so unrelated bundle framing cannot satisfy those negative assertions.
- Real `ENOTDIR` failures preserve graph/history/project files and asset ownership, including a Bake that actually published a new asset before save failure. A later transaction converts/updates curves, Bakes, paints and then fails on a missing layer; both pixel writes occurred and all newly owned files roll back.

`node --test tests/curves-banks-client-audit.test.mjs tests/smooth-curves-client-audit.test.mjs` passes **6/6**, including3 new bank checks against the actual TypeScript helper. They cover exact hidden strings, invalid-bank reporting, independent defaults, subnormal upgrade/downconversion, explicit single replacement payloads, all-bank Smooth capability gates and independent old-single/global/source support. No browser acceptance is inferred from pure helper tests.

## Client wrapper source review

The actual `CurvesEditor`, its narrow `CurvesControl` hooks, ProPanels, LayerFilters, App mount and recipe seams have no remaining ownership/capability blocker. Inspection objects survive own revisions outside revision-keyed drafts, while bank navigation is absent from whole-Curves request epochs. Bank switching is disabled and guarded during a captured drag; point cancellation restores only the matching session, and exact SVG-matrix checks remain in place. Conversion recovery snapshots are local, fully owned and invalidated on a different session/successful revision. Unsupported hidden Smooth banks freeze mutation without hiding inspection, and the ancestor fieldset exceptions leave mutable controls explicitly disabled. Recipe execution checks both the complete bank definition and a banked bound target; inert definition capture stays independent.

The final UI document and help explicitly describe the actual256-byte bank lookup for both Linear and Smooth, while old single Linear retains its authored polyline. An earlier draft still had the old Linear wording; the owner confirmed it was updated when the helper seam froze, and I checked the final text. No production correction or additional numerical claim is needed.

The UI owner reports **8 focused plus75 adjacent browser workflows and build passing**, including all eight legacy channel/interpolation upgrades, explicit replacement/recovery, hidden invalid/Smooth inspection, pointer ownership, pending bank navigation, cross-selected toggle/capability withdrawal, actual41S refusal, recipe reset/hash stability, masked Bake and portable/photo checks. Evidence is `test-results/curves-banks-browser-report.json` and the UI design. Root independently reports **1076/1076 integrated tests passing in21.56 seconds**, including the maintained audits, and inspected the900px controls and graded photo. This reviewer did not rerun the browser harness. The separate accessibility specialist found no issue and made no edits; all acceptance processes have closed.
