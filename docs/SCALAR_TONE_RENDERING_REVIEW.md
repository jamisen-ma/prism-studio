# Legacy Shadows / Highlights rendering consistency

During Local Shadows / Highlights browser acceptance, repeated exports of an unchanged document produced different RGB bytes. The document contained only an imported image and the existing global Shadows and Highlights adjustments. Its graph, revision and source asset were identical before and after; no browser requests edited that document.

An independent reproduction reduced the trigger to fixture preparation and Chromium launch, before page navigation. Instrumentation found that the first Shadows evaluation left part of its output unchanged; Highlights correctly consumed that partially adjusted buffer. Disabling optimization or concurrent recompilation made the reproduction stable. Suppressing optimization of `applyAdjustment` alone did not. These observations implicate the optimized scalar dispatch, but do not establish the exact underlying runtime defect.

## Change and compatibility

`server/color.mjs` now selects Shadows or Highlights when compiling the transform, outside the generic per-channel `map` callback and switch. Its closure computes the same encoded-RGB luminance, squared tonal weight, `value * 1.275 * weight` offset and rounded/clamped channels in the same arithmetic order. No command, persisted setting, parameter range, alpha rule or intended pixel formula changes. Other scalar branches remain intact.

This concerns the existing pointwise `shadows` and `highlights` kinds. The separate source-only `shadows_highlights` neighborhood algorithm remains independent. Global legacy adjustments retain their existing treatment of hidden RGB, while source filters continue to skip pixels with zero effective source alpha. The fix does not unify those distinct policies or claim Adobe pixel equivalence.

## Evidence

- Five fresh ordinary-runtime processes each exported the original global reproduction nine times with identical bytes after the fix. No optimization flags are required in the app.
- Three maintained independent regression tests cover two fresh processes with seven alternating 0.5 MP tone evaluations each, checking every RGB and alpha byte; source/global alpha and hidden-color differences; mask density, fractional opacity and protected pixels; and repeated exports across unrelated source-local edits without source-file changes.
- The normal-runtime Local Shadows / Highlights browser workflow retains unchanged-global comparisons before and after its full editing sequence, including portable project transfer. All eight workflows pass.
- The targeted native/color/filter/tonal/blend/local-tone sweep passes 65 tests. The latest full-suite and browser counts are recorded in [implementation status](IMPLEMENTATION_STATUS.md).

The cold regression intentionally uses the ordinary supported Node runtime rather than compiler intrinsics or a production workaround flag. It checks the declared pixels independently; it does not claim every runtime optimization schedule will reproduce the historical failure. Diagnostic scripts and before/after reports remain in the ignored `test-results` directory. The maintained regression is `tests/scalar-tone-regression.test.mjs` with `tests/fixtures/scalar-tone/cold-worker.mjs`.
