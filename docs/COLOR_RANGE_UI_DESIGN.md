# Color Range selection UI

Status: implementation checkpoint for manual testing; browser acceptance pending, September 19, 2026. Scope ends with Color Range. See [native design](COLOR_RANGE_DESIGN.md), [independent review](COLOR_RANGE_REVIEW.md) and [MCP contract](COLOR_RANGE_MCP_DESIGN.md).

## Controls and meaning

Add a document-scoped Color Range section beside From composite channel in Selections. Begin with an empty sample list, Tolerance32, Falloff32, Invert off and Replace. **Add foreground color** deliberately copies the current foreground value into a visible editable hex/color-picker row. Opening the panel never copies a sample. There is no additional live eyedropper or call to `sample_color`; an existing foreground color is a copied value, not a server-revision measurement. Each row has an explicit Remove action. Up to eight distinct canonical colors are supported; duplicate copies explain which existing sample matches without silently appending or deduplicating. Hex strings, incomplete numeric strings and every other row remain exact local drafts. Invalid colors or duplicate case-insensitive values block Preview/Load. Removal can leave the list empty.

Tolerance and Falloff accept whole finite integers0..255 without clamping or rounding. Scientific numeric drafts are retained; lexical nonzero underflow is invalid. Labels distinguish the full-strength matching tolerance from additional fading distance; their sum may exceed255. Invert is explicit. Combine offers Replace/Add/Subtract/Intersect, with the latter two requiring an existing selection. Preview and Load are separate deliberate actions. Settings never mutate the document until Load, which captures complete canonical colors/T/F/invert/mode and a positive revision.

Always-visible guidance: selection from similar colors in the visible composite; white selects fully and gray partially. Collapsed help describes encoded-RGB byte distance, nearest-of-swatches union, alpha multiplication and inversion last (including transparent pixels), without claiming perceptual or object detection. Preview shows candidate coverage **before** Combine; Load measures full resolution again and supports Undo. Selected layer and active selection do not limit measurement. Save Selection retains the resulting mask, not a live Color Range recipe.

## Capability and resource boundaries

Use `colorRangePolicy:'sampled-rgb-chebyshev-alpha-v1'`, typed bounded `colorRangeLimits` and independent command gates. Preview requires connected Native, that policy, valid limits, `get_color_range_preview` and valid `colorRangePreviewLimits`. It does not require dense authoring or channel policy. Load additionally requires existing dense policy/limits and `load_color_range_selection`; target dimensions must fit dense authoring limits. Strict all-string command arrays fail closed on malformed values. All required numeric limit fields must be finite safe integers within the shipped protocol maximum; honor valid smaller advertised ceilings. Keep out-of-limit drafts readable, with a reason. Preview minimum edge must be at least32 and default/max must be ordered; preserve a withdrawn selected size until the user selects an available size. Compare full-pixel/color-count work for Load and sampled-pixel/color-count work for Preview against the advertised comparison ceiling. Native remains authoritative for graph, memory and mask preparation limits.

Only Add/Subtract/Intersect consume the old selection; omitted mode means Replace. Add the new command to the existing mode-aware dense dependency helper. Existing alpha8/RLE overlay, save/mask/paint/canvas/project consumers and Magic Wand remain unchanged.

## Owned Preview and Load

The preview uses the established ChannelSelection request epoch and decode sequence in a separate compact component. Identity includes document/backend/revision/dimensions, canonical ordered swatches/T/F/invert, maxEdge, applicable policy/limits/command support and busy/review state. A monotonic epoch invalidates reads across away-and-back changes. Every request is explicit; restoration after invalidation never fetches automatically. Combine and Fit/100% are inspection choices and do not invalidate compatible candidate pixels. Abort stale requests, validate all echoed fields, dimensions, PNG envelope and byte ceiling, then await an owned Image.decode and validate natural dimensions before displaying. Late load/error/decode cannot revive old images. No raw mask asset fetch or client-made selection is used.

