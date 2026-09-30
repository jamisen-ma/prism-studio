# Independent Color Range expectations

`reference.mjs` is authored for this repository and imports no production or
prototype implementation. Its two half-up stages use BigInt rational division.
The eleven literal goldens include a membership half tie, the two-stage alpha
discriminator, inclusive hard boundary, wide falloff, hidden alpha and overlapping
swatches. Plane and nearest-pixel-center preview helpers are suitable for native,
MCP and browser expectations. Inputs to these arithmetic oracles are trusted test
fixtures; public malformed-input behavior is tested against the actual validator.

The existing `../tonal-color/astronaut.png` photograph is reused without modifying
or duplicating it. Its existing provenance/license remain authoritative. Exact
full-photo expected bytes are computed by this independent oracle.

Exports: `rangeMembershipReference`, `rangeAlphaReference`, `colorRangeReference`,
`colorRangePlaneReference`, `colorRangePreviewReference`, `COLOR_RANGE_GOLDENS`.
`COLOR_RANGE_PHOTO_GOLDENS` fixes the complete512×512 coverage SHA-256 values for
the warm-orange and orange/blue default32/32 cases, independently derived by the
BigInt plane oracle.
