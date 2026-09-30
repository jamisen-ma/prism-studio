import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { sourceSpatialPlan, sourceSpatialCandidate } from '../server/source-spatial-filters.mjs';
import { normalizeLayerFilter, applyLayerFilters, filterWork, layerFilterSpatialCacheBytes, layerFilterSharedBytes, validateLayerFilterResources } from '../server/layer-filters.mjs';
import { estimateFilterBakeBytes, bakeFilterSource } from '../server/filter-bake.mjs';
import { layerTree } from '../server/groups.mjs';
import { encodeProjectBundle } from '../server/project-bundle.mjs';

const base=extra=>({id:randomUUID(),name:'Independent High Pass audit',visible:true,opacity:1,blendMode:'normal',...extra});
const filter=(value=0,extra={})=>({id:randomUUID(),kind:'high_pass',value,enabled:true,opacity:1,...extra});
const image=(w,h,fn)=>Buffer.from(Array.from({length:w*h},(_,i)=>typeof fn==='function'?fn(i%w,Math.floor(i/w),i):fn).flat());
const edit=(native,doc,command,args={})=>native.execute(command,{documentId:doc.id,expectedRevision:doc.revision,...(command==='apply_transaction'?{label:'High Pass audit transaction'}:{}),...args});
const get=async(native,doc)=>(await native.execute('get_document',{documentId:doc.id})).document;
const files=async dir=>Object.fromEntries(await Promise.all((await fs.readdir(dir)).sort().map(async name=>[name,await fs.readFile(path.join(dir,name))])));
const decode=data=>sharp(data).toColourspace('srgb').ensureAlpha().raw().toBuffer();
const project=async(native,width,height,layers,extra={})=>(await native.newProject({name:'High Pass audit',width,height,selection:null,layers,...extra},'Fixture')).document;
async function fixture(t){const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'prism-high-pass-audit-'));const native=await new NativeBackend({dataDir,segmentSubject:()=>assert.fail('High Pass must not call a model')}).init();t.after(async()=>{await native.close();await fs.rm(dataDir,{recursive:true,force:true});});return{native,dataDir};}
async function raster(native,input,width,height,extra={}){const asset=await native.storeAsset(await sharp(input,{raw:{width,height,channels:4}}).png().toBuffer());return base({type:'raster',width,height,asset,sourceAsset:asset,sourceFormat:'png',transforms:[],...extra});}
async function noPixels(native,run,noFilesystem=false){const restore=[];for(const key of ['render','renderGraph','renderLayer','readAlpha','storeAlpha','storeAsset','readProjectAsset','validateProjectAsset','segmentSubject'])if(typeof native[key]==='function'){const old=native[key];native[key]=()=>assert.fail(`Unexpected ${key}`);restore.push(()=>{native[key]=old;});}if(noFilesystem)for(const key of ['readFile','writeFile','open','rename','link','stat']){const old=fs[key];fs[key]=()=>assert.fail(`Unexpected fs.${key}`);restore.push(()=>{fs[key]=old;});}try{return await run();}finally{restore.reverse().forEach(fn=>fn());}}

