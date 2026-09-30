# Photoshop tool inventory and Prism coverage

Research date: September 18, 2026. Adobe desktop documentation is the reference. Names include nested toolbar tools; deprecated 3D tools are excluded. A toolbar inventory is not full Photoshop parity: menus, filters, formats, color pipelines, and automation are tracked separately below.

The application reads `shared/tool-catalog.json`. `partial` means a working core implementation with the stated limits, not Photoshop-equivalent behavior. `planned` means unavailable. Actual backend capabilities also control access.

| Category | Tool | Prism status | Scope |
|---|---|---|---|
| Selection | [Move](https://helpx.adobe.com/photoshop/desktop/make-selections/get-started-selections/selection-tools-overview.html) | partial | V drags selected visible content with integer translation and one undo; numeric translate, rotate, scale and flip also available. Masks stay document-anchored. |
| Selection | [Rectangular Marquee](https://helpx.adobe.com/photoshop/desktop/make-selections/get-started-selections/selection-tools-overview.html) | partial | Rectangular selection with feather and inversion. |
| Selection | [Elliptical Marquee](https://helpx.adobe.com/photoshop/desktop/make-selections/get-started-selections/selection-tools-overview.html) | partial | Elliptical selection with feather and inversion. |
| Selection | [Single Row Marquee](https://helpx.adobe.com/photoshop/desktop/make-selections/get-started-selections/selection-tools-overview.html) | partial | Select an entire one-pixel row. |
| Selection | [Single Column Marquee](https://helpx.adobe.com/photoshop/desktop/make-selections/get-started-selections/selection-tools-overview.html) | partial | Select an entire one-pixel column. |
| Selection | [Lasso](https://helpx.adobe.com/photoshop/desktop/make-selections/get-started-selections/selection-tools-overview.html) | partial | Freehand points become a polygon selection. |
| Selection | [Polygonal Lasso](https://helpx.adobe.com/photoshop/desktop/make-selections/get-started-selections/selection-tools-overview.html) | planned | Not implemented in Prism yet. |
| Selection | [Magnetic Lasso](https://helpx.adobe.com/photoshop/desktop/make-selections/get-started-selections/selection-tools-overview.html) | planned | Not implemented in Prism yet. |
| Selection | [Quick Selection](https://helpx.adobe.com/photoshop/desktop/make-selections/get-started-selections/selection-tools-overview.html) | planned | Not implemented in Prism yet. |
| Selection | [Magic Wand](https://helpx.adobe.com/photoshop/desktop/make-selections/get-started-selections/selection-tools-overview.html) | partial | Four-connected or global RGBA color selection with tolerance. |
| Selection | [Object Selection](https://helpx.adobe.com/photoshop/desktop/make-selections/get-started-selections/selection-tools-overview.html) | planned | Not implemented in Prism yet. |
| Layout | [Artboard](https://helpx.adobe.com/photoshop/desktop/create-manage-layers/layout-design-tools/add-artboards-current-document.html) | planned | Not implemented in Prism yet. |
| Selection | [Selection Brush](https://helpx.adobe.com/photoshop/desktop/make-selections/freehand-selections/create-quick-selections-with-selection-brush-tool.html) | partial | Paint selection opacity with add, subtract, replace, hardness and pressure. |
| Color | [Adjustment Brush](https://helpx.adobe.com/photoshop/using/adjustment-brush.html) | partial | Paint the mask of an editable adjustment layer. Select an adjustment layer first; also supports content-layer masks. |
| Layout | [Crop](https://helpx.adobe.com/photoshop/desktop/crop-resize-transform/crop-straighten/crop-tool-options.html) | partial | Canvas cropping with reversible history. Native Canvas bounds separately supports transparent expansion and selected-area AI outpainting. |
| Layout | [Perspective Crop](https://helpx.adobe.com/photoshop/desktop/crop-resize-transform/crop-straighten/transform-perspective-while-cropping.html) | planned | Not implemented in Prism yet. |
| Layout | [Slice](https://helpx.adobe.com/photoshop/using/slicing-web-pages.html) | planned | Not implemented in Prism yet. |
| Layout | [Slice Select](https://helpx.adobe.com/photoshop/using/slicing-web-pages.html) | planned | Not implemented in Prism yet. |
| Layout | [Frame](https://helpx.adobe.com/photoshop/using/tool-techniques/frame-tool.html) | planned | Not implemented in Prism yet. |
| Painting | [Brush](https://helpx.adobe.com/photoshop/desktop/apply-painting-techniques/fill-objects-selections-layers/painting-tools-overview.html) | partial | Round pressure-sensitive brushes with size, opacity, and hardness. |
| Painting | [Pencil](https://helpx.adobe.com/photoshop/desktop/apply-painting-techniques/fill-objects-selections-layers/painting-tools-overview.html) | partial | Pixel-snapped hard-edged drawing. |
| Painting | [Color Replacement](https://helpx.adobe.com/photoshop/desktop/apply-painting-techniques/fill-objects-selections-layers/painting-tools-overview.html) | partial | Tolerance-based replacement with luminance preservation. |
| Painting | [Mixer Brush](https://helpx.adobe.com/photoshop/desktop/apply-painting-techniques/fill-objects-selections-layers/painting-tools-overview.html) | planned | Not implemented in Prism yet. |
| Painting | [History Brush](https://helpx.adobe.com/photoshop/desktop/apply-painting-techniques/fill-objects-selections-layers/painting-tools-overview.html) | planned | Not implemented in Prism yet. |
| Painting | [Art History Brush](https://helpx.adobe.com/photoshop/desktop/apply-painting-techniques/fill-objects-selections-layers/painting-tools-overview.html) | planned | Not implemented in Prism yet. |
| Painting | [Gradient](https://helpx.adobe.com/photoshop/desktop/apply-painting-techniques/fill-objects-selections-layers/painting-tools-overview.html) | partial | Editable linear, radial, angle, reflected and diamond gradients with alpha stops. |
| Painting | [Paint Bucket](https://helpx.adobe.com/photoshop/desktop/apply-painting-techniques/fill-objects-selections-layers/painting-tools-overview.html) | partial | Color-region fill, or fill the selection through MCP; opacity and selection boundaries are respected. |
| Painting | [Eyedropper](https://helpx.adobe.com/photoshop/desktop/apply-painting-techniques/fill-objects-selections-layers/painting-tools-overview.html) | partial | Sample actual composite RGBA; MCP also supports averaged sampling. |
| Painting | [Color Sampler](https://helpx.adobe.com/photoshop/desktop/apply-painting-techniques/fill-objects-selections-layers/painting-tools-overview.html) | planned | Not implemented in Prism yet. |
| Painting | [Clone Stamp](https://helpx.adobe.com/photoshop/desktop/apply-painting-techniques/fill-objects-selections-layers/painting-tools-overview.html) | partial | Offset sampling from a frozen pre-stroke composite. |
| Painting | [Pattern Stamp](https://helpx.adobe.com/photoshop/desktop/apply-painting-techniques/fill-objects-selections-layers/painting-tools-overview.html) | planned | Not implemented in Prism yet. |
| Retouch | [Spot Healing Brush](https://helpx.adobe.com/photoshop/desktop/repair-retouch/remove-objects-fill-space/retouch-tools-overview.html) | planned | Not implemented in Prism yet. |
| Retouch | [Healing Brush](https://helpx.adobe.com/photoshop/desktop/repair-retouch/remove-objects-fill-space/retouch-tools-overview.html) | partial | Source sampling with local color matching; not content-aware synthesis. |
| Retouch | [Patch](https://helpx.adobe.com/photoshop/desktop/repair-retouch/remove-objects-fill-space/retouch-tools-overview.html) | planned | Not implemented in Prism yet. |
| Retouch | [Red Eye](https://helpx.adobe.com/photoshop/desktop/repair-retouch/remove-objects-fill-space/retouch-tools-overview.html) | partial | Red-dominance correction within the stroke. |
| Retouch | [Eraser](https://helpx.adobe.com/photoshop/desktop/repair-retouch/remove-objects-fill-space/retouch-tools-overview.html) | partial | Pressure-sensitive alpha erasing. |
| Retouch | [Background Eraser](https://helpx.adobe.com/photoshop/desktop/repair-retouch/remove-objects-fill-space/retouch-tools-overview.html) | planned | Not implemented in Prism yet. |
| Retouch | [Magic Eraser](https://helpx.adobe.com/photoshop/desktop/repair-retouch/remove-objects-fill-space/retouch-tools-overview.html) | partial | Erase a connected or global color region to transparency. |
| Retouch | [Blur](https://helpx.adobe.com/photoshop/desktop/repair-retouch/remove-objects-fill-space/retouch-tools-overview.html) | partial | Localized Gaussian smoothing. |
| Retouch | [Sharpen](https://helpx.adobe.com/photoshop/desktop/repair-retouch/remove-objects-fill-space/retouch-tools-overview.html) | partial | Localized unsharp masking. |
| Retouch | [Smudge](https://helpx.adobe.com/photoshop/desktop/repair-retouch/remove-objects-fill-space/retouch-tools-overview.html) | partial | Pigment dragging with pickup. |
| Retouch | [Dodge](https://helpx.adobe.com/photoshop/desktop/repair-retouch/remove-objects-fill-space/retouch-tools-overview.html) | partial | Localized lightening. |
| Retouch | [Burn](https://helpx.adobe.com/photoshop/desktop/repair-retouch/remove-objects-fill-space/retouch-tools-overview.html) | partial | Localized darkening. |
| Retouch | [Sponge](https://helpx.adobe.com/photoshop/desktop/repair-retouch/remove-objects-fill-space/retouch-tools-overview.html) | partial | Localized saturation or desaturation. |
| Retouch | [Remove](https://helpx.adobe.com/photoshop/using/tool-techniques/remove-tool.html) | planned | Not implemented in Prism yet. |
| Retouch | [Content-Aware Move](https://helpx.adobe.com/photoshop/using/content-aware-patch-move.html) | planned | Not implemented in Prism yet. |
| Paths | [Pen](https://helpx.adobe.com/photoshop/desktop/draw-shapes-paths/create-shapes/drawing-tools-overview.html) | partial | Editable cubic Bezier paths, draggable anchors and absolute control handles. |
| Paths | [Freeform Pen](https://helpx.adobe.com/photoshop/desktop/draw-shapes-paths/create-shapes/drawing-tools-overview.html) | planned | Not implemented in Prism yet. |
| Paths | [Curvature Pen](https://helpx.adobe.com/photoshop/desktop/draw-shapes-paths/create-shapes/drawing-tools-overview.html) | planned | Not implemented in Prism yet. |
| Paths | [Add Anchor Point](https://helpx.adobe.com/photoshop/desktop/draw-shapes-paths/create-shapes/drawing-tools-overview.html) | partial | Insert anchors through the editable path properties panel. |
| Paths | [Delete Anchor Point](https://helpx.adobe.com/photoshop/desktop/draw-shapes-paths/create-shapes/drawing-tools-overview.html) | partial | Remove anchors through path properties while preserving an editable path. |
| Paths | [Convert Point](https://helpx.adobe.com/photoshop/desktop/draw-shapes-paths/create-shapes/drawing-tools-overview.html) | partial | Convert corner/smooth anchors and edit Bezier control handles. |
| Shapes | [Rectangle](https://helpx.adobe.com/photoshop/desktop/draw-shapes-paths/create-shapes/drawing-tools-overview.html) | partial | Editable rectangle geometry with fill, stroke, masks, transforms and undo. |
| Shapes | [Ellipse](https://helpx.adobe.com/photoshop/desktop/draw-shapes-paths/create-shapes/drawing-tools-overview.html) | partial | Editable ellipse geometry with fill, stroke, masks, transforms and undo. |
| Shapes | [Triangle](https://helpx.adobe.com/photoshop/desktop/draw-shapes-paths/create-shapes/drawing-tools-overview.html) | partial | Editable triangle geometry with fill, stroke, masks, transforms and undo. |
| Shapes | [Polygon](https://helpx.adobe.com/photoshop/desktop/draw-shapes-paths/create-shapes/drawing-tools-overview.html) | partial | Editable polygon geometry with fill, stroke, masks, transforms and undo. |
| Shapes | [Star](https://helpx.adobe.com/photoshop/desktop/draw-shapes-paths/create-shapes/drawing-tools-overview.html) | partial | Editable star geometry with fill, stroke, masks, transforms and undo. |
| Shapes | [Line](https://helpx.adobe.com/photoshop/desktop/draw-shapes-paths/create-shapes/drawing-tools-overview.html) | partial | Editable line geometry with fill, stroke, masks, transforms and undo. |
| Shapes | [Custom Shape](https://helpx.adobe.com/photoshop/desktop/draw-shapes-paths/create-shapes/drawing-tools-overview.html) | partial | Author a custom closed vector path. No imported shape-preset library. |
| Paths | [Path Selection](https://helpx.adobe.com/photoshop/desktop/text-typography/text-on-paths-shapes/convert-text-to-shapes-or-work-paths.html) | partial | Select a path layer and transform the whole path; no multi-path sub-selection. |
| Paths | [Direct Selection](https://helpx.adobe.com/photoshop/desktop/text-typography/text-on-paths-shapes/convert-text-to-shapes-or-work-paths.html) | partial | Move individual path anchors and edit their handles. |
| Type | [Horizontal Type](https://helpx.adobe.com/photoshop/desktop/text-typography/get-started-with-text/add-text.html) | partial | Editable system-font text with size, alignment, bold, and italic. |
| Type | [Vertical Type](https://helpx.adobe.com/photoshop/desktop/text-typography/get-started-with-text/add-text.html) | planned | Not implemented in Prism yet. |
| Type | [Horizontal Type Mask](https://helpx.adobe.com/photoshop/desktop/text-typography/text-on-paths-shapes/create-text-selection-borders.html) | planned | Not implemented in Prism yet. |
| Type | [Vertical Type Mask](https://helpx.adobe.com/photoshop/desktop/text-typography/text-on-paths-shapes/create-text-selection-borders.html) | planned | Not implemented in Prism yet. |
| View & measure | [Hand](https://helpx.adobe.com/photoshop/desktop/use-grids-measurement-guides/alignment-grids-guides/navigation-and-measuring-tools-overview.html) | partial | Pan the canvas view. |
| View & measure | [Rotate View](https://helpx.adobe.com/photoshop/desktop/use-grids-measurement-guides/alignment-grids-guides/navigation-and-measuring-tools-overview.html) | planned | Not implemented in Prism yet. |
| View & measure | [Zoom](https://helpx.adobe.com/photoshop/desktop/use-grids-measurement-guides/alignment-grids-guides/navigation-and-measuring-tools-overview.html) | partial | Fit and magnify the canvas view. |
| View & measure | [Note](https://helpx.adobe.com/photoshop/desktop/use-grids-measurement-guides/alignment-grids-guides/navigation-and-measuring-tools-overview.html) | planned | Not implemented in Prism yet. |
| View & measure | [Ruler](https://helpx.adobe.com/photoshop/desktop/use-grids-measurement-guides/alignment-grids-guides/navigation-and-measuring-tools-overview.html) | planned | Not implemented in Prism yet. |
| View & measure | [Count](https://helpx.adobe.com/photoshop/desktop/use-grids-measurement-guides/alignment-grids-guides/navigation-and-measuring-tools-overview.html) | planned | Not implemented in Prism yet. |

## Professional features outside the toolbar

The [standalone feature-family matrix](FEATURE_PARITY.md) is the authoritative broader comparison. It covers 33 families, dependencies and acceptance criteria; this toolbar checklist is not a complete Photoshop feature list or a parity percentage. Photoshop installation is not required for native development.

| Area | Current scope | Remaining work |
|---|---|---|
| Layers | Ordered content/adjustments, 27 blends, masks, outside styles/presets, pass-through/isolated groups and bounded content clipping chains | Smart objects, clipped groups/adjustments, inner styles/bevel and advanced layer locks |
| Color | Exposure, brightness, contrast, saturation, temperature, vibrance, hue, highlights, shadows, levels/curves, histogram, invert/grayscale/sepia/posterize/threshold | Channel mixer, selective color, LUTs, gradient maps, full Lab/CMYK/ICC/16-/32-bit pipeline |
| Filters | Gaussian blur, RGB sharpening, editable Unsharp Mask, repeatable Uniform/Gaussian Add Noise, median, alpha-weighted mosaic and localized paint filters | Filter Gallery, Camera Raw, Liquify, lens corrections, advanced restoration, displacement and Smart Filters |
| Selection | Rectangle, ellipse, polygon, color regions, painted selections, feather/invert, local subject alpha and manual source-alpha repair | Channel selections, advanced edge refinement and arbitrary interactive object selection |
| Text | Editable basic text and bundled Fraunces | Full font discovery, shaping controls, vertical/paragraph type, text on path, type masks |
| Files | PNG/JPEG/WebP/TIFF import, PNG/JPEG/WebP export; immutable originals and saved project history | PSD/PSB round trip, RAW, PDF, multipage/animation, print production |
| Automation | Validated MCP commands, actual layer/source/mask images, revision checking, atomic transactions, undo/redo | Recipe recorder, plugin ecosystem, larger-scale batch pipelines |
| AI | Durable provider generation/edit jobs, locally clipped selection fill/outpainting, alpha-only extraction and protected original compositing | Reliable restoration, harmonization/upscaling and broader real-photo evaluation; real provider use requires quota |

Adobe references for broader features: [current desktop release notes](https://helpx.adobe.com/photoshop/desktop/whats-new/whats-new-in-adobe-photoshop-on-desktop.html), [generative AI overview](https://helpx.adobe.com/photoshop/desktop/generative-ai/generative-ai-features-overview.html), [Filter Gallery](https://helpx.adobe.com/photoshop/desktop/effects-filters/get-started-with-filters/filter-gallery.html).

This checklist remains explicit about gaps. Adding a name to the browser does not implement the feature. All new editing commands must alter actual document state, survive save/reopen, participate in undo, and be tested through the API or UI.

Blend references: [Adobe blending modes](https://helpx.adobe.com/photoshop/desktop/repair-retouch/adjust-light-tone/blending-mode-descriptions.html) and [W3C compositing formulas](https://www.w3.org/TR/compositing-1/#blending). Prism implements the core blend math, without Adobe-specific Fill-opacity behavior or group Pass Through.
