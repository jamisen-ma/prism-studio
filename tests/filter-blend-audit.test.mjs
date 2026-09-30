import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { compileFilterBlend, normalizeFilterBlendMode } from '../server/filter-blend.mjs';
import { normalizeLayerFilter, applyLayerFilters, filterWork, layerFilterSpatialCacheBytes, layerFilterSharedBytes, validateLayerFilterResources } from '../server/layer-filters.mjs';
import { estimateFilterBakeBytes } from '../server/filter-bake.mjs';
import { layerTree } from '../server/groups.mjs';
import { encodeProjectBundle } from '../server/project-bundle.mjs';

// Independent normalized BigInt definitions, rather than production byte
// ratios, and exact doubling rather than IEEE bit-field extraction.
const F=(n,d=1n)=>[BigInt(n),BigInt(d)], Z=F(0),O=F(1),H=F(1,2);
const add=(a,b)=>F(a[0]*b[1]+b[0]*a[1],a[1]*b[1]);
const sub=(a,b)=>F(a[0]*b[1]-b[0]*a[1],a[1]*b[1]);
const mul=(a,b)=>F(a[0]*b[0],a[1]*b[1]);
const div=(a,b)=>F(a[0]*b[1],a[1]*b[0]);
const cmp=(a,b)=>a[0]*b[1]-b[0]*a[1];
const min=(a,b)=>cmp(a,b)<=0n?a:b,max=(a,b)=>cmp(a,b)>=0n?a:b;
const abs=a=>F(a[0]<0n?-a[0]:a[0],a[1]);
const clamp=a=>min(O,max(Z,a));
function burn(b,s){return cmp(b,O)===0n?O:cmp(s,Z)===0n?Z:sub(O,min(O,div(sub(O,b),s)));}
function dodge(b,s){return cmp(b,Z)===0n?Z:cmp(s,O)===0n?O:min(O,div(b,sub(O,s)));}
function scalar(b,s,mode){
  switch(mode){
    case'darken':return min(b,s);case'lighten':return max(b,s);
    case'multiply':return mul(b,s);case'screen':return sub(add(b,s),mul(b,s));
    case'color_burn':return burn(b,s);case'color_dodge':return dodge(b,s);
    case'linear_burn':return max(Z,sub(add(b,s),O));case'linear_dodge':return min(O,add(b,s));
    case'overlay':return cmp(b,H)<=0n?mul(F(2),mul(b,s)):sub(O,mul(F(2),mul(sub(O,b),sub(O,s))));
    case'hard_light':return scalar(s,b,'overlay');
    case'vivid_light':return cmp(s,H)<0n?burn(b,mul(F(2),s)):dodge(b,sub(mul(F(2),s),O));
    case'linear_light':return clamp(sub(add(b,mul(F(2),s)),O));
    case'pin_light':return cmp(s,H)<0n?min(b,mul(F(2),s)):max(b,sub(mul(F(2),s),O));
    case'hard_mix':return cmp(scalar(b,s,'vivid_light'),H)<0n?Z:O;
    case'difference':return abs(sub(b,s));case'exclusion':return sub(add(b,s),mul(F(2),mul(b,s)));
    case'subtract':return max(Z,sub(b,s));case'divide':return cmp(s,Z)===0n?O:min(O,div(b,s));
    default:throw Error(mode);
  }
}
const opacityCache=new Map();
function fraction(value){
  if(opacityCache.has(value))return opacityCache.get(value);
  let numerator=value,denominator=1n;
  while(!Number.isInteger(numerator)){numerator*=2;denominator*=2n;}
  const result=F(BigInt(numerator),denominator);opacityCache.set(value,result);return result;
}
function roundByte(value){const[n,d]=mul(value,F(255));return Number((2n*n+d)/(2n*d));}
function expected(back,front,opacity,mode){
  if(!mode||mode==='normal')return back.map((b,c)=>Math.max(0,Math.min(255,Math.round(b+(front[c]-b)*opacity))));
  const p=fraction(opacity),sum=x=>x.reduce((a,b)=>a+b,0);
  const selected=mode==='darker_color'?(sum(back)<=sum(front)?back:front):mode==='lighter_color'?(sum(back)>=sum(front)?back:front):null;
  return back.map((byte,c)=>{const b=F(byte,255),s=F(front[c],255),candidate=selected?F(selected[c],255):scalar(b,s,mode);return roundByte(add(mul(b,sub(O,p)),mul(candidate,p)));});
}
function stackReference(input,entries){
  const out=Buffer.from(input);
  for(const entry of entries)if(entry.enabled&&entry.opacity>0)for(let at=0;at<out.length;at+=4)if(out[at+3]){
    const b=[...out.subarray(at,at+3)],f=entry.kind==='gradient_map'?[85,85,85]:entry.kind==='invert'?b.map(v=>255-v):b;
    const rgb=expected(b,f,entry.opacity,entry.blendMode);for(let c=0;c<3;c++)out[at+c]=rgb[c];
  }
  return out;
}
const base=extra=>({id:randomUUID(),name:'Independent blend audit',visible:true,opacity:1,blendMode:'normal',...extra});
const filter=(kind='blur',extra={})=>({id:randomUUID(),kind,value:0,enabled:true,opacity:1,...extra});
const image=(w,h,fn)=>Buffer.from(Array.from({length:w*h},(_,i)=>typeof fn==='function'?fn(i%w,Math.floor(i/w),i):fn).flat());
const edit=(native,doc,command,args={})=>native.execute(command,{documentId:doc.id,expectedRevision:doc.revision,...(command==='apply_transaction'?{label:'Blend audit transaction'}:{}),...args});
const get=async(native,doc)=>(await native.execute('get_document',{documentId:doc.id})).document;
const files=async dir=>Object.fromEntries(await Promise.all((await fs.readdir(dir)).sort().map(async name=>[name,await fs.readFile(path.join(dir,name))])));
const decode=data=>sharp(data).toColourspace('srgb').ensureAlpha().raw().toBuffer();
const project=async(native,width,height,layers,extra={})=>(await native.newProject({name:'Blend audit',width,height,selection:null,layers,...extra},'Fixture')).document;
async function fixture(t){const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'prism-blend-audit-'));const native=await new NativeBackend({dataDir,segmentSubject:()=>assert.fail('Filter blend must not call a model')}).init();t.after(async()=>{await native.close();await fs.rm(dataDir,{recursive:true,force:true});});return{native,dataDir};}
async function raster(native,input,width,height,extra={}){const asset=await native.storeAsset(await sharp(input,{raw:{width,height,channels:4}}).png().toBuffer());return base({type:'raster',width,height,asset,sourceAsset:asset,sourceFormat:'png',transforms:[],...extra});}
async function noPixels(native,run,noFilesystem=false){const restore=[];for(const key of ['render','renderGraph','renderLayer','readAlpha','storeAlpha','storeAsset','readProjectAsset','validateProjectAsset','segmentSubject'])if(typeof native[key]==='function'){const old=native[key];native[key]=()=>assert.fail(`Unexpected ${key}`);restore.push(()=>{native[key]=old;});}if(noFilesystem)for(const key of ['readFile','writeFile','open','rename','link','stat']){const old=fs[key];fs[key]=()=>assert.fail(`Unexpected fs.${key}`);restore.push(()=>{fs[key]=old;});}try{return await run();}finally{restore.reverse().forEach(fn=>fn());}}

