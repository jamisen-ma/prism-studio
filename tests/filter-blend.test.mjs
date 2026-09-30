import { lookupBytes, lookupParameters, lookupOptions } from './fixtures/color-lookup/owner-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { compileFilterBlend, normalizeFilterBlendMode, LAYER_FILTER_BLEND_MODES, LAYER_FILTER_BLEND_POLICY } from '../server/filter-blend.mjs';
import { LAYER_FILTER_KINDS, LAYER_FILTER_RANGES, normalizeLayerFilter, editedFilterStack, applyLayerFilters, filterWork, layerFilterSpatialCacheBytes, layerFilterSharedBytes } from '../server/layer-filters.mjs';
import { blendRGB, BLEND_MODES } from '../server/blend.mjs';
import { normalizeEditRecipe } from '../server/edit-recipes.mjs';
import { ADJUSTMENTS } from '../server/color.mjs';
import { estimateFilterBakeBytes } from '../server/filter-bake.mjs';
import { NativeBackend } from '../server/native.mjs';

const coded = code => error => error.code === code;
const entry = (kind='brightness',value=10,extra={}) => ({id:randomUUID(),kind,value,enabled:true,opacity:1,...extra});
const rgba=(width,height)=>Buffer.from(Array.from({length:width*height},(_,p)=>[(53*p+17)%256,(173*p+40)%256,(97*p+121)%256,[0,1,128,255][p%4]]).flat());
const byte=x=>Math.max(0,Math.min(255,Math.round(x)));
const f=(n,d=1n)=>({n:BigInt(n),d:BigInt(d)}),zero=f(0),one=f(1),half=f(1,2);
const add=(a,b)=>f(a.n*b.d+b.n*a.d,a.d*b.d),sub=(a,b)=>f(a.n*b.d-b.n*a.d,a.d*b.d),mul=(a,b)=>f(a.n*b.n,a.d*b.d),div=(a,b)=>f(a.n*b.d,a.d*b.n);
const cmp=(a,b)=>a.n*b.d-b.n*a.d,min=(a,b)=>cmp(a,b)<=0n?a:b,max=(a,b)=>cmp(a,b)>=0n?a:b,clip=x=>max(zero,min(one,x));
// Independent opacity conversion: exact repeated doubling, without IEEE bit fields.
function opacityFraction(p){let denominator=1n;while(!Number.isInteger(p)){p*=2;denominator*=2n;}return f(BigInt(p),denominator);}
function rationalMode(b,s,mode){
  const burn=(b,s)=>cmp(b,one)===0n?one:s.n===0n?zero:sub(one,min(one,div(sub(one,b),s)));
  const dodge=(b,s)=>b.n===0n?zero:cmp(s,one)===0n?one:min(one,div(b,sub(one,s)));
  switch(mode){
    case'darken':return min(b,s);case'lighten':return max(b,s);case'multiply':return mul(b,s);case'screen':return sub(one,mul(sub(one,b),sub(one,s)));
    case'color_burn':return burn(b,s);case'color_dodge':return dodge(b,s);case'linear_burn':return max(zero,sub(add(b,s),one));case'linear_dodge':return min(one,add(b,s));
    case'overlay':return cmp(b,half)<=0n?mul(f(2),mul(b,s)):sub(one,mul(f(2),mul(sub(one,b),sub(one,s))));
    case'hard_light':return cmp(s,half)<=0n?mul(f(2),mul(b,s)):sub(one,mul(f(2),mul(sub(one,b),sub(one,s))));
    case'vivid_light':return cmp(s,half)<0n?burn(b,mul(f(2),s)):dodge(b,sub(mul(f(2),s),one));
    case'linear_light':return clip(sub(add(b,mul(f(2),s)),one));case'pin_light':return cmp(s,half)<0n?min(b,mul(f(2),s)):max(b,sub(mul(f(2),s),one));
    case'hard_mix':return cmp(rationalMode(b,s,'vivid_light'),half)<0n?zero:one;
    case'difference':return cmp(b,s)<0n?sub(s,b):sub(b,s);case'exclusion':return sub(add(b,s),mul(f(2),mul(b,s)));case'subtract':return max(zero,sub(b,s));case'divide':return s.n===0n?one:min(one,div(b,s));
    default:throw Error(mode);
  }
}
const floating=new Set(['soft_light','hue','saturation','color','luminosity']);
function reference(back,front,mode,opacity){
  if(mode==='normal')return back.map((b,c)=>byte(b+(front[c]-b)*opacity));
  if(floating.has(mode)){const mixed=blendRGB(back.map(x=>x/255),front.map(x=>x/255),mode);return back.map((b,c)=>byte(b+(mixed[c]*255-b)*opacity));}
  const p=opacityFraction(opacity);let chosen;
  if(mode==='darker_color'||mode==='lighter_color'){const b=back.reduce((x,y)=>x+y),s=front.reduce((x,y)=>x+y);chosen=(mode==='darker_color'?b<=s:b>=s)?back:front;}
  return back.map((b,c)=>{const B=f(b,255),S=f(front[c],255),R=chosen?f(chosen[c],255):rationalMode(B,S,mode),out=mul(f(255),add(mul(B,sub(one,p)),mul(R,p)));return Number((2n*out.n+out.d)/(2n*out.d));});
}
function setting(kind){
  if(kind==='color_lookup')return entry(kind,0,{parameters:lookupParameters,opacity:.625});
  if(['levels','curves','channel_mixer','gradient_map','color_balance','black_white','unsharp_mask','add_noise','shadows_highlights','selective_color','hue_saturation'].includes(kind))return entry(kind,0,{opacity:.625,parameters:kind==='unsharp_mask'?{amount:37,sigma:.3977,threshold:5}:kind==='add_noise'?{amount:13.37,distribution:'gaussian',monochromatic:false,seed:4294967295}:undefined});
  if(['median','mosaic'].includes(kind))return entry(kind,3,{opacity:.625});
  if(['blur','sharpen'].includes(kind))return entry(kind,.7,{opacity:.625});
  return entry(kind,Math.round((LAYER_FILTER_RANGES[kind][0]+LAYER_FILTER_RANGES[kind][1])/3),{opacity:.625});
}
const edit=async(native,doc,command,args={})=>(await native.execute(command,{documentId:doc.id,expectedRevision:doc.revision,...args})).document;
const graphOf=(native,doc)=>structuredClone(native.project(doc.id).states[native.project(doc.id).cursor].graph);
async function fixture(t){const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'prism-filter-blend-')),native=await new NativeBackend({dataDir}).init();t.after(async()=>{await native.close();await fs.rm(dataDir,{recursive:true,force:true});});const input=rgba(7,5),png=await sharp(input,{raw:{width:7,height:5,channels:4}}).png().toBuffer();const doc=(await native.execute('import_image',{mimeType:'image/png',data:png.toString('base64')})).document;return{native,doc,dataDir,input};}

