# Independent retouch sampling contract review

Status: independent native audit passes **6/6**, September 19, 2026. This reviews the [backend design](RETOUCH_SAMPLING_DESIGN.md) and its implementation. Browser acceptance remains separately owned. No production files were changed; no live projects, provider calls or credentials were used.

## Sampling and write protection are separate

The legacy default remains `all` with adjustment skipping off. Existing clone/heal source sampling is frozen before the stroke, and ordinary target, selection, filter-stack and protection guards remain unchanged.

`current` samples the transformed working RGBA and separate source alpha of the target. It excludes the additional mask, density, opacity, styles, surrounding layers, clipping contribution and generated display clipping. This is not the layer's visible preview. A blank repair layer samples transparency; there is no implicit fallback. The current target must still satisfy ordinary writable-raster guards, including no nonempty editable filter stack. Adjustment skipping with this raw mode must reject rather than pretend to affect its source.

`current-and-below` requires an unlinked root raster target: neither a clipping base nor member and no parent group. The sampling renderer should traverse the original graph's root nodes through that target inclusively. Complete earlier groups and clipping chains retain their existing blending, masks, density, filters, styles and protection context. The cutoff belongs to root traversal, before visibility/opacity skipping: a hidden or opacity-zero target still excludes every upper root. Slicing the flat layer array or filtering away adjustment records would risk invalid parent/chain structure.

`ignoreAdjustments` skips only standalone adjustment nodes during sample rendering, including those inside lower groups. It does not disable source filter stacks, group blending or change the visible document. Upper protected content may be excluded from the sampled image but remains part of the full-document write-protection footprint. Sampling options must never be passed into the write-footprint calculation.

## Frozen input and resources

Source inspection of `applyStroke` confirms that it allocates its own output and reads only the original target and frozen sample. A local independent clone/heal probe compared `composite === pixels` with a detached composite copy on patterned alpha0/1/128/255 inputs; both outputs matched and the input was unchanged. Current-layer sampling can therefore reuse the target buffer without an extra image copy. Healing's source/destination ring correction must use that same declared frozen sample scope.

The coordinator explicitly retained the existing brush and renderer limits instead of claiming a new total-operation 256 MiB limit. The new modes must not increase the legacy all-layers allocation pattern. At the stroke-kernel phase, distinct target/sample/output images retain up to `12N` bytes, the dab coverage plane up to `2N`, and the protected footprint `N`, before selection callback storage. Current-layer aliasing removes one `4N` image. A feathered bitmap selection can add `5N` bytes. Source decoding, geometry, protection rendering, group/filter scratch and PNG encoding have additional transient allocations. These counts are not a complete RSS estimate or a new enforced total bound.

The existing 24 MP canvas, 2,000 input points, 100,000 planned dabs and 60-million weighted pixel-visit limits remain meaningful. The dab planner rejects before allocating its output/coverage plane, but the current native caller renders inputs before calling the planner; do not describe that as a pre-render work-limit rejection unless the implementation actually moves validation/planning earlier. Existing brush loops and some renderer stages remain synchronous.

## Repair-layer creation and atomic publication

`create_repair_layer({sourceLayerId,newLayerId?,name?})` is an explicit insertion operation, not a live source dependency. Validate an existing unlinked root raster source, caller UUID uniqueness, name and layer capacity before creating bytes. Insert an ordinary visible, normal, unprotected transparent paint layer immediately above that source and below the next root subtree. Do not inherit its filters, mask, source image, styles, generated provenance or protection. Hidden, transformed, filtered or protected source rasters remain valid creation anchors because creation does not alter them.

An optional caller UUID makes a same-transaction stroke unambiguous. A standalone response should identify the created layer explicitly; transaction callers already know their provided UUID. Normal revision and request-ID handling remains authoritative: an existing UUID must reject instead of silently reusing an unrelated layer.

