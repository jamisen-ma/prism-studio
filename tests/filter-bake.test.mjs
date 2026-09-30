import { lookupBytes, lookupParameters, lookupOptions } from './fixtures/color-lookup/owner-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { applyLayerFilters, LAYER_FILTER_KINDS, normalizeLayerFilterParameters } from '../server/layer-filters.mjs';
import { FILTER_BAKE_LIMITS, estimateFilterBakeBytes, planFilterBake, bakeFilterSource, encodeBakedPng } from '../server/filter-bake.mjs';
import { openBoundedFile, readBoundedHandle } from '../server/bounded-file.mjs';
import { combineAlpha } from '../server/cutout-pixels.mjs';

const coded=code=>cause=>cause.code===code;
const hash=data=>createHash('sha256').update(data).digest('hex');
const edit=async(native,doc,command,args={})=>(await native.execute(command,{documentId:doc.id,expectedRevision:doc.revision,...(command==='apply_transaction'?{label:'Bake transaction'}:{}),...args})).document;
const get=async(native,doc)=>(await native.execute('get_document',{documentId:doc.id})).document;
const graphOf=(native,doc)=>structuredClone(native.project(doc.id).states[native.project(doc.id).cursor].graph);
const render=(native,doc)=>native.render(native.project(doc.id));
const png=(data,width,height,channels=4)=>sharp(data,{raw:{width,height,channels}}).png({palette:false}).toBuffer();
const entry=(kind,value=0,parameters,other={})=>({id:randomUUID(),kind,value,parameters:normalizeLayerFilterParameters(kind,parameters),enabled:true,opacity:1,...other});
const brush=layerId=>({tool:'brush',layerId,points:[{x:2.5,y:1.5}],size:1,hardness:1,opacity:1,color:'#fe0311'});
async function fixture(t,{alpha=false,filters=[entry('invert',100)]}={}) {
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'prism-filter-bake-'));
  const native=await new NativeBackend({dataDir}).init();t.after(async()=>{await native.close();await fs.rm(dataDir,{recursive:true,force:true});});
  const width=7,height=5, pixels=Buffer.alloc(width*height*4),cutout=Buffer.alloc(width*height);
  for(let p=0;p<width*height;p++){pixels.set([10+p*5%230,40+p*3%170,180-p*4%140,[255,128,1,0][p%4]],p*4);cutout[p]=[0,1,128,255,193][p%5];}
  const original=await png(pixels,width,height);
  let doc=(await native.execute('import_image',{data:original.toString('base64'),mimeType:'image/png',name:'Bake source'})).document;
  const graph=graphOf(native,doc);graph.layers[0].filters=filters;
  if(alpha) graph.layers[0].alphaAsset=await native.storeAlpha(cutout,width,height);
  doc=(await native.commit(native.project(doc.id),graph,'Filter fixture')).document;
  return {native,doc,dataDir,width,height,pixels,cutout,original};
}

