import { lookupBytes, lookupParameters, lookupOptions } from './fixtures/color-lookup/owner-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {NativeBackend} from '../server/native.mjs';
import {maskCoverage} from '../server/masks.mjs';
import {layerTree} from '../server/groups.mjs';
import {applyLayerFilters,normalizeLayerFilters,editedFilterStack,validateLayerFilterResources,LAYER_FILTER_KINDS,normalizeLayerFilterParameters} from '../server/layer-filters.mjs';
import {filterEntries,storedFilterMask,normalizeFilterMask,normalizeSourceFilterMaskDescriptor,filterMaskWork,estimateFilterMaskSourceBytes,compileFilterMaskDensity,prepareBitmapCoverage,mixFilterMask,planFilterMaskCapture,estimateFilterMaskCapture,captureFilterMask,encodeFilterMaskAlpha,FILTER_MASK_POLICY} from '../server/filter-mask.mjs';
import {estimateFilterBakeBytes} from '../server/filter-bake.mjs';
import {renderMaskPreview} from '../server/mask-preview.mjs';

const coded=code=>cause=>cause.code===code;
const filter=(kind='invert',value=1,extra={})=>({id:randomUUID(),kind,value,enabled:true,opacity:1,...extra});
const bitmap=(values,width,height,extra={})=>({shape:'bitmap',x:0,y:0,width,height,runs:values.flatMap((v,p)=>v?[p,1,v]:[]),feather:0,invert:false,...extra});
const wrapped=(entries,width,height,coverage=bitmap([],width,height),extra={})=>({version:1,entries,mask:{sourceWidth:width,sourceHeight:height,coverage,density:1,enabled:true,...extra}});
const sample=(width,height)=>Buffer.from(Array.from({length:width*height},(_,p)=>[(31+17*p)%256,(241-37*p+25600)%256,(11+83*p)%256,[0,1,128,255][p%4]]).flat());
const mixByte=(o,f,m)=>Number((2n*(BigInt(o)*BigInt(255-m)+BigInt(f)*BigInt(m))+255n)/510n);
const graphOf=(native,doc)=>structuredClone(native.project(doc.id).states[native.project(doc.id).cursor].graph);
const edit=async(native,doc,command,args={})=>(await native.execute(command,{documentId:doc.id,expectedRevision:doc.revision,...args})).document;
async function fixture(t,width=8,height=6){const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'prism-filter-mask-')),native=await new NativeBackend({dataDir}).init();t.after(async()=>{await native.close();await fs.rm(dataDir,{recursive:true,force:true});});const pixels=sample(width,height),data=await sharp(pixels,{raw:{width,height,channels:4}}).png().toBuffer();let doc=(await native.execute('import_image',{data:data.toString('base64'),mimeType:'image/png'})).document;doc=await edit(native,doc,'add_layer_filter',{layerId:doc.layers[0].id,kind:'invert',value:1});return{native,doc,dataDir,pixels};}

test('masked representation is strict, retains ordinary arrays and has unambiguous entry lifecycle',()=>{
  const entries=[filter(),filter('brightness',10)],stack=wrapped(entries,3,2,bitmap([1,128,255],3,2),{enabled:false,density:.1});
  assert.deepEqual(normalizeLayerFilters(entries),entries);assert.equal(JSON.stringify(entries),JSON.stringify(filterEntries(entries)));
  assert.deepEqual(normalizeLayerFilters(stack),entries);assert.deepEqual(normalizeFilterMask(stack.mask),stack.mask);
  for(const malformed of[{...stack,version:2},{...stack,mask:null},{...stack,mask:undefined},{...stack,entries:[]},{...stack,unexpected:true},{...stack,mask:{...stack.mask,enabled:undefined}},{...stack,mask:{...stack.mask,coverage:{...stack.mask.coverage,density:0}}}])assert.throws(()=>normalizeLayerFilters(malformed));
  assert.throws(()=>normalizeFilterMask(stack.mask,2,3));
  for(const descriptor of[{shape:'polygon',points:[{x:0,y:0},{x:2,y:0},{x:0,y:2}]},{shape:'rectangle',x:.5,y:0,width:1,height:1},{...stack.mask.coverage,x:1},{...stack.mask.coverage,feather:null},{...stack.mask.coverage,clip:{x:0,y:0,width:1,height:1}},{...stack.mask.coverage,runs:Array(600003).fill(0)}])assert.throws(()=>normalizeSourceFilterMaskDescriptor(descriptor,3,2));
  const reordered=editedFilterStack(stack,'reorder_layer_filter',{filterId:entries[0].id,index:1});assert.deepEqual(reordered.mask,stack.mask);assert.notEqual(reordered.mask,stack.mask);
  const first=editedFilterStack(stack,'delete_layer_filter',{filterId:entries[0].id});assert.deepEqual(first.mask,stack.mask);assert.deepEqual(editedFilterStack(first,'delete_layer_filter',{filterId:entries[1].id}),[]);assert.deepEqual(editedFilterStack(stack,'clear_layer_filters',{}),[]);
});

