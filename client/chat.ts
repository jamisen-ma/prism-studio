import { useCallback, useEffect, useRef, useState } from 'react';
import { api, commandWithRequestId, fileBase64, type Document } from './api';

export type ChatAttachment = { documentId: string; name: string };
type DraftAttachment = { id: string; file: File; preview: string; imported?: ChatAttachment };
export const CHAT_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/tiff,.png,.jpg,.jpeg,.webp,.tif,.tiff';
const imageMime = (file: File) => file.type || ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff' }[file.name.split('.').at(-1)?.toLowerCase() || ''] || '');

export type ChatTurn = { id: string; requestId: string; message: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'; createdAt: string; updatedAt: string; reply?: string; error?: { message: string }; events: { id: string; label: string; status?: 'running' | 'succeeded' | 'failed' }[]; documentId?: string; resultDocumentId?: string; generationJobIds?: string[]; attachments?: ChatAttachment[] };
export type ChatStatus = { available: boolean; message?: string; turns: ChatTurn[] };
export type ChatContext = { documentId?: string; selectedLayerId?: string };
type Submission = ChatContext & { message: string; requestId: string; attachments?: ChatAttachment[] };
type PendingSubmission = { payload: Submission; draft: string; attachmentIds: string[] };
/** Each canvas has its own conversation: turns sent from, producing, or attaching this document (mirrors server history). */
export const inThread = (turn: ChatTurn, documentId?: string) => documentId ? turn.documentId === documentId || turn.resultDocumentId === documentId || Boolean(turn.attachments?.some(item => item.documentId === documentId)) : !turn.documentId;
const terminal = (turn: ChatTurn) => !['queued', 'running'].includes(turn.status);
const definiteRefusals = new Set(['INVALID_ARGUMENT', 'INVALID_ARGUMENTS', 'CHAT_UNAVAILABLE', 'QUEUE_FULL', 'LIMIT_EXCEEDED', 'NOT_FOUND', 'INVALID_TARGET']);

/** Conversation and delivery identity live in App, across inspector/tab changes. */
export function useChat({ open, onFinished }: { open: boolean; onFinished: (turn: ChatTurn) => Promise<void> }) {
  const [status, setStatus] = useState<ChatStatus | null>(null), [turns, setTurns] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState(''), draftRef = useRef(draft); draftRef.current = draft;
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]), attachmentsRef = useRef<DraftAttachment[]>([]);
  const [uploading, setUploading] = useState(false), preparing = useRef(false);
  const [attachmentError, setAttachmentError] = useState('');
  const [loading, setLoading] = useState(true), [submitting, setSubmitting] = useState(false), [pendingCancel, setPendingCancel] = useState('');
  const [error, setError] = useState(''), [serviceError, setServiceError] = useState(''), [nonce, setNonce] = useState(0);
  const pending = useRef<PendingSubmission | null>(null), sending = useRef(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const latestTurns = useRef<ChatTurn[]>([]), finished = useRef(onFinished); finished.current = onFinished;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const replaceAttachments = (next: DraftAttachment[]) => { attachmentsRef.current = next; setAttachments(next); };
  useEffect(() => () => { for (const item of attachmentsRef.current) URL.revokeObjectURL(item.preview); }, []);
  const addAttachments = (files: File[]) => {
    const next = [...attachmentsRef.current], errors: string[] = [];
    for (const file of files) {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/tiff'].includes(imageMime(file))) { errors.push(`${file.name}: use PNG, JPEG, WebP, or TIFF.`); continue; }
      if (!file.size || file.size > 20 * 1024 * 1024) { errors.push(`${file.name}: images must be between 1 byte and 20 MB.`); continue; }
      if (next.length >= 8) { errors.push('Attach up to 8 images per message.'); break; }
      next.push({ id: crypto.randomUUID(), file, preview: URL.createObjectURL(file) });
    }
    replaceAttachments(next); setAttachmentError(errors.join(' '));
  };
  const removeAttachment = (id: string) => {
    if (preparing.current || sending.current || pending.current) return;
    const removed = attachmentsRef.current.find(item => item.id === id);
    if (removed) URL.revokeObjectURL(removed.preview);
    replaceAttachments(attachmentsRef.current.filter(item => item.id !== id)); setAttachmentError('');
  };
  const accept = useCallback((incoming: ChatTurn[]) => {
    if (!mounted.current) return;
    const values = new Map(latestTurns.current.map(turn => [turn.id, turn]));
    const latest = incoming.at(-1);
    for (const turn of incoming) {
      const old = values.get(turn.id);
      const ownsPending = pending.current?.payload.requestId === turn.requestId;
      if (old && (terminal(old) && !terminal(turn) || Date.parse(old.updatedAt) > Date.parse(turn.updatedAt))) continue;
      values.set(turn.id, turn);
      const resultChanged = Boolean(turn.resultDocumentId && (!old || old.updatedAt !== turn.updatedAt || old.status !== turn.status || old.resultDocumentId !== turn.resultDocumentId));
      if (resultChanged && (old || ownsPending || turn.id === latest?.id) || terminal(turn) && (old && !terminal(old) || !old && ownsPending)) void finished.current(turn).catch(() => { /* A later progress update can refresh the real result. */ });
      if (pending.current?.payload.requestId === turn.requestId) {
        if (draftRef.current === pending.current.draft) { draftRef.current = ''; setDraft(''); }
        const sentIds = new Set(pending.current.attachmentIds);
        for (const item of attachmentsRef.current) if (sentIds.has(item.id)) URL.revokeObjectURL(item.preview);
        attachmentsRef.current = attachmentsRef.current.filter(item => !sentIds.has(item.id)); setAttachments(attachmentsRef.current);
        pending.current = null; setUnconfirmed(false); setError('');
      }
    }
    const next = [...values.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(-200);
    latestTurns.current = next; setTurns(next);
  }, []);
  useEffect(() => {
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    const poll = async () => {
      try {
        const result = await api<ChatStatus>('/api/chat', undefined, abort.signal);
        if (cancelled) return;
        setStatus(result); accept(result.turns); setLoading(false); setServiceError('');
        timer = setTimeout(poll, result.turns.some(turn => !terminal(turn)) || pending.current ? 1000 : open ? 3000 : 10000);
      } catch (reason) {
        if (cancelled) return;
        setServiceError(reason instanceof Error ? reason.message : 'Chat is unavailable.'); setLoading(false);
        timer = setTimeout(poll, 5000);
      }
    };
    void poll(); return () => { cancelled = true; abort.abort(); clearTimeout(timer); };
  }, [open, nonce, accept]);
  const dispatch = async (submission: PendingSubmission) => {
    if (sending.current) return null;
    sending.current = true; setSubmitting(true); setError(''); pending.current = submission;
    try {
      const result = await api<{ turn: ChatTurn }>('/api/chat', submission.payload);
      if (mounted.current) {
        if (!latestTurns.current.some(turn => turn.id === result.turn.id)) latestTurns.current = [...latestTurns.current, { ...result.turn, status: 'queued' }];
        accept([result.turn]); setNonce(value => value + 1);
      }
      return result.turn;
    } catch (reason) {
      if (mounted.current) {
        const observed = latestTurns.current.find(turn => turn.requestId === submission.payload.requestId);
        if (observed) { accept([observed]); return observed; }
        if (definiteRefusals.has((reason as { code?: string }).code || '')) { pending.current = null; setUnconfirmed(false); }
        else setUnconfirmed(true);
        setError(reason instanceof Error ? reason.message : 'Message delivery could not be confirmed.'); setNonce(value => value + 1);
      }
      return null;
    } finally { sending.current = false; if (mounted.current) setSubmitting(false); }
  };
  const send = async (context: ChatContext) => {
    const text = draftRef.current, images = [...attachmentsRef.current];
    if ((!text.trim() && !images.length) || preparing.current || sending.current || pending.current || !status?.available || serviceError) return null;
    preparing.current = true; setUploading(Boolean(images.length)); setError(''); setAttachmentError('');
    try {
      const imported: ChatAttachment[] = [];
      for (const item of images) {
        if (!item.imported) {
          const result = await commandWithRequestId<{ document: Document }>('native', 'import_image', { name: item.file.name.trim().slice(0, 200) || 'Attached image', data: await fileBase64(item.file), mimeType: imageMime(item.file) }, item.id);
          item.imported = { documentId: result.document.id, name: result.document.name };
        }
        imported.push(item.imported);
      }
      if (!mounted.current) return null;
      return await dispatch({ payload: { message: text.trim() || 'Please inspect the attached images and ask what I would like to do with them.', requestId: crypto.randomUUID(), ...context, ...(imported.length ? { attachments: imported } : {}) }, draft: text, attachmentIds: images.map(item => item.id) });
    } catch (reason) {
      if (mounted.current) setAttachmentError(reason instanceof Error ? `Image upload failed: ${reason.message}` : 'Image upload failed. Your attachments are still here; try sending again.');
      return null;
    } finally { preparing.current = false; if (mounted.current) setUploading(false); }
  };
  const retry = () => pending.current && !sending.current ? dispatch(pending.current) : Promise.resolve(null);
  const cancel = async (id: string) => {
    if (pendingCancel) return;
    setPendingCancel(id); setError('');
    try { const result = await api<{ turn: ChatTurn }>(`/api/chat/${encodeURIComponent(id)}/cancel`, {}); accept([result.turn]); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : 'Stopping could not be confirmed. Refresh the conversation.'); }
    finally { if (mounted.current) { setPendingCancel(''); setNonce(value => value + 1); } }
  };
  return { status, turns, draft, setDraft, attachments, addAttachments, removeAttachment, attachmentError, uploading, loading, submitting, pendingCancel, unconfirmed, error: error || serviceError, available: Boolean(status?.available && !serviceError), send, retry, cancel, refresh: () => setNonce(value => value + 1) };
}
export type ChatController = ReturnType<typeof useChat>;
