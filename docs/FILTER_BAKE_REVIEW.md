# Independent source-filter bake review

Reviewed 2026-09-19 against [FILTER_BAKE_DESIGN.md](FILTER_BAKE_DESIGN.md) and the implemented native renderer, filter evaluator and asset publisher. Root approved the choices below. The ten independent production checks in `tests/filter-bake-audit.test.mjs` pass; no production correctness defect was found in this bounded audit.

## Accepted source semantics

The input is the current working asset, not the preserved original. Evaluate filters against its RGB and the exact byte alpha produced by working-alpha × separate-cutout-alpha. Restore original working alpha into the filtered output before saving, and retain the separate alpha asset. Recombination then recreates the same effective alpha exactly once. Since the RGBA entering geometry is unchanged, later deterministic geometry, clipping, masks, density, styles, group blending and layer opacity receive identical inputs.

Retain source dimensions, transforms, source asset/format, alpha asset, IDs, roles/provenance, parent/clipping links and all unrelated document metadata. Generated layers retain their existing display exclusion. A bake neither assembles clipping-chain interiors nor freezes a document preview. The source-space filter list alone becomes an ordinary working RGB image.

Previously hidden effective-alpha-zero RGB stays ungraded. Revealing it later through cutout repair does not recompute the removed filters. This is a necessary explicit consequence of fixed pixels, including spatial-filter samples frozen against the old cutout. The UI should explain it without adding a permission dialog.

Reject every protected target. For an active stack, also reject any earlier protected content node in canonical order, including hidden or fully masked nodes and nodes inside other groups. Current filter rendering can restore unfiltered transformed RGB under those footprints; clearing the stack would remove that behavior. A source-only bake cannot generally invert arbitrary geometry to reproduce it. The conservative structural refusal is appropriate. Later protected nodes are allowed, and an entirely disabled/zero-opacity stack can clear metadata without source I/O under the ordinary target guard.

An active identity setting still follows the protected-prefix rule. An exact pixel comparison may avoid writing a new image when permitted filtering changes no RGB. No empty-stack no-op is implied: an empty stack rejects with the agreed `NO_FILTERS` code.

## Reviewed explicit-buffer ledger

Let `S` be source pixels, `Ew/Ea` bounded encoded working/alpha input bytes, and `P=min(5S+1 MiB,128 MiB)` the accepted encoded-output ceiling.

| Phase | Accounted bound |
| --- | --- |
| Decode/alpha combination | `Ew+Ea+(alphaAsset ? 9S : 4S)` |
| Filtering | `Ew+Ea+(alphaAsset ? 17S : 12S)+64 KiB` |
| Encode and bounded output read | `Ew+Ea+8S+P` |
| Asset publication/deduplication | `Ew+Ea+4S+2P` |

The alpha filtering peak is original working RGBA `4S`, decoded alpha `S`, effective input `4S`, mutable filtered output `4S`, and one spatial candidate `4S`. Without separate alpha the input aliases the original, giving `12S`. The current median histograms use about 3.3 KiB of typed arrays; the 64 KiB reserve is conservative. Current scalar/mosaic/median candidates do not require another retained JavaScript image frame. Native codec internals remain explicitly outside this ledger.

The materializer must return only final source RGBA before the encode helper begins. Its original/effective/candidate buffers must not remain referenced across the encoding await. The encode reserve includes the final RGBA and another codec-facing surface. Publication reserves a second encoded image only for bounded deduplication comparison. Encoded inputs are conservatively counted through every phase. Take the phase maximum before source-surface allocation and refuse above 256 MiB. This is a named-buffer admission policy, not a whole-process RSS or total-operation latency promise.

Existing graph/filter/positioned-mask admission runs before baking. Those geometry/composition/mask surfaces are not also allocated by source-only baking. Filter work weights and limits still apply. New alpha restoration/comparison loops yield at most every 65,536 pixels.

## I/O findings resolved

**Output allocation:** a PNG-size allowance is not a universal encoder proof. PNG permits arbitrary IDAT chunk sizes, and zlib's documented bound depends on its flush policy. [PNG specification](https://www.w3.org/TR/png-3/#11IDAT), [zlib `deflateBound`](https://www.zlib.net/manual.html#Advanced).

The installed Sharp implementation also does not provide incrementally bounded encoded output through its stream API: `node_modules/sharp/dist/output.mjs` receives the full native encoded buffer before pushing it. Checking stream-chunk lengths afterward would not limit that allocation. Root therefore selected **Sharp encoding to a private staging file**, inside an owned mode-0700 temporary directory. Require nonpalette, noninterlaced RGBA8 output without copied metadata. After encoding, stat the output and enforce `P` before any output-sized Buffer allocation; read through that same descriptor with bounded exact-length reads. Always remove the owned temporary file/directory. `P` is an output admission ceiling; temporary disk output can exceed it and then be refused. No custom PNG codec or universal output-size guarantee is introduced. Sharp's available PNG controls are documented [here](https://sharp.pixelplumbing.com/api-output/#png).

**Deduplicated assets:** existing `storeAsset` used an unbounded `readFile` on `EEXIST`, which would invalidate the new `2P` publication allowance if a stored hash file were corrupt and oversized. Root approved exact-size bounded validation for this path: open without following symlinks, require a regular file whose size equals the new buffer length before allocating, read exactly that amount, verify its digest and final size, and retain existing `CORRUPT_ASSET` semantics. An existing hash is never owned by the new operation and must never be removed on rollback.

