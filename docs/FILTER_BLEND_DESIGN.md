# RGB blending within editable source filters

Implemented and backend-verified, 2026-09-19. Root and independent review accepted the refined arithmetic, uniform blend surcharge, measured adversarial paths and explicit-Normal read tolerance. The focused owner/audit/schema/MCP sweep passes21 tests and39 adjacent owner filter/Bake tests pass. Full-project and browser acceptance are maintained separately.

Per-filter blending lets a grade contribute only color, a sharpen contribute luminosity, or a generated texture combine with the current source through Multiply/Screen. It operates inside one source filter stack, before retained geometry and document compositing. It is independent of the raster layer's own blend mode.

## Stored contract and capability discovery

Extend existing `add_layer_filter` and `update_layer_filter` arguments with optional `blendMode`. No new command, asset, filter kind or global adjustment parameter is introduced. All26 source filter kinds support this same property.

Missing `blendMode` means Normal. Explicit `'normal'` is accepted but omitted by authored add/update/reset operations and normalized recipe steps. Adding a default filter therefore produces the same serialized record as before. Updating with the field omitted preserves its current mode; explicitly setting `'normal'` removes the stored field. Validation stays pure: an externally supplied valid explicit-Normal record may remain stored until ordinary filter editing normalizes it, and older readers may reject that external record's extra field. Do not migrate/rewrite graphs merely on read. No null/reset alias, coercion or fallback is accepted. Validate modes even for disabled entries, opacity0 and identity parameters.

Use the existing27 layer mode names except Dissolve, giving26 filter choices:

`normal`, `darken`, `multiply`, `color_burn`, `linear_burn`, `darker_color`, `lighten`, `screen`, `color_dodge`, `linear_dodge`, `lighter_color`, `overlay`, `soft_light`, `hard_light`, `vivid_light`, `linear_light`, `pin_light`, `hard_mix`, `difference`, `exclusion`, `subtract`, `divide`, `hue`, `saturation`, `color`, `luminosity`.

Dissolve changes coverage and has no role in this RGB-only operation. Unknown values, including Dissolve, reject before rendering/publication. Existing readers already reject unknown filter-record fields, so a persisted nonnormal field fails closed without changing the project version. Canonical Normal records remain readable by earlier versions.

Implemented independent capability fields:

```js
layerFilterBlendPolicy: 'candidate-rgb-v1'
layerFilterBlendModes: [/* the26 names above */]
```

Nonnormal authoring/execution requires the exact policy, source filter coordinates, supported kind and listed mode; a filter's existing source-only kind policy still applies. Missing/malformed/unknown blend policy preserves the legacy Normal workflow, with no `blendMode` payload. A partial recognized list limits available nonnormal modes. Definition capture/import/save may preserve a supported recipe structurally without executing it; Validate/Apply must enforce the execution capability in the client. A currently unsupported nonnormal entry must not be silently reset or enabled. Existing explicit Delete/Clear/Bake capabilities remain independent. See the separate UI design for frozen requests, lost capabilities and stack reorder handling.

## Exact stage ordering and alpha

For each enabled entry with positive opacity, `C` is the current source RGB byte triple produced by the preceding entry. First evaluate the existing filter at full strength, obtaining its already-quantized RGB byte candidate `F`. Every current scalar transform and spatial/noise candidate returns bytes; no filter algorithm is changed.

Apply the chosen RGB blend function with backdrop `C` and source `F`, then use the existing per-entry opacity to interpolate from `C` to that blend result. Quantize/clamp once after this interpolation. Do not round the blend result before opacity. For example, Multiply with C=1,F=51 and opacity0.625 has an unrounded blend value0.2 and final byte1; early rounding of0.2 would incorrectly yield0.

Normal retains the exact old expression and evaluation branch:

```js
clampByte(Math.round(C + (F - C) * opacity))
```

