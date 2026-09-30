declare module '*smooth-curves.mjs' {
  export const CURVES_INTERPOLATION_POLICY: 'shape-preserving-pchip-v1';
  export const CURVES_INTERPOLATION_MODES: readonly ['linear', 'smooth'];
  export function compileSmoothCurveLookup(points: { x: number; y: number }[]): Uint8Array;
}
