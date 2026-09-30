import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { COLOR_MAPPING_KINDS } from '../server/color.mjs';
import { applyLayerFilters, filterWork, layerFilterSpatialCacheBytes, layerFilterSharedBytes } from '../server/layer-filters.mjs';
import { estimateFilterBakeBytes } from '../server/filter-bake.mjs';
import { editRecipeHash } from '../server/edit-recipes.mjs';
import { encodeProjectBundle, decodeProjectBundle } from '../server/project-bundle.mjs';
import { PHOTO_FILTER_POLICY, PHOTO_FILTER_DEFAULTS, normalizePhotoFilterParameters, mergePhotoFilterParameters, photoFilterIsIdentity, photoFilterTransform } from '../server/photo-filter.mjs';
import { PHOTO_FILTER_DEFAULTS as DEFAULTS, PHOTO_FILTER_GOLDENS, photoFilterReference, photoFilterReferenceStages, photoFilterRationalEqual } from './fixtures/photo-filter/reference.mjs';

test('Photo Filter production agrees with independent unsimplified rational geometry, literal halves and gamut fits', () => {
  assert.equal(PHOTO_FILTER_POLICY, 'rgb-transmission-luma-fit-v1');
  assert.deepEqual(PHOTO_FILTER_DEFAULTS, DEFAULTS); assert.ok(Object.isFrozen(PHOTO_FILTER_DEFAULTS));
  for (const item of PHOTO_FILTER_GOLDENS) {
    assert.deepEqual(photoFilterReference(item.rgb, item.parameters), item.expected, item.name);
    assert.deepEqual(photoFilterTransform(item.parameters)(...item.rgb), item.expected, item.name);
  }
  const values = [0, 1, 127, 128, 254, 255], colors = ['#000000', '#ffffff', '#010101', '#ff0000', '#00ffff', '#ff9500', '#5080ff', '#10d080'];
  let fits = 0, ties = 0;
  for (const color of colors) for (const density of [.01, 25, 99.99, 100]) for (const preserveLuminosity of [false, true]) {
    const parameters = { color, density, preserveLuminosity }, transform = photoFilterTransform(parameters);
    assert.deepEqual(Object.keys(transform), []);
    for (const r of values) for (const g of values) for (const b of values) {
      const rgb = [r, g, b], reference = photoFilterReferenceStages(rgb, parameters);
      assert.deepEqual(transform(...rgb), reference.bytes);
      if (preserveLuminosity) assert.ok(photoFilterRationalEqual(reference.originalLuma, reference.outputLuma));
      else reference.bytes.forEach((value, c) => assert.ok(value <= rgb[c]));
      fits += Number(reference.fitted);
      ties += reference.exact.filter(({ n, d }) => 2n * (n % d) === d).length;
    }
  }
  assert.ok(fits > 100); assert.ok(ties > 100);
  let seed = 0x70686f74; const random = () => seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  for (let i = 0; i < 1500; i++) {
    const rgb = [random() % 256, random() % 256, random() % 256];
    const parameters = { color: `#${(random() & 0xffffff).toString(16).padStart(6, '0')}`, density: (random() % 10001) / 100, preserveLuminosity: Boolean(i % 2) };
    assert.deepEqual(photoFilterTransform(parameters)(...rgb), photoFilterReference(rgb, parameters));
  }
});

