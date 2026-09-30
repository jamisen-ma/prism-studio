# Color Lookup transport and MCP review

Design only, 2026-09-19. The API direction below is agreed; numerical/resource release gates remain in the forthcoming native design. This note records transport constraints and acceptance ownership; it does not register a feature.

## Atomic local-file workflow

The planned file helper reads one explicit absolute `.cube` path and forwards its original bytes to the same strict native command used by the browser. It does not create a document, upload an unattached library asset, search directories, infer a color space from the filename, or invoke a provider. A required positive revision pins the destination. The explicit encoded-sRGB interpretation travels in the command payload, not in an unstated client default.

For a proposed 4 MiB original-byte limit, canonical base64 needs at most `4*ceil(4194304/3) = 5592408` characters. The existing 42 MiB JSON transport cap accommodates this without an increase. The public schema must bound the string before decoding; native validation must additionally check decoded length and canonical encoding, because a base64 character limit alone is not an exact byte limit. Original bytes remain immutable and hash-addressed. No file path belongs in the durable descriptor.

The file wrapper should open a regular local file using nonblocking/no-follow flags, stat and read through that same descriptor, allocate at most the allowed size plus one sentinel byte, and reject an observed length change. Stat alone does not bound a later `readFile` if the file grows. Extension checks choose the intended workflow; strict format parsing establishes validity. Filesystem and parser errors must not include file contents, private credentials or unrelated directory data.

The caller supplies a stable `requestId`. A repeated identical file/payload must use the existing companion deduplication mechanism; changed content with the same ID must conflict. The wrapper must not invent automatic retries after an uncertain response. A saved document and its current revision remain authoritative. Deduplication is session-scoped unless the final native design explicitly adds durable receipts; no stronger guarantee should be implied.

Replacement must preserve unrelated authored state: layer/filter identity, placement, opacity, blend, mask, enabled/visible state and other entries. The proposed `import_color_lookup` target is `adjustment` (optional `layerId` replaces a saved Color Lookup; omission adds) or `layer-filter` (required `layerId`, optional `filterId` replaces; omission appends). Arguments include canonical base64 `data`, safe `sourceName`, explicit `inputSpace:'srgb'` and positive `expectedRevision`. The result includes `document`, affected `layerId` and optional `filterId`. The complete parameter descriptor is `{asset,bytes,gridSize,inputSpace:'srgb',sourceName,title?}`. Exact field bounds await the native contract. The target discriminant decides add versus replace explicitly. A source replacement cannot silently append when its target disappeared. The browser's local file draft and MCP helper both end in one native commit/Undo step.

## Validation and ownership

Shared command schemas, optional bridge refusal, direct native call-time snapshots and transaction semantics must agree. File bytes, names, target metadata and input interpretation must be owned before entering the queue; revision and actual target checks occur inside it. Existing asset descriptors reused through ordinary add/update commands need verified typed assets before a new graph is published. No resolver may read a path from supplied parameters.

The agreed direction supports transactions with a positive outer revision, owned operations and at most 4 MiB of aggregate decoded LUT import bytes across all operations. Newly written LUT assets participate in transaction failure cleanup. Ordinary descriptor reuse remains a metadata operation followed by bounded verification before publication; an empty parameter patch is a no-op and a nonempty descriptor patch must be complete. Parser and phase review still gate production release.

Recipes remain self-contained in this first slice. Adding a new adjustment kind to a generic enum must not accidentally authorize a LUT-bearing recipe slot or filter step. Shared recipe validation and native normalization must refuse those definitions before asset I/O. Capturing unrelated style properties with an explicit filter opt-out remains possible; applying an ordinary dependency-free recipe to a document containing a LUT is not globally prohibited.

## Root acceptance ownership

Root owns shared command/recipe validation, status forwarding, MCP registration/file wrapper, strict schema tests and official SDK integration tests after the descriptor/API is frozen. Native parsing, typed asset traversal and resource admission remain with architecture. UI and independent numerical/asset audits have separate owners.

Official SDK coverage should verify discovery/help and exact capability forwarding; local-file add and in-place replacement; schema refusal before HTTP; original byte/hash retention; source/global pixel results against independent fixtures; source blend, deferred stack mask, geometry and raw-alpha Bake; Undo and retry semantics; portable current-state transfer and reopen; inactive/history-only references; recipe refusal; and actual save/late transaction failure cleanup as supported by the final API. Unsupported formats, missing files and stale targets must fail without altering the document or asset set.

Tests use isolated temporary companions, fake forbidden provider/key/segmentation functions and captured stderr checked for token disclosure. No real user project or secret is needed.

## Local-file prototype evidence

`test-results/color-lookup-mcp/file-probe.mjs` passes 11 isolated filesystem cases on the development machine: exact original bytes, symlink refusal, nonblocking FIFO refusal, directory/empty/oversize refusal, the exact 4 MiB/5,592,408-character boundary, observed growth and shrink, same-descriptor ownership across path replacement, and missing files. Temporary files are removed. This is an unregistered design probe, not production acceptance.

A same-descriptor bounded read does not establish an atomic snapshot against arbitrary concurrent same-length in-place writes. The received bytes must still pass strict parsing and hashing; documentation must not promise detection of every concurrent writer.

The independent transport probe `test-results/color-lookup-mcp/base64-probe.mjs` also accepts 4,099 generated canonical encodings and rejects 19 malformed/boundary cases. It validates alphabet, complete quartets, terminal padding, canonical pad bits and decoded length before allocation, without a repeated-capture regular expression over a multi-megabyte string. The tested implementation remains an unregistered prototype pending the shared contract.
