import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, CircleAlert, ImagePlus, LoaderCircle, RefreshCw, Send, Sparkles, Square, X } from 'lucide-react';
import { command, hostedSession, type BackendId, type Document, type Layer } from './api';
import { CodexConnect } from './CodexConnect';
import { CodexDisconnect } from './Hosted';
import { CHAT_IMAGE_ACCEPT, inThread, type ChatAttachment, type ChatController, type ChatTurn } from './chat';
import { codexJobPresentation, type GenerationController } from './generation';
import { ChatProgress } from './ChatProgress';
import './chat.css';

function SentAttachment({ attachment, onOpen, disabled }: { attachment: ChatAttachment; onOpen: () => void; disabled: boolean }) {
  const [preview, setPreview] = useState(''), ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let stopped = false; const abort = new AbortController();
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      void (async () => {
        const { document } = await command<{ document: Document }>('native', 'get_document', { documentId: attachment.documentId }, abort.signal);
        const source = document.layers.find(layer => layer.type === 'raster' && layer.sourceAsset);
        if (!source) return;
        const image = await command<{ data: string; mimeType: string }>('native', 'get_layer_preview', { documentId: document.id, layerId: source.id, view: 'source', maxWidth: 160 }, abort.signal);
        if (!stopped) setPreview(`data:${image.mimeType};base64,${image.data}`);
      })().catch(() => { /* Keep the filename usable if the source was removed. */ });
    }, { rootMargin: '100px' });
    if (ref.current) observer.observe(ref.current);
    return () => { stopped = true; abort.abort(); observer.disconnect(); };
  }, [attachment.documentId]);
  return <button ref={ref} type="button" disabled={disabled} className="chat-attachment" aria-label={`Open attachment ${attachment.name}`} title={attachment.name} onClick={onOpen}>{preview ? <img src={preview} alt={attachment.name} /> : <ImagePlus size={24} />}<span>{attachment.name}</span></button>;
}