test('new rational production modes match independent normalized BigInt at endpoints, ties and exact IEEE opacities',()=>{
  const modes=['darken','multiply','color_burn','linear_burn','lighten','screen','color_dodge','linear_dodge','overlay','hard_light','vivid_light','linear_light','pin_light','hard_mix','difference','exclusion','subtract','divide','darker_color','lighter_color'];
  const opacities=[0,Number.MIN_VALUE,2**-1022,2**-40,2**-36,.01,.1,.125,.37,.375,.5-2**-54,.5,.5+2**-53,.625,.75-2**-53,.75,.75+2**-53,.875,1-2**-53,1];
  let state=0x412974;const next=()=>state=(Math.imul(state,1664525)+1013904223)>>>0;
  for(const mode of modes)for(const opacity of opacities){const actual=compileFilterBlend(mode,opacity);for(let i=0;i<64;i++){const bytes=Array.from({length:6},()=>next()>>>24),b=bytes.slice(0,3),f=bytes.slice(3);assert.deepEqual(actual(b,f),expected(b,f,opacity,mode));}}
  for(const mode of modes)for(const b of [0,1,127,128,254,255])for(const f of [0,1,127,128,254,255])assert.deepEqual(compileFilterBlend(mode,.5)([b,b,b],[f,f,f]),expected([b,b,b],[f,f,f],.5,mode));
  const goldens=[['multiply',13,85,.75,7],['screen',17,130,.375,63],['difference',2,69,.5,35],['linear_burn',2,254,.5,2],['linear_light',0,128,.5,1],['multiply',1,51,.625,1],['difference',1,1,.5+2**-53,0],['difference',1,1,.5-2**-54,1]];
  for(const[mode,b,f,opacity,wanted]of goldens)assert.deepEqual(compileFilterBlend(mode,opacity)([b,b,b],[f,f,f]),[wanted,wanted,wanted]);
  for(const mode of ['darker_color','lighter_color'])assert.deepEqual(compileFilterBlend(mode,1)([34,43,0],[0,77,0]),[34,43,0]);
  // Independent native floating goldens with no gamut clipping or half ties.
  for(const[mode,rgb]of [['hue',[124,94,144]],['saturation',[54,121,189]],['color',[134,89,144]],['luminosity',[56,116,176]]])assert.deepEqual(compileFilterBlend(mode,.5)([60,120,180],[200,50,100]),rgb);
});

