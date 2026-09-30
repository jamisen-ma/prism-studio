import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {adjustmentTransform,normalizeParameters} from '../../../server/color.mjs';
import {CURVES_BANK_NAMES} from '../../../shared/curves-banks.mjs';
const hash=createHash('sha256'),configurations=[];
for(const points of [[{x:0,y:255},{x:255,y:.49999999999999994}],[{x:0,y:255},{x:Number.MIN_VALUE,y:0},{x:.1,y:80},{x:.10000000000000002,y:120},{x:255,y:255}],[{x:0,y:0},{x:85,y:255},{x:170,y:0},{x:255,y:255}]])for(const channel of ['rgb','red','green','blue'])for(const interpolation of ['linear','smooth']){
 const single=normalizeParameters('curves',{points,channel,interpolation}),banks=normalizeParameters('curves',{mode:'banks',banks:{[channel==='rgb'?'master':channel]:{points,interpolation}}});
 configurations.push([adjustmentTransform({kind:'curves',value:0,parameters:single}),adjustmentTransform({kind:'curves',value:0,parameters:banks})]);
}
for(let pass=0;pass<128;pass++)for(const [single,banks]of configurations)for(let i=0;i<256;i++){const input=[i,(i*37+13)%256,(i*101+25)%256],expected=single(...input),actual=banks(...input);assert.deepEqual(actual,expected);hash.update(Buffer.from(actual));}
console.log(JSON.stringify({configurations:configurations.length,bytes:configurations.length*128*256*3,sha256:hash.digest('hex')}));