test('Photo Filter exact identities, zero-transmission endpoints and bounded half-up ratio proof remain distinct', () => {
  for (const p of [{ density: 0 }, { color: '#ffffff', preserveLuminosity: false }, { color: '#000000' }, { color: '#010101' }, { color: '#ababab', density: 100 }]) {
    assert.equal(photoFilterIsIdentity(p), true);
    for (let c = 0; c < 256; c++) assert.deepEqual(photoFilterTransform(p)(c, 255-c, c^128), [c, 255-c, c^128]);
  }
  for (const p of [{}, { color: '#000000', preserveLuminosity: false }, { color: '#ababaa' }, { color: '#ff9500', density: .01 }]) assert.equal(photoFilterIsIdentity(p), false);
  for (const [rgb, color] of [[[255,0,0], '#00ffff'], [[0,127,91], '#ff0000'], [[13,127,253], '#000000']])
    for (const density of [0, .01, 25, 99, 99.99, 100]) assert.deepEqual(photoFilterTransform({color, density})(...rgb), rgb);
  // Test the declared Number division expression at worst allowed integer
  // boundaries, independently of the runtime helper's private fast branch.
  const maximum = 6_502_500_000_000n;
  for (const d of [1n, 2n, 2_550_000n, maximum-1n, maximum]) for (let c = 0n; c < 255n; c++) for (const step of [-2n,-1n,0n,1n,2n]) {
    const n = ((2n*c+1n)*d)/2n+step;
    if (n < 0n || n > 255n*d) continue;
    assert.ok(2n*n+d < 2n**52n);
    assert.equal(Math.floor((2*Number(n)+Number(d))/(2*Number(d))), Number((2n*n+d)/(2n*d)));
  }
});

test('Photo Filter strict normalization and merge reject patch accessors before spread and own compiled state', () => {
  let calls = 0; const getter = () => { calls++; throw Error('Accessor executed'); };
  const accessor = Object.defineProperty({}, 'density', {enumerable:true, get:getter});
  const malformed = [null, [], 0, true, 'warm', Object.create({density:25}), {extra:0}, {[Symbol('bad')]:0}, accessor,
    Object.defineProperty({}, 'color', {value:'#ffffff', enumerable:false}),
    ...['#fff','#abcdef\n','#abcdef\r','#abcdeg',' #abcdef','#abcdef ','abcdef',null,0].map(color => ({color})),
    ...[null,'25',true,NaN,Infinity,-Infinity,-.01,100.01,.001,Number.MIN_VALUE].map(density => ({density})),
    ...[null,0,1,'true'].map(preserveLuminosity => ({preserveLuminosity}))];
  for (const p of malformed) {
    assert.throws(() => normalizePhotoFilterParameters(p), {code:'INVALID_ARGUMENT'});
    assert.throws(() => mergePhotoFilterParameters(DEFAULTS, p), {code:'INVALID_ARGUMENT'});
  }
  assert.equal(calls, 0); assert.throws(() => photoFilterIsIdentity({density:.001}), {code:'INVALID_ARGUMENT'});
  assert.deepEqual(normalizePhotoFilterParameters(), DEFAULTS);
  assert.deepEqual(normalizePhotoFilterParameters(Object.assign(Object.create(null), {color:'#ABCDEF', density:-0, preserveLuminosity:false})), {color:'#abcdef',density:0,preserveLuminosity:false});
  const p = {color:'#1020ef',density:37.19,preserveLuminosity:false}, original = {...p}, transform = photoFilterTransform(p);
  p.density = 0; assert.deepEqual(transform(173,116,84), photoFilterReference([173,116,84], original));
  const result = transform(173,116,84); result.fill(255); assert.deepEqual(transform(173,116,84), photoFilterReference([173,116,84], original));
  assert.deepEqual(mergePhotoFilterParameters(original, {}), original);
  assert.deepEqual(mergePhotoFilterParameters(original, {density:0}), {...original,density:0});
});

const treatment = {color:'#ff9500',density:37.19,preserveLuminosity:true};

