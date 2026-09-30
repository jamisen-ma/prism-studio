import { useEffect, useRef, useState } from 'react';
import { Check, Expand, Link2, Maximize, SquareDashed } from 'lucide-react';
import { isPositionedMask, type Backend, type Document } from './api';
import type { RunCommand } from './CanvasTools';
import { captureGesture } from './gesture';
import { RESIZE_LABELS, resizeMethods, type ResizeMethodChoice } from './resize-methods';
import './resize.css';

type Anchor = 'top-left' | 'top' | 'top-right' | 'left' | 'center' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right';
const ANCHORS: Anchor[] = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'];
export type ResizeDraft = { mode: 'scale' | 'canvas'; width: string; height: string; method: ResizeMethodChoice; anchor: Anchor; selectPadding: boolean };

export function ResizePanel({ document, backend, preview, canResizeCanvas, busy, run, onComplete, captureCapabilityGuard, initialMode = 'scale', initialDraft, onReviewMask }: { document: Document; backend?: Backend; preview: string; canResizeCanvas: boolean; busy: boolean; run: RunCommand; onComplete: (result: Document) => void; captureCapabilityGuard: (mode: 'scale' | 'canvas') => () => boolean; initialMode?: 'scale' | 'canvas'; initialDraft?: ResizeDraft; onReviewMask?: (layerId: string, draft: ResizeDraft) => void }) {
  const capability = resizeMethods(backend, document.backend);
  const [mode, setMode] = useState<'scale' | 'canvas'>((initialDraft?.mode || initialMode) === 'canvas' && canResizeCanvas && document.backend === 'native' ? 'canvas' : 'scale');
  const [widthText, setWidth] = useState(initialDraft?.width ?? String(document.width)), [heightText, setHeight] = useState(initialDraft?.height ?? String(document.height));
  const [method, setMethod] = useState<ResizeMethodChoice>(initialDraft?.method ?? capability.initial);
  const [anchor, setAnchor] = useState<Anchor>(initialDraft?.anchor ?? 'center');
  const [selectPadding, setSelectPadding] = useState(initialDraft?.selectPadding ?? true);
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const draftKey = JSON.stringify([mode, widthText, heightText, ...(mode === 'scale' ? [method] : [anchor, selectPadding])]);
  const draftRef = useRef(draftKey); draftRef.current = draftKey;
  const width = Number(widthText), height = Number(heightText);
  const positioned = document.layers.filter(layer => isPositionedMask(layer.mask));
  const blocked = mode === 'scale' && positioned.length > 0;
  const grows = width > document.width || height > document.height;
  const valid = widthText.trim() !== '' && heightText.trim() !== '' && Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && width <= 8192 && height <= 8192 && width * height <= 24000000;
  const methodValid = capability.supported && (capability.explicit ? capability.methods.includes(method as never) : method === 'legacy');
  const factorX = anchor.includes('left') ? 0 : anchor.includes('right') ? 1 : .5;
  const factorY = anchor.includes('top') ? 0 : anchor.includes('bottom') ? 1 : .5;
  const offsetX = Math.floor((width - document.width) * factorX), offsetY = Math.floor((height - document.height) * factorY);
  const changed = width !== document.width || height !== document.height;
  const unavailable = capability.explicit && method !== '' && method !== 'legacy' && !capability.methods.includes(method);
  return <>
    <span className="eyebrow">ROOM TO CHANGE</span><h1 id="modal-title">Resize your canvas.</h1>
    <p className="modal-intro">{mode === 'scale' ? 'Scale your image and layers to a new size. This edit can be undone.' : 'Change the canvas bounds while preserving the size of your original pixels.'}</p>
    {document.backend === 'native' && <div className="resize-mode-tabs" role="group" aria-label="Resize method"><button disabled={busy} className={mode === 'scale' ? 'selected' : ''} onClick={() => setMode('scale')}><Maximize size={14} />Scale image</button><button className={mode === 'canvas' ? 'selected' : ''} disabled={busy || !canResizeCanvas} title={!canResizeCanvas ? 'Canvas bounds require an updated native companion.' : undefined} onClick={() => setMode('canvas')}><Expand size={14} />Canvas bounds</button></div>}
    <form onSubmit={event => {
      event.preventDefault(); if (busy || !valid || !changed || blocked || (mode === 'scale' ? !methodValid : !canResizeCanvas)) return;
      const submittedDraft = draftKey;
      const context = { ...captureGesture(document), scope: 'document' as const, resize: { sourceWidth: document.width, sourceHeight: document.height, width, height }, isCurrent: captureCapabilityGuard(mode) };
      void run(mode === 'scale' ? 'resize_document' : 'resize_canvas', { width, height, ...(mode === 'canvas' ? { anchor, ...(grows && selectPadding ? { selectPadding: true } : {}) } : method !== 'legacy' && method !== '' ? { resample: method } : {}) }, mode === 'scale' ? 'Scaling image' : 'Changing canvas bounds', context).then(result => { if (result?.document && alive.current && draftRef.current === submittedDraft) onComplete(result.document); });
    }}>
      <div className="form-grid"><label className="field-label">Width, px<input autoFocus required disabled={busy} type="number" min="1" max="8192" value={widthText} onChange={event => setWidth(event.target.value)} /></label><label className="field-label">Height, px<input required disabled={busy} type="number" min="1" max="8192" value={heightText} onChange={event => setHeight(event.target.value)} /></label></div>
      {mode === 'scale' ? <>
        <button className="text-button aspect-button" type="button" disabled={busy || widthText.trim() === '' || !Number.isInteger(width) || width < 1 || width > 8192} onClick={() => setHeight(String(Math.round(width * document.height / document.width)))}><Link2 size={13} />Match original aspect ratio</button>
        {capability.explicit && <label className="field-label resize-resampling">Resampling method<select aria-label="Resampling method" value={method === 'legacy' ? '' : method} disabled={busy || capability.methods.length === 0 || !capability.supported} onChange={event => setMethod(event.target.value as ResizeMethodChoice)}><option value="" disabled>Choose a supported method</option>{unavailable && <option value={method} disabled>{RESIZE_LABELS[method]} · unavailable</option>}{capability.methods.map(item => <option value={item} key={item}>{RESIZE_LABELS[item]}{backend?.documentResizeDefault === item ? ' · companion default' : ''}</option>)}</select></label>}
        {capability.explicit && capability.methods.length === 0 && <p className="inline-panel-error resize-error">This companion advertises no supported image resampling methods. Update or reconnect the companion to scale an image. Canvas bounds remain available separately.</p>}
        {unavailable && <p className="inline-panel-error resize-error">Your chosen resampling method is no longer available. Choose a supported method before applying.</p>}
        {!capability.explicit && method !== 'legacy' && <div className="resize-method-fallback"><p>The companion no longer advertises resampling choices. Your chosen method has not been replaced.</p><button type="button" className="button mini subtle" disabled={busy || !capability.supported} onClick={() => setMethod('legacy')}>Use companion default</button></div>}
        {!capability.supported && <p className="inline-panel-error resize-error">This companion does not currently support image scaling.</p>}
        {capability.explicit && capability.methods.length > 0 && <div className="resize-method-help"><p>{method === 'nearest' ? 'Keeps hard pixel edges by copying sampled colors and transparency at this resize step. Reduction can skip small details.' : 'Cubic, Mitchell and Lanczos 3 use different reduction filters. Enlargement uses cubic interpolation for all three; mixed-axis resizing combines reduction with enlargement.'}</p><p>Applies to rendered layer content. Masks and selections keep their existing resize rules.</p></div>}
        {blocked && <section className="resize-mask-review" aria-label="Positioned masks to review"><strong>Review positioned masks before scaling</strong><p>Rasterize each retained mask position in Layers first. This converts its current canvas coverage to 8-bit pixels and discards off-canvas coverage. Your dimensions and method stay here; scaling will not run automatically.</p><ul>{positioned.map(layer => <li key={layer.id}><span>{layer.name}</span>{onReviewMask && <button className="button mini subtle" type="button" disabled={busy} aria-label={`Review mask on ${layer.name}`} onClick={() => onReviewMask(layer.id, { mode, width: widthText, height: heightText, method, anchor, selectPadding })}>Review mask</button>}</li>)}</ul></section>}
      </> : <>
        <div className="canvas-anchor-section"><div><span className="resize-control-label">KEEP THIS EDGE IN PLACE</span><div className="canvas-anchor-grid" role="group" aria-label="Canvas anchor">{ANCHORS.map(item => <button type="button" disabled={busy} aria-label={`Anchor ${item.replaceAll('-', ' ')}`} aria-pressed={anchor === item} className={anchor === item ? 'selected' : ''} key={item} onClick={() => setAnchor(item)}><span /></button>)}</div><span className="canvas-anchor-name">{anchor.replaceAll('-', ' ')}</span></div><div className="canvas-bounds-preview">{valid && <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Preview of canvas bounds and original image position"><image href={preview} x={offsetX} y={offsetY} width={document.width} height={document.height} preserveAspectRatio="none" /><rect x={0} y={0} width={width} height={height} fill="none" stroke="#cfb0e3" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>}<span>{valid ? `${width} × ${height}` : 'Enter valid dimensions'}</span></div></div>
        <label className={`canvas-padding-check ${!grows ? 'inactive' : ''}`}><input aria-label="Select added space for AI fill" type="checkbox" checked={selectPadding && grows} disabled={busy || !grows} onChange={event => setSelectPadding(event.target.checked)} /><SquareDashed size={15} /><span>Select added space for AI fill</span></label>
        <p className="canvas-resize-note">{grows ? 'Added space is transparent. The original image stays at its current scale; use Selection fill in Generate to extend the scene.' : 'Smaller bounds crop the visible canvas. Undo restores the previous bounds and pixels.'}</p>
        {positioned.length > 0 && <p className="mask-position-notice">Canvas bounds clip retained mask coverage to the old and new canvas extents, including hidden masks. Added space has no mask coverage. Moving the mask later cannot recover clipped coverage; Undo restores it.</p>}
      </>}
      {!valid && <p className="inline-panel-error resize-error">Use dimensions from 1–8,192 px, up to 24 million pixels total.</p>}
      <button className="button primary wide" disabled={busy || !valid || !changed || blocked || (mode === 'canvas' ? !canResizeCanvas : !methodValid)} type="submit">{mode === 'canvas' ? <Check size={15} /> : <Maximize size={15} />}{mode === 'canvas' ? 'Apply canvas bounds' : 'Apply dimensions'}</button>
    </form>
  </>;
}
