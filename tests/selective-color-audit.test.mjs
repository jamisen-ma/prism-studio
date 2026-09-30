import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { normalizeParameters, COLOR_MAPPING_KINDS } from '../server/color.mjs';
import { applyLayerFilters, filterWork, layerFilterSpatialCacheBytes, layerFilterSharedBytes } from '../server/layer-filters.mjs';
import { editRecipeHash } from '../server/edit-recipes.mjs';
import { encodeProjectBundle, decodeProjectBundle } from '../server/project-bundle.mjs';
import {
  SELECTIVE_COLOR_POLICY, SELECTIVE_COLOR_RANGES, SELECTIVE_COLOR_METHODS,
  normalizeSelectiveColorParameters, selectiveColorIsIdentity, selectiveColorTransform,
} from '../server/selective-color.mjs';
import { RANGE_NAMES, referenceMembership, selectiveColorReference } from './fixtures/selective-color/exact-reference.mjs';

const everyRange = row => Object.fromEntries(RANGE_NAMES.map(name => [name, [...row]]));
const invalid = value => assert.throws(() => normalizeSelectiveColorParameters(value), {code:'INVALID_ARGUMENT'});

test('Selective Color production bytes agree with independent cube decomposition and exact nine-row arithmetic', () => {
  assert.equal(SELECTIVE_COLOR_POLICY,'rgb-partition-cmyk-v1');
  assert.deepEqual(SELECTIVE_COLOR_RANGES,RANGE_NAMES);
  assert.deepEqual(SELECTIVE_COLOR_METHODS,['relative','absolute']);
  const values=[0,1,63,64,127,128,191,254,255], pixels=[];
  for(const r of values)for(const g of values)for(const b of values)pixels.push([r,g,b]);
  const parameters=[{}, {method:'absolute'}];
  for(const method of ['relative','absolute'])for(const range of RANGE_NAMES)for(let channel=0;channel<4;channel++)for(const amount of [-100,100]){
    const row=[0,0,0,0];row[channel]=amount;parameters.push({method,[range]:row});
  }
  let seed=0x51ec710;
  const random=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
  for(let i=0;i<48;i++)parameters.push({method:i%2?'relative':'absolute',...Object.fromEntries(RANGE_NAMES.map(name=>[name,Array.from({length:4},()=>((random()%20001)-10000)/100)]))});
  for(const p of parameters){
    const transform=selectiveColorTransform(p);
    for(const rgb of pixels)assert.deepEqual(transform(...rgb),selectiveColorReference(rgb,p));
  }
  // Pin gray midpoint and color/white mixtures separately from output clipping.
  assert.deepEqual(referenceMembership([255,128,255]),[0,0,0,0,0,127,128,0,0]);
  assert.deepEqual(referenceMembership([127,127,127]),[0,0,0,0,0,0,0,254,1]);
  assert.deepEqual(referenceMembership([128,128,128]),[0,0,0,0,0,0,1,254,0]);
});

test('Selective Color sums before clipping and rounding, with exact half-up and native Relative endpoint behavior', () => {
  const cases=[
    [[255,255,255],{whites:[100,100,100,100]},[255,255,255]],
    [[255,255,255],{method:'absolute',whites:[50,0,0,0]},[128,255,255]],
    [[255,128,255],{method:'absolute',whites:[50,0,0,0]},[191,128,255]],
    [[255,0,0],{reds:[0,0,0,100]},[255,0,0]],
    [[255,0,0],{method:'absolute',reds:[0,0,0,50]},[128,0,0]],
    [[255,0,0],{method:'absolute',reds:[100,0,0,-100]},[255,255,255]],
    [[200,100,50],{method:'absolute',reds:[100,0,0,0],neutrals:[-100,0,0,0]},[200,100,50]],
    [[255,128,255],{method:'absolute',magentas:[1,0,0,0],whites:[1,0,0,0]},[252,128,255]],
    [[200,128,40],everyRange([50,0,0,0]),[173,128,40]],
    [[200,128,40],everyRange([-50,0,0,0]),[228,128,40]],
  ];
  for(const [rgb,p,expected] of cases){assert.deepEqual(selectiveColorReference(rgb,p),expected);assert.deepEqual(selectiveColorTransform(p)(...rgb),expected);}
  for(const [amount,absolute,relative] of [[49.99,128,173],[50,128,173],[50.01,127,172]]){
    assert.deepEqual(selectiveColorTransform({method:'absolute',whites:[amount,0,0,0]})(255,255,255),[absolute,255,255]);
    assert.deepEqual(selectiveColorTransform(everyRange([amount,0,0,0]))(200,128,40),[relative,128,40]);
  }
  for(const method of ['relative','absolute']){
    const cancellation={method,...everyRange([-33.33,-33.33,-33.33,33.33])};
    assert.equal(selectiveColorIsIdentity(cancellation),false,'nonzero authored controls retain computing admission');
    const transform=selectiveColorTransform(cancellation);
    for(let c=0;c<256;c++)assert.deepEqual(transform(c,255-c,c^128),[c,255-c,c^128]);
  }
});