const base=extra=>({id:randomUUID(),name:'Independent Photo Filter audit',visible:true,opacity:1,blendMode:'normal',...extra});
const filter=(parameters={},extra={})=>({id:randomUUID(),kind:'photo_filter',value:0,enabled:true,opacity:1,parameters,...extra});
const fake=(width,height,extra={})=>base({type:'raster',width,height,asset:'a'.repeat(64),sourceAsset:'a'.repeat(64),transforms:[],...extra});
const image=(w,h)=>Buffer.from(Array.from({length:w*h},(_,p)=>[p*37%256,p*73%256,p*97%256,[0,1,128,255][p%4]]).flat());
const bitmap=(bytes,width,height,extra={})=>({shape:'bitmap',x:0,y:0,width,height,runs:Array.from(bytes).flatMap((v,i)=>v?[i,1,v]:[]),feather:0,invert:false,...extra});
const mask=(width,height,extra={})=>({sourceWidth:width,sourceHeight:height,coverage:{shape:'rectangle',x:0,y:0,width,height,feather:0,invert:false},density:1,enabled:true,...extra});
const graph=(native,doc)=>{const p=native.projects.get(doc.id);return structuredClone(p.states[p.cursor].graph);};
const get=async(native,doc)=>(await native.execute('get_document',{documentId:doc.id})).document;
const edit=(native,doc,command,args={})=>native.execute(command,{documentId:doc.id,expectedRevision:doc.revision,...(command==='apply_transaction'?{label:'Photo Filter audit'}:{}),...args});
const project=async(native,width,height,layers,extra={})=>(await native.newProject({name:'Photo Filter audit',width,height,selection:null,layers,...extra},'Fixture')).document;
const files=async dir=>Object.fromEntries(await Promise.all((await fs.readdir(dir)).sort().map(async name=>[name,await fs.readFile(path.join(dir,name))])));
const half=(n,d)=>Number((2n*BigInt(n)+BigInt(d))/(2n*BigInt(d)));
async function fixture(t){const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'prism-photo-filter-audit-'));const native=await new NativeBackend({dataDir,segmentSubject:()=>assert.fail('No model for Photo Filter')}).init();t.after(async()=>{await native.close();await fs.rm(dataDir,{recursive:true,force:true});});return{native};}
async function raster(native,input,width,height,extra={}){const asset=await native.storeAsset(await sharp(input,{raw:{width,height,channels:4}}).png().toBuffer());return fake(width,height,{asset,sourceAsset:asset,...extra});}
async function noPixels(native,operation,noIO=false){const saved=[],calls=[];for(const key of ['render','renderGraph','renderLayer','readAlpha','storeAlpha','storeAsset','readProjectAsset','validateProjectAsset','segmentSubject']){const old=native[key];native[key]=()=>{calls.push(key);assert.fail(`Unexpected pixel access: ${key}`);};saved.push(()=>{native[key]=old;});}if(noIO)for(const key of ['readFile','writeFile','open','rename','link','unlink','mkdir','stat']){const old=fs[key];fs[key]=()=>{calls.push(`fs.${key}`);assert.fail(`Unexpected fs.${key}`);};saved.push(()=>{fs[key]=old;});}try{return await operation();}finally{saved.reverse().forEach(restore=>restore());assert.deepEqual(calls,[],'No pixel or forbidden filesystem call may be swallowed as a validation refusal');}}

