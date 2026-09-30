export type DenseMaskDescriptor = {
  shape: 'alpha8';
  asset: string;
  bytes: number;
  width: number;
  height: number;
  x: 0;
  y: 0;
  feather: number;
  invert: boolean;
};
export type ChannelSelectionChannel = 'red' | 'green' | 'blue' | 'luma' | 'alpha';
export const DENSE_MASK_POLICY: 'framed-raw-alpha8-v1';
export const DENSE_MASK_LIMITS: Readonly<{
  headerBytes: number;
  maxDimension: number;
  maxPixels: number;
  maxWorkingBytes: number;
  maxPrepareWork: number;
  maxHistoryAssets: number;
  maxHistoryBytes: number;
  yieldVisits: number;
}>;
export const CHANNEL_SELECTION_POLICY: 'composite-byte-alpha-v1';
export const CHANNEL_SELECTION_CHANNELS: readonly ['red', 'green', 'blue', 'luma', 'alpha'];
export const CHANNEL_PREVIEW_LIMITS: Readonly<{
  maxEdge: number;
  defaultMaxEdge: number;
  maxBytes: number;
  maxWorkingBytes: number;
  yieldVisits: number;
}>;
export function normalizeDenseMaskDescriptor(value: unknown, options?: { persisted?: boolean }): DenseMaskDescriptor;
