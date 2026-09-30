# Independent typography UI integration review

Verified September 19, 2026. Source review covers `client/TextTools.tsx`, its App integration and the captured-command context. The focused independent [browser audit](../tests/text-spacing-ui-audit-browser.mjs) passed two creation-lifecycle workflows. The UI owner's separate [browser suite](../tests/text-spacing-browser.mjs) passed four workflows and its build passed. Native arithmetic/layout evidence remains in [TEXT_SPACING_AUDIT.md](TEXT_SPACING_AUDIT.md); this pass did not rerun or replace those tests.

## Confirmed integration behavior

The text inspector mounts fresh draft state for backend, document, revision, layer and spacing-capability identity. Creation drafts also reset when the document, revision or selected target changes. Fields initialize synchronously rather than waiting for an effect that could briefly expose another layer's draft. Submissions carry the captured document, target and revision through the shared command guard.

Tracking and leading capability checks are independent and include the declared units. Unsupported controls are absent and their arguments are omitted, preserving existing stored values. Auto submits the explicit `leading:null` reset; zero tracking submits zero so the native canonicalizer removes the prior key. Explicit leading remains unchanged when font size changes. Auto-to-explicit initialization formats the computed default without rounding already stored or typed explicit values.

Source-coordinate bounds now use the text layer's original dimensions, not the post-crop document dimensions, and exclude the invalid coordinate equal to the source width/height. The inspector explains these units. Font size and explicit leading allow fractional values; tracking requires a bounded integer. Protected text fields and submissions are disabled. Invalid drafts do not dispatch a command.

## Independent adversarial browser evidence

1. An open creation form on document A contains unsaved text, tracking and explicit leading. Switching its document through the real workspace selector resets all three drafts, updates the bounds and sends no edit to either document. An explicit subsequent submission creates one layer only in document B, with B's captured revision. A remains byte-equivalent at the document level.
2. An `add_text` request is paused before reaching the companion. An external edit advances the document revision; releasing the request rejects it without a new layer or duplicate. Navigation and fields are disabled while the request is pending. The UI refreshes the target, discards the stale draft and creates exactly one layer only after an explicit fresh-revision retry. The other document remains unchanged.

The report is `test-results/text-spacing-ui-audit-report.json`: two workflows passed, zero browser errors, zero key reads and zero provider calls. The owner's four workflows separately verify ordinary create/edit/reset pixels, target/document/undo resets, protected state, cropped source coordinates, rejected stale updates, reopening, independent capability absence and 900 px layout. The reference SVG shares the font renderer and is not an independent shaping implementation.

No new production correctness defect remained from this UI review. No production files were edited by this pass. The reviewed source-coordinate correction and Auto initializer presentation were implemented by the UI owner.

## Coordination and next integration boundaries

At handoff, root owns the separate title demonstration and consolidated public documentation. The UI agent owns typography client code and browser checks. Native typography ownership was released after a combined 42-test pass. The feature-review agent owns only `NEXT_FEATURE_REVIEW.md`; this reviewer owns this document and its separate browser fixture. No overlapping production edit ownership was found.

The feature-review pass reported older public descriptions of image-transfer bounds, filter counts, group modes and PSD support. Root is reconciling those documents; this UI review does not independently claim those documentation edits are complete. Native text support also does not make editable PSD text supported or establish full Photoshop typography parity.

The next clone/heal sampling proposal is still a design workstream. It must distinguish its sampling context from its write protection, account for stroke buffers in addition to group/filter scratch, and settle repair-layer asset rollback before production. In particular, the existing stroke kernel retains target, sampled image, fresh output and a bounded two-byte-per-pixel dab-coverage plane; a new memory claim cannot count only the renderer's existing scratch limit. Root and the backend owner hold that separate scope.
