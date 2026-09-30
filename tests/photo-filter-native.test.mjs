import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { ADJUSTMENTS, PARAMETERIZED_ADJUSTMENTS, COLOR_MAPPING_KINDS, normalizeParameters } from '../server/color.mjs';
import { PHOTO_FILTER_POLICY, PHOTO_FILTER_DEFAULTS } from '../server/photo-filter.mjs';
import { applyLayerFilters, editedFilterStack, filterWork, layerFilterSpatialCacheBytes, layerFilterSharedBytes, LAYER_FILTER_KINDS } from '../server/layer-filters.mjs';
import { LAYER_FILTER_BLEND_MODES, compileFilterBlend } from '../server/filter-blend.mjs';
import { combineAlpha } from '../server/cutout-pixels.mjs';
import { photoFilterReference } from './fixtures/photo-filter/reference.mjs';
const coded=code=>error=>error.code===code;
const parameters={color:'#5090ff',density:37.51,preserveLuminosity:true};
const entry=(p=parameters,extra={})=>({id:randomUUID(),kind:'photo_filter',value:0,parameters:p,enabled:true,opacity:1,...extra});
const graphOf=(native,doc)=>structuredClone(native.project(doc.id).states[native.project(doc.id).cursor].graph);
const edit=async(native,doc,command,args={})=>(await native.execute(command,{documentId:doc.id,expectedRevision:doc.revision,...args})).document;
const pixels=(width,height)=>{const output=Buffer.alloc(width*height*4);for(let p=0;p<width*height;p++)output.set([p%256,(p*37+29)%256,(p*101+40)%256,[0,1,128,255][p%4]],p*4);return output;};
const byte=x=>Math.max(0,Math.min(255,Math.round(x)));
async function fixture(t,{alpha=false}={}){
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'prism-photo-filter-')),native=await new NativeBackend({dataDir}).init();
 t.after(async()=>{await native.close();await fs.rm(dataDir,{recursive:true,force:true});});
 const width=16,height=16,input=pixels(width,height),png=await sharp(input,{raw:{width,height,channels:4}}).png().toBuffer();
 let doc=(await native.execute('import_image',{mimeType:'image/png',data:png.toString('base64')})).document;
 const cutout=Buffer.from(Array.from({length:width*height},(_,p)=>[0,1,128,255,191][p%5]));
 if(alpha){const graph=graphOf(native,doc);graph.layers[0].alphaAsset=await native.storeAlpha(cutout,width,height);doc=(await native.commit(native.project(doc.id),graph,'Alpha fixture')).document;}
 return{native,doc,input,cutout,width,height,dataDir};
}
function sourceReference(input,entries){const output=Buffer.from(input);for(const selected of entries){if(!selected.enabled||selected.opacity===0)continue;const blend=selected.blendMode?compileFilterBlend(selected.blendMode,selected.opacity):null;for(let i=0;i<output.length;i+=4)if(output[i+3]){const original=[...output.subarray(i,i+3)],candidate=photoFilterReference(original,selected.parameters);output.set(blend?blend(original,candidate):original.map((c,j)=>byte(c+(candidate[j]-c)*selected.opacity)),i);}}return output;}

test('Photo Filter discovery, label, complete defaults and flat partial updates require no image access',async t=>{
 const{native,doc:initial}=await fixture(t);let doc=initial;const id=doc.layers[0].id;
 assert.equal(Object.keys(ADJUSTMENTS).length,28);assert.equal(LAYER_FILTER_KINDS.length,32);assert.ok(PARAMETERIZED_ADJUSTMENTS.includes('photo_filter'));assert.ok(COLOR_MAPPING_KINDS.includes('photo_filter'));assert.deepEqual(normalizeParameters('photo_filter'),PHOTO_FILTER_DEFAULTS);
 const caps=await native.execute('capabilities');assert.equal(caps.photoFilterPolicy,PHOTO_FILTER_POLICY);
 let io=0;const render=native.renderLayer,store=native.storeAsset;native.renderLayer=native.storeAsset=async()=>{io++;throw Error('Unexpected image access');};
 try{
  doc=await edit(native,doc,'add_layer_filter',{layerId:id,kind:'photo_filter',value:0,parameters});const filterId=doc.layers[0].filters[0].id;
  doc=await edit(native,doc,'update_layer_filter',{layerId:id,filterId,parameters:{density:0}});assert.deepEqual(doc.layers[0].filters[0].parameters,{...parameters,density:0});
  doc=await edit(native,doc,'update_layer_filter',{layerId:id,filterId,parameters:{}});assert.deepEqual(doc.layers[0].filters[0].parameters,{...parameters,density:0});
  doc=await edit(native,doc,'add_adjustment',{kind:'photo_filter',value:0});const tone=doc.layers.at(-1).id;assert.equal(doc.layers.at(-1).name,'Photo Filter');
  doc=await edit(native,doc,'update_adjustment',{layerId:tone,parameters:{color:'#AAbbCC'}});assert.deepEqual(doc.layers.at(-1).parameters,{...PHOTO_FILTER_DEFAULTS,color:'#aabbcc'});
  let reads=0;const accessor=Object.defineProperty({},'density',{enumerable:true,get(){reads++;return 25;}});
  assert.throws(()=>editedFilterStack(doc.layers[0].filters,'update_layer_filter',{filterId,parameters:accessor}),coded('INVALID_ARGUMENT'));
  await assert.rejects(edit(native,doc,'update_adjustment',{layerId:tone,parameters:accessor}),coded('INVALID_ARGUMENT'));assert.equal(reads,0);
 }finally{native.renderLayer=render;native.storeAsset=store;}assert.equal(io,0);
});

