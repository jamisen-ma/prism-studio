# Chat-driven editing

The default right sidebar is **Chat**. Describe the outcome, press Enter or Send, and the local Codex agent chooses native editing commands, image generation, or a combination. Shift+Enter inserts a newline. The current document and selected layer are shown as context. Open image uses the existing image importer. Layers, Select, Adjustments and History remain available for manual work; Image options is a secondary control for reviewing retained generation results.

Examples:

- “Make this photo warmer, keeping the adjustment editable.”
- “Create a cream autumn background, then add AUTUMN as editable brown text.”
- “Change that title to OUTFITS and make it smaller.”

Requests run serially while the companion stays open. The conversation shows tool activity, replies and errors. The canvas follows the agent’s result automatically while it works, including newly created documents and subsequent edits. A result already on the canvas does not require an Open result button; links remain for revisiting other results. Follow-ups receive bounded recent conversation history and verified result IDs. The agent sees real image previews through MCP. It must inspect current revisions before changing existing documents. There is no keyword-based intent classifier and no automatic Photoshop installation requirement.

## Images in chat

Use **Attach** in the composer, drop image files onto it, or paste an image from the clipboard. Attach up to eight PNG, JPEG, WebP, or TIFF files, each up to 20 MiB. Thumbnails can be removed before sending; text and attachments stay in the draft while switching inspector tabs. TIFF drafts show a file icon until the server can render a preview.

Files are staged locally until Send, then imported as native documents with their original source assets. The chat request contains verified document references, not embedded image bytes. Codex receives ordered attachment names and IDs and inspects their real previews through editing tools. This supports multiple photo references alongside a written brief. Sending images alone asks Codex to inspect them and clarify the desired edit. Sent attachments remain in conversation history and can be opened from their thumbnails. Unsent drafts are not persisted across a browser reload.

If a message response is lost, **Retry same message** reuses the original request and imported image references. An upload failure keeps the draft for correction or retry. Successfully imported images remain workspace documents even if a later message submission fails.

## Local runtime

The signed-in Codex CLI runs an ephemeral planning session connected only to a private Prism MCP bridge. Native edits use the same command schemas, protection rules and revision checks as the editor. Generation tools wait on the existing Codex image worker and use its built-in image tool; they do not read an image API key. The planning session cannot generate an unmanaged image directly. Shell, browser, app connectors and extra agents are disabled for that session.

The bridge exposes a compact tool catalog: discover commands, read a command’s argument schema, execute the command, generate an image, or edit an image. Each turn gets its own temporary capability. That capability only authorizes its active tool endpoints and is revoked when the turn ends or stops. Credentials are not included in the model prompt or public chat history. The private MCP server’s tools are explicitly enabled for the editing actions requested through Chat; other user MCP configuration is not loaded or changed.

Keep Codex signed in with ChatGPT. `PRISM_CODEX_BIN` selects its executable. `PRISM_CHAT=0` disables chat at startup; `PRISM_CODEX_WORKER=0` disables image generation. Library/test companions remain disabled unless enabled explicitly with injected or real adapters. `node scripts/verify-chat.mjs --live` is an opt-in integration check that generates one real image and edits native text in two chat turns.

## Recovery and limits

Messages and tool execution receipts are saved before work begins. Retrying an unconfirmed message retains its request ID; the same message is not submitted twice. Restarting interrupts unfinished turns instead of replaying edits or generating again. Failed turns preserve a specific safe runner reason (output size, invalid response, process exit, incomplete reply, start failure, timeout or agent failure) without exposing raw process output. Generation results that conflict with a newer document remain available for explicit review in Image options.

Stop prevents further tool dispatch, aborts the local agent, and cancels its pending generation requests. An editor operation already accepted may finish; completed edits remain and can be inspected or undone with normal history controls. Stopping is not an automatic rollback.

This initial implementation retains up to 100 turns, with 6 queued/running requests, 64 tool calls per turn, bounded recent model context, a 20-minute agent deadline, and bounded output/receipt storage. It edits Prism Native documents, not a separately installed Photoshop host. Arbitrary filesystem import/export is not exposed to this private bridge; attach images in Chat or import them through the workspace, and export using its normal controls. Existing native editor limitations still apply.

The CLI event reader processes image-bearing MCP events one at a time. It bounds individual JSONL events to 16 MiB, non-tool events to 1 MiB and diagnostics to 2 MiB, rather than imposing a cumulative image-preview budget on a whole editing session. Split UTF-8 characters and events spanning subprocess chunks are handled correctly. Preview bytes are neither persisted in chat receipts nor retained as runner logs.

CLI advisory error events no longer terminate the local agent immediately. A later turn-completed receipt and successful process exit are required to resolve them; unresolved errors, terminal turn failures and incomplete replies still fail. The assistant starts visual inspection at 700px and requests larger previews only for needed detail, reducing repeated image traffic without changing document pixels.
