import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { LOCAL_TONE_POLICY, normalizeLocalToneParameters, localTonePlan, compileLocalToneTables, localToneChannelByte, localToneCandidate } from '../server/local-tone.mjs';
import { LAYER_FILTER_KINDS, LAYER_FILTER_PARAMETERIZED_KINDS, normalizeLayerFilter, applyLayerFilters, filterWork, layerFilterSpatialCacheBytes } from '../server/layer-filters.mjs';
import { ADJUSTMENTS, PARAMETERIZED_ADJUSTMENTS } from '../server/color.mjs';
import { LAYER_FILTER_BLEND_MODES, compileFilterBlend } from '../server/filter-blend.mjs';
import { estimateFilterBakeBytes } from '../server/filter-bake.mjs';
import { normalizeEditRecipe } from '../server/edit-recipes.mjs';

const defaults = { shadows:25, highlights:0, shadowWidth:50, highlightWidth:50, sigma:3 };
const coded = code => error => error.code === code;
const filter = (parameters, extra={}) => ({ id:randomUUID(), kind:'shadows_highlights', value:0, enabled:true, opacity:1, ...(parameters === undefined ? {} : {parameters}), ...extra });
const image = (w,h) => Buffer.from(Array.from({length:w*h},(_,p)=>[(53*p+17)%256,(173*p+40)%256,(97*p+121)%256,[0,1,128,255][p%4]]).flat());
const round = (n,d) => (2n*n+d)/(2n*d);
const edge = (x,n) => Math.max(0,Math.min(n-1,x));
function gaussian(sigma) {
  if (sigma === 0) return { radius:0, weights:[65536] };
  const radius=Math.ceil(3*sigma), raw=Array.from({length:radius+1},(_,i)=>i===0?1:Math.exp(-i*i/(2*sigma*sigma)));
  const sum=1+2*raw.slice(1).reduce((a,b)=>a+b,0), weights=Array(2*radius+1).fill(0);
  for(let d=1;d<=radius;d++) weights[radius-d]=weights[radius+d]=Math.round(raw[d]*65536/sum);
  weights[radius]=65536-weights.reduce((a,b)=>a+b,0); return {radius,weights};
}
function weight(amount,width,level) {
  const range=255n*BigInt(Math.round(width*100)), distance=range-10000n*BigInt(level);
  return distance<=0n?0n:round(65536n*BigInt(Math.round(amount*100))*distance*distance,10000n*range*range);
}
function reference(input,width,height,parameters) {
  const p={...defaults,...parameters}, output=Buffer.from(input), {radius,weights}=gaussian(p.sigma);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const i=4*(y*width+x); if(!input[i+3])continue;
    let n=0n,d=0n;
    for(let dy=-radius;dy<=radius;dy++)for(let dx=-radius;dx<=radius;dx++) {
      const j=4*(edge(y+dy,height)*width+edge(x+dx,width));
      const a=BigInt(input[j+3])*BigInt(weights[dx+radius])*BigInt(weights[dy+radius]);
      const l=(2126n*BigInt(input[j])+7152n*BigInt(input[j+1])+722n*BigInt(input[j+2])+5000n)/10000n;
      n+=l*a;d+=a;
    }
    const level=round(n,d), s=weight(p.shadows,p.shadowWidth,level), h=weight(p.highlights,p.highlightWidth,255n-level);
    const a=65536n+3n*s,b=65536n+3n*h;
    for(let c=0;c<3;c++){const v=BigInt(input[i+c]);output[i+c]=Number(round(255n*a*v,b*(255n-v)+a*v));}
  }
  return output;
}
const graphOf=(native,doc)=>structuredClone(native.project(doc.id).states[native.project(doc.id).cursor].graph);
const edit=async(native,doc,command,args={})=>(await native.execute(command,{documentId:doc.id,expectedRevision:doc.revision,...args})).document;
async function fixture(t) {
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'prism-local-tone-')), native=await new NativeBackend({dataDir}).init();
  t.after(async()=>{await native.close();await fs.rm(dataDir,{recursive:true,force:true});});
  const input=image(7,5),png=await sharp(input,{raw:{width:7,height:5,channels:4}}).png().toBuffer();
  const doc=(await native.execute('import_image',{mimeType:'image/png',data:png.toString('base64')})).document;
  return {native,doc,dataDir,input};
}