test('Selective Color strict normalization rejects executable or malformed metadata without invoking accessors', () => {
  let calls=0;
  const getter=()=>{calls++;throw new Error('Getter must not be evaluated');};
  const ownGetter=Object.defineProperty({},'reds',{enumerable:true,get:getter});
  const methodGetter=Object.defineProperty({},'method',{enumerable:true,get:getter});
  const rowGetter=[0,0,0,0];Object.defineProperty(rowGetter,'2',{enumerable:true,get:getter});
  const rowHidden=[0,0,0,0];Object.defineProperty(rowHidden,'2',{enumerable:false,value:0});
  const hidden=Object.defineProperty({},'reds',{enumerable:false,value:[0,0,0,0]});
  const rowSurplus=[0,0,0,0];rowSurplus.extra=0;
  const rowSymbol=[0,0,0,0];rowSymbol[Symbol('extra')]=0;
  const sparse=Array(4);sparse[0]=sparse[1]=sparse[3]=0;
  const foreign=Object.create({reds:[0,0,0,0]});
  class Row extends Array {}
  for(const value of [null,[],true,0,'relative',foreign,ownGetter,methodGetter,hidden,
    {method:null},{method:false},{method:'Relative'},{method:'future'},{unknown:0},{[Symbol('unknown')]:0},
    {reds:null},{reds:{}},{reds:[0,0,0]},{reds:[0,0,0,0,0]},{reds:sparse},{reds:new Row(0,0,0,0)},
    {reds:rowGetter},{reds:rowHidden},{reds:rowSurplus},{reds:rowSymbol},
    ...[NaN,Infinity,-Infinity,'0',null,true,100.01,-100.01,.001,Number.MIN_VALUE].map(x=>({reds:[0,0,0,x]}))])invalid(value);
  assert.equal(calls,0);
  assert.throws(()=>selectiveColorIsIdentity({blacks:[0,0,0,.001]}),{code:'INVALID_ARGUMENT'});
  assert.throws(()=>selectiveColorTransform({method:'future'}),{code:'INVALID_ARGUMENT'});
  const plainNull=Object.assign(Object.create(null),{method:'absolute',blacks:[-100,-.29,0,100]});
  assert.deepEqual(normalizeSelectiveColorParameters(plainNull).blacks,[-100,-.29,0,100]);
});

test('Selective Color defaults, identity predicate and compiled snapshots own all rows without sharing output tuples', () => {
  const defaults=normalizeSelectiveColorParameters();
  assert.deepEqual(defaults,{method:'relative',...everyRange([0,0,0,0])});
  for(const name of RANGE_NAMES)for(const other of RANGE_NAMES)if(name!==other)assert.notEqual(defaults[name],defaults[other]);
  assert.equal(selectiveColorIsIdentity(),true);assert.equal(selectiveColorIsIdentity({method:'absolute'}),true);
  const negativeZero=normalizeSelectiveColorParameters({reds:[-0,0,-0,0]});assert.equal(Object.is(negativeZero.reds[0],-0),false);
  assert.equal(selectiveColorIsIdentity(negativeZero),true);
  const authored={method:'absolute',reds:[25,-.01,0,-12.5],whites:[50,0,0,0]};
  const saved=structuredClone(authored), normalized=normalizeSelectiveColorParameters(authored), transform=selectiveColorTransform(authored);
  assert.deepEqual(authored,saved);assert.notEqual(normalized.reds,authored.reds);
  authored.reds.fill(100);authored.method='relative';normalized.whites.fill(-100);
  for(const rgb of [[255,0,0],[255,255,255],[200,100,50]])assert.deepEqual(transform(...rgb),selectiveColorReference(rgb,saved));
  const first=transform(255,255,255);first[0]=0;assert.deepEqual(transform(255,255,255),[128,255,255]);
  const identity=selectiveColorTransform(Object.freeze({method:'absolute',reds:Object.freeze([0,0,0,0])}));
  const tuple=identity(17,80,223);assert.deepEqual(tuple,[17,80,223]);tuple[0]=255;assert.deepEqual(identity(17,80,223),[17,80,223]);
  const other=selectiveColorTransform({method:'relative',...everyRange([10,-20,30,0])});
  for(let c=0;c<256;c++){
    const rgb=[c,255-c,c^128];assert.deepEqual(identity(...rgb),rgb);
    assert.deepEqual(other(...rgb),selectiveColorReference(rgb,{method:'relative',...everyRange([10,-20,30,0])}));
    assert.deepEqual(transform(...rgb),selectiveColorReference(rgb,saved));
  }
});