test('Photo Filter byte candidates enter all blends before a finished-stack mask and preserve source alpha/hidden RGB',async()=>{
 const input=pixels(16,16),immutable=Buffer.from(input);
 for(const blendMode of LAYER_FILTER_BLEND_MODES){const e=entry(parameters,{opacity:.625,blendMode});assert.deepEqual(await applyLayerFilters(input,16,16,[e]),sourceReference(input,[e]),blendMode);}
 const identity=entry({color:'#000000',density:100,preserveLuminosity:true},{opacity:.5,blendMode:'multiply'});assert.deepEqual(await applyLayerFilters(input,16,16,[identity]),sourceReference(input,[identity]));assert.notDeepEqual(await applyLayerFilters(input,16,16,[identity]),input);
 const entries=[entry(parameters,{opacity:.625}),entry({color:'#ff8000',density:75,preserveLuminosity:false},{opacity:.375,blendMode:'screen'})],graded=sourceReference(input,entries),runs=[];for(let p=1;p<256;p++)runs.push(p,1,p);
 const stack={version:1,entries,mask:{sourceWidth:16,sourceHeight:16,density:.1,enabled:true,coverage:{shape:'bitmap',width:16,height:16,runs,feather:0,invert:false}}},expected=Buffer.from(input);
 for(let p=0;p<256;p++)if(input[p*4+3]){const m=Math.round(255-.1*(255-p));for(let c=0;c<3;c++)expected[p*4+c]=Math.floor((2*(input[p*4+c]*(255-m)+graded[p*4+c]*m)+255)/510);}
 assert.deepEqual(await applyLayerFilters(input,16,16,stack),expected);assert.deepEqual(input,immutable);
});

test('Photo Filter direct-JS transaction patches reject getters before Bake snapshots or any I/O',async t=>{
 const{native,doc:initial}=await fixture(t);let doc=initial;const sourceId=doc.layers[0].id;
 doc=await edit(native,doc,'add_layer_filter',{layerId:sourceId,kind:'photo_filter',value:0});const filterId=doc.layers[0].filters[0].id;
 doc=await edit(native,doc,'add_adjustment',{kind:'photo_filter',value:0});const toneId=doc.layers.at(-1).id;
 const before=JSON.stringify(native.project(doc.id)),open=fs.open,render=native.renderLayer,store=native.storeAsset;let reads=0,io=0;
 fs.open=native.renderLayer=native.storeAsset=async()=>{io++;throw Error('Unexpected I/O');};
 try{
  for(const field of['density','preserveLuminosity'])for(const command of['update_adjustment','update_layer_filter']){
   const parameters=Object.defineProperty({},field,{enumerable:true,get(){reads++;return field==='density'?25:true;}});
   const args={documentId:doc.id,expectedRevision:doc.revision,label:'Strict Photo Filter patch',operations:[{command,args:{layerId:command==='update_adjustment'?toneId:sourceId,...(command==='update_layer_filter'?{filterId}:{}),parameters}},{command:'bake_layer_filters',args:{layerId:sourceId}}]};
   await assert.rejects(native.execute('apply_transaction',args),coded('INVALID_ARGUMENT'));
   await assert.rejects(native.dispatch('apply_transaction',args),coded('INVALID_ARGUMENT'));
  }
  const parameters=Object.defineProperty({},'color',{enumerable:true,get(){reads++;return '#ffffff';}});
  await assert.rejects(native.execute('apply_transaction',{documentId:doc.id,expectedRevision:doc.revision,label:'Strict add',operations:[{command:'add_adjustment',args:{kind:'photo_filter',value:0,parameters}},{command:'bake_layer_filters',args:{layerId:sourceId}}]}),coded('INVALID_ARGUMENT'));
 }finally{fs.open=open;native.renderLayer=render;native.storeAsset=store;}
 assert.equal(reads,0);assert.equal(io,0);assert.equal(JSON.stringify(native.project(doc.id)),before);
});

