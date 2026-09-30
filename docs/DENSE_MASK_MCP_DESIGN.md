# Dense masks and composite-channel selections: API plan

Status: implemented and verified, 2026-09-19. The full1,177-test suite passes, including four shared metadata, four schema and four official SDK workflows for this feature. The two public commands and all mask consumers are registered;88 focused/adjacent browser workflows and the build pass. Read the [consumer and lifetime map](DENSE_MASK_ARCHITECTURE.md), [implementation design](DENSE_MASK_DESIGN.md) and [user workflow](DENSE_MASKS.md) for the exact boundaries.

The workflow research was checked against Adobe's [channel overview](https://helpx.adobe.com/photoshop/using/channel-basics.html) and [saved selection and alpha-mask guide](https://helpx.adobe.com/photoshop/using/saving-selections-alpha-channel-masks.html). Those references establish grayscale channel inspection and reusable channel-derived selections. Prism's byte arithmetic, alpha treatment and storage format below are explicit native choices, not claims about Adobe's internal algorithms or complete channel editing support.

## Channel selection command

`load_channel_selection` accepts the current document ID, a positive `expectedRevision`, `channel`, `mode` and `invert`. The channels are `red`, `green`, `blue`, `luma` and `alpha`; the default is `luma`. Mode is the existing `replace`, `add`, `subtract` or `intersect`, defaulting to Replace. Invert is a strict Boolean, default false. The same positive revision requirement applies to the outer atomic transaction. The command returns the updated document and is one Undo step.

The source is the final native composite at that revision, including visible layers, adjustments, transforms, group/clipping behavior and protected-content handling. There is no implicit target layer, original-image channel or alternate render mode. The command creates selection coverage; it does not modify source RGB or alpha. It invokes neither segmentation nor image generation.

Component coverage is the selected composite byte multiplied by composite alpha, rounded half up to a byte. Luma first rounds the weighted encoded RGB sum `(2126R + 7152G + 722B) / 10000` to a byte, then multiplies that byte by alpha and rounds again. Alpha uses the composite alpha byte directly. Inversion subtracts the finished coverage from255 before combining with an existing selection. Consequently an inverted fully transparent pixel is selected. This explicit policy avoids using hidden RGB in the non-inverted result and avoids ambiguity about the luma rounding stage.

For example, RGB `[14,1,122]` has weighted luma12.5, so its luma byte is13. At alpha128 the resulting coverage is7; multiplying unrounded luma by alpha would instead produce6. This distinction needs literal maintained fixtures, including alpha0/1/128/255.

Combination preserves the existing selection algebra: Add takes maximum coverage, Subtract multiplies active coverage by one minus loaded coverage, and Intersect multiplies both. Existing feather/inversion/domain are evaluated once before the current byte quantization. Subtract/Intersect without an active selection fail before rendering or publishing an asset. An empty result remains a real empty selection, not the absence of a selection.

Do not materialize a geometric active selection into alpha8 before combining. A1×1 rectangle with feather3 has center coverage1/6; intersecting loaded byte69 produces11 under the existing order. Prematurely rounding the active coverage produces12. Dense storage is permitted to change representation only after the operation's existing coverage calculation is complete.

## Read-only channel preview

The companion `get_channel_preview` command accepts document ID, an optional positive revision, the same channel/invert fields and `maxEdge`32–2400, default700. It renders the same final composite and returns an opaque grayscale PNG using nearest pixel-center samples of the defined coverage. Metadata includes document/revision, channel/invert, source and output dimensions, sampling and coverage policy. It does not create a selection or asset, mutate history or cache decoded channel planes in graph metadata.

This is distinct from mask inspection: channel preview intentionally reads and renders RGB content. Its resource gate applies before those reads even when the graph contains no existing dense mask, LUT or Distort. After rendering, it can sample into the bounded output directly instead of allocating an unnecessary full-resolution channel plane; the live4Q composite, output and encoding reserves still require a joined ledger. The client must associate a response with its exact document revision, channel, inversion and request ownership.

Together the two commands increase the native command count from100 to102. Registration followed complete consumer/resource design review and the native integration checkpoint; native, MCP and browser acceptance now passes.

## Capability boundaries

