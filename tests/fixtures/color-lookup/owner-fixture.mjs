import { createHash } from 'node:crypto';
import { authoredCube } from './reference.mjs';
import { prepareColorLookup } from '../../../server/color-lookup.mjs';
export const lookupBytes = authoredCube('gentle-crosscolor');
export const lookupParameters = Object.freeze({ asset: createHash('sha256').update(lookupBytes).digest('hex'), bytes: lookupBytes.length, gridSize: 2, inputSpace: 'srgb', sourceName: 'gentle.cube', title: 'Prism authored gentle-crosscolor' });
export const lookupOptions = { prepareColorLookup: parameters => prepareColorLookup(parameters, async () => Buffer.from(lookupBytes)) };