const treatment={method:'absolute',reds:[35,-20,10,-5],whites:[50,0,0,0],neutrals:[-10,5,-20,3],blacks:[0,0,0,-25]};
const base=extra=>({id:randomUUID(),name:'Independent Selective Color audit',visible:true,opacity:1,blendMode:'normal',...extra});
const filter=(parameters={},extra={})=>({id:randomUUID(),kind:'selective_color',value:0,enabled:true,opacity:1,parameters,...extra});
const fake=(width,height,extra={})=>base({type:'raster',width,height,asset:'a'.repeat(64),sourceAsset:'a'.repeat(64),transforms:[],...extra});
const image=(w,h)=>Buffer.from(Array.from({length:w*h},(_,p)=>[p*37%256,p*73%256,p*97%256,[0,1,128,255][p%4]]).flat());
const bitmap=(bytes,width,height,extra={})=>({shape:'bitmap',x:0,y:0,width,height,runs:Array.from(bytes).flatMap((v,i)=>v?[i,1,v]:[]),feather:0,invert:false,...extra});
const mask=(width,height,extra={})=>({sourceWidth:width,sourceHeight:height,coverage:{shape:'rectangle',x:0,y:0,width,height,feather:0,invert:false},density:1,enabled:true,...extra});
const graph=(native,doc)=>{const p=native.projects.get(doc.id);return structuredClone(p.states[p.cursor].graph);};
const get=async(native,doc)=>(await native.execute('get_document',{documentId:doc.id})).document;
const edit=(native,doc,command,args={})=>native.execute(command,{documentId:doc.id,expectedRevision:doc.revision,...(command==='apply_transaction'?{label:'Selective Color audit'}:{}),...args});
const project=async(native,width,height,layers,extra={})=>(await native.newProject({name:'Selective Color audit',width,height,selection:null,layers,...extra},'Fixture')).document;
const files=async dir=>Object.fromEntries(await Promise.all((await fs.readdir(dir)).sort().map(async name=>[name,await fs.readFile(path.join(dir,name))])));
const half=(n,d)=>Number((2n*BigInt(n)+BigInt(d))/(2n*BigInt(d)));
async function fixture(t){const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'prism-selective-audit-'));const native=await new NativeBackend({dataDir,segmentSubject:()=>assert.fail('No model for Selective Color')}).init();t.after(async()=>{await native.close();await fs.rm(dataDir,{recursive:true,force:true});});return{native};}
async function raster(native,input,width,height,extra={}){const asset=await native.storeAsset(await sharp(input,{raw:{width,height,channels:4}}).png().toBuffer());return fake(width,height,{asset,sourceAsset:asset,...extra});}
async function noPixels(native,operation,noIO=false){const saved=[],calls=[];for(const key of ['render','renderGraph','renderLayer','readAlpha','storeAlpha','storeAsset','readProjectAsset','validateProjectAsset','segmentSubject']){const old=native[key];native[key]=()=>{calls.push(key);assert.fail(`Unexpected pixel access: ${key}`);};saved.push(()=>{native[key]=old;});}if(noIO)for(const key of ['readFile','writeFile','open','rename','link','unlink','mkdir','stat']){const old=fs[key];fs[key]=()=>{calls.push(`fs.${key}`);assert.fail(`Unexpected fs.${key}`);};saved.push(()=>{fs[key]=old;});}try{return await operation();}finally{saved.reverse().forEach(restore=>restore());assert.deepEqual(calls,[],'No pixel or forbidden filesystem call may be swallowed as a validation refusal');}}

