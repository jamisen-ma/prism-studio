# Targeted Hue / Saturation UI

Status: **implemented and verified**, 2026-09-19. Root approved this design and the frozen native contract. This document builds on [the native evaluation/design](TARGETED_HSL_EVALUATION.md), [independent numerical review](TARGETED_HSL_REVIEW.md), [the workflow comparison](NEXT_PRO_WORKFLOW_REVIEW.md), and the accepted [Selective Color UI](SELECTIVE_COLOR_UI_DESIGN.md). The final focused eight workflows, 67 adjacent workflows, two independent client tests and build pass. The final run includes global pending-Apply/preview inspection for both range editors. Acceptance evidence is recorded below.

## Shared range editor

Add a distinct **Hue / Saturation** kind, `hue_saturation`, with `value: 0`, to the global adjustment workbench and source-filter editor. Existing scalar Hue, Saturation and Vibrance remain separately labeled and retain their current algorithms and saved records. The implementation brings the full native counts to 26 global kinds and 30 source kinds; it introduces no new command. Layer blending remains 27 modes and source-filter blending remains 26.

The complete parameter object contains seven rows in this order: `master`, `reds`, `yellows`, `greens`, `cyans`, `blues`, `magentas`. Each tuple is `[Hue, Saturation, Lightness]`. All rows default to `[0, 0, 0]`. Hue accepts −180..180 degrees; Saturation and Lightness accept −100..100 percent. Every value must satisfy the exact centi-unit check `Math.round(value * 100) / 100 === value`, with no tolerance, clamping or silent rounding. Normalize negative zero only. Preserve authored +180 and −180 as distinct valid metadata rather than silently wrapping their draft text.

Use one shared `TargetedHSLControls` and a pure draft/capability helper for both contexts. The parent owns all **21 strings**, not only the current range. A keyboard-accessible **Color range** selector defaults to Master and controls inspection only. Three compact, dark numeric text fields expose **Hue, °**, **Saturation, %**, and **Lightness, %**, with range-specific accessible names such as “Reds hue degrees.” `type="text"` and decimal input mode preserve incomplete `1e`, blanks and equivalent scientific forms. No slider is needed in this bounded first slice; actual finite strings remain authoritative.

Parse all seven rows on every validity check. An invalid hidden row disables Apply and is identified in the selector and message, while range navigation remains usable to locate and correct it. Switching range changes no field string, saved state or execution identity. Equivalent valid spellings such as `1.25e1` and `12.50` compare clean against saved12.5. Reading sparse persisted parameters fills absent rows with effective defaults without writing or sharing row arrays. A partial native update replaces an entire supplied tuple and retains omitted rows; UI Apply sends all seven complete numeric rows so hidden intent is explicit.

**Reset range** changes only the selected tuple to three zero strings. **Reset all ranges** clears all seven tuples. Both are local, keyboard-accessible actions that preserve source filter blend/opacity, masks and geometry. Invalid strings can be repaired with either reset. All-zero settings remain a valid explicit Add and an identity candidate; an unchanged saved canonical record cannot be resubmitted accidentally. Nonzero rows that cancel for a pixel, including combined full hue turns, must not be silently canonicalized to all-zero settings.

## Capability and read-only inspection contract

The frozen capability contract is:

- `hueSaturationPolicy: 'rgb-hue-triangle-hsl-v1'`;
- `hueSaturationRanges: ['master', 'reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas']`.

Root accepted computing32S/authored-zero1S work with the existing additional blend/mask charges. These capability names and the numerical policy are frozen. The client does not reproduce numerical work admission. Require matching **Native**, the exact frozen marker, a well-formed string list containing all seven recognized ranges, and the existing context-specific kind and command support. Source authoring additionally requires `layerFilterCoordinates: 'source'`. Unknown future strings may coexist with the complete recognized list; missing, empty, partial, unknown-only or mixed-nonstring lists fail closed. Global and source support are independent. There is no persisted membership-mode, saturation-mode, Colorize, eyedropper range targeting or adjustable falloff option.

New-kind discovery only offers supported Hue / Saturation. If support disappears while its draft is open, keep all21 strings and the current inspected range; show an unavailable explanation and disable execution. Saved unsupported entries remain inspectable across all seven ranges. Disabled fieldsets must not trap the inspection selector, including while global Apply or its preview is pending: protection, missing effect-mask policy and unsupported filter blending disable mutation controls individually. The new-kind selector itself still disables during busy/protection/mask restrictions, as corrected for Selective Color. Do not broaden unrelated legacy editors.

