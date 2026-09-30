# Inspect active selections and additional layer masks

Status: native backend implemented with ten passing owner checks, September 19, 2026. Independent audit, SDK and browser verification run separately. This is read-only mask inspection, not Quick Mask editing.

## Problem and intended result

The editor can modify and reuse soft masks, but the cutout preview's Mask view represents only source cutout alpha. There is no read-only grayscale image of an active selection or a layer's separate document-space mask. The bitmap selection tint currently draws stored runs without evaluating feather or the internal canvas clip. A precise inspection view would let people and MCP assistants assess soft edges without first copying or changing the mask.

Adobe documents viewing a layer mask as grayscale or as a colored overlay. Its temporary Quick Mask is a separate editing workflow. This proposal implements inspection of existing native masks, not full Quick Mask or Adobe-equivalent channel behavior. [Adobe layer-mask viewing](https://helpx.adobe.com/photoshop/using/editing-layer-masks.html), [Adobe Quick Mask](https://helpx.adobe.com/photoshop/using/create-temporary-quick-mask.html).

## Read command

```js
get_mask_preview({
  documentId,
  expectedRevision?,
  source: 'selection' | 'layer-mask', // default selection
  layerId?,                         // required only for layer-mask
  maskMode?: 'raw' | 'effective',     // mask only; default effective
  maxEdge?: 32..2400                 // default 700, longest edge; never upscale
})
```

Reject irrelevant `layerId` or `maskMode` for a selection source, missing `layerId` for mask source, invalid enums and missing selection/mask. `selection:null` returns `NO_SELECTION`; an explicit empty bitmap returns a black image. All nodes with an own additional mask are eligible, including groups and adjustments. This read never invokes rendering of source RGB, segmentation, generation, credential access or asset publication.

Selection coverage is its existing `maskCoverage`: stored geometry/bitmap, feather, inversion and internal clip evaluated once. Additional-mask raw/effective coverage has exactly the layer-to-selection contract: raw evaluates mask settings before density; effective includes density. Neither is multiplied by source transparency, layer opacity, visibility, ancestors, clipping chains, styles, protection or other layer content.

White means full mask/selection coverage, black means zero and gray means partial coverage. These colors describe the selected mask only; they do not claim that an edit can alter protected pixels. Use `Q(c)=clamp(round(255*c),0,255)` once and encode opaque grayscale PNG, preserving exact byte values at native resolution. Do not reuse source-alpha `get_layer_preview({view:'mask'})` under a different meaning.

Return `{data,mimeType:'image/png',width,height,sourceWidth,sourceHeight,documentId,revision,source,sampling:'nearest-pixel-center',maxEdge}`; `data` is base64 at the native public boundary. Layer-mask results additionally include `layerId` and resolved `maskMode`; selection results omit them. MCP returns an image block with detached metadata, consistent with other preview tools. Capabilities advertise `maskPreviewSources:['selection','layer-mask']`, `maskPreviewMaskModes:['raw','effective']`, `limits.maxMaskPreviewEdge:2400`, `limits.maxMaskPreviewBytes:8388608` and `limits.maxMaskPreviewWorkingBytes:268435456`. There is no new transaction mutation, graph field, asset or history entry.

## Sampling and resource contract

Build the mask coverage callback once, after an operation resource preflight. Feathered bitmaps can require a full alpha plane and four-byte distance field; geometric polygon callbacks retain bounded row caches. Existing callback initialization is synchronous and bounded, not interruptible. Sampling/encoding loops should yield every32 rows and should not add a second feather pass.

Use deterministic nearest-neighbor pixel-center sampling and quantize the chosen source coverage once, so a resized preview never invents intermediate shades. Output-size rounding and pixel-center-to-source mapping are pinned below and in independent coordinate tests; a reduced preview cannot retain every hair/isolated pixel. Max-edge scaling bounds both dimensions, preserves aspect within integer rounding and never enlarges. UI caption must disclose preview dimensions and offer an appropriate size/retry control; the inspection image is bounded to2400 pixels on its longest edge; inspect original source data separately when this loses necessary detail.

`server/mask-preview.mjs` exports `renderMaskPreview`, `maskPreviewDimensions` and `estimateMaskPreviewBytes`. The helper returns an owned PNG Buffer and inspection metadata; native queued dispatch supplies the document/revision and base64 only after the encoded size check.

The conservative 256 MiB ledger is `C + 5P + E + 5B`: `C` is callback construction storage (zero for geometry or effective density zero, `N` for an unfeathered bitmap, `5N` for a feathered bitmap); `P` is sampled output pixels; `5P` reserves the gray plane and four-byte codec surface; `E=8 MiB` is the fixed encoded PNG bound; and `B=4*ceil(E/3)` is the maximum base64 length. `5B` reserves the base64 string and serialized JSON as UTF-16 plus UTF-8 transfer bytes. The callback budget remains counted through encoding rather than relying on early garbage collection. No full document gray/RGB plane is added just to inspect a geometric mask.

The encoded PNG is single-channel eight-bit grayscale, with no palette, ICC profile, alpha or ancillary source metadata. Output over 8 MiB rejects before base64 publication. An independent maximum-edge high-entropy 2400×2400 probe encoded to 5,772,680 bytes, comfortably below the fixed bound. Maximum legal callback/output accounting is approximately 203.24 MiB; input limits make an otherwise valid 256 MiB refusal currently unreachable, so tests verify the ledger and dimension/edge rejection rather than inventing a budget-failure fixture.

This is explicit binary-buffer/transfer accounting, not total RSS. Existing native codec caches and bounded JS mask/polygon/graph objects are outside that ledger. No cache is used, so each view is fresh at its reported revision.

Read through the native queue and validate optional expectedRevision immediately before coverage. A later edit may invalidate the view in the client, but cannot relabel an old image with a newer revision. Leave persisted projects, revision, history, source assets, PSD archive/receipt and composite cache byte-for-byte unchanged on success and failure.

## UI proposal

Add an explicit **Inspect coverage** action beside the active selection and beside additional-mask controls. It opens a compact read-only image panel/dialog with source name, raw/effective density choice when relevant, black/white legend, dimensions and refresh. Keep the active editing target unchanged. Every request is keyed by backend/document/revision/source/layer/options; late replies must never appear against a new target. Disable absent sources and expose failure/retry honestly. Do not automatically issue expensive previews during every brush move.

A later separate change can use the same evaluated preview to fix the bitmap canvas tint, with precise stale-result and downsampling behavior. Do not quietly change interactive overlays in this milestone or introduce a second client-side feather implementation. Source cutout inspection remains distinct.

## Acceptance

1. Independent full-size PNG decode equals quantized geometric/bitmap feather/invert/clip coverage, including0/1/128/255, no runs, inverted no runs and masks clipped by canvas changes.
2. Effective density0/0.5/1, half-byte rounding and raw/effective differences agree with loaded selections. Group/adjustment masks work despite hidden sources and missing/corrupt raster assets elsewhere.
3. Exact nearest-neighbor coordinate fixtures cover odd dimensions, very tall/narrow sources, edge pixels, no enlargement and actual returned dimensions. No read mutates masks or saves a copy.
4. Missing/invalid/stale requests and accounting-limit failures leave every project/cache/asset unchanged; native queue ordering is verified. Independent memory oracle covers feather callback and output/transfer bounds.
5. Official SDK returns real PNG/image metadata; HTTP auth/Origin/Host checks reuse the command path. Browser verifies target/revision switching, stale responses, absent masks, grayscale and long-name layout. All tests avoid providers and keys.

Only `maxEdge` controls output size. If the longest source dimension is at most `maxEdge`, preserve both dimensions exactly. Otherwise compute each dimension as `max(1,floor((2*sourceDimension*maxEdge+longest)/(2*longest)))`, exact rational half-up rounding of proportional scaling. This avoids floating-point half-tie drift: 420×840 at edge457 yields229×457. Map preview coordinate `p` to source `min(sourceSize-1,floor(((2*p+1)*sourceSize)/(2*outputSize)))`. All numerator products are exact under existing bounds. Quantize that source coverage once before encoding. This explicit inspection contract differs from older width-bounded image previews.

Owner verification: `node --test tests/mask-preview.test.mjs` passes ten checks. These decode all 256 grayscale values as exact opaque RGB, validate raw/effective coverage and empty masks, compare sampling against a BigInt oracle, pin half-pixel size ties and the buffer ledger, prove missing/corrupt raster assets are not read, and check file/cache/history neutrality plus queued stale-revision handling. Source cutout alpha and ordinary image previews remain separate APIs.

## Shared density rounding correction

Inspection tests exposed a pre-existing density cancellation bug at alpha8 half ties. Interior density now evaluates `(255-d*(255-byteCoverage))/255`; only inherently alpha8 bitmap coverage is recovered to its exact byte before this calculation, including stored inversion and already-baked canvas clipping. Geometric feather/shape coverage remains continuous, and density zero/one keep their exact fast paths. This is one shared `layerMaskCoverage` correction used by rendering, selection loading and preview, not a preview-specific adjustment. Independent quarter/half/three-quarter rational ramps cover every forward/inverted byte; a BigInt source-alpha oracle also covers source alpha0/1/128/255 and canvas-expanded inverted bitmaps. Existing source assets are unchanged.