test('all computational identity families still blend, with no ring/table and exact alpha/hidden RGB',async()=>{
  const identities=[filter('blur'),filter('sharpen'),filter('unsharp_mask',{parameters:{amount:0,sigma:50}}),filter('unsharp_mask',{parameters:{sigma:0}}),filter('unsharp_mask',{parameters:{sigma:50,threshold:255}}),filter('add_noise',{parameters:{amount:0,distribution:'gaussian'}})];
  const input=image(8,1,(_,__,i)=>[128,61,203,[0,1,128,255][i%4]]),copy=Buffer.from(input);
  for(const identity of identities)for(const mode of ['normal','multiply','screen','difference']){
    const entry=normalizeLayerFilter({...identity,blendMode:mode,opacity:.5});
    assert.deepEqual(await applyLayerFilters(input,8,1,[entry]),stackReference(input,[entry]));
    assert.equal(filterWork(entry,8),8*(mode==='normal'?1:41));assert.equal(layerFilterSpatialCacheBytes([entry],8,1),0);assert.equal(layerFilterSharedBytes([entry]),0);
    const normal=estimateFilterBakeBytes({width:8,height:1,hasAlpha:true,filters:[{...entry,blendMode:'normal'}]}),blended=estimateFilterBakeBytes({width:8,height:1,hasAlpha:true,filters:[entry]});assert.deepEqual(blended,normal);
    for(const bypass of [{enabled:false},{opacity:0}]){const inactive={...entry,...bypass};assert.equal(filterWork(inactive,8),0);assert.deepEqual(await applyLayerFilters(input,8,1,[inactive]),input);}
  }
  assert.deepEqual(input,copy);
  const old=filter('invert',{value:100,opacity:.37});assert.deepEqual(await applyLayerFilters(input,8,1,[old]),stackReference(input,[old]));assert.deepEqual(await applyLayerFilters(input,8,1,[{...old,blendMode:'normal'}]),stackReference(input,[old]));
});

