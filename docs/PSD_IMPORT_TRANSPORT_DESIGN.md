# PSD import transport contract — draft

Approved integration contract; transport and MCP modules are implemented behind pending service wiring. Root owns these modules and integration tests. Current PSD export endpoints stay separate.

## Binary requests and review binding

- `POST /api/psd/inspect-import`: authenticated bounded PSD/octet-stream body. Query options include `assumeSrgb=true|false` (default false), source filename and optional new document name. Run the complete importer inspection without publishing any files or document. Return the versioned report, exact source SHA-256, dimensions/layer summary, named issues/warnings and explicitly interpreted color policy. Malformed input has a structured error; structurally valid unsupported input has a report with `supported:false`.
- `POST /api/psd/import`: resend the same bytes/options with required `X-Prism-Request-Id`, `X-Prism-Expected-Sha256` and `X-Prism-Importer-Version`. Validate the byte hash and interpretation contract, then rerun the complete native import validation. Create one new document only. The report does not constitute a retained upload token or bypass validation.
- `GET /api/psd/:documentId/original?expectedRevision=N`: read the retained archival asset independently of current raster rendering. Verify immutable hash/byte length and return a safe attachment with document/revision/source-hash headers. The archive is the original PSD container, not a fresh PSD export of the edited scene.

A change to the selected file, interpreter options or importer version invalidates the reviewed state. Importer version is a shared constant and increments when the interpretation contract changes. `assumeSrgb` is an explicit interpretation choice for untagged RGB; it never overrides an unknown embedded profile.

No base64 file payloads in JSON or MCP text. Uploads have a 64 MiB cap, validated Content-Length when present, streaming actual-byte enforcement and rejection of incomplete bodies. Authentication and Host/Origin checks happen first. Limit concurrent PSD import inspections/imports/downloads to two, with released slots on exceptions or disconnected responses. Native parser workers enforce their own accounting/deadline limits independently of HTTP admission.

## Retry and publication

The import receipt fingerprint includes source SHA-256, interpreter version, `assumeSrgb`, original filename and requested document name. A reused request ID with different input/options rejects `REQUEST_CONFLICT`; matching concurrent requests await the same operation. A successful receipt survives a lost response. Return the persisted document on retry, retaining the original import report; never retain a complete PSD buffer or document graph in a completed receipt. Bound in-memory coalescing receipts to the most recent 200 completed imports, with pending operations not evicted. Native publication atomically retains a small top-level project receipt, outside the portable graph/history, so restart and cache eviction still recover the same request.

Native import owns validation, asset staging, project publication and rollback. An unsuccessful import removes only newly created assets/project files and preserves shared assets and all existing documents. Transport never fabricates a receipt before native publication or automatically retries with a new ID. A detached client need not cancel a committed import; keeping its receipt prevents duplicates. Read-only inspection is aborted on disconnect; its worker must terminate before admission is released. Accepted imports deliberately continue once native.importPsd starts: one disconnected waiter cannot cancel another waiter’s shared import. Durable recovery returns the committed document after response loss.

## MCP tools

Registered module names (service wiring follows backend verification):

- `prism_inspect_psd_import_file`: bounded exact local file read, optional explicit sRGB interpretation, complete compatibility report. Read-only annotation.
- `prism_import_psd_file`: local file plus reviewed SHA-256/importerVersion/options and required stable request ID. Creates a new native document and returns its report. Unsupported files reject; no flattening fallback.
- `prism_export_original_psd`: exact retained archive to a unique private local file, with hash and byte count. Distinct from `prism_export_psd`, which renders the current native scene.

MCP file reads must use one descriptor and bounded allocation; verify complete expected bytes and detect length changes. Downloads validate MIME, declared/actual length, document/revision/hash headers and returned bytes before `wx` publication. Use mode0600 files below the configured export directory; never return private tokens or file bytes in text context.

## Required integration evidence

- Unauthorized/cross-origin requests reject before reading or invoking native import.
- Unsupported reports, malformed length/header options, mismatched SHA, stale importer version, changed interpretation/name and conflicting receipt IDs cannot create projects or assets.
- Matching concurrent/retried requests create exactly one project; success after client disconnect remains recoverable; failed native publication can retry the same ID safely.
- Two-transfer admission and slot recovery are observed with controlled deferred operations and real HTTP disconnects.
- Portable `.prism` round-trip retains the archive and rejects archive/raster role confusion, changed archive length/hash and files over64MiB; unrelated projects remain intact.
- Original download is byte-exact after normal edits and reopening, rejects a stale revision/corrupt asset and never includes modified native pixels.
- An official MCP SDK workflow imports independently produced PSD bytes, edits a layer, inspects real pixels, exports the source archive, and validates its hash and private destination permissions.