test('filter modes are strict source-only fields with canonical Normal, independent copies and recipe propagation',()=>{
  assert.deepEqual(LAYER_FILTER_BLEND_MODES,BLEND_MODES.filter(x=>x!=='dissolve'));assert.equal(LAYER_FILTER_BLEND_MODES.length,26);assert.equal(Object.keys(ADJUSTMENTS).length,28);
  const original=entry(),normal=normalizeLayerFilter(original);assert.deepEqual(normal,normalizeLayerFilter({...original,blendMode:'normal'}));assert.equal(normalizeFilterBlendMode(),undefined);
  const added=editedFilterStack([],'add_layer_filter',{kind:'brightness',value:10,blendMode:'multiply'})[0];assert.equal(added.blendMode,'multiply');
  const retained=editedFilterStack([added],'update_layer_filter',{filterId:added.id,value:12})[0];assert.equal(retained.blendMode,'multiply');
  const reset=editedFilterStack([retained],'update_layer_filter',{filterId:added.id,blendMode:'normal'})[0];assert.ok(!Object.hasOwn(reset,'blendMode'));assert.equal(added.blendMode,'multiply');
  for(const blendMode of[null,{},false,'','dissolve','Normal','unknown'])assert.throws(()=>normalizeLayerFilter({...original,blendMode,enabled:false,opacity:0}),coded('INVALID_ARGUMENT'));
  for(const opacity of[-1,2,NaN,Infinity,'1',null])assert.throws(()=>compileFilterBlend('multiply',opacity),coded('INVALID_ARGUMENT'));
  assert.deepEqual(Object.keys(compileFilterBlend('multiply',.75+2**-53)),[],'compiled opacity state stays private');
  const recipe=mode=>normalizeEditRecipe({id:randomUUID(),version:1,name:'Modes',slots:[{key:'photo',type:'raster'}],steps:[{command:'add_layer_filter',target:'photo',args:{kind:'add_noise',value:0,blendMode:mode}}]});
  assert.equal(recipe('screen').steps[0].args.blendMode,'screen');assert.deepEqual(recipe('screen').steps[0].args.parameters,{amount:5,distribution:'uniform',monochromatic:true,seed:1});assert.ok(!Object.hasOwn(recipe('normal').steps[0].args,'blendMode'));
});