function weights(sigma){const radius=Math.ceil(3*sigma),side=Array.from({length:radius},(_,i)=>Math.exp(-((i+1)**2)/(2*sigma*sigma))),z=1+2*side.reduce((a,b)=>a+b,0),q=side.map(x=>Math.round(x*65536/z));return[...q].reverse().concat(65536-2*q.reduce((a,b)=>a+b,0),q);}
const halfUp=(n,d)=>n<=0n?0:n>=255n*d?255:Number((2n*n+d)/(2n*d));
function reference(input,w,h,sigma,earlyBlurRound=false){
  const out=Buffer.from(input);if(sigma===0){for(let p=0;p<w*h;p++)if(input[4*p+3])out.fill(128,4*p,4*p+3);return out;}
  const k=weights(sigma),r=(k.length-1)/2,axis=(position,size)=>{const q=Array(size).fill(0n);k.forEach((v,i)=>{q[Math.max(0,Math.min(size-1,position+i-r))]+=BigInt(v);});return q;};
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const at=4*(y*w+x);if(!input[at+3])continue;const xs=axis(x,w),ys=axis(y,h),n=[0n,0n,0n];let d=0n;
    for(let sy=0;sy<h;sy++)for(let sx=0;sx<w;sx++){const i=4*(sy*w+sx),weight=xs[sx]*ys[sy]*BigInt(input[i+3]);d+=weight;for(let c=0;c<3;c++)n[c]+=weight*BigInt(input[i+c]);}
    assert.ok(d>0n);for(let c=0;c<3;c++)out[at+c]=halfUp((128n+BigInt(input[at+c]))*d-(earlyBlurRound?BigInt(halfUp(n[c],d))*d:n[c]),d);
  }
  return out;
}
function fraction(value){let n=value,q=1n;while(!Number.isInteger(n)){n*=2;q*=2n;}return[BigInt(n),q];}
function blend(b,f,opacity,mode){
  if(!mode||mode==='normal')return Math.max(0,Math.min(255,Math.round(b+(f-b)*opacity)));
  let n,d=1n;const B=BigInt(b),F=BigInt(f),[p,q]=fraction(opacity);
  if(mode==='multiply'){n=B*F;d=255n;}else if(mode==='screen'){n=255n*(B+F)-B*F;d=255n;}else if(mode==='overlay'){n=b<=127?2n*B*F:65025n-2n*(255n-B)*(255n-F);d=255n;}else if(mode==='linear_light')n=BigInt(Math.max(0,Math.min(255,b+2*f-255)));else throw Error(mode);
  return halfUp(B*d*q+(n-B*d)*p,d*q);
}
function stack(input,w,h,entries){let out=Buffer.from(input);for(const f of entries){if(!f.enabled||!f.opacity)continue;const candidate=f.kind==='invert'?Buffer.from(out.map((v,i)=>i%4===3?v:255-v)):reference(out,w,h,f.value);for(let i=0;i<out.length;i+=4)if(out[i+3])for(let c=0;c<3;c++)out[i+c]=blend(out[i+c],candidate[i+c],f.opacity,f.blendMode);}return out;}

test('actual High Pass ring matches independent two-dimensional BigInt residuals, not rounded blur subtraction',async()=>{
  let state=0x769c2;const next=()=>state=(Math.imul(state,1664525)+1013904223)>>>0,sigmas=[0,Number.MIN_VALUE,.001,.1,.3977,.528474,1,2.125,10,50];
  for(let trial=0;trial<60;trial++){
    const w=1+next()%9,h=1+next()%7,sigma=sigmas[trial%sigmas.length],input=image(w,h,(_,__,i)=>[next()>>>24,next()>>>24,next()>>>24,[0,1,128,255][i%4]]),saved=Buffer.from(input),expected=reference(input,w,h,sigma);
    const actual=await sourceSpatialCandidate(input,w,h,filter(sigma));assert.deepEqual(actual,expected);assert.notEqual(actual,input);assert.deepEqual(await applyLayerFilters(input,w,h,[filter(sigma)]),expected);assert.deepEqual(input,saved);
    const hidden=Buffer.from(input);for(let i=0;i<w*h;i++)if(!input[4*i+3])for(let c=0;c<3;c++)hidden[4*i+c]^=255;
    const changed=await sourceSpatialCandidate(hidden,w,h,filter(sigma));for(let i=0;i<w*h;i++)assert.deepEqual(changed.subarray(4*i,4*i+4),(input[4*i+3]?actual:hidden).subarray(4*i,4*i+4));
  }
  const tie=Buffer.from([80,80,80,255,144,144,144,255]),expected=Buffer.from([126,126,126,255,131,131,131,255]);assert.deepEqual(reference(tie,2,1,.3977),expected);assert.notDeepEqual(reference(tie,2,1,.3977,true),expected);assert.deepEqual(await applyLayerFilters(tie,2,1,[filter(.3977)]),expected);
  for(const sigma of [0,Number.MIN_VALUE,1,50])for(const alpha of [1,128,255]){const input=image(7,5,(_,__,i)=>i%4?[21,127,239,alpha]:[254,3,177,0]),actual=await sourceSpatialCandidate(input,7,5,filter(sigma));for(let i=0;i<35;i++)assert.deepEqual([...actual.subarray(4*i,4*i+4)],input[4*i+3]?[128,128,128,alpha]:[254,3,177,0]);}
});

