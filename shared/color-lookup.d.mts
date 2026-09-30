export type ColorLookupParameters = {
  asset: string;
  bytes: number;
  gridSize: number;
  inputSpace: 'srgb';
  sourceName: string;
  title?: string;
};
export const COLOR_LOOKUP_POLICY: 'cube3d-f64-trilinear-srgb-v1';
export const COLOR_LOOKUP_FORMATS: readonly ['cube-3d'];
export const COLOR_LOOKUP_INPUT_SPACES: readonly ['srgb'];
export const COLOR_LOOKUP_LIMITS: Readonly<{
  maxBytes: number; minGridSize: number; maxGridSize: number;
  maxLineLength: number; maxNumberLength: number; maxTitleLength: number;
  maxSourceNameLength: number; maxPrepareBytes: number; maxHistoryAssets: number;
  maxHistoryBytes: number; maxTransactionBytes: number; maxWorkingBytes: number;
}>;
export function normalizeColorLookupParameters(value: unknown): ColorLookupParameters;
export function mergeColorLookupParameters(previous: unknown, patch: unknown): ColorLookupParameters;
export function colorLookupBase64Bytes(data: unknown): number;