test('all rational modes obey independent fractions at boundaries and arbitrary IEEE opacities; floating modes retain native core ordering',()=>{
  const values=[0,1,2,13,17,63,64,85,127,128,130,191,253,254,255];
  const opacities=[0,1,.5,.625,.75,.1,Number.MIN_VALUE,.5+2**-53,.5-2**-54,.75+2**-53,.75-2**-53,2**-36,2**-37];
  for(const mode of LAYER_FILTER_BLEND_MODES)for(const opacity of opacities){const transform=compileFilterBlend(mode,opacity);for(const b of values)for(const s of values){const back=[b,255-b,(b*7)%256],front=[s,(s*11)%256,255-s];assert.deepEqual(transform(back,front),reference(back,front,mode,opacity),`${mode}/${opacity}/${b}/${s}`);}}
  for(const [mode,b,s,p,expected]of[['multiply',13,85,.75,7],['screen',17,130,.375,63],['difference',2,69,.5,35],['linear_burn',2,254,.5,2],['linear_light',0,128,.5,1],['multiply',1,51,.625,1]])assert.deepEqual(compileFilterBlend(mode,p)([b,b,b],[s,s,s]),[expected,expected,expected]);
  for(const mode of['darker_color','lighter_color'])assert.deepEqual(compileFilterBlend(mode,1)([1,2,252],[2,250,3]),[1,2,252]);
});

test('all 32 source candidates ×26 blend modes preserve alpha, hidden RGB and the full-strength candidate-before-opacity stage',async()=>{
  const input=rgba(4,3);assert.equal(LAYER_FILTER_KINDS.length,32);
  for(const kind of LAYER_FILTER_KINDS){const config=setting(kind),candidate=await applyLayerFilters(input,4,3,[{...config,opacity:1}],lookupOptions);for(const mode of LAYER_FILTER_BLEND_MODES){const expected=Buffer.from(input);for(let p=0;p<12;p++)if(input[p*4+3])expected.set(reference([...input.subarray(p*4,p*4+3)],[...candidate.subarray(p*4,p*4+3)],mode,config.opacity),p*4);assert.deepEqual(await applyLayerFilters(input,4,3,[{...config,blendMode:mode}],lookupOptions),expected,`${kind}/${mode}`);}}
});

