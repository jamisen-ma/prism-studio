# Photo Filter: API and MCP integration plan

Status: shared schemas, HTTP status and MCP help are integrated, 2026-09-19. Four focused schema checks and two official SDK lifecycle checks pass. The integrated native/schema/SDK/client checkpoint passes1,140 checks; all99 focused/adjacent browser workflows and the production build also pass.

## Shared public contract

Use the distinct global/source kind `photo_filter`, with `value:0` and optional flat parameters `{color,density,preserveLuminosity}`. The reviewed candidate defaults are `color:'#ff9500'`, `density:25`, `preserveLuminosity:true`. Color accepts exactly seven characters forming a six-digit RGB hex triplet and canonicalizes to lowercase. The explicit length check prevents a terminal newline from matching JavaScript's `$` regex anchor. Density accepts finite0–100 in exact0.01 increments; Boolean values are never coerced.

Creation fills all defaults. A partial update retains omitted fields; an empty object changes nothing. Canonical native records and recipes retain all three effective parameters, so applying a default recipe resets an existing custom treatment. Color-only updates must not reset density or luminosity preservation. Unknown parameters, malformed strings, nonfinite/finer density, non-Boolean values and nonzero values reject before publication. The ordinary source blend/opacity/mask and global selection/protection contracts remain in force.

Add the kind to both shared enums and its strict object to the existing parameter unions. Keep source-only spatial families source-only. Ordinary recipe schema derivation includes the new dependency-free kind; the Color Lookup exclusion remains unchanged. Reject explicit Photo Filter kinds and identifiable Photo Filter parameter fields on the optional Adobe bridge. An older native reader rejects the unknown kind rather than silently approximating it.

## Discovery and tool help

Advertise `photoFilterPolicy:'rgb-transmission-luma-fit-v1'` independently from existing color-family markers. Require the marker, the context's kind and individual command; source editing also requires source coordinates. No new command, file import, asset dependency, key or generation provider is needed. Forward the marker through HTTP status and official MCP discovery.

The four existing add/update adjustment/filter tools should describe the flat fields, defaults, partial-update behavior, alpha policy, source blend ordering and native encoded-RGB interpretation. Explain that Preserve Luminosity retains unrounded weighted encoded luma with shared gamut compression, with final byte rounding; it is not a color-temperature/Kelvin control. Density100 is not full replacement by a flat color. Preserve-on white and pure primaries remain unchanged, and zero transmitted luma returns the original RGB. Exact numerical policy and measured work weights belong in the native design.

## Meaningful integration evidence

Shared schema tests will cover complete/sparse input, uppercase hex, endpoints/centipercent density, malformed/unknown parameters, wrong-kind/value cases, source/global separation, bridge rejection and transaction/recipe validation. Maintain discovery count expectations without changing blend-mode counts or historical evidence.

Official SDK tests will compare literal and independently computed source/global pixels across color-only updates, fractional opacity, nonnormal source blending and deferred effect masks. Verify immutable source/working/cutout alpha, integer Distort plus raw Bake, Undo, portable/restart and exact defaults in saved recipes. Include protected/generated compositing, stale requests, stable replay and a late failing transaction where appropriate without duplicating all native unit cases. The isolated companion forbids generation, credential reads and segmentation calls.

Root owns shared schemas, status forwarding, MCP help, schema/SDK tests and public documentation. Native ownership remains with the architecture agent; the reviewer owns independent arithmetic fixtures/audits; the client agent owns controls and browser acceptance.

## Executed transport evidence

`tests/photo-filter-schema.test.mjs` passes4 checks covering sparse/complete input, exact hex length and density precision, malformed/wrong-kind/value cases, transaction/recipe semantics and bridge refusal. All86 shared-schema tests pass in210.72ms after only current28/32 discovery counts were updated.

`tests/photo-filter-mcp.test.mjs` passes2 official SDK workflows in1077.72ms. The isolated companion and stdio MCP client verify capability/status/tool help, default normalization, uppercase color-only retention, authored false/centipercent updates, stable request replay and independently computed complete-image source/global bytes. Source evidence includes Multiply at0.5 opacity, a density0.5 effect mask, working/cutout alpha0/1/128/255, integer Distort, raw Bake, Undo, original assets, `.prism` transfer and restart. Global evidence includes captured selection retention, complete recipe defaults, source append under an existing mask, one Undo, stale replay refusal after restart and late transaction rollback. Invalid requests retain graph/project bytes. Provider, key and segmentation calls are forbidden, and the companion token must not appear in subprocess stderr. Log: `test-results/photo-filter-mcp.log`.