test('native flat Photo Filter patches retain omitted controls and reject executable patches before publication', async t => {
  const {native} = await fixture(t), w=8,h=6, source=fake(w,h,{filters:[filter({color:'#1020ef',preserveLuminosity:false})]});
  const grade=base({type:'adjustment',kind:'photo_filter',value:0,parameters:{color:'#1020ef',preserveLuminosity:false},mask:{shape:'rectangle',x:0,y:0,width:4,height:h},maskDensity:.31});
  let doc=await project(native,w,h,[source,grade]);
  await noPixels(native,async()=>{native.validateGraph(graph(native,doc));assert.deepEqual(await get(native,doc),doc);},true);
  for(const [command,target] of [['update_layer_filter',{layerId:source.id,filterId:source.filters[0].id}],['update_adjustment',{layerId:grade.id}]]) {
    doc=(await noPixels(native,()=>edit(native,doc,command,{...target,parameters:{density:0}}))).document;
    doc=(await noPixels(native,()=>edit(native,doc,command,{...target,parameters:{}}))).document;
    const actual=command==='update_adjustment'?doc.layers[1].parameters:doc.layers[0].filters[0].parameters;
    assert.deepEqual(actual,{color:'#1020ef',density:0,preserveLuminosity:false});
    const before=structuredClone(doc);let calls=0;
    for(const parameters of [Object.defineProperty({},'color',{enumerable:true,get:()=>{calls++;return '#ffffff';}}),Object.defineProperty({},'density',{enumerable:false,value:25}),{[Symbol('bad')]:0},Object.create({density:25})])
      await noPixels(native,()=>assert.rejects(edit(native,doc,command,{...target,parameters}),{code:'INVALID_ARGUMENT'}),true);
    // Bake activates native call-time schema snapshotting. Both a distinctive
    // density field and the shared preserveLuminosity name must be rejected
    // using the actual target kind before Zod could evaluate their getters.
    for(const [key,value] of [['density',25],['preserveLuminosity',true]]) {
      const parameters=Object.defineProperty({},key,{enumerable:true,get:()=>{calls++;return value;}});
      await noPixels(native,()=>assert.rejects(edit(native,doc,'apply_transaction',{operations:[
        {command,args:{...target,parameters}},
        {command:'bake_layer_filters',args:{layerId:source.id}},
      ]}),{code:'INVALID_ARGUMENT'}),true);
    }
    assert.equal(calls,0);assert.deepEqual(await get(native,doc),before);
  }
  assert.deepEqual(doc.layers[1].mask,grade.mask);assert.equal(doc.layers[1].maskDensity,.31);assert.deepEqual(await fs.readdir(native.assetsDir),[]);
});

test('Photo Filter exact identity versus computing work, masks and blend activation refuse before image I/O', async t => {
  const {native}=await fixture(t);
  for(const [p,weight] of [[{},16],[{density:0},1],[{color:'#ffffff',preserveLuminosity:false},1],[{color:'#000000'},1],[{color:'#000000',preserveLuminosity:false},16]]) {
    assert.equal(filterWork(filter(p),100),weight*100);assert.equal(filterWork(filter(p,{blendMode:'multiply'}),100),(weight+40)*100);
    assert.equal(filterWork(filter(p,{enabled:false}),100),0);assert.equal(filterWork(filter(p,{opacity:0}),100),0);
    assert.equal(layerFilterSpatialCacheBytes([filter(p)],6000,4000),0);assert.equal(layerFilterSharedBytes([filter(p)]),0);
    const estimate=estimateFilterBakeBytes({width:8,height:6,filters:[filter(p)]});
    assert.equal(estimate.spatialCacheBytes,0);assert.equal(estimate.sharedBytes,0);
  }
  const exact=fake(6000,4000,{visible:false,filters:[filter(treatment)]}),atLimit=await project(native,6000,4000,[exact]);
  await noPixels(native,()=>assert.rejects(edit(native,atLimit,'add_layer_filter',{layerId:exact.id,kind:'photo_filter',value:0,parameters:{density:0}}),{code:'LIMIT_EXCEEDED'}),true);
  const active=fake(4000,3200,{visible:false,filters:[filter(treatment),filter({color:'#000000'})]}),activation=await project(native,4000,3200,[active]);
  await noPixels(native,()=>assert.rejects(edit(native,activation,'update_layer_filter',{layerId:active.id,filterId:active.filters[1].id,parameters:{preserveLuminosity:false}}),{code:'LIMIT_EXCEEDED'}),true);
  const scoped=fake(4000,4000,{visible:false,filters:{version:1,entries:[filter(treatment),filter({density:0})],mask:mask(4000,4000,{enabled:false})}}),masked=await project(native,4000,4000,[scoped]);
  await noPixels(native,()=>assert.rejects(edit(native,masked,'modify_layer_filter_mask',{layerId:scoped.id,enabled:true}),{code:'LIMIT_EXCEEDED'}),true);
  const neutral=fake(4000,2400,{filters:[filter({density:0})]}),blend=await project(native,4000,2400,[neutral]);
  await noPixels(native,()=>assert.rejects(edit(native,blend,'update_layer_filter',{layerId:neutral.id,filterId:neutral.filters[0].id,blendMode:'multiply'}),{code:'LIMIT_EXCEEDED'}),true);
  const disabled=fake(4000,3200,{filters:[filter(treatment),filter({}, {enabled:false})]}),toggle=await project(native,4000,3200,[disabled]);
  await noPixels(native,()=>assert.rejects(edit(native,toggle,'update_layer_filter',{layerId:disabled.id,filterId:disabled.filters[1].id,enabled:true}),{code:'LIMIT_EXCEEDED'}),true);
  for(const doc of [atLimit,activation,masked,blend,toggle])assert.deepEqual(await get(native,doc),doc);
  assert.deepEqual(await fs.readdir(native.assetsDir),[]);
});