Extend the existing App-mounted `useChannelSelection` narrowly with a producer-tagged request and submission record. One document map owns both Channel and Color Range pending/unconfirmed loads; either unresolved producer blocks both Load buttons, including after panel teardown. Records retain producer/id/revision for honest notices. Each producer uses its own semantic capability epoch plus the shared document/backend epoch, so unrelated channel capabilities do not invalidate Range and unrelated Range capabilities do not invalidate Channel. Selected layer, panel mounting, current local settings and the command's own busy/revision advancement are not target identity.

Use the existing bounded App document-selection branch, extended to the two exact command/producer pairs: pre-dispatch document/revision/dimensions/support checks, exact +1 response identity, and ownership before and after document-preview publication. A complete submitted copy is frozen. Failed or stale dispatched requests become unconfirmed unless an explicit definite-refusal code proves no change; unknown errors, lost responses and revision conflicts require Review. No replay or receipt machinery is introduced. Review is an explicit fresh `get_document` without expectedRevision; it captures the record ID and a separate review token, validates current document/revision, and guards metadata plus preview publication. Only that record may be cleared. A delayed producer reply/review cannot install over or clear a newer submission. Review remains available from either section and does not depend on the former producer's semantic capability.

## Layout and accessibility

Use existing dark32px fields, compact swatch rows and two-column Tolerance/Falloff controls. Every hex, picker and remove action has a numbered accessible label. Keyboard users can add/correct/remove samples and invoke Preview/Load; errors/statuses are announced. Empty and unsupported states retain useful local inspection. While Load or Review is pending, mutation controls freeze; preview Fit/100% and help remain inspectable. Preview has a descriptive grayscale label and explicit captured canvas/revision text. Detailed guidance starts collapsed. At900px the inspector must not overflow horizontally; primary actions remain reachable without opening help.

## Acceptance

Eight focused browser groups:

1. Empty/default/foreground copy, exact raw hex/numeric drafts, duplicate/limit validation, keyboard editing, explicit positive-revision payload and small literal alpha/inversion/two-rounding goldens.
2. Actual512² photograph and1MP high-frequency full selections/nearest preview, one/eight swatches, adaptive dense fallback and original asset retention.
3. All combination modes, continuous geometric-left coverage, explicit empty selection and missing-selection refusal.
4. Save Selection, layer/adjustment/source-mask/Bake or representative consumer paths, paint/canvas/Undo and portable reopen retaining exact coverage.
5. Independent preview/load/dense/channel gates, malformed/withdrawn/lower limits and raw draft retention.
6. Delayed response/decode, settings/capability away-and-back and busy interruption without automatic reads; mode/view changes preserve a valid candidate.
7. Shared Channel/Range pending and unknown-result state across panel/document switches, selected-layer independence, explicit guarded Review, stale response and held post-mutation preview.
8. Actual-photo exports,900/1440px keyboard/focus/help inspection, no overflow/browser errors/provider/key access, build and targeted adjacent regressions.

Preserve completed Channel acceptance with its eight browser groups, then relevant saved-selection/layer-selection/mask-inspection/morphology/mask-position/filter-mask/paint-canvas/pointer/project flows. Record actual totals after running; do not label planned checks as passed.

## Manual-testing stopping point

The user requested a clean stopping point before automated browser acceptance. Client controls, capability gates and shared Channel/Color Range Load ownership are implemented. The initial TypeScript/Vite build passed before final cleanup. Final cleanup fixes the two identified source findings: capability keys now serialize only descriptor-safe numeric limit values, and Channel submission ownership ignores unrelated Color Range commands. Root owns the final build after files settle.

No Color Range browser workflow or adjacent browser regression has run, and no new screenshot/layout acceptance is claimed. The incomplete harness is preserved only as non-runnable notes at [test-results/color-range-browser.incomplete.txt](../test-results/color-range-browser.incomplete.txt); its runnable test file and package alias were removed. No owned test process remains active. The app is left running for manual testing. Independent source review of the two fixes is requested; this checkpoint does not claim complete Color Range acceptance.