test('source alpha precedes quantized candidates/blends; Bake retains geometry, mask density, group/clipping and upper protection',async t=>{
  const{native}=await fixture(t),w=9,h=7,input=image(w,h,(x,y,i)=>[x*29,y*37,i*53%256,[0,1,128,255][i%4]]),alpha=Buffer.from(Array.from({length:w*h},(_,i)=>[255,1,128,197,0][i%5]));
  const entries=[filter('gradient_map',{parameters:{stops:[{offset:0,color:'#555555'},{offset:1,color:'#555555'}]},blendMode:'multiply',opacity:.75+2**-53}),filter('invert',{value:100,blendMode:'screen',opacity:.37}),filter('blur',{blendMode:'difference',opacity:.125})];
  const group=base({type:'group',mode:'isolated',blendMode:'multiply',opacity:.7,mask:{x:1,y:0,width:7,height:6},maskDensity:.4});
  const content=await raster(native,input,w,h,{parentId:group.id,filters:entries,alphaAsset:await native.storeAlpha(alpha,w,h),transforms:[{type:'affine',width:w,height:h,x:.4,y:-.3,scaleX:1.1,scaleY:.9,rotation:17,flipX:false,flipY:false}],mask:{shape:'positioned',sourceWidth:w,sourceHeight:h,x:1,y:-1,source:{shape:'ellipse',x:1,y:1,width:5,height:4,feather:1.2,invert:true}},maskDensity:.5});
  const effective=Buffer.from(input);for(let i=0;i<alpha.length;i++)effective[i*4+3]=Number((2n*BigInt(input[i*4+3])*BigInt(alpha[i])+255n)/510n);
  const expectedSource=stackReference(effective,entries);assert.deepEqual(await native.renderLayer({...content,transforms:[]}),expectedSource);assert.notDeepEqual(expectedSource,stackReference(effective,[...entries].reverse()));
  const member=base({type:'solid',width:w,height:h,color:'#7d4ac1',transforms:[],parentId:group.id,clipBaseId:content.id,opacity:.43});
  const protectedTop=await raster(native,image(w,h,(x,y)=>[177,123,81,x>6&&y>4?255:0]),w,h,{protected:true});
  let doc=await project(native,w,h,[base({type:'solid',width:w,height:h,transforms:[],color:'#aabbcc'}),group,content,member,protectedTop],{selection:{shape:'rectangle',x:2,y:2,width:2,height:2}});
  const before=await native.renderGraph(doc),assets=await files(native.assetsDir),old=structuredClone(content);
  doc=(await edit(native,doc,'bake_layer_filters',{layerId:content.id})).document;
  const baked=doc.layers.find(l=>l.id===content.id),stored=await decode(await fs.readFile(path.join(native.assetsDir,baked.asset)));
  for(let i=0;i<alpha.length;i++)expectedSource[i*4+3]=input[i*4+3];assert.deepEqual(stored,expectedSource);assert.deepEqual(await native.renderGraph(doc),before);
  for(const key of Object.keys(old).filter(k=>!['asset','filters'].includes(k)))assert.deepEqual(baked[key],old[key]);
  for(const[name,data]of Object.entries(assets))assert.deepEqual(await fs.readFile(path.join(native.assetsDir,name)),data);
});

test('original lower protected context and generated clipping stay enforced for identity candidates that alter RGB',async t=>{
  const{native}=await fixture(t),w=9,h=7,person=await raster(native,image(w,h,(x,y)=>[188,127,81,x<3&&y>1?[1,128,255][x]:0]),w,h,{protected:true});
  const group=base({type:'group',mode:'isolated',opacity:.6}),original=image(w,h,(x,y)=>[x%2?220:20,y*35,150,255]);
  const content=await raster(native,original,w,h,{parentId:group.id,filters:[filter('unsharp_mask',{parameters:{amount:0,sigma:50},blendMode:'multiply'})]});
  const generated=await raster(native,image(w,h,[33,88,199,173]),w,h,{parentId:group.id,clipBaseId:content.id,role:'generated',provenance:{jobId:randomUUID(),mode:'generate'},filters:[filter('add_noise',{parameters:{amount:0,distribution:'gaussian'},blendMode:'difference'})]});
  const doc=await project(native,w,h,[person,group,content,generated]),footprint=await native.protectedPixels(doc,{beforeLayerId:content.id}),altered=await native.renderLayer(content,{protectedPixels:footprint});let restored=0,changed=0;
  for(let i=0;i<w*h;i++)if(footprint[i]){assert.deepEqual(altered.subarray(i*4,i*4+3),original.subarray(i*4,i*4+3));restored++;}else if(!altered.subarray(i*4,i*4+3).equals(original.subarray(i*4,i*4+3)))changed++;
  assert.ok(restored&&changed);
  const actual=await native.renderGraph(doc),control=await native.renderGraph({...doc,layers:doc.layers.filter(l=>l.id!==generated.id).map(l=>l.id===content.id?{...l,filters:[]}:l)});
  for(let i=0;i<w*h;i++)if(footprint[i])assert.deepEqual(actual.subarray(i*4,i*4+4),control.subarray(i*4,i*4+4));
  const preview=await native.execute('get_layer_preview',{documentId:doc.id,layerId:generated.id,view:'layer',maxWidth:32}),rgba=await decode(Buffer.from(preview.data,'base64'));
  for(let i=0;i<w*h;i++)if(footprint[i])assert.equal(rgba[i*4+3],0);
  const hidden=await project(native,w,h,[{...person,visible:false},{...content,parentId:undefined}]);
  await noPixels(native,()=>assert.rejects(edit(native,hidden,'bake_layer_filters',{layerId:content.id}),{code:'FILTER_BAKE_PROTECTED_CONTEXT'}));
  await noPixels(native,()=>assert.rejects(edit(native,hidden,'set_layer_protection',{layerId:content.id,protected:true}),{code:'PROTECTED_LAYER'}));
  await noPixels(native,()=>assert.rejects(edit(native,doc,'add_layer_filter',{layerId:person.id,kind:'blur',value:0,blendMode:'multiply'}),{code:'PROTECTED_LAYER'}));
});

