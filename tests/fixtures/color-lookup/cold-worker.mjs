import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseColorLookupBytes } from '../../../server/color-lookup.mjs';
import { authoredCube, authoredLookupNativeOrder } from './reference.mjs';
const digest=createHash('sha256');
for(const name of['identity','gain-half','rgb-cycle','cross-products','gentle-crosscolor']){
 const {transform}=await parseColorLookupBytes(authoredCube(name,{gridSize:33}));
 for(let i=0;i<65536;i++){const rgb=[i%256,(i*37>>>8)%256,(i*131>>>8)%256],actual=transform(...rgb);assert.deepEqual(actual,authoredLookupNativeOrder(name,rgb,33));digest.update(Buffer.from(actual));}
}
console.log(digest.digest('hex'));
