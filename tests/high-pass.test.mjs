import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {NativeBackend} from '../server/native.mjs';
import {sourceSpatialPlan,sourceSpatialCandidate,SOURCE_HIGH_PASS_POLICY} from '../server/source-spatial-filters.mjs';
import {LAYER_FILTER_KINDS,LAYER_FILTER_PARAMETERIZED_KINDS,normalizeLayerFilter,applyLayerFilters,filterWork,layerFilterSpatialCacheBytes,layerFilterSharedBytes} from '../server/layer-filters.mjs';
import {compileFilterBlend,LAYER_FILTER_BLEND_MODES} from '../server/filter-blend.mjs';
import {ADJUSTMENTS,PARAMETERIZED_ADJUSTMENTS} from '../server/color.mjs';
import {estimateFilterBakeBytes} from '../server/filter-bake.mjs';
import {normalizeEditRecipe} from '../server/edit-recipes.mjs';

const coded=code=>error=>error.code===code;
const filter=(value,extra={})=>({id:randomUUID(),kind:'high_pass',value,enabled:true,opacity:1,...extra});
const image=(width,height)=>Buffer.from(Array.from({length:width*height},(_,p)=>[(53*p+17)%256,(173*p+40)%256,(97*p+121)%256,[0,1,128,255][p%4]]).flat());
function kernel(value){if(value===0)return{radius:0,weights:[65536]};const radius=Math.ceil(value*3),raw=Array.from({length:radius+1},(_,i)=>i===0?1:Math.exp(-i*i/(2*value*value))),sum=1+2*raw.slice(1).reduce((a,b)=>a+b,0),weights=Array(radius*2+1).fill(0);for(let i=1;i<=radius;i++)weights[radius-i]=weights[radius+i]=Math.round(raw[i]*65536/sum);weights[radius]=65536-weights.reduce((a,b)=>a+b,0);return{radius,weights};}
function reference(input,width,height,value){
  const output=Buffer.from(input),{radius,weights}=kernel(value),clamp=(n,size)=>Math.max(0,Math.min(size-1,n));
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4;if(!input[i+3])continue;let d=0n,n=[0n,0n,0n];for(let ky=0;ky<weights.length;ky++)for(let kx=0;kx<weights.length;kx++){const j=(clamp(y+ky-radius,height)*width+clamp(x+kx-radius,width))*4,w=BigInt(weights[kx])*BigInt(weights[ky])*BigInt(input[j+3]);d+=w;for(let c=0;c<3;c++)n[c]+=BigInt(input[j+c])*w;}for(let c=0;c<3;c++){const m=(128n+BigInt(input[i+c]))*d-n[c];output[i+c]=m<=0n?0:m>=255n*d?255:Number((2n*m+d)/(2n*d));}}
  return output;
}
const graphOf=(native,doc)=>structuredClone(native.project(doc.id).states[native.project(doc.id).cursor].graph);
const edit=async(native,doc,command,args={})=>(await native.execute(command,{documentId:doc.id,expectedRevision:doc.revision,...args})).document;
async function fixture(t){const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'prism-high-pass-')),native=await new NativeBackend({dataDir}).init();t.after(async()=>{await native.close();await fs.rm(dataDir,{recursive:true,force:true});});const input=image(7,5),png=await sharp(input,{raw:{width:7,height:5,channels:4}}).png().toBuffer();const doc=(await native.execute('import_image',{mimeType:'image/png',data:png.toString('base64')})).document;return{native,doc,dataDir,input};}

test('High Pass is a strict scalar source-only kind with a gray zero candidate, separate capability and complete recipe settings',()=>{
  assert.equal(LAYER_FILTER_KINDS.length,32);assert.ok(LAYER_FILTER_KINDS.includes('high_pass'));assert.equal(Object.keys(ADJUSTMENTS).length,28);assert.ok(!('high_pass'in ADJUSTMENTS));assert.ok(!PARAMETERIZED_ADJUSTMENTS.includes('high_pass'));assert.ok(!LAYER_FILTER_PARAMETERIZED_KINDS.includes('high_pass'));
  for(const value of[0,Number.MIN_VALUE,.001,.3977,1,50])assert.equal(normalizeLayerFilter(filter(value)).value,value);
  assert.ok(!Object.hasOwn(normalizeLayerFilter(filter(0,{parameters:{}})),'parameters'));
  for(const value of[-1,50.01,NaN,Infinity,null,'1',undefined])assert.throws(()=>normalizeLayerFilter(filter(value,{enabled:false,opacity:0})),coded('INVALID_ARGUMENT'));
  for(const parameters of[null,[],{sigma:1},{amount:0}]){assert.throws(()=>normalizeLayerFilter(filter(0,{parameters})),coded('INVALID_ARGUMENT'));assert.throws(()=>sourceSpatialPlan(filter(0,{parameters,enabled:false}),1,1),coded('INVALID_ARGUMENT'));}
  const plan=sourceSpatialPlan(filter(0),2,1);assert.deepEqual(plan,{radius:0,taps:1,cacheRows:0,cacheBytes:0,work:2,computesCandidate:true});assert.equal(sourceSpatialPlan(filter(0,{enabled:false}),2,1).computesCandidate,false);
  const recipe=normalizeEditRecipe({id:randomUUID(),version:1,name:'Detail',slots:[{key:'photo',type:'raster'}],steps:[{command:'add_layer_filter',target:'photo',args:{kind:'high_pass',value:0,blendMode:'overlay'}}]});assert.deepEqual(recipe.steps[0].args,{kind:'high_pass',value:0,enabled:true,opacity:1,blendMode:'overlay'});
});