test('native sparse and partial Selective settings preserve other rows while exact work activation refuses before image I/O',async t=>{
  const {native}=await fixture(t),w=8,h=6,source=fake(w,h,{filters:[filter({reds:[1,2,3,4]})]});
  const grade=base({type:'adjustment',kind:'selective_color',value:0,parameters:{reds:[1,2,3,4]},mask:{shape:'rectangle',x:0,y:0,width:4,height:h},maskDensity:.31});
  let doc=await project(native,w,h,[source,grade]);
  const old=structuredClone(doc);await noPixels(native,async()=>{native.validateGraph(graph(native,doc));assert.deepEqual(await get(native,doc),old);},true);
  assert.deepEqual(graph(native,doc).layers[1].parameters,{reds:[1,2,3,4]});
  for(const [command,target]of [['update_layer_filter',{layerId:source.id,filterId:source.filters[0].id}],['update_adjustment',{layerId:grade.id}]]){
    doc=(await noPixels(native,()=>edit(native,doc,command,{...target,parameters:{method:'absolute',blacks:[-10,20,-30,40]}}))).document;
    doc=(await noPixels(native,()=>edit(native,doc,command,{...target,parameters:{reds:[0,0,0,0]}}))).document;
    const actual=command==='update_adjustment'?doc.layers[1].parameters:doc.layers[0].filters[0].parameters;
    assert.deepEqual(actual,{method:'absolute',...everyRange([0,0,0,0]),blacks:[-10,20,-30,40]});
  }
  assert.deepEqual(doc.layers[1].mask,grade.mask);assert.equal(doc.layers[1].maskDensity,.31);assert.deepEqual(await fs.readdir(native.assetsDir),[]);
  for(const [p,weight]of [[{},1],[treatment,12],[everyRange([-50,-50,-50,50]),12]]){
    assert.equal(filterWork(filter(p),100),weight*100);assert.equal(filterWork(filter(p,{blendMode:'multiply'}),100),(weight+40)*100);
    assert.equal(filterWork(filter(p,{enabled:false}),100),0);assert.equal(filterWork(filter(p,{opacity:0}),100),0);
    assert.equal(layerFilterSpatialCacheBytes([filter(p)],6000,4000),0);assert.equal(layerFilterSharedBytes([filter(p)]),0);
  }
  const exact=fake(4000,4000,{visible:false,filters:[filter(treatment),filter(treatment)]}),atLimit=await project(native,4000,4000,[exact]);
  await noPixels(native,()=>assert.rejects(edit(native,atLimit,'add_layer_filter',{layerId:exact.id,kind:'selective_color',value:0}),{code:'LIMIT_EXCEEDED'}),true);
  const active=fake(4000,3000,{visible:false,filters:[filter(treatment),filter(treatment),filter()]}),activation=await project(native,4000,3000,[active]);
  await noPixels(native,()=>assert.rejects(edit(native,activation,'update_layer_filter',{layerId:active.id,filterId:active.filters[2].id,parameters:{reds:[.01,0,0,0]}}),{code:'LIMIT_EXCEEDED'}),true);
  const scoped=fake(6000,3200,{visible:false,filters:{version:1,entries:[filter(treatment),filter()],mask:mask(6000,3200,{enabled:false})}}),masked=await project(native,6000,3200,[scoped]);
  await noPixels(native,()=>assert.rejects(edit(native,masked,'modify_layer_filter_mask',{layerId:scoped.id,enabled:true}),{code:'LIMIT_EXCEEDED'}),true);
  assert.deepEqual(await get(native,activation),activation);assert.deepEqual(await get(native,masked),masked);assert.deepEqual(await fs.readdir(native.assetsDir),[]);
});

