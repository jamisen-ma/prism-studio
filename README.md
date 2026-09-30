# Prism Studio

A standalone image editor controlled by an AI assistant through MCP. Prism implements its own document engine, editing tools, local subject extraction and AI image workflows. Photoshop is not required.

This is an **early implementation**, not complete Photoshop feature parity. The native engine is tested against actual images. The [standalone roadmap](docs/ROADMAP.md) and [feature-family coverage matrix](docs/FEATURE_PARITY.md) track the remaining work beyond the toolbar inventory. An optional Adobe bridge is retained separately and is not a dependency or milestone for the standalone product.

## Run

Requires Node.js 22.12+ and npm (macOS or Linux; Chrome recommended).

```sh
git clone <repo-url> ai-photoshop
cd ai-photoshop
npm install
npm run dev
```

All editing tools work with just those steps. Two features are optional extras:

- **Subject cutouts / Select subject:** run `npm run setup:segmentation` once (needs Python 3.12+; downloads a ~400 MB local model).
- **Chat and AI image generation:** install the [Codex CLI](https://github.com/openai/codex) and sign in with your own ChatGPT account (`codex login`).

`npm run doctor` shows which of these are set up.

Open **http://127.0.0.1:43110**. The companion runs at **http://127.0.0.1:43120**. Both bind only to loopback. For a single production service:

```sh
npm run build
npm start
```

Then open **http://127.0.0.1:43120**. Keep the companion running while using MCP. `npm run doctor` checks the installation and connection without printing secrets.

## Host it on Railway

Run Prism Studio as one web service that a few people can share. Each person gets an account and connects their own Codex (ChatGPT) account. The repo includes a `Dockerfile` and `railway.json`.

1. **Push to GitHub** as a **private** repository.
2. In [Railway](https://railway.com) choose **New Project → Deploy from GitHub repo** and pick the repository. Railway builds it from the `Dockerfile`.
3. **Add a Volume** to the service, mounted at **`/data`**. Accounts, documents and each user's Codex sign-in are stored there. Without a volume they are lost on every redeploy.
4. **Set these variables** (service → Variables):

   | Variable | Value |
   | --- | --- |
   | `PRISM_SIGNUP_CODE` | An invite code people must enter to sign up. Strongly recommended: without it, anyone who finds the URL can make an account. |
   | `PRISM_PUBLIC_URL` | The public `https://…` URL from step 5. |
   | `RAILWAY_RUN_UID` | `0`. Required: Railway mounts volumes owned by root, and without this the app can't write to `/data`. |
   | `PRISM_ALLOW_SIGNUP` | Optional. Set to `0` to close sign-ups once everyone has joined. |
   | `PRISM_SEGMENTATION` | Optional. Set to `0` to turn AI cutouts off. It is already off unless you build with them (see below). |

   Optional limits: `PRISM_MAX_USERS` (default 50), `PRISM_MAX_UPLOAD_MB` (64), `PRISM_MAX_DOCUMENTS` (50 per user), `PRISM_MAX_STORAGE_MB` (2048 per user), `PRISM_IDLE_MINUTES` (20; idle workspaces are unloaded from memory).

   `PORT`, `PRISM_HOSTED=1` and `PRISM_DATA_ROOT=/data` are handled for you. Railway sets `PORT`, and the image sets the other two.
5. Under **Settings → Networking**, click **Generate Domain**. Then set `PRISM_PUBLIC_URL` to that URL, for example `https://prism-studio-production.up.railway.app`. Railway redeploys automatically.
6. **Share the URL and the invite code** with the people you trust. Each person signs up, then connects Codex from the app. The app shows a link and a one-time code, and they approve it with their own ChatGPT account (device-code login). Chat and image generation then run on that person's account. The image includes the Codex CLI but no credentials.

**Cost:** roughly $5–10 a month on Railway for a few light users, plus a little for volume storage. AI cutouts are **off by default** because they need a much bigger image (~1.9 GB vs ~1.1 GB) and are CPU-heavy. To turn them on, add a service variable `WITH_SEGMENTATION=1` and redeploy. Railway passes service variables to the Docker build as build arguments. The Python runtime and the 224 MB model are then built into the image instead of the volume, so the build takes a few minutes longer and every restart already has the model. Consider a larger plan if several people will use cutouts at once.

**Updating:** push to the GitHub branch the service tracks and Railway rebuilds and redeploys automatically. Data on the `/data` volume is kept. The health check is `GET /api/health`.

**Security:**
- Each user's Codex sign-in token is stored on the server's `/data` volume. Anyone with access to the Railway project can read it, so invite only people you trust and keep the project's members to a minimum.
- Keep an invite code set. Read OpenAI's terms of use before letting anyone beyond a small trusted group use their ChatGPT accounts through a shared server.
- Back up the volume (Railway volume backups, or download the data) before big changes.

To test the same image locally: `docker build -t prism-studio . && docker run -p 8080:8080 -e PRISM_PUBLIC_URL=http://localhost:8080 -e PRISM_SIGNUP_CODE=test -v prism-data:/data prism-studio`, then open http://localhost:8080.

## Connect an AI assistant with MCP

Codex is the AI assistant; this application exposes the image-editing tools. The companion also runs an automatic local image worker: new Codex requests are saved durably, checked every five seconds, generated by the signed-in Codex CLI’s built-in image tool, and imported automatically. No prompt copying or image API key is needed. Keep the companion running and Codex signed in with ChatGPT. This starts a local Codex session; it does not awaken a hosted conversation. The default **Chat** sidebar accepts one natural-language request. Its local agent chooses native edits, image generation, or both and shows progress and actual results. No bottom composer or separate generation step is required. Layers and other manual tabs remain available; Image options is a secondary control. See [chat-driven editing](docs/CHAT.md).

Register the server using absolute paths appropriate to your machine:

```sh
codex mcp add prism-studio -- node /path/to/ai-photoshop/server/mcp.mjs
```

Or configure an MCP host:

```toml
[mcp_servers.prism-studio]
command = "node"
args = ["/path/to/ai-photoshop/server/mcp.mjs"]
tool_timeout_sec = 120
```

Reload the MCP host after adding the server. The companion must run first. For another companion port/data directory, set `PRISM_URL` and `PRISM_DATA_DIR` on the MCP process; the data directory must match the companion. The default UXP plugin's network permission targets port 43120.

Try this request in a connected assistant:

> Use Prism Native. Import the photo at the path I provided. Inspect it, add a subtle exposure adjustment and reduce saturation as one undoable edit. Show me the preview, then export a PNG copy.

Recommended tool sequence: `prism_status` → `prism_list_documents`/`prism_import_file` → `prism_get_document` → `prism_get_preview` → `prism_apply_transaction` → `prism_get_preview` → `prism_export_document`. For Photoshop, open the photo there, select the Photoshop backend, and inspect available capabilities first.

## Generate images and extract subjects

```sh
npm run setup:segmentation
```

This installs the local BiRefNet Lite model and an isolated Python CPU runtime (Python 3.12 or newer is required for setup). Describe the image or edit in **Chat**. The agent chooses the appropriate tools and waits for the result. The local image worker automatically picks up generation requests and returns their PNGs. **Chat → Image options** retains advanced generation controls and stale-result review. The editor displays and composites the result. Jobs support cancellation, previews, persistent retry IDs and retained output if the document changes. Built-in generation uses Codex usage limits. Local segmentation predicts alpha only and does not upload photos.

The worker processes one request at a time. Cancellation stops its local Codex process and prevents installation. Interrupted or failed generation is never retried automatically; saved completed output can be returned again without regenerating. Older manual handoffs stay manual. Set `PRISM_CODEX_WORKER=0` before startup to disable automation, or `PRISM_CODEX_BIN` to choose the Codex executable. `npm run doctor` checks local sign-in and image-tool availability. Native generated files remain in Codex’s generated-image cache; Prism also stores the imported copy in its project asset store. The opt-in `node scripts/verify-codex-worker.mjs --live` smoke test makes one real generation request.

An optional, explicitly selected **OpenAI API** route is retained; `npm run configure:ai` configures its separate server-side key and API billing. The default Codex route does not read that key.

Protected cutouts retain original source RGB, support proportional placement and outside outlines, and exclude their visible pixels from generated layers and color adjustments. Inspect original/mask previews and repair omitted details using brushes or selections. See [AI editing and the four-person cover workflow](docs/AI_EDITING.md) and [architecture](docs/ARCHITECTURE.md).

## What works

Prism includes real editing operations, not simulated toolbar buttons. Open **Browse all tools** to search the [71-tool Adobe inventory](docs/PHOTOSHOP_TOOL_INVENTORY.md). Each entry states what is implemented and links to Adobe's reference; unavailable tools are disabled.

| Capability | Native engine | Photoshop plugin |
| --- | --- | --- |
| Documents, layers, previews, crop, resize | Implemented | Implemented; live-host validation pending |
| Painting and retouching | Brush, pencil, eraser, clone, healing, dodge, burn, blur, sharpen, smudge, sponge, red-eye, color replacement; [separate repair layers and sampling scopes](docs/RETOUCH_SAMPLING.md), plus [Aligned Clone/Heal](docs/CLONE_ALIGNMENT.md) | Native-only |
| Selections | Local subject extraction, rectangle, ellipse, lasso, single row/column, color regions and painted selections; layer transparency/additional-mask loading; [composite-channel selections](docs/DENSE_MASKS.md); feather/invert; up to 16 named reusable selections with combine modes | Rectangle and Photoshop subject selection |
| Selection and mask shaping | Expand, contract, two-sided border and opening/closing smoothing on selections or existing layer masks; grayscale coverage and one-step undo | Native-only |
| Masks and compositing | Geometric/painted content, group and adjustment masks with editable density, feather, inversion and independent mask positioning; 27 layer blend modes | Rectangular masks and the bridge's original 8 blend modes |
| Layer Fill | [Separate content opacity](docs/LAYER_FILL.md) for six content types; outside styles retain overall Opacity; precise drafts, source retention and protected edits | Native-only |
| Clipping chains | Editable image/gradient fills inside text, shapes or raster silhouettes; soft base alpha retained; explicit release and whole-chain grouping | Native-only |
| Layer groups | Nested pass-through or isolated groups with 27 blend modes, whole-group masks/opacity/visibility, subtree duplication, reparenting and safe ungrouping | Native-only in this bridge version |
| Rulers and guides | 64 persistent pixel guides, view-only rulers and zoom-aware Move snapping; numeric guide controls and undo | Native-only |
| Arrange layers | Align to canvas or selected bounds; distribute centers or equal gaps with integer translations and fixed endpoints | Native-only in this bridge version |
| Color | Exposure, brightness, contrast, saturation, temperature, vibrance, hue, highlights, shadows, blur, sharpen, editable Levels and [Linear/Smooth Curves](docs/SMOOTH_CURVES.md) with [Master/component banks](docs/CURVES_BANKS.md), Channel Mixer, Gradient Map, Color Balance, Black & White/tint, [Selective Color](docs/SELECTIVE_COLOR.md), targeted [Hue / Saturation](docs/TARGETED_HSL.md), imported [Color Lookup](docs/COLOR_LOOKUP.md), [Photo Filter](docs/PHOTO_FILTER.md) and histogram | Exposure, brightness, contrast and saturation |
| Additional native adjustments | Invert, grayscale, sepia, posterize, threshold, median and alpha-weighted mosaic; editable and maskable | Native-only |
| Editable layer filters | 32 raster filter kinds, including source Gaussian Blur, RGB Sharpen, Unsharp Mask, repeatable Add Noise, High Pass, Local Shadows / Highlights and Photo Filter, in a reorderable stack with 26 individual RGB blend modes, a source-space effect mask, enable/opacity controls and explicit Bake/Clear actions; originals retained | Native-only |
| Outside layer styles | Editable drop shadow, outer glow and outlines;32 reusable document styles with atomic multi-layer application; original subject pixels preserved | Native-only |
| Fill and sample | Bucket fill, region erasing, eyedropper and averaged samples | Native-only in this bridge version |
| Shapes and paths | Editable rectangle, ellipse, triangle, polygon, star, line, cubic Bezier paths and anchor controls | Native-only in this bridge version |
| Gradients | Editable linear, radial, angle, reflected and diamond gradients with alpha stops | Native-only in this bridge version |
| Typography | Editable generic-family and bundled Fraunces text, alignment, bold/italic, tracking and Auto/explicit line spacing | Basic editable text |
| Transform | Move selected content with V; numeric translation, scale, rotation and flip; editable [four-corner Distort](docs/DISTORT.md) with saved stages, canvas handles and [linked Perspective](docs/LINKED_PERSPECTIVE.md) | Canvas crop/resize |
| AI image generation | Automatic local Codex image generation, manual handoffs, edits and selected fill; durable jobs and local hard clipping; optional explicit API route | Use generated files through the native workflow |
| Protected cutouts | Local alpha extraction, proportional cross-document placement, outside outlines and protected compositing | Photoshop subject selection through bridge |
| Canvas expansion | Nine anchors, reversible bounds changes, exact pixel retention and selected padding for AI outpainting | Native-only in this bridge version |
| History and AI control | Atomic MCP transactions, revisions, undo/redo, auto-save and reopen | Modal/history transactions |
| Reusable edit recipes | Saved typed filter, adjustment, typography and outside-style steps; explicit targets, validation, one-step Undo and definition transfer | Native-only |
| Files | PNG/JPEG/WebP/TIFF import and flattened export; PNG/JPEG/TIFF resolution metadata, JPEG matte, lossless WebP | Open directly in Photoshop; PNG/JPEG export |
| Portable projects | Editable `.prism` download/open with exact original assets, layers, groups, masks and saved selections; current state only, fresh history on import | Prism format; not Photoshop PSD |
| Layered PSD import | Bounded RGB8 flat raster layers with raw/PackBits channels, simple masks and explicit color policy; exact original archive retained | Open files directly in Photoshop |
| Layered PSD export | Strict flat raster/solid subset with separate masks, exact-byte opacity, sRGB and an opaque saved composite; compatibility report before download | Open files directly in Photoshop |

Keyboard: **V** move, **B** brush, **E** eraser, **S** clone, **J** healing, **O / Shift+O** dodge/burn, **M** marquee, **L** lasso, **W** magic wand, **I** eyedropper, **U** shape, **P** pen, **G / Shift+G** gradient/bucket, **T** type, **H** hand, **C** crop. Use **[ / ]** for brush size, **Option/Alt-click** to set clone/heal source, and **Enter** to finish a pen path. Choose a raster layer for retouching, or create a paint layer. Paint adjustment masks to localize editable color changes.

Enable **Aligned** beside Clone/Heal sampling to retain the source offset across separate strokes. Leave it unchecked to restart at the sampled anchor. The moving source marker follows the actual offset, including outside the canvas; each stroke samples fresh pixels and has its own Undo step. See [sampling, resets and MCP coordinates](docs/CLONE_ALIGNMENT.md).

Native boundaries: 8-bit sRGB, 24 megapixels, 8192 pixels per axis, 64 layers, 100 retained history states, and 16 MiB of project metadata. Oversized edits fail before changing the saved project. Imported originals remain byte-for-byte preserved. The renderer works on full images in memory; it is not tiled. Pixel masks use exact bounded run-length encoding or immutable framed alpha8 assets, with nearest-neighbor mask resampling. Detailed-mask history has separate256-asset/3GiB limits; portable projects retain their existing smaller limits. Layer masks stay anchored to the document during image-layer transforms. Their independent positions retain source coverage; image resampling requires explicitly rasterizing retained mask positions first. **Image → Scale image** offers Nearest neighbor, Cubic, Mitchell and Lanczos 3. Nearest copies sampled RGBA exactly at that geometry step; photographic methods use cubic enlargement. Existing masks and selections retain their own resize rules. See [resampling choices, precision and MCP](docs/RESAMPLING.md).

Use **Select → From a layer** to load image, cutout, text or shape transparency as a selection, or load an additional mask before/after density. Soft edges remain editable, empty selections stay empty, and no AI runs. See [source semantics, combine modes and MCP](docs/LAYER_SELECTIONS.md).

Use **Select → From composite channel** to preview or load Red, Green, Blue, Encoded luma or Alpha coverage from the visible image. Full-resolution soft selections can drive adjustments, painting and reusable masks without changing the original image. Inverting coverage also selects transparent pixels. See [channel controls, exact storage and MCP](docs/DENSE_MASKS.md).

Use **Inspect coverage** in Select or the layer-mask inspector for a read-only grayscale view, including feather, inversion and optional density. The viewer identifies its document revision and keeps source cutout alpha separate. See [mask inspection and preview limits](docs/MASK_INSPECTION.md).

Use **Layer filters** for editable source Gaussian Blur and RGB Sharpen. These filters preserve alpha and cutout silhouettes; their radius is measured before resizing or other layer transforms. See [controls, precision and source-filter limits](docs/SOURCE_SPATIAL_FILTERS.md).

Choose **Unsharp Mask** for separate Amount, Gaussian sigma and per-channel Threshold controls. Settings stay editable through recipes and portable projects, with explicit Bake for continuing pixel edits. See [Unsharp Mask controls and MCP](docs/UNSHARP_MASK.md).

Choose **Add Noise** for Uniform or Gaussian texture with monochromatic or separate RGB samples. A saved pattern seed keeps previews, exports and recipes repeatable; **New pattern** changes the local draft until you apply it. Transparency and original assets stay intact. See [Add Noise controls and MCP](docs/ADD_NOISE.md).

Choose **High Pass** for an editable gray detail map. Select Overlay or Soft Light to blend detail into the photo, with source-pixel sigma and precise filter opacity. Sigma zero produces gray 128 before blending. See [High Pass controls and MCP](docs/HIGH_PASS.md).

Choose **Selective Color** in the color workbench or a raster filter to adjust nine color ranges with Cyan, Magenta, Yellow and Black controls. Relative and Absolute modes retain every range's settings. Exact numeric drafts, source blend/opacity, masks, recipes and explicit Bake are supported. See [native color behavior and MCP examples](docs/SELECTIVE_COLOR.md).

Choose **Hue / Saturation** for separate Master, Reds, Yellows, Greens, Cyans, Blues and Magentas controls. All seven ranges stay editable together, with precise numeric values, source blending, masks and recipes. See [color targeting, native behavior and MCP examples](docs/TARGETED_HSL.md).

Choose **Photo Filter** to warm, cool or tint a photograph with a custom color, precise Density and optional Preserve Luminosity. Use it as a global adjustment or editable source filter, with masks, blending and reusable recipes. See [controls, native color behavior and MCP](docs/PHOTO_FILTER.md).

Choose **Upgrade to channel banks** in Curves to keep independent Master, Red, Green and Blue curves in one adjustment or filter. Each bank retains its own exact points and Linear/Smooth setting; Master runs first, followed by the component curves. Apply saves all four together. See [Curves banks, explicit conversions and MCP examples](docs/CURVES_BANKS.md).

Choose **Local Shadows / Highlights** to balance source tones according to nearby brightness. Separate Amount and Tonal width controls shape dark and bright regions, while source-pixel sigma controls the neighborhood. Alpha stays intact; large corrections can create halos. See [controls, limits and MCP](docs/LOCAL_SHADOWS_HIGHLIGHTS.md).

Use **Filter blend** to combine one filter with its input using Multiply, Screen, Soft Light, Luminosity and other RGB modes. Saved modes travel with recipes and portable projects; Normal keeps existing behavior. See [filter blending, precise opacity and MCP](docs/FILTER_BLENDING.md).

Additional layer-mask density can reveal more existing image content without changing its source pixels or cutout alpha. Painting and morphology retain density; replacement resets it. See [mask density controls and coverage rules](docs/MASK_DENSITY.md).

Move an additional mask independently with numeric X/Y controls. Position-only moves retain off-canvas coverage; crop shifts its source frame exactly. Canvas-bounds changes clip retained support, while painting, reshaping and **Rasterize mask position** convert current coverage to an ordinary 8-bit mask. Resize lists masks that need this explicit conversion and retains your dimensions while you review them. See [mask positioning and conversion rules](docs/MASK_POSITION.md).

Channel Mixer provides independent RGB percentage rows and monochrome mixing. Gradient Map colors image tones with editable stops and reverse. Both are available as adjustment layers and raster filters; original pixels and alpha remain intact. See [controls, exact parameter ranges and scope](docs/COLOR_MAPPING.md).

Color Balance provides separate shadow, midtone and highlight controls with optional luminosity preservation. Black & White mixes six input hue families and retains optional tint settings. Both work as editable adjustments, source filters and saved recipe steps. See [controls, precision and large-source limits](docs/TONAL_COLOR.md).

Raster layer filters run first to last on source pixels before geometry, so median/mosaic sizes scale with the image. Up to eight entries per layer and 64 per document are supported within workload and shared scratch limits. **Filter effect mask** scopes the completed stack without hiding the layer; explicitly capture a compatible current selection or use a source rectangle/ellipse. The additional layer mask controls final visibility. Disable or clear active entries before protecting a layer. Use **Bake filters** to keep the saved masked treatment as working pixels, or **Clear filters** to remove it, before eligible painting, filling, source-alpha repair, extraction or cross-document placement. Both remove the effect mask explicitly. Baking preserves the current composite and archived originals; protected targets and active stacks above earlier protected content reject. See [filter effect masks](docs/FILTER_EFFECT_MASKS.md) and [baking, undo and source-alpha behavior](docs/FILTER_BAKING.md).

Use **Layout** in the canvas footer for pixel rulers, document guides and optional Move snapping. Guides follow canvas geometry and remain outside image exports and AI inputs. See [guide controls and current snapping limits](docs/GUIDES.md).

Clip consecutive image or gradient layers into editable text, shapes or raster silhouettes from the Layers panel. The base retains its soft alpha and original assets. See [clipping behavior, protection and structural restrictions](docs/CLIPPING.md).

Isolated groups keep their adjustments inside the group and blend the completed result with the canvas. Protected descendants lock changes that would alter their isolation context. See [group modes and current restrictions](docs/GROUP_COMPOSITING.md).

Save reusable outline/shadow/glow combinations in the Layers panel. Applying one replaces those settings on the selected content layers as one undo step; every target keeps its pixels, masks, filters and protection. Presets are independent copies retained in `.prism` files. See [layer style controls and MCP commands](docs/LAYER_STYLES.md).

Open **Recipes** in Layers to capture reusable settings, inspect each step and bind it to a layer. Validation checks the complete proposed edit; application commits once. Definitions travel with `.prism` projects or as separate JSON files. Filters append on each intentional application. See [recipe controls, exact scope and MCP](docs/EDIT_RECIPES.md).

Repeated composite previews reuse an in-memory cache keyed by document, revision and preview width. Its 32-entry/64 MiB accounting limit is additional to rendering memory. Successful document writes invalidate cached previews. This assumes immutable internal assets; external changes to asset files are not rehashed on cache hits. Exports, generation snapshots and individual layer/source/mask inspection still read and render independently.

The Export panel can embed 1–1200 pixels-per-inch resolution metadata without resizing the image. TIFF uses lossless Deflate compression with transparency and an sRGB profile; it is a flattened 8-bit file, not a layered project. JPEG has an adjustable matte for transparent areas. Lossless WebP preserves visible pixels and alpha; its codec may normalize RGB beneath fully transparent pixels. PNG or TIFF preserve the full rendered RGBA buffer. WebP does not support the editor's resolution metadata option.

This does **not** implement all Photoshop features. RAW, general PSD/PSB interchange, CMYK/HDR/16-bit editing, smart objects, clipped groups/adjustments, advanced inner effects, Camera Raw, Liquify, arbitrary object selection, specialized restoration/upscaling, and the remaining catalog tools are future work. Native healing uses sampled color matching; red-eye uses a color heuristic; Curves offers unchanged Linear segments or explicit native Smooth interpolation. Blend modes implement core math without Photoshop's special Fill-opacity behavior. Groups support pass-through and isolated compositing, with up to eight nested groups and a shared 256 MiB group/filter/clipping scratch budget. Editable text includes generic system families and bundled Fraunces; it is not a full typography engine. The native algorithms are not Adobe's proprietary algorithms.

Limited layered PSD copies preserve independent raster layers and exactly representable 8-bit masks/opacity. Unsupported text, groups, blends, effects, filters and contextual generation reject with a compatibility report. Geometry becomes raster pixels in the copy. Keep `.prism` for full editing state and source archives. See [PSD export scope](docs/PSD_EXPORT.md).

**File → Open PSD** inspects a bounded RGB8 flat raster subset before importing it as a new document. Simple separate masks, visibility, opacity, Unicode names and off-canvas layer source pixels are retained; native display still clips to the canvas. Untagged files require an explicit sRGB assumption. Unsupported records reject with a report. Download the exact original PSD before or after editing, and retain it through `.prism` transfers. See [PSD import scope and limits](docs/PSD_IMPORT.md).

## Storage and editing behavior

Use **File → Download project** to take an editable `.prism` copy with you and **File → Open project** to reopen it as a separate document. Portable files include current layers, settings and required assets; they omit undo history. See the [portable project format and MCP workflow](docs/PROJECT_FORMAT.md).

- `.prism/native/projects/`: editable document graphs and undo history.
- `.prism/native/assets/`: immutable imported originals and working assets.
- `.prism/exports/`: new image, limited layered PSD and portable project files exported through MCP. Browser exports download through the browser instead.
- `.prism/generation/`: saved job metadata, masks, snapshots and generated output assets.
- `.prism/models/`: downloaded local segmentation model.
- `.prism/python-runtime/`: isolated CPU inference dependencies; no system Python packages are changed.
- `.prism/secrets/openai-api-key`: server-only image-provider credential; never returned to clients.
- `.prism/bridge-token`: generated local pairing key, restricted file permissions. Do not commit or share it.

The shared API validates every command. Mutations are serialized, optional `expectedRevision` rejects stale requests, and a repeated `requestId` returns the same result during the current companion session. Use `apply_transaction` for one undo step across multiple edits. A failed transaction does not commit partial changes. Conventional command deduplication is bounded to the companion session. AI job retry IDs persist across restarts; interrupted provider calls are never automatically retried.

Timeouts and connection losses can leave a Photoshop command's outcome unknown; inspect the document before retrying. Reloading the plugin resets its observed revision counters. Native changes automatically save; explicit save is also available. Export creates a flattened copy and preserves the editable project.

The browser and MCP clients authenticate to the local companion. The server validates browser origins and hosts, and the optional plugin authenticates its socket with the pairing key. Ordinary edits and local segmentation stay on this computer. Built-in generation sends the requested prompt and edit references to the signed-in Codex image tool and uses Codex usage limits; the optional API route sends prompts/edit snapshots under separate API billing. No arbitrary script execution or remote listener is exposed. `npm run doctor` checks the standalone installation; optional `-- --check-api` and `-- --check-adobe` inspect those integrations explicitly.

## Verify

```sh
npm test
npm run build
npm run test:browser
npm run test:browser:pro
npm run test:generation-browser
npm run test:codex-generation-browser
npm run test:saved-selection-browser
npm run test:project-bundle-browser
npm run test:arrangement-browser
npm run test:layer-filters-browser
npm run test:morphology-browser
npm run doctor
```

The browser test runs the compiled workspace with an isolated temporary companion and leaves user projects untouched. Build first. It uses installed Google Chrome on macOS, or Playwright Chromium on other platforms. Screenshots and exported fixtures go to `test-results/`. Set `PRISM_UI_URL` only when intentionally testing an already-running workspace. See [the tool inventory](docs/PHOTOSHOP_TOOL_INVENTORY.md), [the roadmap](docs/ROADMAP.md), [the initial command contract](docs/CONTRACT.md), and [professional command additions](docs/PRO_TOOLS.md) for implementation boundaries.

## Optional existing Photoshop bridge

This optional integration is only for people who already use Photoshop. Skip it for every Prism Native workflow.

1. Open Photoshop 25+ and Adobe UXP Developer Tool.
2. Add `photoshop-plugin/manifest.json` in UXP Developer Tool and load it.
3. Open **Plugins → Prism Studio** in Photoshop.
4. In the Prism workspace, open connection setup and copy the pairing key into the plugin.
5. Connect. Select the Photoshop backend and open a document in Photoshop.

The complete [Photoshop setup and manual validation checklist](photoshop-plugin/README.md) documents precisely what is implemented and what still needs real-host testing. The bridge does not install Photoshop or activate an Adobe account.