The approved asset rollback scope covers the entire mutation-to-commit interval for standalone creation and every transaction containing it. A helper-local collector is insufficient: outer commit can fail, or a later transaction stroke can publish another fresh asset before a subsequent operation rejects. Record only blobs newly published by the no-overwrite `fs.link`; an `EEXIST` blob is never owned by rollback. On failure, delete owned fresh blobs only and preserve prior assets, projects, history and cache. Clear the scope reliably after success or failure. A pre-existing shared transparent PNG must survive a rejected repair transaction.

The backend uses a per-native-instance `AsyncLocalStorage` scope, preserving explicit import collectors as well. This isolates nested awaited writes from unrelated direct helper calls. Independent tests verify the full scope through a later painted asset and real outer persistence failure. The contract does not change ordinary asset cleanup outside create-containing operations. If an extension throws after publishing a new project, the implementation deliberately retains its referenced assets rather than deleting them; ordinary persistence failures occur before publication.

## Verified independent fixtures

Run `node --test tests/retouch-sampling-audit.test.mjs`: **6 passed, 0 failed**. The tests use actual native publication and decoded PNG assets. The established brush kernel is reused as an oracle for sample-routing comparisons; this does not independently prove Photoshop-equivalent healing. A constant-color filtered-source fixture also checks explicit expected RGB. A separately constructed complete lower tree checks the new root-prefix path without calling its cutoff/adjustment-skip options.

- Default versus explicit All Layers matches for clone and heal; Current uses frozen working/source alpha despite hidden target, hidden isolated ancestor, opacity, masks/density, outline and glow. No composite render occurs. Original assets remain byte-identical.
- Hidden and zero-opacity target roots stop sampling above their own position. Complete lower nested groups and clipping chains retain their pixels; skipped nested adjustments are the only removed source operation.
- Brightness-filtered source pixels remain filtered while adjustment nodes are ignored. Upper protected source alpha of one and its outside outline prevent writes even though those layers are outside the sample prefix.
- Explicit-ID creation plus stroke publishes one revision, inserts below the next group subtree, retains an independent original blank PNG and has no inherited source settings. Undo, redo, reopen and portable transfer preserve graph and repaired bytes.
- Later transaction failure and real `ENOTDIR` during outer persistence preserve existing projects, history/cache and shared assets while removing new repair/stroke blobs. A subsequent successful edit proves the scope resets.
- A suspended transaction permits an unrelated direct asset publication; rollback removes the repair assets and preserves the unrelated bytes.

The native owner's complementary tests cover strict argument/target rejection before source work, explicit collector coexistence, exact Current buffer identity and transformed source geometry. This review also inspected those call paths without adding duplicate tests.

## Acceptance scope retained in the contract

- Legacy all/false output byte identity for clone and heal; current aliases detached sampling exactly, including transparent RGB and alpha1 fringes.
- Hidden/opacity-zero root cutoff; lower isolated/pass-through groups and complete clipping chains; upper ordinary/adjustment/generated/protected nodes excluded only from sampling as specified.
- Adjustment skipping inside groups while editable source filters remain active; raw current mode ignores display settings and rejects irrelevant skipping.
- Full-document protection blocks writes into upper protected subjects, outlines and density-expanded masks even when the sample cutoff excludes them.
- Repair insertion below upper artwork, explicit UUID collision before writes, immutable source bytes, same-transaction repair plus stroke, undo/reopen/portable preservation and metadata reset.
- Later-operation and persistence failures roll back every owned fresh blob; pre-existing shared blobs survive; subsequent valid transactions still work after scope cleanup.
- Unsupported targets and invalid sampling combinations reject before source rendering or publication where the documented preflight promises that ordering.

The UI proposal's separate sampling settings, captured mode/source identity and cancellation on scope/reset/layout changes are appropriate. In particular, the new toolbar can move the artboard; clone/heal must not combine points measured before and after that move. Source markers denote document-coordinate anchors, not cached original-image pixels.

Read-only review of `RetouchTools.tsx`, `CanvasTools.tsx` and `App.tsx` found sampling fields gated to clone/heal capabilities, synchronous source clearing on scope changes, captured sampling options and revision, artboard-rectangle guards, and same-context checks before selecting the successful repair or changing its preset. The browser owner was asked to exercise toolbar reflow as well as zoom/scroll. Its results are not implied by the six native tests above.