test('source RGB baking retains separate alpha, original bytes and exact current full composite through groups, masks, styles and geometry',async t=>{
  const {native,doc:start,pixels,cutout,original}=await fixture(t,{alpha:true,filters:[entry('brightness',17),entry('mosaic',3),entry('color_balance',0,{shadows:[-11,2,17],midtones:[8,-3,2]}),entry('invert',100,undefined,{opacity:.37})]});
  const id=start.layers[0].id;let doc=await edit(native,start,'set_layer_mask',{layerId:id,mask:{shape:'ellipse',x:.2,y:.1,width:5.7,height:3.8,feather:1,invert:true}});
  doc=await edit(native,doc,'modify_layer_mask',{layerId:id,density:.5});doc=await edit(native,doc,'set_layer_mask_position',{layerId:id,x:1,y:-1});
  doc=await edit(native,doc,'set_layer_effects',{layerId:id,effects:{shadow:{color:'#aa3322',blur:1,x:1,y:1,opacity:.6}}});
  doc=await edit(native,doc,'transform_layer',{layerId:id,x:.25,y:-.3,scaleX:1.2,scaleY:.9,rotation:17});
  doc=await edit(native,doc,'group_layers',{layerIds:[id],name:'Backdrop group'});const group=doc.layers[0].id;
  doc=await edit(native,doc,'set_group_compositing',{layerId:group,mode:'isolated',blendMode:'screen'});doc=await edit(native,doc,'set_layer',{layerId:group,opacity:.75});
  doc=await edit(native,doc,'set_layer_mask',{layerId:group,mask:{shape:'rectangle',x:0,y:0,width:6,height:4,feather:.3}});
  const before=doc,prior=before.layers.find(l=>l.id===id),composite=await render(native,doc),filterPixels=await applyLayerFilters(combineAlpha(pixels,cutout),7,5,prior.filters);
  doc=await edit(native,doc,'bake_layer_filters',{layerId:id});const baked=doc.layers.find(l=>l.id===id);
  assert.deepEqual(await render(native,doc),composite);assert.deepEqual({...baked,asset:prior.asset,filters:prior.filters},prior);assert.deepEqual(baked.filters,[]);
  const decoded=await sharp(await fs.readFile(path.join(native.assetsDir,baked.asset))).ensureAlpha().raw().toBuffer();
  for(let p=0;p<cutout.length;p++){assert.equal(decoded[p*4+3],pixels[p*4+3]);assert.deepEqual(decoded.subarray(p*4,p*4+3),filterPixels.subarray(p*4,p*4+3));}
  assert.deepEqual(combineAlpha(decoded,cutout),filterPixels);assert.deepEqual(await fs.readFile(path.join(native.assetsDir,baked.sourceAsset)),original);
  assert.equal(baked.alphaAsset,prior.alphaAsset);assert.deepEqual(await native.readAlpha(baked.alphaAsset,7,5),cutout);
  assert.equal(doc.revision,before.revision+1);assert.equal(doc.history.length,before.history.length+1);
  doc=await edit(native,doc,'undo');assert.deepEqual(doc.layers,before.layers);doc=await edit(native,doc,'redo');assert.deepEqual(await render(native,doc),composite);
});

test('all 32 source filters bake through the production encoder with alpha-weighted source sampling and unchanged hidden RGB',async t=>{
  const {native,doc,pixels,cutout,dataDir}=await fixture(t,{alpha:true});
  const values={exposure:1.25,brightness:14,contrast:-17,saturation:36,temperature:23,vibrance:31,hue:57,highlights:22,shadows:-15,invert:100,grayscale:73,sepia:64,posterize:7,threshold:97,median:3,mosaic:3};
  const parameters={color_lookup:lookupParameters,hue_saturation:{master:[17.25,-13.37,5],reds:[-28.25,26.51,8.75]},selective_color:{method:'absolute',reds:[-8,2,10,-2],blacks:[8,2,-8,0]},shadows_highlights:{shadows:35.37,highlights:26.51,shadowWidth:69.33,highlightWidth:75.11,sigma:.3977},add_noise:{amount:17.35,distribution:'gaussian',monochromatic:false,seed:4294967295},unsharp_mask:{amount:37,sigma:.528474,threshold:3},color_balance:{shadows:[-7,2,14],midtones:[11,-3,8]},black_white:{tint:true,tintColor:'#ee7733',tintAmount:79.25},levels:{gamma:1.4},curves:{points:[{x:0,y:0},{x:117,y:183},{x:255,y:255}]}};
  await native.storeAsset(lookupBytes);
  const effective=combineAlpha(pixels,cutout);
  for(const kind of LAYER_FILTER_KINDS){const filters=[entry(kind,values[kind]??0,parameters[kind],{opacity:.37})];
    const expected=await applyLayerFilters(effective,7,5,filters,lookupOptions),{data}=await bakeFilterSource({layer:doc.layers[0],filters,assetsDir:native.assetsDir,tempRoot:dataDir,prepareColorLookup:lookupOptions.prepareColorLookup});
    const output=data?await sharp(data).ensureAlpha().raw().toBuffer():pixels;
    assert.deepEqual(combineAlpha(output,cutout),expected,kind);
    for(let p=0;p<cutout.length;p++){assert.equal(output[p*4+3],pixels[p*4+3]);if(!effective[p*4+3])assert.deepEqual(output.subarray(p*4,p*4+3),pixels.subarray(p*4,p*4+3),`${kind} hiddenRGB`);}
  }
  assert.equal((await fs.readdir(dataDir)).some(name=>name.startsWith('.filter-bake-')),false);
});

