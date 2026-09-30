import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { materializeMaskAlpha } from '../server/dense-mask.mjs';
import { colorRangePlaneReference, colorRangePreviewReference, COLOR_RANGE_PHOTO_GOLDENS } from './fixtures/color-range/reference.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const current=(native,doc)=>native.project(doc.id).states[native.project(doc.id).cursor].graph;
const edit=async(native,doc,command,args={})=>(await native.execute(command,{documentId:doc.id,expectedRevision:doc.revision,...args})).document;
const equalBytes=(a,b)=>{assert.equal(a.length,b.length);const i=a.findIndex((v,i)=>v!==b[i]);assert.equal(i,-1,`first differing byte ${i}: ${a[i]} vs ${b[i]}`);};
const selection=(native,doc)=>materializeMaskAlpha(doc.selection,doc.width,doc.height,mask=>native.readDenseMask(mask));
async function fixture(t){const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'prism-range-owner-')),native=await new NativeBackend({dataDir,segmentSubject:()=>assert.fail('No segmentation')}).init();t.after(async()=>{await native.close();await fs.rm(dataDir,{recursive:true,force:true});});return{native,dataDir};}

test('Color Range native photo preview/full output matches independent planes and leaves assets intact',async t=>{
 const{native}=await fixture(t),source=await fs.readFile(new URL('./fixtures/tonal-color/astronaut.png',import.meta.url));let doc=(await native.execute('import_image',{mimeType:'image/png',data:source.toString('base64')})).document;
 const asset=doc.layers[0].asset,workingBefore=await fs.readFile(path.join(native.assetsDir,asset));
 for(const{parameters,sha256}of COLOR_RANGE_PHOTO_GOLDENS){
  const composite=await native.renderGraph(current(native,doc)),expected=colorRangePlaneReference(composite,parameters);assert.equal(sha(expected),sha256);
  const before=JSON.stringify(native.project(doc.id));const preview=await native.execute('get_color_range_preview',{documentId:doc.id,expectedRevision:doc.revision,...parameters,maxEdge:137});
  const reference=colorRangePreviewReference(composite,doc.width,doc.height,parameters,137);equalBytes(await sharp(Buffer.from(preview.data,'base64')).extractChannel(0).raw().toBuffer(),reference.gray);assert.equal(JSON.stringify(native.project(doc.id)),before);
  doc=await edit(native,doc,'load_color_range_selection',parameters);equalBytes(await selection(native,doc),expected);
 }
 equalBytes(await fs.readFile(path.join(native.assetsDir,asset)),workingBefore);
 const caps=await native.execute('capabilities');assert.equal(caps.commands.length,105);assert.equal(caps.colorRangeLimits.maxComparisons,192_000_000);assert.ok(caps.commands.includes('get_color_range_preview'));
});

test('Color Range native snapshots queued read/load and rejects direct/TX accessors before invocation',async t=>{
 const{native}=await fixture(t);let doc=(await native.execute('create_document',{width:4,height:4,background:'#e06942'})).document;
 for(const command of ['get_color_range_preview','load_color_range_selection']){
  let unblock;const blocker=native.enqueue(()=>new Promise(resolve=>{unblock=resolve;}));await new Promise(resolve=>setImmediate(resolve));
  const args={documentId:doc.id,expectedRevision:doc.revision,colors:['#e06942'],tolerance:0,falloff:0},pending=native.execute(command,args);args.colors[0]='#000000';args.invert=true;unblock();await blocker;const result=await pending;
  if(result.document){doc=result.document;equalBytes(await selection(native,doc),Buffer.alloc(16,255));}else{assert.deepEqual(result.colors,['#e06942']);equalBytes(await sharp(Buffer.from(result.data,'base64')).extractChannel(0).raw().toBuffer(),Buffer.alloc(16,255));}
 }
 let getters=0;const before=JSON.stringify(native.project(doc.id));
 for(const method of ['execute','dispatch'])for(const transaction of [false,true]){
  const args={documentId:doc.id,expectedRevision:doc.revision,colors:['#e06942']};Object.defineProperty(args,'falloff',{enumerable:true,get(){getters++;return 32;}});
  const command=transaction?'apply_transaction':'load_color_range_selection',input=transaction?{documentId:doc.id,expectedRevision:doc.revision,label:'Reject getter',operations:[{command:'load_color_range_selection',args}]}:args;
  await assert.rejects(native[method](command,input),{code:'INVALID_ARGUMENTS'});
 }
 assert.equal(getters,0);assert.equal(JSON.stringify(native.project(doc.id)),before);
});