test('Local Shadows / Highlights is source-only with strict complete parameters and independent recipe copies',()=>{
  assert.equal(LAYER_FILTER_KINDS.length,32);assert.ok(LAYER_FILTER_KINDS.includes('shadows_highlights'));
  assert.equal(Object.keys(ADJUSTMENTS).length,28);assert.ok(!Object.hasOwn(ADJUSTMENTS,'shadows_highlights'));assert.ok(!PARAMETERIZED_ADJUSTMENTS.includes('shadows_highlights'));assert.ok(LAYER_FILTER_PARAMETERIZED_KINDS.includes('shadows_highlights'));
  assert.deepEqual(normalizeLocalToneParameters(),defaults);assert.deepEqual(normalizeLayerFilter(filter()).parameters,defaults);
  const supplied={shadows:0,highlights:100,shadowWidth:1,highlightWidth:99.99,sigma:Number.MIN_VALUE};assert.deepEqual(normalizeLocalToneParameters(supplied),supplied);assert.notEqual(normalizeLocalToneParameters(supplied),supplied);
  assert.equal(Object.is(normalizeLocalToneParameters({shadows:-0,highlights:-0,sigma:-0}).sigma,-0),false);
  for(const parameters of[null,[],{shadows:.001},{highlights:100.01},{shadowWidth:0},{highlightWidth:1.001},{sigma:50.01},{sigma:NaN},{sigma:Infinity},{sigma:'1'},{shadows:null},{value:0},Object.create({shadows:10}),{[Symbol('s')]:0},Object.defineProperty({},'shadows',{enumerable:true,get(){throw Error('read accessor');}})])assert.throws(()=>normalizeLayerFilter(filter(parameters,{enabled:false,opacity:0})),coded('INVALID_ARGUMENT'));
  assert.throws(()=>normalizeLayerFilter(filter({}, {value:1})),coded('INVALID_ARGUMENT'));
  const recipe=normalizeEditRecipe({id:randomUUID(),version:1,name:'Local tone',slots:[{key:'photo',type:'raster'}],steps:[{command:'add_layer_filter',target:'photo',args:{kind:'shadows_highlights',value:0,parameters:{highlights:0}}}]});
  assert.deepEqual(recipe.steps[0].args.parameters,defaults);recipe.steps[0].args.parameters.shadows=99;assert.deepEqual(normalizeLocalToneParameters(),defaults);
});

test('bounded 512-entry response setup matches independent BigInt and yields in each 64-entry block',async()=>{
  let state=1234567;const next=()=>state=(Math.imul(state,1664525)+1013904223)>>>0;
  for(let n=0;n<32;n++) {
    const p={shadows:n?next()%10001/100:0,highlights:next()%10001/100,shadowWidth:(100+next()%9901)/100,highlightWidth:(100+next()%9901)/100,sigma:3};
    const table=await compileLocalToneTables(p);assert.equal(table.byteLength,2048);assert.equal(table.buffer.byteLength,2048);
    for(let l=0;l<256;l++){assert.equal(table[l],Number(weight(p.shadows,p.shadowWidth,l)));assert.equal(table[256+l],Number(weight(p.highlights,p.highlightWidth,255-l)));if(l){assert.ok(table[l]<=table[l-1]);assert.ok(table[256+l]>=table[255+l]);}}
  }
  let ticks=0,active=true;const tick=()=>{if(active){ticks++;setImmediate(tick);}};setImmediate(tick);
  try {const table=await compileLocalToneTables(defaults);assert.ok(ticks>=8);assert.ok(table.subarray(256).every(v=>v===0));}finally{active=false;}
  const a=await compileLocalToneTables(defaults),b=await compileLocalToneTables(defaults);a[0]=1;assert.notEqual(a[0],b[0]);
});