const labels: Record<ChatTurn['status'], string> = { queued: 'Queued', running: 'Working', succeeded: 'Reply ready', failed: 'Could not finish', cancelled: 'Stopped', interrupted: 'Interrupted' };
export function ChatPanel({ controller, document, documents, layer, backend, busy, generation, onOpenResult, onImageOptions, onOpenImage }: { controller: ChatController; document: Document | null; documents: Document[]; layer?: Layer; backend: BackendId; busy: boolean; generation: GenerationController; onOpenResult: (documentId: string) => Promise<void>; onImageOptions: (jobId?: string) => void; onOpenImage?: () => void }) {
  const { turns: allTurns, draft, setDraft, attachments, addAttachments, removeAttachment, attachmentError, uploading, loading, submitting, unconfirmed, pendingCancel, error, status, available, send, retry, cancel, refresh } = controller;
  const scroller = useRef<HTMLDivElement>(null), nearEnd = useRef(true);
  const [resultError, setResultError] = useState(''), [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null), dragDepth = useRef(0);
  const native = backend === 'native', canSend = native && available && !busy && !submitting && !uploading && !unconfirmed && Boolean(draft.trim() || attachments.length);
  // Show only this canvas's conversation; a new canvas starts with an empty chat.
  const turns = allTurns.filter(turn => inThread(turn, native ? document?.id : undefined));
  const active = allTurns.filter(turn => turn.status === 'queued' || turn.status === 'running');
  const scrollKey = JSON.stringify(turns.map(turn => [turn.id, turn.status, turn.reply, turn.events.length]));
  useEffect(() => { if (nearEnd.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [scrollKey]);
  const submit = () => { if (!canSend) return; nearEnd.current = true; void send({ ...(document?.backend === 'native' ? { documentId: document.id, ...(layer ? { selectedLayerId: layer.id } : {}) } : {}) }); };
  const openResult = async (id: string) => { setResultError(''); try { await onOpenResult(id); } catch (reason) { setResultError(reason instanceof Error ? reason.message : 'The result could not be opened.'); } };
  return <section className="chat-panel" aria-label="Chat with Codex" onDragEnter={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); dragDepth.current++; setDragging(true); } }} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = native ? 'copy' : 'none'; } }} onDragLeave={event => { event.preventDefault(); event.stopPropagation(); if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }} onDrop={event => { event.preventDefault(); event.stopPropagation(); dragDepth.current = 0; setDragging(false); if (native) addAttachments(Array.from(event.dataTransfer.files)); }}>
    <div className="chat-heading"><div><Sparkles size={15} /><strong>Chat with Codex</strong></div><button className="icon-button" aria-label="Refresh chat" onClick={refresh}><RefreshCw size={13} /></button></div>
    <div className="chat-context"><span>{document?.name || 'No document selected'}</span>{native && document && <small>{layer?.name || 'No layer selected'}{document.selection ? ' · Selection active' : ''}</small>}{onOpenImage && <button type="button" disabled={busy} onClick={onOpenImage} aria-label="Open image for chat"><ImagePlus size={12} />Open image</button>}</div>
    <div className="chat-messages" ref={scroller} role="log" aria-label="Chat conversation" aria-live="polite" aria-relevant="additions text" onScroll={() => { const element = scroller.current; if (element) nearEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60; }}>
      {!turns.length && <div className="chat-empty"><Sparkles size={24} /><h2>What would you like to make?</h2><p>Ask for an edit, a new image, or both. Codex works with the selected document and its layers.</p><span>“Warm the colors and add a title.”</span><span>“Create a background and place it behind the subject.”</span></div>}
      {turns.map(turn => <article className="chat-turn" key={turn.id} aria-label={`Request: ${turn.message}`}>
        <div className="chat-user-message"><strong>You</strong><p>{turn.message}</p>{Boolean(turn.attachments?.length) && <div className="chat-sent-attachments">{turn.attachments!.map(attachment => <SentAttachment key={attachment.documentId} attachment={attachment} disabled={busy} onOpen={() => void openResult(attachment.documentId)} />)}</div>}{turn.documentId && <small>{documents.find(item => item.id === turn.documentId)?.name || 'Previous document'}</small>}</div>
        <div className="chat-assistant-message"><div className={`chat-turn-status state-${turn.status}`}>{turn.status === 'running' || turn.status === 'queued' ? <LoaderCircle size={12} className="spin" /> : turn.status === 'succeeded' ? <Check size={12} /> : <CircleAlert size={12} />}<span>{labels[turn.status]}</span>{(turn.status === 'running' || turn.status === 'queued') && <button disabled={pendingCancel === turn.id} onClick={() => void cancel(turn.id)} aria-label={`Stop request: ${turn.message}`}><Square size={10} />{pendingCancel === turn.id ? 'Stopping…' : 'Stop'}</button>}</div>
          {(turn.status === 'queued' || turn.status === 'running') && <ChatProgress key={turn.id} turn={turn} history={allTurns} />}
          {turn.events.length > 0 && <details className="chat-details"><summary>Details</summary><ol className="chat-events" aria-label="Work updates">{turn.events.map((event, index) => <li key={event.id} className={event.status || ''}>{event.status === 'running' && index === turn.events.length - 1 && (turn.status === 'queued' || turn.status === 'running') ? <LoaderCircle size={10} className="spin" /> : event.status === 'failed' ? <CircleAlert size={10} /> : <span className="chat-event-dot" />}<span>{event.label}</span></li>)}</ol></details>}
          {turn.reply && <p className="chat-reply">{turn.reply}</p>}
          {turn.error?.message && <p className="chat-turn-error">{turn.error.message}</p>}
          {(turn.status === 'cancelled' || turn.status === 'interrupted') && <p className="chat-turn-note">This request stopped. Any edits already made remain in the document. It will not restart automatically.</p>}
          {turn.status === 'failed' && <p className="chat-turn-note">No automatic retry was made. Review the document before sending another request.</p>}
          {turn.generationJobIds?.map(id => { const job = generation.jobs.find(item => item.id === id), presentation = job ? codexJobPresentation(job, generation.status?.codexWorker) : null; return <button key={id} className="chat-image-job" onClick={() => onImageOptions(id)}><ImagePlus size={13} /><span>{presentation?.label || (job?.status === 'succeeded' ? 'Image added to workspace' : job?.status === 'ready' ? 'Image ready to review and apply' : job?.status === 'cancelled' ? 'Image request cancelled' : job?.status === 'failed' ? 'Image request failed' : 'View image request')}</span><ArrowUpRight size={12} /></button>; })}
          {turn.resultDocumentId && turn.resultDocumentId !== document?.id && turn.status !== 'queued' && turn.status !== 'running' && <button className="button secondary chat-open-result" disabled={busy} onClick={() => void openResult(turn.resultDocumentId!)}>Open result<ArrowUpRight size={12} /></button>}
        </div>
      </article>)}
    </div>
    <form className={`chat-composer${dragging ? ' dragging' : ''}`} onPaste={event => { const files = Array.from(event.clipboardData.files); if (native && files.length) { event.preventDefault(); event.stopPropagation(); addAttachments(files); } }} onSubmit={event => { event.preventDefault(); submit(); }}>
      {loading ? <p className="chat-availability" role="status">Connecting to local Codex…</p> : !available && (hostedSession() ? <CodexConnect onConnected={refresh} /> : <p className="chat-unavailable" role="status">{status?.message || 'Local Codex chat is unavailable. Check the companion and sign-in, then refresh.'}</p>)}
      {(error || resultError || attachmentError) && <p className="chat-error" role="alert">{resultError || attachmentError || error}</p>}
      {unconfirmed && <div className="chat-delivery" role="status"><p>Delivery is unconfirmed. Refresh the conversation or retry the same message; a duplicate will not be submitted.</p><button type="button" disabled={submitting || !native} onClick={() => void retry()}>Retry same message</button></div>}
      <input ref={fileInput} className="sr-only" type="file" aria-label="Attach images to chat" accept={CHAT_IMAGE_ACCEPT} multiple tabIndex={-1} onChange={event => { if (native) addAttachments(Array.from(event.target.files || [])); event.target.value = ''; }} />
      {attachments.length > 0 && <div className="chat-draft-attachments" aria-label="Attached images">{attachments.map(item => <div className="chat-attachment" key={item.id} title={item.file.name}>{item.file.type === 'image/tiff' || /\.tiff?$/i.test(item.file.name) ? <ImagePlus size={24} /> : <img src={item.preview} alt={item.file.name} />}<span>{item.file.name}</span><button type="button" aria-label={`Remove ${item.file.name}`} disabled={uploading || submitting || unconfirmed} onClick={() => removeAttachment(item.id)}><X size={12} /></button></div>)}</div>}
      {uploading && <p className="chat-availability" role="status">Sending images and message…</p>}
      <label className="sr-only" htmlFor="chat-message">Message Codex</label><textarea id="chat-message" aria-label="Message Codex" placeholder="Describe an edit, or attach images…" value={draft} onChange={event => setDraft(event.target.value)} rows={3} maxLength={16000} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} />
      <div className="chat-composer-actions"><button type="button" className="chat-attach-button" aria-label="Attach images" title="Attach images · PNG, JPEG, WebP, TIFF · up to 8, 20 MB each" disabled={!native || attachments.length >= 8} onClick={() => fileInput.current?.click()}><ImagePlus size={16} /><span>Attach</span></button><span>{active.length ? `${active.length} request${active.length === 1 ? '' : 's'} in progress` : 'Enter to send · Shift+Enter for a new line'}</span><button type="submit" className="button primary" aria-label="Send message to Codex" disabled={!canSend}>{submitting || uploading ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}<span>Send</span></button></div>
      <div className="chat-options"><button type="button" aria-label="Open image generation" onClick={() => onImageOptions()}>Image options{generation.activeCount + generation.waitingCount + generation.readyCount > 0 && <span className="generation-count">{generation.activeCount + generation.waitingCount + generation.readyCount}</span>}</button>{hostedSession() ? <small>Runs through your Codex account.{available && <> <CodexDisconnect onChange={refresh} /></>}</small> : <small>Runs through your local Codex account.</small>}</div>
    </form>
  </section>;
}