test('identity candidates still blend without a spatial cache or noise table and retain Normal work/bytes',async()=>{
  const identities=[entry('blur',0),entry('sharpen',0),entry('unsharp_mask',0,{parameters:{amount:0}}),entry('unsharp_mask',0,{parameters:{sigma:0}}),entry('unsharp_mask',0,{parameters:{threshold:255}}),entry('add_noise',0,{parameters:{amount:0,distribution:'gaussian'}})];
  const input=Buffer.from([128,64,192,1,128,64,192,128,128,64,192,255,17,31,43,0]);
  for(const config of identities){assert.equal(filterWork(config,10),10);assert.deepEqual(await applyLayerFilters(input,4,1,[config]),input);for(const blendMode of['multiply','screen','difference']){const blended={...config,blendMode};assert.equal(filterWork(blended,10),410);assert.equal(layerFilterSpatialCacheBytes([blended],4,1),0);assert.equal(layerFilterSharedBytes([blended]),0);const result=await applyLayerFilters(input,4,1,[blended]);for(let p=0;p<3;p++)assert.deepEqual([...result.subarray(p*4,p*4+3)],reference([128,64,192],[128,64,192],blendMode,1));assert.deepEqual(result.subarray(12),input.subarray(12));}}
  const ordinary=entry('gradient_map',0);assert.equal(filterWork({...ordinary,blendMode:'multiply'},1),45);assert.equal(filterWork({...ordinary,blendMode:'multiply',enabled:false},1),0);assert.equal(filterWork({...ordinary,blendMode:'hue',opacity:0},1),0);
  const baseline=estimateFilterBakeBytes({width:10,height:10,filters:[ordinary]}),blended=estimateFilterBakeBytes({width:10,height:10,filters:[{...ordinary,blendMode:'multiply'}]});assert.deepEqual(blended,baseline);
});

test('native mode edits and normalized recipes require no image work; hidden source work activation rejects atomically',async t=>{
  const{native,doc:initial,dataDir}=await fixture(t);let doc=initial;const layerId=doc.layers[0].id,originalGraph=graphOf(native,doc);const caps=await native.execute('capabilities',{});assert.equal(caps.layerFilterBlendPolicy,LAYER_FILTER_BLEND_POLICY);assert.deepEqual(caps.layerFilterBlendModes,LAYER_FILTER_BLEND_MODES);
  const actualRender=native.renderLayer,actualStore=native.storeAsset;native.renderLayer=async()=>{throw Error('Metadata read pixels');};native.storeAsset=async()=>{throw Error('Metadata wrote asset');};
  try{doc=await edit(native,doc,'add_layer_filter',{layerId,kind:'blur',value:0,blendMode:'multiply'});assert.equal(doc.layers[0].filters[0].blendMode,'multiply');doc=await edit(native,doc,'update_layer_filter',{layerId,filterId:doc.layers[0].filters[0].id,blendMode:'normal'});assert.ok(!Object.hasOwn(doc.layers[0].filters[0],'blendMode'));}finally{native.renderLayer=actualRender;native.storeAsset=actualStore;}
  const graph=originalGraph;graph.width=1;graph.height=1;Object.assign(graph.layers[0],{width:4000,height:2400,visible:false,transforms:[{type:'resize',width:1,height:1}],filters:[entry('blur',0)]});const huge=(await native.newProject(graph,'Bounded source')).document;
  const files=await fs.readdir(path.join(dataDir,'assets')),before=JSON.stringify(native.project(huge.id));let reads=0;native.renderLayer=async()=>{reads++;throw Error('Forbidden image work');};
  try{await assert.rejects(edit(native,huge,'update_layer_filter',{layerId:huge.layers[0].id,filterId:huge.layers[0].filters[0].id,blendMode:'multiply'}),coded('LIMIT_EXCEEDED'));}finally{native.renderLayer=actualRender;}
  assert.equal(reads,0);assert.equal(JSON.stringify(native.project(huge.id)),before);assert.deepEqual(await fs.readdir(path.join(dataDir,'assets')),files);
});

