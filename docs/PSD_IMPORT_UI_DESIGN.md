# PSD import review and transport

Status: implemented, September 19, 2026. The native importer accepts PSD v1 RGB8 flat raster layers in normal blending, with simple user masks and raw/PackBits channel decoding. Limits are 64 MiB input, 8192 pixels per axis, 24 MP canvas, 64 layers, and a separate 256 MiB accounted work budget plus bounded mask complexity. ZIP, PSB and general Photoshop interchange are outside this milestone. The authoritative accepted-record policy is in [PSD_IMPORT_DESIGN.md](PSD_IMPORT_DESIGN.md). Import requires review before publication; the saved merged image is never substituted for editable content.

## Recommendation

Use a two-step flow: **inspect the selected file without publishing a document, then explicitly import the compatible file as a new native document**. A report belongs to exact file bytes and a parser-policy version, not to a filename or the currently selected canvas. Never substitute the saved merged image for unsupported layers. Keep `.prism` as the complete native editable project format.

The existing [PSD export panel](../client/PsdExport.tsx) provides suitable compatibility-report presentation, but its document/revision identity is different from import's file/hash identity. Keep import and export state separate in a new `client/PsdImport.tsx` dialog; App should own only the selected File/session and entry/exit callbacks. The existing [project transfer](../server/project-routes.mjs) and [client binary helpers](../client/api.ts) provide authentication, bounded upload and stable retry patterns; don't send PSD through `fileBase64` or the ordinary `import_image` command.

## Entry and review

- Add capability-gated **File → Open PSD…** with its own native-only file input accepting `.psd,image/vnd.adobe.photoshop`. Route `.psd` drag/drop to the same review flow before the ordinary image MIME whitelist. An empty or generic browser MIME does not prove an otherwise valid PSD is unsupported; server signature validation is authoritative.
- Keep **Open image**, **Open project** and their existing shortcuts unchanged in this first slice. No Photoshop connection, installation or API key is involved. Optional Photoshop backend should offer returning to Native rather than uploading into its bridge.
- Retain the `File` object in App-owned import state while the dialog inspects or retries. Reset the input element so the same file can be picked again. Only one pending PSD is needed. Selecting a replacement clears the old report and aborts its inspection.
- Title: **Open layered PSD**. Intro: “Imports compatible raster layers and masks as a new Prism document. This version supports a limited PSD subset.” Show sanitized filename, file size, dimensions, layer count and color/depth when available.
- While checking, show an indeterminate **Inspecting PSD…** status; do not invent a percentage. Inspection must not alter the current document, source assets or document list. It must remain cancellable.
- Untagged RGB requires an explicit **Interpret untagged RGB as sRGB** option when the report requests it. Default it off. Toggling it clears eligibility and re-inspects the same file; the subsequent report carries a visible assumption warning. Unknown ICC profiles remain unsupported and do not receive an override. This is a color interpretation choice, not a generic confirmation checkbox.
- A successful report shows **Compatible with this PSD subset**, the retained editable properties, and any conversion/omission warnings. Unsupported reports show **This PSD cannot be imported**, with named layers/records and plain explanations. Missing Unicode names can use the reported original layer index; these are not Prism layer IDs yet.
- The primary button is **Import as new document**, enabled only for a complete, supported report belonging to the current file and current parser policy. Warnings remain visible beside the action; no extra “yes” dialog is needed. An unsupported report cannot be overridden with that button.
- Secondary actions are **Choose another PSD**, **Download original PSD**, and **Cancel**. Downloading the retained original `File` is byte-preserving and available even when the file is incompatible; it is explicitly the original archive, not a rendered export.
- Success selects the new native document, fits the view and reports: “PSD imported with editable supported layers and masks. History starts here.” Show a concise count of the warnings presented during review. The report is available through the read-only inspection API; this first UI does not retain a post-import report viewer. The current document must remain unchanged throughout.

At 900px, use the existing modal's bounded width, one scrollable report body, wrap long filenames/layer names, and keep the action row visible. Use text plus icons for compatibility state, a polite live status for progress, and an alert for transport errors. No bitmap preview is necessary for this first flow; a saved merged preview could otherwise be mistaken for proof that the editable graph matches it.

## Binary transport

All routes run after the companion's existing Host, Origin and session-token checks. Use binary request bodies and `Authorization: Bearer …`; do not put tokens or file data into URLs. Accept PSD MIME and `application/octet-stream`, then validate actual bytes. Enforce declared and streamed body limits before decoding. Use a separate bounded inspection/import transfer slot and the parser's deadline; cancelled read-only inspections release slots and discard temporary work. Accepted imports finish despite a disconnected caller, because another waiter or later same-ID retry may need their committed result.

