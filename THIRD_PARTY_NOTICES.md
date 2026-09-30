# Third-party assets

## Fraunces

Bundled regular and italic variable fonts are from the [Google Fonts Fraunces directory](https://github.com/google/fonts/tree/main/ofl/fraunces). Copyright 2020 The Fraunces Project Authors. Distributed under the SIL Open Font License 1.1; see [the included license](assets/fonts/Fraunces-OFL.txt). Font binaries are unmodified; filenames are shortened for packaging.

## BiRefNet

The optional local subject-segmentation model is [BiRefNet](https://github.com/ZhengPeng7/BiRefNet), by its authors, distributed under the MIT license. See [the included license](assets/models/BiRefNet-LICENSE.txt). Model weights are downloaded separately into the ignored local data directory and are not bundled with the source tree.

The exported Lite model URL, checksum and preprocessing/postprocessing follow [rembg's BiRefNet adapters](https://github.com/danielgatis/rembg/tree/main/rembg/sessions). See [rembg's MIT license](assets/models/rembg-LICENSE.txt). Prism uses model output only as alpha coverage and does not use foreground color reconstruction.

## Runtime dependencies

JavaScript runtime dependencies and their versions are recorded in `package-lock.json`; each installed package includes its own license. Optional Python inference dependencies are pinned in `assets/models/requirements.txt` and installed into an isolated local virtual environment. ONNX Runtime provides CPU inference, NumPy provides tensor operations, Pillow provides alpha/image resampling, and sharp/libvips provides native raster operations. Provider-generated imagery is stored separately from source code and is not part of these bundled assets.
