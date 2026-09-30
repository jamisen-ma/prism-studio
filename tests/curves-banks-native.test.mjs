import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {NativeBackend} from '../server/native.mjs';
import {ADJUSTMENTS,adjustmentTransform,normalizeParameters,globalCurvesBanksCacheBytes} from '../server/color.mjs';
import {CURVES_BANKS_POLICY,CURVES_BANK_NAMES} from '../shared/curves-banks.mjs';
import {applyLayerFilters,normalizeLayerFilter,LAYER_FILTER_KINDS,filterWork,layerFilterSpatialCacheBytes,validateLayerFilterResources} from '../server/layer-filters.mjs';
import {LAYER_FILTER_BLEND_MODES,compileFilterBlend} from '../server/filter-blend.mjs';
import {estimateFilterBakeBytes} from '../server/filter-bake.mjs';
import {createDistort} from '../server/distort.mjs';
import {estimateDistortResources} from '../server/distort-resources.mjs';
import {layerTree} from '../server/groups.mjs';
import {normalizeEditRecipe,editRecipeHash} from '../server/edit-recipes.mjs';
const coded=code=>error=>error.code===code,byte=n=>Math.max(0,Math.min(255,Math.round(n))),identity=[{x:0,y:0},{x:255,y:255}],line=(a,b)=>[{x:0,y:a},{x:255,y:b}];
const parameters={mode:'banks',banks:{master:{points:[{x:0,y:0},{x:85,y:255},{x:170,y:0},{x:255,y:255}],interpolation:'smooth'},red:{points:line(0,127.5)},green:{points:line(255,0)},blue:{points:line(20,235),interpolation:'smooth'}}};
const entry=(p=parameters,extra={})=>({id:randomUUID(),kind:'curves',value:0,parameters:p,enabled:true,opacity:1,...extra});
const graphOf=(native,doc)=>structuredClone(native.project(doc.id).states[native.project(doc.id).cursor].graph);
const edit=async(native,doc,command,args={})=>(await native.execute(command,{documentId:doc.id,expectedRevision:doc.revision,...args})).document;
const pixels=(w,h)=>Buffer.from(Array.from({length:w*h},(_,i)=>[i%256,(i*37+13)%256,(i*71+25)%256,[0,1,128,255][i%4]]).flat());
const sequence=p=>{const effective=normalizeParameters('curves',p);return CURVES_BANK_NAMES.map(name=>adjustmentTransform({kind:'curves',value:0,parameters:{...effective.banks[name],channel:name==='master'?'rgb':name}}));};
const candidate=(functions,rgb)=>functions.reduce((value,fn)=>fn(...value),rgb);
function sourceReference(input,entries){const out=Buffer.from(input);for(const e of entries){if(!e.enabled||!e.opacity)continue;const fns=sequence(e.parameters),blend=e.blendMode?compileFilterBlend(e.blendMode,e.opacity):null;for(let i=0;i<out.length;i+=4)if(out[i+3]){const old=[...out.subarray(i,i+3)],front=candidate(fns,old);out.set(blend?blend(old,front):old.map((v,c)=>byte(v+(front[c]-v)*e.opacity)),i);}}return out;}
async function fixture(t){const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'prism-curves-banks-')),native=await new NativeBackend({dataDir}).init();t.after(async()=>{await native.close();await fs.rm(dataDir,{recursive:true,force:true});});const input=pixels(16,16),png=await sharp(input,{raw:{width:16,height:16,channels:4}}).png().toBuffer(),doc=(await native.execute('import_image',{mimeType:'image/png',data:png.toString('base64')})).document;return{native,doc,input};}
const base=extra=>({id:randomUUID(),name:'Banks fixture',visible:true,opacity:1,blendMode:'normal',...extra});
const fake=(w,h,extra={})=>base({type:'raster',width:w,height:h,asset:'a'.repeat(64),sourceAsset:'a'.repeat(64),transforms:[],...extra});
const graph=(w,h,layers)=>({name:'Bank resource fixture',width:w,height:h,selection:null,layers});
const corners=(w,h)=>[{x:0,y:0},{x:w,y:0},{x:w,y:h},{x:0,y:h}];
const globalBank=extra=>base({type:'adjustment',kind:'curves',value:0,parameters:{mode:'banks'},...extra});

