# PSD codec evaluation — ag-psd 31.0.2

Evaluated September 19, 2026. **Do not expose this codec as a general production PSD importer/exporter yet.** Its raw raster API is useful and preserves layer data in the fixtures below, but tested allocation, input-boundary, compatibility-reporting and export defects require additional controls. No application dependency or production import/export implementation was changed by this evaluation.

The better next milestone is a small, independently verified **export-only** writer for an explicit native subset, using uncompressed PSD v1 channels and an opaque merged image. General PSD import remains a separate project.

## Reproducibility and isolation

The complete experiment is in [test-results/psd-evaluation](../test-results/psd-evaluation/README.md). `ag-psd@31.0.2` was installed there with `--ignore-scripts`, its own npm cache and lockfile. Its only runtime dependencies are pinned `base64-js@1.5.1` and `pako@2.1.0`. The package integrity digest is recorded in that lockfile. Independent checks use an isolated Python environment with `psd-tools==1.19.0` and Pillow `12.3.0`. All fixtures are synthetic and generated locally; no Adobe installation, private photographs, credentials or paid service was used.

Run the four commands in the evaluation README. The generated JSON files are the evidence, including intentionally reproduced defects. A `passed` result on a defect reproduction means the problematic behavior was observed, not that the codec is safe.

## What worked

The [1,468-byte layered fixture](../test-results/psd-evaluation/raster-groups-mask.psd) includes three raster leaves, a pass-through group at opacity `128/255`, an empty group, a Unicode name, a hidden multiply layer, negative layer and mask origins, and layer alpha values 0, 1, 128 and 255. The independently supplied opaque merged image is separate from those records.

Reading and rewriting the fixture through raw `imageData` preserved every raster RGBA byte, including hidden RGB at alpha zero, every mask byte, hierarchy/order, names, visibility, bounds and representable opacity. There were zero canvas calls. Reading requires a custom `initializeCanvas` image-data allocator even with `useImageData:true`; the canvas factory can reject every call. Writing accepts typed raw image data without node-canvas when thumbnail generation is disabled. This supports a dependency-free pixel bridge to Prism's existing RGBA renderer. See [results.json](../test-results/psd-evaluation/results.json).

Independent checks establish more than a self-roundtrip:

- Pillow decoded the supplied opaque merged RGB exactly.
- psd-tools independently decoded all three layer RGBA buffers, the raster mask, negative origins, group opacity, visibility, Unicode names and the empty group exactly.
- Recomposition through psd-tools differed from our manual integer composite by at most one channel value in seven channels. Raw asset fidelity and cross-engine compositing are distinct guarantees.
- A second file produced by psd-tools contained a hidden, offset raster inside a Unicode group. That producer stores RGBA input alpha as a separate user mask in an RGB document. ag-psd recovered its RGB and mask exactly; multiplying those independent channels reproduced the original RGBA. See [independent-results.json](../test-results/psd-evaluation/independent-results.json) and [independent-readback.json](../test-results/psd-evaluation/independent-readback.json).

## Confirmed blockers and limits

| Finding | Small reproduction | Implication |
| --- | --- | --- |
| Lazy helpers ignore the configured decode budget | With `totalMemoryLimit:1`, eager decode rejects, while lazy layer, mask and composite helpers allocate 48, 24 and 96 bytes respectively. | Preflight all bitmap dimensions and budget every decode outside these helpers. |
| ZIP expansion is not dimension/budget bounded | A file declaring a one-pixel channel contains 4,092 compressed bytes that expand to 4 MiB. Eager decode succeeds with a 1,024-byte budget. | The image allocator guard does not bound decompression. Reject ZIP initially or use a separately bounded decompressor that verifies exact output size. |
| Reads can cross the supplied input view | A deliberately truncated 222-byte file is exposed as a view into a larger, explicitly initialized array. The decoded blue channel becomes the known canary byte 177 beyond that view. Copying into an exact-sized owned array instead produces zero-filled fallback data. | Never pass a pooled Buffer/view directly; exact ownership is necessary but does not make malformed input rejection strict. Validate section and channel lengths independently. |
| Unknown records are silently skipped | Replacing a `luni` record key with `zzzz` still succeeds with `throwForMissingFeatures:true`. An unknown image resource is also discarded. | That flag is not a complete unsupported-feature detector. Enumerate records before conversion and enforce an allowlist/report. |
| ICC profile is discarded | The fixture's valid 480-byte resource 1039 is readable by Pillow, but disappears after ag-psd read/write. Resource 1005 resolution survives at 300 PPI. | Prism must preserve/interpret ICC independently; RGB mode alone is not proof of sRGB. |
| One-pixel-wide merged exports are truncated | For dimensions 1×1, 1×2 and 1×3, raw layers remain correct, but Pillow rejects the composite as truncated. Widths 2–6 passed the same fixture sweep. | Do not ship the current writer without handling this case. |
| Transparent merged-image roundtrip is lossy | Source RGB `(37,89,173)` at alpha 1 returns `(0,0,0)` after ag-psd's merged-image white-matte processing; alpha 128 also loses RGB precision. Layer RGBA stays exact. | Do not claim transparent merged-composite pixel equality. A strict first export can require an opaque final composite while retaining soft alpha in editable layers. |
| Opacity is quantized to one byte | `0.5` returns `128/255`. | Either explicitly report quantization or reject nonrepresentable values in an exact subset. |
| No merged-image rendering | Omitting the supplied composite does not render the red layer into the saved composite. | Always generate a fresh compatibility image from Prism. |

