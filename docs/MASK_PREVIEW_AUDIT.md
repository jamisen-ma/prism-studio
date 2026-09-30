# Independent selection and mask inspection audit

Verified September 19, 2026. The independent [mask-preview audit](../tests/mask-preview-audit.test.mjs) passes eight tests. The combined preview owner suite, preview audit, density audit and layer-selection audit passed 35 tests. SDK/schema and browser checks are tracked separately by their owners.

This verifies the bounded native [inspection contract](MASK_INSPECTION_DESIGN.md). It does not implement Quick Mask editing or claim Photoshop channel parity. The preview is an opaque grayscale image of the active selection or a node's additional mask, distinct from source cutout alpha.

## Numerical findings and corrections

The initial output-size formula could round a mathematical half downward because of floating-point multiplication. A 420 × 840 canvas at maximum edge 457 produced 228 × 457 instead of 229 × 457. Production now uses exact integer-ratio half-up sizing and pixel-center sampling. An independent BigInt oracle verifies five explicit half cases, 8,000 bounded dimension combinations, narrow canvases and actual sampled pixels. The client response validator was updated to the same contract.

The review also confirmed a pre-existing density rounding defect: bitmap value 10 at density 0.5 could materialize as 132 instead of 133. Density arithmetic now runs in byte units. Bitmap coverage is already byte-valued after feathering; recovering that byte before density removes cancellation from stored inversion as well. Continuous geometric coverage remains unquantized until output, and density 0/1 retain their fast paths. All 256 stored values, forward and inverted, at density 0/0.25/0.5/0.75/1 agree with an independent integer oracle through PNG inspection, loaded selections and native rendered alpha. This is a numerical accuracy correction, not an added early quantization stage.

PSD export still refuses nonrepresentable fractional masks. The audit independently walks exported raw mask channels and verifies exact integer density bytes; a neighboring half-byte fixture is displayed with half-up rounding but refuses the exact editable PSD subset. An older continuous-double density assertion now tolerates four machine epsilons for algebraically equivalent operations; its final pixel assertions remain exact.

## Read-only and coverage evidence

- Independent rectangle and ellipse fixtures apply feather, inversion and the persisted canvas clip once, before density and nearest sampling. A small bitmap fixture independently derives feathered byte values before inversion.
- All grayscale results decode to equal R/G/B bytes with alpha 255. An explicit empty bitmap is black; its inversion is white; a null selection returns `NO_SELECTION`.
- Own masks on hidden isolated groups, adjustments and rasters work despite missing working/source/alpha assets. Source visibility, opacity, ancestors and image pixels cannot change this mask-only view. The test makes image rendering, asset access/publication and composite-cache operations throw if called.
- Successful and failed inspection preserve project bytes, assets, saved selections, history, revision and warmed composite-cache accounting. Returned metadata is detached. A queued mutation separates old and fresh reads correctly; a pinned stale read fails instead of relabeling old pixels.
- Density zero does not bypass malformed-mask validation. Invalid runs, dimensions, feather and misplaced density metadata reject before publication. Missing masks remain distinct from disabled masks.

## Resource scope

The independent ledger is `C + 5P + E + 5B`: callback bytes `C` are zero for geometric masks, `N` for bitmap bytes and `5N` with bitmap feathering; effective density zero bypasses callback allocation. `P` is the sampled pixel count, bounded by 2400 × 2400. `E` reserves the hard 8 MiB encoded PNG cap, and `B = 4 ceil(E/3)` reserves base64 characters. The `5B` transfer term accounts two UTF-16 string copies and one UTF-8 transfer copy.

The 256 MiB limit describes these accounted binary buffers, not total process RSS, JavaScript graph/polygon caches or native codec caches. The sampled geometric path does not allocate a full source grayscale canvas. A 24 MP geometric fixture produces only a 32 × 12 output; a separate one-megapixel sample confirms event-loop progress before completion. Existing bitmap-feather preparation remains synchronous and bounded. Reduced nearest-sampled previews can omit fine detail and do not replace access to full-resolution mask data.

No native correctness issue remains open from this audit. The two numerical findings were fixed before acceptance; the audit introduces no production changes, provider calls or credential reads.
