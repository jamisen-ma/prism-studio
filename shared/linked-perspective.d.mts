export type PerspectiveAxis = 'horizontal' | 'vertical';
export interface PerspectivePoint { x: number; y: number; }
export type PerspectiveCorners = [PerspectivePoint, PerspectivePoint, PerspectivePoint, PerspectivePoint];
export interface LinkedPerspectiveOptions {
  cornerIndex: number;
  axis: PerspectiveAxis;
  delta: number;
  limit?: number;
}
export interface LinkedPerspectiveResult {
  corners: PerspectiveCorners;
  partnerIndex: number;
  withinBounds: boolean;
}
export const LINKED_PERSPECTIVE_AXES: readonly ['horizontal', 'vertical'];
export function perspectivePartner(cornerIndex: number, axis: PerspectiveAxis): number;
export function linkedPerspectiveCorners(baseline: readonly Readonly<PerspectivePoint>[], options: Readonly<LinkedPerspectiveOptions>): LinkedPerspectiveResult;
