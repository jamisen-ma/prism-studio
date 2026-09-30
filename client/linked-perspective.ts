import { linkedPerspectiveCorners } from '../shared/linked-perspective.mjs';
import { parseCorners, type CornerDraft } from './distort-model';

export type PerspectiveAxis = 'horizontal' | 'vertical';
export type CornerMovement = 'free' | PerspectiveAxis;
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

export function parsePerspectiveDelta(text: string, limit = 16384): number | undefined {
  const value = text.trim();
  if (!Number.isInteger(limit) || limit < 1 || limit > 16384 || !decimal.test(value)) return;
  const delta = Number(value);
  if (!Number.isFinite(delta) || Math.abs(delta) > 2 * limit || delta === 0 && /[1-9]/.test(value.split(/e/i)[0])) return;
  return delta;
}

export function perspectiveDeltaPending(text: string, limit = 16384): boolean {
  const delta = parsePerspectiveDelta(text, limit);
  return delta === undefined || delta !== 0;
}

/** Each action evaluates from its original exact string snapshot, never the last move. */
export function linkedPerspectiveDraft(draft: CornerDraft, cornerIndex: number, axis: PerspectiveAxis, delta: number, limit = 16384): CornerDraft | undefined {
  const baseline = parseCorners(draft, limit);
  if (!baseline) return;
  try {
    const { corners } = linkedPerspectiveCorners(baseline, { cornerIndex, axis, delta, limit });
    return corners.map((point, index) => ({
      x: point.x === Number(draft[index].x) ? draft[index].x : String(point.x),
      y: point.y === Number(draft[index].y) ? draft[index].y : String(point.y),
    }));
  } catch { return; }
}