test('actual source-alpha, positioned-mask and transformed appearance is exact across mode Bake, undo and portable reopen',async t=>{
  const{native,doc:initial,dataDir}=await fixture(t);let doc=initial,graph=graphOf(native,doc);const layerId=doc.layers[0].id,layer=graph.layers[0],asset=layer.asset,sourceAsset=layer.sourceAsset,original=await fs.readFile(path.join(native.assetsDir,asset));
  const alpha=Buffer.from(Array.from({length:35},(_,p)=>[0,1,128,255][p%4])),alphaAsset=await native.storeAsset(await sharp(alpha,{raw:{width:7,height:5,channels:1}}).png().toBuffer());layer.alphaAsset=alphaAsset;doc=(await native.commit(native.project(doc.id),graph,'Alpha fixture')).document;
  doc=await edit(native,doc,'set_layer_mask',{layerId,mask:{shape:'rectangle',x:1,y:1,width:5,height:3,feather:1}});doc=await edit(native,doc,'modify_layer_mask',{layerId,density:.5});doc=await edit(native,doc,'set_layer_mask_position',{layerId,x:1,y:0});doc=await edit(native,doc,'transform_layer',{layerId,x:1,y:0,scaleX:1,scaleY:1});
  doc=await edit(native,doc,'add_layer_filter',{layerId,kind:'brightness',value:15,blendMode:'multiply',opacity:.75});doc=await edit(native,doc,'add_layer_filter',{layerId,kind:'add_noise',value:0,parameters:{amount:0},blendMode:'screen',opacity:.625});
  const before=await native.renderGraph(graphOf(native,doc)),saved=structuredClone(doc.layers[0]);doc=await edit(native,doc,'bake_layer_filters',{layerId});assert.deepEqual(await native.renderGraph(graphOf(native,doc)),before);const baked=doc.layers[0];assert.deepEqual(baked.filters,[]);assert.equal(baked.alphaAsset,alphaAsset);assert.equal(baked.sourceAsset,sourceAsset);assert.deepEqual(baked.mask,saved.mask);assert.deepEqual(baked.transforms,saved.transforms);assert.deepEqual(await fs.readFile(path.join(native.assetsDir,asset)),original);
  doc=await edit(native,doc,'undo');assert.deepEqual(doc.layers[0].filters,saved.filters);assert.deepEqual(await native.renderGraph(graphOf(native,doc)),before);
  const bundle=await native.exportProject({documentId:doc.id}),reopened=(await native.importProject({data:bundle.data})).document;assert.deepEqual(reopened.layers[0].filters,saved.filters);assert.deepEqual(await native.renderGraph(graphOf(native,reopened)),before);
});

test('mode activation preserves protected identity guards and real persistence failures leave project/assets/cache unchanged',async t=>{
  const{native,doc:initial,dataDir}=await fixture(t);let doc=initial;const layerId=doc.layers[0].id;
  doc=await edit(native,doc,'set_layer_protection',{layerId,protected:true});await assert.rejects(edit(native,doc,'add_layer_filter',{layerId,kind:'blur',value:0,blendMode:'difference'}),coded('PROTECTED_LAYER'));doc=await edit(native,doc,'set_layer_protection',{layerId,protected:false});
  doc=await edit(native,doc,'add_layer_filter',{layerId,kind:'brightness',value:15});const project=native.project(doc.id),before=JSON.stringify(project),assets=await fs.readdir(path.join(dataDir,'assets'));await native.execute('get_preview',{documentId:doc.id});const cache=native.previewCache.stats();
  const directory=native.projectsDir;native.projectsDir=path.join(native.assetsDir,doc.layers[0].asset);try{await assert.rejects(edit(native,doc,'update_layer_filter',{layerId,filterId:doc.layers[0].filters[0].id,blendMode:'screen'}),coded('ENOTDIR'));}finally{native.projectsDir=directory;}
  assert.equal(JSON.stringify(native.project(doc.id)),before);assert.deepEqual(await fs.readdir(path.join(dataDir,'assets')),assets);assert.deepEqual(native.previewCache.stats(),cache);
});

test('wide all-channel generic fallback yields and preserves every exact output byte',async()=>{
  const width=8192,height=128,input=Buffer.alloc(width*height*4);for(let p=0;p<width*height;p++)input.set([13,127,253,255],p*4);let ticks=0;const timer=setInterval(()=>ticks++,0);
  try{const result=await applyLayerFilters(input,width,height,[entry('gradient_map',0,{parameters:{stops:[{offset:0,color:'#555555'},{offset:1,color:'#555555'}]},opacity:.75+2**-53,blendMode:'multiply'})]);for(let p=0;p<width*height;p++)assert.deepEqual([...result.subarray(p*4,p*4+4)],[6,63,126,255]);assert.ok(ticks>=16);}finally{clearInterval(timer);}
});