test('quantized luminance before the Gaussian agrees with direct 2D BigInt for soft alpha, tiny sigma and hidden RGB',async()=>{
  for(const [width,height] of [[1,1],[2,1],[1,5],[5,1],[3,4],[7,5]])for(const sigma of[0,Number.MIN_VALUE,.001,.3977,1,3]) {
    const input=image(width,height),copy=Buffer.from(input),p={shadows:67.31,highlights:29.53,shadowWidth:74.77,highlightWidth:63.31,sigma};
    const actual=await localToneCandidate(input,width,height,filter(p));assert.deepEqual(actual,reference(input,width,height,p));assert.deepEqual(input,copy);
    const altered=Buffer.from(input);for(let i=0;i<input.length;i+=4)if(!input[i+3])altered.set([255-input[i],255-input[i+1],255-input[i+2]],i);
    const changed=await localToneCandidate(altered,width,height,filter(p));for(let i=0;i<input.length;i+=4)assert.deepEqual(changed.subarray(i,i+4),input[i+3]?actual.subarray(i,i+4):altered.subarray(i,i+4));
  }
  for(const alpha of[1,128,255])for(const sigma of[Number.MIN_VALUE,.3977,1,10,50]) {
    const input=Buffer.from([31,51,71,alpha]);assert.deepEqual(await localToneCandidate(input,1,1,filter({sigma})),await localToneCandidate(input,1,1,filter({sigma:0})));
  }
  const source=Buffer.from([128,128,128,1]);assert.equal(await localToneCandidate(source,1,1,filter({shadows:0,highlights:0})),source);assert.equal(await localToneCandidate(source,1,1,filter({}, {enabled:false})),source);
});

test('single rounded RGB ratio preserves endpoints and matches BigInt at ties and fixed-gain monotonic sweeps',()=>{
  let state=173;const next=()=>state=(Math.imul(state,1664525)+1013904223)>>>0;
  for(let n=0;n<300;n++){const s=next()%65537,h=next()%65537,a=65536n+3n*BigInt(s),b=65536n+3n*BigInt(h);let previous=-1;
    for(let c=0;c<256;c++){const C=BigInt(c),actual=localToneChannelByte(c,s,h);assert.equal(actual,Number(round(255n*a*C,b*(255n-C)+a*C)));assert.ok(actual>=previous);previous=actual;}
    assert.equal(localToneChannelByte(0,s,h),0);assert.equal(localToneChannelByte(255,s,h),255);
  }
  for(const [c,s,h,expected] of[[5,34488,12,13],[250,12,34488,243]])assert.equal(localToneChannelByte(c,s,h),expected);
  for(let c=0;c<256;c++)assert.equal(localToneChannelByte(c,32768,32768),c);
});