test('complete default and sparse Selective recipes reset targets, preserve source mask scope and validate without I/O',async t=>{
  const {native}=await fixture(t),w=8,h=6;
  for(const authored of [{},{method:'absolute',yellows:[12.34,-56.78,90,-1]}]){
    const scope=mask(w,h,{coverage:bitmap(Uint8Array.from({length:w*h},(_,i)=>i*17%256),w,h),density:.37});
    const source=await raster(native,image(w,h),w,h,{filters:{version:1,entries:[filter(treatment)],mask:scope}});
    const grade=base({type:'adjustment',kind:'selective_color',value:0,parameters:normalizeSelectiveColorParameters(treatment),opacity:.7,mask:{shape:'rectangle',x:0,y:0,width:4,height:h},maskDensity:.31});
    let doc=await project(native,w,h,[source,grade]),control=await project(native,w,h,[source,grade]);
    const saved=await noPixels(native,()=>edit(native,doc,'save_edit_recipe',{name:'Full Selective defaults',slots:[{key:'photo',type:'raster'},{key:'grade',type:'adjustment',kind:'selective_color'}],steps:[{command:'update_adjustment',target:'grade',args:{value:0,parameters:authored}},{command:'add_layer_filter',target:'photo',args:{kind:'selective_color',value:0,parameters:authored}}]}));doc=saved.document;
    const recipe=doc.editRecipes.find(r=>r.id===saved.recipeId),hash=editRecipeHash(recipe),complete={method:'relative',...everyRange([0,0,0,0]),...authored};
    assert.deepEqual(recipe.steps[0].args.parameters,complete);assert.deepEqual(recipe.steps[1].args.parameters,complete);
    const args={recipeId:saved.recipeId,bindings:{photo:source.id,grade:grade.id}},before=structuredClone(doc),assets=await files(native.assetsDir);
    const report=await noPixels(native,()=>edit(native,doc,'validate_edit_recipe',args),true);assert.equal(report.valid,true);assert.equal(report.recipeHash,hash);assert.deepEqual(await get(native,doc),before);
    doc=(await noPixels(native,()=>edit(native,doc,'apply_edit_recipe',args))).document;
    control=(await edit(native,control,'update_adjustment',{layerId:grade.id,value:0,parameters:complete})).document;control=(await edit(native,control,'add_layer_filter',{layerId:source.id,...recipe.steps[1].args})).document;
    assert.deepEqual(doc.layers[1].parameters,complete);assert.deepEqual(doc.layers[1].mask,grade.mask);assert.equal(doc.layers[1].maskDensity,grade.maskDensity);
    assert.deepEqual(graph(native,doc).layers[0].filters.mask,scope);assert.deepEqual(await native.renderGraph(graph(native,doc)),await native.renderGraph(graph(native,control)));
    assert.deepEqual(doc.editRecipes.find(r=>r.id===saved.recipeId),recipe);assert.equal(editRecipeHash(recipe),hash);assert.equal(doc.history.length,before.history.length+1);assert.deepEqual(await files(native.assetsDir),assets);
    assert.deepEqual((await edit(native,doc,'undo')).document.layers,before.layers);
  }
  const source=fake(4000,4000,{filters:[filter(treatment),filter(treatment)]});let doc=await project(native,4000,4000,[source]);
  const saved=await edit(native,doc,'save_edit_recipe',{name:'Over budget even as identity',slots:[{key:'photo',type:'raster'}],steps:[{command:'add_layer_filter',target:'photo',args:{kind:'selective_color',value:0}}]});doc=saved.document;
  const args={recipeId:saved.recipeId,bindings:{photo:source.id}},report=await noPixels(native,()=>edit(native,doc,'validate_edit_recipe',args),true);
  assert.equal(report.valid,false);assert.equal(report.issues[0].code,'LIMIT_EXCEEDED');await noPixels(native,()=>assert.rejects(edit(native,doc,'apply_edit_recipe',args),{code:'LIMIT_EXCEEDED'}),true);assert.deepEqual(await get(native,doc),doc);
});

