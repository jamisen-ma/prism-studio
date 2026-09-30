/** Local coordinate/session ownership only. No pixels, persistence, randomness or API calls. */
export type ClonePoint = { x: number; y: number };
export type CloneContext = { backend: string; documentId: string; targetLayerId: string; width: number; height: number; revision: number; tool: string; capabilityKey: string; samplingKey: string; available: boolean };
export type CloneTicket = { token: number; epoch: number; context: CloneContext; predecessorRevision: number; firstPoint: ClonePoint; source: ClonePoint; lastPoint: ClonePoint; tentativeOffset: ClonePoint | null; phase: 'drag' | 'pending'; acceptedOwnRevision?: number };
export type CloneSession = { epoch: number; serial: number; aligned: boolean; anchor: ClonePoint | null; offset: ClonePoint | null; context: CloneContext | null; stroke: CloneTicket | null };
export const createCloneSession = (): CloneSession => ({ epoch: 0, serial: 0, aligned: false, anchor: null, offset: null, context: null, stroke: null });
const point = (value: ClonePoint) => ({ x: value.x, y: value.y });
const finitePoint = (value: ClonePoint) => Number.isFinite(value.x) && Number.isFinite(value.y);
const sampledTool = (tool: string) => tool === 'clone' || tool === 'heal';
const sameFrame = (a: CloneContext, b: CloneContext) => a.backend === b.backend && a.documentId === b.documentId && a.targetLayerId === b.targetLayerId && a.width === b.width && a.height === b.height;
const sameSemantics = (a: CloneContext, b: CloneContext) => sameFrame(a, b) && a.tool === b.tool && a.capabilityKey === b.capabilityKey && a.samplingKey === b.samplingKey && a.available === b.available;
function invalidate(session: CloneSession, clearAnchor: boolean) { session.epoch++; session.stroke = null; session.offset = null; if (clearAnchor) session.anchor = null; }

/** Call synchronously with live props before events and result predicates, as well as render. */
export function syncCloneSession(session: CloneSession, context: CloneContext) {
  const previous = session.context;
  if (previous) {
    const semanticChange = !sameSemantics(previous, context);
    const ownRevision = session.stroke?.phase === 'pending' && session.stroke.epoch === session.epoch && session.stroke.acceptedOwnRevision === context.revision;
    if (semanticChange || (previous.revision !== context.revision && !ownRevision)) {
      const mustClear = session.aligned || !sameFrame(previous, context) || previous.samplingKey !== context.samplingKey || Boolean(session.stroke);
      invalidate(session, mustClear);
    }
  }
  session.context = { ...context };
  return session;
}
export function setCloneAnchor(session: CloneSession, anchor: ClonePoint | null) {
  if (anchor && !finitePoint(anchor)) return false;
  invalidate(session, true); session.anchor = anchor ? point(anchor) : null; return true;
}
export function setCloneAligned(session: CloneSession, aligned: boolean) {
  if (session.aligned === aligned) return;
  invalidate(session, false); session.aligned = aligned;
}
export function beginCloneStroke(session: CloneSession, firstPoint: ClonePoint): CloneTicket | null {
  const context = session.context;
  if (session.stroke || !context?.available || !sampledTool(context.tool) || !session.anchor || !finitePoint(firstPoint)) return null;
  const source = session.aligned && session.offset ? { x: firstPoint.x + session.offset.x, y: firstPoint.y + session.offset.y } : point(session.anchor);
  const ticket: CloneTicket = { token: ++session.serial, epoch: session.epoch, context: { ...context }, predecessorRevision: context.revision, firstPoint: point(firstPoint), lastPoint: point(firstPoint), source, tentativeOffset: session.aligned && !session.offset ? { x: session.anchor.x - firstPoint.x, y: session.anchor.y - firstPoint.y } : null, phase: 'drag' };
  session.stroke = ticket; return ticket;
}
export function ownsCloneStroke(session: CloneSession, ticket: CloneTicket) {
  const context = session.context;
  return session.stroke === ticket && session.epoch === ticket.epoch && Boolean(context && sameSemantics(context, ticket.context) && context.available && (context.revision === ticket.predecessorRevision || context.revision === ticket.acceptedOwnRevision));
}
export function submitCloneStroke(session: CloneSession, ticket: CloneTicket) {
  if (!ownsCloneStroke(session, ticket) || ticket.phase !== 'drag') return false;
  ticket.phase = 'pending'; return true;
}
export function cancelCloneStroke(session: CloneSession, ticket: CloneTicket) {
  if (!ownsCloneStroke(session, ticket) || ticket.phase !== 'drag') return false;
  session.stroke = null; return true;
}
/** Reserve this exact response before App publishes its document metadata. */
export function acceptCloneDocument(session: CloneSession, ticket: CloneTicket, result: CloneContext) {
  if (!ownsCloneStroke(session, ticket) || ticket.phase !== 'pending' || ticket.acceptedOwnRevision !== undefined || !sameSemantics(ticket.context, result) || result.revision !== ticket.predecessorRevision + 1) return false;
  ticket.acceptedOwnRevision = result.revision; return true;
}
export function finishCloneStroke(session: CloneSession, ticket: CloneTicket, success: boolean) {
  if (!ownsCloneStroke(session, ticket) || ticket.phase !== 'pending') return false;
  if (!success || ticket.acceptedOwnRevision === undefined || session.context?.revision !== ticket.acceptedOwnRevision) { invalidate(session, true); return true; }
  if (session.aligned && ticket.tentativeOffset) session.offset = point(ticket.tentativeOffset);
  session.stroke = null; return true;
}
export function cloneSampleCenter(session: CloneSession, cursor: ClonePoint | null): ClonePoint | null {
  const ticket = session.stroke;
  if (ticket && ownsCloneStroke(session, ticket)) {
    const destination = ticket.phase === 'pending' ? ticket.lastPoint : cursor;
    return destination ? { x: destination.x + (ticket.source.x - ticket.firstPoint.x), y: destination.y + (ticket.source.y - ticket.firstPoint.y) } : null;
  }
  if (!session.anchor) return null;
  if (session.aligned && session.offset) return cursor ? { x: cursor.x + session.offset.x, y: cursor.y + session.offset.y } : null;
  return point(session.anchor);
}