test('sigma zero is a real gray candidate; Overlay and Soft Light neutrality does not generalize to other modes',async()=>{
  const input=image(256,4,(x,y)=>[x,255-x,(x*73)%256,[0,1,128,255][y]]),copy=Buffer.from(input);
  const plan=sourceSpatialPlan(filter(),256,4);assert.equal(plan.computesCandidate,true);assert.equal(plan.cacheBytes,0);assert.equal(plan.work,1024);assert.equal(layerFilterSpatialCacheBytes([filter()],256,4),0);
  assert.deepEqual(await applyLayerFilters(input,256,4,[filter()]),reference(input,256,4,0));assert.notDeepEqual(await applyLayerFilters(input,256,4,[filter()]),input);
  for(const mode of ['overlay','soft_light'])for(const opacity of [Number.MIN_VALUE,.1,.37,.5,.5+2**-53,.75,1])assert.deepEqual(await applyLayerFilters(input,256,4,[filter(0,{blendMode:mode,opacity})]),input);
  const altered=await applyLayerFilters(input,256,4,[filter(0,{blendMode:'linear_light'})]);for(let i=0;i<input.length;i+=4)for(let c=0;c<4;c++)assert.equal(altered[i+c],c===3||!input[i+3]?input[i+c]:Math.min(255,input[i+c]+1));
  for(const bypass of [{enabled:false},{opacity:0}]){const f=filter(0,{...bypass,blendMode:'multiply'});assert.equal(sourceSpatialPlan(f,256,4).computesCandidate,false);assert.equal(filterWork(f,1024),0);assert.deepEqual(await applyLayerFilters(input,256,4,[f]),input);}
  assert.equal(filterWork(filter(0,{blendMode:'overlay'}),1024),41*1024);assert.deepEqual(input,copy);
});

test('source-alpha order and candidate quantization survive affine geometry, positioned density masks, isolated clipping and Bake',async t=>{
  const{native}=await fixture(t),w=9,h=7,input=image(w,h,(x,y,i)=>[x*29,y*37,i*53%256,[0,1,128,255][i%4]]),alpha=Buffer.from(Array.from({length:w*h},(_,i)=>[255,1,128,197,0][i%5]));
  const entries=[filter(.3977,{opacity:.625,blendMode:'overlay'}),filter(0,{kind:'invert',value:100,opacity:.25}),filter(1.2,{opacity:.37,blendMode:'multiply'})];
  const group=base({type:'group',mode:'isolated',blendMode:'screen',opacity:.7,mask:{x:1,y:0,width:7,height:6},maskDensity:.4});
  const content=await raster(native,input,w,h,{parentId:group.id,filters:entries,alphaAsset:await native.storeAlpha(alpha,w,h),transforms:[{type:'affine',width:w,height:h,x:.4,y:-.3,scaleX:1.1,scaleY:.9,rotation:17,flipX:false,flipY:false}],mask:{shape:'positioned',sourceWidth:w,sourceHeight:h,x:1,y:-1,source:{shape:'ellipse',x:1,y:1,width:5,height:4,feather:1.2,invert:true}},maskDensity:.5});
  const effective=Buffer.from(input);for(let i=0;i<alpha.length;i++)effective[i*4+3]=halfUp(BigInt(input[i*4+3])*BigInt(alpha[i]),255n);
  const expected=stack(effective,w,h,entries);assert.deepEqual(await native.renderLayer({...content,transforms:[]}),expected);assert.notDeepEqual(expected,stack(effective,w,h,[...entries].reverse()));
  const member=base({type:'solid',width:w,height:h,color:'#7d4ac1',transforms:[],parentId:group.id,clipBaseId:content.id,opacity:.43}),protectedTop=await raster(native,image(w,h,(x,y)=>[177,123,81,x>6&&y>4?255:0]),w,h,{protected:true});
  let doc=await project(native,w,h,[base({type:'solid',width:w,height:h,transforms:[],color:'#aabbcc'}),group,content,member,protectedTop],{selection:{shape:'rectangle',x:2,y:2,width:2,height:2}});
  const before=await native.renderGraph(doc),assets=await files(native.assetsDir),old=structuredClone(content);doc=(await edit(native,doc,'bake_layer_filters',{layerId:content.id})).document;
  const baked=doc.layers.find(l=>l.id===content.id),stored=await decode(await fs.readFile(path.join(native.assetsDir,baked.asset)));for(let i=0;i<alpha.length;i++)expected[i*4+3]=input[i*4+3];assert.deepEqual(stored,expected);assert.deepEqual(await native.renderGraph(doc),before);
  for(const key of Object.keys(old).filter(k=>!['asset','filters'].includes(k)))assert.deepEqual(baked[key],old[key]);for(const[name,data]of Object.entries(assets))assert.deepEqual(await fs.readFile(path.join(native.assetsDir,name)),data);
});

