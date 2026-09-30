# Independent PSD input fixtures

These small synthetic files were produced with isolated psd-tools 1.19.0 and independently read with Pillow 12.3.0 on September19,2026. They contain no user photos or external artwork. `produce.py` reproduces them in its own directory when those optional Python packages are available; normal Node tests use the checked-in files and need no Python dependency.

`flat-raw.psd` uses raw layer/merged channels. `flat-rle.psd` uses PackBits layer/merged channels. Both are 9×6 RGB8 documents with three raster layers, Unicode names, hidden negative-origin pixels, alpha0/1/128/255, independently positioned user masks, byte opacity and neutral blending ranges. They are untagged and require the explicit sRGB interpretation option. `expected.json` records the independently supplied source bytes and geometry.

These exercise a foreign producer, rather than Prism's own PSD writer. They do not establish general Photoshop compatibility. See docs/PSD_IMPORT_REVIEW.md and the ignored test-results/psd-import-evaluation/report.json for the original inspection.