test('native density stages and exact final RGB mixing preserve every alpha and invisible RGB',async()=>{
  for(const density of[0,Number.MIN_VALUE,.1,.10000000000000002,.49999999999999994,.5,.5000000000000001,.625,.9,1]){
    const lut=compileFilterMaskDensity(density);for(let m=0;m<256;m++)assert.equal(lut[m],Math.round(255-density*(255-m)));
    const original=sample(256,1),filtered=Buffer.from(original);for(let i=0;i<filtered.length;i++)if(i%4!==3)filtered[i]=255-original[i];
    const before=Buffer.from(filtered),mask=wrapped([filter()],256,1,bitmap(Array.from({length:256},(_,i)=>i),256,1),{density}).mask;
    const actual=await mixFilterMask(original,filtered,256,1,mask);
    for(let p=0;p<256;p++)for(let c=0;c<4;c++)assert.equal(actual[p*4+c],c===3||!original[p*4+3]?original[p*4+c]:mixByte(original[p*4+c],before[p*4+c],lut[p]));
  }
  assert.equal(compileFilterMaskDensity(.1)[0],230);assert.equal(compileFilterMaskDensity(.5000000000000001)[0],127);
});

test('all 32 source kinds are mixed only after the complete stack; disabled masks and inactive stacks bypass safely',async()=>{
  const input=sample(6,4),values=Array.from({length:24},(_,i)=>(i*73)%256),coverage=bitmap(values,6,4);
  for(const kind of LAYER_FILTER_KINDS){const value=['levels','curves','channel_mixer','gradient_map','color_balance','black_white','unsharp_mask','add_noise','shadows_highlights','selective_color','hue_saturation','color_lookup','photo_filter'].includes(kind)?0:['median','mosaic','posterize'].includes(kind)?3:kind==='high_pass'?0:1;const parameters=kind==='color_lookup'?lookupParameters:normalizeLayerFilterParameters(kind);const entry=filter(kind,value,{...(parameters?{parameters}:{}),opacity:.625});const plain=await applyLayerFilters(input,6,4,[entry],lookupOptions);const actual=await applyLayerFilters(input,6,4,wrapped([entry],6,4,coverage),lookupOptions);for(let p=0;p<24;p++)for(let c=0;c<4;c++)assert.equal(actual[p*4+c],c===3||!input[p*4+3]?input[p*4+c]:mixByte(input[p*4+c],plain[p*4+c],values[p]),kind);}
  const twice=[filter('invert',100),filter('invert',100)];assert.deepEqual(await applyLayerFilters(input,6,4,wrapped(twice,6,4,coverage)),input,'two inversions finish before mask');
  const active=[filter('blur',.3977)],whole=await applyLayerFilters(input,6,4,active),masked=await applyLayerFilters(input,6,4,wrapped(active,6,4,coverage));assert.equal(masked[7*4],mixByte(input[7*4],whole[7*4],values[7]),'blur neighborhoods are not clipped by the mask');
  assert.deepEqual(await applyLayerFilters(input,6,4,wrapped(active,6,4,coverage,{enabled:false})),whole);
  assert.deepEqual(await applyLayerFilters(input,6,4,wrapped(active,6,4,coverage,{density:0})),whole);
  assert.equal(await applyLayerFilters(input,6,4,wrapped([filter('invert',1,{enabled:false})],6,4,coverage)),input);
});

