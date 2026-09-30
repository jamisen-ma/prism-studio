import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { NativeBackend } from '../../../server/native.mjs';
import { encodeDenseMaskFrame } from '../../../server/dense-mask.mjs';
import { adjustmentTransform } from '../../../server/color.mjs';
const png=await fs.readFile(new URL('../tonal-color/astronaut.png',import.meta.url)),input=await sharp(png).ensureAlpha().raw().toBuffer();
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dense-invert-worker-')),native=await new NativeBackend({dataDir:dir}).init(),mask=Buffer.alloc(input.length/4),protection=new Uint8Array(mask.length),digest=createHash('sha256');
for(let i=0;i<mask.length;i++){mask[i]=Math.round((2126*input[i*4]+7152*input[i*4+1]+722*input[i*4+2])/10000);if(i%97===0)protection[i]=1;}
const {frame,descriptor}=await encodeDenseMaskFrame(mask,512,512);await native.storeAsset(frame);
try{for(const value of [100,37,100,0,63,100])for(const masked of [false,true]){
 const fn=adjustmentTransform({kind:'invert',value}),layer={kind:'invert',value,opacity:masked?.73:1,...(masked?{mask:descriptor}: {})};
 const actual=await native.applyAdjustment(input,512,512,layer,protection);
 for(let p=0;p<mask.length;p++){const offset=p*4,rgb=fn(input[offset],input[offset+1],input[offset+2]);for(let c=0;c<3;c++){
 const old=input[offset+c],candidate=Math.max(0,Math.min(255,Math.round(old+(255-2*old)*value/100))),amount=layer.opacity*(masked?mask[p]/255:1),expected=protection[p]?old:Math.round(old+(candidate-old)*amount);
 assert.equal(rgb[c],candidate,`scalar ${value}/${p}/${c}`);assert.equal(actual[offset+c],expected,`global ${value}/${masked}/${p}/${c}`);
 }assert.equal(actual[offset+3],input[offset+3]);}digest.update(actual);
}console.log(digest.digest('hex'));}finally{await native.close();await fs.rm(dir,{recursive:true,force:true});}