test('Photo Filter work identities and computing activation use16S/1S with no cache and reject before I/O',async t=>{
 const{native,doc}=await fixture(t);const selected=entry();assert.equal(filterWork(selected,24_000_000),384_000_000);assert.equal(filterWork(entry({density:0}),24_000_000),24_000_000);
 for(const p of[{color:'#ffffff'},{color:'#808080'},{color:'#000000',density:100}])assert.equal(filterWork(entry(p),1),1);
 assert.equal(filterWork(entry({color:'#808080',preserveLuminosity:false}),1),16);assert.equal(filterWork(entry({}, {blendMode:'multiply'}),1),56);assert.equal(filterWork(entry({density:0},{blendMode:'multiply'}),1),41);
 assert.equal(layerFilterSpatialCacheBytes([selected],8000,3000),0);assert.equal(layerFilterSharedBytes([selected]),0);
 const graph=graphOf(native,doc);graph.width=8000;graph.height=3000;Object.assign(graph.layers[0],{width:8000,height:3000,filters:[selected]});native.validateGraph(graph);
 graph.layers[0].filters.push(entry({density:0}));let calls=0;const open=fs.open;fs.open=async()=>{calls++;throw Error('Unexpected I/O');};try{assert.throws(()=>native.validateGraph(graph),coded('LIMIT_EXCEEDED'));await assert.rejects(native.renderGraph(graph),coded('LIMIT_EXCEEDED'));}finally{fs.open=open;}assert.equal(calls,0);
 graph.layers[0].visible=false;graph.layers[0].filters=[entry({color:'#abcdef\n'},{enabled:false,opacity:0})];assert.throws(()=>native.validateGraph(graph),coded('INVALID_ARGUMENT'));
});

test('global Photo Filter keeps protected and zero-alpha bytes and applies density/opacity only after the candidate',async()=>{
 const input=pixels(16,16),protectedPixels=Uint8Array.from({length:256},(_,p)=>p%7===0?1:0),layer={...entry(parameters,{opacity:.625}),mask:{shape:'rectangle',x:2,y:0,width:12,height:16,feather:0,invert:false},maskDensity:.5};
 const output=await NativeBackend.prototype.applyAdjustment(input,16,16,layer,protectedPixels),expected=Buffer.from(input);
 for(let p=0;p<256;p++)if(input[p*4+3]&&!protectedPixels[p]){const amount=.625*(p%16>=2&&p%16<14?1:.5),candidate=photoFilterReference([...input.subarray(p*4,p*4+3)],parameters);for(let c=0;c<3;c++)expected[p*4+c]=byte(input[p*4+c]+(candidate[c]-input[p*4+c])*amount);}
 assert.deepEqual(output,expected);
});

test('complete Photo Filter recipes reset all fields and append under existing mask without pixel work',async t=>{
 const{native,doc:initial}=await fixture(t);let doc=initial;const sourceId=doc.layers[0].id;
 doc=await edit(native,doc,'add_layer_filter',{layerId:sourceId,kind:'photo_filter',value:0,parameters});doc=await edit(native,doc,'set_layer_filter_mask',{layerId:sourceId,source:'all'});doc=await edit(native,doc,'add_adjustment',{kind:'photo_filter',value:0,parameters});const toneId=doc.layers.at(-1).id;
 const saved=await native.execute('save_edit_recipe',{documentId:doc.id,expectedRevision:doc.revision,name:'Photo defaults',slots:[{key:'photo',type:'raster'},{key:'tone',type:'adjustment',kind:'photo_filter'}],steps:[{command:'add_layer_filter',target:'photo',args:{kind:'photo_filter',value:0,parameters:{}}},{command:'update_adjustment',target:'tone',args:{value:0,parameters:{}}}]});doc=saved.document;
 const prior=structuredClone(doc.layers),mask=doc.layers[0].filterMask,render=native.renderLayer,store=native.storeAsset;let calls=0;native.renderLayer=native.storeAsset=async()=>{calls++;throw Error('Recipe touched pixels');};
 try{assert.equal((await native.execute('validate_edit_recipe',{documentId:doc.id,expectedRevision:doc.revision,recipeId:saved.recipeId,bindings:{photo:sourceId,tone:toneId}})).valid,true);doc=await edit(native,doc,'apply_edit_recipe',{recipeId:saved.recipeId,bindings:{photo:sourceId,tone:toneId}});}finally{native.renderLayer=render;native.storeAsset=store;}
 assert.equal(calls,0);assert.deepEqual(doc.layers.at(-1).parameters,PHOTO_FILTER_DEFAULTS);assert.deepEqual(doc.layers[0].filters[1].parameters,PHOTO_FILTER_DEFAULTS);assert.deepEqual(doc.layers[0].filterMask,mask);doc=await edit(native,doc,'undo');assert.deepEqual(doc.layers,prior);
});