test('yielding bitmap preparation is byte-equivalent to legacy feather for raw and inverted coverage',async()=>{
  for(let n=0;n<40;n++){const width=3+n%11,height=2+n%7,values=Array.from({length:width*height},(_,p)=>(p*31+n*71)%256),mask=bitmap(values,width,height,{feather:[0,.25,1,10,100][n%5],invert:Boolean(n%2)}),legacy=maskCoverage(mask),actual=await prepareBitmapCoverage(mask);for(let y=-1;y<=height;y++)for(let x=-1;x<=width;x++)assert.equal(actual(x,y),legacy(x,y));}
  const width=8192,height=32,runs=[];for(let p=1;p<width*height;p+=2)runs.push(p,1,128);
  let ticks=0,active=true;const tick=()=>{if(active){ticks++;setImmediate(tick);}};setImmediate(tick);
  try{await prepareBitmapCoverage({shape:'bitmap',x:0,y:0,width,height,runs,feather:0,invert:false});assert.ok(ticks>=2,'sparse runs yield by visited writes rather than coordinates');}finally{active=false;}
});

test('capture compiles every intermediate clip and refuses noncopy geometry and excessive polygon work before sampling',async()=>{
  const layer={width:4,height:2,transforms:[{type:'crop',x:1,y:0,width:2,height:2},{type:'canvas',x:1,y:0,width:4,height:2}]},graph={width:4,height:2,selection:{shape:'rectangle',x:0,y:0,width:4,height:2,feather:0,invert:false}};
  const mask=await captureFilterMask(layer,graph),coverage=maskCoverage(mask);assert.deepEqual(Array.from({length:8},(_,p)=>Math.round(255*coverage(p%4,Math.floor(p/4)))),[0,255,255,0,0,255,255,0]);
  const plan=planFilterMaskCapture(layer,graph);assert.equal(plan.sampledPixels,4);assert.equal(estimateFilterMaskCapture({layer,graph}).captureWork,8+8*4);
  for(const transform of[{type:'resize',width:4,height:2},{type:'resample',method:'nearest',width:4,height:2},{type:'affine',width:4,height:2,x:.5,y:0,scaleX:1,scaleY:1,rotation:0}])assert.throws(()=>planFilterMaskCapture({...layer,transforms:[transform]},graph),coded('FILTER_MASK_CAPTURE_GEOMETRY'));
  const points=Array.from({length:256},(_,p)=>({x:p*6000/255,y:p%2?4000:0})),large={width:6000,height:4000,transforms:[]},bigGraph={width:6000,height:4000,selection:{shape:'polygon',points,feather:100,invert:false}};
  const estimate=estimateFilterMaskCapture({layer:large,graph:bigGraph});assert.equal(estimate.captureWork,24_000_000*521+4000*256*10);await assert.rejects(captureFilterMask(large,bigGraph),coded('LIMIT_EXCEEDED'));
  const selected=bitmap([0,255,128,1,255,0,80,200],4,2,{feather:2,invert:true});const captured=await captureFilterMask({...layer,transforms:[]},{...graph,selection:selected}),a=maskCoverage(captured),b=maskCoverage(selected);for(let p=0;p<8;p++)assert.equal(Math.round(a(p%4,Math.floor(p/4))*255),Math.round(b(p%4,Math.floor(p/4))*255));
  const complex=Uint8Array.from({length:500000},(_,i)=>i%2?1:2);await assert.rejects(encodeFilterMaskAlpha(complex,1000,500),coded('LIMIT_EXCEEDED'));
});

