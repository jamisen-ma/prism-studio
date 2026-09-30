# Tonal grading photographic fixture

`astronaut.png` is the original 512×512, 8-bit RGB photograph of NASA astronaut Eileen Collins supplied with scikit-image. It was copied byte-for-byte from this workspace's earlier public segmentation source fixture; no cutout, segmentation, generation, resizing or color edit was applied.

The [official scikit-image data documentation](https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.astronaut) identifies the NASA Great Images database as its source and states that the image is public domain with no known copyright restrictions. Its [linked NASA source](https://flic.kr/p/r9qvLn) supplies the original attribution. The original scene includes the held helmet and full background.

SHA-256: `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`.

The browser test reads this local file without external requests. It checks byte preservation and writes actual native before/after outputs for visual review. Synthetic RGBA fixtures and separate independent numerical tests supply exact algorithm assertions; this photograph does not establish Adobe numerical parity.
