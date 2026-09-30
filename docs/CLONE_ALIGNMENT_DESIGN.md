# Aligned Clone and Heal sampling

Design reviewed against the current native kernel and browser lifecycle, 2026-09-19. **Approved for client implementation; no production changes were made by this design task.** Existing command and pixel behavior can express this feature; implementation is a bounded client session with guarded response ownership. See [research](CLONE_ALIGNMENT_RESEARCH.md) and [independent review](CLONE_ALIGNMENT_REVIEW.md).

## Scope and compatibility

Add an **Aligned** checkbox beside the existing Clone/Heal sampling controls. It starts unchecked, preserving today's Restart payload and pixels. The choice is a browser-session preference shared by Clone and Heal; it is not stored in a project, local storage, history, recipe, export or native capability. Reloading starts unchecked. Switching context clears the sample as described below but can retain this checkbox preference.

Aligned retains a source-minus-destination offset across accepted strokes. Restart begins every stroke at the original Alt/Option-click anchor. Both modes sample a fresh frozen image at the start of each stroke; neither caches pixels at sampling time or freezes an entire session. Current, Current & Below, All and Ignore adjustment layers retain their existing definitions. Heal continues its existing per-stroke local mean-color correction, not Photoshop-equivalent healing.

Adobe documents the Aligned/restarting distinction in its [Clone Stamp guide](https://helpx.adobe.com/photoshop/desktop/repair-retouch/heal-clone/retouch-images-with-the-clone-stamp-tool.html). Its separate [Clone Source panel](https://helpx.adobe.com/photoshop/desktop/repair-retouch/heal-clone/clone-source-panel.html) includes broader controls. This slice does not add multiple sources, cross-document sources, rotation/scale/flip, a sampled-pixel overlay, flow or new blending modes.

The control is native-only and requires a connected native backend advertising `paint_stroke`, with Clone or Heal selected. Existing source-point support predates the sampling-scope capabilities: absence of newer scope fields must not hide alignment on an otherwise supported native tool. No new command, `aligned` argument, server state, source-coordinate field, capability marker or MCP schema is needed. MCP callers already express the same behavior with explicit `source` on each `paint_stroke`.

## Coordinates and exact payload

All quantities are document pixels in the existing canvas pointer coordinate system. Do not substitute source-image coordinates, transformed layer bounds, CSS pixels or rounded inspector values.

Let A be the sampled anchor. Let P0 be the first serialized point of the first successfully accepted aligned stroke. Retain Δ=A−P0, component by component. For a later stroke beginning at Pk, send `source=Pk+Δ`. For Restart, or an aligned session whose offset is not yet established, send A. The first stroke is therefore identical in both modes. Only a matching accepted first stroke commits its tentative Δ.

The kernel computes `sourceOffset=source−points[0]`, then samples destination pixel `(x,y)` at `(x+sourceOffset.x,y+sourceOffset.y)` from its frozen source. Brush points and source are continuous document coordinates; this existing pixel-index sampler already accounts for the half-pixel relation. Do not add or subtract another half pixel in the UI.

Retain the original Δ until reset. Do not integrate pointer deltas, use the last stroke endpoint, replace A with a moving crosshair, or recompute Δ from later derived source points. Use ordinary existing JavaScript Number addition/subtraction, retaining fractional coordinates. `(Pk+Δ)−Pk` can differ from Δ by an ulp for arbitrary values; this is the unchanged stateless API's arithmetic, not a reason to introduce quantization or a new backend offset. During a stroke, derive its moving marker from the actual captured `source−points[0]`, matching exactly the offset the kernel will use. UI coordinate formatting is display-only.

For example A=(2.5,3.5), P0=(10.5,8.5), Δ=(−8,−5). At P1=(18.5,12.5), Restart sends (2.5,3.5), Aligned sends (10.5,7.5). In the independent patterned fixture, the second fully covered pixel is respectively RGBA (14,33,15,255) and (70,77,51,255).

Never clamp the derived source to the canvas. For an axis W≤8192, A/P0/Pk∈[0,W) imply −W<source<2W, inside the existing public/native range [−8192,16384]. Current pointer clamping can remain unchanged. Native premultiplied bilinear sampling treats outside neighbors as transparent: an outside center can still partially sample an edge. A source at (−.25,.5) painting at (1.5,.5) over a transparent target can yield border RGB (200,100,50) with alpha64. Clamping it would change the result. Fully outside sampling is a normal possibly empty stroke, not an alignment failure.

## Session and gesture ownership

Keep a small synchronous ref-owned session, with React state only for presentation:

```
mode: restart | aligned
epoch: monotonic local counter
anchor: Point | null
offset: Point | null
context: backend/document ID/target ID/canvas width/height/tool/capability key
acceptedRevision: number
pending: null | {
  token, epoch, predecessorRevision, acceptedOwnRevision?,
  capturedContext, mode, anchor, source, firstPoint,
  tentativeOffset?, brush, samplingArgs, points
}
```

The pending token is local identity, never a command argument or server receipt. The active drag similarly captures its epoch and source/settings at pointerdown. Only one drag or dispatched retouch stroke can own the session at a time, independently of asynchronous React `busy` updates. Do not share mutable point/brush objects with live controls; copy the final point list at dispatch.

The capability key contains semantic availability relevant to this tool: connected/native status, `paint_stroke` presence, effective source mode/ignore settings and the capabilities that admit those settings. A refreshed object with identical values does not reset anything. Withdrawal of `paint_stroke` must invalidate even when `retouchArgs(...)` remains byte-for-byte the same. Do not use the entire status response or unrelated filter/mask capability changes as reset keys.

Changing away and back to the same document/layer/tool still advances the epoch. A late completion must match both identities and the captured epoch, not IDs alone. Event handlers update epoch refs synchronously; result predicates additionally compare current live props so they do not depend on a delayed effect having run.

### Event contract

| Event | Sample/session behavior |
| --- | --- |
| Alt/Option-click | Replace A, clear Δ, cancel any undelivered drag and advance epoch. No command/history entry. |
| Reset source | Clear A/Δ, cancel undelivered drag and advance epoch. |
| Toggle Aligned | Retain A, clear Δ, cancel undelivered drag, advance epoch. Checking waits for a newly accepted stroke; unchecking resumes from A. |
| First aligned pointerdown | Capture tentative A−firstPoint; keep committed Δ unset. |
| Matching pointercancel, Escape or real lost capture before submission | Discard the drag and its tentative offset; retain previously valid A/Δ. No request. |
| Foreign pointer move/up/cancel/lost capture | Ignore for active stroke and source cursor; do not overwrite the owned cursor. |
| Normal pointerup | Detach the drag before releasing pointer capture, then dispatch once. Synchronous lost capture from deliberate release does not cancel it. |
| Local eligibility refusal before submission | Keep an otherwise valid A/Δ, establish nothing. Context invalidation separately clears it. |
| Accepted matching own stroke | Keep A/Δ, promote first tentative Δ if present, advance accepted revision. A committed visually empty stroke still establishes alignment. |
| Matching dispatched failure, stale refusal, failed save/preview or ambiguous lost response | Clear only the still-owned sample/session. No automatic retry, rebase or inferred success. Require sampling again. |
| New document/backend/target/canvas dimensions | Cancel undelivered gesture and clear A/Δ in both modes, as current Restart does. |
| Sample mode/Ignore adjustments changes | Clear A/Δ in both modes, as current Restart does. |
| Relevant capability loss/change or disconnect | Invalidate in-flight ownership and clear Aligned A/Δ. No stale sample resumes on reconnect. Restart also must discard an unsupported pending stroke; idle anchor retention may follow its existing behavior. |
| Retouch tool change or leaving Clone/Heal | Cancel gesture/invalidate pending epoch. Aligned clears A/Δ; Restart keeps its existing idle anchor behavior. Returning to Aligned requires a fresh sample. |
| Unrelated revision, Undo, Redo, selection/graph edit | Aligned clears A/Δ. Explicit accepted-own transition is the only exception. Restart preserves current idle anchor behavior; an invalid active/pending gesture cannot survive. |
| Brush size/hardness/opacity/color changes | Future strokes use new values; an existing gesture keeps its captured brush. Does not reset A/Δ. |
| Zoom, scroll or layout changes between strokes | Preserve document-space A/Δ; recompute screen position. |
| Canvas view rectangle changes during a drag | Existing cancellation rule remains. Discard that drag/tentative offset; retain the prior valid A/Δ. No mixed-view point list. |
| Successful Create repair layer | Existing success-only target/preset update remains; new target clears A/Δ and requires explicit sampling. |

Controls are disabled while a request is pending as today, but correctness cannot depend on disabled DOM controls: navigation, capabilities and asynchronous results still change. Reset/toggle/navigation after submission abandons local ownership; it cannot cancel or roll back a request already accepted by the companion. Discard its stale response and reconcile normally. Do not announce that such a stroke was undone.

Keep the default Restart's legacy idle resets and sent source values. The new ownership guards apply to clone/heal in either mode, since a late callback corrupting a newer Restart source is also unsafe. Do not broaden these changes to unrelated brushes or gestures.

## Own revision handoff and result installation

`App.updateDocument` installs the returned graph synchronously before awaiting `get_preview`; React can observe that revision before the current `run(...).then(...)` executes. A naive revision-reset effect therefore destroys a valid first offset. A generic exception for `revision+1`, any paint command, or `busy=true` is unsafe because unrelated edits can have the same properties.

Add a narrow local retouch acceptance hook to `GestureContext` (or an equivalent explicit internal callback), never serialized. The required sequence is:

1. Before dispatch, `isCurrent` checks token/epoch, current context and captured predecessor revision. The immutable stroke payload is already derived from its captured first point and source.
2. After command success but **before installing its document**, `App.run` gates clone/heal results on the current backend/document/target, predecessor revision, live epoch/tool/capability predicate, result identity/target existence and unchanged canvas dimensions. The native single-stroke result revision must be the expected successor. An external matching number alone is never sufficient; the owned command response is required.
3. Invoke the synchronous handoff with that exact returned document/revision. It records `pending.acceptedOwnRevision`, allowing the forthcoming own props transition; it does not yet promote the tentative Δ or allow another stroke. If it cannot claim the token, do not install the result.
4. Install metadata via `updateDocument`, supplying a retouch-specific `acceptPreview` predicate. During preview await, only the exact authorized own revision/context/token is valid. Any unrelated revision or navigation invalidates the epoch. Prevent a delayed preview from installing after a context change away and back.
5. Recheck after preview await before returning an accepted result. Only that same pending owner finalizes Δ and acceptedRevision. A rejected/null result clears only its still-current epoch; an old `finally` may clear only its own stroke overlay/pending token.

This callback must survive the authorized own revision without permitting arbitrary revisions. An implementation can expose a small local `acceptDocument(document): boolean` plus `isCurrent()`; it should not add a server-aligned setting or rely on Promise callback timing. Match the actual `updateDocument` ordering rather than copying a guard that assumes metadata installation happens after preview.

If preview loading fails after a committed stroke, native history remains committed, alignment is cleared conservatively and the existing error/refresh flow reconciles the graph. Do not replay the stroke. Likewise, rejected late responses may represent committed server work; routine refresh reveals it without reviving the abandoned offset.

Own `paint_stroke` changes target working asset, width/height, transforms and separate alpha: native renders the target into document dimensions, clears transforms and absorbs alpha. These expected changes must not invalidate document-space Δ. Keep `sourceAsset`/working image identities out of unconditional reset keys; unrelated graph revisions already invalidate Aligned sessions.

## Truthful source indicator and controls

Keep the original anchor separate from the current sample center. Show the original anchor while waiting for the first aligned stroke and as Restart's idle source. During a drag, show `currentDestination + (capturedSource−capturedFirstPoint)` in both modes; Restart also moves within one stroke. With committed Aligned Δ and an idle hover, show `cursor+Δ`. When the cursor leaves, hide the moving source marker rather than presenting its old location as current.

Use one moving crosshair, not an image overlay. While a stroke request is pending, freeze its overlay/sample center at its last serialized destination point, or hide that marker; do not derive a new pending sample from unrelated hover motion. The inspector can display `Anchor: x, y` and, when available, `Sample: x, y`; label formatted values as display coordinates and retain full Number precision internally. In Aligned mode show a concise pending-first-stroke or established-offset status. An outside center gets an explicit outside-canvas note and its real coordinates; clipping the SVG is fine, clamping its coordinates is not. Say that outside samples may be transparent, not that every outside center has no pixels.

Suggested help: unchecked, “Each stroke starts from the sampled anchor.” Checked before alignment, “The first completed stroke sets the offset.” Checked after alignment, “Keep the sample offset across strokes. Alt/Option-click to sample again.” Existing scope/protection/Heal explanations remain. This is a compact addition to RetouchOptions, with responsive inspection at 900px and keyboard-accessible labeled checkbox.

## Native invariants, cost and persistence

No native image/kernel/command edits are required. Existing selection and full-document protected-footprint write coverage, protected target/filter-stack guards, sampler bounds, alpha-weighted bilinear interpolation, per-stroke maximum brush coverage, dabs/points/work limits, frozen-map rules, source assets, failure persistence and one-undo-per-stroke behavior remain authoritative. Retained geometry is rendered before sampling just as today. New state contains a few scalar points/IDs and one pending reference; it adds no image plane, file, provider request, project metadata or resource admission limit.

Every successful stroke is still its own revision/history item; Aligned does not group strokes or create a transaction. Reload, portable reopen, Undo/Redo and an ambiguous retry do not recover the local offset. Existing explicit per-stroke MCP coordinates can reproduce the same edits; a project stores their resulting pixels, not this UI session.

## Evidence and implementation acceptance

Design-only owner probe: `node test-results/clone-alignment-evaluation/probe.mjs`. Its [report](../test-results/clone-alignment-evaluation/report.json) records 320 comparisons against an independent bilinear/size1-Heal annulus oracle across Restart/Aligned, fractional source coordinates, alpha0/1/128/255 and outside samples. Six actual native two-stroke sequences (Clone/Heal × Current/Current & Below/All) start with transformed targets, retain correct explicit source mapping through native materialization and preserve original asset bytes. This confirms API feasibility, not an implemented client state machine or Adobe healing parity.

The independent [probe report](../test-results/clone-alignment-review/report.json) supplies the integer-offset discriminator and partial-edge alpha64 example. Neither probe changes production files or dependencies.

Implementation acceptance should include:

1. Browser-observed payloads and actual native pixels for two separated strokes, different first endpoints, repeated own revisions, fractional coordinates and all sampling scopes. Default Restart first/second pixels remain legacy-exact. Heal must receive the same derived map but recompute its normal correction.
2. Before/after-established cancellation, foreign pointers, release-triggered lost capture, single dispatch, Reset/Alt-click/toggle, independent brush capture and pan/zoom between versus during strokes.
3. Delayed command and delayed preview across every context change, including away-and-back to identical IDs. Old success/null/finally must not install stale graphs/previews or erase newer anchors/overlays. `paint_stroke` capability withdrawal invalidates even if sampling JSON is unchanged.
4. Explicit own-revision handoff before render/effects, initially transformed/cutout target materialization, and unrelated same-size/successor revisions. Undo/Redo, changed selection, stale rejection, work refusal, real save failure and lost response must require resampling without replay.
5. Unclamped left/right/top/bottom sources, partial versus fully outside samples, frozen sampling during one stroke and fresh source content next stroke, source-alpha classes, protected coverage and source bytes. Current sampling on an empty repair layer stays empty.
6. Compact controls and actual photo/pattern repairs, clear anchor/current-source status and owned moving crosshair. Run adjacent retouch/canvas pointer suites and build; no full backend sweep is required solely for client-only changes unless production scope expands.

Approved implementation ownership: client/UI owner for a small pure session helper, CanvasTools, RetouchOptions, overlay and narrow GestureContext/App acceptance hook plus browser tests after filter-mask browser closure. Parent owns any public usage guide. Server/shared/MCP stay unchanged. Independent reviewer audits response ownership and native pixel fixtures. This document records the accepted contract; it does not claim implementation or browser acceptance.