test('uniform blend work and activation fail before image I/O, including hidden records, transactions and cumulative recipes',async t=>{
  const{native}=await fixture(t),w=4000,h=2400,source=base({type:'raster',width:w,height:h,asset:'a'.repeat(64),sourceAsset:'a'.repeat(64),transforms:[],visible:false,filters:[filter('blur')]});
  let doc=await project(native,w,h,[source]);const snapshot=structuredClone(doc);
  for(const args of [{blendMode:'multiply'},{blendMode:'soft_light'},{blendMode:'hue'}])await noPixels(native,()=>assert.rejects(edit(native,doc,'update_layer_filter',{layerId:source.id,filterId:source.filters[0].id,...args}),{code:'LIMIT_EXCEEDED'}));
  await noPixels(native,()=>assert.rejects(edit(native,doc,'apply_transaction',{operations:[{command:'update_layer_filter',args:{layerId:source.id,filterId:source.filters[0].id,blendMode:'multiply'}},{command:'rasterize_layer',args:{layerId:source.id}}]}),{code:'LIMIT_EXCEEDED'}));
  assert.deepEqual(await get(native,doc),snapshot);
  doc=(await noPixels(native,()=>edit(native,doc,'update_layer_filter',{layerId:source.id,filterId:source.filters[0].id,blendMode:'multiply',enabled:false}))).document;
  await noPixels(native,()=>assert.rejects(edit(native,doc,'update_layer_filter',{layerId:source.id,filterId:source.filters[0].id,enabled:true}),{code:'LIMIT_EXCEEDED'}));
  doc=(await noPixels(native,()=>edit(native,doc,'update_layer_filter',{layerId:source.id,filterId:source.filters[0].id,enabled:true,opacity:0}))).document;
  await noPixels(native,()=>assert.rejects(edit(native,doc,'update_layer_filter',{layerId:source.id,filterId:source.filters[0].id,opacity:Number.MIN_VALUE}),{code:'LIMIT_EXCEEDED'}));
  const small={...source,width:2200,height:2200,filters:[]};doc=await project(native,2200,2200,[small]);
  const saved=await noPixels(native,()=>edit(native,doc,'save_edit_recipe',{name:'Cumulative identity blends',slots:[{key:'photo',type:'raster'}],steps:[{command:'add_layer_filter',target:'photo',args:{kind:'blur',value:0,blendMode:'multiply'}},{command:'add_layer_filter',target:'photo',args:{kind:'add_noise',value:0,parameters:{amount:0,distribution:'gaussian'},blendMode:'screen'}}]}));doc=saved.document;
  const args={recipeId:saved.recipeId,bindings:{photo:small.id}},report=await noPixels(native,()=>edit(native,doc,'validate_edit_recipe',args),true);
  assert.equal(report.valid,false);assert.equal(report.issues[0].stepIndex,1);assert.equal(report.issues[0].code,'LIMIT_EXCEEDED');
  await noPixels(native,()=>assert.rejects(edit(native,doc,'apply_edit_recipe',args),{code:'LIMIT_EXCEEDED'}));assert.deepEqual(await get(native,doc),doc);assert.deepEqual(await fs.readdir(native.assetsDir),[]);
});