test('native banks discovery and both update paths retain nested settings and require explicit replacement without pixels',async t=>{
 const{native,doc:initial}=await fixture(t);let doc=initial;const id=doc.layers[0].id;assert.equal(Object.keys(ADJUSTMENTS).length,28);assert.equal(LAYER_FILTER_KINDS.length,32);const caps=await native.execute('capabilities');assert.equal(caps.curvesBanksPolicy,CURVES_BANKS_POLICY);assert.deepEqual(caps.curvesBankNames,CURVES_BANK_NAMES);
 let calls=0;const oldRender=native.renderLayer,oldStore=native.storeAsset;native.renderLayer=native.storeAsset=async()=>{calls++;throw Error('Metadata read pixels');};
 try{for(const source of [true,false]){doc=await edit(native,doc,source?'add_layer_filter':'add_adjustment',{...(source?{layerId:id}:{}),kind:'curves',value:0,parameters});const target=source?id:doc.layers.at(-1).id,filterId=source?doc.layers[0].filters[0].id:undefined,command=source?'update_layer_filter':'update_adjustment',args={layerId:target,...(source?{filterId}:{})},selected=()=>source?doc.layers[0].filters[0]:doc.layers.at(-1);
 doc=await edit(native,doc,command,{...args,parameters:{mode:'banks',banks:{red:{interpolation:'smooth'}}}});assert.deepEqual(selected().parameters.banks.master.points,parameters.banks.master.points);assert.equal(selected().parameters.banks.red.interpolation,'smooth');assert.deepEqual(selected().parameters.banks.red.points,parameters.banks.red.points);
 const before=JSON.stringify(native.project(doc.id));await assert.rejects(edit(native,doc,command,{...args,parameters:{channel:'blue'}}),coded('INVALID_ARGUMENT'));assert.equal(JSON.stringify(native.project(doc.id)),before);const current=structuredClone(selected().parameters);doc=await edit(native,doc,command,{...args,parameters:{}});assert.deepEqual(selected().parameters,current);
 doc=await edit(native,doc,command,{...args,parameters:{mode:'single',channel:'blue'}});assert.deepEqual(selected().parameters,{points:identity,channel:'blue'});doc=await edit(native,doc,command,{...args,parameters:{mode:'single',interpolation:'smooth'}});assert.deepEqual(selected().parameters,{points:identity,channel:'blue',interpolation:'smooth'});
 doc=await edit(native,doc,command,{...args,parameters:{mode:'banks',banks:{green:{interpolation:'smooth'}}}});assert.deepEqual(selected().parameters.banks.blue,{points:identity,interpolation:'linear'});assert.equal(selected().parameters.banks.green.interpolation,'smooth');}}
 finally{native.renderLayer=oldRender;native.storeAsset=oldStore;}assert.equal(calls,0);
});

test('bank candidates precede all26 source blends and deferred whole-stack mask while original alpha and hidden RGB remain exact',async()=>{
 const input=pixels(16,16),snapshot=Buffer.from(input);for(const blendMode of LAYER_FILTER_BLEND_MODES){const e=entry(parameters,{blendMode,opacity:.625});assert.deepEqual(await applyLayerFilters(input,16,16,[e]),sourceReference(input,[e]),blendMode);}
 const entries=[entry(parameters,{opacity:.75}),entry({mode:'banks',banks:{blue:{points:line(255,0)}}},{opacity:.375,blendMode:'screen'})],filtered=sourceReference(input,entries),runs=[];for(let p=1;p<256;p++)runs.push(p,1,p);
 const mask={sourceWidth:16,sourceHeight:16,coverage:{shape:'bitmap',x:0,y:0,width:16,height:16,runs,feather:0,invert:false},enabled:true,density:.1},actual=await applyLayerFilters(input,16,16,{version:1,entries,mask}),expected=Buffer.from(input);
 for(let p=0;p<256;p++){const m=Math.round(255-.1*(255-p));for(let c=0;c<3;c++)expected[p*4+c]=Math.floor((2*(input[p*4+c]*(255-m)+filtered[p*4+c]*m)+255)/510);}assert.deepEqual(actual,expected);assert.deepEqual(input,snapshot);
 const cancelled={mode:'banks',banks:Object.fromEntries(CURVES_BANK_NAMES.map(name=>[name,{points:line(255,0)}]))};assert.deepEqual([...await applyLayerFilters(Buffer.from([128,128,128,1,10,20,30,0]),2,1,[entry(cancelled,{blendMode:'multiply'})])],[64,64,64,1,10,20,30,0]);
});