test('Photo Filter sparse recipes become complete resets, retain source effect scope and fail over-budget before I/O',async t=>{
  const {native}=await fixture(t),w=8,h=6;
  for(const authored of [{},{density:0,preserveLuminosity:false},{color:'#ABCDEF',density:12.34}]){
    const scope=mask(w,h,{coverage:bitmap(Uint8Array.from({length:w*h},(_,i)=>i*17%256),w,h),density:.37});
    const source=await raster(native,image(w,h),w,h,{filters:{version:1,entries:[filter(treatment)],mask:scope}});
    const grade=base({type:'adjustment',kind:'photo_filter',value:0,parameters:{color:'#10d080',density:75,preserveLuminosity:false},opacity:.7,mask:{shape:'rectangle',x:0,y:0,width:4,height:h},maskDensity:.31});
    let doc=await project(native,w,h,[source,grade]),control=await project(native,w,h,[source,grade]);
    const saved=await noPixels(native,()=>edit(native,doc,'save_edit_recipe',{name:'Full Photo Filter defaults',slots:[{key:'photo',type:'raster'},{key:'grade',type:'adjustment',kind:'photo_filter'}],steps:[{command:'update_adjustment',target:'grade',args:{value:0,parameters:authored}},{command:'add_layer_filter',target:'photo',args:{kind:'photo_filter',value:0,parameters:authored}}]}));doc=saved.document;
    const complete={...DEFAULTS,...authored,color:(authored.color??DEFAULTS.color).toLowerCase()},recipe=doc.editRecipes.find(r=>r.id===saved.recipeId),hash=editRecipeHash(recipe);
    assert.deepEqual(recipe.steps[0].args.parameters,complete);assert.deepEqual(recipe.steps[1].args.parameters,complete);
    const args={recipeId:saved.recipeId,bindings:{photo:source.id,grade:grade.id}},before=structuredClone(doc),assets=await files(native.assetsDir);
    const report=await noPixels(native,()=>edit(native,doc,'validate_edit_recipe',args),true);assert.equal(report.valid,true);assert.equal(report.recipeHash,hash);assert.deepEqual(await get(native,doc),before);
    doc=(await noPixels(native,()=>edit(native,doc,'apply_edit_recipe',args))).document;
    control=(await edit(native,control,'update_adjustment',{layerId:grade.id,value:0,parameters:complete})).document;control=(await edit(native,control,'add_layer_filter',{layerId:source.id,...recipe.steps[1].args})).document;
    assert.deepEqual(doc.layers[1].parameters,complete);assert.deepEqual(doc.layers[1].mask,grade.mask);assert.equal(doc.layers[1].maskDensity,grade.maskDensity);
    assert.deepEqual(graph(native,doc).layers[0].filters.mask,scope);assert.deepEqual(await native.renderGraph(graph(native,doc)),await native.renderGraph(graph(native,control)));
    assert.equal(editRecipeHash(doc.editRecipes.find(r=>r.id===saved.recipeId)),hash);assert.equal(doc.history.length,before.history.length+1);assert.deepEqual(await files(native.assetsDir),assets);
    assert.deepEqual((await edit(native,doc,'undo')).document.layers,before.layers);
  }
  const source=fake(6000,4000,{filters:[filter(treatment)]});let doc=await project(native,6000,4000,[source]);
  const saved=await edit(native,doc,'save_edit_recipe',{name:'Over budget identity',slots:[{key:'photo',type:'raster'}],steps:[{command:'add_layer_filter',target:'photo',args:{kind:'photo_filter',value:0,parameters:{density:0}}}]});doc=saved.document;
  const args={recipeId:saved.recipeId,bindings:{photo:source.id}},report=await noPixels(native,()=>edit(native,doc,'validate_edit_recipe',args),true);
  assert.equal(report.valid,false);assert.equal(report.issues[0].code,'LIMIT_EXCEEDED');await noPixels(native,()=>assert.rejects(edit(native,doc,'apply_edit_recipe',args),{code:'LIMIT_EXCEEDED'}),true);assert.deepEqual(await get(native,doc),doc);
});