test('native global and source Selective preserve hidden RGB and alpha with their declared opacity and mask stages',async t=>{
  const {native}=await fixture(t),input=Buffer.from([255,255,255,0,255,128,255,1,200,100,50,128,64,80,120,255]),before=Buffer.from(input),raw=[255,128,0,255];
  const layer={kind:'selective_color',value:0,parameters:treatment,opacity:.5,mask:bitmap(raw,4,1),maskDensity:.5};
  assert.equal(COLOR_MAPPING_KINDS.includes('selective_color'),true);
  const result=await native.applyAdjustment(input,4,1,layer,Uint8Array.from([0,0,0,1]));
  for(let p=0;p<4;p++){const rgb=[...input.subarray(p*4,p*4+3)],mapped=selectiveColorReference(rgb,treatment),amount=.5*(255-.5*(255-raw[p]))/255;for(let c=0;c<4;c++)assert.equal(result[p*4+c],c===3||!input[p*4+3]||p===3?input[p*4+c]:Math.round(rgb[c]+(mapped[c]-rgb[c])*amount));}
  const source=await applyLayerFilters(input,4,1,[filter(treatment,{opacity:.5})]);
  for(let p=0;p<4;p++){const rgb=[...input.subarray(p*4,p*4+3)],mapped=selectiveColorReference(rgb,treatment);for(let c=0;c<4;c++)assert.equal(source[p*4+c],c===3||!input[p*4+3]?input[p*4+c]:half(rgb[c]+mapped[c],2));}
  assert.deepEqual(input,before);assert.deepEqual(await native.applyAdjustment(input,4,1,{...layer,opacity:0}),input);
  assert.deepEqual(await applyLayerFilters(Buffer.from([128,128,128,255]),1,1,[filter({}, {blendMode:'multiply'})]),Buffer.from([64,64,64,255]));
});

test('Selective source alpha, sequential candidate/blend and complete-stack mask precede Distort and exact Bake',async t=>{
  const {native}=await fixture(t),w=9,h=7,input=image(w,h),alpha=Uint8Array.from({length:w*h},(_,p)=>[255,128,1,0,199][p%5]),raw=Uint8Array.from({length:w*h},(_,p)=>p*53%256);
  const scope=mask(w,h,{coverage:bitmap(raw,w,h,{invert:true}),density:.1});
  const p2={method:'relative',cyans:[10,0,-20,0],neutrals:[5,10,-5,0],blacks:[-10,0,20,0]},entries=[filter(treatment,{opacity:.625}),filter(p2,{opacity:.5,blendMode:'multiply'})];
  const source=await raster(native,input,w,h,{alphaAsset:await native.storeAlpha(Buffer.from(alpha),w,h),filters:{version:1,entries,mask:scope},mask:{shape:'positioned',sourceWidth:w,sourceHeight:h,x:1,y:-1,source:{shape:'ellipse',x:1,y:1,width:5,height:4,feather:1.2,invert:true}},maskDensity:.5});
  let doc=await project(native,w,h,[source]);const corners=[[1,0],[w+1,0],[w+1,h],[1,h]].map(([x,y])=>({x,y}));doc=(await edit(native,doc,'add_layer_distort',{layerId:source.id,corners})).document;
  const wanted=Buffer.from(input);let orderDiffers=0;
  for(let p=0;p<w*h;p++){
    wanted[p*4+3]=half(input[p*4+3]*alpha[p],255);if(!wanted[p*4+3])continue;
    const original=[...input.subarray(p*4,p*4+3)],a=selectiveColorReference(original,treatment),first=original.map((c,i)=>Math.round(c+(a[i]-c)*.625)),b=selectiveColorReference(first,p2);
    const second=first.map((c,i)=>half(255*c+c*b[i],510)),effective=Math.round(255-.1*raw[p]);
    const wrong=selectiveColorReference(original,p2);if(!Buffer.from(wrong).equals(Buffer.from(b)))orderDiffers++;
    for(let c=0;c<3;c++)wanted[p*4+c]=half(original[c]*(255-effective)+second[c]*effective,255);
  }
  assert.ok(orderDiffers>0);assert.deepEqual(await native.renderLayer({...graph(native,doc).layers[0],transforms:[]}),wanted);
  const translated=Buffer.alloc(input.length);for(let y=0;y<h;y++)wanted.copy(translated,(y*w+1)*4,y*w*4,(y*w+w-1)*4);assert.deepEqual(await native.renderLayer(graph(native,doc).layers[0]),translated);
  const assets=await files(native.assetsDir),appearance=await native.renderGraph(graph(native,doc)),previous=graph(native,doc).layers[0];doc=(await edit(native,doc,'bake_layer_filters',{layerId:source.id})).document;
  const baked=graph(native,doc).layers[0],bytes=await sharp(await fs.readFile(path.join(native.assetsDir,baked.asset))).ensureAlpha().raw().toBuffer();
  for(let p=0;p<w*h;p++){assert.deepEqual(bytes.subarray(p*4,p*4+3),wanted.subarray(p*4,p*4+3));assert.equal(bytes[p*4+3],input[p*4+3]);}
  for(const key of Object.keys(previous).filter(k=>!['asset','filters'].includes(k)))assert.deepEqual(baked[key],previous[key]);assert.deepEqual(baked.filters,[]);assert.equal(doc.layers[0].filterMask,undefined);assert.deepEqual(await native.renderGraph(graph(native,doc)),appearance);
  for(const [name,bytes]of Object.entries(assets))assert.deepEqual(await fs.readFile(path.join(native.assetsDir,name)),bytes);
});

