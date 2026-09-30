import { useEffect, useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { command, type BackendId, type Document, type Layer } from './api';

type View = 'composite' | 'source' | 'mask';
type Preview = { data: string; mimeType: string; width: number; height: number; revision: number; sourceWidth?: number; sourceHeight?: number };
type Result = { key: string; preview?: Preview; error?: string };

export function CutoutPreview({ document, layer, preview, backend, enabled, busy, placement }: {
  document: Document; layer?: Layer; preview: string; backend: BackendId; enabled: boolean; busy: boolean;
  placement?: { x: number; y: number; width: number; height: number } | null;
}) {
  const [view, setView] = useState<View>('composite');
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const originalAvailable = enabled && backend === 'native' && Boolean(layer?.sourceAsset);
  const maskAvailable = enabled && backend === 'native' && Boolean(layer?.alphaAsset);
  const activeView = view === 'source' && !originalAvailable || view === 'mask' && !maskAvailable ? 'composite' : view;
  const key = `${backend}:${document.id}:${document.revision}:${layer?.id}:${activeView}:${attempt}`;
  const current = result?.key === key ? result : null;
  useEffect(() => {
    let active = true;
    if (activeView !== 'composite' && layer && backend === 'native') {
      void command<Preview>('native', 'get_layer_preview', { documentId: document.id, layerId: layer.id, view: activeView, maxWidth: 700 })
        .then((value) => {
          if (!active) return;
          if (value.revision !== document.revision) throw new Error('The document changed. Retry to refresh this preview.');
          setResult({ key, preview: value });
        })
        .catch((error) => { if (active) setResult({ key, error: error instanceof Error ? error.message : 'Could not load this preview.' }); });
    }
    return () => { active = false; };
  }, [key, activeView, backend, document.id, document.revision, layer?.id]);
  const image = activeView === 'composite' ? preview : current?.preview ? `data:${current.preview.mimeType};base64,${current.preview.data}` : '';
  const width = activeView === 'composite' ? document.width : current?.preview?.width || layer?.width || document.width;
  const height = activeView === 'composite' ? document.height : current?.preview?.height || layer?.height || document.height;
  const loading = activeView !== 'composite' && !current;
  const description = activeView === 'composite' ? 'Live composite' : activeView === 'source' ? 'Preserved source image' : 'Cutout alpha before layer masks and transforms';
  return <>
    <div className="cutout-preview-views" role="group" aria-label="Cutout preview view">
      {([['composite', 'Composite', true], ['source', 'Original', originalAvailable], ['mask', 'Mask', maskAvailable]] as const).map(([value, label, available]) => <button type="button" key={value} aria-pressed={activeView === value} disabled={!available} title={!available ? value === 'source' ? 'Select a layer with an original source image; an updated native companion is required.' : 'Select a cutout with separate alpha; an updated native companion is required.' : undefined} onClick={() => { setView(value); setAttempt(current => current + 1); }}>{label}</button>)}
    </div>
    <div className="cutout-preview-label"><span>{activeView === 'composite' ? document.name : layer?.name}</span><small>{activeView === 'composite' ? 'LIVE COMPOSITE' : activeView === 'source' ? 'ORIGINAL SOURCE' : 'ALPHA MASK'}</small></div>
    <div className="cutout-preview-checker" aria-busy={loading}><div className="cutout-preview-image" style={{ aspectRatio: `${width}/${height}`, width: `min(100%, ${440 * width / height}px)` }}>
      {image && <img src={image} alt={activeView === 'composite' ? 'Cutout document preview' : activeView === 'source' ? 'Original source image' : 'Cutout alpha mask'} />}
      {activeView === 'composite' && placement && <div className="cutout-placement-box" style={{ left: `${placement.x / document.width * 100}%`, top: `${placement.y / document.height * 100}%`, width: `${placement.width / document.width * 100}%`, height: `${placement.height / document.height * 100}%` }}><span>Placement area</span></div>}
      {(loading || busy && activeView === 'composite') && <span className="cutout-preview-busy" role="status"><LoaderCircle size={16} className="spin" />{loading ? 'Loading preview' : 'Updating canvas'}</span>}
    </div></div>
    {current?.error && <div className="cutout-target-note" role="alert"><span>{current.error}</span><button type="button" className="button mini secondary" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={12} />Retry preview</button></div>}
    <p className="cutout-preview-caption">{description}{(activeView === 'composite' || current?.preview) && <> · {current?.preview?.sourceWidth || width} × {current?.preview?.sourceHeight || height} px</>}</p>
  </>;
}