test('complete neighborhoods feed quantized candidates before all entry blends and the final stack mask',async()=>{
  const input=Buffer.alloc(12*5*4);for(let y=0;y<5;y++)for(let x=0;x<12;x++){const c=x<6?30:220;input.set([c,c,c,255],4*(y*12+x));}for(const x of[2,9])input.set([64,64,64,255],4*(2*12+x));
  const entry=filter({sigma:1}),candidate=reference(input,12,5,{sigma:1});assert.equal(candidate[4*(2*12+2)],81);assert.equal(candidate[4*(2*12+9)],64);
  const point=await localToneCandidate(input,12,5,filter({sigma:0}));assert.equal(point[4*(2*12+2)],73);assert.equal(point[4*(2*12+9)],73);
  for(const blendMode of LAYER_FILTER_BLEND_MODES){const blend=compileFilterBlend(blendMode,.625),expected=Buffer.from(input);for(let i=0;i<input.length;i+=4)expected.set(blend([...input.subarray(i,i+3)],[...candidate.subarray(i,i+3)]),i);assert.deepEqual(await applyLayerFilters(input,12,5,[{...entry,blendMode,opacity:.625}]),expected);}
  const mask={sourceWidth:12,sourceHeight:5,coverage:{shape:'bitmap',x:0,y:0,width:12,height:5,runs:[26,1,128],feather:0,invert:false},density:1,enabled:true};
  const actual=await applyLayerFilters(input,12,5,{version:1,entries:[entry],mask});for(let p=0;p<60;p++)for(let c=0;c<4;c++)assert.equal(actual[p*4+c],p!==26||c===3?input[p*4+c]:Number(round(BigInt(input[p*4+c])*127n+BigInt(candidate[p*4+c])*128n,255n)));
  for(const [blendMode,value] of[['multiply',64],['screen',192],['difference',0]])assert.deepEqual([...await applyLayerFilters(Buffer.from([128,128,128,1,23,41,17,0]),2,1,[filter({shadows:0,highlights:0},{blendMode})])],[value,value,value,1,23,41,17,0]);
});

test('metadata work and sequential cache maximum propagate into every unchanged Bake phase',()=>{
  const width=1024,height=1024,S=width*height;
  for(const sigma of[0,Number.MIN_VALUE,.001,1,3,50]){const entry=filter({sigma}),plan=localTonePlan(entry,width,height),K=2*Math.ceil(3*sigma)+1,M=Math.min(height,K),cache=2048+(sigma>0?8*width*M+3*width+4*M+8*K:0);assert.equal(plan.cacheBytes,cache);assert.equal(plan.work,S*(sigma===0?16:2*K+20));assert.equal(filterWork(entry,S),plan.work);assert.equal(filterWork({...entry,blendMode:'multiply'},S),plan.work+40*S);assert.equal(layerFilterSpatialCacheBytes([entry],width,height),cache);}
  const identity=filter({shadows:0,highlights:0,sigma:50});assert.equal(localTonePlan(identity,width,height).cacheBytes,0);assert.equal(filterWork(identity,S),S);assert.equal(filterWork({...identity,blendMode:'multiply'},S),41*S);
  assert.equal(localTonePlan(filter({sigma:50},{enabled:false}),width,height).work,0);assert.equal(localTonePlan(filter({sigma:50},{opacity:0}),width,height).cacheBytes,0);
  assert.throws(()=>localTonePlan(filter(),8193,1),coded('LIMIT_EXCEEDED'));assert.throws(()=>localTonePlan(filter({sigma:null}),1,1),coded('INVALID_ARGUMENT'));
  const local=filter({sigma:1}),blur={...filter(),kind:'blur',value:3,parameters:undefined},localCache=62548,blurCache=311524;
  assert.equal(layerFilterSpatialCacheBytes([local],width,height),localCache);for(const stack of[[local,blur],[blur,local]])assert.equal(layerFilterSpatialCacheBytes(stack,width,height),blurCache);
  const options={width:8192,height:1000,hasAlpha:true,encodedWorkingBytes:70_000_000,encodedAlphaBytes:59_099_776},noise={...filter(),kind:'add_noise',parameters:{distribution:'gaussian'}};
  const zero=estimateFilterBakeBytes({...options,filters:[filter({sigma:0}),noise]}),tiny=estimateFilterBakeBytes({...options,filters:[filter({sigma:.01}),noise]});assert.equal(zero.filterBytes,268435456);assert.equal(tiny.filterBytes,268656676);assert.equal(tiny.filterBytes-zero.filterBytes,221220);for(const phase of['decodeBytes','encodeBytes','publicationBytes'])assert.equal(tiny[phase],zero[phase]);
});