test('canonical Normal and mode-only updates preserve sparse parameters; valid recipe planning remains entirely metadata-only',async t=>{
  const{native}=await fixture(t),source=await raster(native,image(7,5,(x,y)=>[x*41,y*59,127,255]),7,5,{filters:[filter('add_noise',{parameters:{amount:0,seed:0,monochromatic:false},blendMode:'normal'})]});
  assert.equal(normalizeFilterBlendMode(),undefined);assert.equal(normalizeFilterBlendMode('normal'),undefined);
  assert.equal('blendMode' in normalizeLayerFilter(source.filters[0]),false);
  let doc=await project(native,7,5,[source]),assets=await files(native.assetsDir),id=source.filters[0].id;
  doc=(await noPixels(native,()=>edit(native,doc,'update_layer_filter',{layerId:source.id,filterId:id,blendMode:'multiply'}))).document;
  const parameters=structuredClone(doc.layers[0].filters[0].parameters);assert.equal(parameters.seed,0);assert.equal(parameters.monochromatic,false);
  doc=(await noPixels(native,()=>edit(native,doc,'update_layer_filter',{layerId:source.id,filterId:id,opacity:.37}))).document;assert.equal(doc.layers[0].filters[0].blendMode,'multiply');assert.deepEqual(doc.layers[0].filters[0].parameters,parameters);
  doc=(await noPixels(native,()=>edit(native,doc,'update_layer_filter',{layerId:source.id,filterId:id,blendMode:'normal'}))).document;assert.equal('blendMode' in doc.layers[0].filters[0],false);
  const saved=await noPixels(native,()=>edit(native,doc,'save_edit_recipe',{name:'Canonical blend defaults',slots:[{key:'photo',type:'raster'}],steps:[{command:'add_layer_filter',target:'photo',args:{kind:'add_noise',value:0,parameters:{amount:0,seed:0,monochromatic:false},blendMode:'normal'}},{command:'add_layer_filter',target:'photo',args:{kind:'blur',value:0,blendMode:'screen',opacity:.5}}]}));doc=saved.document;
  assert.equal('blendMode' in doc.editRecipes.at(-1).steps[0].args,false);assert.equal(doc.editRecipes.at(-1).steps[1].args.blendMode,'screen');
  const args={recipeId:saved.recipeId,bindings:{photo:source.id}};assert.equal((await noPixels(native,()=>edit(native,doc,'validate_edit_recipe',args),true)).valid,true);
  doc=(await noPixels(native,()=>edit(native,doc,'apply_edit_recipe',args))).document;assert.equal(doc.layers[0].filters.at(-1).blendMode,'screen');assert.deepEqual(await files(native.assetsDir),assets);
});