test('Color Range dense selection reuses saved/portable consumers and rolls back new files on persistence failure',async t=>{
 const{native}=await fixture(t),width=512,height=512,alpha=Buffer.from(Uint8Array.from({length:width*height},(_,i)=>(i*71)%256)),rgba=Buffer.alloc(width*height*4);
 for(let i=0;i<alpha.length;i++)rgba.set([80,40,20,alpha[i]],i*4);
 const png=await sharp(rgba,{raw:{width,height,channels:4}}).png().toBuffer();let doc=(await native.execute('import_image',{mimeType:'image/png',data:png.toString('base64')})).document;
 const settings={colors:['#123456'],tolerance:255,falloff:255};doc=await edit(native,doc,'load_color_range_selection',settings);assert.equal(doc.selection.shape,'alpha8');equalBytes(await selection(native,doc),alpha);
 doc=await edit(native,doc,'save_selection',{name:'Exact range'});const saved=structuredClone(doc.selection);
 doc=await edit(native,doc,'clear_selection');doc=await edit(native,doc,'load_selection',{selectionId:doc.savedSelections[0].id});assert.deepEqual(doc.selection,saved);
 const reopened=(await native.importProject({data:(await native.exportProject({documentId:doc.id})).data})).document;equalBytes(await selection(native,reopened),alpha);
 const before=JSON.stringify(native.project(doc.id)),files=(await fs.readdir(native.assetsDir)).sort(),persist=native.persist;native.persist=async()=>{throw Object.assign(new Error('Injected publication error'),{code:'ENOTDIR'});};
 try{await assert.rejects(edit(native,doc,'load_color_range_selection',{...settings,invert:true}),{code:'ENOTDIR'});}finally{native.persist=persist;}
 assert.equal(JSON.stringify(native.project(doc.id)),before);assert.deepEqual((await fs.readdir(native.assetsDir)).sort(),files);equalBytes(await selection(native,doc),alpha);
 await assert.rejects(edit(native,doc,'apply_transaction',{label:'Late range rollback',operations:[{command:'load_color_range_selection',args:{...settings,invert:true}},{command:'set_layer',args:{layerId:'missing',name:'No target'}}]}),{code:'NOT_FOUND'});
 assert.equal(JSON.stringify(native.project(doc.id)),before);assert.deepEqual((await fs.readdir(native.assetsDir)).sort(),files);
});

test('Color Range native all combinations retain continuous geometry and missing-selection refusal',async t=>{
 const{native}=await fixture(t);let doc=(await native.execute('create_document',{width:3,height:3,background:'#ffffff'})).document;
 const settings={colors:['#000000'],tolerance:0,falloff:255};
 for(const mode of ['subtract','intersect']){const old=native.renderGraph;let reads=0;native.renderGraph=async()=>{reads++;throw Error('Unexpected render');};try{await assert.rejects(edit(native,doc,'load_color_range_selection',{...settings,mode}),{code:'NO_SELECTION'});assert.equal(reads,0);}finally{native.renderGraph=old;}}
 for(const mode of ['replace','add','subtract','intersect']){
  doc=await edit(native,doc,'select_rectangle',{x:1,y:1,width:1,height:1,feather:3});
  const before=await native.prepareMaskCoverage(doc.selection),composite=await native.renderGraph(current(native,doc)),candidate=colorRangePlaneReference(composite,{colors:['#bababa'],tolerance:0,falloff:255}),expected=Buffer.alloc(9);
  for(let i=0;i<9;i++){const left=before(i%3,Math.floor(i/3)),right=candidate[i]/255;expected[i]=Math.round(255*(mode==='replace'?right:mode==='add'?Math.max(left,right):mode==='subtract'?left*(1-right):left*right));}
  doc=await edit(native,doc,'load_color_range_selection',{colors:['#bababa'],tolerance:0,falloff:255,mode});equalBytes(await selection(native,doc),expected);
 }
});