Source inputs similarly require no-follow descriptors, regular nonempty bounded files, exact hash validation and source-sized single-page PNG decoding. Validate both encoded lengths and the combined phase ledger before decoding. Missing, corrupt or wrong-format input errors must be sanitized.

**Nonregular paths before stat:** root's subsequent FIFO probe showed that a read-only open could block before the regular-file check ran. The bounded opener now adds `O_NONBLOCK` alongside `O_NOFOLLOW`; ordinary files keep their normal behavior, while a FIFO can be inspected and refused without a writer. The backend owner's timeout-bounded child regression exercises both source admission (`INVALID_IMAGE`) and native deduplication (`CORRUPT_ASSET`), keeping the FIFO untouched. This reviewer independently reran that regression successfully in about 89 ms, alongside the existing corrupt/symlink deduplication audit. The timeout is test containment, not a latency guarantee.

## Atomicity and API decisions

Standalone baking requires a positive `expectedRevision`. A bake-containing transaction requires its enclosing positive revision; internal steps use that captured revision. Existing session deduplication remains the retry policy. After restart, an old revision rejects rather than replaying against current state.

Root accepted `layerFilterBaking:'source-rgb'` and the design's resource-capability names. Baking remains outside metadata-only recipe commands. Clear and Bake are distinct explicit operations.

Use one instance-owned AsyncLocalStorage asset-ownership scope around the complete mutate-to-commit interval for standalone baking and any transaction containing it. Include later retouch writes, and share one scope when repair creation also appears. Track only successful newly linked hashes. On a late operation, encode, validation or prepublication persistence failure, remove only new owned blobs. Preserve deduplicated originals, prior graph/history/revision and preview cache. An extension throwing after real publication must not delete live assets. Bake-only and mixed scopes use `FILTER_BAKE_ROLLBACK_FAILED`; repair-only behavior keeps its existing error code.

Before asset publication, preflight actual prospective history serialization with a same-length placeholder hash and cleared filters. Final commit validation remains mandatory. Later transaction steps may still fail or expand metadata; the full ownership scope handles their rollback.

## Independent production evidence

`node --test tests/filter-bake-audit.test.mjs` passes all ten checks:

1. Same-descriptor readers reject symlinks, growth before/after reads, premature EOF, wrong digests and exact-size mismatches. Short successful reads loop correctly.
2. Private-file encoding preserves every RGBA byte, including hidden RGB and alpha 1/128. Success and an intentionally one-byte output ceiling both remove staging directories.
3. An independent phase formula covers small and large source dimensions, separate alpha and encoded files. A metadata-only oversized source is refused by the ledger before decoding its intentionally incompatible tiny PNG.
4. Actual ordered filter evaluation matches an independent RGB interpolation oracle. The stored PNG retains original working alpha; separate alpha and original assets remain byte-identical. Effective alpha-zero RGB is unchanged, full composition is exact, and Undo restores the stack.
5. Active baking rejects earlier protected nodes when hidden, fully masked, opacity zero or inside hidden isolated groups, before source access. An entirely inactive stack clears metadata even when the working asset is unavailable; only project persistence occurs.
6. Affine geometry, positioned/inverted/feathered additional masks, density, isolated group blending, clipping members and later protected outlines preserve every composite byte. Generated roles/provenance survive, and moving protection below the baked generated layer still excludes those pixels in its original-context preview.
7. Late transaction failure and actual filesystem `ENOTDIR` persistence failure restore assets, project/history/revision and preview cache. Publication counters prove the bake and retouch writes occurred before refusal; mixed bake/repair creation/repair stroke reaches all three writes and rolls them back. Existing deduplicated hashes survive.
8. Missing, digest-corrupt, wrong-format, wrong-dimension and sparse over-128-MiB sources reject without staging output or exposing paths.
9. A failed transaction removes its own newly linked image while an unrelated helper publication running outside its AsyncLocalStorage scope survives.
10. Corrupt oversized and symlinked existing hash paths reject deduplication without an unbounded `readFile`, retaining the existing path and external target.

The backend owner's separate eleven tests cover all 22 filter kinds, queued input snapshots, prospective metadata limits, cleanup failure codes, post-publication retention and the FIFO regression above. Root's official SDK workflow separately passes revision/session retry, portable/restart, Clear versus Bake, source/alpha preservation and bake-plus-brush atomic Undo. These are separately owned results, not additional independent cases.

The [UI contract and implementation](FILTER_BAKE_UI_DESIGN.md) were reviewed without a blocker. The helper, `LayerFilters` and App runner use canonical protection checks and independent Bake/Clear capability gates. Whole-stack response identity deliberately excludes selected filter and stack contents so removing entries does not invalidate its own successful result; document/layer/capability changes still invalidate late installation. The panel stays mounted for bake-only/clear-only companions after its own stack becomes empty. Relevant server refusals refresh current metadata without automatic replay.

The UI owner reports six focused browser workflows passing, including selected-filter-only changes during pending Bake, late layer navigation, navigation during preview loading, marker loss and both action-only companion variants. Eight tonal, four filter and five recipe workflows plus build pass. Real-photograph before/after PNGs are identical, with SHA-256 `e1dc7b139e78f9ba4c31dbdb2f81fcf34e2343e63b7b0654c9d00af7f4a60a73`. This paragraph attributes the separately owned browser evidence; it is not another independent test run. No provider, model or credential access was used by this audit.
