# Editable tracking and leading

Status: implemented and verified, September19,2026. Owner7, independent7 and official SDK/schema3 tests pass; complete Node suite631 passes. Four browser workflows plus two independent UI lifecycle cases pass, as do baseline and cutout regressions. A separate native title-layout demo retains background source bytes and pixels outside the title. Public controls and scope: [text spacing](TEXT_SPACING.md).

## Purpose and scope

Poster and cover titles need adjustable character spacing and line spacing while remaining editable text. Current native text has font, size, weight, style, alignment and explicit newlines, with a fixed 1.2× line step. Add whole-layer tracking and an optional explicit baseline step. Keep source photographs, masks and existing text untouched unless the corresponding text layer is edited.

Adobe defines tracking in thousandths of an em and leading as baseline-to-baseline spacing. Those units guide the UI; this remains Prism's existing SVG/shaping renderer, not Photoshop's optical kerning or complete typography engine. [Adobe line and character spacing](https://helpx.adobe.com/uk/photoshop/using/line-character-spacing.html).

Do not include paragraph wrapping, mixed styles, pair kerning, font discovery/import, text-on-path, vertical composition, OpenType feature controls or new fonts in this milestone.

## Proposed command and graph fields

Extend existing `add_text` and `update_text`:

```js
tracking?: integer // -1000..1000, thousandths of an em; default 0
leading?: number | null // finite 1..2000 source-canvas pixels; null resets Auto
```

Persist optional `tracking` and optional numeric `leading` only on text nodes. New writes canonicalize tracking0 and Auto leading by omitting their keys. Already-persisted text with explicit tracking0 remains valid and renders identically; validation must not rewrite it. No `null` or `undefined` leading is stored. Missing tracking behaves as 0. Missing leading means Auto, whose step is `fontSize*1.2`. Existing projects render byte-identically when neither property exists; preserve the original operation order for legacy line positions.

On add, omitted/null leading uses Auto. On update, omitted fields preserve the existing value; `leading:null` removes the stored leading. Changing font size rescales tracking because its unit is relative to type size. Explicit leading remains the authored pixel distance; Auto responds to the new font size. A tracking value of0 explicitly resets spacing and deletes the stored tracking key. Both resets require explicit deletion after the merged settings validate: simply omitting a field from `Object.assign` would retain its old value. Never assign `undefined` as a substitute for deletion; portable JSON validation intentionally rejects undefined-valued properties. An omitted partial-update field preserves its authored value.

Reject nonfinite values, noninteger tracking, out-of-range values and misplaced graph fields rather than silently ignoring them. The current native validator and portable codec do not generally allowlist layer metadata. Reserve only these two new fields: nontext nodes carrying tracking or leading reject, while unrelated unknown metadata keeps its existing compatibility behavior. Public commands previously rejected these options, so ordinary old projects are unaffected; manually authored nontext metadata using these newly reserved names will reject explicitly. Do not introduce a broad metadata migration. The Photoshop bridge rejects these new options until that separate integration supports them.

Capabilities: `textSpacingProperties:['tracking','leading']`, `textTrackingUnits:'thousandths-em'`, `textLeadingUnits:'source-pixels'`. Existing text command availability plus these fields gates the UI. Native command count stays unchanged.

## Rendering and geometry

Use numeric SVG `letter-spacing` equal to `fontSize*tracking/1000`, shared by the text layer's lines. Omit this attribute for missing/zero tracking to preserve old output precisely. Do not split strings into codepoints and position glyphs manually: keep the existing shaping, Unicode escaping, alignment and font fallback path.

For each explicitly separated line, the first baseline remains `y+fontSize`. An explicit leading gives line `i` baseline `y+fontSize+i*leading`; Auto preserves the old expression `y+fontSize+i*fontSize*1.2`. Do not precompute Auto into a step variable and then multiply by the line index: `i*(fontSize*1.2)` can differ from the old `i*fontSize*1.2` operation order. The absent-leading render branch must retain the old expression verbatim. Explicit leading uses its separately defined expression. Blank lines count as authored line steps. Tracking and leading operate in the text's source canvas before the existing crop/resize/affine pipeline. They scale with later geometry like the text itself.

Text anchors keep their existing meanings for left/center/right. The shaping engine determines glyph advances and kerning; validate that nonzero letter-spacing behaves sensibly for the bundled font and generic families. Do not claim full script/language support from one successful Latin fixture. Overlapping glyphs/lines and off-canvas text are permitted within existing geometry; no silent resizing, automatic reflow or text clipping rectangle is introduced.

Protected text rejects spacing/content edits using existing `update_text` protection. Duplicates, groups, clipping chains, styles, rasterization, source-oriented selections, previews, undo/reopen and portable projects must all derive from the same updated renderer. PSD editable text remains unsupported; this feature does not change its export policy.

## Native and portable integration

`server/text-spacing.mjs` supplies `normalizeTextSpacing`, `textLineBaseline`, `textTrackingAttribute` and the three capability constants for shared validation and rendering. Native `add_text`/`update_text` owns the merge/reset and still performs all content/protection/coordinate checks before assigning staged settings. Graph validation allows numeric fields only on text; leading null is command-only reset syntax. Render nonzero tracking as a numeric SVG attribute, without any new unescaped user markup.

No portable codec or format revision is required. The codec preserves layer JSON and calls native graph validation before asset processing. Duplicate and history snapshots already deep-copy text metadata. Rasterization replaces the text layer with a raster record, so tracking/leading are baked into its generated working pixels and omitted from the replacement; existing parent IDs, clip links, styles, masks and protection retain their established handling. No source image assets are written by adding or editing these metadata fields.

Existing `update_text` protection runs before edits and already forbids changing protected text. The source-oriented alpha-selection path bypasses only RGB filters; it uses this same text renderer, so new spacing changes its silhouette naturally. Additional masks stay document anchored under text geometry. PSD text remains unsupported, independent of typography settings. The Photoshop bridge must reject any newly supplied tracking/leading, including explicit0/null resets, instead of silently dropping them.

## Resource and numeric limits

No extra whole-image buffer or new render cache is introduced. Existing source canvas limits (8192 per axis/24 MP), 2000-character text limit, fontSize1–1000 and retained geometry budgets still apply. Tracking maps to at most ±1000 source pixels per character. At most2000 authored lines with leading2000 place baselines below roughly4.01million source units, finite and comparable to existing maximum-size Auto text. The existing fixed source canvas clips distant ink; no oversized image is allocated to fit that text. Bounded line/tspan metadata remains far below the existing1MiB generated-SVG reservation used by alpha-selection accounting, and project/history metadata still obey the16MiB cap.

Leading accepts finite fractional pixel values without extra quantization; tracking is an integer in thousandths of an em. Multiplication order is fixed by the render contract, not silently rewritten as a general numeric cleanup. Font shaping, text drawing and legacy geometry retain their existing synchronous/native work limits; this feature does not claim a new typography deadline or worker boundary.

## UI proposal

Add **Tracking, 1/1000 em** and **Line spacing** (Auto or explicit px) to creation and the existing text inspector. Show the current Auto pixel step without storing it as explicit leading. Switching Auto off initializes the current step, and switching it on sends `leading:null`. Avoid silently turning Auto into an explicit value when submitting unrelated settings.

Text edit fields should initialize synchronously from backend/document/revision/layer context. Current TextEditor uses effects to reload fields; review stale draft/undo behavior while adding these controls. A pending submission must capture the original document, text layer and revision. Keep labels and validation compact in the existing inspector; do not create a typography modal for two options.

## Evidence already gathered

A local Sharp/SVG probe used bundled Fraunces at 72 px. Omitted and explicit zero letter spacing were pixel-identical for AUTUMN, AVA, office and A A. AUTUMN visible width changed from 306 px to 342 px at +7.2 px spacing and 288 px at -3.6 px. This demonstrates a usable rendering seam, not complete feature verification or cross-platform font equivalence.

## Acceptance

1. Legacy absent-field and explicit-zero/Auto fixtures remain byte-identical, including multiline default order, spaces, XML characters, combining marks, surrogate pairs and bundled-font text. New fields do not modify image assets.
2. Independent text rendering/layout fixtures verify positive/negative tracking and explicit leading, first-baseline stability, blank lines, center/right anchors and font-size changes. Use monochrome/alpha bounds and independent equivalent SVG references where raster glyph shape comes from the same library; do not call that an independent font rasterizer.
3. New setting persistence and reset: partial update retains the other field, tracking0 deletes tracking, leading null restores Auto and deletes leading, duplicate/undo/redo/reopen/portable preserve editability, invalid fields reject atomically, malformed portable null/nontext fields reject before image processing/writes, protected text cannot change.
4. Clipping/selection/rasterization tests ensure typography drives the same source alpha everywhere. Existing source RGB/protection and text tests remain green.
5. Official MCP validates both commands, defaults/reset, transactions and current revisions. Browser checks create/edit/reset, draft cancellation on undo/target/document switch, long values, capability gating and 900 px layout.
6. Create a separate native title-layout demo using the already-generated autumn background and editable Fraunces text. Do not invent the four missing people or claim it is the user's example cover. Inspect final PNG plus editable project and keep the existing background demo unchanged.

Backend and independent reviewer agreed on the exact ranges, canonical/reset policy, capability names and compatibility boundary above; the implementation now follows that contract. These are native controls, not copied Photoshop limits. The Adobe primary page was independently checked for the thousandths-em and baseline-spacing terminology; the rendering and resource behavior comes from local source inspection and the native contract.

## Verification commands

`node --test tests/text-spacing.test.mjs` passes seven owner checks, including exact legacy SVG output, positive/negative tracking, fractional leading, canonical resets, protected/invalid/stale rollback, source assets and clipping/selection/rasterization parent-link preservation. Reference SVG comparisons independently assemble layout and escaping but intentionally use the same font rasterizer; they are not a second shaping engine. The separate independent audit and official SDK/schema suites exercise additional reference layouts, portable validation and public command behavior.
