"""Local alpha-only BiRefNet inference. No RGB reconstruction or network calls."""

import hashlib
import io
import json
import os
import sys

os.environ.setdefault("OMP_NUM_THREADS", "2")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")

import numpy as np
import onnxruntime as ort
from PIL import Image

MODEL_BYTES = 224005088
MODEL_MD5 = "4fab47adc4ff364be1713e97b7e66334"
MODEL_ID = "birefnet-general-lite"
INPUT_SIZE = 1024
Image.MAX_IMAGE_PIXELS = 24_000_000
session = None


def initialize(model_path):
    global session
    if os.path.getsize(model_path) != MODEL_BYTES:
        raise ValueError("Invalid model")
    digest = hashlib.md5()
    with open(model_path, "rb") as model:
        for chunk in iter(lambda: model.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != MODEL_MD5:
        raise ValueError("Invalid model")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    options.log_severity_level = 3
    session = ort.InferenceSession(model_path, sess_options=options,
                                   providers=["CPUExecutionProvider"])


def segment(payload, model_path):
    with Image.open(io.BytesIO(payload)) as source:
        width, height = source.size
        if (source.format != "PNG" or getattr(source, "n_frames", 1) != 1
                or min(width, height) < 1 or max(width, height) > 8192
                or width * height > 24_000_000):
            raise ValueError("Invalid image")
        rgb = source.convert("RGB").resize((INPUT_SIZE, INPUT_SIZE), Image.Resampling.LANCZOS)
    pixels = np.asarray(rgb, dtype=np.float32)
    pixels /= max(float(pixels.max()), 1.0)
    pixels = (pixels - np.array([.485, .456, .406], dtype=np.float32)) / np.array([.229, .224, .225], dtype=np.float32)
    tensor = pixels.transpose(2, 0, 1)[None, ...]
    if session is None:
        initialize(model_path)
    outputs = session.run(None, {session.get_inputs()[0].name: tensor})
    prediction = outputs[0]
    if prediction.size != INPUT_SIZE * INPUT_SIZE or not np.isfinite(prediction).all():
        raise ValueError("Invalid mask")
    # Stable sigmoid, then the same min/max normalization used by rembg's
    # BiRefNet adapter. Predicted coverage is the only returned image data.
    probabilities = 1.0 / (1.0 + np.exp(-np.clip(prediction, -80, 80)))
    minimum, maximum = float(probabilities.min()), float(probabilities.max())
    alpha = np.zeros((INPUT_SIZE, INPUT_SIZE), dtype=np.uint8)
    if maximum - minimum > 1e-7:
        alpha = np.rint(255 * (probabilities.reshape(INPUT_SIZE, INPUT_SIZE) - minimum) / (maximum - minimum)).astype(np.uint8)
    mask = Image.fromarray(alpha).resize((width, height), Image.Resampling.LANCZOS)
    return width, height, mask.tobytes()


def read_exact(stream, size):
    chunks = bytearray()
    while len(chunks) < size:
        chunk = stream.read(size - len(chunks))
        if not chunk:
            raise EOFError()
        chunks.extend(chunk)
    return bytes(chunks)


def main():
    if len(sys.argv) != 2:
        return 1
    incoming, outgoing = sys.stdin.buffer, sys.stdout.buffer
    while True:
        line = incoming.readline(4097)
        if not line:
            return 0
        if len(line) > 4096 or not line.endswith(b"\n"):
            return 1
        try:
            header = json.loads(line)
            request_id, length = header["id"], header["bytes"]
            if (not isinstance(request_id, str) or len(request_id) > 128
                    or type(length) is not int or length < 1 or length > 32 * 1024 * 1024):
                return 1
            payload = read_exact(incoming, length)
        except (ValueError, KeyError, TypeError, EOFError):
            return 1
        try:
            width, height, alpha = segment(payload, sys.argv[1])
            result = {"id": request_id, "width": width, "height": height,
                      "model": MODEL_ID, "bytes": len(alpha)}
            outgoing.write(json.dumps(result).encode("utf-8") + b"\n")
            outgoing.write(alpha)
        except Exception:
            # Never serialize file paths, source pixels or exception details.
            result = {"id": request_id, "error": {"code": "SEGMENTATION_FAILED",
                      "message": "Local subject extraction failed."}}
            outgoing.write(json.dumps(result).encode("utf-8") + b"\n")
        outgoing.flush()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (BrokenPipeError, KeyboardInterrupt):
        sys.exit(0)
