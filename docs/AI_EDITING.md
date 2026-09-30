# AI generation and pixel-preserving editing

Prism separates generated imagery from conventional editing. The default Codex route uses a local worker to process saved image requests with Codex's built-in image tool, then returns the PNG to the native editor. It uses your signed-in local Codex installation and does not read or substitute the optional image API key. Ordinary editing and installed local segmentation also need no image API key.

## Automatic local Codex generation

Keep the Prism companion running and sign in to the local Codex installation with your ChatGPT account. The worker polls the existing durable generation queue **every five seconds** and processes one automatic request at a time. No CSV queue or browser tab timer is required. `PRISM_CODEX_BIN` selects a different Codex executable. `PRISM_CODEX_WORKER=0` disables automatic processing; library/test companions default to disabled unless explicitly enabled.

1. Open **Generate**, choose Codex, and describe the image or selected-area edit. Submission saves the request, document revision, input and protection mask before generation starts.
2. The panel shows queued, generating and returning progress. You can keep editing or close the panel while the companion runs.
3. The worker generates using the local Codex image tool and returns its selected PNG automatically. Prism validates the bytes and applies them using the saved mask and current protected layers.
4. Inspect the result. If the document changed meanwhile, the image remains **Ready to apply** until you explicitly apply it to the latest document. No second image is generated for that application.

Only new requests submitted while the worker is enabled are reserved for automatic processing. Older manual handoffs are not silently adopted. If the runner is unavailable, automatic requests stay queued with a status explanation; they do not fall back to the Images API. Cancel a queued request if you no longer want it.

Before launching Codex, the worker persists its attempt receipt. Interrupted or failed attempts never regenerate automatically. A fully saved output can be returned again using the identical bytes after a restart or transient installation failure. Cancellation stops the local attempt and prevents late application; usage already incurred may remain. The companion must stay running for polling, and local Codex account/tool availability and usage limits still apply. Size, quality and background options are preferences for this image tool, not an API-model parity guarantee.

## Manual conversation handoffs

Manual handoffs remain available for requests created with automatic processing disabled, including older saved requests. An automatically reserved request cannot simultaneously be claimed by a manual conversation.

1. Inspect the document and selection with MCP. Start `prism_generate_image` or `prism_edit_image` using a stable `requestId`; the default provider is `codex`. Existing documents require their latest `expectedRevision`.
2. An unmarked manual job enters `awaiting_image`. Call `prism_get_generation_handoff` to read the prompt and, for edits, inspect the saved input and protection mask. The tool returns image blocks and immutable local PNG reference paths. Automatically queued/generating/returning jobs refuse manual handoff and completion.
3. Use the built-in image generation tool in this conversation. A dedicated image agent can perform this step. Do not launch a separate Codex CLI or substitute the Images API.
4. Call `prism_complete_generation` with `jobId` and the absolute path to the selected generated PNG. Prism validates the file, retains its original bytes, and applies it locally using the captured mask and current protected layers.
5. Inspect `prism_get_generation_preview` and the actual document. The browser polls the job and displays the returned result. If the document changed, the output stays `ready`; inspect the current revision and use `prism_apply_generation` to apply it explicitly.

For manual requests the browser provides a copyable handoff instruction. A browser cannot awaken this hosted conversation itself; the automatic route instead uses the separately supervised local Codex worker described above.

A manual `awaiting_image` request survives companion restarts without regenerating. Repeated completion with the identical PNG is idempotent. A different image cannot replace an already completed receipt; create a new request for a new variant. Cancelled requests reject late completion. MCP and HTTP completion accept PNGs up to 30 MiB, with the native 8192-pixel edge and 24-megapixel limits. No saved API key is read by the default status, handoff or completion flow.

## Optional API generation

```sh
npm run configure:ai
```

The prompt hides input. The key is written to `.prism/secrets/openai-api-key` with owner-only permissions; the directory is ignored by source control. `OPENAI_API_KEY` is also supported and takes precedence. Keys are never sent to the browser or returned through MCP. Run the command again to rotate the key. Use `npm run doctor` to check configuration without displaying it.