test('zero and positive High Pass retain original protected context, generated clipping exclusions and structural Bake guards',async t=>{
  const{native}=await fixture(t),w=9,h=7,person=await raster(native,image(w,h,(x,y)=>[188,127,81,x<3&&y>1?[1,128,255][x]:0]),w,h,{protected:true}),original=image(w,h,(x,y)=>[x%2?220:20,y*35,150,255]);
  const group=base({type:'group',mode:'isolated',opacity:.6}),content=await raster(native,original,w,h,{parentId:group.id,filters:[filter(0)]}),generated=await raster(native,image(w,h,[33,88,199,173]),w,h,{parentId:group.id,clipBaseId:content.id,role:'generated',provenance:{jobId:randomUUID(),mode:'generate'},filters:[filter(1,{blendMode:'overlay'})]});
  for(const sigma of [0,1]){
    const current={...content,filters:[filter(sigma)]},doc=await project(native,w,h,[person,group,current,generated]),footprint=await native.protectedPixels(doc,{beforeLayerId:current.id}),altered=await native.renderLayer(current,{protectedPixels:footprint});let restored=0,changed=0;
    for(let i=0;i<w*h;i++)if(footprint[i]){assert.deepEqual(altered.subarray(i*4,i*4+3),original.subarray(i*4,i*4+3));restored++;}else if(!altered.subarray(i*4,i*4+3).equals(original.subarray(i*4,i*4+3)))changed++;assert.ok(restored&&changed);
    const actual=await native.renderGraph(doc),control=await native.renderGraph({...doc,layers:doc.layers.filter(l=>l.id!==generated.id).map(l=>l.id===current.id?{...l,filters:[]}:l)});for(let i=0;i<w*h;i++)if(footprint[i])assert.deepEqual(actual.subarray(i*4,i*4+4),control.subarray(i*4,i*4+4));
    const preview=await native.execute('get_layer_preview',{documentId:doc.id,layerId:generated.id,view:'layer',maxWidth:32}),rgba=await decode(Buffer.from(preview.data,'base64'));for(let i=0;i<w*h;i++)if(footprint[i])assert.equal(rgba[i*4+3],0);
  }
  const hidden=await project(native,w,h,[{...person,visible:false},{...content,parentId:undefined,filters:[filter(0,{blendMode:'overlay'})]}]);
  await noPixels(native,()=>assert.rejects(edit(native,hidden,'bake_layer_filters',{layerId:content.id}),{code:'FILTER_BAKE_PROTECTED_CONTEXT'}));await noPixels(native,()=>assert.rejects(edit(native,hidden,'set_layer_protection',{layerId:content.id,protected:true}),{code:'PROTECTED_LAYER'}));await noPixels(native,()=>assert.rejects(edit(native,hidden,'add_layer_filter',{layerId:person.id,kind:'high_pass',value:0}),{code:'PROTECTED_LAYER'}));
});

test('zero-to-positive ring activation counts shared noise, retained masks, groups and clipping before any pixel operation',async t=>{
  const{native}=await fixture(t),w=8192,h=64,s=w*h,hash='a'.repeat(64),outer=base({type:'group',mode:'isolated',opacity:.5}),inner=base({type:'group',mode:'isolated',parentId:outer.id,opacity:.5});
  const content=base({type:'raster',width:w,height:h,asset:hash,sourceAsset:hash,transforms:[],parentId:inner.id,filters:[filter(0)]}),member=base({type:'solid',width:w,height:h,color:'#ffffff',transforms:[],parentId:inner.id,clipBaseId:content.id});
  const retained=(width,height)=>base({type:'solid',width:w,height:h,color:'#ffffff',transforms:[],visible:false,mask:{shape:'positioned',sourceWidth:width,sourceHeight:height,x:0,y:0,source:{shape:'bitmap',x:0,y:0,width,height,runs:[],feather:0,invert:false}}});
  const noise=base({type:'raster',width:1,height:1,asset:hash,sourceAsset:hash,transforms:[{type:'resize',width:w,height:h}],filters:[filter(0,{kind:'add_noise',parameters:{distribution:'gaussian'}})]});
  const graph={name:'High Pass ring and other-leaf table',width:w,height:h,selection:null,layers:[noise,outer,inner,content,member,...Array.from({length:5},()=>retained(6000,4000)),retained(3850,2000)]};
  const estimate=validateLayerFilterResources(graph,layerTree(graph.layers));assert.equal(estimate.estimatedScratchBytes,24*s+2*127_700_000+4096);assert.equal(estimate.estimatedScratchBytes,267_987_008);
  const changed=value=>({...graph,layers:graph.layers.map(l=>l.id===content.id?{...l,filters:[{...content.filters[0],value}]}:l)}),tiny=changed(.01);
  assert.equal(validateLayerFilterResources(tiny,layerTree(tiny.layers)).estimatedScratchBytes,estimate.estimatedScratchBytes+393252);
  const over=changed(1);assert.equal(sourceSpatialPlan(filter(1),w,h).cacheBytes,917588);assert.throws(()=>validateLayerFilterResources(over,layerTree(over.layers)),{code:'LIMIT_EXCEEDED'});
  const doc=await project(native,w,h,graph.layers),args={layerId:content.id,filterId:content.filters[0].id,value:1};
  await noPixels(native,()=>assert.rejects(edit(native,doc,'update_layer_filter',args),{code:'LIMIT_EXCEEDED'}));await noPixels(native,()=>assert.rejects(edit(native,doc,'apply_transaction',{operations:[{command:'update_layer_filter',args},{command:'rasterize_layer',args:{layerId:noise.id}}]}),{code:'LIMIT_EXCEEDED'}));assert.deepEqual(await get(native,doc),doc);assert.deepEqual(await fs.readdir(native.assetsDir),[]);
});