test('inactive and identity stacks clear without new assets; empty, protected and earlier-protected contexts reject before source reads',async t=>{
  const {native,doc:start}=await fixture(t,{filters:[entry('invert',100,undefined,{enabled:false}),entry('median',3,undefined,{opacity:0})]});const id=start.layers[0].id;
  const stored=await fs.readdir(native.assetsDir),open=fs.open;fs.open=async()=>{throw new Error('No image or project I/O expected before metadata guard');};
  try {
    const graph=graphOf(native,start);graph.layers[0].protected=true;assert.throws(()=>planFilterBake(graph,id),coded('PROTECTED_LAYER'));
    graph.layers[0].protected=false;graph.layers[0].filters=[];assert.throws(()=>planFilterBake(graph,id),coded('NO_FILTERS'));
    graph.layers[0].filters=[entry('invert',100)];graph.layers.unshift({...graph.layers[0],id:randomUUID(),name:'Hidden protected',visible:false,opacity:0,protected:true,filters:[]});
    assert.throws(()=>planFilterBake(graph,id),coded('FILTER_BAKE_PROTECTED_CONTEXT'));graph.layers[1].filters[0].enabled=false;assert.equal(planFilterBake(graph,id).active,false);
  }finally{fs.open=open;}
  // Deliberately missing source proves the bypass path never reads it.
  const sourcePath=path.join(native.assetsDir,start.layers[0].asset),sourceBytes=await fs.readFile(sourcePath);await fs.unlink(sourcePath);
  let doc=await edit(native,start,'bake_layer_filters',{layerId:id});assert.deepEqual(doc.layers[0].filters,[]);await fs.writeFile(sourcePath,sourceBytes);
  assert.deepEqual(await fs.readdir(native.assetsDir),stored);
  await assert.rejects(edit(native,doc,'bake_layer_filters',{layerId:id}),coded('NO_FILTERS'));
  doc=await edit(native,doc,'add_layer_filter',{layerId:id,kind:'color_balance',value:0});const before=doc.layers[0].asset;
  doc=await edit(native,doc,'bake_layer_filters',{layerId:id});assert.equal(doc.layers[0].asset,before);assert.deepEqual(await fs.readdir(native.assetsDir),stored);
  assert.equal((await fs.readdir(native.dataDir)).some(name=>name.startsWith('.filter-bake-')),false);
});

test('background baking below protected subjects stays exact and retains generated provenance and clipping links',async t=>{
  const {native,doc:start}=await fixture(t);let doc=await edit(native,start,'duplicate_layer',{layerId:start.layers[0].id});const lower=doc.layers[0].id,upper=doc.layers[1].id;
  doc=await edit(native,doc,'clear_layer_filters',{layerId:upper});doc=await edit(native,doc,'set_layer_protection',{layerId:upper,protected:true});
  const before=await render(native,doc);doc=await edit(native,doc,'bake_layer_filters',{layerId:lower});assert.deepEqual(await render(native,doc),before);
  doc=await edit(native,doc,'set_layer_protection',{layerId:upper,protected:false});
  doc=await edit(native,doc,'add_layer_filter',{layerId:upper,kind:'black_white',value:0});
  doc=await edit(native,doc,'set_clipping_chain',{baseLayerId:lower,layerIds:[upper]});
  const graph=graphOf(native,doc),member=graph.layers[1];member.role='generated';member.provenance={jobId:randomUUID(),imported:true};doc=(await native.commit(native.project(doc.id),graph,'Generated clip member')).document;
  const current=await render(native,doc),metadata=structuredClone(doc.layers[1]);doc=await edit(native,doc,'bake_layer_filters',{layerId:upper});
  assert.deepEqual(await render(native,doc),current);assert.deepEqual({...doc.layers[1],asset:metadata.asset,filters:metadata.filters},metadata);
});

test('bake unlocks a same-transaction stroke with one undo and retains source/alpha through portable reopen until a later source edit',async t=>{
  const {native,doc:start,dataDir,original}=await fixture(t,{alpha:true});const id=start.layers[0].id;
  let doc=await edit(native,start,'bake_layer_filters',{layerId:id}),baked=doc;
  assert.equal(doc.layers[0].alphaAsset,start.layers[0].alphaAsset);
  const copy=(await native.importProject({data:(await native.exportProject({documentId:doc.id})).data})).document;
  assert.deepEqual(copy.layers,doc.layers);assert.deepEqual(await render(native,copy),await render(native,doc));
  const reopened=await new NativeBackend({dataDir}).init();t.after(()=>reopened.close());assert.deepEqual((await get(reopened,doc)).layers,doc.layers);
  doc=await edit(native,doc,'undo');const before=doc;
  doc=await edit(native,doc,'apply_transaction',{operations:[{command:'bake_layer_filters',args:{layerId:id}},{command:'paint_stroke',args:brush(id)}]});
  assert.equal(doc.history.length,before.history.filter(item=>!item.future).length+1);assert.equal(doc.layers[0].alphaAsset,undefined,'the subsequent ordinary brush keeps its existing alpha-bake semantics');
  assert.equal(doc.layers[0].sourceAsset,start.layers[0].sourceAsset);assert.deepEqual(await fs.readFile(path.join(native.assetsDir,doc.layers[0].sourceAsset)),original);
  assert.notDeepEqual(await native.renderLayer(doc.layers[0]),await native.renderLayer(baked.layers[0]));
  doc=await edit(native,doc,'undo');assert.deepEqual(doc.layers,start.layers);
});