test('global banks retain existing Curves hidden-RGB, alpha, mask density, opacity and protected-pixel policies',async()=>{
 const input=pixels(16,16),protectedPixels=Buffer.from(Array.from({length:256},(_,p)=>p%11===0?255:0)),layer={...entry(parameters,{opacity:.5}),mask:{shape:'rectangle',x:0,y:0,width:8,height:16},maskDensity:.25},fns=sequence(parameters),actual=await NativeBackend.prototype.applyAdjustment(input,16,16,layer,protectedPixels);let changedHidden=false;
 for(let p=0;p<256;p++){const i=p*4,front=candidate(fns,[...input.subarray(i,i+3)]),amount=.5*(p%16<8?1:.75);assert.equal(actual[i+3],input[i+3]);for(let c=0;c<3;c++){const expected=protectedPixels[p]?input[i+c]:byte(input[i+c]+(front[c]-input[i+c])*amount);assert.equal(actual[i+c],expected);if(!input[i+3]&&actual[i+c]!==input[i+c])changedHidden=true;}}assert.equal(changedHidden,true);
});

test('source sequential compiler cache and global once-per-graph reserve close preread masked and Distort boundaries',async t=>{
 const{native}=await fixture(t),bank=entry({mode:'banks'}),legacy=entry({channel:'rgb'});assert.equal(filterWork(bank,24_000_000),24_000_000);assert.equal(filterWork({...bank,blendMode:'multiply'},1),41);assert.equal(layerFilterSpatialCacheBytes([bank,bank],6000,4000),1280);assert.equal(layerFilterSpatialCacheBytes([{...bank,enabled:false}],6000,4000),0);
 const blur={id:randomUUID(),kind:'blur',value:1,enabled:true,opacity:1},ring=layerFilterSpatialCacheBytes([blur],1024,1024);assert.ok(ring>1280);assert.equal(layerFilterSpatialCacheBytes([bank,blur,bank],1024,1024),ring);
 const w=8191,h=2731,mask={sourceWidth:w,sourceHeight:h,coverage:{shape:'rectangle',x:0,y:0,width:w,height:h,feather:0,invert:false},enabled:true,density:1},g=graph(w,h,[fake(w,h,{filters:{version:1,entries:[legacy],mask}})]);native.validateGraph(g);g.layers[0].filters.entries=[bank];assert.throws(()=>native.validateGraph(g),coded('LIMIT_EXCEEDED'));g.layers[0].filters.mask.enabled=false;native.validateGraph(g);
 const a=graph(2410,7956,[fake(2410,7956,{transforms:[createDistort(2410,7956,corners(2410,7956))]})]);native.validateGraph(a);assert.equal(estimateDistortResources(a).estimatedWorkingBytes,268435440);a.layers.push(globalBank());assert.equal(globalCurvesBanksCacheBytes(a),1280);assert.equal(estimateDistortResources(a).estimatedWorkingBytes,268436720);assert.throws(()=>native.validateGraph(a),coded('LIMIT_EXCEEDED'));a.layers.at(-1).opacity=0;native.validateGraph(a);
 const b=graph(1490,8189,[fake(1490,8189,{filters:[bank],transforms:[createDistort(1490,8189,corners(1490,8189))]})]);native.validateGraph(b);assert.equal(estimateDistortResources(b).estimatedWorkingBytes,268435420);b.layers.push(globalBank({visible:false}),globalBank());assert.equal(globalCurvesBanksCacheBytes(b),1280);assert.throws(()=>native.validateGraph(b),coded('LIMIT_EXCEEDED'));
 const small=graph(16,16,[fake(16,16),globalBank()]),one=validateLayerFilterResources(small,layerTree(small.layers)).estimatedScratchBytes;small.layers.push(globalBank());assert.equal(validateLayerFilterResources(small,layerTree(small.layers)).estimatedScratchBytes,one);assert.equal(one,1280);
 const opts={width:1024,height:1024,hasAlpha:true,encodedWorkingBytes:1000,encodedAlphaBytes:200},plain=estimateFilterBakeBytes({...opts,filters:[legacy]}),banks=estimateFilterBakeBytes({...opts,filters:[bank]});assert.equal(banks.filterBytes-plain.filterBytes,1280);for(const key of ['decodeBytes','encodeBytes','publicationBytes'])assert.equal(banks[key],plain[key]);
 const source=fake(16,16,{protected:true,filters:[bank]});assert.throws(()=>native.validateGraph(graph(16,16,[source])),coded('PROTECTED_LAYER'));
});