Preserve the saved global inspector on `update_adjustment` withdrawal, without discarding an incomplete draft. Add-only/update-only command partitions can still inspect and make local drafts/resets; Apply requires its exact advertised command. Policy-unsupported numeric controls remain read-only. Source enabling and reordering fail closed when a saved Hue / Saturation entry lacks its semantic support, including disabled/all-zero/zero-opacity entries. Delete, Clear and separately advertised Bake retain their existing independent guards and scope disclosures. Existing source-edit and protection rules remain structural even when the candidate is an identity.

Policy/range-list fields join global, source-entry, whole-stack and recipe execution signatures. Keep capability identity out of the draft key. Temporary withdrawal/restoration invalidates an old pending request through a monotonic epoch; restoration does not revive it or rewrite drafts. Optional histogram support must not determine authoring support.

## Existing precise-color ownership and recipes

Extend the existing private `preciseColor` path narrowly to `hue_saturation`; Curves and Selective Color keep their accepted behavior. Capture document/backend/revision, target layer, selected source entry, authored kind and monotonic execution epoch. Range inspection is local and does not invalidate a legitimate result. Entry/target/kind A→B→A and capability loss/restoration cannot revive a pending request. Keep whole-stack operations independent of which entry is selected.

Guard metadata installation, the accepted own-document handoff, asynchronous preview publication and error/refresh completion. Preserve the global owner's intentional empty-document first selection and own revision-keyed remount. When a Hue / Saturation checkbox is toggled while another kind is selected, the actual toggled kind must choose `preciseColor`; it must not fall through the older unguarded path. A current validation/work refusal retains exact drafts and saved state. A revision conflict refreshes the current authoritative graph for explicit review. Add no automatic replay or silent numerical adjustment.

Recipe capture/import remain definition operations. Capture saved effective seven-row parameters, ignoring local text drafts and selected inspection range. Materialize defaults for sparse global and source records so a zero recipe resets a target's previously nonzero rows. A supplied tuple stays a complete replacement; there is no transient reset field. Validate/Apply requires complete support for every Hue / Saturation source step and global update slot/current target, including disabled/zero source entries. Keep existing blend/effect-mask/target/protection checks. A changed policy/range list invalidates ready reports and late validation results.

Appending filter recipes preserves the destination's existing whole-stack effect mask. Capturing a masked source stack keeps the explicit refusal; only a deliberate Filters opt-out can capture styles alone. Definition hashes, application request IDs, same-session deduplication and restart reconciliation stay unchanged. No retry refactor belongs to this feature.

## Product copy and preview

Use **Hue / Saturation** consistently in the kind picker, selected-filter heading and global tab; show Lightness explicitly in its control label. At900px, show Color range, the three fields, Reset range/all, a short sentence and collapsed help, with source blend/opacity/Apply close below. Use the established approximately30px field height and readable dark-field styling. Do not display all21 fields at once or depend on swatch color alone for navigation/errors.

Always-visible copy: **“Adjust Master or a color range. All range settings stay together.”** Keep the parent global/source mask-scope explanation. Put these consequences in collapsed **How Hue / Saturation works** help:

- The six named ranges use the colors entering this adjustment/filter. Nearby ranges can contribute together. Master and named changes combine from those same input colors; changing Master Hue does not retarget a named row to the resulting hue.
- Hue and Saturation use hue-normalized targeting, so a fully matched dark or pale color can receive the complete named correction. Hue wraps around the color wheel.
- Saturation is proportional to current HSL saturation. With the other rows at zero and full named influence, +100% doubles it up to its limit; it does **not** set every color to full saturation. −100% removes it. Exact gray stays gray under Hue/Saturation; this is not Colorize.
- Named Lightness is weaker when the original RGB has less chroma, including dark, pale and nearly gray colors. Its ±100% endpoints need not reach white/black. Master Lightness is unweighted and can brighten/darken neutrals; with the other rows at zero, its full endpoints reach white/black.
- This is Prism's fixed-range native RGB/HSL treatment. It is separate from the older scalar Hue/Saturation controls, is not a perceptual exposure adjustment, and makes no Adobe pixel-parity claim. Fixed ranges have no adjustable falloff handles in this slice.
- Source alpha and hidden alpha-zero RGB remain unchanged; filter blend/opacity and the whole-stack effect mask retain their existing order before later visibility masks. All-zero rows leave the correction candidate unchanged, but non-Normal filter blending can still change pixels. Native work refusal keeps the saved stack intact.

