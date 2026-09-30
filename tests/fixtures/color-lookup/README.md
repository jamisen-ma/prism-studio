# Authored Color Lookup fixtures

All formulas, original CUBE text, numerical references and literal goldens in this directory were independently authored for this project on2026-09-19. No third-party LUTs, preset packs, copied implementation or external license dependency is included. These are project-authored test materials with no additional license terms.

`reference.mjs` exports `authoredCube(name,{gridSize})`, `authoredLookupGolden(name,rgb)`, `AUTHORED_LOOKUP_GOLDENS`, `authoredLookupNativeOrder` and `malformedAuthoredCubes`. No production or evaluation prototype is imported. `authoredLookupGolden` uses closed-form BigInt formulas for the five named multilinear functions, rather than duplicating a generic table sampler. Valid generated grids2/3/5/9/17/33 have power-of-two interval counts and exact dyadic samples.

The five original size2 files are checked against the generator in the maintained audit:

- `identity-2.cube`: unchanged components and endpoint coverage.
- `rgb-cycle-2.cube`: red/green/blue axis and output-order discrimination.
- `cross-products-2.cube`: independent channel interactions `R*G`, `G*(1-B)`, `B*(1-R)`.
- `gain-half-2.cube`: red gain255/256; input red128 is exactly127.5 and rounds to128, preserving authored sample precision.
- `gentle-crosscolor-2.cube`: restrained authored photographic test treatment with an exact closed-form reference. It does not emulate a commercial film, Adobe algorithm or color-management transform.

These exact-real goldens apply to the specified dyadic multilinear fixture functions. They do not promise exact-real half rounding for arbitrary imported decimal tables. `authoredLookupNativeOrder` is a separate comparison helper for these functions; production parser output never supplies its sample values.

The independent discarded-Q16 comparison and prototype evidence remain in `test-results/color-lookup-review/`. Malformed generators include exact-decimal range/domain and nonzero-underflow controls. Exact byte/line limits are generated in tests to avoid storing multi-megabyte invalid files.
