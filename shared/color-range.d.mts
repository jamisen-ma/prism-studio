export interface ColorRangeSettings { colors: string[]; tolerance: number; falloff: number; invert: boolean; }
export interface ColorRangeSettingsInput { colors: readonly string[]; tolerance?: number; falloff?: number; invert?: boolean; }
export const COLOR_RANGE_POLICY: 'sampled-rgb-chebyshev-alpha-v1';
export const COLOR_RANGE_LIMITS: Readonly<{ maxColors: 8; maxTolerance: 255; maxFalloff: 255; maxComparisons: 192000000; comparisonBatch: 65536; }>;
export const COLOR_RANGE_PREVIEW_LIMITS: Readonly<{ minEdge: 32; maxEdge: 2400; defaultMaxEdge: 700; maxBytes: 8388608; maxWorkingBytes: 268435456; }>;
export function normalizeColorRangeSettings(value: unknown): ColorRangeSettings;
