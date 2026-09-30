# Explicit document resize methods

Implemented and browser-verified, 2026-09-19, against the approved [native resize design](RESIZE_RESAMPLING_DESIGN.md), [independent resampler review](RESIZE_RESAMPLER_REVIEW.md), and the current `ResizePanel`/mask-review/runner implementation. Root owns schemas, MCP, status and public guidance; the native owner owns resampling. This proposal adds a bounded method selector and completes the existing document-wide resize lifecycle without changing canvas-bounds semantics, masks, image algorithms or recipe execution.

## Scale image controls

In **Scale image** mode, place a labeled **Image resampling** select below Width/Height and **Match original aspect ratio**, before the positioned-mask review section. Its options are the supported subset of:

| Wire value | Label |
| --- | --- |
| `nearest` | Nearest neighbor |
| `cubic` | Cubic |
| `mitchell` | Mitchell |
| `lanczos3` | Lanczos3 |

Append “(default)” only to the valid advertised default. The current native default is Lanczos3. Use the actual native names; do not label methods Automatic, Preserve Details, Bicubic Sharper/Smoother or imply Adobe numerical equivalence.

Nearest help:

> Keeps hard pixel edges by copying sampled colors and transparency at this resize step. Reduction can skip small details.

Photo-method help:

> These methods use different reduction filters. Enlargement uses cubic interpolation for all three; mixed-axis resizing combines reduction with enlargement.

Shared note:

> Applies to rendered layer content. Masks and selections keep their existing resize rules.

This wording scopes nearest exactness to the current geometry stage, not archived source bytes after compositing. It also avoids suggesting that text reflows, fonts change source size, source-space filter radii shrink or soft masks acquire the image kernel. The existing committed canvas remains the result preview; the selector does not claim a live uncommitted preview.

Canvas-bounds mode exposes no interpolation selector or photo-method help and sends no `resample` field. Switching modes retains the scale-method draft so returning to Scale restores it. Bounds anchors, transparent padding, selection-of-padding and positioned-mask clipping disclosure keep their existing behavior. Selecting a new method without changing dimensions does not enable Apply or rewrite an earlier retained resize stage.

## Typed drafts and capability boundaries

Add `DocumentResizeMethod = 'nearest' | 'cubic' | 'mitchell' | 'lanczos3'` and optional typed `Backend.documentResizeMethods` / `documentResizeDefault`. Pass current capabilities plus independent image/canvas command availability into ResizePanel.

Keep local dimension drafts as strings. Convert only nonempty finite integer values into the submitted numeric Width/Height, enforcing the existing 1–8192 axes and 24-MP total. Empty fields must not coerce to zero, trigger a warning from a `NaN` controlled input, or dispatch. Disable aspect-ratio matching when Width is invalid. A valid ratio calculation may produce an out-of-range Height, which remains visible and invalid rather than silently distorting the aspect ratio by clamping it.

`ResizeDraft` is frontend-only and has just two current consumers: ResizePanel and App's mask-review state. Extend it with the method choice and preserve dimension strings, including incomplete text, across review navigation. The wire payload remains numeric. A local choice can represent a supported method, an explicit `legacy` omission state, or an empty selection requiring a choice; these local sentinels are never serialized.

| Capability state | UI/payload behavior |
| --- | --- |
| Matching native backend, nonempty recognized method subset | Show only recognized, deduplicated choices in stable order. Select the advertised default only if it belongs to that subset. Send the chosen explicit method. |
| Recognized subset, absent/invalid/unsupported advertised default | Show “Choose a resampling method”; require an explicit supported choice before image resize. Do not silently choose the first option. |
| `documentResizeMethods` absent | Preserve legacy behavior: hide the selector, omit `resample` entirely. Ignore a stray default field. |
| Explicit empty, malformed or unknown-only method list | Disable image scaling with an actionable capability message; canvas bounds remains independent. Do not silently send a default resize. |
| Method removed while a draft exists | Keep its value visibly unavailable and disable Scale Apply until a supported choice is made. Never replace a chosen method automatically. |
| Explicit-method draft, then method-list capability disappears | Preserve the intent and explain that choices are no longer advertised. A local **Use companion default** action explicitly changes the draft to legacy omission. Until then, Scale Apply remains disabled. |
| Missing image-resize command | Disable image submission independently of canvas-bounds capability. |
| Photoshop/another unsupported backend | Keep legacy omission-only resizing; no native method is inferred from a command name. |

The backend owner confirmed the absent/subset/empty distinction. Capability changes invalidate an in-flight method-specific submission. A document must match the active backend before the panel can borrow that backend's methods or command availability. The native server remains authoritative for protection, method admission, resource limits and any old host's rejection of unsupported explicit arguments.