test('Bake reserves one actual High Pass ring plus a shared table in every phase and refuses oversized materialization before source decode',async t=>{
  const{native,dataDir}=await fixture(t),w=8192,h=1925,s=w*h,hp=filter(.01),noise=filter(0,{kind:'add_noise',parameters:{distribution:'gaussian'}});
  const zero=estimateFilterBakeBytes({width:w,height:h,hasAlpha:true,filters:[filter(0)]}),positive=estimateFilterBakeBytes({width:w,height:h,hasAlpha:true,filters:[hp]}),shared=estimateFilterBakeBytes({width:w,height:h,hasAlpha:true,filters:[hp,noise]});
  assert.equal(positive.spatialCacheBytes,393252);assert.equal(positive.filterBytes,17*s+393252+65536);assert.equal(layerFilterSharedBytes([hp]),0);for(const key of ['decodeBytes','filterBytes','encodeBytes','publicationBytes'])assert.equal(shared[key],positive[key]+4096);
  assert.ok(zero.estimatedWorkingBytes<=zero.maxWorkingBytes);assert.ok(positive.estimatedWorkingBytes>positive.maxWorkingBytes);
  const tiny=await raster(native,Buffer.from([20,80,170,255]),1,1),layer={...tiny,width:w,height:h,alphaAsset:tiny.asset,filters:[hp]};await assert.rejects(bakeFilterSource({layer,filters:[hp],assetsDir:native.assetsDir,tempRoot:dataDir}),{code:'LIMIT_EXCEEDED'});assert.equal((await fs.readdir(dataDir)).some(name=>name.startsWith('.filter-bake-')),false);
});

test('metadata recipes and hidden work activations share the exact High Pass cost without reading missing sources',async t=>{
  const{native}=await fixture(t),source=base({type:'raster',width:2000,height:2000,asset:'a'.repeat(64),sourceAsset:'a'.repeat(64),transforms:[],visible:false});let doc=await project(native,2000,2000,[source]);
  const definition={name:'Detail and explicit blend',slots:[{key:'photo',type:'raster'}],steps:[{command:'add_layer_filter',target:'photo',args:{kind:'high_pass',value:1,blendMode:'overlay'}},{command:'add_layer_filter',target:'photo',args:{kind:'high_pass',value:1,blendMode:'screen'}}]};
  const saved=await noPixels(native,()=>edit(native,doc,'save_edit_recipe',definition));doc=saved.document;const args={recipeId:saved.recipeId,bindings:{photo:source.id}},report=await noPixels(native,()=>edit(native,doc,'validate_edit_recipe',args),true);assert.equal(report.valid,false);assert.equal(report.issues[0].stepIndex,1);assert.equal(report.issues[0].code,'LIMIT_EXCEEDED');await noPixels(native,()=>assert.rejects(edit(native,doc,'apply_edit_recipe',args),{code:'LIMIT_EXCEEDED'}));assert.deepEqual(await get(native,doc),doc);
  const valid=await noPixels(native,()=>edit(native,doc,'save_edit_recipe',{...definition,steps:[{...definition.steps[0],args:{kind:'high_pass',value:0}}]}));doc=valid.document;const validArgs={recipeId:valid.recipeId,bindings:args.bindings};assert.equal((await noPixels(native,()=>edit(native,doc,'validate_edit_recipe',validArgs),true)).valid,true);doc=(await noPixels(native,()=>edit(native,doc,'apply_edit_recipe',validArgs))).document;
  assert.equal(doc.layers[0].filters[0].value,0);const filterId=doc.layers[0].filters[0].id;await noPixels(native,()=>assert.rejects(edit(native,doc,'update_layer_filter',{layerId:source.id,filterId,value:50}),{code:'LIMIT_EXCEEDED'}));
  doc=(await noPixels(native,()=>edit(native,doc,'update_layer_filter',{layerId:source.id,filterId,value:50,enabled:false}))).document;await noPixels(native,()=>assert.rejects(edit(native,doc,'update_layer_filter',{layerId:source.id,filterId,enabled:true}),{code:'LIMIT_EXCEEDED'}));assert.deepEqual(await fs.readdir(native.assetsDir),[]);
});