| Route | Request | Response / effect |
| --- | --- | --- |
| `POST /api/psd/inspect-import` | Binary file; explicit `assumeSrgb` option; optional sanitized display filename supplied separately | Structured compatibility report; no native document or archive publication. Full bounded structural/channel validation is required before `validation: 'complete'`. |
| `POST /api/psd/import` | Same binary file; stable `X-Prism-Request-Id`; `X-Prism-Expected-Sha256`; explicit `importerVersion:1` and the same `assumeSrgb` decision; optional document name | Recompute hash and rerun required validation. Publish one fresh native document plus the promised archive atomically; return `{document, report, historyIncluded:false}` with `document.sourceDocument` archive metadata. |
| `GET /api/psd/:documentId/original?expectedRevision=N` | Authenticated request identifying an imported archive | Exact retained PSD bytes as an inert application/octet-stream attachment, with SHA-256 and byte count headers. This is distinct from `/export`, which renders a new PSD copy. |

These routes are implemented in `server/psd-import-routes.mjs`. Use query `assumeSrgb=true|false`, `sourceName`, optional `name`, and import header `X-Prism-Importer-Version: 1`. The report declares `color:{policy:'known-srgb'|'assumed-srgb',profileSha256?}`. Avoid a server staging-token endpoint in the first slice: repeating a bounded upload is simpler than retaining temporary PSD payloads across dialog cancellation, process restart and token expiry. The client retains the file already. A later staged transport could use the same hash/report contract without changing user-facing behavior.

The import request's fingerprint includes file SHA-256, requested document name, importer version and `assumeSrgb` choice. Identical retries return the same document ID; reusing an ID for different input returns `REQUEST_CONFLICT`. A lost successful response must not produce another document. The approved backend contract retains a small import receipt atomically with the document; same-ID recovery survives companion restart. Transport may separately cache at most 200 session coalescing receipts. Never make a new request ID merely because a request timed out.

Name changes after inspection do not invalidate byte compatibility but must create a new logical import request before any write has been attempted. Once a write may have succeeded, freeze file/name/hash/importer version/interpretation/request ID for recovery. Hash mismatch or changed policy returns `INSPECTION_STALE` or another agreed explicit code, disables Import, and offers **Inspect again**. Inspection receipts are not authorization to bypass native validation.

## Report and capability fields

Keep the import type separate from export's `PsdReport`; export's `documentId`, `revision` and `requiresPixelValidation` describe a different object. The client consumes this bounded report subset:

```ts
type PsdImportReport = {
  format: 'psd';
  importerVersion: 1;
  subsetId: 'rgb8-flat-raster-v1';
  input: { sha256: string; bytes: number };
  supported: boolean;
  validation: 'complete' | 'rejected';
  options: { assumeSrgb: boolean };
  requiresSrgbAssumption?: boolean; // explicit UI discriminator, not message parsing
  document?: {
    width: number; height: number; layerCount: number;
    bitsPerChannel: number; colorMode: string; fileVersion?: number;
    compression?: Array<'raw' | 'packbits'>;
  };
  preserves: string[];
  omits: string[];
  issues: Array<{
    code: string; message: string; layerIndex?: number;
    layerName?: string; recordKey?: string;
  }>;
  warnings: Array<{
    code: string; message: string; layerIndex?: number;
    layerName?: string; recordKey?: string;
  }>;
  issuesOmitted?: number;
  warningsOmitted?: number;
  comparison?: {
    reference: 'stored-merged-rgb';
    comparedWith: 'native-flat-recomposition';
    differingChannels: number; maxChannelDifference: number;
    transparentPixels: number; alphaComparable: boolean;
  };
};
```

`rejected` can be displayed but never enables import. Unknown records/profile assumptions cannot be quietly represented as compatible: the parser must classify them as an explicit warning or unsupported issue under its accepted policy. At most 128 issues and 128 warnings are returned; the UI displays optional `issuesOmitted` and `warningsOmitted` counts. Native-versus-saved RGB differences are disclosed when present, and `alphaComparable:false` is disclosed even when RGB values agree. Unsupported reports do not display preserved-property claims. Escape file-provided labels as React text, never HTML.

Native capabilities include `layeredImportFormats:['psd']`, `psdImportPolicy:'rgb8-flat-raster-v1'`, `psdImporterVersion:1`, and limits `maxPsdImportBytes` and `maxPsdImportWorkingBytes`. Native dimension/pixel limits continue to apply. Do not reuse `layeredExportFormats` or assume import and export support identical files. The backend enforces 64 MiB input and the limits stated above. Forward those capabilities rather than borrowing the raster-import 24 MiB or project-import 256 MiB caps. No import UI is exposed when the new capability is absent.

Transport/auth failures use `{ok:false,error:{code,message},report?}`. A well-formed inspection that finds unsupported content should normally return HTTP 200 with `supported:false`; malformed/truncated input may return 422 with a partial report. The client preserves that report rather than collapsing named incompatibilities into a generic toast. Resource limits, busy queues and timeouts get actionable messages with retry only where repeating the same input can help.

## Original archive ownership

During review, **Download original PSD** uses the retained browser File with no additional upload. The durable archive metadata is `graph.sourceDocument:{format:'psd',asset,bytes,name}`. Here `asset` is the content hash of the original PSD container, **not** a layer's decodable raster `sourceAsset`. The import response/document exposes this metadata; the original-download response returns the same hash and exact bytes. `expectedRevision` prevents downloading through stale document identity/context.

