# Independent editable text-spacing audit

Verified September 19, 2026. The independent [typography audit](../tests/text-spacing-audit.test.mjs) passes seven tests against the native [tracking and leading contract](TEXT_SPACING_DESIGN.md). No production change was made by this audit. Browser and MCP verification are reported by their respective owners.

## Pixel and layout evidence

The audit captured the old SVG expression before the renderer changed. Absent spacing fields and explicit zero/Auto resets remain byte-identical across generic sans, generic serif and bundled Fraunces, with left/center/right alignment, fractional font size, XML-sensitive characters, combining marks, surrogate pairs and authored blank lines. The Auto baseline retains its previous multiplication order.

An independently assembled SVG reference checks 36 combinations of all three anchors, negative/positive tracking including both bounds, and fractional/extreme leading. Visible alpha bounds also verify that ordinary negative tracking narrows and positive tracking widens a word. Leading leaves the first baseline unchanged, and an empty line advances by one additional authored step. The reference uses the installed SVG/font renderer for glyph rasterization; it is independent layout construction, not an independent font rasterizer or proof of complete script support.

Tracking and leading remain source-space properties after crop and resize. A fixture manually crops reference pixels, resamples them, and compares the actual text layer and its loaded alpha selection. Its source x coordinate remains valid beyond the new canvas width, with no automatic wrapping or text reflow. No additional image asset is written by these text edits.

## Editing, preservation and rejection

- Partial edits preserve the other spacing property. Tracking zero deletes the authored tracking key; leading null deletes the leading key and restores Auto. Font-size changes rescale tracking while explicit leading remains fixed.
- Duplicate copies are independent. Undo restores authored spacing and pixels. Reopening and `.prism` transfer preserve editable text metadata and render output.
- Editable text remains a clipping base after spacing changes. Composite alpha and a loaded source selection equal the independently rendered glyph alpha. Rasterization preserves the layer ID and clipping links, bakes the same pixels, removes text-only fields and leaves the original photo PNG unchanged. Undo restores the editable text.
- Invalid ranges/types, a stale revision, a failed transaction and an actual persistence-path failure preserve graph, history, revision, assets and preview-cache accounting. Protected text rejects spacing resets and edits.
- Canonical portable bundles containing stored null leading, fractional/string tracking or either reserved field on a nontext node reject before asset processing or publication. Persisted text tracking zero remains valid, and unrelated legacy metadata is not rejected by a new general allowlist.

The inspector review also identified its existing canvas-based X/Y input bounds, which could prevent editing text after a crop despite valid source coordinates. The UI owner agreed to use source dimensions and context-keyed drafts while implementing the controls; browser acceptance remains separately reported.

No new full-image buffer, renderer cache, automatic text bounding canvas or typography worker is introduced. Existing source-canvas, text-length, transform and project metadata limits continue to apply. Font shaping and SVG rasterization retain their existing native execution characteristics. This milestone does not add mixed styles, paragraph wrapping, optical/pair kerning, OpenType controls or editable PSD text.

No native correctness issue remains open from this independent pass.