test('banked source Bake preserves exact working alpha, effect mask and Distort, assets, portable graph and actual save rollback',async t=>{
 const{native,doc:initial}=await fixture(t);let doc=initial;const layerId=doc.layers[0].id,originalAsset=doc.layers[0].asset,source=await fs.readFile(path.join(native.assetsDir,originalAsset));
 doc=await edit(native,doc,'add_layer_filter',{layerId,kind:'curves',value:0,parameters,opacity:.75,blendMode:'screen'});doc=await edit(native,doc,'set_layer_filter_mask',{layerId,source:'mask',mask:{shape:'ellipse',x:1,y:1,width:14,height:14,feather:1}});doc=await edit(native,doc,'modify_layer_filter_mask',{layerId,density:.1});doc=await edit(native,doc,'add_layer_distort',{layerId,corners:[{x:1,y:0},{x:16,y:1},{x:15,y:16},{x:0,y:15}]});
 const before=await native.renderGraph(graphOf(native,doc)),project=JSON.stringify(native.project(doc.id)),assets=(await fs.readdir(native.assetsDir)).sort(),directory=native.projectsDir;
 native.projectsDir=path.join(native.assetsDir,originalAsset);try{await assert.rejects(edit(native,doc,'bake_layer_filters',{layerId}),coded('ENOTDIR'));}finally{native.projectsDir=directory;}assert.equal(JSON.stringify(native.project(doc.id)),project);assert.deepEqual((await fs.readdir(native.assetsDir)).sort(),assets);
 const saved=structuredClone(doc.layers[0]);doc=await edit(native,doc,'bake_layer_filters',{layerId});assert.deepEqual(await native.renderGraph(graphOf(native,doc)),before);assert.deepEqual(doc.layers[0].transforms,saved.transforms);const working=await sharp(await fs.readFile(path.join(native.assetsDir,doc.layers[0].asset))).ensureAlpha().raw().toBuffer(),raw=await sharp(source).ensureAlpha().raw().toBuffer();for(let i=3;i<raw.length;i+=4)assert.equal(working[i],raw[i]);
 doc=await edit(native,doc,'undo');const imported=(await native.importProject({data:(await native.exportProject({documentId:doc.id})).data})).document;assert.deepEqual(imported.layers[0].filters[0].parameters,saved.filters[0].parameters);assert.deepEqual(await native.renderGraph(graphOf(native,imported)),before);assert.deepEqual(await fs.readFile(path.join(native.assetsDir,originalAsset)),source);
});

test('full bank recipes and old single recipes reset both representations with stable canonical bodies and atomic late failure',async t=>{
 const{native,doc:initial}=await fixture(t);let doc=await edit(native,initial,'add_adjustment',{kind:'curves',value:0,parameters});const layerId=doc.layers.at(-1).id;
 const definition={id:randomUUID(),version:1,name:'Legacy red',slots:[{key:'tone',type:'adjustment',kind:'curves'}],steps:[{command:'update_adjustment',target:'tone',args:{value:0,parameters:{points:line(0,127.5),channel:'red'}}}]},body=JSON.stringify(definition),hash=editRecipeHash(definition);assert.deepEqual(normalizeEditRecipe(definition),definition);
 const saved=await native.execute('save_edit_recipe',{documentId:doc.id,expectedRevision:doc.revision,name:definition.name,slots:definition.slots,steps:definition.steps});doc=saved.document;const before=JSON.stringify(native.project(doc.id));const report=await native.execute('validate_edit_recipe',{documentId:doc.id,expectedRevision:doc.revision,recipeId:saved.recipeId,bindings:{tone:layerId}});assert.equal(report.valid,true);assert.equal(JSON.stringify(native.project(doc.id)),before);doc=(await native.execute('apply_edit_recipe',{documentId:doc.id,expectedRevision:doc.revision,recipeId:saved.recipeId,bindings:{tone:layerId}})).document;assert.deepEqual(doc.layers.at(-1).parameters,definition.steps[0].args.parameters);assert.equal(JSON.stringify(definition),body);assert.equal(editRecipeHash(definition),hash);assert.ok(!Object.hasOwn(doc.editRecipes[0].steps[0].args.parameters,'mode'));
 doc=await edit(native,doc,'undo');assert.equal(doc.layers.at(-1).parameters.mode,'banks');const bankDefinition={...definition,id:randomUUID(),name:'Bank reset',steps:[{command:'update_adjustment',target:'tone',args:{value:0,parameters:{mode:'banks',banks:{green:{interpolation:'smooth'}}}}}]},canonical=normalizeEditRecipe(bankDefinition);for(const name of CURVES_BANK_NAMES)assert.deepEqual(canonical.steps[0].args.parameters.banks[name].points,identity);
 const old=JSON.stringify(native.project(doc.id)),files=(await fs.readdir(native.assetsDir)).sort();await assert.rejects(edit(native,doc,'apply_transaction',{label:'Late bank failure',operations:[{command:'update_adjustment',args:{layerId,parameters:{mode:'single'}}},{command:'delete_layer',args:{layerId:randomUUID()}}]}),coded('NOT_FOUND'));assert.equal(JSON.stringify(native.project(doc.id)),old);assert.deepEqual((await fs.readdir(native.assetsDir)).sort(),files);
});