test('Photo Filter masked Distort Bake preserves working alpha/source assets, portable restart and real rollback',async t=>{
 const{native,doc:initial,input,cutout,width,height,dataDir}=await fixture(t,{alpha:true});let doc=initial;const id=doc.layers[0].id,originalAsset=doc.layers[0].asset,original=await fs.readFile(path.join(native.assetsDir,originalAsset));
 doc=await edit(native,doc,'add_layer_filter',{layerId:id,kind:'photo_filter',value:0,parameters,opacity:.625});doc=await edit(native,doc,'set_layer_filter_mask',{layerId:id,source:'mask',mask:{shape:'rectangle',x:1,y:1,width:14,height:14}});doc=await edit(native,doc,'modify_layer_filter_mask',{layerId:id,density:.5});doc=await edit(native,doc,'add_layer_distort',{layerId:id,corners:[{x:.25,y:0},{x:width+.25,y:0},{x:width+.25,y:height},{x:.25,y:height}]});
 const before=await native.renderGraph(graphOf(native,doc)),prior=structuredClone(doc.layers[0]),project=JSON.stringify(native.project(doc.id)),assets=await fs.readdir(native.assetsDir),directory=native.projectsDir;
 native.projectsDir=path.join(native.assetsDir,originalAsset);try{await assert.rejects(edit(native,doc,'bake_layer_filters',{layerId:id}),coded('ENOTDIR'));}finally{native.projectsDir=directory;}
 assert.equal(JSON.stringify(native.project(doc.id)),project);assert.deepEqual(await fs.readdir(native.assetsDir),assets);
 await assert.rejects(edit(native,doc,'apply_transaction',{label:'Photo rollback',operations:[{command:'bake_layer_filters',args:{layerId:id}},{command:'paint_stroke',args:{tool:'brush',layerId:id,points:[{x:2.5,y:1.5}],size:1,hardness:1,opacity:1,color:'#ff0033'}},{command:'delete_layer',args:{layerId:randomUUID()}}]}),coded('NOT_FOUND'));
 assert.equal(JSON.stringify(native.project(doc.id)),project);assert.deepEqual(await fs.readdir(native.assetsDir),assets);
 doc=await edit(native,doc,'bake_layer_filters',{layerId:id});assert.deepEqual(await native.renderGraph(graphOf(native,doc)),before);assert.deepEqual(doc.layers[0].transforms,prior.transforms);assert.equal(doc.layers[0].alphaAsset,prior.alphaAsset);assert.deepEqual(await fs.readFile(path.join(native.assetsDir,originalAsset)),original);
 const effective=combineAlpha(input,cutout),graded=sourceReference(effective,prior.filters),expected=Buffer.from(input);for(let p=0;p<256;p++){const x=p%16,y=Math.floor(p/16),m=x>=1&&x<15&&y>=1&&y<15?255:128;for(let c=0;c<3;c++)expected[p*4+c]=Math.floor((2*(effective[p*4+c]*(255-m)+graded[p*4+c]*m)+255)/510);}
 const raw=await sharp(await fs.readFile(path.join(native.assetsDir,doc.layers[0].asset))).ensureAlpha().raw().toBuffer();assert.deepEqual(raw,expected);
 doc=await edit(native,doc,'undo');const bundle=await native.exportProject({documentId:doc.id}),copy=(await native.importProject({data:bundle.data})).document;assert.deepEqual(copy.layers[0].filters,prior.filters);assert.deepEqual(await native.renderGraph(graphOf(native,copy)),before);
 const restarted=await new NativeBackend({dataDir}).init();try{assert.deepEqual(await restarted.renderGraph(graphOf(restarted,doc)),before);}finally{await restarted.close();}
});

test('wide Photo Filter source and global paths yield within the agreed pixel batches',async()=>{
 const width=8192,height=64,input=pixels(width,height),selected=entry(parameters,{opacity:.625}),expected=Array.from({length:256},(_,p)=>photoFilterReference([p,(p*37+29)%256,(p*101+40)%256],parameters));
 for(const scope of['source','global']){let running=true,ticks=0;const tick=()=>{if(running){ticks++;setImmediate(tick);}};setImmediate(tick);try{const output=scope==='source'?await applyLayerFilters(input,width,height,[selected]):await NativeBackend.prototype.applyAdjustment(input,width,height,selected);assert.ok(ticks>=32,`${scope} yielded ${ticks} batches`);for(let i=0;i<input.length;i++)assert.equal(output[i],i%4===3||!input[i-i%4+3]?input[i]:byte(input[i]+(expected[Math.floor(i/4)%256][i%4]-input[i])*.625));}finally{running=false;}}
});