Portable `.prism` projects include and validate this explicitly typed container reference through the codec/native extension. The original container is validated independently from raster assets; it is not passed through the old image-asset path. Publication of normalized layer images, original archive, graph and deduplication receipt is atomic: an archive-write failure must not publish a partial import.

After import, expose **File → Download original PSD** only when the native document carries this metadata and the backend supports the archive route. Keep it distinct from **Export → Layered PSD**, which generates a new compatible file from current native state. The original archive stays unchanged when layers are edited and remains downloadable after reload, companion restart and `.prism` round-trip. Its name is displayed and used as a sanitized attachment filename, never a filesystem path.

## Client state and retries

Use one explicit state machine: `empty → inspecting → supported | unsupported | inspection-error → importing → imported | import-error`. Store `{file, fileKey, report, requestId, name, assumeSrgb, operationVersion}` together. Inspection errors retain the selected file; a retry reads the same File. Import errors retain the frozen logical request and full report.

Each response is keyed to file identity, color interpretation, importer version, operation version and backend context. Use AbortController for inspection and ignore late results after replacement/cancellation/backend change. File metadata alone is not identity; the server-provided SHA-256 binds the report to bytes. Do not clear the active workspace while checking. During final import, disable file/name replacement and duplicate submission. Once submitted, aborting the HTTP connection does not prove publication was cancelled; keep recovery state until the same request ID resolves. Surface local import errors inside the review dialog, instead of reusing App's current hardcoded “Retry project import” toast label.

A definitive pre-publication validation rejection (`INVALID_PSD`, `PSD_UNSUPPORTED`, `INSPECTION_STALE`, argument errors or `LIMIT_EXCEEDED`) permits reinspection or choosing another file. This escape is unavailable if an earlier attempt had an ambiguous failure: the same request ID remains mandatory even if a later retry refuses the request. Network failures, general import failures and request conflicts keep recovery state. Closing the review preserves an ambiguous request in the mounted controller. Reloading the entire page is outside this in-memory File retention guarantee; the backend receipt remains durable.

## Verified implementation

`tests/psd-import-browser.mjs` passes five real Chrome workflows using the independently produced `tests/fixtures/psd-import` raw and PackBits files. The tests compare every imported source RGBA byte and the native composite with a separate reference, assert original archive retention through edits/restart/portable round-trip, and cover named incompatibilities, color interpretation, cancellation, bounded diagnostics, definitive rejection and ambiguous same-ID recovery. Transport fault responses are explicitly injected; normal import/publication and durable retry use the real companion. No image provider or credential lookup runs. Existing project transfer (four workflows), PSD export (three workflows) and the production build also pass.

Screenshots: `test-results/psd-import-compatible.png` and `test-results/psd-import-unsupported.png`. The compatibility screenshot discloses the fixture's measured seven RGB channel differences of one byte from the saved merged image; the imported native composite remains verified separately.

## Broader acceptance coverage

Automated Chrome tests use isolated real companions and small independently produced synthetic PSDs, without provider calls:

1. A supported raw fixture and a supported PackBits fixture inspect without changing document count, graph/history or asset/archive files. Review shows the exact named retained properties. Explicit import creates one fresh document/history and retains editable order, names, visibility, opacity, layer alpha and masks; compare source channels and composite according to the approved parser policy.
2. Unsupported layers/records, PSB, depth/mode, compression/profile and malformed bounds produce named report errors; the import button is disabled. There is no hidden `import_image`, flattening, merge fallback or mutation of existing documents.
3. Capture a successful import response, simulate its loss, retry from the same retained File, and assert identical bytes/request ID/name/hash/policy with one published document. Also cover busy queues, inspection retry, stale-report/hash rejection and duplicate concurrent clicks.
4. Replace a file while inspection is delayed, switch backend, cancel, and deliver the old response: no stale report or document switch is allowed. During publication, test explicit recovery rather than pretending an aborted request cannot have committed.
5. Original archive download is byte-identical before and after import/reload/restart; `.prism` round-trip retains the explicitly typed archive and exact original bytes. Native source PNGs and every pre-existing project remain untouched.
6. Capability absence hides the entry; PSD drag/drop on an unsupported backend has an actionable message. Untagged files stay in review until the explicit sRGB interpretation is chosen and reinspected; turning that choice off invalidates eligibility, and unknown ICC never becomes importable. Empty/generic MIME with correct signature works, spoofed extension rejects, and empty/oversize inputs stop before uploading. Auth/Host/Origin/binary limits are separately covered by service tests.
7. At 900px, long Unicode names/issues wrap, keyboard focus stays usable, actions remain reachable, and there are no uncaught browser errors or unexpected key/provider reads. Screenshots show one compatible review and one named rejection.

Manual inspection should cover a supported externally authored PSD, visible/hidden layers and soft masks, the original archive download, and an unsupported real document with useful layer names. Do not describe self-export/reimport alone as broad Photoshop compatibility. Existing Open image, `.prism` import/retry and PSD export remain regression targets after implementation.