There is no normalize-to-unit-RGB roundtrip on Normal and no changed candidate/work/identity path. New rational modes use the exact arithmetic below. Soft Light and the four nonseparable modes use the existing native floating core and declared ordering. This policy does not change old layer/group/clipping/global-adjustment pixels or claim Photoshop Smart Filter parity. The [W3C blending reference](https://www.w3.org/TR/compositing-1/#blending) is the conceptual reference for the existing core; its blending functions are separate from alpha compositing.

The effective working alpha, including separate source-cutout alpha, is copied unchanged. Alpha0 RGB is not touched. Positive alpha does not scale filter blending/opacity again: source alpha1 and alpha255 with identical current RGB get identical RGB candidates, except that spatial candidate neighborhoods already use the existing alpha-weighted rules. No layer opacity, additional mask, selection, ancestor mask/opacity, clipping or document backdrop participates in this inner RGB operation. Those existing stages remain later in rendering. Source preview continues to ignore the entire stack.

## Rational blend core and rounding

Implement a new source-filter-only helper. Do not rewrite the established `server/blend.mjs` or clipping compositing during this feature. Eighteen separable modes produce an integer numerator N and positive integer denominator D, with `0<=N<=255*D` and `1<=D<=255`. Darker/Lighter Color additionally select the whole backdrop/candidate by exact integer sums R+G+B, preserving the backdrop on a tie; their channels have D=1. This avoids both normalized half-tie drift and normalized equal-sum comparisons.

For byte backdrop b and candidate s:

| Mode | Byte-space blend result |
| --- | --- |
| Darken / Lighten | `min(b,s)` / `max(b,s)` |
| Multiply | `b*s/255` |
| Screen | `(255*b+(255-b)*s)/255` |
| Color Burn | b255→255; otherwise s0→0; otherwise `max(0,255*s-255*(255-b))/s` |
| Color Dodge | b0→0; otherwise s255→255; otherwise `min(255*(255-s),255*b)/(255-s)` |
| Linear Burn / Dodge | `max(0,b+s-255)` / `min(255,b+s)` |
| Overlay | b≤127: `2*b*s/255`; otherwise `(65025-2*(255-b)*(255-s))/255` |
| Hard Light | Same two expressions, selecting by s≤127 |
| Vivid Light | s≤127: Burn with source2s; otherwise Dodge with source2s−255, retaining endpoint precedence |
| Linear Light | `clamp(b+2*s-255)` |
| Pin Light | s≤127: `min(b,2*s)`; otherwise `max(b,2*s-255)` |
| Hard Mix | Vivid Light's exact N/D: output0 if `2*N<255*D`, otherwise255 |
| Difference | `abs(b-s)` |
| Exclusion | `(255*(b+s)-2*b*s)/255` |
| Subtract | `max(0,b-s)` |
| Divide | s0→255; otherwise `min(255*s,255*b)/s` |

Opacity is the exact authored finite binary64 number p in[0,1]. Compile its reduced rational representation P/Q once per entry. The exact final value is:

```text
U = b*D*Q + (N-b*D)*P
V = D*Q
result = floor((2*U+V)/(2*V))
```

Convex interpolation keeps U in[0,255V]. There is no intermediate candidate/blend byte quantization beyond the existing candidate F, and no extra source-alpha factor.

If Q≤2^36, Number integer arithmetic is exact: each product is bounded by65025Q<2^52, the final doubled numerator is at most511*255*2^36<2^53, and2V<2^45. A noninteger quotient is more than2^-45 from an integer floor boundary; the largest binary64 division half-ULP below256 is2^-46. Thus `floor((2U+V)/(2V))` cannot cross a floor boundary. This compile-time route covers all ordinary dyadic opacities, including0,1,.5,.625,.75, without per-pixel BigInt.

For other opacities, compute the estimate `(b*D+(N-b*D)*p)/D`. All integer coefficients are exact. With round-to-nearest unit error u=2^-53, multiplication, addition and division contribute less than4*255u absolute error; gradual-underflow error is negligible relative to that bound. Guard distance to the nearest half byte with `64*Number.EPSILON*255`, over32times this bound. Outside the guard, ordinary rounding is safe. Inside, evaluate the exact U/V using the compiled BigInt P/Q and half-up integer division. No epsilon is added to colors. Values already beyond0/255 clamp safely. Compilation and fallback use bounded scalar metadata, no per-pixel cache or image plane. Independent arbitrary finite opacity probes are required, not merely percent-slider fractions.

Known regressions to pin include Multiply b13,s85,p.75→7; Screen b17,s130,p.375→63; Difference b2,s69,p.5→35; Linear Burn b2,s254,p.5→2; Linear Light b0,s128,p.5→1. Direct normalized arithmetic or division before interpolation produced the lower byte. Identity Difference with RGB1 and opacity immediately above .5 must produce0, while the immediately lower binary64 value produces1; these force the exact generic path on every channel.

Soft Light and Hue/Saturation/Color/Luminosity retain `blendRGB(C/255,F/255,mode)`, then byte-unit `round(C+(255*mixed-C)*opacity)`. These are explicitly the existing native binary64 formulas, not an exact-real rounding promise. The nonseparable luma is the existing `.3R+.59G+.11B`, distinct from Rec.709 tonal grading. Their exact native reference/golden cases must be recorded independently. No changes to those functions are needed to add filter blending.

## Identity, work, buffers and yielding

Disabled or opacity0 entries skip as before. A computationally identity candidate is different from an identity *entry*: blur/sharpen sigma0, Unsharp amount0/sigma0/threshold255 and Noise amount0 still blend when nonnormal. Reuse current RGB as F without allocating a candidate/ring/hash/table. For example, RGB128 under self-Multiply becomes64, Screen192, Difference0. Normal keeps the old complete identity skip. Tiny positive quantized-Gaussian identities retain their current conservative computation/work policy.

Keep the prior per-kind work weight unchanged, including each active identity's weight1. Add a mode surcharge only for enabled positive-opacity entries:

| Mode class | Additional work per source pixel |
| --- | ---: |
| Normal | 0 |
|Every nonnormal mode, including all separable/whole-color and nonseparable modes | 40 |

The final uniform surcharge accounts for the slower all-channel, large-numerator rational fallback, not merely common Multiply/Screen or Difference timing. It keeps admission stable when switching between nonnormal modes or arbitrary positive opacities. Document-wide384million work, hidden nodes, layer/document filter counts, source pixels and dimensions stay unchanged. Any active identity with a nonnormal mode costs41S (maximum floor(384M/41)=9,365,853 pixels). Computing Noise costs48S (8MP maximum), and preserved Color Balance costs80S (4.8MP maximum). Changing Normal to another mode, or activating opacity/enabled, must revalidate work and roll back atomically if activation exceeds the limit. Ordinary Normal documents retain exact old admission and serialization.

No new full image surface, random field, channel plane or retained lookup table is needed. Scalar candidates remain short RGB tuples; spatial/noise candidates retain the existing4S lifetime. Compile opacity before constructing the candidate: IEEE decomposition uses one transient8-byte DataView, returns only bounded scalar P/Q and never retains the view. P has at most53 significant bits and Q at most1075 bits; even subnormal opacity has bounded scalar BigInt operands/results. This compilation phase precedes the existing source+candidate peak. Reuse bounded scratch triples for source/backdrop/output; the existing floating nonseparable functions allocate transient short JS arrays, which are not full-frame buffers. The existing source cache Rmax, persistent Gaussian noise reserve T, group/clipping/positioned-mask envelope and all four Bake phases remain valid. No total RSS/GC guarantee is added.

For nonnormal RGB loops, yield after at most16,384 source pixels, counting skipped alpha0 pixels. If implemented by rows use `min(existingColorYieldRows, max(1,floor(16384/width)))`; maxwidth8192 makes at mosttwo rows. Spatial/noise candidate construction keeps its own existing tap/pixel yielding. Normal keeps its old loop/yield path. Runtime scheduling, JIT, short-array collection and initial buffer copying are not hard deadlines.

## Native integration and acceptance

`normalizeLayerFilter` owns validation/canonical omission. `editedFilterStack` must copy/add the field and recognize blend-only updates; explicit Normal requires deletion rather than an `Object.assign` omission trap. `filterWork` should add the surcharge after the unchanged candidate weight. `applyLayerFilters` must only skip candidate identities when mode is Normal; nonnormal identities alias current pixels and enter blending. Metadata resource validation still precedes asset work, including transaction and recipe staging.

Recipe normalization already calls the filter normalizer, so its complete parameters, retained seed and canonical blend setting stay target-independent. Mode-only edits, saved recipes, duplicate, undo/redo, portable projects and restart must preserve the same exact stack. The strict filter field list provides the old-reader compatibility barrier. Malformed portable modes and resource-overflow activations reject before image reads. Global adjustment schemas remain unchanged.

Render/inspection/retouch/filter Bake naturally share `applyLayerFilters`. Preserve protected-target rejection, original-context lower-protected RGB restoration, generated footprint exclusion, source-cutout alpha and source originals. Bake retains its earlier-protected-context rejection, exact raw working alpha restoration, explicit revision and whole-interval asset rollback. An identity candidate with nonnormal mode can produce changed RGB and must be encoded; a truly unchanged final result may retain the existing asset as before. Nonempty filter stacks remain unsupported for editable PSD until explicit Bake/Clear.

Required backend tests cover all26 kinds×26 modes, exact rational mode formulas/thresholds/ties/arbitrary opacity, normal legacy byte+canonical parity, nonseparable native goldens, candidate-before-opacity order, identity mode changes and no ring/table, alpha0/1/128/255, sequential ordering, exact whole-color sum ties, missing/invalid mode behavior, inactive validation, hidden work limits/activation rollback, no metadata I/O, source/geometry/mask/protected/generated integration, Bake, recipe full settings, portable/restart/retry and real persistence failure. UI tests must preserve local mode/parameter drafts and freeze captured revision/target contexts.

## Probe and production evidence

`test-results/filter-blend-evaluation/prototype.mjs`, `rational.mjs`, `probe.mjs` and `report.json` are design-only. The700 small image comparisons cover26×26 kind/mode combinations plus24 identity cases; Normal delegates to the actual old evaluator and is byte-equal. The prototype's Mosaic candidate uses the old evaluator only for small semantic fixtures and is excluded from allocation/performance claims.

The first normalized-core-only probe exposed why new rational evaluation is needed; it is not the proposed implementation. The refined probe uses exact byte ratios, reduced-opacity routing and16,384-pixel yields. Three-run full-candidate medians on Node22.14.0, Darwin arm64, Apple M5 Max:

|1024² workload | Median time |
| --- | ---: |
| Identity candidate, Multiply / Hard Mix |46.1 /65.0ms |
| Identity candidate, Soft Light |105.1ms |
| Identity candidate, Hue / Saturation |236.4 /225.3ms |
| Identity candidate, Color / Luminosity |112.2 /112.6ms |
| Brightness13.3%, Multiply / Saturation |74.3 /266.2ms |
| Blur1 / Unsharp / computing Gaussian Noise, Saturation |277.5 /300.9 /326.0ms |
| Identity Difference, RGB1, opacity.5 exact fast path |45.2ms |
| Identity Difference, opacity adjacent above/below.5, every channel exact fallback |146.1 /147.3ms |
| Gradient Map→RGB85, Multiply, RGB[13,127,253], opacity adjacent above/below.75, every channel exact fallback |345.0 /341.9ms |

The large-numerator fixture justified raising the original provisional separable surcharge16 to uniform40. There is no cheaper admission based on expected rarity of half ties. Wide8192×128 and tall128×8192 probes include nonseparable modes and generic Difference fallback; the wide fallback medians are148.2/147.6ms. The largest observed5ms heartbeat gap across all51 refined configurations is13.18ms, including scheduling/JIT/GC. These measurements include the candidate stage, scalar compilation, output copying and yielding; exclude file decoding, full graph composition and PNG encoding. Work units are conservative admission weights, not an upper latency promise.

`large-probe.mjs` and `large-report.json` cover8192×1000 (8.192MP) at the same all-channel Multiply fallback, with work45*S=368.64million under the proposed limit. All output bytes were verified on all three runs. Median candidate time is2477.3ms; largest5ms heartbeat gap15.68ms. This workload includes large BigInt intermediate numerators and arbitrary non-dyadic-shortcut opacity, rather than assuming fallback is rare.

The independent reviewer separately verified1,179,648 exhaustive Multiply/Screen dyadic cases,29,952 arbitrary IEEE-opacity comparisons and156 Normal legacy cases across all26 filters. Their actual refined helper then passed1,179,648 byte-pair comparisons across18 rational channel modes and204,800 randomized whole-RGB/IEEE-opacity comparisons across all20 rational modes, exercising27,223 generic fallbacks. That oracle uses normalized BigInt fractions and repeated exact doubling to recover opacity, independently of the owner byte ratios and IEEE bitfield extraction. Their independent worst Multiply timing is339–343ms/1MP and342ms wide, with3,145,728 fallback channels per run. No arithmetic blocker remains; see [the independent review](FILTER_BLEND_REVIEW.md). No production file is changed by these probes.

The same700 semantic comparisons and51 benchmark configurations were repeated through the actual production `applyLayerFilters` entry point in `production-probe.mjs`/`production-report.json`. Production1MP medians include Multiply44.1ms, Soft Light107.7ms, Hue235.1ms, Saturation236.1ms, and the two large-numerator all-channel fallback cases353.4/344.5ms. The largest5ms heartbeat gap across those configurations is9.39ms. `production-large-probe.mjs` verifies every byte of the admitted8.192MP fallback image across three runs: median2383.4ms and largest observed heartbeat gap16.60ms. These are measured responsiveness results with bounded loop chunks, not hard scheduler deadlines.

`tests/filter-blend.test.mjs` passes eight owner cases: strict/canonical fields and recipe settings; independent normalized BigInt arithmetic across modes/boundaries/arbitrary IEEE opacities;26kinds×26modes with alpha and candidate ordering; identities without ring/noise-table allocation or changed Normal work; metadata-only native updates and hidden work refusal; real source-alpha/positioned-mask/geometry Bake with undo/portable retention; protected identity and real `ENOTDIR` persistence rollback; and8192-wide all-channel fallback yielding. The independent audit passes nine cases, including generated/protected group/clipping contexts, malformed portable input before reads and every relevant source/Bake invariant. Three schema cases and the official MCP workflow complete21 focused checks. The39 adjacent owner checks include layer filters, Unsharp Mask, Noise and all26 kinds through Bake.

Implementation is in `server/filter-blend.mjs`, the narrow `layer-filters.mjs` integration and native capability/limit descriptions. The helper exports mode constants, `normalizeFilterBlendMode`, `layerFilterBlendWork` and `compileFilterBlend`; compiled rational state stays private. The independent source review caught one leftover prototype diagnostic property, which was removed and pinned by the owner encapsulation check. Recipe canonicalization propagates through its existing call to `normalizeLayerFilter`; no separate mutation or migration was added. Existing `blend.mjs`, clipping, global color and mask algorithms are unchanged.
