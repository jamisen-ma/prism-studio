# Linked Perspective editing for existing Distort stages

Status: implementation approved; shared helper, native equivalence, independent audits and full regression complete; browser acceptance pending, 2026-09-19. Fill is closed with 1206/1206 registered tests and 67 browser workflows. Root released the environment-neutral paired-corner helper and the matching bounded interaction extension. No Distort renderer, command, schema or capability change is part of this feature.

Adobe describes Perspective as moving a corner with symmetric motion of another corner. This is useful workflow guidance, not a published formula for arbitrary quadrilaterals. The exact pair and arithmetic rules below are native interaction rules; they do not claim Adobe gesture/pixel equivalence, camera calibration, automatic straightening or vanishing-point recovery. [Adobe Transform options](https://helpx.adobe.com/photoshop/desktop/crop-resize-transform/transform-manipulate-reshape/transformation-options-in-adobe-photoshop.html).

## Useful smallest scope

Extend the current `Distort layer` panel with three explicit edit modes: **Free corners**, **Perspective: horizontal pair**, and **Perspective: vertical pair**. Free corners remains the default when opening an editor. Changing mode alone does not change corners or send a command. The existing four saved corners, historical stage index, fixed frame, resource limits and Apply/Remove workflow remain the entire persistence contract.

Horizontal/vertical describe the selected corner's displacement axis, not the perceived direction of the vanishing point. Horizontal edits change X; vertical edits change Y. Numeric edits use the selected stage's historical pixel-edge axes. When canvas handles are available, that stage is new/trailing and its axes coincide with the displayed document axes. Later transforms do not grant historical stages new canvas handles or change their coordinate interpretation.

The four corner identities remain TL, TR, BR, BL, regardless of where an arbitrary saved quad currently places them. Do not geometrically resort corners, normalize to a rectangle, fit an axis-aligned bounding box, rotate into a local edge basis or infer a camera plane. A rotated/skewed quad remains rotated/skewed except for the explicitly paired coordinate changes.

| Mode | Selected corner | Partner | Changed coordinates |
| --- | --- | --- | --- |
| Horizontal pair | TL / TR | TR / TL | Selected X and partner X, opposite displacements |
| Horizontal pair | BR / BL | BL / BR | Selected X and partner X, opposite displacements |
| Vertical pair | TL / BL | BL / TL | Selected Y and partner Y, opposite displacements |
| Vertical pair | TR / BR | BR / TR | Selected Y and partner Y, opposite displacements |

The other six scalar coordinates remain unchanged. In exact arithmetic, the selected edge's midpoint is preserved while its axis span changes. Binary64 computation may introduce normal last-bit error; do not claim exact real-number midpoint equality for arbitrary finite inputs.

## Exact arithmetic and bounded pure helper

For selected index `i`, partner `j`, axis `a`, captured original coordinates `s = baseline[i][a]`, `p = baseline[j][a]`, and authored displacement `delta`:

```js
next[i][a] = s + delta;
next[j][a] = p - delta;
```

Use that binary64 operation order, independently from the same baseline. Do not reconstruct a midpoint, derive delta back from the rounded selected coordinate, or accumulate changes from the previous sample. For example, `s=16384`, `p=0`, `delta=1e-12` can leave the selected Number unchanged while moving its partner to`-1e-12`; this is a valid consequence of applying the authored displacement. When delta is zero, return an owned identity copy without recalculating any coordinate. The UI preserves all original strings on that no-op. There is no exact-real midpoint or inverse-operation promise.

Module `shared/linked-perspective.mjs` and matching `.d.mts`, with no React, DOM, Node, Sharp, native matrix or network imports:

```js
LINKED_PERSPECTIVE_AXES = ['horizontal', 'vertical'];
perspectivePartner(cornerIndex, axis); // index 0..3; horizontal i^1, vertical 3-i
linkedPerspectiveCorners(baseline, {
  cornerIndex, axis, delta,
  limit: 16384 // optional; validated lower native advertised bound allowed
});
// { corners: ownedFourPoints, partnerIndex, withinBounds: boolean }
```

`baseline` is a dense length-four ordinary array of plain/null-prototype `{x,y}` objects with exactly two own enumerable data properties. Arrays with holes, extra/symbol keys, accessors or custom prototypes reject before getter invocation; frozen inputs are valid. The option shape is strict own plain data, with no extra keys. Index must be an integer 0..3; axis one of the two strings; limit an integer 1..16384. All baseline coordinates are finite Numbers within ±limit. Delta is a finite Number with `|delta| <= 2*limit`. No string coercion, percent conversion, epsilon snapping or integer rounding occurs. Copy untouched Number values exactly, including signed zero. Zero-delta identity preserves every Number. Only the two changed results follow the stated binary64 operations; do not globally canonicalize signed zero in this helper. Native command normalization subsequently canonicalizes signed zero under its existing contract.

Both computed coordinates are therefore finite and bounded by`3*limit`; there is no overflow or unbounded computation. An output outside ±limit remains in the owned candidate with `withinBounds:false`, so the UI can show the actual invalid pair rather than independently clamping it. `withinBounds` checks every output coordinate. The helper makes no assertion about convexity, area, pole stability, conditioning, document dimensions or pixel work. Those remain the native Distort validator's responsibility on Apply.

An incomplete/nonfinite numeric delta or one outside ±2*limit remains raw text and does not move corners. A numeric delta inside that bound installs both computed coordinates as one local action, including an over-limit candidate; reset the action delta to0, retain both exact invalid coordinate fields and disable stage Apply until corrected through the independent fields, Reset or Revert. This uses one corner draft, not a second proposed quad. During a pointer gesture, a computed delta outside the helper bound cancels the gesture completely: restore the exact captured strings, release capture, invalidate the drag and show a cancellation notice. Later move/up events from that pointer cannot resume it. A new gesture starts from the restored baseline. In-range pointer candidates outside the native corner bound retain both exact numeric fields and remain invalid; nothing is silently clamped or submitted. The existing canvas guide may disappear after capture ends when its corner parser rejects bounds; persistent out-of-bounds numeric values, not a persistent guide, are required for repair.

This is constant work: inspect four points, copy four tiny objects, change two numbers. It adds no pixel allocation, matrix compilation, render, asset, parser, retained-history growth or new resource limit. The helper is suitable for independent script consumers too, but no new MCP argument or command is needed.

## Golden coordinate examples

Start with `[(0,0),(100,0),(100,80),(0,80)]`:

| Action | Result TL, TR, BR, BL |
| --- | --- |
| Horizontal TL delta +10 | `(10,0),(90,0),(100,80),(0,80)` |
| Horizontal BR delta +10 | `(0,0),(100,0),(110,80),(-10,80)` |
| Vertical TR delta +8 | `(0,0),(100,8),(100,72),(0,80)` |
| Vertical BL delta −8 | `(0,8),(100,0),(100,80),(0,72)` |
| Horizontal TL delta 0 | Exact identity copy |
| Horizontal TL delta +60 | `(60,0),(40,0),(100,80),(0,80)`; basic bounds pass, native convexity validation refuses |

For an arbitrary baseline `[(7.25,11.5),(103.5,-2.25),(94,83),(-5,79.75)]`, horizontal TR delta −8.375 produces TR X=95.125 and TL X=15.625. Both top Y coordinates and both bottom corners remain byte-for-byte the same Numbers. Vertical BL delta −5.625 produces BL Y=74.125 and TL Y=17.125 and leaves both X coordinates and both right corners unchanged.

Bounds discriminator with limit16384: horizontal TL delta −16384 from top pair X values `0,16384` produces partner X=32768, `withinBounds:false`. Do not clamp that partner to16384 or submit only the selected corner. Native still rejects the full over-limit quad if a caller submits it directly.

## Numeric and pointer editing ownership

Keep the current stage session, all eight independent exact coordinate fields and explicit Apply. None of those existing fields silently edits its partner. Linked modes add a selected corner, one **Delta (px)** text field, and **Move pair**; Enter performs the same local action. Display the active X/Y axis and partner. These controls calculate a corner draft only; **Apply distortion** remains the separate command that commits pixels.

The delta field accepts complete decimal/scientific text. Preserve incomplete strings such as `1e` without treating them as zero, and reject nonzero lexical underflow such as`1e-9999` even when Number conversion yields0; signed scientific zero is valid. Reject overflow and magnitudes greater than2*limit. No new parser rule is imposed on the eight existing coordinate fields. Do not rely on number-input sanitization or a slider step for delta.

Move pair captures the current complete bounded corner draft and its eight exact strings at the action, then applies the helper once. Preserve the six untouched strings. Delta0 is a no-op preserving all eight strings. On a successful local action, including a computed over-limit pair, reset delta to0 to prevent accidental repeated movement. A malformed/out-of-helper-bound delta or unparseable baseline changes no corners and keeps the raw text. Invalid native geometry remains an editable full quad; no hidden rectangularization occurs.

A nonzero or incomplete/unusable pending delta blocks stage Apply until Move pair or explicit **Clear delta**; Apply never silently consumes it. Guard mode, corner and stage switches while such a delta is pending, with the reason visible. The existing independent fields may correct the current baseline before Move pair. Clear delta removes only the unapplied delta; Revert restores the existing saved-stage/new-rectangle baseline and clears the local action draft. Closing the whole editor remains its existing deliberate draft discard. Free corners is the default on a new/revisited editor session; modes are not inferred from a saved quad or persisted.

For pointer editing, capture mode, axis, corner, baseline quad/strings, frame size, pointer identity, displayed image rectangle and ownership epoch at pointerdown. Compute delta only from active-axis displacement relative to that capture: horizontal `(clientX-startX)/rect.width*frame.width`, vertical `(clientY-startY)/rect.height*frame.height`. Both helper coordinates come from the original four-point baseline. A nonfinite computed delta follows the complete-cancellation rule above. Ignore motion on the orthogonal screen axis. If the active-axis screen displacement is zero, restore the original paired coordinate strings exactly even if the orthogonal pointer moved.

On Escape, pointercancel/lost capture, view geometry change, document revision change, target switch, backend/capability withdrawal or mode change, restore the captured pregesture draft and release pointer ownership. Mode and pair mutations are disabled during a captured drag and while a command is pending. Stage switches are disabled during capture or while a local delta is unresolved; existing retained-stage inspection during a pending command remains allowed once no delta is pending and invalidates old ownership. Close remains explicit discard, including an unresolved delta; explicit pointer cancellation remains available. Check live mode/context/capability/view ownership before every move/up draft change. Never let a paired pointer change a free-corner draft under a new mode or make a new pointer continue another pointer's baseline.

The current Distort session already has revision/capability/target epochs and `distortResultMatches`; extend those boundaries to paired mode rather than creating another mutation runner. A→B→A mode/target/capability transitions invalidate previous pending ownership even if values eventually match. Successful Apply resets the pair baseline to the acknowledged full stage. A failed native convexity/stability/resource check leaves the submitted complete quad and exact numeric drafts editable.

Canvas handles remain available only for new and trailing stages under the existing capability, protection, revision and busy gates. Historical saved stages retain numerical pair editing when update is supported, but no guessed mapping through later geometry is added. Disabled update does not disable separately authorized Remove. Add/update/remove support continues to come from the existing exact Distort policy, stage-coordinate marker, eligible types, limits and commands. There is no new capability marker because every resulting command is an ordinary previously supported four-corner edit.

## Native, persistence and public boundary

Apply sends the existing `add_layer_distort` or `update_layer_distort` with a complete four-point `corners` replacement, positive expected revision and existing full transform index. Mode, axis, selected pair, delta and interaction baseline are never persisted. Old native readers supporting the existing Distort stage therefore render paired edits normally; older readers lacking that stage keep their existing refusal. Native validation remains authoritative for the whole quad and all intermediate transaction states.

No server Distort normalization, homography, sampler, alpha policy, integer-copy optimization, work weight, memory estimate, clipping/Fill/mask/Bake behavior, portable serialization, recipe support or source asset changes are planned. Applying helper-produced corners and applying the same manually authored corners must produce identical stored records, pixels, revision/Undo and portable results. Existing command and adjustment/filter discovery counts remain unchanged. Documentation/MCP help may explain how callers construct symmetric pairs, but must not invent an extra mode argument.

The current preview remains a draft polygon with unchanged raster pixels until Apply. Label it accordingly; do not imply a live perspective image preview. A highlighted selected edge/partner and X/Y guide can make the coupling clear. Keep native error explanations and the fixed historical-frame clipping notice visible, particularly on arbitrary quads and off-frame coordinates.

## Acceptance and release boundary

1. Pure independent coordinate tests: all eight corner/axis pairings, rectangular and arbitrary skew/rotated baselines, fixed selected-plus-delta/partner-minus-delta arithmetic, six untouched Numbers, signed zero, fractional/subnormal/adjacent values, no-motion identity, fixed arithmetic half/last-bit fixtures, delta-bound rejection and over-limit output flags and output ownership. Strict malformed/getter/prototype/hole/symbol inputs reject without evaluating new input getters.
2. Captured-baseline tests: a long pointer sample sequence has the same final result as one direct evaluation from the original baseline; orthogonal-only and away/back-to-start motion preserve original strings. No repeated increment accumulation, drift, independent clamping or hidden auto-rectification.
3. Native compatibility: use current add/update commands with expected manual corners, including a middle stage followed by affine/resampling. Compare every output byte and stored stage with an independent manual command. Test Undo/redo, portable/restart and source immutability. A crossed/concave, over-limit or unstable candidate still receives the existing native refusal without changing document state.
4. Browser ownership: horizontal and vertical corner/partner movement, exact typed delta, invalid/incomplete/underflow input, pending-delta Clear and switch guards, bounded out-of-range pair, complete pointer overflow cancellation, explicit Revert, pointer cancellation, busy/mode/axis/corner/stage changes, view resize, stale revision and target/capability A→B→A. Held old results/previews must not install after their owner changes.
5. Capability and accessibility: saved read-only inspection, independent add/update/remove availability, protected targets, all six types and historical numeric-only stages. Keyboard corner selection and delta input and Move pair action, readable partner/range errors and 900px layout without overflow. Free-corner regressions must retain their existing behavior.
6. Actual-use visual: narrow the top of a rectangular photo/shape and separately narrow one side; test a saved skewed quad so its unchanged coordinates are evident. The applied raster must be the existing Distort sampler's result. No performance benchmark is required for a four-point helper; existing render tests remain relevant.

Root and independent review accepted the helper/interaction contract before implementation. The production scope is the shared pure helper plus client editor/guide integration and maintained tests; it is not a new renderer feature or a broader transform-system rewrite.


## Implementation evidence

`shared/linked-perspective.mjs` and its declaration expose the three frozen exports above. Validation rejects malformed data with `TypeError` carrying `code: INVALID_ARGUMENT`. The helper has no server/native imports, mutable global state, renderer path or persistent registration.

Owner checks pass **5/5 in 206.89 ms**: four pure tests in `tests/linked-perspective.test.mjs` plus the historical command-equivalence test in `tests/linked-perspective-native.test.mjs`. They pin all eight literal pairings, arbitrary saved coordinates, owned output and unchanged signed zero, zero/half-ULP/subnormal cases, 1001 independent captured-baseline samples, strict no-getter validation and unclamped bounded-invalid candidates. The native comparison retains source filters, their shared mask, a document-space layer mask and later crop/nearest resize, compares every RGBA byte with independently authored manual corners, verifies source bytes, and refuses over-limit/crossed updates without state changes. No production issue was found.

Root's separately owned official SDK workflow passed in 778.16 ms, covering all eight asymmetric pairings, retained Fill/styles, replay, historical affine/resize suffix, Undo/Redo, portable/restart and late invalid transaction rollback. Independent helper/client checks contribute six maintained tests. The final registered regression passed1218/1218 in24.34735075 seconds, adding12 checks over the closed Fill1206 baseline (owner5, SDK1, independent6). Final browser acceptance remains tracked by the UI owner. This four-point helper adds no pixel resources and requires no renderer benchmark.
