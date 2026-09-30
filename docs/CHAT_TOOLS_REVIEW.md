# Chat tool dispatch review

The private tool layer is implemented in `server/chat-tools.mjs`. It exposes five tools: native command discovery, exact schema discovery, native execution, image generation, and image editing. The initial manifest stays below 10 KiB instead of sending approximately 119 KiB of native command schemas with every turn. Native execution uses the companion dispatcher; binary imports and exports are excluded, including nested transaction attempts. Recipe definitions retain the native restricted step schema.

Chat document mutations require a positive current revision. The layer never injects a newer revision or retries an edit automatically. Each call uses a deterministic request ID derived from its turn and call IDs. Arguments are copied as plain JSON before an asynchronous boundary, with getters, custom prototypes, cycles, and sparse arrays rejected. Preview pixels are returned as MCP image blocks and omitted from text/structured metadata; preview payloads are limited to 8 MiB.

Image tools require an available automatic Codex worker and cannot choose a separate API provider, model, request ID, or manual handoff. The durable job ID is persisted through an awaited callback before waiting. Stop cancels only the turn's pending job. A provenance/progress persistence failure also cancels pending generation; ready and successful images are retained. Stale image results remain ready for explicit review and are never silently applied to another revision.

The tool dispatcher checks cancellation before native dispatch and after asynchronous waits. A native operation already accepted by the companion may finish: its real document result is recorded even when cancellation arrived during execution. The UI accurately states that completed changes remain.

Independent tests:

- `tests/chat-tools.test.mjs`: **10/10 passed in 337 ms**. Covers real native schemas, excluded nested commands, revision conflicts, stable call IDs, preview images, queued argument ownership/getters, cancellation and accepted-result provenance, unavailable workers/provider overrides, actual durable worker generation with an injected image adapter, result deduplication, stale results, and failed provenance persistence.
- `tests/chat-tool-scope-audit.test.mjs`: **2/2 passed in 202 ms**. Uses the real companion HTTP routes and private token checks. Wrong tokens, ordinary session tokens on private routes, other turns, cross-origin requests, and private-token access to public routes all refuse. Cancellation immediately revokes the capability. A chat agent failure while its image tool waits cancels the durable image job before the turn finishes and retains the job ID for review.

No test here invoked an actual model or image API. All owned processes exited.

Source review confirmed startup reconciliation precedes starting the automatic image worker, failed agent execution aborts before waiting for the tool tail, and queued tool calls authenticate again at execution. A UI ownership finding was corrected by its owner: a terminal turn first observed through polling while its POST reply is delayed or lost now triggers completion refresh only when it matches the pending request.

Final resource finding sent to the manager owner: the original private route inherited the 42 MiB binary-import JSON body cap, while up to 64 queued calls could retain their argument copies independently of the 32 MiB result cache. Private chat needs a smaller per-call body bound and an aggregate queued/cumulative argument bound before copying. This is a pending resource tightening at this review checkpoint; the HTTP authentication and cancellation tests above are already green.


Root closure: the manager owner implemented a1MiB private tool HTTP cap,128KiB message cap and8MiB aggregate queued argument budget, checked by a strict own-data traversal before cloning/hashing. Owner resource regressions pass, including getter refusal and duplicate-call behavior. A final cancellation intent guard also prevents dispatch while a stop receipt is being saved before the controller is installed. Root source-reviewed the final progress spinner condition: only the latest event can spin while its turn is active. These findings are closed; final combined evidence is recorded in WORK_LOG.md.
