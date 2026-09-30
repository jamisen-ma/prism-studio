import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import { Check, CornerUpLeft, RotateCcw, Trash2, X } from 'lucide-react';
import type { Backend, Document, Layer } from './api';
import type { RunCommand } from './CanvasTools';
import { captureGesture } from './gesture';
import { CORNER_NAMES, cornerDraft, distortCapabilityKey, distortFrame, distortResultMatches, distortSupport, isDistortStage, parseCorners, rectangleCorners, type CornerDraft, type Corners } from './distort-model';
import { linkedPerspectiveDraft, parsePerspectiveDelta, perspectiveDeltaPending, type CornerMovement } from './linked-perspective';
import './distort.css';

type Session = { epoch: number; document: Document; layerId: string; index: number | 'new'; draft: CornerDraft; tool: string; movement: CornerMovement; pairCorner: number; delta: string };
type Drag = { epoch: number; pointerId: number; element: HTMLButtonElement; corner: number; movement: CornerMovement; context: string; capKey: string; revision: number; limit: number; startX: number; startY: number; before: CornerDraft; rect: { left: number; top: number; width: number; height: number }; width: number; height: number };
type Props = { document: Document | null; layer?: Layer; capabilities?: Backend; busy: boolean; run: RunCommand; tool: string; visible: boolean; viewKey: string; imageRef: RefObject<HTMLDivElement | null>; canBegin: () => boolean; notify: (message: string, error?: boolean) => void };