test('Photo Filter source/global alpha, protection, final candidate rounding and identity blend stages stay exact',async t=>{
  const {native}=await fixture(t),input=Buffer.from([255,255,0,0,128,128,128,1,173,116,84,128,255,255,0,255]),before=Buffer.from(input),raw=[255,128,0,255];
  const layer={kind:'photo_filter',value:0,parameters:treatment,opacity:.5,mask:bitmap(raw,4,1),maskDensity:.5};
  assert.ok(COLOR_MAPPING_KINDS.includes('photo_filter'));
  const result=await native.applyAdjustment(input,4,1,layer,Uint8Array.from([0,0,0,1]));
  for(let p=0;p<4;p++){const rgb=[...input.subarray(p*4,p*4+3)],mapped=photoFilterReference(rgb,treatment),amount=.5*(255-.5*(255-raw[p]))/255;for(let c=0;c<4;c++)assert.equal(result[p*4+c],c===3||!input[p*4+3]||p===3?input[p*4+c]:Math.round(rgb[c]+(mapped[c]-rgb[c])*amount));}
  const source=await applyLayerFilters(input,4,1,[filter(treatment,{opacity:.5})]);
  for(let p=0;p<4;p++){const rgb=[...input.subarray(p*4,p*4+3)],mapped=photoFilterReference(rgb,treatment);for(let c=0;c<4;c++)assert.equal(source[p*4+c],c===3||!input[p*4+3]?input[p*4+c]:half(rgb[c]+mapped[c],2));}
  assert.deepEqual(input,before);assert.deepEqual(await native.applyAdjustment(input,4,1,{...layer,opacity:0}),input);
  for(const identity of [{density:0},{color:'#ffffff',preserveLuminosity:false},{color:'#000000'}])
    assert.deepEqual(await applyLayerFilters(Buffer.from([128,128,128,255]),1,1,[filter(identity,{blendMode:'multiply'})]),Buffer.from([64,64,64,255]));
  const tie=Buffer.from([13,127,253,1,13,127,253,0]),settings={color:'#000000',density:50,preserveLuminosity:false};
  // Mapping rounds to [7,64,127] before .5 opacity: [10,96,190].
  const expected=Buffer.from([10,96,190,1,13,127,253,0]);
  assert.deepEqual(await native.applyAdjustment(tie,2,1,{kind:'photo_filter',value:0,parameters:settings,opacity:.5}),expected);
  assert.deepEqual(await applyLayerFilters(tie,2,1,[filter(settings,{opacity:.5})]),expected);
});