These are bounded local fixtures, not giant allocation attacks. The maximum deliberately expanded malformed channel is 4 MiB. The input-boundary experiment uses owned canary bytes, not unrelated process data. See [boundary-checks.mjs](../test-results/psd-evaluation/boundary-checks.mjs), [input-view-bounds.json](../test-results/psd-evaluation/input-view-bounds.json), and the malformed fixture generator in [evaluation.mjs](../test-results/psd-evaluation/evaluation.mjs).

The pinned source explains the findings: `dist/psdReader.js` passes no memory limit from `getLayerImageData`/mask helpers, creates a fresh unbudgeted reader for the lazy composite, inflates ZIP through `pako.inflate`, and bounds `readBytes` against the backing array rather than the view. Unknown resource and additional-info branches skip records. Resource 1039 is behind `MOCK_HANDLERS=false`. The writer's scratch estimate is too small for the one-pixel-wide merged RLE case. These observations concern the installed 31.0.2 artifact, not an assumption about a future upstream revision.

## Threading and memory experiment

A 2048×2048 RGB fixture with four full-size raster layers encoded to 1,323,568 bytes because its rows compress well. In one local run, writing took 54 ms and worker decoding took 49 ms. The parent heartbeat continued at approximately 5–7 ms. Terminating a second worker five milliseconds after its ready message stopped active synchronous decoding; termination completed in about 1.1 ms. These timings are measurements for this easy fixture, not latency guarantees. See [worker-results.json](../test-results/psd-evaluation/worker-results.json).

The worker had a 32 MiB V8 old-generation limit but reported roughly 86.6 MB of ArrayBuffers. The heap setting is not a pixel-memory cap. A production wrapper needs independent compressed-input, decoded-pixel, metadata, node-count, depth and scratch limits plus a real worker deadline. Validate every layer and mask rectangle, which may exceed the document canvas, before invoking any lazy helper. A timed-out worker must be terminated before publishing a project. A structured, bounded output from the worker must be validated again by the parent.

## Recommended controlled export-only contract

Use a small raw-channel writer for already validated native documents. This avoids introducing an untrusted PSD parser or ZIP/RLE decompressor into the application. It still requires byte-layout tests and independent readers.

First subset:

- PSD version 1, RGB, eight-bit channels; native dimension/count limits and a separate **64 MiB exact output limit**.
- Flat raster/solid leaves in normal blend mode. Export rendered working pixels after geometry, but before each layer's own mask and opacity. Geometry is explicitly rasterized in the exported copy; the native source graph stays unchanged.
- Keep every exported raster RGBA byte, including alpha-zero RGB; keep own raster-mask bytes separately. Mask coverage must be exactly representable as alpha8 for this strict subset. Source cutout alpha already belongs in the exported raster alpha.
- Preserve names using a Unicode name record, stacking order, visibility and opacity only when `opacity × 255` is an integer within a small numerical tolerance. Reject silent rounding.
- Reject groups, adjustments, text/vector/gradient layers, layer styles/outlines, nonempty editable filter stacks, and layers whose generated provenance causes contextual clipping. Report the exact layer and unsupported feature before allocating output.
- Require the final visible composite to be opaque. Write its exact RGB as uncompressed planar channels; retain soft alpha in the individual layers. This avoids the conflicting transparent-composite interpretation observed across independent decoders.
- Embed a known sRGB ICC resource explicitly. Do not infer color space from an RGB header, and do not silently discard unknown profiles when import is eventually considered.
- Clearly report that Prism's protection semantics, immutable source archives, native geometry/selection metadata and undo history are not PSD-native properties. Keep `.prism` as the native lossless editable format.

