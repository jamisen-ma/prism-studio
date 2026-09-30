# Aligned retouch sampling: next feature candidate

Research only, 2026-09-19. No implementation or acceptance claim. Complete filter-mask integration first.

Adobe's desktop [Clone Stamp guide](https://helpx.adobe.com/photoshop/desktop/repair-retouch/heal-clone/retouch-images-with-the-clone-stamp-tool.html) documents Aligned sampling across strokes and restarting from the original sample when alignment is off. Its [Clone Source panel](https://helpx.adobe.com/photoshop/desktop/repair-retouch/heal-clone/clone-source-panel.html) additionally covers multiple sample sources, transforms and an overlay. Those broader controls are separate work; an alignment toggle alone would not implement the whole panel.

Current Prism native clone/heal commands already accept an explicit source point for each stroke and freeze the sampled image during that stroke. The browser's `CanvasTools` saves one Alt/Option-click point and sends the same point at each new stroke, which gives restart sampling. This creates a bounded opportunity to add an explicit Aligned mode without changing the pixel algorithm or persisting new image metadata.

Candidate behavior: keep a source anchor and, when alignment is established, a source-minus-destination offset. Later strokes compute their source point from the new first destination point plus that offset. Preserve the old restart behavior when alignment is off. Never clamp the derived source back into the canvas; existing out-of-bounds sample behavior must remain exact. The inspector and source crosshair should distinguish an origin anchor from the current sampling location.

Before implementation, define when alignment is established and reset: new sampling click, toggle, document/backend/layer changes, source-frame resize, pointer cancellation, failed/stale writes, undo and tool changes. A captured in-flight stroke must retain its own settings and source even if the user changes a checkbox. No automatic new source point or replay should follow a refusal.

MCP already expresses aligned strokes by supplying their corresponding per-stroke source points. Any new UI session state must be described honestly; it is not a persisted native recipe or shared document setting unless separately implemented. Existing Current/Current & below/All and adjustment-exclusion contracts remain independent.

Acceptance should compare two separated strokes against independently predicted source coordinates, distinguish restart versus aligned output, test re-sampling/toggle/cancel/navigation/revision races, preserve protected writes and source assets, and inspect a real photo plus the compact controls. Cross-document sources, multiple source slots, clone transforms, sample overlays and Adobe healing equivalence remain outside this candidate slice.