## Positioned-mask review and revision refresh

Keep the existing explicit mask-review workflow. Its saved draft includes mode, Width/Height text, method choice, bounds anchor and padding choice. Reviewing or rasterizing masks does not issue a resize. Returning to the dialog restores all those fields against the same document's **new current revision**, then an explicit Apply submits that revision. Hidden and density-zero positioned masks remain blockers for an actual image dimension change. A zero-offset retained frame still needs explicit rasterization.

Update review/return copy to say that dimensions **and resampling choice** are retained. If capability support changed during review, preserve the old method visibly and require a new valid choice or explicit legacy-default selection; do not erase it. Canvas-bounds mode does not inherit an image-method blocker, and its request never contains the hidden scale choice.

A same-document revision conflict or positioned-mask rejection refreshes current metadata, retains the form draft and displays the current blockers. No automatic rasterization, dimension rebase, proportional resize, or retry occurs. A later explicit Apply captures the refreshed revision. Existing proportional protection enforcement stays native; the existing aspect-ratio action remains a user action, not an automatic response to an error.

## Document installation and dialog completion are separate

The current runner already captures the active document at resize dispatch and checks its revision before/after preview. ResizePanel still submits without a captured local context and closes through an unconditional `.then(result => onComplete())`. That is insufficient when an old dialog closes and another dialog opens on the same document while a resize response or preview is pending.

Capture an immutable submission at click:

- backend/document ID and positive expected revision;
- current source Width/Height;
- numeric target Width/Height;
- mode and its effective wire method, or canvas anchor/padding arguments;
- relevant capability signature;
- dialog instance and submitted draft identity for completion only.

Extend the existing internal command context with an explicit document scope for resize commands only, or an equivalently narrow typed resize context. Existing layer-scoped gestures retain their current selected-layer checks. A document-wide resize must not require the same selected layer: selecting another layer or closing the old dialog does not cancel a valid resize of the same document. The prior mask-position browser regression explicitly requires that behavior, and the independent reviewer confirmed it.

The runner's installation gates check the captured backend/document, expected revision and source dimensions before installing the result. Confirm result document/backend/target dimensions match the submission. After preview, check the accepted result revision/dimensions and current backend/document. A stable App-owned capability reference guards the chosen method both before and after the preview await, including after the submitting panel unmounts. Do not place this installation callback solely inside an unmounted dialog or include selected-layer identity in it. Canvas mode's signature should use its relevant command capability, not an unused image-method choice.

Closing the old dialog alone may still allow the valid same-document result to appear. Completion is stricter: ResizePanel checks its alive state and unchanged submitted draft; App checks a resize-dialog instance token, current modal, backend/document and accepted result revision/dimensions before closing, clearing mask-review state or changing zoom. Increment the token for each fresh open and each Return to resize. Keep the panel key independent of document revision so its own successful resize does not unmount it prematurely. A changed draft, new dialog instance, new document/backend, removed capability or later revision must never be closed by the older submission.

Disable the form's controls and method/mode switches while the mutation is busy. Closing remains available. A queued synthetic change is still defended by the completion identity check. No “Apply again” automatic retry uses a new revision. If the graph was successfully installed but the user navigated while its preview was pending, the existing preview version guard and the completion guard keep the newer view current.

## Bounded implementation seams

Primary files: `client/api.ts`, `client/ResizePanel.tsx`, `client/resize.css`, the existing local command-context type if needed, and narrow resize-only portions of `client/App.tsx`. Add a focused browser alias/script; retain the existing canvas/mask-position tests. No new dependency, mask/refinement algorithm, modal framework, global request abstraction or recipe change is needed.

Do not reuse the per-layer tonal/filter callback for resize. Do not reuse its alive condition for document installation either: an explicitly closed old resize dialog can have a valid same-document committed result while its completion callback must be discarded.

## Browser acceptance

Use isolated temporary native projects and the existing unchanged local NASA/scikit-image photograph. No model, provider, new image generation or live user project is involved. Consolidate these eight workflows:

