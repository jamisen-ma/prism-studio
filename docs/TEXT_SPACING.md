# Editable text spacing

Select an editable text layer in **Layers**, or choose **Add text**, to set tracking and line spacing. Text stays editable through undo, reopening and portable `.prism` projects. These controls use the existing font, alignment and layer geometry; they do not change source photographs.

**Tracking** changes character spacing for the entire layer. Its integer unit is one thousandth of the font size: tracking 100 at 100 px adds 10 px through the renderer's glyph-spacing rules. Negative values tighten spacing. The supported range is −1000 to 1000. Set 0 to restore the default.

**Line spacing** is the distance between consecutive baselines. Auto follows the font size at 1.2×; Explicit accepts 1–2000 source pixels, including fractions. Explicit spacing stays fixed when you change font size. Press Enter in the text to author another line; blank lines consume a line step. There is no automatic paragraph wrapping. X/Y positions and explicit line spacing belong to the text layer's source canvas, before its crop, resize or transforms.

Changes commit through **Update text layer**. Changing the selected layer, document or revision discards unapplied drafts. Protected text cannot be edited until its protection is explicitly removed. Tracking and leading are independently advertised capabilities; clients omit unsupported fields.

## MCP

Both `prism_add_text` and `prism_update_text` accept the native spacing fields:

```json
{
  "backend": "native",
  "documentId": "CURRENT_DOCUMENT_ID",
  "expectedRevision": 3,
  "layerId": "TEXT_LAYER_ID",
  "tracking": 25,
  "leading": 142
}
```

The example is an update. For creation, omit `layerId` and provide the usual text, position, font size and color fields. An omitted update field preserves its current value. Reset with `tracking:0` and `leading:null`; Auto is stored as the absence of an explicit leading field. Stable request IDs, revision checks and transactions retain their usual behavior.

Inspect `textSpacingProperties`, `textTrackingUnits` and `textLeadingUnits` in native capabilities. Units are `thousandths-em` and `source-pixels`. The optional Photoshop bridge rejects these native-only fields. PSD editable-text interchange remains unsupported; use `.prism` to retain editable type.

## Scope and verification

Tracking and leading use the existing SVG/font shaping engine. They are whole-layer properties, without pair kerning, mixed character styles, paragraph boxes, font import, OpenType controls or text on a path. Adobe's [line and character spacing reference](https://helpx.adobe.com/uk/photoshop/using/line-character-spacing.html) supplies the familiar units; this implementation does not claim Photoshop-identical typography.

Native, independent pixel, schema and official MCP tests verify zero/Auto identity with older projects, fractional leading, all alignments, blank lines and Unicode escaping, source geometry, rasterization, alpha selections, protection, atomic failures, undo, reopening and portable transfer. Four browser workflows and two independent lifecycle cases verify the controls and stale-create/update recovery. Text changes create no image assets and make no model or provider calls. See [the implementation contract](TEXT_SPACING_DESIGN.md), [pixel audit](TEXT_SPACING_AUDIT.md) and [UI review](TEXT_SPACING_UI_REVIEW.md).

The local example `test-results/autumn-title-layout.prism` combines the previously generated cream autumn background with an editable two-line Fraunces title. `autumn-title-layout.png` is its 1086×1448 export. Source bytes and every background pixel outside the title remain unchanged; the original background document is intact. This demonstrates native type over generated design. The four original photographs were not supplied, so this is not the completed four-person cover.