export function useDistort({ document, layer, capabilities, busy, run, tool, visible, viewKey, imageRef, canBegin, notify }: Props) {
  const [session, publish] = useState<Session | null>(null), sessionRef = useRef(session), epoch = useRef(0), [dragging, setDragging] = useState(false), drag = useRef<Drag | null>(null);
  const cornerInputs = useRef<(HTMLInputElement | null)[]>([]), deltaInput = useRef<HTMLInputElement | null>(null);
  const capKey = distortCapabilityKey(capabilities), context = `${document?.backend}:${document?.id}:${layer?.id}:${tool}:${visible}`;
  const live = useRef({ context, capKey, document, layer, busy, visible }); live.current = { context, capKey, document, layer, busy, visible };
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; const pointer = drag.current; drag.current = null; if (pointer?.element.hasPointerCapture(pointer.pointerId)) pointer.element.releasePointerCapture(pointer.pointerId); }; }, []);
  const setSession = (next: Session | null) => { sessionRef.current = next; publish(next); };
  const cancelDrag = (restore = true) => { const prior = drag.current; drag.current = null; setDragging(false); if (prior && restore && sessionRef.current?.epoch === prior.epoch) setSession({ ...sessionRef.current, draft: prior.before }); if (prior?.element.hasPointerCapture(prior.pointerId)) prior.element.releasePointerCapture(prior.pointerId); };
  const close = () => { epoch.current++; cancelDrag(false); setSession(null); };
  const targetMatches = Boolean(session && document && layer && document.backend === session.document.backend && document.id === session.document.id && layer.id === session.layerId && tool === session.tool && visible);
  const active = Boolean(session && targetMatches);
  useEffect(() => { if (sessionRef.current && !targetMatches) close(); }, [context]);
  useEffect(() => { cancelDrag(); if (sessionRef.current) setSession({ ...sessionRef.current, epoch: ++epoch.current }); }, [capKey]);
  useEffect(() => { cancelDrag(); }, [viewKey, document?.revision]);
  useEffect(() => { if (busy) cancelDrag(); }, [busy]);
  useEffect(() => { const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && drag.current) { event.preventDefault(); cancelDrag(); } }; window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape); }, []);
  const begin = (index?: number | 'new', discardDelta = false) => {
    if (!document || !layer) return;
    if (!discardDelta && sessionRef.current && perspectiveDeltaPending(sessionRef.current.delta, distortSupport(capabilities, layer).limit)) { notify('Move the pair or clear its pending delta before choosing another stage.', true); return; }
    if (!canBegin()) { notify('Finish or cancel the current canvas gesture before opening a distortion stage.', true); return; }
    cancelDrag(false); const transforms = layer.transforms || [], chosen = index ?? transforms.reduce((last, stage, index) => isDistortStage(stage) ? index : last, -1), nextIndex = chosen === -1 ? 'new' : chosen;
    const frame = distortFrame(layer, nextIndex), stage = nextIndex === 'new' ? undefined : transforms[nextIndex];
    if (nextIndex !== 'new' && (!stage || !isDistortStage(stage))) return;
    setSession({ epoch: ++epoch.current, document, layerId: layer.id, index: nextIndex, draft: cornerDraft(stage && isDistortStage(stage) ? stage.corners : rectangleCorners(frame.width, frame.height)), tool, movement: 'free', pairCorner: 0, delta: '0' });
  };
  const support = distortSupport(capabilities, layer), savedLayer = session?.document.layers.find(item => item.id === session.layerId), frame = savedLayer && session ? distortFrame(savedLayer, session.index) : { width: 0, height: 0 };
  const stale = Boolean(active && document?.revision !== session?.document.revision), parsed = session ? parseCorners(session.draft, support.limit) : undefined;
  const delta = session ? parsePerspectiveDelta(session.delta, support.limit) : undefined, pendingDelta = Boolean(session && perspectiveDeltaPending(session.delta, support.limit));
  // Keep captured handles mounted while a drag leaves the authoring range. The
  // invalid finite draft remains visible until release; Apply still rejects it.
  const guidePoints = parsed || (drag.current && session ? session.draft.map(point => ({ x: Number(point.x), y: Number(point.y) })) as Corners : undefined);
  const selected = session?.index === 'new' ? undefined : savedLayer?.transforms?.[session?.index ?? -1];
  const dirty = session?.index === 'new' || !parsed || JSON.stringify(parsed) !== JSON.stringify(selected?.corners);
  const editable = Boolean(active && support.policy && (session?.index === 'new' ? support.add : support.update) && !layer?.protected && !stale);
  const handles = Boolean(editable && savedLayer && session && (session.index === 'new' || session.index === (savedLayer.transforms?.length || 0) - 1));
  const change = (draft: CornerDraft) => { if (sessionRef.current && !busy && !drag.current) setSession({ ...sessionRef.current, draft }); };
  const reset = () => { if (sessionRef.current && editable && !busy && !drag.current) setSession({ ...sessionRef.current, draft: cornerDraft(rectangleCorners(frame.width, frame.height)), delta: '0' }); };
  const reload = () => { const saved = sessionRef.current; if (!saved || !layer || busy || drag.current) return; const oldLayer = saved.document.layers.find(item => item.id === saved.layerId); begin(JSON.stringify(oldLayer?.transforms) === JSON.stringify(layer.transforms) ? saved.index : 'new', true); };
  const setMovement = (movement: CornerMovement) => { const saved = sessionRef.current; if (!saved || !editable || live.current.busy || drag.current || perspectiveDeltaPending(saved.delta, support.limit) || !['free', 'horizontal', 'vertical'].includes(movement)) return; setSession({ ...saved, movement }); };
  const setPairCorner = (pairCorner: number) => { const saved = sessionRef.current; if (!saved || !editable || live.current.busy || drag.current || perspectiveDeltaPending(saved.delta, support.limit) || !Number.isInteger(pairCorner) || pairCorner < 0 || pairCorner > 3) return; setSession({ ...saved, pairCorner }); };
  const setDelta = (delta: string) => { if (sessionRef.current && editable && !live.current.busy && !drag.current) setSession({ ...sessionRef.current, delta }); };
  const clearDelta = () => { if (sessionRef.current && !live.current.busy && !drag.current) setSession({ ...sessionRef.current, delta: '0' }); };
  const movePair = () => {
    const saved = sessionRef.current;
    if (!saved || !editable || live.current.busy || drag.current || saved.movement === 'free') return;
    const amount = parsePerspectiveDelta(saved.delta, support.limit);
    if (amount === undefined || amount === 0) return;
    const draft = linkedPerspectiveDraft(saved.draft, saved.pairCorner, saved.movement, amount, support.limit);
    if (draft) setSession({ ...saved, draft, delta: '0' });
  };
  const submit = async (remove = false) => {
    const captured = sessionRef.current; if (!captured || !active || busy || drag.current || stale || layer?.protected || (remove ? captured.index === 'new' || !support.remove : !editable || !parsed || !dirty || perspectiveDeltaPending(captured.delta, support.limit))) return;
    const capturedContext = context, capturedCaps = capKey, capturedEpoch = captured.epoch;
    const owned = () => alive.current && epoch.current === capturedEpoch && sessionRef.current?.epoch === capturedEpoch && live.current.context === capturedContext && live.current.capKey === capturedCaps;
    const contextArgs = { ...captureGesture(captured.document, captured.layerId), isCurrent: owned, distort: { acceptDocument: (next: Document) => {
      if (!owned() || !distortResultMatches(captured.document, captured.layerId, captured.index, remove ? undefined : parsed, next)) return false;
      const nextLayer = next.layers.find(item => item.id === captured.layerId)!; const transforms = nextLayer.transforms || [];
      const index = remove ? transforms.reduce((last, stage, index) => isDistortStage(stage) ? index : last, -1) : captured.index === 'new' ? transforms.length - 1 : captured.index;
      const chosen = index === -1 ? 'new' : index, nextFrame = distortFrame(nextLayer, chosen), stage = chosen === 'new' ? undefined : transforms[chosen];
      setSession({ ...captured, document: next, index: chosen, draft: cornerDraft(stage && isDistortStage(stage) ? stage.corners : rectangleCorners(nextFrame.width, nextFrame.height)), ...(remove ? { movement: 'free' as const, pairCorner: 0, delta: '0' } : {}) });
      return true;
    } } };
    await run(remove ? 'delete_layer_distort' : captured.index === 'new' ? 'add_layer_distort' : 'update_layer_distort', { layerId: captured.layerId, ...(captured.index === 'new' ? {} : { transformIndex: captured.index }), ...(remove ? {} : { corners: parsed }) }, remove ? 'Removing distortion' : 'Applying distortion', contextArgs);
  };
  const geometryChanged = (current: Drag) => { const rect = imageRef.current?.getBoundingClientRect(); return !rect || (['left', 'top', 'width', 'height'] as const).some(key => Math.abs(rect[key] - current.rect[key]) > 0.01); };
  const down = (event: PointerEvent<HTMLButtonElement>, corner: number) => {
    event.stopPropagation(); if (!handles || busy || drag.current || event.button !== 0 || !sessionRef.current || !imageRef.current || !parsed || perspectiveDeltaPending(sessionRef.current.delta, support.limit)) return;
    const rect = imageRef.current.getBoundingClientRect(); if (!(rect.width > 0 && rect.height > 0)) return;
    drag.current = { epoch: sessionRef.current.epoch, pointerId: event.pointerId, element: event.currentTarget, corner, movement: sessionRef.current.movement, context, capKey, revision: sessionRef.current.document.revision, limit: support.limit, startX: event.clientX, startY: event.clientY, before: structuredClone(sessionRef.current.draft), rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, width: frame.width, height: frame.height };
    setDragging(true); event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault();
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation(); const current = drag.current; if (!current || current.pointerId !== event.pointerId || current.epoch !== sessionRef.current?.epoch) return;
    if (live.current.busy || live.current.context !== current.context || live.current.capKey !== current.capKey || live.current.document?.revision !== current.revision || sessionRef.current.movement !== current.movement) { cancelDrag(); return; }
    if (geometryChanged(current)) { cancelDrag(); notify('Corner drag cancelled because the canvas view changed. Your previous draft is restored.', true); return; }
    let draft: CornerDraft | undefined;
    if (current.movement === 'free') {
      draft = structuredClone(current.before); draft[current.corner] = { x: event.clientX === current.startX ? current.before[current.corner].x : String(Number(current.before[current.corner].x) + (event.clientX - current.startX) / current.rect.width * current.width), y: event.clientY === current.startY ? current.before[current.corner].y : String(Number(current.before[current.corner].y) + (event.clientY - current.startY) / current.rect.height * current.height) };
    } else {
      const amount = current.movement === 'horizontal' ? (event.clientX - current.startX) / current.rect.width * current.width : (event.clientY - current.startY) / current.rect.height * current.height;
      draft = linkedPerspectiveDraft(current.before, current.corner, current.movement, amount, current.limit);
      if (!draft) { cancelDrag(); notify('Perspective drag cancelled because its movement exceeded the supported range. Your previous draft is restored.', true); return; }
    }
    setSession({ ...sessionRef.current, draft });
  };
  const up = (event: PointerEvent<HTMLButtonElement>) => { event.stopPropagation(); if (drag.current?.pointerId !== event.pointerId) return; move(event); cancelDrag(false); };
  const cancel = (event: PointerEvent<HTMLButtonElement>) => { event.stopPropagation(); if (drag.current?.pointerId === event.pointerId) cancelDrag(); };
  const focusCorner = (index: number) => {
    if (!handles || busy || drag.current || !sessionRef.current) return;
    if (sessionRef.current.movement === 'free') cornerInputs.current[index]?.focus();
    else { if (!perspectiveDeltaPending(sessionRef.current.delta, support.limit)) setPairCorner(index); deltaInput.current?.focus(); }
  };
  return { cornerInputs, deltaInput, focusCorner, active, canBegin, available: Boolean(layer && ((layer.transforms || []).some(isDistortStage) || support.add || support.update || support.remove)), session, begin, close, frame, support, stale, parsed, guidePoints, dirty, editable, handles, change, reset, reload, submit, dragging, down, move, up, cancel, busy, layer, document, delta, pendingDelta, setMovement, setPairCorner, setDelta, clearDelta, movePair };
}

