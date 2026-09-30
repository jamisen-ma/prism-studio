import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { GenerationManager } from '../server/generation.mjs';
import { maskCoverage } from '../server/masks.mjs';

async function fixture(t){const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'prism-canvas-native-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));return {dataDir,native:await new NativeBackend({dataDir:path.join(dataDir,'native')}).init()};}
async function pixels(native,id){return native.render(native.project(id));}
function at(bytes,width,x,y){return [...bytes.subarray((y*width+x)*4,(y*width+x)*4+4)];}
test('canvas expansion preserves layered feathered pixels, source assets and source geometry through reopen/undo',async t=>{
  const {native,dataDir}=await fixture(t);
  let {document}=await native.execute('create_document',{width:12,height:12,background:'#3d6793'});
  ({document}=await native.execute('add_adjustment',{documentId:document.id,kind:'brightness',value:73,mask:{shape:'ellipse',x:1,y:1,width:10,height:10,feather:1.2}}));
  const before=await pixels(native,document.id),originalLayer=document.layers[0];
  ({document}=await native.execute('resize_canvas',{documentId:document.id,expectedRevision:document.revision,width:20,height:18,anchor:'center'}));
  assert.equal(document.layers[0].id,originalLayer.id);assert.equal(document.layers[0].width,12);
  const expanded=await pixels(native,document.id);
  for(let y=0;y<18;y++)for(let x=0;x<20;x++)assert.deepEqual(at(expanded,20,x,y),x>=4&&x<16&&y>=3&&y<15?at(before,12,x-4,y-3):[0,0,0,0],`pixel${x},${y}`);
  const reopened=await new NativeBackend({dataDir:path.join(dataDir,'native')}).init();
  assert.equal((await pixels(reopened,document.id)).equals(expanded),true);
  await reopened.execute('undo',{documentId:document.id});assert.equal((await pixels(reopened,document.id)).equals(before),true);
  await reopened.execute('redo',{documentId:document.id});assert.equal((await pixels(reopened,document.id)).equals(expanded),true);
});
test('outpainting selects only added space and hard-clips a disobedient provider around exact original pixels',async t=>{
  const {native,dataDir}=await fixture(t);
  let {document}=await native.execute('create_document',{width:8,height:6,background:'#714325'});
  const original=await pixels(native,document.id);
  ({document}=await native.execute('resize_canvas',{documentId:document.id,width:16,height:12,anchor:'bottom-right',selectPadding:true}));
  const coverage=maskCoverage(document.selection);
  assert.equal(coverage(0,0),1);assert.equal(coverage(7,5),1);assert.equal(coverage(8,6),0);assert.equal(coverage(15,11),0);
  let calls=0;
  const output=await sharp({create:{width:16,height:12,channels:4,background:'#00ff00'}}).png().toBuffer();
  const manager=await new GenerationManager({dataDir,native,getKey:async()=> 'test-key',provider:async({image,mask})=>{
    calls++;assert.ok(Buffer.isBuffer(image));const rgba=await sharp(mask).ensureAlpha().raw().toBuffer();assert.equal(at(rgba,16,8,6)[3],255);assert.equal(at(rgba,16,0,0)[3],0);return {data:output,mimeType:'image/png'};
  }}).init();t.after(()=>manager.close());
  const {job}=await manager.start({provider:'openai',mode:'edit',prompt:'Fill only the newly added background',scope:'selection',documentId:document.id,expectedRevision:document.revision,requestId:'outpaint-once'});
  for(let i=0;i<200;i++){const current=manager.get(job.id).job;if(current.status==='succeeded'||current.error||['failed','cancelled'].includes(current.status))break;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal(manager.get(job.id).job.status,'succeeded',JSON.stringify(manager.get(job.id).job.error));assert.equal(calls,1);
  const edited=await pixels(native,document.id);
  for(let y=0;y<12;y++)for(let x=0;x<16;x++)assert.deepEqual(at(edited,16,x,y),x>=8&&y>=6?at(original,8,x-8,y-6):[0,255,0,255]);
  await native.execute('undo',{documentId:document.id});assert.deepEqual(at(await pixels(native,document.id),16,0,0),[0,0,0,0]);
  await native.execute('undo',{documentId:document.id});assert.equal((await pixels(native,document.id)).equals(original),true);
});
test('canvas crop, clipping, repeated expansion and transaction rollback preserve mask semantics',async t=>{
  const {native}=await fixture(t);
  let {document}=await native.execute('create_document',{width:10,height:10,background:'#aabbcc'});
  ({document}=await native.execute('select_region',{documentId:document.id,shape:'ellipse',x:1,y:1,width:8,height:8,feather:2.2,invert:true}));
  const source=maskCoverage(document.selection);
  ({document}=await native.execute('resize_canvas',{documentId:document.id,width:6,height:6,anchor:'center'}));
  ({document}=await native.execute('resize_canvas',{documentId:document.id,width:12,height:12,anchor:'center'}));
  const current=maskCoverage(document.selection);
  for(let y=0;y<12;y++)for(let x=0;x<12;x++)assert.equal(current(x,y),x>=3&&x<9&&y>=3&&y<9?source(x-1,y-1):0);
  const before=await pixels(native,document.id),revision=document.revision;
  await assert.rejects(native.execute('apply_transaction',{documentId:document.id,label:'Invalid expansion',operations:[{command:'resize_canvas',args:{width:20,height:20}},{command:'resize_canvas',args:{width:2,height:2,selectPadding:true}}]}));
  document=(await native.execute('get_document',{documentId:document.id})).document;
  assert.equal(document.revision,revision);assert.equal(document.width,12);assert.equal((await pixels(native,document.id)).equals(before),true);
});
