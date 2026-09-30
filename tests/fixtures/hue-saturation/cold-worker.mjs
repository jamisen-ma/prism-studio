import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {hueSaturationTransform} from '../../../server/hue-saturation.mjs';
const fixtures=[
 [[224,1,127],{reds:[0,-100,0]},[176,49,121]],[[224,127,1],{reds:[0,-100,0]},[176,121,49]],
 [[32,0,0],{reds:[0,-100,0]},[16,16,16]],[[255,223,223],{reds:[0,-100,0]},[239,239,239]],
 [[128,127,127],{reds:[0,0,10]},[128,127,127]],[[128,127,127],{master:[0,30,0]},[128,127,127]],
 [[127,127,127],{master:[180,100,0]},[127,127,127]],[[255,0,0],{master:[120,0,0]},[0,255,0]],
 [[255,0,0],{master:[180,0,0],reds:[180,0,0]},[255,0,0]],
 [[200,100,100],{master:[0,0,100]},[255,255,255]],[[200,100,100],{master:[0,0,-100]},[0,0,0]]
];
const compiled=fixtures.map(([,p])=>hueSaturationTransform(p)),hash=createHash('sha256');
for(let pass=0;pass<20000;pass++)for(let j=0;j<fixtures.length;j++){const output=compiled[j](...fixtures[j][0]);assert.deepEqual(output,fixtures[j][2]);hash.update(Buffer.from(output));}
console.log(hash.digest('hex'));