test('single-round residual agrees with independent2D BigInt including gray, subnormal kernels, half ties, clamping and hidden colors',async()=>{
  let checks=0;
  for(const [width,height]of[[1,1],[2,1],[1,5],[5,1],[3,4],[7,5]])for(const value of[0,Number.MIN_VALUE,.001,.1,.3977,1,3]){
    const input=image(width,height),actual=await sourceSpatialCandidate(input,width,height,filter(value));assert.deepEqual(actual,reference(input,width,height,value));const altered=Buffer.from(input);for(let p=0;p<width*height;p++)if(!input[p*4+3])altered.set([255-input[p*4],255-input[p*4+1],255-input[p*4+2]],p*4);const changed=await sourceSpatialCandidate(altered,width,height,filter(value));for(let p=0;p<width*height;p++)if(input[p*4+3])assert.deepEqual(changed.subarray(p*4,p*4+4),actual.subarray(p*4,p*4+4));checks++;
  }
  assert.equal(checks,42);
  for(const value of[0,Number.MIN_VALUE,.3977,1,10,50])for(const alpha of[1,128,255])assert.deepEqual([...await sourceSpatialCandidate(Buffer.from([31,121,231,alpha]),1,1,filter(value))],[128,128,128,alpha]);
  assert.deepEqual([...await sourceSpatialCandidate(Buffer.from([80,80,80,255,144,144,144,255]),2,1,filter(.3977))],[126,126,126,255,131,131,131,255]);
  for(const row of[[255,0,255],[0,255,0]]){const input=Buffer.from(row.flatMap(v=>[v,v,v,255]));assert.deepEqual(await sourceSpatialCandidate(input,3,1,filter(10)),reference(input,3,1,10));}
});

test('gray128 midpoint and quantized High Pass candidates feed every blend before opacity without changing alpha',async()=>{
  const ramp=Buffer.from(Array.from({length:256},(_,v)=>[v,v,v,255]).flat());
  for(const blendMode of['overlay','soft_light'])for(const opacity of[0,.1,.5,.625,1])assert.deepEqual(await applyLayerFilters(ramp,256,1,[filter(0,{blendMode,opacity})]),ramp);
  for(const [mode,count]of[['hard_light',128],['linear_light',255],['vivid_light',128]]){const actual=await applyLayerFilters(ramp,256,1,[filter(0,{blendMode:mode})]);let changed=0;for(let v=0;v<256;v++)if(actual[v*4]!==v)changed++;assert.equal(changed,count);}
  const input=image(7,5),candidate=reference(input,7,5,.3977);
  for(const blendMode of LAYER_FILTER_BLEND_MODES)for(const opacity of[.625,1]){const blend=compileFilterBlend(blendMode,opacity),expected=Buffer.from(input);for(let p=0;p<35;p++)if(input[p*4+3])expected.set(blend([...input.subarray(p*4,p*4+3)],[...candidate.subarray(p*4,p*4+3)]),p*4);assert.deepEqual(await applyLayerFilters(input,7,5,[filter(.3977,{blendMode,opacity})]),expected);}
});