test('Photo Filter source alpha, sequential candidate/blend and complete-stack mask precede Distort and exact Bake',async t=>{
  const {native}=await fixture(t),w=9,h=7,input=image(w,h),alpha=Uint8Array.from({length:w*h},(_,p)=>[255,128,1,0,199][p%5]),raw=Uint8Array.from({length:w*h},(_,p)=>p*53%256);
  const scope=mask(w,h,{coverage:bitmap(raw,w,h,{invert:true}),density:.1});
  const p2={color:'#5080ff',density:37.19,preserveLuminosity:false},entries=[filter(treatment,{opacity:.625}),filter(p2,{opacity:.5,blendMode:'multiply'})];
  const source=await raster(native,input,w,h,{alphaAsset:await native.storeAlpha(Buffer.from(alpha),w,h),filters:{version:1,entries,mask:scope},mask:{shape:'positioned',sourceWidth:w,sourceHeight:h,x:1,y:-1,source:{shape:'ellipse',x:1,y:1,width:5,height:4,feather:1.2,invert:true}},maskDensity:.5});
  let doc=await project(native,w,h,[source]);const corners=[[1,0],[w+1,0],[w+1,h],[1,h]].map(([x,y])=>({x,y}));doc=(await edit(native,doc,'add_layer_distort',{layerId:source.id,corners})).document;
  const wanted=Buffer.from(input);let orderDiffers=0;
  for(let p=0;p<w*h;p++){
    wanted[p*4+3]=half(input[p*4+3]*alpha[p],255);if(!wanted[p*4+3])continue;
    const original=[...input.subarray(p*4,p*4+3)],a=photoFilterReference(original,treatment),first=original.map((c,i)=>Math.round(c+(a[i]-c)*.625)),b=photoFilterReference(first,p2);
    const second=first.map((c,i)=>half(255*c+c*b[i],510)),effective=Math.round(255-.1*raw[p]);
    const wrong=photoFilterReference(original,p2);if(!Buffer.from(wrong).equals(Buffer.from(b)))orderDiffers++;
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


test('Photo Filter generated clipping and isolated groups retain lower protected pixels and guarded source/Bake behavior',async t=>{
  const {native}=await fixture(t),w=9,h=7,count=w*h;
  const personBytes=Buffer.from(Array.from({length:count},(_,p)=>[31,117,209,p%w>=3&&p%w<=5?[1,128,255][p%3]:0]).flat()),person=await raster(native,personBytes,w,h,{protected:true,outline:{width:1,color:'#ffffff'}}),group=base({type:'group',mode:'isolated',opacity:.7});
  const sourceBytes=image(w,h);for(let p=0;p<count;p++)sourceBytes[p*4+3]=255;
  const source=await raster(native,sourceBytes,w,h,{parentId:group.id}),memberBytes=Buffer.from(Array.from({length:count},()=>[29,157,71,177]).flat()),member=await raster(native,memberBytes,w,h,{parentId:group.id,clipBaseId:source.id,role:'generated',provenance:{jobId:randomUUID(),mode:'generate'},visible:false});
  let doc=await project(native,w,h,[person,group,source,member]);const baseline=await native.renderGraph(graph(native,doc)),footprint=await native.protectedPixels(graph(native,doc)),assets=await files(native.assetsDir);
  for(const layerId of [source.id,member.id])doc=(await edit(native,doc,'add_layer_filter',{layerId,kind:'photo_filter',value:0,parameters:treatment})).document;doc=(await edit(native,doc,'set_layer',{layerId:member.id,visible:true})).document;
  const actual=await native.renderGraph(graph(native,doc));let changed=0;
  const preview=async(layerId,view='layer')=>{const r=await native.execute('get_layer_preview',{documentId:doc.id,layerId,view,maxWidth:32});return sharp(Buffer.from(r.data,'base64')).ensureAlpha().raw().toBuffer();};
  const sourceView=await preview(source.id),memberView=await preview(member.id);
  for(let p=0;p<count;p++)if(footprint[p]){assert.deepEqual(actual.subarray(p*4,p*4+4),baseline.subarray(p*4,p*4+4));assert.deepEqual(sourceView.subarray(p*4,p*4+3),sourceBytes.subarray(p*4,p*4+3));assert.equal(memberView[p*4+3],0);}else if(!actual.subarray(p*4,p*4+4).equals(baseline.subarray(p*4,p*4+4)))changed++;
  assert.ok(changed>0);assert.deepEqual(await preview(member.id,'source'),memberBytes);
  await noPixels(native,()=>assert.rejects(edit(native,doc,'add_layer_filter',{layerId:person.id,kind:'photo_filter',value:0,parameters:{}}),{code:'PROTECTED_LAYER'}));
  await noPixels(native,()=>assert.rejects(edit(native,doc,'bake_layer_filters',{layerId:source.id}),{code:'FILTER_BAKE_PROTECTED_CONTEXT'}));assert.deepEqual(await files(native.assetsDir),assets);
});


test('Photo Filter real publication failure and late Bake/paint transaction failure preserve graph, files and owned assets',async t=>{
  const {native}=await fixture(t),w=8,h=6,source=await raster(native,image(w,h),w,h,{filters:[filter(treatment)]}),grade=base({type:'adjustment',kind:'photo_filter',value:0,parameters:{}}),doc=await project(native,w,h,[source,grade]);
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

test('malformed inactive Photo Filter records and canonical portable recipes reject before pixels or asset I/O',async t=>{
  const {native}=await fixture(t),w=8,h=6,source=await raster(native,image(w,h),w,h),doc=await project(native,w,h,[source]),assets=await files(native.assetsDir);
  const bundle=await encodeProjectBundle({graph:graph(native,doc),validateGraph:v=>native.validateGraph(v),readAsset:asset=>fs.readFile(path.join(native.assetsDir,asset))});
  const size=bundle.readUInt32BE(8),manifest=JSON.parse(bundle.subarray(12,12+size));
  const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
  const forged=g=>{const json=Buffer.from(JSON.stringify(canonical({...manifest,graph:g}))),header=Buffer.from(bundle.subarray(0,12));header.writeUInt32BE(json.length,8);return Buffer.concat([header,json,bundle.subarray(12+size)]);};
  assert.deepEqual(decodeProjectBundle(forged(graph(native,doc)),{validateGraph:v=>native.validateGraph(v)}).graph,graph(native,doc),'Canonical positive control retains the original valid asset');
  for(const parameters of [{color:'#abcdef\n'},{color:'#ff00gg'},{density:.001},{density:null},{preserveLuminosity:0},{extra:true}]){
    for(const command of ['add_adjustment','add_layer_filter'])await noPixels(native,()=>assert.rejects(edit(native,doc,command,{...(command==='add_layer_filter'?{layerId:source.id}:{}),kind:'photo_filter',value:0,parameters}),error=>['INVALID_ARGUMENT','INVALID_ARGUMENTS'].includes(error.code)),true);
    const recipe={id:randomUUID(),version:1,name:'Malformed Photo Filter',slots:[{key:'grade',type:'adjustment',kind:'photo_filter'}],steps:[{command:'update_adjustment',target:'grade',args:{value:0,parameters}}]};
    for(const extra of [
      {layers:[{...source,filters:{version:1,entries:[filter(parameters,{enabled:false,opacity:0})],mask:mask(w,h,{enabled:false,density:0})}}]},
      {layers:[source,base({type:'adjustment',kind:'photo_filter',value:0,parameters,visible:false,opacity:0})]},
      {layers:[source],editRecipes:[recipe]},
    ])await noPixels(native,()=>assert.rejects(native.importProject({data:forged({name:'Bad Photo Filter',width:w,height:h,selection:null,...extra})}),{code:'INVALID_PROJECT_BUNDLE'}),true);
  }
  for(const command of ['add_adjustment','add_layer_filter'])await noPixels(native,()=>assert.rejects(edit(native,doc,command,{...(command==='add_layer_filter'?{layerId:source.id}:{}),kind:'photo_filter',value:1}),error=>['INVALID_ARGUMENT','INVALID_ARGUMENTS'].includes(error.code)),true);
  assert.deepEqual(await get(native,doc),doc);assert.deepEqual(await files(native.assetsDir),assets);
});