- `channelSelectionPolicy:'composite-byte-alpha-v1'` and `channelSelectionChannels` containing all five names describe the producer.
- `denseMaskPolicy:'framed-raw-alpha8-v1'` and a strictly validated `denseMaskLimits` object describe storage support. The shared contract fixes the frame at32 bytes, source limits at8192 per axis and24MP, named working buffers at256MiB, preparation work at384 million visits, and retained history at256 unique frames/3GiB. These limits are separate from the unchanged portable-project limits.
- The client requires the producer policy, typed channel list, storage policy and the individual command. A present string in place of a list must not enable controls.
- Source effect-mask authoring additionally advertises `alpha8` in its own shape list. Its existing source-coordinate policy and capture-geometry rules remain required.
- The optional Adobe bridge rejects the new command and descriptor explicitly. Native old readers reject the new shape; no fallback approximates it as a rectangle or an empty bitmap.

Capabilities do not grant arbitrary asset access. The graph stores an immutable hash descriptor, never a file path, URL or base64 pixel plane. Ordinary document reads return compact metadata; callers inspect actual coverage using the existing bounded `get_mask_preview` endpoint. That endpoint may read the selected alpha asset and must still avoid RGB image reads or unrelated assets.

## Shared schemas and transport

The new descriptor is a strict `shape:'alpha8'` record containing `asset`, `bytes`, `width`, `height`, `feather` and `invert`, with canonical zero x/y. The approved design specifies the fixed32-byte `PRISMA8` frame and its version, dimensions, length and reserved fields. Hashes have exactly64 lowercase hexadecimal characters; dimensions obey the existing8192-axis/24MP bounds; byte length equals width times height plus the header. A hash reused under incompatible dimensions, lengths or asset types fails before I/O. Strict own-data validation precedes native snapshots; wire JSON must retain unknown-field rejection.

Existing explicit mask inputs should only accept the new descriptor where the native implementation verifies its immutable asset and supports all subsequent consumers. The existing geometric `set_layer_mask` API need not become a generic raw-file importer. Selection capture, saved selections and filter-mask capture can share verified descriptors. No mask pixels enter an edit recipe; masked-stack capture retains its existing refusal, and ordinary recipes may operate in a document containing dense masks.

The shared schema registers the new command as a revision-pinned transaction member. Status forwards the two policy markers, channel list and exact limits. MCP help explains composite source, two-stage luma rounding, alpha multiplication, inversion order, combination, Undo and original-pixel preservation. Native graph/resource rejection must remain visible; clients must never silently quantize, resize, threshold or retry with weakened settings.

## Meaningful acceptance

Root schema checks cover defaults, all channels/modes, strict Booleans, unknown fields, finite positive revisions, transaction revision requirements and Adobe refusal. Descriptor checks cover exact length/frame/hash, malformed inactive records and unchanged legacy masks without loosening unrelated schema rules.

Official SDK workflows use the original512² photograph and a high-frequency1MP fixture that exceed the old200000-run ceiling. They compare full coverage against an independent byte oracle, retain exact original assets, then save/load/combine, apply a masked adjustment, inspect coverage, paint under the selection and change canvas bounds. Mixed sparse/dense masks, Undo/restart and portable transfer must retain exact bytes. Source effect capture/Bake and protected/generated clipping remain native/independent acceptance responsibilities, with selected cross-boundary SDK cases where useful.

Tests also require stale-revision rejection, stable request replay, late transaction failure and actual persistence failure with newly owned asset cleanup. Existing shared assets and Undo states must survive those failures. Full-suite and browser acceptance follow only after the shared consumer implementation and joint resource gates are reviewed. Root owns schemas, HTTP status, MCP help, SDK tests and user-facing documentation; the native, reviewer and client agents own their corresponding implementation and evidence.

Publication admission must include the actual immutable-store deduplication branch. With output planeQ and framed bytesB=Q+32, `storeAsset` verifies an already-existing hash using another privately read B-byte buffer while the incoming frame remains live. The worst named-buffer publication phase is therefore Q+2B, not Q+B, unless that store path is deliberately changed and reviewed. The existing bounded reader allocates exactly B and hashes chunk views; it has no separate EOF probe plane.
