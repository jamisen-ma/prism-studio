# Group compositing

Prism groups can pass their contents through to the backdrop or render them as an isolated group. Select a group in Layers and choose **Group compositing**.

| Mode | What happens |
| --- | --- |
| Pass through | Children blend against the layers already below the group. Internal adjustment layers can affect that backdrop. This is the default for new groups and preserves existing projects. |
| Isolated · Normal | Children blend against transparency. Their adjustments affect only the group's own rendered contents. The completed group is then placed over the backdrop. |
| Isolated · another blend | Render the group on transparency, then combine that result with the backdrop using the selected native blend mode. |

Group opacity and its mask affect the completed result once. Children retain their editable masks, filters, content and ordering. Nested groups can mix both modes. The underlying distinction follows the general group-compositing behavior described by [Adobe](https://helpx.adobe.com/photoshop/using/layer-opacity-blending.html); Prism uses its own 8-bit renderer and does not claim Adobe-identical rounding or proprietary blending options.

For example, place a photo over a background and group the photo with an Invert adjustment. Pass through also inverts the background beneath transparent photo regions. Isolated confines the adjustment to the photo group's content.

## Protected content

Changing isolation can affect blend context and low-alpha rounding even with Normal blending. A group containing protected content therefore rejects an actual mode change. Protected descendants also require every ancestor to remain fully opaque with Normal blending. Hidden or masked protected descendants count.

Moving protected content within the same isolation context is allowed. Moving it across an isolated-group boundary requires explicitly removing its protection first. Neutral pass-through wrappers remain usable inside the same context. These guards preserve existing protection; they do not silently unprotect a person to complete an operation.

Generated content, editable filters, adjustments and outside decorations still obey the earlier protected footprint when rendered inside isolated groups. A generated layer cannot use group isolation to cover an earlier protected person.

## Organization and current limits

Nonempty groups can be ungrouped only when set to Pass through, visible, fully opaque and unmasked. Switching those settings can itself change appearance and is an explicit edit. Empty groups can be ungrouped directly.

Cross-document placement and alignment/distribution reject sources or targets beneath any isolated ancestor. Their isolated-layer calculations do not promise the full group's blend context. Numeric layer transforms and the Move tool remain separate operations; groups themselves cannot be transformed, painted, given outside styles, rasterized or placed in this release. Clipping-mask chains remain future work.

Up to eight group ancestors and 64 total layer/group nodes are supported. Isolated groups always need an extra working surface. Masked and translucent pass-through groups also retain working data. Preflight counts five bytes per canvas pixel per such ancestor, including hidden groups, within the shared 256 MiB group/filter scratch budget. This is allocation accounting rather than a bound on total process memory.

## MCP

```js
prism_set_group_compositing({
  backend: 'native',
  documentId,
  expectedRevision,
  layerId: groupId,
  mode: 'isolated',
  blendMode: 'multiply'
})
```

`mode` accepts `pass-through` or `isolated`. Omitted `blendMode` defaults to `normal`; pass-through rejects other blends. The command changes both fields atomically, supports normal retry IDs and transactions, and creates one undo step. Existing `set_layer` can change blending on an already isolated group but cannot silently switch its mode. Check `groupModes` and `groupBlendModes` in capabilities.

Mode, blend and child structure survive undo, redo, reopening and `.prism` export/import. The limited PSD exporter still rejects all groups. Independent fixture tests compare nested soft-mask and opacity results with a separate premultiplied reference; actual MCP tests verify scoped adjustments, blending, protected-change rejection and exact portable output. See [implementation design and acceptance cases](ISOLATED_GROUP_DESIGN.md).