test('metadata work, ring lifetime and every Bake phase charge High Pass consistently without an extra Gaussian plane',()=>{
  for(const sigma of[0,Number.MIN_VALUE,.001,1,3,50]){const width=8192,height=64,entry=filter(sigma),plan=sourceSpatialPlan(entry,width,height),k=2*Math.ceil(3*sigma)+1,rows=Math.min(height,k),expected=sigma===0?0:16*width*rows+4*rows+8*k;assert.equal(plan.cacheBytes,expected);assert.equal(plan.computesCandidate,true);assert.equal(plan.work,filterWork(entry,width*height));assert.equal(filterWork({...entry,blendMode:'overlay'},width*height),plan.work+40*width*height);assert.equal(layerFilterSpatialCacheBytes([entry],width,height),expected);}
  const options={width:1024,height:1024,encodedWorkingBytes:1000,encodedAlphaBytes:300,hasAlpha:true},zero=estimateFilterBakeBytes({...options,filters:[filter(0)]}),positive=estimateFilterBakeBytes({...options,filters:[filter(3)]});const ring=sourceSpatialPlan(filter(3),1024,1024).cacheBytes;assert.equal(positive.filterBytes-zero.filterBytes,ring);for(const phase of['decodeBytes','encodeBytes','publicationBytes'])assert.equal(positive[phase],zero[phase]);
  const noise={...filter(0),kind:'add_noise',parameters:{distribution:'gaussian'}},combined=estimateFilterBakeBytes({...options,filters:[filter(3),noise]});for(const phase of['decodeBytes','filterBytes','encodeBytes','publicationBytes'])assert.equal(combined[phase]-positive[phase],4096);assert.equal(layerFilterSharedBytes([filter(3)]),0);
  assert.throws(()=>sourceSpatialPlan(filter(1),8193,1),coded('LIMIT_EXCEEDED'));
});

test('native graph and recipe operations are source-only and metadata-only; hidden work activation fails before render',async t=>{
  const{native,doc:initial}=await fixture(t);let doc=initial;const layerId=doc.layers[0].id,caps=await native.execute('capabilities');assert.equal(caps.layerFilterHighPassPolicy,SOURCE_HIGH_PASS_POLICY);assert.equal(caps.layerFilterKinds.length,32);assert.equal(caps.adjustmentKinds.length,28);
  const actualRender=native.renderLayer,actualStore=native.storeAsset;native.renderLayer=async()=>{throw Error('Metadata read pixels');};native.storeAsset=async()=>{throw Error('Metadata wrote pixels');};
  try{doc=await edit(native,doc,'add_layer_filter',{layerId,kind:'high_pass',value:0});doc=await edit(native,doc,'update_layer_filter',{layerId,filterId:doc.layers[0].filters[0].id,value:.001});await assert.rejects(edit(native,doc,'add_adjustment',{kind:'high_pass',value:0}),coded('UNSUPPORTED'));const saved=await native.execute('save_edit_recipe',{documentId:doc.id,expectedRevision:doc.revision,name:'Detail',slots:[{key:'photo',type:'raster'}],steps:[{command:'add_layer_filter',target:'photo',args:{kind:'high_pass',value:0,blendMode:'soft_light'}}]});doc=saved.document;const report=await native.execute('validate_edit_recipe',{documentId:doc.id,expectedRevision:doc.revision,recipeId:saved.recipeId,bindings:{photo:layerId}});assert.equal(report.valid,true);doc=(await native.execute('apply_edit_recipe',{documentId:doc.id,expectedRevision:doc.revision,recipeId:saved.recipeId,bindings:{photo:layerId}})).document;}finally{native.renderLayer=actualRender;native.storeAsset=actualStore;}
  const graph=graphOf(native,doc);graph.width=1;graph.height=1;Object.assign(graph.layers[0],{width:4000,height:2400,visible:false,transforms:[{type:'resize',width:1,height:1}],filters:[filter(0)]});const large=(await native.newProject(graph,'Work bounds')).document,before=JSON.stringify(native.project(large.id));
  let reads=0;native.renderLayer=async()=>{reads++;throw Error('Forbidden pixels');};try{await assert.rejects(edit(native,large,'update_layer_filter',{layerId:large.layers[0].id,filterId:large.layers[0].filters[0].id,value:3}),coded('LIMIT_EXCEEDED'));await assert.rejects(edit(native,large,'update_layer_filter',{layerId:large.layers[0].id,filterId:large.layers[0].filters[0].id,blendMode:'overlay'}),coded('LIMIT_EXCEEDED'));}finally{native.renderLayer=actualRender;}assert.equal(reads,0);assert.equal(JSON.stringify(native.project(large.id)),before);
});

