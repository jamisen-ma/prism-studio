# Channel Mixer and Gradient Map

Status: native backend implemented after root and independent-review approval. Eight focused backend tests pass; shared-schema, MCP and browser integration are tracked by their owners. This is an additive native milestone using existing adjustment-layer and raster-filter commands, persistence, masks and protection.

## Primary references and declared scope

Adobe describes Channel Mixer as combining source-channel contributions into output channels, with negative/positive percentages, an additive constant and a monochrome option. Its documentation permits source coefficients from −200% to +200%. These concepts support a small editable RGB matrix control; the arithmetic below is an explicit Prism contract, not a claim of undocumented Photoshop numerical parity. [Adobe Channel Mixer](https://helpx.adobe.com/photoshop/using/color-monochrome-adjustments-using-channels.html).

Adobe describes Gradient Map as assigning gradient colors to image tones, with optional reverse and dithering controls. Implement color stops and reverse first; defer dithering, alternate interpolation methods, opacity stops and gradient midpoint/smoothness controls. [Adobe special color effects](https://helpx.adobe.com/photoshop/using/applying-special-color-effects-images.html).

Both references were checked on 2026-09-19. Native working pixels remain 8-bit encoded sRGB. No linear-light, Lab, CMYK, HDR or Photoshop-exact processing is implied.

## Existing commands, new kinds

Add `channel_mixer` and `gradient_map` to both `add_adjustment` and `add_layer_filter`; continue editing through `update_adjustment` and `update_layer_filter`. Both kinds have scalar `value: 0`, exactly like Levels/Curves: parameters perform the operation and the zero value must **not** bypass it. Entry opacity/enabled and adjustment-layer opacity remain the existing strength controls.

Canonical Channel Mixer parameters:

```js
{
  monochrome: false,
  red:   [100, 0, 0, 0],
  green: [0, 100, 0, 0],
  blue:  [0, 0, 100, 0],
  gray:  [21.26, 71.52, 7.22, 0]
}
```

Each row is exactly four finite numbers: red contribution %, green contribution %, blue contribution %, constant %. Every number is bounded −200 through +200 inclusive and must be a canonical 0.01% increment: `Math.round(value * 100) / 100 === value`. Values with finer precision reject rather than being silently rounded. UI inputs use `step=0.01`. Unknown keys, wrong-length arrays, NaN and Infinity reject. Omitted parameters use these defaults; omitted rows use their full default row. The three color rows are retained while monochrome is enabled; `gray` is retained while it is disabled, so toggling does not overwrite custom color mixes. Arrays are owned copies.

Compile each validated percentage row once to integer hundredth-percent units, `R100 = Math.round(R * 100)` (and likewise G/B/C). For input bytes `r,g,b`, a row `[R,G,B,C]` produces:

```text
roundClamp((r*R100 + g*G100 + b*B100 + 255*C100) / 10000)
```

The full signed numerator is an exact integer with absolute bound 20,400,000; no intermediate channel or term is rounded. Half-byte output ties therefore come from exact division of a numerator ending in 5000, avoiding decimal-percentage accumulation drift. Stored values remain the user-facing percentage numbers; compiled units are temporary renderer data only.

Compute every row from the same original pixel, never sequentially from previously changed channels. Clamp once after the full sum to 0–255, then round to the nearest integer using the existing nonnegative byte convention. In color mode use the respective three rows. In monochrome mode compute the `gray` row once and repeat it in all channels. Coefficient sums need not equal 100; never silently normalize them. The identity color default must preserve every RGBA byte. A −100% coefficient with +100% constant can invert a channel; pure negative coefficients can clip to black. The chosen default grayscale weights are a declared native choice, not an Adobe preset claim.

Canonical Gradient Map parameters:

```js
{
  stops: [
    { offset: 0, color: '#000000' },
    { offset: 1, color: '#ffffff' }
  ],
  reverse: false
}
```

Accept 2–16 owned stops, finite offsets within 0–1, strictly increasing, with exact endpoints 0 and 1. Accept only six-digit hex colors, normalize their casing, and reject unknown stop fields. No opacity field is accepted: this tool changes RGB only. Omitted parameters use black-to-white and reverse false. Unlike the identity mixer default, the default Gradient Map converts color to grayscale.

Compute tone without prematurely quantizing it to a byte:

```text
n = 2126*r + 7152*g + 722*b
t = (reverse ? 2550000 - n : n) / 2550000
```

The integer coefficient sum is 10000, so black and white produce exact endpoints. Reverse complements the integer numerator before division: computing `1 - n/2550000` instead can shift exact half-byte ties downward (for example RGB [0,177,68] must map to reverse gray 124). Locate adjacent stops by bounded binary search on the original finite offsets, returning exact authored stop colors when `t` equals their offset. For interpolation, compile stop positions `offset * 2550000` once and form a weighted byte numerator before one division by the interval; avoid early tone division in the color expression, which can move exact half-byte ties below the rounding threshold. If distinct authored offsets collapse to an equal scaled position, fall back to their original finite spacing. Arbitrary finite offsets retain declared native floating-point interpolation. Round/clamp each result once. A stop exactly at the sampled tone produces its exact color. Do not quantize tone through a 256-entry lookup: that changes results at closely spaced stops. This interpolation is described as native encoded-sRGB interpolation; Adobe method names such as Linear/Perceptual/Classic are not used.

## Update and validation semantics

The existing native update path merges parameter objects shallowly. Retain that explicit rule: replacing `red` replaces the **whole four-value row**; replacing `stops` replaces the whole ordered list; changing only `monochrome` or `reverse` preserves other current fields. UI sends complete edited rows/lists. No index-level patch language is added.

Creation may omit parameters for defaults. Partial parameter objects are valid for these two kinds when every supplied row/list is complete. Empty parameters mean defaults on creation and no parameter change on update. Engine normalization always emits the canonical complete object. Shared schemas must validate the matching kind on creation; update commands lack a kind, so validate the syntactic parameter family there and let the persisted target kind determine the allowed family before mutation. Unknown fields must never disappear through permissive parsing. Existing Levels/Curves forms and acceptance remain compatible.

Graph validation normalizes/validates the new parameter objects on reopen/import as well as command handling, but must not mutate the caller's graph during validation. `value` must equal zero on creation, update and import; out-of-range values must fail before publication. Commands retain current revision, transaction and retry semantics.

## Alpha, selection, protection and composition

- Every alpha byte remains exact. Raster-filter execution already skips zero-alpha pixels; retain that behavior and their invisible RGB. For the **two new global kinds**, skip zero-alpha input pixels too. Avoid changing established invisible-RGB behavior of unrelated legacy adjustments as part of this milestone.
- Adjustment layers run on the current composite at their stack position, use their captured/explicit mask and layer opacity, and respect lower protected footprints. Isolated groups scope them as usual. They cannot be clipping-chain members because the initial chain contract excludes adjustments.
- Filter entries run in source space after the separate source alpha and before geometry, in existing filter order. They ignore the active document selection and use entry opacity/enabled. Disabled entries and opacity zero bypass exactly. Source images and alpha assets are never rewritten.
- Existing contextual protection renders unfiltered/filtered geometry and restores original RGB at lower protected footprints; no new exemption is introduced. Protected targets cannot edit their stack, and enabled entries still prevent enabling target protection even when mixer parameters happen to be identity. Identity detection must not circumvent the simple existing protection rule.
- Raster filters may operate on unprotected clipping bases/members, retaining the chain's base-alpha-once policy and its suppression of upper color contributions at inherited protected pixels. Isolated member/base preview context must agree with the currently audited clipping rules.
- Source/raw-alpha previews and source-oriented `select_subject(layerId)` remain unfiltered. Composite previews, histograms, exports and generation snapshots see the actual adjustment/filtered result. No model/provider call is required to implement or test these tools.

## Work and memory bounds

Validate canonical 0.01% precision and compile integer hundredth-percent rows and gradient colors once per transform creation; do not parse hex or allocate stop tables per pixel. A 16-stop gradient needs at most four binary-search decisions. No full-canvas candidate image is needed beyond existing filter/adjustment output buffers. Keep the 24 MP/8192 axes, eight filters per layer, 64 filters per document, existing combined group/chain/filter scratch cap and 16 MiB project metadata bounds.

Implemented conservative weighted filter work: mixer `3 * sourcePixels`, gradient map `5 * sourcePixels`, only for enabled entries with nonzero opacity, including hidden targets. Keep the total existing 384-million work cap. This is an accounting bound rather than a CPU-time promise; a 24 MP gradient filter uses 120 million units and three such entries fit. No per-kind exception to source/geometry scratch is needed. The transform closure stores only a handful of bounded arrays, not a 256³ color table.

The two new global transforms yield after each 32-row batch. Existing global adjustment arithmetic and invisible-RGB behavior are unchanged; the common loop gained only a new-kind yield and new-kind zero-alpha skip. Raster filters continue yielding through their existing loop. Do not add a process-wide resource claim: current limits bound accounted buffers/work, not total RSS or all sharp allocations.

## Concrete integration inventory

| Surface | Required work |
| --- | --- |
| `server/color.mjs` | Add `ADJUSTMENTS` ranges `[0,0]`, canonical normalization and transform factories. Consider exporting the parameterized-kind list to avoid a new scattered zero-value rule. Keep strict unknown-key checks. |
| `server/native.mjs` | Exempt both kinds from the scalar `value === 0` early return in `applyAdjustment`; new-kind invisible-RGB preservation/yielding; dynamic `adjustmentKinds` gains both. Update numerical limitations and hardcoded count prose. |
| `server/layer-filters.mjs` | Derived supported kinds automatically gains both once `ADJUSTMENTS` does; update weighted `filterWork`. Existing cloning, validation, source alpha, protection, opacity and geometry code must remain the path used. |
| `shared/commands.mjs` | Extend both kind enums/range maps and parameter families; replace the `Only levels and curves`/`black in parameters` dispatch assumption. Support whole-row/list partial updates without confusing empty parameter objects with another kind. Keep Photoshop unsupported guards explicit even when parameters are omitted. |
| `server/mcp.mjs` and status | Existing commands inherit schemas; descriptions explain percentages/row order, explicit mono row, stops, native RGB interpolation, `value:0`, selection scope and source-space filters. Capability arrays are dynamic; no new command or endpoint needed. |
| `client/api.ts` | Add parameter types to `Layer` and `LayerFilter` unions; no document root fields. |
| `client/ProPanels.tsx` | Extend parameterized color editor dispatch currently restricted to Levels/Curves. Add a selected output-row editor, monochrome/gray controls, row totals, reset, gradient stops and reverse. Capability-gate both. Do not feed these kinds through a zero-disabled scalar slider. |
| `client/LayerFilters.tsx` | Extend allowed kind list, labels/defaults/validation, parameter inclusion currently gated to Levels/Curves and editor selection. Reuse color editors to keep row/list semantics identical. |
| `client/App.tsx` | Ensure parameterized tools have creation controls independent of scalar adjustment `value` truthiness. Existing selection notice applies to adjustment layers, not raster filters. |
| `.prism` and persisted projects | No codec or format version change: existing graph validation and JSON preservation cover new parameters. Add malformed-bundle-before-write cases and undo/reopen/portable tests. |
| Strict PSD export | Remains unsupported: adjustment layers already reject by type and raster stacks reject even when disabled. Do not flatten either feature silently or advertise PSD-native mixer/gradient records. |
| Photoshop bridge | Leave its supported scalar adjustments unchanged. Parameterless `channel_mixer`/`gradient_map` requests must reject by kind, not accidentally pass because `parameters` is absent. |
| Tests/docs/catalog | The native totals become 22 adjustment kinds and 20 raster-filter kinds. Update assertions/UI discovery only after checking capability lists, not by assuming every backend supports them. |

## Acceptance before release

1. Independent exact fixtures for identity, channel swap, monochrome, negative/oversized coefficients, constant clipping and full-sum-before-clamp; randomized canonical 0.01% inputs use an independent integer/rational reference and exercise positive/negative half-byte ties. Finer-than-0.01% values reject without quantization.
2. Gradient black/white endpoints, exact interior stops, non-byte-aligned tone, reverse, default grayscale and 16-stop search; unequal stop intervals are not treated as equal-width bins.
3. Alpha 0/1/128/255 and invisible RGB remain exact; identity mixer, disabled/opacity-zero filter and zero mask coverage preserve original byte arrays. A new-kind `value:0` visibly works.
4. Partial row/list updates preserve unrelated parameters and stable IDs. Wrong family/unknown fields/NaN/range/percentage precision/row length/missing endpoints/duplicate offsets reject with no revision, history, cache or asset changes.
5. Adjustment mask/selection capture and opacity; filter source-space order before geometry; lower protected footprints, generated/ordinary clipping members and isolated previews agree with independent expected bytes.
6. Hidden high-cost stacks fail total work preflight before pixel allocation or persistence; all old combined group/chain/filter scratch cases remain valid. Verify updated weights without constructing huge rendered buffers.
7. Original assets, alpha assets, source previews and raw subject input stay byte-identical. Undo/redo, reopen, `.prism` import/export and source protection are unchanged. PSD and Photoshop bridge reject explicitly.
8. MCP uses the existing four commands, revision guards and one-step transactions. Browser can create, edit, toggle monochrome/reverse, modify one row/stop set, reorder/bypass filters, undo, reopen and work at compact viewport sizes. Invalid UI values do not dispatch mutations.

Root and independent review approved the parameter names, canonical 0.01% mixer precision, integer arithmetic, gradient interpolation and work weights before implementation. `tests/color-mixer.test.mjs` passes eight focused tests, including 2,000 independent BigInt mixer fixtures, forward/reverse half-byte regressions with non-default colors, extremely close exact-stop routing, sub-byte narrow stop ranges, alpha/invisible-RGB preservation, exact bypasses, mask/protection scope, partial parameter updates, source/undo/reopen/portable retention, rejected edits and hidden weighted-work preflight. No model, credential or provider call was used.