The writer should accept already rendered owned buffers, have no filesystem/network access, preflight exact section sizes before allocation, and write directly into one bounded final buffer. A metadata-only preflight returns a compatibility report with supported/unsupported reasons and estimated size; the final write rechecks all buffer lengths, opacity, mask bounds, profile and merged alpha. Errors return no partial output. Native queue/revision handling remains outside the codec.

Before UI exposure, independent Pillow and psd-tools fixtures should cover 1×1/1×N/N×1 dimensions; asymmetric colors; alpha 0/1/128/255; hidden RGB; masks 0/1/128/255; Unicode names; hidden layers; exact opacity bytes; top/bottom ordering; and opaque merged pixels. The controlled writer must also reject every unsupported native feature, one byte over its output cap, malformed buffers, fractional masks and nonrepresentable opacity without modifying inputs.

## Controlled writer implementation and independent verification

The pure [controlled writer](../server/psd-export.mjs) is now implemented without adding any production dependency. Native rendering, queue/revision guards and transport integration are separate work. Its two functions are `preflightPsdExport(graph,{iccProfileBytes})` and `writePsdExport({width,height,layers,composite,iccProfile})`. The writer receives full-canvas bottom-to-top `{id,name,visible,opacity,pixels,mask?}` layers, where `pixels` is RGBA8 and `mask` is optional alpha8. It returns `{data,mimeType,bytes}`. Unsupported content produces a structured compatibility report; malformed buffer/profile arguments and bounded-resource failures have explicit codes.

Preflight includes the exact final output size and a conservative working estimate comprising caller-owned input frames, the writer's copied frames and its final output. Limits are 64 MiB output and 256 MiB working storage. Composite opacity remains a pixel-validation requirement even when metadata preflight succeeds. Native integration must supply a known sRGB profile and reject mask coverage that is not exactly representable in alpha8; the writer validates bounded ICC structure and accepts already quantized mask bytes.

The eight [focused tests](../tests/psd-export.test.mjs) validate raw channel records and sizes using a separate specification-oriented byte walker, plus feature restrictions, one-pixel dimensions, caller ownership, malformed inputs and resource preflight. Five additional independently authored audit tests run actual Pillow and psd-tools readers and test a metadata case exactly one byte above the output cap.

The reproducible [controlled fixture generator](../test-results/psd-evaluation/controlled-writer.mjs) and [independent reader script](../test-results/psd-evaluation/controlled-independent.py) cover 1×1, 1×3, 3×1, 5×3 and 11×7 synthetic documents with three layers, partial masks, soft alpha, invisible RGB, Unicode names, hidden content and byte-exact opacity. Every raw layer RGBA byte, mask byte, ICC byte and saved merged RGB byte decoded exactly. Their results are saved in [controlled-independent-results.json](../test-results/psd-evaluation/controlled-independent-results.json).

When psd-tools forcibly recomposited those layers, its result differed from the supplied native-style integer composite by at most **one 8-bit channel value**: respectively 0, 3, 3, 13 and 76 differing channels across those fixtures. The compatibility report explicitly distinguishes raw/saved-composite fidelity from cross-editor recomposition; these measurements do not establish a universal one-value maximum or exact Photoshop parity.

For the smallest files, psd-tools logs an `Invalid signature` warning while decoding all pixels correctly. Its optional-global-mask check expects at least 17 bytes after layer information; the valid four-byte empty global-mask record plus tiny merged RGB payload is shorter. Independent byte walkers confirm correct section lengths and the Adobe-specified empty mask record. No private padding or decoder-specific workaround was inserted into the PSD.

## Primary references

- [Adobe PSD format specification](https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/): authoritative section, channel, mask and resource layouts.
- [ag-psd upstream README](https://github.com/Agamnentzar/ag-psd/blob/master/README.md): raw image-data API, no compositor, and production handling guidance. Actual behavior above was tested against the local pinned artifact.
- [ag-psd reader source](https://github.com/Agamnentzar/ag-psd/blob/master/src/psdReader.ts), [writer source](https://github.com/Agamnentzar/ag-psd/blob/master/src/psdWriter.ts), and [image-resource handlers](https://github.com/Agamnentzar/ag-psd/blob/master/src/imageResources.ts): primary implementation references; upstream branch contents may change.
- [Pillow image format documentation](https://pillow.readthedocs.io/en/stable/handbook/image-file-formats.html#psd) and [psd-tools documentation](https://psd-tools.readthedocs.io/en/latest/): independent decoder/producer capabilities. Both were actually run for this evaluation.

No external image fixtures or upstream source code were copied into production files. The small fixture generators and tests are original evaluation code.
