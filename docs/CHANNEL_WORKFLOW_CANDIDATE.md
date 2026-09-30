# Candidate after Curves banks: composite channels and selection coverage

Status: research notes,2026-09-19. No production command, schema or UI is authorized by this proposal. Complete Curves banks acceptance first, then compare this workflow with the typed-asset LUT proposal in [the earlier comparison](NEXT_PRO_WORKFLOW_REVIEW.md).

## Why consider it

The editor has color adjustments, Channel Mixer, saved selections, layer-alpha selection loading and grayscale mask inspection. It does not yet provide an explicit composite Red/Green/Blue channel inspection and channel-to-selection workflow. That would let a user inspect which component separates an object, then use its continuous intensity as a mask for an existing adjustment. It changes selection metadata without repainting source pixels and does not need a new external model or file dependency.

Adobe describes separate RGB information channels, grayscale inspection, and alpha channels that store selections. That establishes a broader professional workflow; it does not specify the native arithmetic proposed here. [Adobe channel basics](https://helpx.adobe.com/photoshop/using/channel-basics.html)

Adobe's Calculations feature can combine channels into channels or selections. A small native channel-loading command would cover only one part of that workflow; full Apply Image/Calculations, spot channels, multichannel color modes and direct component painting would remain missing. [Adobe channel calculations](https://helpx.adobe.com/photoshop/using/channel-calculations.html)

Imported LUTs remain useful too: Adobe's Color Lookup adjustment applies reusable preset looks. Prism's existing asset walker and recipe format currently make portable LUT dependencies substantially more involved than selection metadata. This is an implementation dependency comparison, not a claim that channel tools replace LUTs. [Adobe Color Lookup tutorial](https://www.adobe.com/learn/photoshop/web/edit-photo-color-lookup-adjustment)

## Candidate boundaries to decide before implementation

- Source: freshly rendered current document composite, including visible layers, groups, effects, filters and adjustments. This differs from the existing layer-alpha loader, which deliberately excludes source filters and compositing. Keep the active selection out of source measurement; it participates only in the explicit combination step.
- Channels: Red, Green, Blue, encoded Rec.709 luma and composite alpha. Do not call the encoded weighted sum perceptual lightness or linear-light luminance. Pin exact integer coefficients and byte rounding if luma is offered.
- Inspection versus mask coverage: decide whether a channel preview displays unassociated channel intensity with the composite alpha or an opaque grayscale image of the exact proposed selection coverage. These are different at partial transparency. Prefer an explicit named contract over a hidden black-matte conversion.
- For color/luma selection coverage, consider `round(channelByte * alphaByte /255)` so fully transparent pixels stay unselected. If inversion is offered, decide explicitly between inverting intensity before alpha multiplication and inverting the final coverage. Neither may be inferred from a generic checkbox label. Alpha inversion may intentionally select transparency.
- Replace/Add/Subtract/Intersect should reuse the existing saved/layer-selection algebra and its complexity guard. Preserve an explicit all-zero bitmap instead of using null, which means no selection. Selection creation remains metadata-only after measurement; source/working assets are unchanged.
- New preview and selection requests need revision ownership, cooperative channel extraction/combination/encoding, bounded output and encoded transfer. Existing source-render scratch checks do not by themselves establish a total full-render memory bound; document the render phase and extracted-plane phase separately or add a scoped stronger preflight for these new operations. Do not claim a process-RSS guarantee.
- Command names, capability markers, return metadata, source dimensions and exact preview sampling must be frozen before UI implementation. The browser should retain its chosen channel while inspecting, reject late cross-document/revision results, and issue one guarded selection mutation on Apply.
- Existing masks/saved selections can persist results; no new editable-channel asset type is needed in this first scope. Native `.prism` transfer and existing Undo should preserve the generated selection. It is not a new PSD alpha-channel interchange claim.

## Existing code seams

`server/layer-selection.mjs` already exposes asynchronous `encodeSelectionAlpha` and `combineSelectionAlpha`, including the600,000-scalar RLE guard and explicit empty selection. Reuse their byte algebra after establishing channel coverage; avoid a second incompatible selection implementation. Their current32-row yields may need a bounded-width wrapper or an independently justified shared scheduling refinement for8192-wide new loops.

`server/mask-preview.mjs` already defines exact rational half-up preview dimensions, nearest-pixel-center sampling, grayscale PNG output limits and structured metadata. Factor only genuinely shared pure sizing/sampling behavior, preserving all current mask-preview bytes and admission rules.

`NativeBackend.render()` computes the actual composite under queued document ownership. `get_histogram` and `sample_color` are existing read-only composite consumers. New channel inspection must not reuse a reduced, encoded browser preview or write a cached project mutation. Native selection mutation must retain whole-operation queuing and atomic commit, including use inside a transaction.

The stronger Distort resource module already accounts decoded content-leaf phases plus root surfaces and retained groups/clipping/callbacks. Whether a scoped generic estimation mode can support new channel operations without changing old admissions requires architecture review; no change is proposed merely by naming that module.

## Acceptance examples

Use tiny exact RGBA fixtures covering alpha0/1/128/255, channel endpoints, neutral ramps and fractional mask density; independently verify preview and selection coverage for every offered channel/invert choice. Include rendered layered examples with groups/clipping, protected and generated content, masks and source filters. Read-only inspection must preserve graph/history/assets/cache policy; selection application must preserve image bytes, undo/reopen/portable exactly and reject stale revisions without replay. Test RLE complexity, admission before image reads, true save failure, transaction rollback and responsive wide/tall loops. Browser evidence should show clear partial-transparency semantics, meaningful actual-photo channel differences, compact layout and accessible keyboard selection.

## Measured storage blocker

Architecture's `test-results/channel-workflow-evaluation/coverage-probe.mjs` measures the existing run-length encoding on the public fixture. At512×512, continuous Red/Green/Blue/luma coverage needs208343/204368/210469/205876 nonzero runs, exceeding the existing200000-run bound for every color channel. At1024² it needs approximately725000–769000 runs. The256² versions fit. These are ordinary photographic channels, not only adversarial noise.

An exact full-resolution channel-loader would therefore fail even this modest512² photo under current storage. Do not silently resize, quantize, threshold, raise the RLE/history budgets or label that an implemented general channel workflow. Reconsider a separately named tonal-range selection with explicit thresholds/falloff and measured photographic utility, an inspection-only component viewer with honest scope, or a larger asset-backed mask design. Asset-backed masks would affect every currently synchronous mask-coverage consumer and need their own design. Imported LUTs may have the more isolated typed-asset boundary because they introduce a new adjustment family rather than changing all existing masks. No next-feature implementation is approved by this finding.