test('complete-source, renderer and Bake mask phases admit metadata before image reads and retain old array estimates',()=>{
  const width=6000,height=4000,entry=filter('brightness',1),stack=wrapped([entry],width,height,{shape:'rectangle',x:0,y:0,width,height,feather:0,invert:false});
  assert.equal(filterMaskWork(stack,width*height),192_000_000);assert.equal(estimateFilterMaskSourceBytes({width,height,stack}).estimatedWorkingBytes,288_000_000);
  const layer={id:randomUUID(),name:'No assets required',type:'raster',visible:false,opacity:1,blendMode:'normal',width,height,transforms:[],filters:stack};const graph={width,height,layers:[layer]};
  assert.throws(()=>validateLayerFilterResources(graph,layerTree(graph.layers)),coded('LIMIT_EXCEEDED'));layer.filters.mask.enabled=false;assert.doesNotThrow(()=>validateLayerFilterResources(graph,layerTree(graph.layers)));
  const source=wrapped([entry],5000,3000,bitmap([],5000,3000,{feather:10}),{density:.5});const plain=estimateFilterBakeBytes({width:5000,height:3000,hasAlpha:true,filters:[entry]}),masked=estimateFilterBakeBytes({width:5000,height:3000,hasAlpha:true,filters:source});
  assert.ok(plain.estimatedWorkingBytes<268435456);assert.equal(masked.maskBytes,18*15000000+256);assert.ok(masked.estimatedWorkingBytes>268435456);assert.ok(!('maskBytes'in plain));
});

test('native masks preserve public arrays, take queued argument snapshots and rollback failed metadata publication',async t=>{
  const{native,doc:initial}=await fixture(t);let doc=initial;const layerId=doc.layers[0].id;
  assert.equal((await native.execute('capabilities')).layerFilterMaskPolicy,FILTER_MASK_POLICY);
  let release;const blocker=native.enqueue(()=>new Promise(resolve=>{release=resolve;}));await new Promise(resolve=>setImmediate(resolve));
  const args={documentId:doc.id,expectedRevision:doc.revision,layerId,source:'mask',mask:{shape:'rectangle',x:1,y:1,width:3,height:3}};
  const pending=native.execute('set_layer_filter_mask',args);args.mask.x=4;release();await blocker;doc=(await pending).document;
  assert.ok(Array.isArray(doc.layers[0].filters));assert.equal(doc.layers[0].filterMask.coverage.x,1);assert.equal(graphOf(native,doc).layers[0].filters.mask.coverage.x,1);
  const before=graphOf(native,doc),assets=await fs.readdir(native.assetsDir),projectsDir=native.projectsDir;native.projectsDir=path.join(native.assetsDir,before.layers[0].asset);
  try{await assert.rejects(edit(native,doc,'modify_layer_filter_mask',{layerId,enabled:false}),coded('ENOTDIR'));}finally{native.projectsDir=projectsDir;}
  assert.deepEqual(graphOf(native,doc),before);assert.deepEqual(await fs.readdir(native.assetsDir),assets);
  await assert.rejects(native.execute('set_layer_filter_mask',{documentId:doc.id,layerId,source:'all'}),coded('INVALID_ARGUMENTS'));
  doc=await edit(native,doc,'modify_layer_filter_mask',{layerId,enabled:false,density:.1,feather:3,invert:true});assert.equal(doc.layers[0].filterMask.enabled,false);
  doc=await edit(native,doc,'set_layer_filter_mask',{layerId,source:'none'});assert.equal(doc.layers[0].filterMask.enabled,true);assert.equal(doc.layers[0].filterMask.density,1);assert.equal(doc.layers[0].filterMask.coverage.feather,0);
  doc=await edit(native,doc,'delete_layer_filter',{layerId,filterId:doc.layers[0].filters[0].id});assert.deepEqual(doc.layers[0].filters,[]);assert.ok(!('filterMask'in doc.layers[0]));
});

test('source mask inspection has exact odd dimensions and differs from canvas/additional-mask coverage',async()=>{
  const stack=wrapped([filter()],420,840,bitmap([],420,840),{enabled:false,density:.1});const layer={id:randomUUID(),type:'raster',width:420,height:840,filters:stack},graph={width:1,height:1,layers:[layer]};
  const raw=await renderMaskPreview(graph,{source:'filter-mask',layerId:layer.id,maskMode:'raw',maxEdge:457}),effective=await renderMaskPreview(graph,{source:'filter-mask',layerId:layer.id,maxEdge:457});
  assert.deepEqual([raw.width,raw.height,raw.sourceWidth,raw.sourceHeight,raw.coordinates],[229,457,420,840,'source']);assert.ok((await sharp(raw.data).raw().toBuffer()).every(value=>value===0));assert.ok((await sharp(effective.data).raw().toBuffer()).every(value=>value===255));
});