Only explicit `provider: "openai"` requests use this key. That route sends the prompt to the Images API; edits also send a flattened snapshot and applicable mask. API usage is billed separately. Inspect configuration explicitly with `prism_ai_status({provider:"openai"})` or `/api/ai/status?provider=openai`. Default status checks leave optional API configuration unread.

## Optional API job workflow

1. Read `prism_ai_status` and inspect the current document/selection.
2. Call `prism_generate_image` or `prism_edit_image` with `provider: "openai"` and a unique, stable `requestId`. Editing an existing document requires its latest `expectedRevision`.
3. Poll `prism_get_generation_job`. The start tool returns quickly; no tool call waits for the full network operation.
4. Inspect `prism_get_generation_preview` and the actual document preview.
5. If the document changed meanwhile, the result stays `ready`. Review it, fetch the current revision, then call `prism_apply_generation`. This applies the saved bytes without charging for a second generation.

`queued` and `running` are pending. `succeeded` means installed into a document. `ready` means generated bytes are retained for explicit application. `failed` and `cancelled` do not automatically retry. A cancelled job with saved output can also be explicitly applied. Cancellation prevents application where possible; a provider request already submitted may still be charged.

The service permits at most six pending requests across routes, with at most one active API request and one active automatic Codex attempt. It retains up to 100 jobs and 512 MiB of job assets and reserves space for pending output. Restarted in-flight API jobs become interrupted; they are never silently resubmitted. Automatic Codex attempts interrupted during generation also require review; only queued requests and exact saved returning output continue automatically. Stable request IDs are persisted, so retrying the same start request recovers its job. Reusing an ID with changed arguments fails.

Inputs and outputs are bounded PNG images; the client never follows provider image URLs. Errors returned to clients are sanitized. Results preserve provider bytes in immutable assets, add a separate editable raster layer, and take one undo step. Native editing remains 8-bit sRGB.

## Hard mask behavior

An image model's mask is guidance, not an exact pixel guarantee. Prism captures the mask and clips the returned result locally before installation. A selected-area edit cannot affect pixels whose saved selection coverage is zero. Feathered selections intentionally blend at their edges. If the canvas dimensions change, applying the saved masked result is rejected until the original dimensions are restored.

Keep people on protected cutout layers. Generate the design/background separately, then place original cutouts above it. Local segmentation predicts alpha coverage; it does not generate faces, clothing, hair, hands, or source RGB. Pixel resizing necessarily interpolates samples, so the exact original asset is retained while placement uses proportional resampling.

Automatic segmentation needs visual review: fine hair, shoes, bags, fingers, overlapping subjects and similar foreground/background colors may need manual mask refinement. A model-generated alpha mask does not prove that every intended accessory was captured.

Protected layers also reject opacity changes and nonuniform scaling. Canvas resizing respects protected content even when it is hidden or fully masked; proportional integer resizing allows half-pixel rounding. Translation, uniform scaling, rotation, visibility and mask refinement remain editable. Explicitly remove protection before changing the subject's pixels.

## Refine an extracted subject

Open **Cutouts**, extract the subject, then choose **Refine mask** on the original cutout. **Add** restores source details such as a missed bag or shoe; **Subtract** removes unwanted background coverage. These strokes change alpha only. MCP exposes the same operation through `paint_cutout_mask`. Refine before placing or transforming the cutout; to restore details later, refine the original source and place it again. An additional layer mask remains available for further hiding.

For a larger missing accessory, draw a lasso or other selection around it and choose **Add selection**. **Subtract selection** hides selected coverage. MCP's `prism_refine_cutout_from_selection` also supports `intersect` and `replace`, keeps the selection active, and creates one undo step. Feathered selections blend coverage; transparent source pixels stay transparent even when their cutout mask is restored.

