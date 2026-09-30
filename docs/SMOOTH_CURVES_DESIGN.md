# Explicit smooth Curves interpolation

Status: implementation approved and backend implemented, 2026-09-19; focused owner and independent acceptance are green. Final production measurements and adjacent checks are recorded below. Smooth pins exact authored knots while preserving the literal legacy Linear branch.

## Scope and choice

Add an explicit **Smooth** interpolation choice to the existing Curves global adjustment and editable source filter. Keep the kind `curves`, value zero, current channel selection and 2–16 control points. Omitted interpolation remains Linear and must run the literal existing linear LUT branch. No existing graph, recipe, layer count, filter kind count or default image changes.

Adobe's Curves workflow maps input tone to output tone through editable points and supports individual channels. This design adopts that workflow, not Adobe's curve algorithm. [Adobe Curves adjustment](https://helpx.adobe.com/photoshop/using/curves-adjustment.html)

Use a native shape-preserving piecewise cubic Hermite rule, based on PCHIP's weighted harmonic interior derivatives and limited one-sided endpoints. The mathematical construction preserves interval shape, including intentional Y reversals and plateaus; natural cubic splines or ordinary Catmull–Rom tangents can overshoot the entered range. PCHIP provides continuous mathematical first derivatives, while second derivatives can change at knots. The finite binary64 implementation and quantized table do not promise exact numerical derivative continuity or exact-real half-tie bytes. [SciPy PCHIP documentation](https://docs.scipy.org/doc/scipy/reference/generated/scipy.interpolate.PchipInterpolator.html), [primary implementation and cited references](https://github.com/scipy/scipy/blob/main/scipy/interpolate/_cubic.py)

An optional parameter is preferable to a separate kind: it preserves the same layer/filter identity, controls, recipe slots and protection behavior. A separate `smooth_curves` kind would unnecessarily split this family. The current native Curves normalizer rejects unknown parameter keys, so explicit interpolation is already a safe old-reader barrier. Unlike an ignored extra layer property, old readers cannot silently render a saved smooth curve as linear.

## Parameters, defaults and compatibility

Persisted parameters:

```js
{ points: [{x:0,y:0}, {x:64,y:46}, {x:192,y:211}, {x:255,y:255}],
  channel: 'rgb', interpolation: 'smooth' }
```

`interpolation` accepts only `linear` or `smooth`. Omitted means Linear. New authoring, reset and ordinary filter/adjustment normalization omit an explicit Linear field canonically; Smooth stays explicit. Reading/validating a valid externally authored explicit-Linear graph does not rewrite it merely on load. Older readers may reject that explicit field too, so canonical omission matters. Legacy omitted-Linear records and recipe bodies remain byte-for-byte stable.

Keep point acceptance unchanged: finite x/y in0..255, 2–16 points, strictly increasing X, first X0 and final X255; arbitrary finite fractional/subnormal spacing remains valid. Y may rise, fall, reverse or stay constant. There is no minimum X gap, precision rounding, forced Y ordering, or automatic point movement. Channels remain rgb/red/green/blue. One point set belongs to the chosen channel; this does not add four simultaneous channel curves to one record.

Native normalization retains its current defaults and merge semantics. Only the new optional interpolation key/enum and its canonical omission are added. Do not tighten legacy point-object/key/prototype acceptance as an unrelated change. The existing public strict point objects remain strict. Proposed shared Curves parameter members `points`, `channel` and `interpolation` become optional, aligning the public API with existing native defaults and allowing interpolation-only/channel-only updates. Final effective points still validate after the retained configuration is merged. A submitted points list replaces the whole list, not individual entries. Null/unknown modes reject; omitted mode preserves a retained mode on partial updates, while explicit Linear clears it. Empty parameters use existing native effective defaults on add and preserve effective settings on update.

Proposed capabilities are `curvesInterpolationPolicy:'shape-preserving-pchip-v1'` and `curvesInterpolationModes:['linear','smooth']`. Existing global/source kind and command gates still apply independently. Missing/unknown new capabilities retain legacy Linear authoring with no new field; Smooth needs the exact policy and recognized mode. A saved unsupported Smooth setting must not be silently converted by unrelated curve edits. No new commands, source kinds, adjustment kinds, recipe slot types or assets are introduced.

## Bounded numeric construction

The existing LUT evaluates only the256 integer input bytes. Smooth compiles a fresh256-byte table once per transform, then the existing RGB channel lookup runs unchanged. Original point metadata stays unquantized.

For interval i, let `h_i=x_(i+1)-x_i`, `dy_i=y_(i+1)-y_i` and conceptual secant `d_i=dy_i/h_i`. Directly calculating d is unsafe: valid subnormal h can overflow even though every final color remains bounded. Instead represent each nonzero secant as sign plus a finite mantissa/exponent pair. Obtain the exact IEEE components of the finite nonzero h and |dy| with one temporary8-byte DataView; normalize subnormals by an exact power-of-two scaling. Store the ratio of their mantissas and the difference of their exponents. Zero dy gets zero tangents.

At an interior knot with like-signed nonzero secants, normalize adjacent interval widths by their maximum and calculate weights:

`wL=(2*hR+hL)/(3*(hL+hR))`, `wR=(hR+2*hL)/(3*(hL+hR))`.

For the tangent's factor relative to a selected interval's secant, compute `f=1/(wTarget+wOther*dTarget/dOther)`. If the slope-ratio exponent is positive, use the reciprocal form `inverseRatio/(wTarget*inverseRatio+wOther)`; otherwise use the direct bounded ratio. The exponent split avoids Infinity/Infinity and zero-times-Infinity. Underflowing negligible ratios become zero under native binary64 rules. Each factor stays in[0,3]. A flat interval or sign change receives zero interior derivative.

For an endpoint, the conceptual derivative is `m=(1+u)*d0-u*d1`, where `u=h0/(h0+h1)`. Compute the factor m/d0 using the same scaled ratio representation; reject opposite tangent direction by clamping to zero and cap the factor at3. A positive overflow in the scaled ratio saturates correctly through that limiter, rather than producing NaN. These are algebraically the standard limited one-sided PCHIP endpoints. With two points the mathematical curve is straight.

On each interval the normalized start/end Hermite factors a,b produce Bezier controls `y0`, `y0+dy*(a/3)`, `y1-dy*(b/3)`, `y1`, with that explicit binary64 operation order. Clamp the two interior controls to the segment's authored endpoint range to remove floating drift. At an interior byte i, use `t=(i-x0)/h` and fixed-order de Casteljau evaluation with `lerp(A,B)=A+(B-A)*t`; clamp the result to that same range before `Math.round` and byte clamp. With factors in[0,3], the mathematical normalized derivative is nonnegative on each increasing segment: it is affine in a,b, and its four square-corner cases are `6t(1-t)`, `3(1-t)^2`, `3t^2` and `3(2t-1)^2`. Decreasing segments follow by sign reversal. Plateaus remain constant. Bounded Bezier controls also keep every intermediate interpolation in the endpoint range.

Pin integer knots before interpolation: if i equals an authored X, emit `Math.round(authoredY)` directly, including endpoints. If every point has x===y, emit exact identity0..255. A two-point curve uses the straight interpolation expression for interior samples and the knot rule at endpoints. **Do not promise universal legacy two-point byte parity.** Example `(0,255),(255,0.49999999999999994)` gives old Linear endpoint1 through cancellation, while Smooth correctly pins the authored endpoint to0. Root explicitly selected this precedence. Legacy Linear remains untouched.

The table is a defined native binary64 result, not a claim that every mathematical rational half rounds identically. Do not add a blanket epsilon or silently move input points to hide one-byte half-tie differences. No runtime inverse CDF, optimization iteration, per-pixel BigInt or growing cache is involved.

## Caller, alpha, masks and protection

Only the selected curve lookup changes. Source filters continue to preserve alpha and skip hidden alpha-zero RGB. Their byte candidate feeds the existing per-entry RGB blend before opacity; the finished stack then passes through its shared source mask before geometry. Smooth identity is still structurally active and can change RGB under a nonnormal blend. Its source work remains1 visit per pixel before the existing +40 blend/+8 stack-mask costs.

Global Curves have a different established hidden-RGB contract: they preserve alpha but grade hidden RGB unless protection or zero mask/opacity amount bypasses the pixel. Preserve this behavior for both modes. **Do not add Curves to COLOR_MAPPING_KINDS**, because that would alter hidden RGB and caller scheduling. Existing global layer masks/density/opacity and protected-footprint handling remain unchanged. Channel isolation, source files, cutout alpha, filters-first geometry, Distort, original-context restoration and generated exclusions keep their current paths.

Bake calls the same source evaluator and keeps its existing exact alpha/source/mask/geometry contract. PSD keeps its current supported-subset/refusal behavior for source stacks and global adjustment layers; this is not native PSD Curves serialization. Portable/history persistence retains explicit Smooth parameters and validates before image reads. The old-reader key rejection works for both source and global records and for stored recipe definitions.

## Recipes and partial updates

Recipe definitions still normalize complete effective points/channel settings. Smooth is explicit; Linear remains omitted so old canonical recipe bytes and hashes do not change. Definition capture/import/save does not need an execution capability; Validate/Apply must respect the Smooth policy on applicable source/global steps and any current target setting that would otherwise be edited without support. Existing masked-stack capture refusal is unchanged; filter-only recipe append preserves the target's whole-stack mask.

There is an important default reset seam: native `update_adjustment` merges submitted parameters with the target. A canonical Linear recipe omits interpolation, so blindly applying it to a Smooth target would accidentally retain Smooth. During **staging execution only**, inject `interpolation:'linear'` into a normalized Curves adjustment recipe step that omits it. The normalizer then clears the field after merge. This transient argument is not stored in the recipe or its hash. Smooth recipes retain explicit mode. Source recipes append new filters, so their effective default naturally starts Linear. This must match an explicit equivalent transaction and preserve one Undo, stable metadata-only Validate, and late-step atomic refusal.

## Resources, helper and UI contract

The numerical helper belongs in environment-neutral `shared/smooth-curves.mjs`, owned with backend numeric implementation. Proposed exports: `CURVES_INTERPOLATION_POLICY`, frozen `CURVES_INTERPOLATION_MODES`, and `compileSmoothCurveLookup(points)` returning a fresh Uint8Array256. Validate inputs defensively. Do not export shared mutable plans/tables. Native color code calls it only for explicit Smooth; the existing Linear LUT code remains literal. UI imports the same compiler for a truthful256-sample preview, while retaining its existing Linear polyline. Neither client nor server performs hidden document writes during compilation.

Setup is bounded by16 points,15 segments and256 LUT samples. The temporary8-byte IEEE decomposition view dies before the retained256-byte LUT is allocated. Small scalar/point arrays are bounded configuration data; no new image plane, ring, persistent table or per-render global cache is added. Curves already owns a256-byte LUT, so existing source work1, caller scheduling and named image-buffer estimates remain unchanged. Existing source/global canvas limits, group/clipping/Distort envelopes, deferred source-mask and Bake phases still apply. This is not a claim that the whole process has only256 bytes of extra memory.

The current curve UI rounds drags to integer positions and clamps any numeric edit using neighbor±1. That can silently move imported fractional X when the user edits only Y. Before supporting Smooth, numeric edits must use exact string drafts, validate strict ordering and change only the requested coordinate; no minimum gap may leak from drag convenience into numeric or persisted state. Add an explicit selectable point list, preserve selected-point ownership through gestures, and guard busy/context/capability changes before accepting pointer updates. The smooth preview should show the actual integer-byte table; authored fractional control points remain visible and editable. Linear defaults, reset and missing-capability behavior must not dirty or migrate saved records.

## Evidence and required acceptance

Owner prototype: `test-results/curves-evaluation/prototype.mjs`; reproducible probe `probe.mjs` and `report.json`.30,042 curves include20,000 random sets,10,000 near-half plateau/reversal sets and subnormal/adjacent-floating X cases. There were no nonfinite tangent factors, out-of-segment bytes, monotonicity violations or integer-knot mismatches. Identity ramps are exact. Ten-thousand-compilation batches measured about0.003ms per common or extreme curve on the current Node22 environment. These are proposal measurements, not production acceptance.

Independent review adds567 curves/145,152 LUT bytes, including36 adversarial two-point endpoints. Across the completed set, exact rational PCHIP differed at520 sampled bytes, all by one and within1.42e-14 of a mathematical half; this is disclosed by the native floating contract. Four Smooth-versus-legacy endpoint differences pin the explicit Smooth/Linear precedence above. See [independent review](SMOOTH_CURVES_REVIEW.md).

Four representative curves have Linear/Smooth photo artifacts under `test-results/curves-evaluation/`: contrast, lift, reversals and plateau. The inspected contrast curve changes234 LUT entries versus Linear with maximum difference6; lift changes228 with maximum5. The underlying photograph is the maintained512² astronaut fixture `test-results/segmentation-public-fixture.png`, SHA-256 `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`. No new dependency, provider or photo download was used.

Before implementation release, maintained tests must cover: exact identity and knot endpoints including the two-point conflict; fractional/subnormal gaps, plateaus/reversals and bounded range; independent normalized PCHIP/byte fixtures; all four channels; unchanged literal Linear output/metadata; partial updates and explicit Linear reset; no-read graph/recipe validation and recipe default reset of Smooth targets; global versus source alpha-zero behavior; source blend/opacity/shared mask/geometry/Distort/Bake; protected/generated/group context; portable/restart/old-reader refusal; real persistence and late transaction rollback; setup/ordinary-process regression timings; UI mode/capability partitions, precise Y-only edits, pointer cancellation, saved-context withdrawal and no mount writes.

## Implemented backend acceptance

The production helper is `shared/smooth-curves.mjs`; `server/color.mjs` selects it only for explicit Smooth and retains the literal Linear LUT loop. Native capabilities advertise the frozen policy and modes. Recipe staging injects a transient Linear reset only for normalized Curves adjustment steps whose canonical parameters omit interpolation. The stored definition and hash remain unchanged.

Maintained owner tests `tests/smooth-curves.test.mjs` pass 8/8. Independent `tests/smooth-curves-audit.test.mjs` passes 8/8, including no image/file/LUT work during metadata validation, canonical recipe reset across masked source and Smooth adjustment targets, both alpha policies, original-context protection, geometry/Bake and actual late rollback. Root reports all 66 schema tests and both official SDK workflows passing. UI and full-suite acceptance are tracked separately by their owners.

The targeted backend closure passes 98/98 in 2.53 s, covering both Smooth suites plus Color Mixer, tonal color, editable filters/blends, recipes, source masks, Bake and the fresh-process legacy Shadows/Highlights regression. Log: `test-results/curves-evaluation/adjacent-tests.log`. Backend ownership is released for the full-suite run.

Production timing is reproducible with `node test-results/curves-evaluation/production-benchmark.mjs`; the JSON report records all samples, output hashes and environment (ordinary Node v22.14.0, macOS arm64, Apple M5 Max). Seven 10,000-compilation batches gave median setup costs of 0.00255 ms for the common curve and 0.00290 ms for the fractional/subnormal extreme curve. There is no new asynchronous setup or pixel scheduling path.

| Production Smooth workload | Source stack median | Global adjustment median |
| --- | ---: | ---: |
| 1024 × 1024 | 14.99 ms | 16.17 ms |
| 8192 × 128 | 14.33 ms | 16.10 ms |
| 128 × 8192 | 18.25 ms | 15.38 ms |
| 6000 × 4000 | 287.53 ms | 332.28 ms |

Linear comparisons remain similar: 14.67/15.97 ms at 1024² and 290.89/331.75 ms at 24 MP. At this initial measurement, the global Curves loop was synchronous: its observed 5 ms heartbeat gap reached 333.44 ms at 24 MP, versus 8.73 ms maximum across Smooth source cases. These are measurements, not latency or RSS guarantees; the Smooth feature preserved caller scheduling and admission. The source/global benchmark uses opaque input so both paths grade every pixel, and hashes agree for matching mode/dimensions. The subsequent scheduling improvement is documented below.

`test-results/curves-evaluation/contrast-production.png` matches the reviewed prototype's decoded pixels exactly. Its PNG SHA-256 is `c22e4c2b95149d7eef05f4388db566415c75086a342e0e163131c9d2fa37d748`. No new image source or provider was used.


## Subsequent global scheduling improvement

The production timing table above preserves the initial implementation measurement. A separate [global adjustment responsiveness change](GLOBAL_ADJUSTMENT_RESPONSIVENESS.md) now yields for all adjustment kinds without changing their numerical or hidden-RGB behavior. It preserves every measured Curves output hash and reduces the 24 MP Smooth loop heartbeat gap from 333.44 ms to 6.28 ms, with a 337.27 ms median, in the documented run. Five focused checks pass. Source processing and the shared curve compiler are unchanged.
