import { BLEND_MODES } from './blend-modes.mjs';

// Filter blending changes RGB while preserving source alpha. Dissolve is a
// separate coverage operation and is deliberately absent from this contract.
export const LAYER_FILTER_BLEND_MODES = Object.freeze(BLEND_MODES.filter(mode => mode !== 'dissolve'));
export const LAYER_FILTER_BLEND_POLICY = 'candidate-rgb-v1';