Use `prism_get_layer_preview` to inspect the isolated layer, retained original photo (`view: "source"`), or source alpha (`view: "mask"`). These are read-only image results. Original and mask views use their source dimensions, which may differ from the current composition after placement or transforms.

## Reuse saved selections

Use the **Select** inspector to save reusable masks, such as the background area or one outfit. Named selections survive reopening and canvas changes. Restore them without altering the saved copy, or combine their coverage with the active selection using Add, Subtract or Intersect. Update a saved entry after refining its active copy. MCP exposes `save_selection`, `load_selection`, `rename_selection` and `delete_selection`; these affect masks, not source RGB.

## Expand a canvas and outpaint

Open **Resize → Canvas bounds**, choose the new dimensions and one of nine anchors, then select **Select new transparent space**. Existing pixels move without resampling. The padding selection excludes the retained original canvas. Use **Generate → Edit image → Selection** to fill it; local clipping prevents the returned image from changing the original region even if the provider ignores its mask.

Through MCP, call `prism_resize_canvas` with `width`, `height`, `anchor` and `selectPadding: true`, then inspect the new document revision and start `prism_edit_image` with `scope: "selection"`. Expansion and the generated layer each have their own undo step. Cropping through canvas bounds is reversible but removes the cropped region from current masks; enlarging again does not reveal mask coverage that was explicitly clipped away.

## Example: four-person outfit cover

Treat the sample instruction as a sequence of inspectable operations:

1. Import each supplied original and inspect it.
2. Extract each subject using local segmentation; inspect full-body masks and refine them where necessary.
3. Create a 3:4 cover document. Generate only the cream paper, corner shading and autumn decorations as a separate design layer. No person photo is needed for this generation request.
4. Place each complete cutout proportionally into four lower rectangles, retain protected layers, and add outside white outlines.
5. Add editable text with the exact two lines `AUTUMN` and `OUTFITS`, in chocolate brown. Use the bundled Fraunces retro-serif family and inspect its fit.
6. Render the actual preview, check all four people and margins, and export one PNG. Preserve the layered project and original assets.

The example does not itself supply four photos. Prism must not invent or substitute people when originals are absent. Generic font families and bundled Fraunces are supported; advanced typography and arbitrary font imports remain separate work.

## Local subject model

```sh
npm run setup:segmentation
```

Setup requires Python 3.12 or newer. It installs a checksum-verified BiRefNet Lite ONNX model under `.prism/models/` and pinned CPU dependencies in `.prism/python-runtime/`. System Python packages are unchanged. Inference runs on this computer in a persistent, bounded child process. Model/runtime setup downloads dependencies; segmentation itself does not upload images. The process receives no provider credentials, returns only alpha coverage, and is terminated on timeout or shutdown.

For an explicit real-model check, run `npm run verify:segmentation -- path/to/photo.png`. This writes a mask, transparent cutout, preview and report under `test-results/real-segmentation/`, checks every source RGB pixel and original file byte, then verifies reopening. It makes no provider calls. These checks establish source preservation, not that the automatic mask captured every intended detail.

`npm run verify:segmentation:mcp -- path/to/photo.png` additionally runs the official MCP client, a temporary companion, real extraction, duplicate-request protection, selection repair, undo and exact PNG export. It shares installed model/runtime files through temporary directory links and uses no provider key or API requests.

## References

- [Built-in image generation](https://learn.chatgpt.com/docs/image-generation): generation in Codex and associated usage limits.
- [OpenAI image generation guide](https://developers.openai.com/api/docs/guides/image-generation): generation, editing, model choices and mask behavior.
- [OpenAI image edit API](https://developers.openai.com/api/reference/resources/images/methods/edit): multipart image and mask inputs.
- [BiRefNet](https://github.com/ZhengPeng7/BiRefNet): local segmentation model and MIT license.
- [rembg BiRefNet Lite adapter](https://github.com/danielgatis/rembg/blob/main/rembg/sessions/birefnet_general_lite.py): exported model and published checksum.
- [ONNX Runtime installation](https://onnxruntime.ai/docs/install/): local Python CPU runtime.
