import type { Backend, BackendId, DocumentResizeMethod } from './api';

export type ResizeMethodChoice = DocumentResizeMethod | 'legacy' | '';
export const RESIZE_METHODS: DocumentResizeMethod[] = ['nearest', 'cubic', 'mitchell', 'lanczos3'];
export const RESIZE_LABELS: Record<DocumentResizeMethod, string> = { nearest: 'Nearest neighbor · pixel art', cubic: 'Cubic', mitchell: 'Mitchell', lanczos3: 'Lanczos 3' };
export function resizeMethods(backend: Backend | undefined, id: BackendId) {
  const explicit = id === 'native' && backend?.documentResizeMethods !== undefined;
  const methods = explicit && Array.isArray(backend?.documentResizeMethods) && backend.documentResizeMethods.every(method => typeof method === 'string') ? RESIZE_METHODS.filter(method => backend.documentResizeMethods!.includes(method)) : [];
  const advertisedDefault = backend?.documentResizeDefault;
  const initial: ResizeMethodChoice = !explicit ? 'legacy' : methods.includes(advertisedDefault as DocumentResizeMethod) ? advertisedDefault! : '';
  return { explicit, methods, initial, supported: Boolean(backend?.connected && backend.id === id && backend.commands.includes('resize_document')) };
}
export function resizeCapabilityKey(backend: Backend | undefined, id: BackendId, mode: 'scale' | 'canvas') {
  const available = Boolean(backend?.id === id && backend.connected && backend.commands.includes(mode === 'scale' ? 'resize_document' : 'resize_canvas'));
  if (mode === 'canvas' || id !== 'native') return JSON.stringify([id, mode, available]);
  const { explicit, methods } = resizeMethods(backend, id);
  return JSON.stringify([id, mode, available, explicit, methods, backend?.documentResizeDefault ?? null]);
}
