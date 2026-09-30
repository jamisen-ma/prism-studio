# Aligned Clone/Heal client evidence

Implemented against [the approved coordinate and lifecycle contract](CLONE_ALIGNMENT_DESIGN.md). The independent [review](CLONE_ALIGNMENT_REVIEW.md) covers the pure session and native coordinate fixtures. No native command, schema, pixel kernel, capability or project format changed.

`client/clone-session.ts` owns the anchor, original offset, context epoch and one captured stroke. `CanvasTools` keeps settings and points captured at pointerdown. `App.run` authorizes an exact successor response before publishing its metadata, then guards preview and completion separately. The pending marker uses the actual sent source minus first point and freezes at the last **serialized** destination after point thinning. A failed or abandoned response cannot clear a newer sample. Local cancellation does not establish an offset.

The default remains Restart. Aligned is a browser-session checkbox; reload, Undo/Redo and unrelated edits require a new sample. Sampling scope and sampled healing remain the existing native operations. A source beyond the canvas is sent unchanged. Numeric source labels are display formatting only.

The focused [browser report](../test-results/clone-alignment-browser-report.json) covers eight workflows:

1. Exact Restart versus Aligned native pixels, distinct first endpoints and repeated accepted revisions.
2. Fractional Clone/Heal coordinates across all three source scopes, native output and browser-only persistence. A transformed32×24 source with separate alpha becomes64×48 working pixels with cleared transforms/absorbed alpha after the first owned stroke; its original document-space offset survives exactly.
3. Cancellation, foreign pointers, deliberate capture release, captured brush settings, zoom and layout changes.
4. Reset/toggle, Undo/Redo, selection and tool changes, legacy sampling capabilities and withdrawal of the paint command.
5. Delayed command results after tool, document and layer changes, including returning to identical IDs.
6. Accepted own metadata during delayed preview, frozen pending markers and capability withdrawal before preview installation.
7. Stale revision, bounded-work refusal, an actual atomic-save failure, lost accepted response and failed preview; no automatic replay.
8. Unclamped canvas edges, partial outside alpha, real photographic strokes and readable 900px controls.

Seventeen adjacent browser workflows cover retouch sampling5, pointer capture4, canvas4 and gestures4. The maintained independent helper/native audit passes8 tests. The production build passes. The old retouch stale-retry browser case now waits for refreshed metadata before explicit resampling: errors use ordinary current-document polling rather than the older unowned asynchronous catch refresh.

The source photograph is the maintained [NASA/scikit-image fixture](../tests/fixtures/tonal-color/README.md), used byte-for-byte with its pinned SHA-256. Actual output: [original](../test-results/clone-alignment-photo-original.png), [repaired](../test-results/clone-alignment-photo-repaired.png). Layout evidence: [900px](../test-results/clone-alignment-900.png), [1440px](../test-results/clone-alignment-1440.png). These are local native edits; no key reads or provider calls occur. The photograph verifies the interface and actual output, while synthetic fixtures and the independent audit establish coordinate/pixel expectations. The sampled Heal comparisons do not claim Photoshop healing parity.