test('same-descriptor reads reject symlinks, growth, truncation, invalid hash and oversized dedupe before allocation',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'prism-bounded-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const data=Buffer.from('immutable example'),file=path.join(directory,'asset');await fs.writeFile(file,data);
  const opened=await openBoundedFile(file,{maxBytes:data.length});try{assert.deepEqual((await readBoundedHandle(opened.handle,{bytes:opened.bytes,expectedHash:hash(data)})).data,data);}finally{await opened.handle.close();}
  await fs.symlink(file,path.join(directory,'link'));await assert.rejects(openBoundedFile(path.join(directory,'link'),{maxBytes:100}),coded('INVALID_IMAGE'));
  await assert.rejects(openBoundedFile(file,{maxBytes:data.length-1}),coded('LIMIT_EXCEEDED'));
  await assert.rejects(openBoundedFile(file,{maxBytes:data.length+1,exactBytes:data.length+1}),coded('INVALID_IMAGE'));
  const stat=size=>({isFile:()=>true,size});
  for(const mode of ['grow','short','hash','before']){let stats=0,reads=0;const fake={stat:async()=>stat(mode==='before'||mode==='grow'&&++stats>1?data.length+1:data.length),read:async(buffer,offset,length,position)=>{reads++;if(mode==='short')return{bytesRead:0};data.copy(buffer,offset,position,position+length);return{bytesRead:length};}};
    await assert.rejects(readBoundedHandle(fake,{bytes:data.length,expectedHash:mode==='hash'?'0'.repeat(64):hash(data)}),coded('INVALID_IMAGE'));if(mode==='before')assert.equal(reads,0);
  }
  const {native}=await fixture(t);const sample=Buffer.from('deduplication fixture'),digest=hash(sample),destination=path.join(native.assetsDir,digest);
  await fs.writeFile(destination,Buffer.alloc(sample.length+1));await assert.rejects(native.storeAsset(sample),coded('CORRUPT_ASSET'));assert.equal((await fs.stat(destination)).size,sample.length+1);
  await fs.unlink(destination);await fs.symlink(file,destination);await assert.rejects(native.storeAsset(sample),coded('CORRUPT_ASSET'));assert.equal((await fs.lstat(destination)).isSymbolicLink(),true);
  assert.equal((await fs.readdir(native.assetsDir)).some(name=>name.startsWith('.')),false);
});

test('resource ledger bounds real owned phases and refuses before decode; private PNG output is size-admitted before JS read and always removed',async t=>{
  const {native,doc,dataDir}=await fixture(t,{alpha:true});const S=4000*2400,Ew=2345,Ea=9876;
  for(const hasAlpha of [false,true]){const a=estimateFilterBakeBytes({width:4000,height:2400,encodedWorkingBytes:Ew,encodedAlphaBytes:hasAlpha?Ea:0,hasAlpha}),e=Ew+(hasAlpha?Ea:0),P=5*S+1024*1024;
    assert.equal(a.decodeBytes,e+(hasAlpha?9:4)*S);assert.equal(a.filterBytes,e+(hasAlpha?17:12)*S+65536);assert.equal(a.encodeBytes,e+8*S+P);assert.equal(a.publicationBytes,e+4*S+2*P);assert.equal(a.estimatedWorkingBytes,Math.max(a.decodeBytes,a.filterBytes,a.encodeBytes,a.publicationBytes));}
  assert.equal(FILTER_BAKE_LIMITS.maxWorkingBytes,256*1024*1024);
  assert.ok(estimateFilterBakeBytes({width:4000,height:6000,hasAlpha:true}).estimatedWorkingBytes>FILTER_BAKE_LIMITS.maxWorkingBytes);
  await assert.rejects(bakeFilterSource({layer:{...doc.layers[0],width:4000,height:6000},filters:doc.layers[0].filters,assetsDir:native.assetsDir,tempRoot:dataDir}),coded('LIMIT_EXCEEDED'));
  let outputReads=0,mode;const originalOpen=fs.open;fs.open=async(...args)=>{const handle=await originalOpen(...args);if(String(args[0]).endsWith('/working.png')){mode=(await fs.stat(path.dirname(args[0]))).mode&0o777;const read=handle.read.bind(handle);handle.read=(...params)=>{outputReads++;return read(...params);};}return handle;};
  try{await assert.rejects(encodeBakedPng(Buffer.from([1,2,3,4]),1,1,{tempRoot:dataDir,maxBytes:1}),coded('LIMIT_EXCEEDED'));}finally{fs.open=originalOpen;}
  assert.equal(outputReads,0);assert.equal(mode,0o700);assert.equal((await fs.readdir(dataDir)).some(name=>name.startsWith('.filter-bake-')),false);
  const encoded=await encodeBakedPng(Buffer.from([91,55,111,0]),1,1,{tempRoot:dataDir,maxBytes:1024});assert.deepEqual(await sharp(encoded).ensureAlpha().raw().toBuffer(),Buffer.from([91,55,111,0]));
});

