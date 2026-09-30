import { useEffect, useRef, useState } from 'react';
import { command, type Backend, type Document, type Mask, type MaskPreview } from './api';
import { capabilityStrings, denseCapabilityKey, paintSelectionCoverage, previewDimensions, supportsMask } from './dense-mask';

export function Alpha8SelectionOverlay({ selection, document, capabilities }: { selection: Mask; document: Document; capabilities?: Backend }) {
  const canvas = useRef<HTMLCanvasElement>(null), [ready, setReady] = useState(''), [failed, setFailed] = useState('');
  const limit = capabilities?.limits?.maxMaskPreviewEdge, bytes = capabilities?.limits?.maxMaskPreviewBytes;
  const edge = typeof limit === 'number' && Number.isInteger(limit) && limit >= 32 && limit <= 2400 ? Math.min(700, limit) : 0;
  const supported = Boolean(supportsMask(selection, capabilities) && capabilityStrings(capabilities?.commands).includes('get_mask_preview') && capabilityStrings(capabilities?.maskPreviewSources).includes('selection') && edge && Number.isSafeInteger(bytes) && bytes! > 0 && bytes! <= 8 * 1024 * 1024 && Number.isSafeInteger(capabilities?.limits?.maxMaskPreviewWorkingBytes) && capabilities!.limits!.maxMaskPreviewWorkingBytes! > 0 && capabilities!.limits!.maxMaskPreviewWorkingBytes! <= 256 * 1024 * 1024);
  const key = JSON.stringify([document.backend, document.id, document.revision, document.width, document.height, selection, denseCapabilityKey(capabilities), capabilities?.commands, capabilities?.maskPreviewSources, capabilities?.limits?.maxMaskPreviewEdge, capabilities?.limits?.maxMaskPreviewWorkingBytes, bytes]);
  const latest = useRef(key); latest.current = key;
  useEffect(() => {
    setReady(''); setFailed('');
    const node = canvas.current; if (node) { node.width = 1; node.height = 1; }
    if (!supported) return;
    const abort = new AbortController(); let alive = true;
    const owned = () => alive && !abort.signal.aborted && latest.current === key;
    void command<MaskPreview>('native', 'get_mask_preview', { documentId: document.id, expectedRevision: document.revision, source: 'selection', maxEdge: edge }, abort.signal).then(async result => {
      if (!owned()) return;
      const size = previewDimensions(document.width, document.height, edge);
      if (result.documentId !== document.id || result.revision !== document.revision || result.source !== 'selection' || result.layerId !== undefined || result.maskMode !== undefined || result.sourceWidth !== document.width || result.sourceHeight !== document.height || result.maxEdge !== edge || result.width !== size.width || result.height !== size.height || result.mimeType !== 'image/png' || result.sampling !== 'nearest-pixel-center' || typeof result.data !== 'string' || !result.data.length || result.data.length > Math.ceil(bytes! / 3) * 4) throw Error('Coverage mismatch');
      const image = new Image(); image.src = `data:image/png;base64,${result.data}`; await image.decode();
      if (!owned() || !canvas.current) return;
      if (image.naturalWidth !== size.width || image.naturalHeight !== size.height) throw Error('Coverage frame mismatch');
      const target = canvas.current; target.width = size.width; target.height = size.height;
      const context = target.getContext('2d'); if (!context) throw Error('Coverage canvas unavailable');
      context.drawImage(image, 0, 0);
      const rgba = context.getImageData(0, 0, size.width, size.height);
      const gray = new Uint8Array(size.width * size.height);
      for (let index = 0; index < gray.length; index++) gray[index] = rgba.data[index * 4];
      paintSelectionCoverage(rgba.data, size.width, size.height, index => gray[index]);
      if (!owned()) return;
      context.putImageData(rgba, 0, 0); setReady(key);
    }).catch(() => { if (owned()) { setReady(''); setFailed(key); } });
    return () => { alive = false; abort.abort(); };
  }, [key, supported]);
  return <><canvas ref={canvas} hidden={ready !== key || !supported} className="bitmap-selection-overlay canvas-selection" role="img" aria-label="Pixel selection coverage overlay" />{(ready !== key || !supported) && <span className="dense-overlay-status" role="status">{supported && failed !== key ? 'Loading pixel selection coverage…' : 'Pixel selection active; coverage overlay unavailable'}</span>}</>;
}