The main canvas and export use actual native preview results after explicit Apply. No approximate client HSL conversion, color-wheel animation or swatch stands in for the authoritative pixel result. Keep low-level rational/fallback arithmetic and work equations out of the product flow; the UI reports native refusal rather than guessing reduced settings.

## Eight focused browser workflows

1. **Defaults, precision and payloads.** Full native26/30 discovery; existing scalar Hue/Saturation remain available and their before/after exports unchanged. Add global/source zero records, value0 and complete21-number payloads. Sparse records open clean with no writes, partial row replacement retains other rows, equivalent scientific strings are clean, and empty-document global creation accepts its own selected adjustment. Exercise both command partitions.
2. **Seven retained drafts and keyboard reset.** Distinct positive/negative/fractional/scientific strings in every tuple; navigate all ranges and edit using keyboard. Hidden invalid strings, overprecision, ±Hue bounds and ±S/L bounds block Apply with navigable explanations. Retain +180/−180, exact0.01 boundaries and negative-zero canonical comparison. Reset range/all remain local and preserve unrelated rows or source blend/opacity as specified.
3. **Independent pixel semantics.** Use independently checked goldens for the frozen native binary64 evaluation order, never the production transform as expected-output oracle. An exact-real rational reference is a comparison tool, not a requirement to override a documented binary64 half tie. Cover all hue sectors and wrap, dark/pale Reds desaturation, proportional near-gray saturation, exact gray immunity, Master versus named Lightness, original-input membership under combined Master hue shifts, aggregate clamps, combined hue turns and final-byte half ties. Pin source/global results with mixed alpha, including alpha0 hidden bytes through raw Bake.
4. **Scope, ordering and resource refusal.** Global selection/attached mask versus source effect-mask behavior, multiple entries/order, fractional opacity and nonnormal blend, zero candidate versus structural active entry, protected target and earlier protected content. Bake matches the live masked/transformed composite, retains source assets/alpha/geometry, and Undo restores filters and scope. Use a metadata-admitted hidden-source fixture crossing the frozen work boundary to prove one refused edit preserves graph/assets/history/draft without automatic retry; do not duplicate the native work policy in client validation.
5. **Capabilities and inspection.** Missing/wrong marker, partial/empty/unknown/mixed range lists, known lists with future string extras, Native-only and independent global/source kind/coordinate/command sets. Preserve all strings during live withdrawal/restoration and saved-global update-command loss. Inspect all ranges under protection, mask-policy loss and unsupported blend, while numeric/reset/new-kind/submission paths remain appropriately disabled. Reorder/toggle versus independent Delete/Clear/Bake gates; histogram absence stays harmless.
6. **Late ownership.** Global/source Apply and cross-selected row toggle with held result and held preview; target/filter/kind away-and-back, range-only inspection during pending work, capability withdrawal/restoration and stale catches. Pin own-success remount and empty first selection. A new target's draft/image cannot be replaced by obsolete success/error/final cleanup; revision conflict has no automatic replay.
7. **Recipes and project retention.** Saved-only complete-row capture for global/source despite unsaved strings, explicit zero/default recipe resetting nonzero target rows, definition transfer, source-mask capture refusal/style opt-out and masked append with one Undo. Global/source policy changes invalidate readiness and late validation. Verify actual reopen/portable transfer and native restart evidence without modifying recipe retry/reconciliation behavior.
8. **Real photograph and narrow layout.** Reuse the original NASA/scikit-image astronaut fixture with its maintained SHA; no image generation. Export original, a modest named warm-color treatment and a proportional Master-saturation comparison, retaining exact original assets and alpha. Inspect1440/900 controls, expanded help and Apply reachability without horizontal overflow. Maintain synthetic palette/near-gray fixtures for exact assertions; photograph is for practical visual evidence. Record zero credential/provider/model calls and isolated-project-only writes.

The following acceptance vectors cover the frozen hybrid memberships and proportional saturation. They are checked against the maintained independently coded native-order reference in `tests/fixtures/targeted-hsl/reference.mjs`; the focused browser also compares actual native exports with that reference. The chosen arithmetic contract uses a fixed binary64 evaluation order and final `Math.round`, without exact-rational fallback. Mathematical half values can land one byte below an exact-real reference; UI copy must not claim exact-real HSL conversion.

