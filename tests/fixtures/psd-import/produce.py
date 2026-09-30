"""Independent PSD input fixtures; no application importer or writer is used."""
import hashlib
import json
from pathlib import Path

from PIL import Image
from psd_tools import PSDImage
from psd_tools.api.layers import PixelLayer
from psd_tools.constants import ChannelID, Compression

ROOT = Path(__file__).resolve().parent
ROOT.mkdir(parents=True, exist_ok=True)
results = []
expected = []


def pattern(width, height, seed):
    return bytes(value for index in range(width * height) for value in
                 ((seed + index * 37) % 256, (211 - index * 11) % 256, (71 + index * 29) % 256))


for compression in (Compression.RAW, Compression.RLE):
    psd = PSDImage.new('RGB', (9, 6), color=(29, 43, 71))
    psd._record.image_data.compression = compression
    background = PixelLayer.frompil(Image.new('RGB', (9, 6), (29, 43, 71)), psd,
                                    name='Independent background', compression=compression)

    negative_rgb = pattern(5, 3, 17)
    negative_alpha = bytes([0, 1, 128, 255, 64][index % 5] for index in range(15))
    negative_rgba = bytes(value for index in range(15)
                          for value in (*negative_rgb[index * 3:index * 3 + 3], negative_alpha[index]))
    negative = PixelLayer.frompil(Image.frombytes('RGBA', (5, 3), negative_rgba), psd,
                                  name='Negative source', left=-2, top=2, compression=compression)
    negative.name = 'Hidden Ω 🌿'
    negative.opacity = 191
    negative.visible = False

    dual_rgb = pattern(3, 5, 83)
    dual_alpha = bytes([255, 128, 1, 0, 64][index % 5] for index in range(15))
    dual_mask = bytes([0, 1, 128, 255][index % 4] for index in range(12))
    dual = PixelLayer.frompil(Image.frombytes('RGB', (3, 5), dual_rgb), psd,
                             name='Independent alpha and offset mask', left=3, top=0, compression=compression)
    # Use the independent codec's channel API to create genuine source alpha,
    # separately from the user mask produced by its public create_mask method.
    for info, channel in zip(dual._record.channel_info, dual._channels):
        if info.id == ChannelID.TRANSPARENCY_MASK:
            channel.set_data(dual_alpha, 3, 5, 8, 1)
            info.length = channel._length
    dual.create_mask(Image.frombytes('L', (3, 4), dual_mask), left=4, top=1, compression=compression)
    dual.opacity = 127

    filename = 'flat-' + compression.name.lower() + '.psd'
    psd.save(ROOT / filename)
    data = (ROOT / filename).read_bytes()
    reopened = PSDImage.open(ROOT / filename)
    records = reopened._record.layer_and_mask_information.layer_info
    fixture = {'filename': filename, 'width': 9, 'height': 6, 'layers': []}
    result = {'filename': filename, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
              'headerChannels': reopened._record.header.channels, 'layerCount': records.layer_count,
              'mergedCompression': int(reopened._record.image_data.compression),
              'resourceIds': [int(resource) for resource in reopened._record.image_resources.keys()],
              'iccPresent': 1039 in reopened._record.image_resources, 'layers': []}
    for layer, record, channels in zip(reopened, records.layer_records, records.channel_image_data):
        rgba = layer.topil(apply_icc=False).convert('RGBA').tobytes()
        mask = layer.mask.topil().convert('L').tobytes() if layer.mask else None
        fixture['layers'].append({'name': layer.name, 'bounds': list(layer.bbox), 'rgba': list(rgba),
                                  'opacity': layer.opacity, 'visible': layer.visible,
                                  'mask': list(mask) if mask is not None else None,
                                  'maskBounds': list(layer.mask.bbox) if layer.mask else None,
                                  'maskDefault': record.mask_data.background_color if record.mask_data else None})
        result['layers'].append({'name': layer.name, 'bounds': list(layer.bbox),
                                 'flagsHex': record.flags.tobytes().hex(), 'opacity': layer.opacity,
                                 'maskFlagsHex': record.mask_data.flags.tobytes().hex() if record.mask_data else None,
                                 'maskBounds': list(layer.mask.bbox) if layer.mask else None,
                                 'maskDefault': record.mask_data.background_color if record.mask_data else None,
                                 'blendingRangesHex': record.blending_ranges.tobytes().hex(),
                                 'tagKeys': [key.decode('ascii') for key in record.tagged_blocks.keys()],
                                 'channels': [{'id': int(info.id), 'bytes': info.length,
                                               'compression': int(channel.compression)}
                                              for info, channel in zip(record.channel_info, channels)]})
    extracted_negative = bytes(fixture['layers'][1]['rgba'])
    extracted_dual = bytes(fixture['layers'][2]['rgba'])
    assert extracted_negative[0::4] == negative_rgb[0::3]
    assert extracted_negative[1::4] == negative_rgb[1::3]
    assert extracted_negative[2::4] == negative_rgb[2::3]
    assert set(extracted_negative[3::4]) == {255}
    assert bytes(fixture['layers'][1]['mask']) == negative_alpha
    assert extracted_dual[0::4] == dual_rgb[0::3]
    assert extracted_dual[1::4] == dual_rgb[1::3]
    assert extracted_dual[2::4] == dual_rgb[2::3]
    assert extracted_dual[3::4] == dual_alpha
    assert bytes(fixture['layers'][2]['mask']) == dual_mask
    assert fixture['layers'][1]['bounds'] == [-2, 2, 3, 5]
    assert fixture['layers'][2]['maskBounds'] == [4, 1, 7, 5]
    assert not fixture['layers'][1]['visible']
    assert reopened._record.header.channels == 3 and records.layer_count == 3
    assert result['mergedCompression'] == int(compression)
    assert not result['iccPresent']
    # The saved compatibility image is independently decoded by Pillow too.
    merged = Image.open(ROOT / filename).convert('RGB')
    assert merged.size == (9, 6)
    fixture['savedMergedRgb'] = list(merged.tobytes())
    result['rawRgbAlphaAndSeparateMaskExact'] = True
    result['pillowMergedDecoded'] = True
    results.append(result)
    expected.append(fixture)

(ROOT / 'report.json').write_text(json.dumps({'producer': 'psd-tools 1.19.0', 'pillow': '12.3.0',
                                           'fixtures': results}, indent=2) + '\n')
(ROOT / 'expected.json').write_text(json.dumps(expected, indent=2) + '\n')
print(json.dumps({'fixtures': len(results), 'allSourceRgbAlphaMasksExact': True,
                  'mergedCompression': [item['mergedCompression'] for item in results],
                  'bytes': [item['bytes'] for item in results],
                  'iccPresent': [item['iccPresent'] for item in results]}, indent=2))