test('mode setting retains mask/group/chain and Bake phase accounting; malformed inactive portable metadata rejects before reads',async t=>{
  const{native}=await fixture(t),w=256,h=128,group=base({type:'group',mode:'isolated',opacity:.7});
  const entry=filter('blur',{value:2}),source=base({type:'raster',width:w,height:h,asset:'a'.repeat(64),sourceAsset:'a'.repeat(64),transforms:[],parentId:group.id,filters:[entry],mask:{shape:'positioned',sourceWidth:6000,sourceHeight:4000,x:0,y:0,source:{shape:'bitmap',x:0,y:0,width:6000,height:4000,runs:[],feather:1,invert:false}}});
  const member=base({type:'solid',width:w,height:h,color:'#ffffff',transforms:[],parentId:group.id,clipBaseId:source.id});
  const graph={name:'Retained blend resources',width:w,height:h,selection:null,layers:[group,source,member]};
  const normal=validateLayerFilterResources(graph,layerTree(graph.layers)),changed={...graph,layers:graph.layers.map(l=>l.id===source.id?{...l,filters:[{...entry,blendMode:'multiply'}]}:l)};
  assert.deepEqual(validateLayerFilterResources(changed,layerTree(changed.layers)),normal);
  assert.deepEqual(estimateFilterBakeBytes({width:w,height:h,hasAlpha:true,filters:[entry]}),estimateFilterBakeBytes({width:w,height:h,hasAlpha:true,filters:[{...entry,blendMode:'multiply'}]}));
  const real=await raster(native,image(3,2,[73,121,189,255]),3,2),bytes=await fs.readFile(path.join(native.assetsDir,real.asset)),before=await files(native.assetsDir);
  for(const bad of ['dissolve','future',null,17,{mode:'multiply'}]){
    const invalid={...real,filters:[filter('blur',{enabled:false,opacity:0,blendMode:bad})]};assert.throws(()=>normalizeLayerFilter(invalid.filters[0]));
    const data=await encodeProjectBundle({graph:{name:'Invalid blend',width:3,height:2,selection:null,layers:[invalid]},validateGraph:()=>{},readAsset:async()=>bytes});
    await noPixels(native,()=>assert.rejects(native.importProject({data}),{code:'INVALID_PROJECT_BUNDLE'}),true);
  }
  assert.throws(()=>normalizeLayerFilter(filter('add_noise',{parameters:{amount:0,blendMode:'multiply'}})));
  assert.deepEqual(await files(native.assetsDir),before);assert.deepEqual(await fs.readdir(native.projectsDir),[]);
});

test('real metadata/Bake persistence and late mixed-transaction failures preserve graph, history, cache and owned assets',async t=>{
  const{native}=await fixture(t),source=await raster(native,image(9,7,(x,y)=>[x*29,y*37,128,255]),9,7,{filters:[filter('blur',{blendMode:'multiply'})]});
  const doc=await project(native,9,7,[source]);await native.execute('get_preview',{documentId:doc.id,maxWidth:32});
  const assets=await files(native.assetsDir),projects=await files(native.projectsDir),cache=native.previewCache.stats(),directory=native.projectsDir;
  native.projectsDir=path.join(native.assetsDir,source.asset);
  try{await assert.rejects(edit(native,doc,'update_layer_filter',{layerId:source.id,filterId:source.filters[0].id,blendMode:'screen'}),{code:'ENOTDIR'});await assert.rejects(edit(native,doc,'bake_layer_filters',{layerId:source.id}),{code:'ENOTDIR'});}finally{native.projectsDir=directory;}
  await assert.rejects(edit(native,doc,'apply_transaction',{operations:[{command:'update_layer_filter',args:{layerId:source.id,filterId:source.filters[0].id,blendMode:'screen'}},{command:'bake_layer_filters',args:{layerId:source.id}},{command:'set_layer',args:{layerId:randomUUID(),visible:false}}]}),{code:'NOT_FOUND'});
  assert.deepEqual(await get(native,doc),doc);assert.deepEqual(await files(native.assetsDir),assets);assert.deepEqual(await files(native.projectsDir),projects);assert.deepEqual(native.previewCache.stats(),cache);
});

test('wide nonnormal loops yield even for alpha-zero pixels and generic fallback while preserving caller input',async()=>{
  const w=8192,h=16,input=image(w,h,(_,__,i)=>[1,1,1,i%2?255:0]),saved=Buffer.from(input);let ticked=false;
  const pending=applyLayerFilters(input,w,h,[filter('blur',{blendMode:'difference',opacity:.5+2**-53})]);setImmediate(()=>{ticked=true;});const actual=await pending;assert.equal(ticked,true);assert.deepEqual(input,saved);
  for(let i=0;i<input.length;i+=4)assert.deepEqual([...actual.subarray(i,i+4)],input[i+3]?[0,0,0,255]:[1,1,1,0]);
  const hidden=Buffer.from(input);for(let i=3;i<hidden.length;i+=4)hidden[i]=0;ticked=false;
  const bypass=applyLayerFilters(hidden,w,h,[filter('blur',{blendMode:'hue'})]);setImmediate(()=>{ticked=true;});assert.deepEqual(await bypass,hidden);assert.equal(ticked,true);
});
