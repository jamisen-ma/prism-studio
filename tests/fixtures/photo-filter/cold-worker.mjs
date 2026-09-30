import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { photoFilterTransform } from '../../../server/photo-filter.mjs';
import { PHOTO_FILTER_GOLDENS } from './reference.mjs';
const compiled=PHOTO_FILTER_GOLDENS.map(f=>photoFilterTransform(f.parameters)),hash=createHash('sha256');
for(let pass=0;pass<10000;pass++)for(let i=0;i<compiled.length;i++){
  const output=compiled[i](...PHOTO_FILTER_GOLDENS[i].rgb);assert.deepEqual(output,PHOTO_FILTER_GOLDENS[i].expected);hash.update(Buffer.from(output));
}
console.log(hash.digest('hex'));
