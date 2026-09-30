import assert from 'node:assert/strict';
import { NativeBackend } from '../../../server/native.mjs';

// Fresh process, ordinary optimized runtime. The expected byte calculation is
// independent of the production transform dispatcher and Array.map closure.
const width=1024,height=512,input=Buffer.alloc(width*height*4),protectedPixels=new Uint8Array(width*height);
for(let y=0;y<height;y++)for(let x=0;x<width;x++)input.set([20+x%200,(x+y)%3?190:30,(x+y)%2?10:240,[0,1,128,255,255][(x+y)%5]],4*(y*width+x));
const clamp=value=>Math.max(0,Math.min(255,Math.round(value)));
for(const [kind,value] of [['shadows',35],['highlights',-25],['shadows',-.25],['highlights',33.125],['shadows',100],['highlights',-100],['shadows',35]]){
  const actual=await NativeBackend.prototype.applyAdjustment.call({},input,width,height,{kind,value,opacity:1},protectedPixels);
  for(let i=0;i<input.length;i+=4){
    const tone=(input[i]*.2126+input[i+1]*.7152+input[i+2]*.0722)/255;
    const weight=kind==='shadows'?(1-tone)**2:tone**2;
    for(let c=0;c<3;c++)assert.equal(actual[i+c],clamp(input[i+c]+value*1.275*weight),`${kind} ${value}, byte ${i+c}`);
    assert.equal(actual[i+3],input[i+3]);
  }
  await new Promise(resolve=>setImmediate(resolve));
}
console.log('Cold scalar tone bytes match.');