test('source-space Bake preserves exact working alpha, originals, positioned masks and retained geometry through undo and portable reopen',async t=>{
  const{native,doc:initial}=await fixture(t);let doc=initial,graph=graphOf(native,doc);const layerId=doc.layers[0].id,asset=doc.layers[0].asset,original=await fs.readFile(path.join(native.assetsDir,asset)),working=await sharp(original).ensureAlpha().raw().toBuffer(),alpha=Buffer.from(Array.from({length:35},(_,p)=>[0,1,128,255][p%4]));const alphaAsset=await native.storeAsset(await sharp(alpha,{raw:{width:7,height:5,channels:1}}).png().toBuffer());graph.layers[0].alphaAsset=alphaAsset;doc=(await native.commit(native.project(doc.id),graph,'Separate alpha')).document;
  doc=await edit(native,doc,'set_layer_mask',{layerId,mask:{shape:'ellipse',x:1,y:0,width:5,height:5,feather:1}});doc=await edit(native,doc,'modify_layer_mask',{layerId,density:.5});doc=await edit(native,doc,'set_layer_mask_position',{layerId,x:1,y:0});doc=await edit(native,doc,'transform_layer',{layerId,x:1,y:0,scaleX:1,scaleY:1});doc=await edit(native,doc,'add_layer_filter',{layerId,kind:'high_pass',value:.3977});
  const effective=Buffer.from(working);for(let p=0;p<35;p++)effective[p*4+3]=Math.round(working[p*4+3]*alpha[p]/255);const expected=reference(effective,7,5,.3977);for(let p=0;p<35;p++)expected[p*4+3]=working[p*4+3];const before=await native.renderGraph(graphOf(native,doc)),saved=structuredClone(doc.layers[0]);doc=await edit(native,doc,'bake_layer_filters',{layerId});assert.deepEqual(await native.renderGraph(graphOf(native,doc)),before);assert.deepEqual(await sharp(await fs.readFile(path.join(native.assetsDir,doc.layers[0].asset))).ensureAlpha().raw().toBuffer(),expected);assert.equal(doc.layers[0].alphaAsset,alphaAsset);assert.deepEqual(doc.layers[0].mask,saved.mask);assert.deepEqual(doc.layers[0].transforms,saved.transforms);assert.deepEqual(await fs.readFile(path.join(native.assetsDir,asset)),original);
  doc=await edit(native,doc,'undo');assert.deepEqual(doc.layers[0].filters,saved.filters);const reopened=(await native.importProject({data:(await native.exportProject({documentId:doc.id})).data})).document;assert.deepEqual(reopened.layers[0].filters,saved.filters);assert.deepEqual(await native.renderGraph(graphOf(native,reopened)),before);
});

test('zero-gray remains protected activity and real Bake persistence failure cleans new assets without changing graph or preview cache',async t=>{
  const{native,doc:initial}=await fixture(t);let doc=initial;const layerId=doc.layers[0].id;doc=await edit(native,doc,'set_layer_protection',{layerId,protected:true});await assert.rejects(edit(native,doc,'add_layer_filter',{layerId,kind:'high_pass',value:0}),coded('PROTECTED_LAYER'));doc=await edit(native,doc,'set_layer_protection',{layerId,protected:false});doc=await edit(native,doc,'add_layer_filter',{layerId,kind:'high_pass',value:0,enabled:false});doc=await edit(native,doc,'set_layer_protection',{layerId,protected:true});await assert.rejects(edit(native,doc,'update_layer_filter',{layerId,filterId:doc.layers[0].filters[0].id,enabled:true}),coded('PROTECTED_LAYER'));doc=await edit(native,doc,'set_layer_protection',{layerId,protected:false});doc=await edit(native,doc,'update_layer_filter',{layerId,filterId:doc.layers[0].filters[0].id,enabled:true});
  await native.execute('get_preview',{documentId:doc.id});const before=JSON.stringify(native.project(doc.id)),assets=await fs.readdir(native.assetsDir),cache=native.previewCache.stats(),directory=native.projectsDir;native.projectsDir=path.join(native.assetsDir,doc.layers[0].asset);try{await assert.rejects(edit(native,doc,'bake_layer_filters',{layerId}),coded('ENOTDIR'));}finally{native.projectsDir=directory;}assert.equal(JSON.stringify(native.project(doc.id)),before);assert.deepEqual(await fs.readdir(native.assetsDir),assets);assert.deepEqual(native.previewCache.stats(),cache);
});

test('zero-gray and positive kernels yield on wide sources while retaining every alpha and hidden byte',async()=>{
  const width=8192,height=128,input=image(width,height);for(const value of[0,.001,1]){let ticks=0,active=true;const pulse=()=>{if(active){ticks++;setImmediate(pulse);}};setImmediate(pulse);try{const actual=await sourceSpatialCandidate(input,width,height,filter(value));for(let p=0;p<width*height;p++){assert.equal(actual[p*4+3],input[p*4+3]);if(!input[p*4+3])assert.deepEqual(actual.subarray(p*4,p*4+3),input.subarray(p*4,p*4+3));else if(value<.01)assert.deepEqual([...actual.subarray(p*4,p*4+3)],[128,128,128]);}assert.ok(ticks>=16);}finally{active=false;}}
});
