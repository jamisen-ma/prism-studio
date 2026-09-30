import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { applyLayerFilters } from '../server/layer-filters.mjs';

const run=promisify(execFile),byte=v=>Math.max(0,Math.min(255,Math.round(v)));
const reference=(r,g,b,kind,value)=>{
  const tone=(r*.2126+g*.7152+b*.0722)/255;
  const weight=kind==='shadows'?(1-tone)**2:tone**2;
  return [byte(r+value*1.275*weight),byte(g+value*1.275*weight),byte(b+value*1.275*weight)];
};

test('legacy scalar tones match every byte through cold and optimized native loops',async()=>{
  const worker=fileURLToPath(new URL('./fixtures/scalar-tone/cold-worker.mjs',import.meta.url));
  for(let i=0;i<2;i++){
    const result=await run(process.execPath,[worker],{timeout:30_000,maxBuffer:16_384});
    assert.match(result.stdout,/Cold scalar tone bytes match/);assert.equal(result.stderr,'');
  }
});

test('legacy tone dispatch preserves source alpha, hidden RGB, masked opacity and protected global pixels',async()=>{
  const input=Buffer.from([15,31,240,0,20,190,240,1,60,40,10,128,110,190,10,255]),before=Buffer.from(input);
  const mask={shape:'bitmap',x:0,y:0,width:4,height:1,runs:[0,1,255,1,1,128,3,1,255]};
  for(const kind of ['shadows','highlights'])for(const value of [-100,-25,.125,35,100]){
    const global=await NativeBackend.prototype.applyAdjustment.call({},input,4,1,{kind,value,opacity:.375,mask,maskDensity:.5},Uint8Array.from([0,0,0,1]));
    for(let p=0;p<4;p++){
      const i=p*4,adjusted=reference(...input.subarray(i,i+3),kind,value),amount=.375*(.5+.5*[255,128,0,255][p]/255);
      for(let c=0;c<3;c++)assert.equal(global[i+c],p===3?input[i+c]:byte(input[i+c]+(adjusted[c]-input[i+c])*amount));
      assert.equal(global[i+3],input[i+3]);
    }
    const source=await applyLayerFilters(input,4,1,[{id:randomUUID(),kind,value,enabled:true,opacity:.375}]);
    for(let p=0;p<4;p++){
      const i=p*4,adjusted=reference(...input.subarray(i,i+3),kind,value);
      for(let c=0;c<3;c++)assert.equal(source[i+c],input[i+3]?byte(input[i+c]+(adjusted[c]-input[i+c])*.375):input[i+c]);
      assert.equal(source[i+3],input[i+3]);
    }
  }
  assert.deepEqual(input,before);
});

test('unchanged global Shadows then Highlights exports match an independent oracle across unrelated local edits',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'prism-scalar-tone-')),native=await new NativeBackend({dataDir}).init();
  t.after(async()=>{await native.close();await fs.rm(dataDir,{recursive:true,force:true});});
  const width=96,height=72,input=Buffer.alloc(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)input.set([20+x%200,(x+y)%3?190:30,(x+y)%2?10:240,[0,1,128,255,255][(x+y)%5]],4*(y*width+x));
  const png=await sharp(input,{raw:{width,height,channels:4}}).png().toBuffer();
  const create=async()=> (await native.execute('import_image',{data:png.toString('base64'),mimeType:'image/png'})).document;
  let global=await create(),other=await create();
  const edit=async(doc,command,args)=>(await native.execute(command,{documentId:doc.id,expectedRevision:doc.revision,...args})).document;
  global=await edit(global,'add_adjustment',{kind:'shadows',value:35});global=await edit(global,'add_adjustment',{kind:'highlights',value:-25});
  const before=structuredClone(global),expected=Buffer.from(input);
  for(let i=0;i<input.length;i+=4){
    const rgb=input[i+3]?[...input.subarray(i,i+3)]:[0,0,0];
    expected.set(reference(...reference(...rgb,'shadows',35),'highlights',-25),i);
  }
  for(let j=0;j<5;j++){
    const output=await native.execute('export_document',{documentId:global.id,format:'png'});
    const actual=await sharp(Buffer.from(output.data,'base64')).ensureAlpha().raw().toBuffer();
    assert.deepEqual(actual,expected);
    other=await edit(other,'add_layer_filter',{layerId:other.layers[0].id,kind:'shadows_highlights',value:0,parameters:{sigma:j%2?0:Number.MIN_VALUE}});
    const image=await native.execute('export_document',{documentId:other.id,format:'png'});assert.ok(image.data.length);
  }
  assert.deepEqual((await native.execute('get_document',{documentId:global.id})).document,before);
  assert.deepEqual(await fs.readFile(path.join(native.assetsDir,global.layers[0].sourceAsset)),png);
});