test('malformed inactive portable values and source-only parameters reject before assets; real save and late Bake failures roll back',async t=>{
  const{native}=await fixture(t),source=await raster(native,image(9,7,(x,y)=>[x*29,y*37,128,255]),9,7,{filters:[filter(0)]}),doc=await project(native,9,7,[source]);await native.execute('get_preview',{documentId:doc.id,maxWidth:32});
  const assets=await files(native.assetsDir),projects=await files(native.projectsDir),cache=native.previewCache.stats(),directory=native.projectsDir;native.projectsDir=path.join(native.assetsDir,source.asset);
  try{await assert.rejects(edit(native,doc,'update_layer_filter',{layerId:source.id,filterId:source.filters[0].id,value:1}),{code:'ENOTDIR'});await assert.rejects(edit(native,doc,'bake_layer_filters',{layerId:source.id}),{code:'ENOTDIR'});}finally{native.projectsDir=directory;}
  await assert.rejects(edit(native,doc,'apply_transaction',{operations:[{command:'update_layer_filter',args:{layerId:source.id,filterId:source.filters[0].id,value:.3977}},{command:'bake_layer_filters',args:{layerId:source.id}},{command:'set_layer',args:{layerId:randomUUID(),visible:false}}]}),{code:'NOT_FOUND'});
  assert.deepEqual(await get(native,doc),doc);assert.deepEqual(await files(native.assetsDir),assets);assert.deepEqual(await files(native.projectsDir),projects);assert.deepEqual(native.previewCache.stats(),cache);
  for(const bad of [{value:-1},{value:50.0001},{value:'1'},{value:null},{parameters:{sigma:1}},{parameters:{amount:0}}]){
    const entry={...filter(0,{enabled:false,opacity:0}),...bad};assert.throws(()=>normalizeLayerFilter(entry));const graph={name:'Malformed High Pass',width:9,height:7,selection:null,layers:[{...source,filters:[entry]}]},data=await encodeProjectBundle({graph,validateGraph:()=>{},readAsset:async()=>assets[source.asset]});await noPixels(native,()=>assert.rejects(native.importProject({data}),{code:'INVALID_PROJECT_BUNDLE'}),true);
  }
  assert.equal(normalizeLayerFilter(filter(0,{parameters:{}})).parameters,undefined);await noPixels(native,()=>assert.rejects(edit(native,doc,'add_adjustment',{kind:'high_pass',value:1})));assert.deepEqual(await files(native.assetsDir),assets);assert.deepEqual(await files(native.projectsDir),projects);
});

test('zero gray-fill and positive spatial paths yield on wide sources and never alias caller RGBA',async()=>{
  const w=8192,h=16,input=image(w,h,(_,__,i)=>[73,129,207,i%2?128:0]),copy=Buffer.from(input);
  for(const sigma of [0,Number.MIN_VALUE,.001]){let ticked=false;const pending=sourceSpatialCandidate(input,w,h,filter(sigma));setImmediate(()=>{ticked=true;});const out=await pending;assert.equal(ticked,true);assert.notEqual(out,input);for(let i=0;i<input.length;i+=4)assert.deepEqual([...out.subarray(i,i+4)],input[i+3]?[128,128,128,128]:[73,129,207,0]);}
  assert.deepEqual(input,copy);
});