1. **Default/drafts:** the full native list and default label; empty/invalid/overlimit dimensions send nothing; method-only change at the same dimensions sends nothing; omitted legacy versus explicit default preserve expected native behavior and one-step Undo. Requests contain numeric captured dimensions, not draft strings.
2. **Exact pixel-art nearest:** a small opaque palette fixture enlarged to odd dimensions through the UI. Decode the actual full-size PNG export and compare every output pixel to an independent integer pixel-center oracle. Include a second reduction stage to prove sequential sampling. Backend tests separately own all-alpha/hidden-RGB geometry exactness; do not equate soft-alpha composition with a raw byte-copy oracle.
3. **Actual photograph:** resize the unchanged 512px fixture to a smaller noninteger size with Cubic, Mitchell and Lanczos3, saving full-size native exports and checking meaningful pairwise pixel differences. Undo between choices. Repeat pure enlargement and verify the installed backend's equal cubic-based results for the three photo options. These are actual renders, not generated replacements or proof of Adobe parity.
4. **Mask review:** choose nondefault nearest and target dimensions, review/rasterize multiple positioned masks including hidden/density-zero masks, return with dimensions/method intact, and issue no resize until explicit Apply. Verify the intended method persisted in the actual geometry and source/alpha assets remain unchanged.
5. **Canvas independence:** switch Scale→Bounds→Scale and retain method; Bounds hides interpolation controls, sends no `resample`, keeps anchor/padding semantics and remains usable when image methods are unavailable.
6. **Capability changes:** legacy absent list with omission-only request, recognized subset with invalid default, empty/unknown-only list, absent command, removed selected method, and capability withdrawal requiring explicit Use companion default. No unsupported method is dispatched or silently substituted.
7. **Lifecycle:** stale revision refreshes dimensions/blockers without retry; same-document layer selection and old-dialog closure still allow valid graph installation; old response cannot close a newly opened same-document dialog/draft. Exercise both delayed command and delayed preview, plus capability removal while a status request was already pending.
8. **Navigation/layout/persistence:** document/backend changes cannot install an old resize; normal success closes only its own dialog; 900px screenshot shows the selector, method explanation and Apply without overflow; reopen/Undo/Redo preserve geometry; source files, expected revisions, no provider/key calls and unexpected browser errors remain clean.

Run build, the focused suite, and adjacent `test:canvas-browser` and `test:mask-position-browser`. The independent native/SDK tests establish broader renderer, resource, portable-import and transactional guarantees; the UI evidence should state precisely what its own pixel fixtures prove.

## Implementation and acceptance evidence

Implemented `client/resize-methods.ts`, strict capability types, string-preserving `ResizePanel` drafts and the narrow document-scope resize context/runner/preview gates. Image/Resize entry points remain reachable when canvas bounds is the only resize command. Aspect matching retains an invalid computed zero instead of clamping; malformed mixed-type capability lists fail closed. Labels use **Resampling method**, **Nearest neighbor · pixel art**, **Cubic**, **Mitchell**, and **Lanczos 3**; the valid default is marked “companion default.” Help names the three photo methods explicitly.

Validation completed against the actual local native companion, in isolated temporary projects:

- `npm run test:resize-resampling-browser`: **8 workflows passed**. The suite includes numeric/default/legacy payloads; all-pixel nearest enlargement and sequential reduction; six actual photographic exports; multiple mask-review round trips; bounds independence; malformed/subset/withdrawn capabilities; stale revision/no replay; delayed command and preview; selected-layer, modal, document and backend changes; and a bounded mock Photoshop bridge for omission-only payload behavior. Queued same-document modal/backend transitions are simulated through the existing React click callbacks while the normal busy-disabled controls remain disabled. No installed Photoshop behavior is claimed.
- `npm run test:canvas-browser`: **4 workflows passed**.
- `npm run test:mask-position-browser`: **8 workflows passed**.
- `npm run build`: passed; only the existing bundle-size/lucide directive warnings remain.

The report is `test-results/resize-resampling-browser-report.json`: zero provider calls, key reads or browser errors; one intentional stale-revision 409. The source photograph remains byte-identical with SHA-256 `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`; its provenance remains in `tests/fixtures/tonal-color/README.md`. All captured immutable assets remain byte-exact.

Artifacts:

- `test-results/resampling-pixel-art-nearest-29x17.png` and `resampling-pixel-art-nearest-sequential-8x6.png`: full-size exported pixels equal the independent center-sampling oracle at every channel.
- `test-results/resampling-photo-{cubic,mitchell,lanczos3}-173x137.png`: actual reductions, differing by 38,959 / 38,490 / 45,167 channels for the three pairings. These are numerical differences, not a quality ranking.
- `test-results/resampling-photo-{cubic,mitchell,lanczos3}-768x768.png`: actual pure enlargements; all pixels equal on the installed backend as documented.
- `test-results/resampling-1440.png` and `resampling-900.png`: complete resize dialog, method/help and Apply visible without horizontal overflow. The 900px dialog and photographic reduction were visually inspected.

The independent reviewer found no source blocker in the install/completion split; final browser results have been sent for its evidence update.