test('Selective generated clipping and isolated groups retain lower protected pixels and guarded source/Bake behavior',async t=>{
  const {native}=await fixture(t),w=9,h=7,count=w*h;
  const personBytes=Buffer.from(Array.from({length:count},(_,p)=>[31,117,209,p%w>=3&&p%w<=5?[1,128,255][p%3]:0]).flat()),person=await raster(native,personBytes,w,h,{protected:true,outline:{width:1,color:'#ffffff'}}),group=base({type:'group',mode:'isolated',opacity:.7});
  const sourceBytes=image(w,h);for(let p=0;p<count;p++)sourceBytes[p*4+3]=255;
  const source=await raster(native,sourceBytes,w,h,{parentId:group.id}),memberBytes=Buffer.from(Array.from({length:count},()=>[29,157,71,177]).flat()),member=await raster(native,memberBytes,w,h,{parentId:group.id,clipBaseId:source.id,role:'generated',provenance:{jobId:randomUUID(),mode:'generate'},visible:false});
  let doc=await project(native,w,h,[person,group,source,member]);const baseline=await native.renderGraph(graph(native,doc)),footprint=await native.protectedPixels(graph(native,doc)),assets=await files(native.assetsDir);
  for(const layerId of [source.id,member.id])doc=(await edit(native,doc,'add_layer_filter',{layerId,kind:'selective_color',value:0,parameters:treatment})).document;doc=(await edit(native,doc,'set_layer',{layerId:member.id,visible:true})).document;
  const actual=await native.renderGraph(graph(native,doc));let changed=0;
  const preview=async(layerId,view='layer')=>{const r=await native.execute('get_layer_preview',{documentId:doc.id,layerId,view,maxWidth:32});return sharp(Buffer.from(r.data,'base64')).ensureAlpha().raw().toBuffer();};
  const sourceView=await preview(source.id),memberView=await preview(member.id);
  for(let p=0;p<count;p++)if(footprint[p]){assert.deepEqual(actual.subarray(p*4,p*4+4),baseline.subarray(p*4,p*4+4));assert.deepEqual(sourceView.subarray(p*4,p*4+3),sourceBytes.subarray(p*4,p*4+3));assert.equal(memberView[p*4+3],0);}else if(!actual.subarray(p*4,p*4+4).equals(baseline.subarray(p*4,p*4+4)))changed++;
  assert.ok(changed>0);assert.deepEqual(await preview(member.id,'source'),memberBytes);
  await noPixels(native,()=>assert.rejects(edit(native,doc,'add_layer_filter',{layerId:person.id,kind:'selective_color',value:0,parameters:{}}),{code:'PROTECTED_LAYER'}));
  await noPixels(native,()=>assert.rejects(edit(native,doc,'bake_layer_filters',{layerId:source.id}),{code:'FILTER_BAKE_PROTECTED_CONTEXT'}));assert.deepEqual(await files(native.assetsDir),assets);
});