type Controller = ReturnType<typeof useDistort>;
export function DistortPanel({ control }: { control: Controller }) {
  const c = control, session = c.session; if (!c.available || !c.layer) return null;
  if (!c.active || !session) return <div className="panel-section distort-entry"><button className="button secondary wide" disabled={!c.canBegin()} onClick={() => c.begin()}><CornerUpLeft size={13} />Distort layer</button></div>;
  const stages = (session.document.layers.find(item => item.id === session.layerId)?.transforms || []).map((stage, index) => ({ stage, index })).filter(item => isDistortStage(item.stage));
  return <section className="panel-section distort-panel" aria-label="Layer distortion"><div className="section-heading"><span>Distort layer</span><button className="icon-button" aria-label="Close distortion editor" onClick={c.close}><X size={14} /></button></div>
    <div className="distort-stages" role="group" aria-label="Retained distortion stages">{stages.map(({ stage, index }, ordinal) => <button key={index} aria-pressed={session.index === index} onClick={() => c.begin(index)} disabled={c.dragging || c.stale || c.pendingDelta}><strong>Distort {ordinal + 1}</strong><span>Stage {index + 1} · {String(stage.width)} × {String(stage.height)} px</span></button>)}<button disabled={!c.support.add || c.busy || c.dragging || c.stale || c.pendingDelta || Boolean(c.layer.protected)} aria-pressed={session.index === 'new'} onClick={() => c.begin('new')}>New distortion</button></div>
    <h3>{session.index === 'new' ? 'New distortion' : `${c.support.update ? 'Edit' : 'Read-only'} stage ${session.index + 1}`}</h3><p className="property-hint">Stage coordinates, px · fixed {c.frame.width} × {c.frame.height} frame. Pixels outside this frame are clipped.</p>
    {c.stale && <p role="alert" className="inline-panel-error">The document changed. This draft keeps its original stage and revision. Reload current geometry to discard this draft and rebuild the stage list. If geometry changed, choose a saved stage again.</p>}
    {!c.support.policy && <p className="inline-panel-error">This companion does not advertise the required Distort policy, coordinates, content type and limits. Saved coordinates remain readable.</p>}
    {session.index !== 'new' && c.support.policy && !c.support.update && <p className="property-hint distort-readonly">This companion cannot update saved distortion stages. Coordinates are read-only.{c.support.remove ? ' Remove remains available under its separate protection and revision checks.' : ''}</p>}
    {c.layer.protected && <p className="inline-panel-error">Unprotect this layer before adding, changing or removing a distortion.</p>}
    <label className="field-label distort-movement">Corner movement<select aria-label="Corner movement" value={session.movement} disabled={!c.editable || c.busy || c.dragging || c.pendingDelta} onChange={event => c.setMovement(event.target.value as CornerMovement)}><option value="free">Free corners</option><option value="horizontal">Horizontal perspective</option><option value="vertical">Vertical perspective</option></select></label>
    {session.movement !== 'free' && <section className="perspective-pair" aria-label="Linked perspective movement">
      <div className="perspective-pair-fields"><label>Selected corner<select aria-label="Perspective selected corner" value={session.pairCorner} disabled={!c.editable || c.busy || c.dragging || c.pendingDelta} onChange={event => c.setPairCorner(Number(event.target.value))}>{CORNER_NAMES.map((name, index) => <option key={name} value={index}>{name}</option>)}</select></label><label>Delta {session.movement === 'horizontal' ? 'X' : 'Y'}, px<input ref={c.deltaInput} aria-label="Perspective delta pixels" aria-describedby="perspective-pair-description" aria-invalid={c.delta === undefined} type="text" inputMode="decimal" value={session.delta} disabled={!c.editable || c.busy || c.dragging} onChange={event => c.setDelta(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); c.movePair(); } }} /></label></div>
      <p id="perspective-pair-description" className="property-hint">{CORNER_NAMES[session.pairCorner]} ↔ {CORNER_NAMES[session.movement === 'horizontal' ? session.pairCorner ^ 1 : 3 - session.pairCorner]} · opposite {session.movement === 'horizontal' ? 'X' : 'Y'} movement. Changes the draft only.</p>
      <div className="distort-draft-actions"><button className="button mini secondary" disabled={!c.editable || c.busy || c.dragging || !c.parsed || c.delta === undefined || c.delta === 0} onClick={c.movePair}>Move pair</button>{c.pendingDelta && <button className="button mini subtle" disabled={c.busy || c.dragging} onClick={c.clearDelta}>Clear delta</button>}</div>
      {c.delta === undefined && <p role="status" className="inline-panel-error">Enter a finite delta from −{(2 * c.support.limit).toLocaleString()} to {(2 * c.support.limit).toLocaleString()} px. Values are not rounded or clamped.</p>}
      {c.pendingDelta && <p role="status" className="property-hint">Move the pair or clear its delta before applying or choosing another movement, corner or stage.</p>}
      <p className="property-hint">Perspective links drags and Move pair. The eight coordinate fields below always edit independently.</p>
    </section>}
    <div className="distort-fields">{session.draft.map((point, index) => <div key={index} className="distort-corner"><strong>{CORNER_NAMES[index]}</strong>{(['x', 'y'] as const).map(axis => <label key={axis}>{axis.toUpperCase()}<input ref={element => { if (axis === 'x') c.cornerInputs.current[index] = element; }} aria-label={`${CORNER_NAMES[index]} distortion ${axis.toUpperCase()}`} type="number" step="any" min={-c.support.limit} max={c.support.limit} value={point[axis]} disabled={!c.editable || c.busy || c.dragging} onChange={event => c.change(session.draft.map((value, pointIndex) => pointIndex === index ? { ...value, [axis]: event.target.value } : value))} /></label>)}</div>)}</div>
    {!c.parsed && <p className="inline-panel-error">Enter four finite X/Y pairs between −{c.support.limit.toLocaleString()} and {c.support.limit.toLocaleString()}. Corners are never rounded or clamped.</p>}
    <div className="distort-draft-actions"><button className="button mini subtle" disabled={!c.editable || c.busy || c.dragging} onClick={c.reset}><RotateCcw size={12} />Reset rectangle</button><button className="button mini subtle" disabled={c.busy || c.dragging} onClick={c.reload}>{c.stale ? 'Reload current geometry' : 'Revert draft'}</button></div>
    {session.index !== 'new' && session.index !== (session.document.layers.find(item => item.id === session.layerId)?.transforms?.length || 0) - 1 && <p className="property-hint">This stage precedes later geometry. Edit its stage coordinates numerically; canvas handles are available for the final stage.</p>}
    {c.handles && <p className="property-hint">Draft guide · pixels update on Apply. Drag a corner or type exact coordinates. Off-frame handles remain editable numerically.</p>}
    <button className="button primary wide" disabled={!c.editable || c.busy || c.dragging || !c.parsed || !c.dirty || c.pendingDelta} onClick={() => void c.submit()}><Check size={13} />Apply distortion</button>
    {session.index !== 'new' && <><button className="button subtle wide" disabled={c.busy || c.dragging || c.stale || Boolean(c.layer.protected) || !c.support.remove} onClick={() => void c.submit(true)}><Trash2 size={13} />Remove saved distortion</button><p className="property-hint">Remove uses the saved stage and discards this draft. Undo restores it.</p></>}
    <details className="distort-help"><summary>How Distort works</summary><p>Four corners map the stage’s pixel edges, clockwise from top left. The output frame stays fixed. Convexity, stability and resource limits are checked by the native editor; rejected drafts remain editable.</p><p>Horizontal perspective moves the selected corner and its left/right partner in opposite X directions. Vertical perspective uses its top/bottom partner and Y. These are stage axes, even for a skewed or rotated quad. Direct coordinate fields stay independent. Move pair and drags change only the local draft; Apply saves the displayed corners. Movement modes are not saved with the stage.</p><p>The guide does not warp the preview. Apply saves editable geometry; original image bytes remain intact. Revisiting this stage can recover its own clipped content, but cannot undo clipping by earlier crop or canvas stages.</p><p>Source filters and their effect mask run first. The additional layer mask, selection and guides stay in document coordinates. Capturing a selection into a source filter mask is unavailable while Distort is retained.</p><p>General perspective uses native bilinear sampling, without a Photoshop pixel-parity promise. Identity and integer translation preserve copied RGBA exactly. Reset rectangle retains a stage; Remove deletes it. Explicit rasterization or pixel editing can consume retained geometry.</p></details>
  </section>;
}
export function DistortOverlay({ control }: { control: Controller }) {
  const c = control; if (!c.active || !c.handles || !c.guidePoints || !c.document) return null;
  return <div className="distort-overlay" aria-label="Distortion draft guide"><svg viewBox={`0 0 ${c.frame.width} ${c.frame.height}`} preserveAspectRatio="none" aria-hidden="true"><rect x="0" y="0" width={c.frame.width} height={c.frame.height} /><polygon points={c.guidePoints.map(point => `${point.x},${point.y}`).join(' ')} /></svg><span className="distort-guide-label">Draft guide · pixels update on Apply</span>{c.guidePoints.map((point, index) => <button key={index} aria-label={`Drag ${CORNER_NAMES[index].toLowerCase()} distortion corner`} title={`${CORNER_NAMES[index]} · ${point.x}, ${point.y}`} disabled={c.busy} style={{ left: `${point.x / c.frame.width * 100}%`, top: `${point.y / c.frame.height * 100}%` }} onClick={event => { event.stopPropagation(); if (event.detail === 0) c.focusCorner(index); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); }} onKeyUp={event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); }} onPointerDown={event => c.down(event, index)} onPointerMove={c.move} onPointerUp={c.up} onPointerCancel={c.cancel} onLostPointerCapture={c.cancel}>{index + 1}</button>)}</div>;
}