| Input RGB | Nonzero parameters | Native expected RGB |
| --- | --- | --- |
| `[32,0,0]` | `reds:[0,-100,0]` | `[16,16,16]` |
| `[255,223,223]` | `reds:[0,-100,0]` | `[239,239,239]` |
| `[128,127,127]` | `master:[0,100,0]` | `[129,127,127]` |
| `[32,0,0]` | `reds:[0,0,100]` | `[92,0,0]` |
| `[255,223,223]` | `reds:[0,0,100]` | `[255,227,227]` |
| `[128,128,128]` | `reds:[180,100,100]` | `[128,128,128]` |
| `[128,128,128]` | `master:[0,0,100]` | `[255,255,255]` |
| `[255,0,0]` | `master:[120,0,0]`, `reds:[0,0,50]`, `greens:[0,0,-100]` | `[128,255,128]` |
| `[224,1,127]` | `reds:[0,-100,0]` | `[176,49,121]`; native green49.49999999999999 rounds49, although the exact-real value99/2 would round50 |
| `[128,127,127]` | `reds:[0,0,10]` | `[128,127,127]`; independent checked native result |
| `[1,0,0]` | `reds:[0,0,10]` | `[1,0,0]`; independent checked native result |
| `[160,96,96]` | `master:[0,100,0]` | `[192,64,64]`; independent checked native result |

Planned targeted regressions: Selective8, Smooth Curves8, tonal8, Channel Mixer/Gradient Map4, editable filters4, blend8, effect mask8, recipes5, Bake6 and professional controls8 =67 adjacent workflows; with focused8,75 total plus build. Update full source/global discovery to30/26 and corresponding partial semantic-capability counts only, preserving missing-source-coordinate22 and the independent blend counts. Root owns shared/status/MCP/schema/SDK/public guides; architecture owns normalization/math/render/work; independent review owns reference proof/audit; this task owns client design/implementation and browser evidence after approval.


## Implementation and acceptance evidence

Implemented the shared controls, exact 21-string draft parser, effective sparse defaults, independent global/source capability gates, complete recipe capture and existing precise-color ownership integration. The source editor preserves range inspection under protection and missing mask/blend support. The saved global inspector preserves exact drafts when its update command disappears. HSL and Selective global range selectors also remain usable while Apply or its preview is pending; all numeric fields, method controls, mode tabs, resets and submission stay disabled.

The final focused [browser report](../test-results/targeted-hsl-browser-report.json) passes **8/8** workflows. Its held-response checks cover source entry away-and-back, an HSL toggle while Brightness is selected, capability withdrawal during preview, global document navigation, and both range editors inspecting their values during held Apply and preview without losing legitimate own success. The real hidden 9.6MP source work-refusal fixture checks unchanged graph/assets and exactly one request. The maintained independent actual-client audit passes **2/2**, and `npm run build` passes.

The focused suite tests global attached masks, a source effect mask, raw Bake alpha/hidden-RGB preservation, live/export equality, original source retention, Undo/Redo, saved-only global/source recipes, complete zero-row recipe resets, explicit masked-stack capture opt-out, reopen and portable project transfer. Retained geometric-stage integration and process restart are established by the separately owned native/official-SDK tests; this browser suite does not claim a transformed-source or companion-restart fixture.

Actual photograph artifacts use the original 512×512 NASA/scikit-image astronaut image from `tests/fixtures/tonal-color/astronaut.png`, SHA-256 `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`. Both full-image exports match the maintained independent declared-order oracle byte for byte:

- [Original photograph](../test-results/targeted-hsl-photo-original.png).
- [Named warm-color treatment](../test-results/targeted-hsl-photo-warm.png): Reds `[−7.25,−12,3]`, Yellows `[4,7,−1]`, other rows zero.
- [Master saturation comparison](../test-results/targeted-hsl-photo-master-saturation.png): Master `[0,30,0]`, other rows zero.
- [900px controls](../test-results/targeted-hsl-900.png), [expanded help](../test-results/targeted-hsl-900-help.png), and [1440px controls](../test-results/targeted-hsl-1440.png).

The report records zero browser errors, credential reads and provider calls. Only isolated temporary projects are written. Source files are byte-preserved; no AI generation, cutout replacement or external model call was used. Independent source review cleared the parser, semantic gates, ownership integration and final busy-inspection correction.

Adjacent regressions pass **67/67**: Selective8, Smooth Curves8, tonal8, Channel Mixer/Gradient Map4, editable filters4, blend8, effect mask8, recipes5, Bake6 and professional controls8. Together with focused8, this is **75 distinct browser workflows**. Selective8 was rerun after the final global busy-inspection fix and remains green. [The adjacent report](../test-results/targeted-hsl-adjacent-report.json) records every result. All owned test/build processes exited successfully; no implementation change remains pending.