test('queued standalone and transaction inputs are captured at call time; mandatory revisions and metadata preflight precede file reads',async t=>{
  const {native,doc:start}=await fixture(t);const id=start.layers[0].id;
  await assert.rejects(native.execute('bake_layer_filters',{documentId:start.id,layerId:id}),coded('INVALID_ARGUMENTS'));
  let release;const gate=new Promise(resolve=>{release=resolve;}),blocking=native.enqueue(()=>gate);
  const args={documentId:start.id,expectedRevision:start.revision,layerId:id},pending=native.execute('bake_layer_filters',args);args.layerId=randomUUID();args.expectedRevision=999;release();await blocking;let doc=(await pending).document;assert.deepEqual(doc.layers[0].filters,[]);
  await assert.rejects(native.execute('bake_layer_filters',{documentId:doc.id,expectedRevision:start.revision,layerId:id}),coded('REVISION_CONFLICT'));
  doc=await edit(native,doc,'undo');let unlock;const pause=new Promise(resolve=>{unlock=resolve;}),queued=native.enqueue(()=>pause);
  const transaction={documentId:doc.id,expectedRevision:doc.revision,label:'Bake and paint',operations:[{command:'bake_layer_filters',args:{layerId:id}},{command:'paint_stroke',args:brush(id)}]},next=native.execute('apply_transaction',transaction);transaction.operations[0].args.layerId=randomUUID();transaction.operations[1].args.color='invalid';unlock();await queued;doc=(await next).document;assert.deepEqual(doc.layers[0].filters,[]);
  doc=await edit(native,doc,'undo');const serialize=native.serializeProject,open=fs.open;let reads=0;
  native.serializeProject=()=>{throw Object.assign(new Error('Prospective history exceeds limit'),{code:'LIMIT_EXCEEDED'});};fs.open=async()=>{reads++;throw new Error('Unexpected file access');};
  try{await assert.rejects(edit(native,doc,'bake_layer_filters',{layerId:id}),coded('LIMIT_EXCEEDED'));assert.equal(reads,0);}finally{native.serializeProject=serialize;fs.open=open;}
  assert.deepEqual(await get(native,doc),doc);
});

test('late transaction and real persistence failures clean every newly owned bake/paint blob while keeping existing deduplicated assets and cache',async t=>{
  const {native,doc:start}=await fixture(t);const id=start.layers[0].id;
  let doc=await edit(native,start,'bake_layer_filters',{layerId:id});const priorBake=doc.layers[0].asset;doc=await edit(native,doc,'undo');
  const files=(await fs.readdir(native.assetsDir)).sort(),preview=await native.execute('get_preview',{documentId:doc.id}),disk=await fs.readFile(path.join(native.projectsDir,`${doc.id}.json`));
  await assert.rejects(edit(native,doc,'apply_transaction',{operations:[{command:'bake_layer_filters',args:{layerId:id}},{command:'paint_stroke',args:brush(id)},{command:'set_layer',args:{layerId:randomUUID(),visible:false}}]}),coded('NOT_FOUND'));
  assert.deepEqual((await fs.readdir(native.assetsDir)).sort(),files);await fs.access(path.join(native.assetsDir,priorBake));assert.deepEqual(await get(native,doc),doc);assert.deepEqual(await native.execute('get_preview',{documentId:doc.id}),preview);
  // Remove the unused baked blob to force a genuinely new publication below.
  await fs.unlink(path.join(native.assetsDir,priorBake));const preFailure=(await fs.readdir(native.assetsDir)).sort();
  const projects=native.projectsDir,moved=`${projects}-retained`;await fs.rename(projects,moved);await fs.writeFile(projects,'blocks project publication');
  try{await assert.rejects(edit(native,doc,'bake_layer_filters',{layerId:id}),coded('ENOTDIR'));}finally{await fs.unlink(projects);await fs.rename(moved,projects);}
  assert.deepEqual((await fs.readdir(native.assetsDir)).sort(),preFailure);assert.deepEqual(await fs.readFile(path.join(native.projectsDir,`${doc.id}.json`)),disk);assert.deepEqual(await get(native,doc),doc);assert.deepEqual(await native.execute('get_preview',{documentId:doc.id}),preview);
  assert.equal((await fs.readdir(native.dataDir)).some(name=>name.startsWith('.filter-bake-')),false);
});

