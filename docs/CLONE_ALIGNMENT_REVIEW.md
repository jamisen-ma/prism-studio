# Independent review: Aligned clone/heal sampling

Approved contract and independent acceptance review, 2026-09-19. The final [CLONE_ALIGNMENT_DESIGN.md](CLONE_ALIGNMENT_DESIGN.md) preserves the native stroke algorithm, command schema, project format and pixel-buffer budget. Eight maintained checks pass: four native pixel/command fixtures and four tests of the actual client session helper. Browser integration/acceptance remains underway; these checks do not imply its completion. See [CLONE_ALIGNMENT_RESEARCH.md](CLONE_ALIGNMENT_RESEARCH.md).

Adobe documents continuous aligned sampling and restarting from the original sample when alignment is off. Its separate Clone Source panel includes multiple sources, source transforms and an overlay. That supports an Aligned toggle as a useful smaller interaction, without claiming those other controls or Photoshop-equivalent healing. [Adobe Clone Stamp](https://helpx.adobe.com/photoshop/desktop/repair-retouch/heal-clone/retouch-images-with-the-clone-stamp-tool.html), [Adobe Clone Source panel](https://helpx.adobe.com/photoshop/desktop/repair-retouch/heal-clone/clone-source-panel.html).

## Coordinates and native behavior

The existing browser retains one Alt/Option-click anchor A in document pixels. Every new clone/heal stroke currently sends A as its `source`, so it restarts from A. The existing native kernel computes `sourceOffset = source - points[0]`; each destination pixel samples the frozen source at that offset. Nothing in the API requires restarting.

Keep Restart as the initial mode and preserve its current per-stroke payload/pixel behavior. For Aligned, let P0 be the first accepted stroke's first captured destination point and D=A−P0. For a later stroke beginning at Pk, send `source = Pk + D`. Do not accumulate displacement from the previous stroke's last point, replace A with the last crosshair, or recompute D from the last endpoint. The pair of coordinates used to establish D and the first serialized point must be identical, including their fractional parts.

An exact simple discriminator uses A=(2.5,3.5), P0=(10.5,8.5), D=(−8,−5), and a later Pk=(18.5,12.5). Restart sends (2.5,3.5); Aligned sends (10.5,7.5). The first stroke is identical in both modes. Fractional source and destination coordinates remain supported; neither inspector formatting nor crosshair rendering may round the command coordinates.

The sampling image is frozen at the start of **each stroke**, not at Alt-click and not for the whole aligned session. Current, Current & Below, All, adjustment skipping, original-context protection and target guards remain independent. Own earlier repairs can be sampled by the next stroke according to that scope. The existing heal algorithm computes a fresh local mean correction per stroke, even with unchanged D; alignment does not freeze that correction or make healing equivalent to cloning.

These are document coordinates after the target's existing source geometry. A successful native `paint_stroke` materializes the target into the canvas dimensions, clears its transforms and absorbs separate alpha. Those source metadata changes are expected consequences of the accepted stroke and must not reset a valid document-space alignment. Do not use changing target `asset`, retained source width/height, alpha asset or transform-array identity as unconditional session-reset keys.

## Out-of-bounds and crosshair accuracy

Keep existing destination-pointer mapping unchanged. Never clamp a derived aligned source into the image or clear alignment merely because the source center lies outside it. For a canvas axis W≤8192, A/P0/Pk in [0,W) imply −W < Pk+A−P0 < 2W, within the existing public/native source range [−8192,16384]. No schema enlargement is necessary.

Native sampling is premultiplied bilinear interpolation with transparent outside neighbors. A center outside the canvas may still partially contribute a border pixel; an entirely outside patch contributes nothing. A source-center bounds check cannot stand in for the sampler. The inspected kernel gives RGBA (200,100,50,64) for a quarter contribution from an opaque (200,100,50) border, and no change when fully outside. Clamping would incorrectly give opaque paint.

Separate three concepts in state and copy:

- **Anchor:** the explicit Alt/Option-click location A. It is useful while waiting for the first aligned stroke and in Restart mode between strokes.
- **Current sample center:** while a stroke is active, firstStrokeSource + currentDestination − firstDestination. After committed alignment, hovering can show cursor + D. Even Restart moves its sample center during one stroke; it returns to A only for a new stroke.
- **Offset:** committed D in document pixels. It is not a cached patch, a live source layer or a persisted setting.

Show an off-canvas source hint/coordinates rather than drawing a clamped crosshair at the border. Do not pretend an off-canvas center always means zero coverage. When the cursor leaves, hide the moving marker or explicitly return to an anchor indicator; do not leave a marker falsely labeled as the current sample. During an active gesture, unrelated pointer IDs must not move the source marker: the present `move` updates cursor state before its pointer-ID check, so the new derived marker needs an owned-pointer rule. No sampled-image overlay is needed. For later strokes, the marker uses the actual captured `sentSource−firstPoint`, matching the kernel's Number operation order; `(Pk+D)−Pk` can differ from the retained D by an ulp. Never overwrite the committed D with that later recomputation.

## State and acknowledgement constraints

Use a small epoch-owned session containing A, optional committed D, mode, context identity and an optional pending stroke token. Store the first offset tentatively in the captured gesture. Promote it only when the corresponding stroke is acknowledged as the accepted own result in the still-matching session. A pointerdown followed by cancellation must not establish D.

The following is the recommended event contract; it should be pinned in the implementation design rather than inferred from React effects:

| Event | Required behavior |
| --- | --- |
| Alt/Option-click | Replace A and clear D immediately; advance the epoch. No command or history entry. |
| Reset sample | Clear A/D and any active gesture; advance the epoch. |
| Toggle Restart/Aligned | Keep A, clear D, cancel any active gesture and advance the epoch. Aligned waits for the next accepted first stroke. No implicit stroke. |
| First aligned pointerdown | Capture A, P0, tentative D, brush/scope/mode/revision and identity once. Do not commit D. |
| Matching pointercancel, Escape or capture loss before dispatch | Discard that gesture/tentative D. Preserve the earlier anchor and any already committed D when the document context remains valid. No command. |
| Unrelated pointer cancellation/loss | Ignore it; do not alter the real gesture or sample state. |
| Ordinary pointerup | Detach the gesture before releasing capture; preserve the existing reentrancy fix. Submit at most once with frozen source/settings. The following lost-capture event cannot cancel the submitted stroke. |
| Local eligibility refusal before dispatch | Do not establish a new offset or manufacture a source. Keep an otherwise valid existing session; a separate context-invalidating event may clear it. |
| Matching successful own stroke | Preserve A/D, promote a tentative D if needed, and advance the accepted revision exactly to this result. Visually unchanged/protected/no-sample strokes still count as accepted when the native command commits. |
| Definite failure, stale rejection or ambiguous lost response after dispatch | Clear only the still-owned session; require explicit sampling again. No automatic replay, rebase or new request ID. A late failure must not clear a newer anchor or another document's state. |
| Unrelated document revision, Undo or Redo | Reset Aligned anchor/offset; never infer that an external edit was our accepted stroke. Own publication is the explicit exception. |
| Document/backend/target/dimensions, retouch tool, sampling scope or relevant capability changes | Cancel the active gesture and reset Aligned context. Preserve the existing Restart payload semantics; its legacy idle tool-switch anchor behavior need not be broadened into new persistent state. |
| Zoom/scroll/toolbar reflow between strokes | Preserve document-space A/D; recompute screen presentation. |
| View rectangle changes during a gesture | Keep the existing cancellation rule; discard tentative gesture coordinates. Do not combine points measured in different views. |
| Brush size/hardness/opacity changes | Future strokes use new settings; an active stroke keeps its captured brush settings. Changing brush appearance alone need not reset A/D. |
| Create repair layer | Existing success-only target/preset installation remains; choosing the new target clears sample/alignment and requires explicit sampling. |

If Reset/toggle/navigation happens after submission, it changes local ownership; it cannot promise to cancel an already accepted native write. The UI may discard its stale response and subsequently reconcile the document. Avoid messaging that the saved stroke was rolled back.

Own-revision handling needs two phases. The accepted document may reach React before the `run(...).then(...)` callback; a blanket revision effect would erase the pending first offset before success can promote it. Reserve the permitted own transition by pending token and exact predecessor/result revision, then finalize only after same-context installation. Do not exempt every `previous+1` revision: an external command can also produce it. Do not use a broad “busy means ours” rule. A token must survive the expected own update but become invalid after a context epoch changes, including a change away and back to the same IDs.

## Existing integration gaps relevant to this feature

`CanvasTools.tsx` already captures source/brush/sampling/revision at pointerdown and detaches the drag before release, which are useful foundations. It currently clears source on any late null result without checking ownership and has no success-result identity check. Such a callback could erase a newly selected sample after navigation or resampling.

`App.run` currently guards mask, stack, color and repair-creation results, but not `paint_stroke`. A delayed clone/heal response therefore lacks the same pre-install and preview-await context gates. Add a narrow clone/heal result path tied to the captured session identity. Require matching backend/document/target/tool/sampling policy and expected current revision before installing the response; require the still-current epoch and installed result revision before installing its preview or promoting alignment. Keep this local callback out of serialized command arguments. A successful old response must not switch the user back to its document, select a layer, advance a new session or replace a newer preview.

Capabilities should be compared through a stable semantic signature: native backend identity/connection, availability of `paint_stroke`, clone/heal sampling support, the declared sample modes, adjustment-skipping behavior and root-prefix policy. Existing `samplingKey` only describes emitted arguments; loss of a command or a policy can matter even when those arguments happen not to change. Do not reset on unrelated status fields or object allocation. No new native Aligned field or capability is necessary if this remains a browser-only coordinate policy; make that scope explicit.

Selection changes and protected/source metadata changes arriving as unrelated revisions should invalidate the Aligned session. They must not bypass the existing full-document protection footprint or nonempty filter-stack refusal, including disabled masked stacks. A source center describes where to sample; it never authorizes writes.

## Acceptance cases

Use independent source-coordinate expectations, with actual native exports where pixels matter. The maintained tests may reuse the established healing kernel to compare the chosen source map, but must not imply an independent proof of Photoshop healing math.

1. Two separated clone strokes distinguish Restart from Aligned using the exact fixture above. Vary the first stroke's endpoint to prove later source depends on D and the new first destination, not the previous endpoint. Repeat after fractional coordinates, zoom/scroll and multiple acknowledged own revisions.
2. Verify first-stroke equivalence, exact frozen per-stroke sampling and sampled-source updates between strokes; Current, Current & Below and All continue using their declared maps. Heal receives the same derived source point and recomputes its normal per-stroke correction.
3. Before the first accepted stroke, pointercancel/Escape/real capture loss leave D unset; the next stroke establishes it from its own start. After alignment exists, cancellation preserves D. Foreign pointer events and a delayed pointerup after loss cannot dispatch; ordinary pointerup's synchronous loss sends exactly one command.
4. Reset, re-sample, toggle, scope and tool changes pin their explicit state semantics. Forced changes while a request is pending must not let old success/failure callbacks mutate the replacement state. Include a context change away and back to identical document/layer/tool IDs.
5. Own success retains alignment across metadata installation and delayed preview. Stale refusal, work-limit rejection, real save failure and an ambiguous lost response never establish or advance it. Undo/Redo and external revisions require fresh sampling. No automatic retry.
6. Delayed command success after document/backend/layer/tool/capability change installs neither stale document nor preview. Change context again during preview await. A late null response must not clear a newer anchor. Withdrawal of `paint_stroke` must invalidate even when sampling argument JSON stays identical.
7. Negative/right/bottom derived source centers remain unclamped. Compare fully outside and partially interpolated border samples, alpha0/1/128/255 sources, immutable source assets and full-document protected write coverage. A transparent Current repair source must not fall back to lower layers.
8. Inspect compact controls and a real patterned/photo repair at900px. Clearly label anchor versus current sample, Aligned pending/established state and outside-source center. Marker motion follows the matching pointer and actual source offset. Default Restart bytes and neighboring pointer-capture/retouch workflows remain unchanged.

The design-only [probe](../test-results/clone-alignment-review/probe.mjs) and [report](../test-results/clone-alignment-review/report.json) exercise the existing kernel with the independent coordinate fixture and partially/fully outside samples. Restart's second pixel is (14,33,15,255), Aligned's is (70,77,51,255), and the partial-border sample is (200,100,50,64). Inputs remain unchanged. This is evidence that the current API can express the proposal, not acceptance of an alignment implementation.

The approved owner design closes the event table and synchronous own-result handoff before metadata installation. Read-only review found no contract blocker. Preserve the pixel kernel and explicit per-stroke API. The response-ownership and own-revision handshake are required parts of the feature, not optional cleanup.

## Maintained native acceptance

`node --test tests/clone-alignment-audit.test.mjs` passes4/4 against the unchanged native backend. These are independent acceptance fixtures for the client policy's explicit source payloads:

- Two separate source coordinates produce the exact Restart/Aligned golden pixels, regardless of the first stroke's final endpoint. Two accepted strokes remain two revisions/history items; original asset bytes are unchanged and no alignment state is persisted.
- A line of pixel-centered Clone dabs observes the original frozen image even where its later samples cross pixels already painted earlier in that stroke. The next aligned stroke samples the accepted repair, proving the session does not freeze image pixels at sampling time.
- Fractional and outside source centers match a separately implemented bilinear/size-one healing-annulus oracle across alpha0/1/128/255. The second stroke's source map includes the accepted repair. Explicit negative edge samples retain partial alpha64 and fully outside samples remain unchanged.
- A protected upper pixel with alpha1 blocks a second aligned write even under Current & Below sampling, and a later point outside the selection remains unwritten. Accepted no-op strokes still advance native revision; an old revision rejects without changing history. Source and protected metadata/assets remain unchanged.

The tests intentionally do not call the production stroke kernel as their pixel oracle. They reuse native composite rendering only to obtain the explicitly declared Current & Below source map before applying independent dab math. Browser lifecycle coverage stays with the UI owner.

## Maintained session acceptance

The same audit now passes8/8 after loading the actual `client/clone-session.ts` through the installed Vite TypeScript transformer. Four additional checks exercise public session operations rather than a test copy:

- First offsets stay tentative through pointerdown/cancel and promote only after dispatch, a matching response handoff, installed own revision and successful finalization. Restart retains its original anchor, while toggling Aligned requires a new first accepted stroke.
- Responses with wrong revision, document, target, dimensions, backend, tool, capabilities, sampling or availability cannot claim the token. Observing an unrelated successor revision before the owned acknowledgement clears the session. Predecessor props may remain briefly visible before the authorized own metadata is installed.
- Old success, failure and cleanup calls cannot touch a replacement anchor/stroke after eleven reset/context transitions, including changes away and back to identical IDs. A current dispatched failure clears the current session; idle Restart retains its established tool/revision behavior while Aligned resets.
- The marker uses captured API arithmetic during a stroke and freezes at the last captured point while pending. The fixture A=.1, P0=.2, later P=1.3 distinguishes retained offset−.1 from the actual later API subtraction−.10000000000000009. Neither is rounded or clamped, and later strokes do not overwrite the original offset.

No pure-helper defect was found. Integration must still establish actual accepted metadata explicitly rather than assume a React render occurs before a resolved preview Promise. The retouch catch/refresh path must not install stale previews or revive an abandoned epoch; these remain source/browser acceptance items.

Initial implementation source review confirms that App marks dispatch only immediately before the API call, validates exact successor/document/target/dimensions, performs the synchronous handoff before metadata publication, and gates both preview installation and the returned result. CanvasTools explicitly synchronizes an accepted result revision before finalization, covering delayed React props. The retouch catch path bypasses the old unowned inline refresh and relies on ordinary current-document polling; it does not retry or resurrect alignment. Foreign-pointer cursor suppression and ticket-owned overlay cleanup are restricted to clone/heal.

One narrow marker finding is fixed: `ticket.lastPoint` was recorded before the existing1,901-point thinning removed its final even-indexed point. The owner now resets it from the final copied point list at pointerup, preserving legacy payloads while making the pending marker match the serialized endpoint. No remaining source-review blocker is known.

The UI owner subsequently reported final focused8 and adjacent17 browser workflows, the maintained independent8 and build green. Its final fixture starts from a32×24 source with separate alpha and retained canvas/translation; an accepted stroke materializes64×48 working pixels and absorbs alpha while preserving the source asset and session offset. Actual work-limit refusal, all source edges, partial alpha64, stale revision, real save failure, lost accepted response and failed preview all follow the agreed ownership/reset rules. See [CLONE_ALIGNMENT_UI_EVIDENCE.md](CLONE_ALIGNMENT_UI_EVIDENCE.md) and [browser report](../test-results/clone-alignment-browser-report.json). These browser results are owner-reported evidence, not a separate reviewer harness rerun.