test('malformed Selective global/source/recipe portable metadata rejects before assets and commands preserve the prior graph',async t=>{
  const {native}=await fixture(t),w=8,h=6,source=await raster(native,image(w,h),w,h),doc=await project(native,w,h,[source]),assets=await files(native.assetsDir);
  const bundle=await encodeProjectBundle({graph:graph(native,doc),validateGraph:v=>native.validateGraph(v),readAsset:asset=>fs.readFile(path.join(native.assetsDir,asset))}),size=bundle.readUInt32BE(8),manifest=JSON.parse(bundle.subarray(12,12+size));
  const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
  const forged=g=>{const json=Buffer.from(JSON.stringify(canonical({...manifest,graph:g}))),header=Buffer.from(bundle.subarray(0,12));header.writeUInt32BE(json.length,8);return Buffer.concat([header,json,bundle.subarray(12+size)]);};
  assert.deepEqual(decodeProjectBundle(forged(graph(native,doc)),{validateGraph:v=>native.validateGraph(v)}).graph,graph(native,doc),'The forged-container helper itself remains a valid canonical bundle');
  for(const parameters of [{method:null},{method:'Relative'},{reds:[0,0,0]},{whites:[0,0,0,.001]},{blacks:[101,0,0,0]},{method:'relative',extra:1}]){
    for(const command of ['add_adjustment','add_layer_filter'])await noPixels(native,()=>assert.rejects(edit(native,doc,command,{...(command==='add_layer_filter'?{layerId:source.id}:{}),kind:'selective_color',value:0,parameters}),error=>['INVALID_ARGUMENT','INVALID_ARGUMENTS'].includes(error.code)),true);
    const recipe={id:randomUUID(),version:1,name:'Malformed Selective',slots:[{key:'grade',type:'adjustment',kind:'selective_color'}],steps:[{command:'update_adjustment',target:'grade',args:{value:0,parameters}}]};
    for(const extra of [{layers:[{...source,filters:[filter(parameters)]}]},{layers:[source,base({type:'adjustment',kind:'selective_color',value:0,parameters})]},{layers:[source],editRecipes:[recipe]}])await noPixels(native,()=>assert.rejects(native.importProject({data:forged({name:'Bad Selective',width:w,height:h,selection:null,...extra})}),{code:'INVALID_PROJECT_BUNDLE'}),true);
  }
  for(const command of ['add_adjustment','add_layer_filter'])await noPixels(native,()=>assert.rejects(edit(native,doc,command,{...(command==='add_layer_filter'?{layerId:source.id}:{}),kind:'selective_color',value:1}),error=>['INVALID_ARGUMENT','INVALID_ARGUMENTS'].includes(error.code)),true);
  assert.deepEqual(await get(native,doc),doc);assert.deepEqual(await files(native.assetsDir),assets);
});

test('Selective real publication failure and late Bake/paint transaction failure preserve graph, files and owned assets',async t=>{
  const {native}=await fixture(t),w=8,h=6,source=await raster(native,image(w,h),w,h,{filters:[filter(treatment)]}),grade=base({type:'adjustment',kind:'selective_color',value:0,parameters:{}}),doc=await project(native,w,h,[source,grade]);
  const assets=await files(native.assetsDir),projects=await files(native.projectsDir),directory=native.projectsDir;
  native.projectsDir=path.join(native.assetsDir,source.asset);try{await assert.rejects(edit(native,doc,'update_adjustment',{layerId:grade.id,parameters:treatment}),{code:'ENOTDIR'});}finally{native.projectsDir=directory;}
  assert.deepEqual(await get(native,doc),doc);assert.deepEqual(await files(native.projectsDir),projects);assert.deepEqual(await files(native.assetsDir),assets);
  const publishedStore=native.storeAsset;let published=0;native.storeAsset=async function(...args){const result=await publishedStore.apply(this,args);if(!Object.hasOwn(assets,result))published++;return result;};
  native.projectsDir=path.join(native.assetsDir,source.asset);try{await assert.rejects(edit(native,doc,'bake_layer_filters',{layerId:source.id}),{code:'ENOTDIR'});}finally{native.projectsDir=directory;native.storeAsset=publishedStore;}
  assert.ok(published>0,'Bake published a new colored asset before the real project save failed');assert.deepEqual(await get(native,doc),doc);assert.deepEqual(await files(native.projectsDir),projects);assert.deepEqual(await files(native.assetsDir),assets);
  const store=native.storeAsset;let writes=0;native.storeAsset=async function(...args){writes++;return store.apply(this,args);};
  try{await assert.rejects(edit(native,doc,'apply_transaction',{operations:[
    {command:'update_adjustment',args:{layerId:grade.id,parameters:treatment}},
    {command:'update_layer_filter',args:{layerId:source.id,filterId:source.filters[0].id,parameters:treatment}},
    {command:'bake_layer_filters',args:{layerId:source.id}},
    {command:'paint_stroke',args:{layerId:source.id,tool:'brush',color:'#cc5522',size:2,opacity:1,hardness:1,points:[{x:3,y:3}]}},
    {command:'set_layer',args:{layerId:randomUUID(),opacity:.5}},
  ]}),{code:'NOT_FOUND'});}finally{native.storeAsset=store;}
  assert.ok(writes>=2);assert.deepEqual(await get(native,doc),doc);assert.deepEqual(await files(native.assetsDir),assets);assert.deepEqual(await files(native.projectsDir),projects);
});
