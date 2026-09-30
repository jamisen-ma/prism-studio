# Color Balance and Black & White

Implemented native backend, 2026-09-19. The standalone arithmetic passed independent numerical review before integration. Owner tests verify native adjustment/filter/recipe behavior; independent native and browser acceptance are tracked separately below.

The objective is two editable photographic adjustments, also available in raster filter stacks and saved recipes. Color Balance separates shadows, midtones and highlights. Black & White controls how six input hue families become gray and optionally applies a tint. Source files, alpha and protected RGB keep the existing adjustment/filter guarantees.

Adobe documents three tonal ranges with opposing color sliders and a luminosity option for [Color Balance](https://helpx.adobe.com/ca/photoshop/using/applying-color-balance-adjustment.html). Its [Black & White workflow](https://helpx.adobe.com/photoshop/desktop/adjust-color/color-effects-techniques/convert-a-color-image-to-black-and-white.html) exposes color-dependent gray mixing and optional tint. These establish useful controls, not proprietary numerical parity. The native mappings below must be named and tested as Prism's own encoded-sRGB algorithms.

## Command surface and persistence

Add `color_balance` and `black_white` to existing adjustment/filter kind lists. Both use `value:0` and typed parameters; no new mutation command is necessary. They work through add/update adjustment and add/update filter, with the existing mask, opacity, source-coordinate, protection and stack rules. Canonical settings include every supported field. Omitted partial updates retain existing settings through the current merge path; new layers and recipe definitions fill omitted fields with deterministic defaults.

Do not change the behavior of existing grayscale, saturation, temperature or Channel Mixer. Keep the new helper separate from the existing transforms where that reduces numerical regression risk. Reusable recipes automatically inherit the new typed kinds but still require a declared fixed adjustment kind and complete canonical settings. Old readers reject unsupported kinds rather than guessing.

Canonical native parameters:

```js
// color_balance
{
  shadows: [0, 0, 0],
  midtones: [0, 0, 0],
  highlights: [0, 0, 0],
  preserveLuminosity: true
}
// Each row: cyan/red, magenta/green, yellow/blue.
// Each number: -100..100 percent in exact 0.01% increments.

// black_white
{
  reds: 40, yellows: 60, greens: 40,
  cyans: 60, blues: 20, magentas: 80,
  tint: false, tintColor: '#b98952', tintAmount: 100
}
// Six gray-mix values: -200..300 percent in exact 0.01% increments.
// tintAmount: 0..100 percent in exact 0.01% increments.
// Tint color is #RRGGBB; canonical lowercase. Retain tint settings while off.
```

Validate finite values, exact row lengths, unknown keys and conditional kind membership in shared schemas and native normalization. No `NaN`, sparse arrays, numeric coercion or silently ignored parameters. Sparse persisted parameters remain valid according to the current normalization model and are presented with effective defaults in the UI. Canonical writes must deep-copy input arrays/objects.

The precision predicate is the existing mixer convention, `Math.round(value * 100) / 100 === value`; reject extra precision rather than quantizing it. Compile accepted values once to integer hundredth-percent units. A supplied Color Balance row always contains all three channels; partial updates replace whole supplied rows while omitted rows and the preservation flag retain their prior values. Black & White updates merge individual named fields, including disabled tint settings. An absent parameter object or empty creation object selects complete defaults. Null parameter objects/fields are invalid. Canonical writes include every field and lowercase tint color; no layer/target-dependent defaults remain in saved recipes.

## Color Balance algorithm

For each byte RGB input, compute encoded-sRGB luma with integer numerator `L=2126R+7152G+722B`, denominator `D=2550000`. The tone weights are triangular and form a partition of one:

```text
shadow numerator = max(0, D - 2L)
highlight numerator = max(0, 2L - D)
midtone numerator = D - shadow numerator - highlight numerator
```

Rows use signed hundredth-percent integers. Let `W_i=sum(weightNumerator * rowInteger)` for each channel. Tone weights come from the input pixel, not partially adjusted channels. Since `D=255*10000`, cancel the leading 255 in the original shift expression before further luma calculations:

```text
shift_i = 255*W_i/(D*10000) = W_i/100000000
A_i = inputChannel_i*100000000 + W_i
desired_i = A_i/100000000
```

All these numerators are exact Number integers. Each `|W_i| <= 25,500,000,000`, and `A_i` lies in `[-25,500,000,000,51,000,000,000]`. This cancellation matters: carrying the uncancelled desired numerator into a subsequent weighted-luma sum can exceed `2^53`, even though the initial shift sum itself fits.

When preserving luminosity is off, clamp and half-up round `A_i/100000000` once. Do not divide the shift first and add it separately. The rational step is at least `1e-8`, so bounded byte-range floating division cannot turn a non-tie into a neighboring half-byte; exact half ties remain exactly representable. All-zero rows, and per-pixel all-zero effective `W_i`, return input RGB exactly.

When it is on, form the unclipped desired RGB and subtract its encoded-sRGB luma to obtain a zero-luma chroma vector. Center that vector on a neutral triple at the input luma. Scale the vector by the largest common factor from 0..1 that keeps all three channels inside 0..255, then add to that neutral triple and round once. A positive component constrains the factor by `(255-inputLuma)/component`; a negative one by `-inputLuma/component`. All-zero effective shifts return the input directly. This preserves input encoded-sRGB luma before final byte rounding and compresses desired chroma near gamut limits. Centering at the target neutral avoids a directional clamp at the original RGB, which could make useful edits vanish on saturated colors. It does not claim perceptual or linear-light luminance preservation. Black/white remain unchanged in this mode; gray midtones can change color.

Compile the centered chroma without floating cancellation:

```text
T = 2126*A_red + 7152*A_green + 722*A_blue
C_i = 10000*A_i - T
chroma_i = C_i/1000000000000
targetLuma = L/10000
```

`T` and `C_i` stay exact integers; conservatively `|C_i| <= 765,000,000,000,000 < 2^53`. Test gamut membership using the exact integer `L*100000000 + C_i` against `0..255000000000000`. When all channels fit, divide that integer by `1e12` and round once. Its minimum nonzero rational distance from a half-byte is `1e-12`, greater than byte-range Number rounding error. No BigInt is needed for identity or this in-gamut branch.

For a compressed channel, define `gap_i = 2550000-L` when `C_i>0`, and `gap_i=L` when `C_i<0`. The common factor is the minimum of `1` and `gap_i*1e8/abs(C_i)`. The numerator and denominator of each ratio are individually exact safe integers. Compute the common factor and output estimates with doubles; do **not** select a source-direction clamp.

Near a half-byte, recompute exact rational output instead of adding an epsilon:

1. Use a conservative decision guard `64 * Number.EPSILON * 255` (approximately `3.63e-12`) around any output `k+0.5`. This guard only selects the exact path; it never changes a color value.
2. For that pixel, compare the candidate `gap_i/abs(C_i)` ratios with bounded BigInt cross-products to choose the exact minimum. The common `1e8` factor cancels. Equal ratios produce the same rational factor; use channel order only as a stable tie convention.
3. If the minimizing candidate is `(gap,q=abs(C_j))`, each exact fitted channel has numerator `L*q + C_i*gap` and denominator `10000*q`. Clamp and half-up round using integer arithmetic. Convert only the final 0..255 integer to Number. Products are fixed-size values derived from bounded byte/control inputs; no input-driven loops or unbounded cache exist.

Error-bound rationale for the fast path: all pre-division integers are exact. Let `u=2^-53=Number.EPSILON/2`. Each ratio and chroma division has relative error at most `u` for these normal finite values. After the exact black/white fast paths, any active factor is at least `722*1e8/765e12 > 9e-5`, so underflow is irrelevant. Taking the minimum of correctly rounded positive candidate ratios yields the rounded exact minimum by monotonicity; choosing a neighboring constraint whose float ties does not enlarge the factor error. If exact fitted chroma is `w=c*factor`, then `abs(w)<=255`. Chroma division, factor division and multiplication together contribute at most `255*((1+u)^3-1)`. Target-luma division contributes at most `255u`; the final addition contributes at most `(255 + priorErrors)*u`. Their total is below `6*255u` (about `1.70e-13`) with these bounds. The decision guard `64*EPSILON*255=128*255u` deliberately exceeds this derived bound by more than 21 times, allowing a conservative margin without biasing output.

Therefore a channel farther from every half-byte than the guard has the same integer rounding as the exact rational result; a closer channel triggers recomputation of the **whole pixel and constraint choice**. Independent references must challenge this bound with near-equal factors and rational half ties. Do not replace the argument with empirically chosen output bias.

At full transform strength, final encoded-luma error is at most half a byte because channel rounding errors are bounded by one half and the positive luma coefficients sum to one. This is a statement about the transform output, not an additional guarantee about later mask/opacity/blend rounding. Default identity remains exact. Benchmark both common and deliberately tie-heavy 1 MP inputs before selecting the final filter work weight: an authored repeated tie can trigger BigInt for every pixel.

## Black & White algorithm

Let `low=min(R,G,B)`, `high=max(R,G,B)`, `C=high-low`. If `C=0`, the untinted gray output is the original neutral value. Otherwise locate RGB hue on six sectors: red, yellow, green, cyan, blue, magenta, wrapping to red. Derive the sector and integer distance using channel differences rather than converting to an angle and back:

```text
if max is R: H = G-B; add6C when negative
else if max is G: H = B-R+2C
else: H = R-G+4C
sector = floor(H/C)       // 0..5
distance = H-sector*C     // 0..C-1
```

Tied maxima land exactly on a sector boundary. With hundredth-percent control values `a` and `b` at the surrounding hue anchors:

```text
gray numerator = low*10000 + (C-distance)*a + distance*b
gray = clamp(round(gray numerator/10000), 0, 255)
```

This formula has exact integer arithmetic through its final division and continuous hue interpolation around the wheel, including magenta→red. Negative and over100% coefficients are meaningful and clamp only once. It is a declared hue-weighted conversion, not a claim to reproduce Photoshop's defaults pixel for pixel.

Tint starts with the rounded gray RGB triple. Compute the chosen color's zero-luma chroma direction by subtracting its encoded-sRGB luma from each channel. Fit that direction around the neutral gray pixel using the same common-factor rule as Color Balance, then multiply by `tintAmount/100`. Add to the gray triple and half-up round. Tint off or amount 0 returns the exact untinted result. A neutral tint has no effect. Black and white stay neutral; the tint's hue/chroma affect intermediate grays while retaining the **converted gray's** encoded luma before rounding, not the original color's luma.

Tint can share the mathematical gamut policy while avoiding BigInt entirely. For tint byte channels `t_i`, compile `Ct_i=10000*t_i-(2126*t_r+7152*t_g+722*t_b)`. For gray `g`, in-gamut values satisfy `0 <= g*10000+Ct_i <= 2550000`. Let `a=round(tintAmount*100)`:

```text
No gamut compression:
  output_i = round((g*100000000 + Ct_i*a)/100000000)

Compression:
  choose minimum gap_i/abs(Ct_i), with gap_i=(255-g) or g
  output_i = round((g*10000*q + Ct_i*gap*a)/(10000*q))
```

Constraint cross-products and final numerators are exact safe Number integers (`abs(Ct_i)<=2550000`, final numerator conservatively below `1.4e13`). Clamp and round once. The minimum rational step remains well above byte-range division roundoff. No HSL/HSV conversion, second RGB image, per-pixel cache or full-frame allocation is needed. A helper module may share normalization and arithmetic utilities while keeping this cheaper exact tint branch distinct from Color Balance's compressed BigInt fallback.

## Engine and UI integration

- The existing scalar transform path handles RGB. Add both kinds to `PARAMETERIZED_ADJUSTMENTS` so `value:0` is functional and to `COLOR_MAPPING_KINDS` so global adjustments preserve zero-alpha RGB. Color Balance yields after `min(32, max(1, floor(65536/width)))` rows in both global and source-filter paths, at most 65,536 pixels between yield points; other mappings retain 32-row yields. Filter evaluation already preserves source alpha/zero-alpha RGB. Do not create a separate compositor or bypass protected footprints, adjustment masks, density, clipping, isolated groups or contextual filter restoration.
- Filter admission weights are **40** for Color Balance with luminosity preservation, **10** without, and **7** for Black & White, including tint. The eight-per-layer/64-per-document and 384-million weighted source-pixel bounds remain. One preserved Color Balance source filter therefore supports at most **9.6 MP** when it consumes the entire work budget; this is not a blanket 24 MP filter promise. Hidden layers count. Disabled/zero-opacity entries cost zero, and partial preservation-flag updates revalidate the complete graph before assignment. Global adjustment layers retain existing canvas limits. No additional full-frame scratch is needed; fixed-size BigInt work is synchronous within each bounded yield interval.
- Expose kinds in capabilities and existing command schemas. Add explicit MCP descriptions of encoded-sRGB tone/hue semantics and preservation scope. The optional Photoshop bridge rejects these unsupported kinds.
- Use one shared client control component for each adjustment in Color workbench and Layer Filters. Context-keyed drafts reset synchronously on document/revision/layer/backend/capability changes. Missing or sparse persisted parameters show defaults without writes.
- Color Balance offers Shadows/Midtones/Highlights tabs retaining all three rows, three opposing labeled sliders with numeric fields and Preserve luminosity. Explain that the preservation refers to encoded-sRGB luma and may reduce shifts near gamut edges.
- Black & White offers six labeled color sliders with numeric fields, Tint, a color input and tint strength. Disabling Tint retains its authored values. A reset affects the local draft until the user applies it.
- Creation uses the current selection as the ordinary adjustment mask. Filter addition ignores the active selection as usual. Editing an existing adjustment retains its current mask and parameters not changed by the submitted partial update.
- Saved recipes must capture/replay complete new parameters and preserve disabled tint settings. PSD export retains its existing strict rejection of adjustment layers/filter stacks; `.prism` preserves everything.

Actual integration seams: `server/color.mjs` owns kind/range/parameterized/color-mapping lists and normalization/transform dispatch; `server/layer-filters.mjs` derives supported kinds and owns weighted work; native add/update/validation already call those helpers. Global `applyAdjustment` must see the expanded color-mapping set. Recipe normalization already delegates to `normalizeParameters`/`normalizeLayerFilter`, so full canonical defaults require no target merge or new recipe step type. Shared schemas, bridge support lists, MCP descriptions, client kind/default/editor tables and any hardcoded discovery counts must be updated together. The discovery counts are 24 adjustment kinds and 22 filter kinds. New kinds, stored rows and tint metadata remain incompatible with old readers through the existing unsupported-kind rejection.

## Independent acceptance

1. Color Balance all-zero identity for every gray and seeded RGB values, each tone/channel separately, signs, bounds and partial/canonical defaults. Without luminosity preservation compare against an independent integer/rational oracle, especially final half ties.
2. Luminosity-preserving output stays in gamut, preserves black/white and obeys the declared luma-error bound; test saturated/extreme colors, opposing rows and factors at0/1. Use independently written references rather than calling production helpers.
3. Black & White exact gray neutrality, six pure hue anchors, sector boundaries/ties, wraparound, equal controls, extreme negative/positive mixes and half ties. Compare thousands of seeded byte triples against an independently calculated reference.
4. Tint off/zero/neutral identity, black/white, retained disabled tint configuration, hue direction and luma bound. Test lowercase color canonicalization and invalid controls.
5. Native adjustment and filter paths match shared declared pixels; alpha0/1/128/255, outside masks, lower protected content and protected-target guards remain exact. Metadata edits write no source assets.
6. Filter order/opacity, disabled entries, work-limit failure, one-step transactions/rollback, `.prism`, reopen and recipe capture/replay use canonical independent settings.
7. Actual browser creation/edit/filter workflows, invalid drafts, sparse persisted defaults, reset, changing tone tabs, tint retention, stale revisions, delayed responses, capability omission and compact layout. Inspect real image output as well as controls.

Final public scope must distinguish native behavior from Adobe compatibility and report measured checks, without claiming RAW, high-depth color, perceptual calibration or broader Photoshop parity.

## Backend verification and measured work

`tests/tonal-color.test.mjs` contains six pure checks against independent uncancelled BigInt arithmetic, including 10,800 Color Balance and 6,300 B&W/tint fixtures. `tests/tonal-color-native.test.mjs` contains six native checks: exact half ties and hue pixels; alpha/invisible RGB; coverage/density/protected pixels; selection scope; partial parameters; stable filter IDs; source files; undo/reopen/portable state; complete recipe defaults; hidden-source budget boundary and partial-update rejection; stale/invalid/persistence rollback; and actual yield delivery at width 8192. Existing Mixer, filter and recipe regressions are also run. Independent review evidence is recorded in [TONAL_COLOR_REVIEW.md](TONAL_COLOR_REVIEW.md).

Reproducible benchmark scripts and JSON results are in `test-results/tonal-color/`. They ran on Node v22.14.0, darwin arm64, Apple M5 Max with 18 logical CPUs. These are local measurements, not throughput or latency guarantees.

| Standalone transform, 1,000,000 pixels | Median of three runs |
| --- | ---: |
| Color Balance, representative controls, preserved | 221.606 ms |
| Color Balance, representative controls, unpreserved | 131.389 ms |
| Color Balance, every pixel an exact-half fallback | 549.168 ms |
| Black & White | 48.108 ms |
| Black & White with tint | 81.383 ms |
| Existing Channel Mixer reference | 38.757 ms |
| Existing Gradient Map reference | 60.824 ms |

The deliberately repeated tie family `[r,89,r]`, `r=0..31`, with every tone row `[100,-100,100]` has exact output `[r+224,0,r+224]`. The native benchmark additionally verifies every RGBA byte over an 8192×128 image (1,048,576 pixels), through the actual global adjustment and filter loops. With eight-row yields, global runs took 496–506 ms and filter runs 493–500 ms; each delivered 15 heartbeat callbacks. The largest observed gap of a 5 ms timer was 62–75 ms. Event-loop scheduling can span more than one yield interval, so the bounded pixel interval is not a strict timer-latency promise. No filesystem, decode, graph composition, provider call or per-pixel cache participates in these measurements.
