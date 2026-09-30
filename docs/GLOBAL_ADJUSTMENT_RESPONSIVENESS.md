# Cooperative global adjustment processing

Global adjustment RGB processing now yields to the event loop after bounded pixel batches. Previously, only the newer color-mapping families yielded; legacy scalar controls, Levels and both Curves modes could hold the companion's main thread for their complete RGB loop.

The change is confined to `NativeBackend.applyAdjustment`. All admitted widths process at most 65,536 pixel visits between yields. Families that already yielded at a tighter row cadence retain that cadence. The existing `COLOR_MAPPING_KINDS` flag still controls its established hidden-RGB policy; the yield itself no longer depends on that flag. The exact transform, candidate rounding, opacity/mask expression, protected-pixel bypass, alpha and early identity return remain unchanged.

The native command queue still owns the complete operation. Yielding allows the event loop to run; it does not allow a queued document mutation to overtake an export, expose partial pixels or create cancellation support. Nested graph evaluation stays sequential, and each render owns its input, output and transform state. Independent source review found no new ownership issue.

## Verification

Two maintained tests in `tests/global-adjustment-yield.test.mjs` verify:

- Wide and tall 1-megapixel legacy Curves operations yield repeatedly before completion, leave their input immutable and match an independent expression for every RGB/alpha byte, including hidden colors, fractional opacity, mask density, protected pixels and the legacy endpoint half tie.
- A real native mutation submitted during the new yield cannot alter an in-flight export. The export contains the original revision's pixels, the queued edit produces its own later revision, the next export contains the new pixels and a stale mutation still rejects.

Both tests and the three maintained cold/optimized scalar-tone regressions pass. The latest complete suite count is tracked separately in [implementation status](IMPLEMENTATION_STATUS.md).

## Measured effect

On Node 22.14.0 and Apple M5 Max, five measured runs per case retained the exact output hash of the earlier Curves production benchmark:

| Global Curves workload | Earlier median | New median | Earlier maximum 5 ms heartbeat gap | New maximum gap |
| --- | ---: | ---: | ---: | ---: |
| 1024 × 1024, Linear | 15.97 ms | 15.86 ms | 19.31 ms | 6.36 ms |
| 1024 × 1024, Smooth | 16.17 ms | 15.61 ms | 16.63 ms | 6.15 ms |
| 8192 × 128, Smooth | 16.10 ms | 15.94 ms | 16.38 ms | 6.32 ms |
| 128 × 8192, Smooth | 15.38 ms | 17.27 ms | 16.41 ms | 6.29 ms |
| 6000 × 4000, Linear | 331.75 ms | 342.35 ms | 331.94 ms | 10.28 ms |
| 6000 × 4000, Smooth | 332.28 ms | 337.27 ms | 333.44 ms | 6.28 ms |

An initial uniform 32-row cadence added unnecessary overhead to tall narrow legacy images. The final implementation uses the pixel-bounded cadence for those previously synchronous kinds. Existing cooperative families retain their tighter row limit where applicable.

These are measurements of this adjustment phase, not whole-export latency or a deadline guarantee. Synchronous output allocation, mask preparation, other compositing stages, native codec setup and total process memory are outside this batch bound. A 24-megapixel buffer copy can still cause a visible heartbeat gap before the loop starts.

Evidence: `test-results/global-adjustment-yield-benchmark.mjs`, its JSON/log outputs, `test-results/global-adjustment-yield.log`, and the preserved pre-change `test-results/curves-evaluation/production-benchmark.json`. No provider, model, API key or source-asset modification is involved.
