# Independent review: strict MCP tool inputs

Read-only source/installed-SDK review, 2026-09-19. Root owns the proposed implementation and actual SDK tests. No provider, key, user file or generation operation was invoked during this review.

The main-command fix is correct: supplying `z.object(shape).strict()` preserves the object schema in the installed SDK, while a raw field map is converted into a default Zod object that strips unknown keys. SDK input validation runs before the tool handler. The companion's later strict schema cannot reject a field that the SDK already discarded.

There is no supported reason for permissive stripping on the remaining custom tools. Every handler consumes a documented, finite field set. Protocol metadata belongs in the MCP request envelope; it does not require unknown keys inside tool arguments. A typo or unsupported editing option should reject instead of becoming a different valid action.

One concrete example is `prism_generate_image` with `mode:'edit'`: the current raw input shape removes `mode`, then its handler explicitly supplies `mode:'generate'`. Unsupported mask/strength fields can likewise disappear before generation validation. Import/export options, completion overrides and job-application options have the same transport issue, even if particular ignored fields have no effect today.

## Bounded implementation

Wrap each existing shape in `z.object(existingShape).strict()`, preserving all fields, refinements, defaults, descriptions, callbacks and annotations. Do not change generation policy, retries, provider selection or file handling as part of this patch.

The remaining inventory is20 custom tools:

| Location | Tools |
| --- | --- |
| `server/mcp.mjs` | status; tool catalog; local image import; AI status; generate/edit image; list/get/cancel/apply/preview generation; inspect/export PSD; export/import Prism project; get generation handoff; complete generation —17 total |
| `server/psd-import-mcp.mjs` | inspect local PSD; import local PSD; export original PSD —3 total |

Empty status/list schemas should become `z.object({}).strict()` too. The generation/action loops must wrap the final expanded shape, retaining the stronger required document/revision fields for Edit and the existing preview/default/request-ID rules. The PSD helper can keep its reusable raw `fileSchema` internally and wrap it at each registration. No global monkeypatch of `registerTool` is needed.

## Actual SDK acceptance

Use the official client/stdio transport against isolated fake companion/provider hooks. Supply otherwise valid arguments plus one unknown top-level field to each custom tool. Assert an SDK validation error naming the unknown field, rather than a handler/HTTP error. Where a file is required, use an isolated fixture or deliberately missing fixture path and ensure the result is the schema error, not ENOENT. No user files or real credentials are necessary.

Prioritize generate/edit with unsupported mask/strength and the explicit wrong-mode example; apply/cancel/complete with unsupported override fields; each local import/export and PSD tool; and empty status/list plus catalog. Confirm zero request count for rejected calls, no key/provider/snapshot hooks, and unchanged jobs, documents, assets, receipts, handoff/export directories. An SDK-level spy can additionally prove the callback never starts; source inspection already establishes the validation ordering.

Keep positive checks for omitted provider→Codex, the existing quality/size/background/scope defaults, preview maxWidth600, catalog implementedOnlyfalse, optional revision fields, edit's required document/revision, and stable request-ID handling. Existing generation/handoff, PSD/project and representative command suites provide the supported-flow regression checks. Advertised property types/defaults/required fields must stay intact, with strict unknown-field behavior exposed consistently.

Root implemented the20 strict wrappers and added `tests/mcp-input-strict.test.mjs`. A subsequent source review confirms that final expanded generation/action shapes, required overrides and all callback/default semantics remain intact. The root-run actual SDK test passes22 negative calls across all20 custom tools. Each asserts an unrecognized-key SDK input-validation error and zero HTTP dispatch; recursive project/job/asset/handoff/export hashes stay identical and forbidden key/provider/model hooks remain zero. The test uses real isolated PNG/PSD/Prism fixtures and an awaiting Codex handoff, then verifies the supported default path and exact-file completion retry. No user credential or provider request is used.

No correction remains from this review. Root owns the broader integrated-suite result; the independent reviewer inspected the patch/test rather than duplicating that complete run.
