# Channel Mixer and Gradient Map independent audit

Verified on 2026-09-19. `tests/color-mixer-audit.test.mjs` passes nine independent tests. The focused run with the eight backend-owner tests, three shared-schema tests, official MCP workflow and six client-snapping audit tests passes **27/27**. Fixtures are synthetic and local; no credentials or image providers are used.

The independent checks cover:

- Channel Mixer identity, channel swaps, retained monochrome/color rows, negative contributions, constants and full-sum-before-clamp behavior. A separate BigInt reference checks 1,600 seeded canonical percentage cases, including half-byte ties. Finer-than-0.01% coefficients reject rather than rounding silently.
- Gradient endpoints, close interior stops, 16 unequal stop intervals and 1,280 forward/reverse comparisons against a separate rational reference. Reverse complements the integer tone numerator. Interpolation with nonzero and descending endpoint colors preserves the audited exact half-byte ties. Exact authored stops remain correct even when two adjacent finite offsets round to the same scaled position.
- Alpha 0/1/128/255, invisible RGB, mask coverage, partial opacity and filter order. Disabled or zero-opacity filters bypass exactly. A scalar value of zero still applies both parameterized kinds.
- Adjustment layers capture the active selection; source filters ignore it. Partial updates retain unrelated rows/stops and stable IDs. Source image files, raw source previews and source-oriented subject-selection input remain exact.
- Lower protected footprints remain unchanged through both new adjustment kinds, filtered clipping bases/members and isolated ancestors. Original-context base/member previews retain their protection behavior. Identity mixer parameters do not bypass the active-filter protection guard.
- Undo, reopening and portable-project roundtrips retain editable parameters and pixels. Invalid parameter families, finer coefficients, stale revisions, failed transactions and a real filesystem save failure leave the committed graph, history, source assets, project files and warm preview cache unchanged.
- Eight canonical hostile portable manifests reject before image validation or writes. Capabilities advertise 22 adjustment kinds and 20 filter kinds. Hidden stacks consume their declared work weights before image allocation: three units per source pixel for Channel Mixer, five for Gradient Map, under the existing aggregate limit.

The audit identified and verified fixes for two rounding risks: complementing an already-divided tone during reverse, and interpolating arbitrary endpoint colors through a prematurely normalized tone. Regression fixtures now cover both. The snapping harness was also updated to execute the new default-aware outside-style helper alongside the actual client clipping and snapping modules.

This verifies the declared native 8-bit encoded-sRGB contract. Arbitrary finite gradient offsets retain native floating-point interpolation; Adobe-exact numerical behavior, alternative color spaces, dithering, opacity stops and gradient midpoint controls are not claimed. Browser verification is recorded separately by its owner.
