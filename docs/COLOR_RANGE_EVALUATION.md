# Bounded Color Range selection proposal

Status: **design assessment only**, 2026-09-19. Root accepted the sampled-RGB direction while Linked Perspective acceptance continues. No production helper, command, schema, capability, UI implementation or registered test is added by this proposal. Root subsequently approved the isolated numerical/photo evaluation below. Numerical/default/photo validation and a final implementation design remain separate review gates.

## Recommended first slice

Add a native **Color Range** selection producer using one to eight explicitly authored RGB8 swatches, full tolerance and a soft falloff. It measures the final visible composite, previews exact prospective coverage, and loads that coverage through the completed selection-combination and adaptive mask publisher. Preserve the existing Magic Wand/`select_color` behavior literally. A tonal-range mode can follow if useful; including it is unnecessary for a complete first color-sampling workflow.

Adobe documents sampled colors, additional/removable samples, adjustable fuzziness, partially selected grayscale previews and inversion. It also offers tonal, skin, gamut and spatial-localization choices. The documentation describes controls, not a numerical color-distance or alpha formula. Use its workflow as context; the proposed native arithmetic below claims no Adobe parity. [Adobe Color Range, updated February 23, 2026](https://helpx.adobe.com/photoshop/desktop/make-selections/freehand-selections/select-a-color-range-in-photoshop.html).

| Candidate | Useful difference from existing tools | Cost and limitation | Recommendation |
| --- | --- | --- | --- |
| Sampled RGB with soft coverage | Select similar visible colors across disconnected regions; include several swatches and retain graded boundaries | At most eight RGB comparisons per measured pixel; encoded-RGB distance is not perceptual and changes with brightness | First slice |
| Encoded-luma interval and falloff | Explicit shadows, highlights or middle-tone selection | A 256-byte ramp and existing luma formula are simple, but it overlaps channel-based tonal selection and adds a second parameter grammar | Later separate mode |
| Perceptual, hue-only or spatial-localized matching | Potentially better hue/brightness discrimination or local disambiguation | New color conversion, achromatic/hue rules or position-dependent support; not justified by the smallest slice | Exclude initially |

The current `server/raster-ops.mjs:selectColorAlpha` compares maximum absolute distance across **RGBA**, produces binary0/255 coverage, optionally flood-fills a four-connected region, and special-cases a transparent seed to select transparent pixels. The new range instead derives soft membership from RGB and then applies each measured pixel's alpha. It has no adjacency queue and no implicit location/radius/segmentation.

## Proposed exact membership

These are candidate names and defaults, not a released schema:

- `colors`: required dense array of one to eight distinct exact seven-character `#rrggbb` strings. Accept either hex letter case and normalize lowercase. Reject duplicates after this normalization; do not silently remove or merge entries. Preserve authored order for display and response metadata. All color comparisons are integer and sample order cannot affect the coverage.
- `tolerance`: integer0..255, proposed default32. This is the maximum per-channel RGB difference receiving full membership.
- `falloff`: integer0..255, proposed default32. This is the additional distance over which membership decreases linearly to zero. The default pair needs actual-photo review before freezing.
- `invert`: Boolean, defaultfalse, applied after source alpha.
- Load additionally takes the existing replace/add/subtract/intersect mode, defaultreplace.

Require strict plain own enumerable data fields and a standard dense array, without coercion, holes, accessors, symbol/hidden fields or custom prototypes. Snapshot the new payload before queueing and before any enclosing transaction schema snapshot. Primitive swatches make ownership small; inputs cannot contain image bytes, paths or a new mask format.

For pixel RGB `R,G,B`, source alpha `A`, swatches `r_j,g_j,b_j`, tolerance `T` and falloff `F`:

```text
D = min_j max(abs(R-r_j), abs(G-g_j), abs(B-b_j))

if D <= T: K = 255
else if F == 0 or D >= T+F: K = 0
else: K = floor((2*255*(T+F-D) + F) / (2*F))

M = floor((2*K*A + 255) / 510)
if invert: M = 255-M
```

All quantities before division are exact small integers. The distance ramp's denominator is at most510 and its numerator less than130305; the alpha product is at most65025. These half-up quotient operations have ample separation from representable rounding boundaries and require no per-pixel BigInt. An independent exact-integer reference must verify that proof before production.

Allow `T+F` above255, up to510. RGB Chebyshev distance itself never exceeds255, so a broad tail may remain positive at the most distant possible RGB value. This is an intentional full-tolerance-plus-width interpretation, not a hidden clamp or validation failure. For example T200/F100 gives K115 at D255; T255 gives full membership everywhere regardless of falloff. F0 is the inclusive hard threshold D≤T; T0/F0 selects exact RGB matches before alpha. At D=T membership is255; at D=T+F it is0.

The operation first unions samples by nearest distance, then rounds membership **once**. Overlapping samples do not add coverage. It next rounds membership times source alpha, matching the channel selection's explicit two-stage policy. A useful discriminator is T0/F4, D1, A2: K191 then M1; fusing the stages produces2 and is not this proposal. Inverting that result produces254. Fully transparent pixels are0 before inversion and255 afterward, independently of hidden RGB. A selected RGB sample is fully selected only at A255; a matching A128 pixel produces128.

This is encoded sRGB byte distance with an axis-aligned cube neighborhood, not linear-light distance, Lab/DeltaE, hue distance or a perceptual fuzziness scale. Expose tolerance/falloff in byte-distance terms. A later comparison with Euclidean or perceptual matching must be a declared different policy rather than changing old saved output.

## Proposed read/load and authoring boundary

Use two separate native commands such as `get_color_range_preview` and `load_color_range_selection`; names are provisional. Both take the complete swatch/range/invert settings. Preview takes optional positive expectedRevision and bounded maxEdge; load requires positive expectedRevision, supports an enclosing positive-revision transaction and returns the ordinary updated document. No new recipe family is needed. The old reader sees only an existing bitmap/alpha8 selection result, never unfamiliar algorithm metadata.

Preview should follow channel preview: a freshly rendered final composite and opaque grayscale membership before active-selection combination, nearest pixel-center sampling, maxEdge32..2400/default700 and encoded PNG at most8MiB. The response should echo canonical settings, exact policy marker, document/revision, source/output dimensions, maxEdge and sampling identity. It should not write an asset, create history, mutate selection or retain a graph-wide preview/table cache. Preview is a bounded view; only Load evaluates all full-resolution pixels.

The active selection never restricts the measured composite. Replace/Add without an active selection use the new candidate. Subtract/Intersect without one refuse before rendering. Existing max/Add, multiplicative Subtract/Intersect and final byte quantization remain unchanged, including continuous geometric-left coverage. The combination result is materialized; explicit all-zero selection must remain an empty mask rather than null/unrestricted coverage. Protected/generated content is measured as already rendered; selection authoring itself does not unlock later protected edits.

Swatches are values, not live references to image coordinates. A color picker, exact hex field and **Add foreground color** are a complete initial authoring path. The existing Eyedropper can set the foreground color first; clearly label the copy as an authored RGB value.

**Source finding:** `sample_color` has no public expectedRevision argument and returns no document/revision identity. `client/useColorSample.ts` captures UI revision/tool/foreground ownership and discards replies after known changes, but this is not an atomic server-pinned sample contract. An alpha-zero sample returns black because its weighted RGB denominator is zero. Do not present that existing read as a new revision-pinned Color Range sample, silently add black to the list after a transparent click, or infer sample validity from foreground hex alone. A dedicated in-panel pick would require a separately reviewed revision-aware read/response and alpha-zero refusal; it is outside the recommended smallest slice. Manual black remains an ordinary valid swatch.

Range draft and preview ownership include document, revision, canonical colors/order, tolerance, falloff, invert, preview size, capability signature and a monotonic epoch. Swatch change/reorder/delete invalidates a preview; selected-layer changes do not retarget this document-scoped operation. Freeze a submitted full draft. Reuse the channel mutation's persistent pending/unconfirmed state and explicit document refresh/inspection; never automatically retry an ambiguous load or claim a durable receipt. Losing a response can have created the new active selection, so closing the panel cannot reset dispatch ownership.

## Resource and publication reuse

Force `validateDenseMaskOperation` for both new commands **even on a graph with no existing dense mask**, and run it before RGB reads. Retain the completed whole-graph surface/callback/source/global/effects ledger and its mask-preparation invocation budget; the new matcher does not relax those admissions or claim total RSS/codec accounting.

Let Q be canvas pixels, P preview pixels and K the authored swatch count. Matching visits are Q×K on Load or P×K on Preview. The authored eight-swatch maximum gives at most192 million full-resolution sample comparisons under the existing24MP ceiling. Count every swatch, independent of early minimum/zero-distance exit, for metadata admission. Do not charge only unique colors after a hidden dedup or assume a cache. A separate explicitly named comparison-work bound and a yield cadence based on sample comparisons should be frozen after a bounded prototype measurement; do not reuse `maxPrepareWork` as if distance evaluations were mask preparations. With at most65536 sample comparisons per batch, an eight-swatch batch visits at most8192 pixels. Existing renderer scheduling remains its own boundary.

The normalized swatches require at most24 RGB bytes. An optional integer membership lookup for D0..255 uses another256 bytes; compile it in the extraction helper **after** awaited rendering, release it with RGB before combination, and account for its280-byte fixed setup reserve. Returning a closure that retains the RGBA buffer into publication is forbidden. The first implementation can use the direct scalar formula if it avoids the table; select that choice only after proving/testing one identical arithmetic policy.

| Phase | Named incremental surfaces beyond the corresponding existing graph phase |
| --- | --- |
| Fresh composite render | Existing forced dense joint graph estimate; only tiny owned scalar settings exist |
| Full extraction | Rendered4Q + candidateQ + at most280 setup bytes |
| Combination | CandidateQ + outputQ + prepared existing-selection callback when applicable; rendered RGB/setup no longer retained |
| Publication | Only final planeQ + incoming raw frame(Q+32) + duplicate-file verification frame(Q+32) =3Q+64; existing count/hash/JSON/history gates |
| Preview sampling | Rendered4Q + bounded grayP + at most280 setup bytes |
| Preview encode/transfer | Existing channel5P + encoded8MiB + bounded base64 transfer reserve; rendered RGB/setup released first |

These phase maxima must be scoped by separate awaited helpers as in `materializeChannelSelection`, not justified by speculative garbage-collector liveness. Add the tiny setup reserve to the actual extraction/preview phase that owns it, not every graph leaf. Publication still validates the candidate known hash, typed alias constraints, prospective retained history and full candidate graph before storage/commit; late failure cleans newly owned links and preserves shared old files.

All output storage and persistence are already implemented: canonical RLE at≤200000 nonzero runs, framed raw alpha8 otherwise; no precision reduction;16MiB project JSON;256 unique/3GiB retained dense-mask references; existing193-asset/256MiB portable bundle bounds. Save selection explicitly to retain a reusable output. No provenance/color-range settings need to be stored beside the mask in the first slice, no new asset walker/consumer/PSD format is introduced, and no disk-GC or total-disk guarantee is added.

## Small integration map and next gate

A later implementation would add one strict shared option/policy contract, one private server membership/extraction/preview helper, native dispatch and two command schemas. Reuse the existing prepared combination, adaptive publisher, command ownership, transaction rollback and channel-shaped response machinery. Root owns shared schemas/status/MCP/SDK; native owner owns the new helper/dispatch/ledgers; UI owner can add a document-scoped section beside `ChannelSelection` with swatches and explicit Preview/Load. Existing `RasterTools`/Magic Wand and the legacy sample read stay unchanged.

Before final design approval: compare actual photographic warm/skin, blue fabric/sky and near-neutral swatches; show hard versus soft coverage and a two-sample union. Do not claim semantic skin/sky detection. Test alpha0/1/2/128/255, exact ramp boundaries, F0, T+F>255, duplicate/case/order behavior and the two-stage discriminator with an independent integer oracle. Probe high-texture/noise to prove adaptive storage is exact, not to retune settings until RLE happens to fit. Verify full-resolution/preview sampled-byte agreement, geometric-left combination, no-selection refusals, forced pre-read budget failures and owned publication rollback. Compare one/eight samples and wide/tall surfaces only in a coordinated timing window. None of this authorizes production before the contract, photographs and resource review are complete.


## Isolated evaluation checkpoint

The candidate lives only in `test-results/color-range-evaluation/architecture-prototype.mjs`; it imports no application modules and is not registered. `architecture-probe.mjs` and `architecture-report.json` record **5,111,808 matching scalar/256-LUT coverage bytes** across one/eight swatches, boundary tolerance/falloff values, both inversion states and15 original-photo coverage planes. Reversing sample order produces identical bytes. Twenty-two malformed settings refuse, accessors execute zero times, and mutating either input settings or separately normalized output cannot change a previously compiled callback.

The original512² photograph remains SHA-256 `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`. Five rows compare warm-orange, a warm skin-colored RGB value, dark blue, a near-neutral value, and the orange/blue two-swatch union. These are authored colors illustrated by known pixel coordinates, not semantic labels or a new live sampler.

- [Coverage comparison](../test-results/color-range-evaluation/architecture-photo-coverage-comparison.png): original, hard32/0, soft32/32 and soft16/32.
- [Dark-matte comparison](../test-results/color-range-evaluation/architecture-photo-matte-comparison.png): the same measured coverage displayed over a constant dark background.

Visual assessment favors keeping32/32 as the candidate default: it removes the hard threshold's gaps across the orange suit and supplies partial edges;16/32 is more selective but retains stronger textured gaps. Neither setting isolates semantic skin or blue objects. The warm skin-colored swatch also includes similarly colored background; the dark-blue32/32 ramp partly includes near-black surroundings because their encoded RGB differences fall inside the declared cube. These behaviors should remain visible and adjustable rather than be hidden behind automatic tuning. Root and independent visual review must agree before the default is frozen.

A separate1MP deterministic full-RGB noise fixture with eight swatches produces315377 nonzero runs. Its exact raw alpha8 frame would be1048608 bytes, exercising the completed dense storage path's intended case without changing thresholds or quantizing coverage. The prototype yields after at most8192 pixels with eight swatches, equivalent to65536 sample comparisons. This is functional evidence only: no production or isolated latency benchmark has run, and the complete native resource/rollback integration remains unimplemented.