test('mixed repair/bake failure shares ownership and bake cleanup error while published-state assets are retained',async t=>{
  const {native,doc:start}=await fixture(t);const id=start.layers[0].id,repair=randomUUID(),files=(await fs.readdir(native.assetsDir)).sort();
  await assert.rejects(edit(native,start,'apply_transaction',{operations:[{command:'create_repair_layer',args:{sourceLayerId:id,newLayerId:repair}},{command:'bake_layer_filters',args:{layerId:id}},{command:'paint_stroke',args:brush(repair)},{command:'set_layer',args:{layerId:randomUUID(),visible:false}}]}),coded('NOT_FOUND'));
  assert.deepEqual((await fs.readdir(native.assetsDir)).sort(),files);
  const persist=native.persist,unlink=fs.unlink;native.persist=async()=>{throw Object.assign(new Error('Disk failed'),{code:'ENOSPC'});};fs.unlink=async target=>{if(/^[a-f0-9]{64}$/.test(path.basename(target))&&!files.includes(path.basename(target)))throw Object.assign(new Error('Cleanup denied'),{code:'EACCES'});return unlink(target);};
  try{await assert.rejects(edit(native,start,'bake_layer_filters',{layerId:id}),coded('FILTER_BAKE_ROLLBACK_FAILED'));}finally{native.persist=persist;fs.unlink=unlink;}
  assert.deepEqual(await get(native,start),start);
  native.persist=async project=>{await persist.call(native,project);throw Object.assign(new Error('Injected post-publication failure'),{code:'ENOSPC'});};
  try{await assert.rejects(edit(native,start,'bake_layer_filters',{layerId:id}),coded('ENOSPC'));}finally{native.persist=persist;}
  const committed=await get(native,start);assert.equal(committed.revision,start.revision+1);assert.deepEqual(committed.layers[0].filters,[]);await fs.access(path.join(native.assetsDir,committed.layers[0].asset));
});

test('source and deduplication FIFO paths reject without waiting for a writer in a timeout-bounded child', {skip:process.platform==='win32'},async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'prism-bake-fifo-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const assets=path.join(directory,'assets');await fs.mkdir(assets);const sample=Buffer.from('fifo dedupe guard'),fifo=path.join(assets,hash(sample));
  await promisify(execFile)('mkfifo',[fifo],{timeout:3000,killSignal:'SIGKILL'});
  const source=`import assert from 'node:assert/strict';
import {openBoundedFile} from ${JSON.stringify(new URL('../server/bounded-file.mjs',import.meta.url).href)};
import {NativeBackend} from ${JSON.stringify(new URL('../server/native.mjs',import.meta.url).href)};
await assert.rejects(openBoundedFile(process.argv[1],{maxBytes:1024}),{code:'INVALID_IMAGE'});
const native=await new NativeBackend({dataDir:process.argv[2]}).init();
try{
  await assert.rejects(native.storeAsset(Buffer.from('fifo dedupe guard')),{code:'CORRUPT_ASSET'});
  await assert.rejects(native.readProjectAsset(process.argv[1].split('/').at(-1)),{code:'LIMIT_EXCEEDED'});
}finally{await native.close();}
console.log('FIFO source and dedupe rejected');`;
  const result=await promisify(execFile)(process.execPath,['--input-type=module','-e',source,fifo,directory],{timeout:3000,killSignal:'SIGKILL',maxBuffer:64*1024});
  assert.match(result.stdout,/FIFO source and dedupe rejected/);assert.equal((await fs.lstat(fifo)).isFIFO(),true);assert.deepEqual(await fs.readdir(assets),[path.basename(fifo)]);
});