test('native sparse updates, recipes and portable copies retain effective defaults; Bake keeps source bytes and failures are atomic',async t=>{
  const {native,doc:initial}=await fixture(t);let doc=initial;const id=doc.layers[0].id,asset=doc.layers[0].asset,original=await fs.readFile(path.join(native.assetsDir,asset));
  const caps=await native.execute('capabilities');assert.equal(caps.layerFilterLocalTonePolicy,LOCAL_TONE_POLICY);assert.equal(caps.layerFilterKinds.length,32);assert.equal(caps.adjustmentKinds.length,28);
  await assert.rejects(edit(native,doc,'add_adjustment',{kind:'shadows_highlights',value:0}),coded('UNSUPPORTED'));
  const graph=graphOf(native,doc);graph.layers[0].filters=[filter({shadows:0,shadowWidth:17.31})];doc=(await native.commit(native.project(doc.id),graph,'Sparse local tone')).document;const fid=doc.layers[0].filters[0].id;
  const render=native.renderLayer,store=native.storeAsset;native.renderLayer=async()=>{throw Error('metadata pixels');};native.storeAsset=async()=>{throw Error('metadata asset');};
  try{doc=await edit(native,doc,'update_layer_filter',{layerId:id,filterId:fid,parameters:{highlights:19.99,sigma:.3977}});assert.deepEqual(doc.layers[0].filters[0].parameters,{shadows:0,highlights:19.99,shadowWidth:17.31,highlightWidth:50,sigma:.3977});const saved=await native.execute('save_edit_recipe',{documentId:doc.id,expectedRevision:doc.revision,name:'Local lift',slots:[{key:'photo',type:'raster'}],steps:[{command:'add_layer_filter',target:'photo',args:{kind:'shadows_highlights',value:0,parameters:{shadows:35.37}}}]});doc=saved.document;assert.equal((await native.execute('validate_edit_recipe',{documentId:doc.id,expectedRevision:doc.revision,recipeId:saved.recipeId,bindings:{photo:id}})).valid,true);doc=(await native.execute('apply_edit_recipe',{documentId:doc.id,expectedRevision:doc.revision,recipeId:saved.recipeId,bindings:{photo:id}})).document;}finally{native.renderLayer=render;native.storeAsset=store;}
  const before=await native.renderGraph(graphOf(native,doc)),saved=structuredClone(doc.layers[0].filters),assets=await fs.readdir(native.assetsDir),project=JSON.stringify(native.project(doc.id)),directory=native.projectsDir;
  native.projectsDir=path.join(native.assetsDir,asset);try{await assert.rejects(edit(native,doc,'bake_layer_filters',{layerId:id}),coded('ENOTDIR'));}finally{native.projectsDir=directory;}
  assert.equal(JSON.stringify(native.project(doc.id)),project);assert.deepEqual(await fs.readdir(native.assetsDir),assets);
  doc=await edit(native,doc,'bake_layer_filters',{layerId:id});assert.deepEqual(await native.renderGraph(graphOf(native,doc)),before);assert.deepEqual(await fs.readFile(path.join(native.assetsDir,asset)),original);
  doc=await edit(native,doc,'undo');assert.deepEqual(doc.layers[0].filters,saved);const copy=(await native.importProject({data:(await native.exportProject({documentId:doc.id})).data})).document;assert.deepEqual(copy.layers[0].filters,saved);assert.deepEqual(await native.renderGraph(graphOf(native,copy)),before);
});

test('wide source candidate and opacity stages yield while retaining every alpha and hidden RGB byte',async()=>{
  const width=8192,height=64,input=image(width,height);
  for(const sigma of[0,.001,1]){let ticks=0,active=true;const tick=()=>{if(active){ticks++;setImmediate(tick);}};setImmediate(tick);
    try {const actual=await applyLayerFilters(input,width,height,[filter({sigma},{opacity:.625})]);for(let p=0;p<width*height;p++){assert.equal(actual[p*4+3],input[p*4+3]);if(!input[p*4+3])assert.deepEqual(actual.subarray(p*4,p*4+3),input.subarray(p*4,p*4+3));}assert.ok(ticks>=16);}finally{active=false;}
  }
});
