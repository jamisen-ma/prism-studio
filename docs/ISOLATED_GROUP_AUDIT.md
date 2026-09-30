# Independent isolated-group audit

The native implementation passes four independent tests in `tests/isolated-groups-audit.test.mjs`. The implementation owner's broader suite, official MCP integration and browser workflows are separate acceptance checks. No implementation blocker was found in this pass.

## Pixel and resource evidence

- Thirty-six small nested fixtures compare the native renderer with an independent premultiplied pixel reference. They mix isolated/pass-through groups, normal/multiply/screen blending, fractional opacity, masks containing alpha 0/1/64/128/255 and source alpha 0/1/2/64/128/254/255. Every output byte matches.
- An explicit alpha-one fixture demonstrates why protected mode changes must reject: background `[73,118,197,1]`, children `[0,255,201,1]` and `[73,201,182,1]` produce `[48,192,193,3]` with pass-through and `[49,192,193,3]` with normal isolation. Intermediate RGBA8 rounding changes appearance even without a nonnormal blend.
- Hidden protected descendants block actual compositing-mode changes, nonnormal ancestor blending and movement across isolation boundaries. Moving within the same ordered isolated-ancestor chain works. Duplicating an isolated subtree creates independent IDs without treating new leaves as moved originals; reopening retains the graph. Rejected edits preserve project bytes, revision/history and the warm composite-preview cache.
- Lower external protection survives generated content inside a screen-blended isolated group, including an editable invert filter, brightness adjustment and shadow. Protected source pixels remain exact, source bytes remain unchanged, and the generation snapshot mask matches the independently known protected coverage.
- Hidden isolated groups consume five retained bytes per canvas pixel. At 4000×4000, three nested groups account for 240,000,000 bytes and pass; four account for 320,000,000 and reject. One isolated ancestor plus filter scratch accounts for 224,000,000 bytes and passes; two account for 304,000,000 and reject. These checks require no large image allocation or source reads. The 256 MiB limit is accounted renderer scratch, not total process memory.

## Source review

The isolated branch starts with transparent pixels and inherits the lower protected footprint. It composites the completed child canvas once using the group's opacity, mask and blend mode. Newly protected coverage merges back without clearing inherited protection. Pass-through keeps its previous renderer path. Group and filter resource validation share `groupNeedsSurface`, including hidden isolated groups.

Structural transitions compare each existing protected leaf's ordered isolated-ancestor IDs captured before tree edits. Actual group-mode changes separately reject protected descendants, including hidden or fully masked ones. Static graph validation rejects protected descendants under reduced opacity or nonnormal ancestor blending. Empty isolated groups can be removed; nonempty isolated ungrouping requires an explicit mode change first.

Rasterization retains the original layer ID, parent, mask, opacity, blending, protection and editable outside styles. Duplication remaps parent IDs and leaves original protected contexts unchanged. Extraction validates protected ancestor opacity/blending before segmentation or alpha writes. Placement and arrangement reject any isolated ancestor because their individual-layer sampling does not reproduce the group's backdrop-dependent blending.

Explicit subject selection samples an individual unfiltered layer with its own styles/mask and staged ancestor opacity/masks, deliberately excluding backdrop/group blending. It is neither the raw original nor the displayed composite. Composite subject selection uses the rendered document; source and raw-alpha previews remain unchanged. The current isolated layer preview renders the inspected subtree and ancestor contexts without adding sibling image pixels, while filter protection refers to the original graph's earlier protected content.

## Remaining boundaries

Clipping chains, group transforms, group outside effects, group placement/rasterization and Photoshop-identical color arithmetic are not part of this milestone. Protection prevents specified editing operations; it does not make every previously rendered composite pixel invariant under all permitted visibility, mask or background changes. User-facing details are in [GROUP_COMPOSITING.md](GROUP_COMPOSITING.md).
