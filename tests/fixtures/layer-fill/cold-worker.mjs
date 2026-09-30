import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../../../server/native.mjs';
import { setLayerFillOpacity } from '../../../server/layer-fill.mjs';
import { encodeDenseMaskFrame } from '../../../server/dense-mask.mjs';
const input=await sharp(await fs.readFile(new URL('../tonal-color/astronaut.png',import.meta.url))).ensureAlpha().raw().toBuffer();
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'prism-fill-cold-')),n=await new NativeBackend({dataDir:dir}).init(),digest=createHash('sha256');
try {
 const asset=await n.storeAsset(await sharp(input,{raw:{width:512,height:512,channels:4}}).png().toBuffer());
 const alpha=Buffer.from(Uint8Array.from({length:512*512},(_,i)=>(i*37)%256)),encoded=await encodeDenseMaskFrame(alpha,512,512);await n.storeAsset(encoded.frame);
 const layer={id:randomUUID(),name:'Cold photo',type:'raster',asset,sourceAsset:asset,sourceFormat:'png',width:512,height:512,visible:true,opacity:.73,blendMode:'normal',transforms:[]};
 for(const fill of [.375,0,.5,1])for(const masked of [false,true]){
  const actual=await n.renderGraph({name:'Cold photo',width:512,height:512,selection:null,layers:[setLayerFillOpacity({...layer,...(masked?{mask:encoded.descriptor}:{})},fill)]});
  const opacity=fill===1?.73:.73*fill;
  for(let p=0;p<alpha.length;p++){
   const coverage=masked?alpha[p]/255:1,amount=input[4*p+3]/255*opacity*coverage,expectedAlpha=Math.round(amount*255);
   if(actual[4*p+3]!==expectedAlpha)throw Error(`alpha ${fill}/${masked}/${p}: ${actual[4*p+3]} != ${expectedAlpha}`);
   for(let c=0;c<3;c++){const expected=amount===0?0:input[4*p+c];if(actual[4*p+c]!==expected)throw Error(`rgb ${fill}/${masked}/${p}/${c}: ${actual[4*p+c]} != ${expected}`);}
  }
  digest.update(actual);
 }
 console.log(digest.digest('hex'));
}finally{await n.close();await fs.rm(dir,{recursive:true,force:true});}
