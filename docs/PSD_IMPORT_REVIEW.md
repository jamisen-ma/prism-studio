# Independent review: bounded layered PSD import

Status: independent design and implementation review on 2026-09-19. The approved bounded implementation supports 1–64 layers, no merged-only fallback or pre-import preview API, and simple disabled/inverted masks. The independent [audit suite](../tests/psd-import-audit.test.mjs) passes 13 tests; its combined run with the owner suite passes 24 tests. HTTP/MCP and browser checks are tracked separately by their owners. This is a strict raster subset, not general Photoshop import parity.

## Evidence and interpretation

Adobe's format specification describes independently delimited file sections, distinct layer transparency and user-mask channels, mask rectangles/default coverage, and per-channel compression. It also distinguishes additional appearance records from raw raster channels. Therefore a valid-looking RGB header is insufficient evidence that importing only pixels reproduces a document. The proposed subset below deliberately rejects unsupported semantics. [Adobe Photoshop File Formats Specification](https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/).

The installed, isolated `psd-tools` 1.19.0 producer was exercised in memory during this review. Its 751-byte, 7×5 flat fixture contained an opaque background and a hidden 4×3 layer at (1,1), opacity 191, with alpha values 0/1/128/255. The output had three merged channels, two positive-count layer records, resource 1057, raw merged data and RLE layer channels. Both layers had separate transparency and user-mask channels; the source RGB and user-mask bytes decoded exactly. The producer emitted visible flags `08`, hidden flags `0a`, and 40 bytes of neutral blending ranges composed of default source/destination pairs. No production files or fixture files were changed by that experiment. Its public layer API separately exposes raw image extraction, composition, masks, opacity and bounds; those operations must not be conflated by our conversion. [psd-tools layer API](https://psd-tools.readthedocs.io/en/latest/reference/psd_tools.api.layers.html).

Earlier local evidence remains relevant: [PSD_CODEC_EVALUATION.md](PSD_CODEC_EVALUATION.md) and the synthetic files in `test-results/psd-evaluation/` demonstrate input-view overreads, unchecked ZIP expansion, ignored unknown records, dropped ICC, and lossy transparent merged-image handling in the evaluated general-purpose codec. Those are reasons to use a strict bounded parser, not reasons to trust any new parser without equivalent rejection fixtures.

The follow-up saved experiment is reproducible with [produce.py](../tests/fixtures/psd-import/produce.py). Its independent [raw](../tests/fixtures/psd-import/flat-raw.psd) and [PackBits](../tests/fixtures/psd-import/flat-rle.psd) files are 1,172 and 1,097 bytes. Both layer and merged compression are exercised. Each has a 9×6 canvas, a hidden Unicode 5×3 source at (-2,2), and a visible 3×5 source with genuine soft source alpha plus a separate 3×4 mask at (4,1). Assertions verify every RGB, source-alpha and mask byte, including invisible RGB. Pillow also decodes the saved merged image. The [record inventory](../test-results/psd-import-evaluation/report.json) confirms only resource 1057, only the `luni` additional key, default mask flags/black outside coverage, neutral 40-byte blend ranges and no ICC. These are foreign-producer fixtures, not self-roundtrips through the application codec.

## Recommended initial subset

Accept PSD v1, 8-bit RGB, flat normal-blended pixel layers, bounded integer geometry, byte opacity, visibility, layer names and one simple raster mask. Raw channels and bounded row-wise PackBits are sufficient. Accept full source-layer RGB and alpha independently of its additional mask; retain invisible RGB. Require 1–64 layer records and positive dimensions within the native 8192-axis/24 MP bounds, including every individual source and mask rectangle.

Initially require three merged channels and reject the merged-transparency marker explicitly. Individual layers may still have transparent pixels. Do not confuse this restriction with requiring every layer or the new native composite to be opaque. Support for four-channel/negative-count merged transparency should wait for its own independently decoded fixtures and a clearly chosen matte convention.

Decode and structurally validate the merged image to the exact file end, even when the native preview is recomposed from layers. A stale or differently rounded saved merged image is not authoritative native source data. Report that Prism uses its native compositor; never silently replace unsupported layers with the saved merged image or promise byte-identical Photoshop compositing.

Reject these features before materializing a native project:

- Groups, text/vector/adjustment/fill/smart-object records, clipping participants, nonnormal blend modes, nondefault blend ranges and nondefault fill opacity.
- Real/vector/relative/render-derived masks and mask parameters such as density or feather, even though Prism has its own density control. Matching parameter names are not proof of identical semantics.
- Pixel-data-irrelevant or unrecognized flag combinations, ambiguous channel lists, duplicate required channels, unsupported channel IDs and inconsistent mask metadata/channel presence.
- Unknown appearance-bearing records at either layer or document scope, alternate layer information, linked data, extra global-mask payloads, unsupported ICC and ambiguous transparency data.

A small explicit metadata allowlist can support the native writer and independent flat producer: Unicode names, known harmless layer IDs, the known sRGB resource and bounded version information. Any additional harmless resource requires a documented reason and explicit warning/preservation policy. Empty or nonempty unknown records must not become an escape hatch. Known groups/effects/filter records reject even when hidden or disabled.

## Pixel and mask semantics

Use the transparency channel as source alpha; absent transparency means full source alpha. Keep the user mask separate. The independent producer proves why multiplying its mask into the source and also retaining it would square soft edges.

Project a supported mask into document coordinates using its own rectangle and outside default, without borrowing the layer rectangle. Accept only an explicitly tested default and flags combination, or reject the others. Root approved retaining a disabled simple mask with native density zero and an explicit warning; inversion remains editable, while relative/real/parameterized masks reject. Silently deleting a disabled mask is not editable fidelity. PSD transparency locking must never become Prism's much stronger original-person protection.

Allow empty, all-black and all-white mask content only when the metadata remains internally consistent. Enforce the existing 200,000-run bitmap limit and 16 MiB complete project-envelope limit before any assets are written. A valid external mask that exceeds these native bounds must fail clearly; do not quietly turn it into source alpha.

Signed source bounds need a deliberate first-version policy. Preserving the cropped source RGBA plus an integer native canvas transform retains the original layer bytes and current visible placement. However, the canvas stage clips pixels before later affine moves: moving that imported layer cannot reveal pixels that were outside the original document canvas. Either reject off-canvas source bounds initially, or disclose this existing native geometry limitation and test the archived/source pixels separately from future edit behavior. Do not call it full Photoshop geometry preservation. Mask bounds outside the document may be projected only under an explicit bounded/default rule.

Names need strict bounded decoding: do not guess UTF-8 for a legacy Pascal name. Prefer a valid Unicode record; define the supported legacy encoding otherwise. Reject malformed surrogate sequences, excessive code-unit counts, forbidden controls and duplicate conflicting name records. Any normalization or generated fallback name needs an import warning. External layer IDs are metadata, not native UUIDs; create fresh IDs.

## Color policy

Recommend a registry of exact known sRGB profile bytes/hashes for the first slice. A description string containing “sRGB” is insufficient, and a valid RGB ICC header does not establish the required transfer curves/primaries. A mismatched or unsupported profile rejects rather than being dropped.

Untagged input requires an explicit `assumeSrgb` policy recorded in inspection/import results. This can be an ordinary import control, not a conversational approval flow. Reimport must bind the same bytes, parser version and color policy. Preserve source bytes under that interpretation; do not claim color conversion was performed. Contradictory untagged/profile metadata and duplicate profiles need rejection fixtures.

## Byte and allocation boundary

The implementation uses 64 MiB input, 64 layers, 4,096 metadata records, native dimensions, 256 MiB explicitly accounted working storage, one active decoder, at most two waiting files and a 30-second worker deadline. These are application limits, not PSD format limits or whole-process RSS guarantees. The working/storage/complexity checks can reject a file smaller than 64 MiB, including a native export; the input-size limit is not a promise that every file within it imports.

The parser should first walk bounded records into a compact plan, then decode only after all channel dimensions, metadata sizes and aggregate reservations pass. Every cursor has a parent end; checking against the outer Buffer alone is inadequate. Check safe integer arithmetic for sums/products, validate lower and upper bounds, reject overlaps/impossible rectangles, and verify all section/channel payload lengths including legal padding. No nested record may borrow bytes from the next record.

For PackBits, bind each scanline to its advertised compressed slice and fixed output width. Every literal/repeat operation must fit both bounds; a no-op still consumes input. Require exact output length and consume the complete row, allowing only explicitly supported no-op padding after output completion. Reject row underflow/overflow, missing repeat bytes, literal truncation, incorrect row tables and payload totals. ZIP and prediction modes reject before decompression. Avoid recursive decoding and make every loop demonstrably advance.

Use an owned exact input view; do not accidentally parse a pooled Buffer's wider backing allocation. Transfers may avoid copies only when ownership is exclusive. Budget concurrent input copies, decoded channel/RGBA buffers, mask expansion, RLE metadata arrays, PNG outputs, worker messages and native validation scratch at their actual overlapping lifetimes. A V8 heap limit does not bound ArrayBuffers or image-library memory. Do not decode every full-canvas layer simultaneously merely because each one fits.

Deadline/cancellation tests must terminate the actual worker and confirm that no late result can publish. Queue waiting needs a separate clear policy. Inspection is read-only and should never create a document or asset. A disconnected inspection aborts its worker, and admission is released only after termination finishes. An accepted HTTP import deliberately continues once native import starts, even if one or every response waiter disconnects; its stable request ID recovers the durable result. A disconnected import waiter cannot cancel shared publication. Direct native cancellation remains explicit and is checked before publication; an already published document is recovered rather than rolled back.

## Typed immutable source archive

The implemented `graph.sourceDocument = { format:'psd', asset, bytes, name }` is an archival role, separate from raster `asset`, `sourceAsset` and `alphaAsset`. Never insert PSD data into a raster source reference: existing previews, validation and portable-project rules expect supported raster images there. Per-layer source PNGs preserve extracted RGB/alpha; the separate archive preserves the original PSD container byte-for-byte.

For this passive role, bounded header/signature checks plus exact declared size and SHA-256 are sufficient on `.prism` import/export and original download. Startup validates persisted archive metadata without rereading all archive bytes; each subsequent archival read performs fresh binary validation. Rerunning the semantic PSD importer is unnecessary provided the archive is never rendered, interpreted as an executable/linked object, or used as proof that the independently validated native graph came from that PSD. A portable project may attach a bounded PSD archive with unsupported internals without gaining unsupported editable features.

Require strict archive metadata, a 64 MiB archive cap, matching actual bytes and format, and a hash that is not also referenced in any raster role. Keep the bundle's total 256 MiB bound. Its current 192-asset maximum corresponds to 64×3 raster references; a full project plus one archive needs a maximum of 193 unique assets. Update reference enumeration, role validation, deduplication, rollback and roundtrip tests together.

Archive reads use no-follow regular-file access and fresh size/hash verification. Downloads use a bounded safe filename, attachment disposition and an inert content type; they must not call sharp or the PSD decoder. Names from the PSD never become local paths or external URLs. The archive survives ordinary edits, undo/reopen, new-document import and portable export without affecting image rendering.

## Atomic native integration and retry contract

The first import always creates a fresh document, fresh layer UUIDs and one initial history entry. No existing document, source asset or selection is overwritten. Preserve original source-layer PNGs and archive bytes immutably; preflight the entire native graph, mask complexity, image bytes and serialized initial project envelope before publishing asset files.

Reuse tracked creation and rollback semantics from portable import. Delete only assets newly created by this failed operation, never pre-existing shared hashes. Hold native serialization across commit/rollback, revalidate worker output in the parent, and publish the project only after every asset succeeds. A late persistence failure must leave no visible half-import; cleanup failure must be reported accurately.

Bind inspection to input SHA-256, byte count, parser version and assumptions. A file picker change, edited file, changed policy or changed parser invalidates the old result. Import must validate its own bytes rather than trust a client-supplied report. Use an explicit request ID bound to that fingerprint; same-ID retries recover one document, and a conflicting payload rejects. To survive a crash between project publication and a separate receipt write, store a recovery receipt atomically with the published project or use an equivalently durable design. A lost HTTP response is not proof that importing failed.

## Required rejection and fidelity fixtures

1. Native raw exports and a fresh flat independent producer: odd dimensions including 1×1/1×N, asymmetric RGB, hidden RGB, source alpha 0/1/128/255, independent mask 0/1/128/255, exact byte opacity, Unicode, hidden layers and stack order. Verify raw bytes, editable graph, native composite, source preview, archive and portable roundtrip separately.
2. Every length boundary: truncated prefix/section/header/table/channel, length reaching into a sibling, exact one-byte-over cap, impossible rectangle, duplicate/missing channels, exact logical view surrounded by canary bytes, unsupported signatures/compression and trailing junk. Check padding from both local producers rather than interpreting ambiguous prose by guesswork.
3. PackBits signed controls, legal no-ops, literal/repeat limits, output width overflow/underflow, row-table sums, zero-byte rows where pixels are required, truncated last row and compression bombs. No zero filling or accepting a partial image.
4. Default and nondefault masks/ranges/flags; swapped layer/mask rectangles; default outside black/white; all invisible records; every unsupported appearance family at layer and global scope. Unknown records must produce a named refusal, not silent raster fallback.
5. Known sRGB, explicit untagged assumption, unsupported/duplicate/malformed profile, transparency marker/four-channel refusal, malformed Unicode and conflicting names. The original archive hash remains exact through every accepted case.
6. Aggregate source/mask/encoded-buffer limits, bitmap-run overflow, metadata-envelope overflow, timeout, worker crash, cancellation before/during decode, queue admission and disconnect. No source or project writes from inspection or rejected input.
7. Storage failure at each publication boundary, shared pre-existing assets, retry after response loss, simultaneous identical requests, conflicting IDs, restart and receipt recovery. Existing projects/caches/assets remain exact.
8. Archive/raster role collision, false declared size, wrong digest/header, path-like filenames, symlink/missing/corrupted archive, 193-reference boundary, bundle total cap and original download after native edits. Archive operations never invoke an image decoder.

## Independent implementation evidence

The 13 passing audit tests independently verify:

- Raw and PackBits source RGBA, hidden RGB, Unicode/visibility/byte opacity, independent mask planes, all eight outside-default/invert/disabled combinations, fresh identities, archive equality after edits/reopen and portable roundtrip.
- Twenty-three corrupt or unsupported record mutations, truncation/trailing bytes and malformed PackBits tables; rejected files leave no projects or assets. Exact logical Buffer views and immediate caller mutation cannot change admitted bytes.
- Durable concurrent/restarted same-ID recovery, changed-interpretation conflicts, hash/version refusal, and no receipt inheritance through a portable clone. The first audit found a changed-assumption conflict returned the wrong error after decoding; receipt checks now precede that path. Native stale-hash errors now match transport `INSPECTION_STALE`.
- Failed asset writes and failed project persistence remove only newly created files, preserve preexisting shared archive assets, and leave the same request retryable. Fresh archive reads reject corrupted or symlinked files even when a document preview is cached. Structurally invalid portable archive metadata and image/archive role collisions reject before raster processing; a plausible but false length fails passive binary validation before writes.
- Explicit native cancellation after the first asset write rolls back completely, while cancellation after atomic project publication returns and recovers the successful document. Neither path creates duplicate projects when retried with the same identity.
- One thousand seeded independent PackBits literal/repeat/no-op cases, with row canaries and malformed underflow/overflow packets. Exact known sRGB preserves RGB; valid unknown, duplicate, malformed and contradictory ICC metadata cannot be bypassed using the untagged policy.
- A controlled worker that delays termination keeps its active admission reservation and blocks queued dispatch; a late result cannot publish. Shared decoded-work reservation rejects before permission to decode. An actual worker deadline rejects only after its thread has terminated.

These checks do not establish Photoshop-compositor equality, unrestricted off-canvas edits, general ICC conversion or unsupported feature preservation as editable native content. Expanded color spaces, ZIP, groups/appearance records and transparent merged-image interpretation remain separate work.
