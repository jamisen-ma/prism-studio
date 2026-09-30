# Source-space raster filter baking

Implemented and verified native backend, 2026-09-19. Root and independent review approved the source algorithm, protected-context admission, bounded private-file encoder and buffer ledger before implementation. Native owner, independent, schema and MCP checks pass; browser release evidence is maintained by its owner.

## Useful bounded scope

Add an explicit **Bake filters** operation to turn the current raster filter result into ordinary working RGB. This unlocks the existing brush, clone/heal, fill, placement, extraction and source-alpha refinement paths without discarding the visible grade. Preserve immutable original `sourceAsset`, working-source alpha, separate `alphaAsset`, source dimensions and every geometry entry. Do not flatten a document-space preview, mask, group, clipping chain, style or blend backdrop.

Adobe distinguishes editable Smart Filters from rasterized pixel content, and documents rasterization before tools that require ordinary pixels. These are workflow references only: Prism has its own source-space filter list and retains original assets and native transforms; this feature does not implement Smart Objects or Adobe pixel parity. [Adobe Smart Filters](https://helpx.adobe.com/photoshop/using/applying-smart-filters.html), [Adobe rasterizing Smart Objects](https://helpx.adobe.com/uk/photoshop/desktop/create-manage-layers/smart-objects/rasterize-smart-objects.html).

The existing `rasterize_layer` command is a different operation: it accepts solid/text/vector/gradient content, renders transformed canvas pixels, creates a new raster source and resets transforms. Reusing it for filters would discard source dimensions and geometry and would mishandle separate cutout alpha. Keep the commands distinct.

## API and capability

```js
bake_layer_filters({ documentId, expectedRevision, layerId })
// -> { document }
```

Require mandatory positive `expectedRevision` for this operation. In `apply_transaction`, require the enclosing transaction revision when any step is a bake; a step may omit its own revision and uses that captured revision. This gives the same atomic bake-then-retouch workflow as existing transaction commands without hidden rebasing. The UI always captures and submits that revision. Existing session request-ID deduplication applies. After companion restart, a repeated old revision rejects; there is no new durable receipt or automatic replay.

Capability: `layerFilterBaking: 'source-rgb'`; limits `maxFilterBakeWorkingBytes: 256*1024*1024`, `maxFilterBakeAssetBytes: 128*1024*1024`. Existing supported filter-kind, work, source-pixel and axis limits still apply. No new persisted field or recipe command is needed. Baking produces an asset and is intentionally excluded from the metadata-only edit-recipe allowlist.

Canonical success sets `layer.filters=[]`. A missing/empty stack rejects `NO_FILTERS`; a nonraster rejects `INVALID_TARGET`; protected target rejects `PROTECTED_LAYER`. A nonempty stack with no enabled, nonzero-opacity entry clears metadata without decoding or publishing an asset, like the existing explicit Clear operation. Disabled entries are removed, not suddenly evaluated. An active identity stack may also reuse the existing working asset if an exact RGB comparison proves that filtering changed nothing. Successful metadata clearing is still one undo step.

All metadata validation, target/protection/context checks, source-file bounds and prospective history-size preflight happen before source decoding or asset publication. Errors must describe the relevant layer/context and remain sanitized; corrupt or undecodable image inputs produce `INVALID_IMAGE`, not internal file paths.

## Exact pixels and retained source alpha

Let `W` be decoded current working `layer.asset`, with its own alpha `Aw`. The archived `sourceAsset` is not the input. A previous retouch may have changed `asset`; baking must include those edits.

The source filter evaluator includes each entry's optional RGB blend mode after its full-strength byte candidate and before entry opacity. Bake therefore fixes the complete source stack, including those modes, while leaving layer/document blending later in the compositor. A computational identity candidate under a nonnormal mode can change RGB and must not be skipped. Normal retains its original pixels/work; nonnormal adds40 work units per source pixel. The mode helper adds bounded scalar compilation only, so the surface/ring/shared-table phase formulas below remain unchanged. See [the filter blending contract](FILTER_BLEND_DESIGN.md).

1. Decode `W` to source-sized RGBA8 using the same color conversion as the existing raster renderer.
2. If a separate `alphaAsset` exists, decode it to byte plane `Ac`. Form temporary effective filter input `E` with identical RGB and `Ae=round(Aw*Ac/255)`, exactly matching `combineAlpha`. With no cutout alpha, `E` may alias `W`.
3. Evaluate every active entry in the existing array order through `applyLayerFilters`. This preserves `Ae` and zero-effective-alpha RGB, uses current alpha-weighted median/mosaic, applies per-entry opacity once and keeps existing work/yield rules.
4. Restore each original `Aw` byte into the **filtered output** before encoding. Preserve its filtered RGB. Do not save effective alpha and retain `alphaAsset`, because that would multiply the cutout twice on the next render.
5. Encode this source-sized working RGBA as lossless nonpalette PNG, publish it as the new `asset` only if pixels changed, and clear the stack. Keep the old `asset` through history and retain `sourceAsset` and `alphaAsset` verbatim.

On the next render, combining the baked working alpha with the unchanged separate alpha recreates `Ae` exactly. The source RGBA entering geometry is therefore byte-identical to the pre-bake filtered RGBA. All later deterministic geometry, masks/density/position, opacity, blend, outside styles, groups and clipping composition receive the same input. This establishes exact current full-composite equality for admitted graphs; acceptance tests must verify it independently with both translucent and invisible RGB fixtures.

Pixels whose effective alpha was zero keep their previous RGB, even if the working alpha was nonzero and only cutout alpha hid them. Later source-alpha repair may reveal these **ungraded** colors. That is explicit fixed-pixel behavior: baking does not retain a dormant filter that recomputes when a cutout changes. Spatial filters also freeze their sampling against the cutout as it existed during baking. The separate cutout remains editable, and Undo restores both the prior working asset and editable stack.

Preserve all other graph fields: layer ID/order/name/visibility/opacity/blend/protection flag, role/provenance, parent and clipping IDs, source format/original, dimensions/transforms, own mask/density/positioned source frame, styles, selections, guides, saved selections/styles and recipes. A generated layer stays generated and retains its ordinary dynamic display exclusion. No model, image-generation or provider call occurs.

## Protected-context admission

A filter render can substitute **unfiltered transformed RGB** wherever earlier protected content has a footprint. That context-dependent substitution is absent once the stack is cleared. Baking a normal filtered source and simply removing the stack would therefore alter protected appearance.

For an **active** stack, first-version admission rejects if any earlier content node in canonical depth-first layer order is protected, including hidden nodes, zero opacity, fully masked content and descendants of hidden groups. Do not allocate or render a footprint to prove present-day non-overlap. Do not inverse-map document protection into source space: affine/resampled mappings are not generally invertible and future geometry or masks could expose a different footprint. Use a distinct actionable error such as `FILTER_BAKE_PROTECTED_CONTEXT` identifying the earlier protected layer. Active identity settings do not bypass this structural guard.

This conservative rule admits the common background-below-protected-subject workflow. Later protected nodes do not participate in the target filter's earlier footprint, and unchanged source RGBA preserves the current full composition. Nested pass-through or isolated ancestors, source transforms, masks and styles do not themselves require rejection. Groups cannot be protected; protected descendants are ordinary earlier/later content nodes in the same canonical order.

Clipping bases and members remain eligible under the same guard. A chain's base and members are necessarily unprotected, so the base-before-context used by the compositor cannot contain an unnoticed protected chain member. Reject any earlier protected node globally, including in another group, even if that is stricter than the current isolated scope. Do not alter chain membership or assemble its combined RGB into the baked asset.

A disabled/zero-opacity-only stack never invokes contextual restoration and changes no pixels when removed, so only the protected-target guard applies to its metadata-only clear path. This distinction is safe and useful, but the UI must state that no filter pixels are being baked.

Future reparenting, protection toggles, source-alpha repair and newly added filters follow ordinary current rules. An already-baked grade is now source RGB; it is no longer a contextually suppressed editable filter. Do not promise that later structural edits recreate the counterfactual behavior of the removed stack. Subsequent paint/retouch still uses the full existing write-protection footprint, and a protected target is never silently unprotected.

## Phase ownership and resource plan

Validate the whole graph at entry, including current group/clipping/filter work and positioned-mask callback admission. Validate the staged graph again before publication. The bake itself performs no geometry, composite rendering, mask callback construction or protected-footprint rendering, so their render scratch is not simultaneously allocated by this operation. Keeping transforms and additional masks prevents their repeated application and avoids their large source-frame allocations.

Use `server/bounded-file.mjs` for this operation. Open each immutable working/alpha asset with `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` (the nonblocking flag lets regular-file admission reject FIFOs before waiting for a writer), inspect that same descriptor, require a regular nonempty file at most 128 MiB, and preflight the ledger before allocating either encoded input. Read exactly the admitted bytes in bounded chunks, rejecting short reads. Check the same descriptor’s size before and after reading and require SHA-256 equality with the referenced hash; growth never enlarges allocation, while truncation or same-size corruption rejects. Require PNG signature, one page and decoded dimensions matching `layer.width/height` for both roles before full decode. No other working-source format is admitted. The immutable original `sourceAsset` is not opened. Existing source dimensions remain at most 8192 per axis and 24 MP.

Approved explicit buffer estimator, for source pixels `S`, encoded working input `Ew`, encoded cutout input `Ea`, and PNG output allowance `P=5*S+1 MiB` (also capped at 128 MiB):

| Phase | Conservative accounted bytes |
| --- | --- |
| Decode / separate-alpha combination | `Ew+Ea + (alphaAsset ? 9S : 4S) + T` |
| Filter evaluation | `Ew+Ea + (alphaAsset ? 17S : 12S) + Rmax + 64 KiB + T` |
| Enabled shared mask, positive density | `Ew+Ea + (alphaAsset ? 13S : 8S) + C + LUT + T` |
| Encode after source-materialization helper returns only final RGBA | `Ew+Ea + 8S + P + T` |
| Publication, including deduplicated-asset comparison | `Ew+Ea + 4S + 2P + T` |

The filter reserve includes original working RGBA `4S`, effective input `4S` when separate alpha exists, mutable output `4S`, spatial candidate `4S`, and a conservatively retained alpha plane `S`; no-alpha input aliases the original. `Rmax` is zero for the original filter kinds and the maximum sequential rolling-cache allocation for source Gaussian/RGB sharpen, parameterized Unsharp Mask, High Pass or Local Shadows / Highlights; see [the spatial contract](SPATIAL_LAYER_FILTERS_DESIGN.md), [Unsharp Mask contract](UNSHARP_MASK_DESIGN.md) and [High Pass contract](HIGH_PASS_DESIGN.md). High Pass at sigma0 still computes its gray128 candidate within the existing candidate reserve, with no ring. Local Shadows / Highlights contributes its sequential 2048-byte response table plus, for positive sigma, its two-channel rolling cache and prepared row; see [the local-tone contract](LOCAL_SHADOWS_HIGHLIGHTS_DESIGN.md). Dual-zero amounts contribute no cache, while computing sigma0 retains the response table. This cache joins the same maximum and ends before the deferred mask phase. The estimator receives the actual stack before encoded source reads. The small fixed reserve covers histogram typed arrays. Restore alpha in the filtered output, rather than allocating another RGBA frame. Retained references across `await` count even if garbage collection might happen sooner; the ring cache returns no retained reference alongside its candidate.

For a [shared source filter mask](FILTER_MASK_DESIGN.md), evaluate the entire stack before constructing mask coverage, then interpolate its finished RGB against the retained effective source and finally restore working alpha. The mask phase retains original/effective/filtered RGBA and separate alpha (13S, or8S without separate alpha), plus C=0 for geometry, S for an unfeathered bitmap or5S for a feathered bitmap, and a256-byte LUT only for fractional density. C does not coexist with Rmax, so compare the phases rather than summing them. Disabled masks/density0 add no mask phase. An inactive Bake clears both entries and mask without image I/O; any successful active Bake also consumes both. Existing arrays retain their old estimates and serialization. The filter-mask owner and audit suites pin cases where the old filter phase fits but the new18S-plus-LUT mask phase refuses before source bytes are read.

`T` is4096 when the actual stack contains any enabled, positive-opacity, positive-amount Gaussian Add Noise entry, otherwise zero. It is added once to every phase because the private shared table remains resident after filtering; it is not a sequential ring and must not be combined as `max(Rmax,T)`. Metadata estimation does not initialize the table. [The noise contract](NOISE_FILTER_DESIGN.md) documents the certified bytes and this per-use reservation, distinct from total process memory.

The encode phase retains final RGBA `4S` and reserves another `4S` codec-facing surface. Keep Sharp’s nonpalette RGBA8 encoder, but call `png().toFile()` into an operation-owned `0700` directory created with `mkdtemp`. Installed Sharp stream output first allocates a complete native output buffer and then pushes it, so a downstream stream collector does not provide this guarantee. The actual file encoder writes PNG directly through libvips’s `pngsave` path.

After the encoder finishes, open its private output with `O_NOFOLLOW`, admit its actual size against `P`, and only then read exactly that size through the bounded same-descriptor reader, computing its SHA-256 and rechecking size. Remove the owned temporary directory in `finally` on success, encoder error, limit rejection and read error. No image asset is published while that temporary file exists. `P=5S+1 MiB`, capped at128MiB, is a declared admission ceiling, **not a proof that every valid image will fit**. A larger encoded file can be produced on disk and then rejected before any JavaScript output buffer allocation. This deliberately makes no hard temporary-disk or native-codec/RSS promise. Do not reduce precision or silently fall back to another output format.

The source-materialization helper returns only final RGBA, so original/effective/alpha/candidate references do not cross into encoding. Encoded inputs remain conservatively charged through all phases. Publication counts the final PNG plus a possible exact-length deduplication read. `storeAsset` now opens an existing destination without following symlinks, requires its size to equal the new PNG’s length **before allocating**, reads exactly that many bytes from the same descriptor, and checks its final size and hash. A corrupt or growing deduplicated file cannot trigger an unbounded `readFile`; `EEXIST` never implies ownership. This bounded comparison also hardens existing publication paths without changing their successful results.

Take the maximum of phases and require at most **256 MiB** before allocating source surfaces. Safe integer arithmetic is mandatory. This is an explicit byte-buffer admission policy, **not total RSS**: Sharp/libvips internals, caches, JavaScript metadata, project serialization and unrelated operations are not fully modeled. The policy may refuse a large source whose existing editable filter render was valid. Report the source/working-buffer limitation clearly instead of changing fidelity, cropping or bypassing the cap. Existing 384-million source-filter work remains authoritative (including Color Balance 40/10 and Black & White 7).

Reusing `applyLayerFilters` retains its row yields and exact fallback policy. New alpha-combination/restoration/comparison loops must yield at at most 65,536 pixels. PNG encoding is asynchronous native work. No fully cancellable or hard timer-latency guarantee is added.

## Atomic publication and transactions

Use the existing instance-owned `AsyncLocalStorage` new-asset collector over the **complete mutate-to-commit interval**, for standalone bake and any transaction containing bake. Extend the existing repair wrapper with an explicit bake-scope flag without changing ordinary unrelated commands. Transactions containing both repair creation and bake use one scope; do not nest collectors or lose either operation's ownership.

`storeAsset` records only hashes newly published by this scope's successful `fs.link`. Retain every existing deduplicated asset. All later asset writes in a bake transaction, such as the following retouch, join the same collector. On decode/filter/encode/staged-validation/late-operation/prepublication-persist failure, remove only those new blobs and retain prior project, history, revision and preview cache. If a test extension throws after actual project publication, retain assets referenced by the published state rather than corrupt it. Cleanup failure in any scope containing bake, including mixed repair/bake transactions, uses `FILTER_BAKE_ROLLBACK_FAILED`. Repair-only scopes retain `REPAIR_ROLLBACK_FAILED`.

Before the first asset write, build a prospective commit with a syntactically valid placeholder SHA-256 replacing only `asset`, clear the stack, and check the actual serialized history limit. Replacing a 64-character hash with the real output hash cannot enlarge that metadata. The actual final commit still validates and enforces the 16 MiB limit. In a transaction, later metadata growth can still fail; the whole-scope collector rolls back every new asset then. Do not promise global preflight of future steps before their existing mutation logic runs.

Undo/redo retains both source and baked working assets through ordinary graph history. Reopen uses the resulting ordinary raster graph. `.prism` current-state export naturally carries the original, baked working image and unchanged alpha; no codec change is required. PSD remains subject to its existing subset checks: clearing this stack alone does not waive group/style/provenance/opacity/mask restrictions.

## Design probe and required acceptance

A design-only in-memory probe lives in `test-results/filter-bake-evaluation/probe.mjs` with `report.json`. It invokes current filter and geometry helpers without publishing any project or asset. Across all 22 filter kinds, full/partial entry opacity and with/without separate alpha, 88 cases preserve exact proposed PNG roundtrip pixels and 352 crop/resize/canvas/affine cases produce equal geometry output. A one-pixel counterexample records why lower protection cannot be ignored: original `[20,60,110,255]` restored under protection versus naively baked invert `[235,195,145,255]`. This proves arithmetic feasibility only, not production publication/resource behavior.

Production acceptance must cover:

1. Actual before/after full-composite equality for noncommuting filter order, entry opacity, all tonal half ties, median/mosaic, source alpha0/1/128/255 and invisible RGB; original files remain byte-identical.
2. PNG's original working alpha plus unchanged `alphaAsset` recombines exactly once. Later cutout repair reveals the documented ungraded previously-hidden RGB. Source preview remains original, mask preview remains separate alpha, content selection uses new working pixels.
3. Crop/resize/affine and source off-canvas data remain editable without resetting transforms; own and ancestor masks/density/positioned masks, effects, normal/nonnormal groups and clipped base/member output stay exact.
4. Protected target rejects. Every earlier protected node rejects active bake before image I/O, including hidden/masked/nested cases. Background below protected subjects succeeds with exact protected appearance. Bypass-only metadata clearing requires no source read or asset write.
5. Graph admission, phase boundaries, oversized encoded input/output, corrupt/missing files, work limits and metadata size reject before publication. Test limits without allocating their large fixtures; verify actual helper lifetimes/call paths.
6. Bake then brush/clone/heal/fill/place/extract/refine works under each operation's remaining restrictions. Reordered/new filters apply once to the baked pixels. No implicit model call or automatic unprotection occurs.
7. Standalone and bake-plus-retouch transaction produce one undo step; late operation and actual filesystem persistence failures remove fresh bake and later-stroke assets, retain `EEXIST` originals and preserve cache/history. Include repair+bake in one transaction and unrelated asynchronous asset publication outside the scope.
8. Stable transport retry, stale revision, undo/redo/reopen/portable archive and distinct UI Bake versus Clear behavior. Confirm explicit loss of entry editability before the action through clear nearby copy, not a new permission dialog.

Root and independent review approved the mandatory revision convention, capability/error names, same-descriptor reads and private-file encoder/ledger before production integration.

## Verification record

The owner suite `tests/filter-bake.test.mjs` has 11 passing cases. It covers actual source RGB/working alpha, all28 current filter kinds, original and separate-alpha bytes, grouped/masked/styled/transformed full-composite equality, generated clip-member metadata, earlier protection, bypass/identity, work/resource admission, private0700 temporary-file cleanup and capped output before read, immutable same-descriptor/hash checks, queued snapshots, prospective metadata refusal, one-step bake/brush transactions, undo/portable/reopen, real `ENOTDIR` failure, reused assets, mixed repair/bake cleanup errors and conservative postpublication ownership. The subsequent source-spatial, Unsharp Mask, Add Noise, High Pass and Local Shadows / Highlights suites add positive blur/sharpen, nondefault unsharp/noise, exact residual/zero-gray candidates, stack-dependent cache admission and persistent-table reservation in all four phases.

The independent audit `tests/filter-bake-audit.test.mjs` passes10cases, including counted fresh publications across late failure, mixed repair/bake/paint operations and unrelated concurrent helper-asset survival. The official MCP workflow and three schema checks pass. A combined72-test sweep includes both bake suites, schema/MCP, existing retouch and its audit, layer filters, portable native projects and tonal native checks.

Root found that a named FIFO could block `open(O_RDONLY)` before `fstat` rejected it. Both the new bounded-file helper and the existing bounded project-asset reader now include `O_NONBLOCK`; regular-file behavior is unchanged. The owner’s isolated child test has a3second SIGKILL deadline and verifies source reading, deduplication and portable-project asset reading reject FIFO hash paths without a writer, leave the FIFO untouched and remove temporary asset files. It passes in roughly92ms here; independent review repeated the source/dedupe checks. This is a correctness regression check, not a general filesystem-latency promise.

The root's final full rerun after both nonblocking-open fixes passes all 751 tests; doctor reports 93 commands. Backend ownership is released.

Implementation files are `server/filter-bake.mjs`, `server/bounded-file.mjs` and the focused native dispatch/publication integration. No original image, mask, transform, recipe schema or project-bundle format migration is required. Public usage and UI evidence are maintained separately.
