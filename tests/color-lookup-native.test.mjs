import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { authoredCube } from './fixtures/color-lookup/reference.mjs';
import { filterEntries } from '../server/filter-mask.mjs';
const edit=async(b,d,c,args={})=>(await b.execute(c,{documentId:d.id,expectedRevision:d.revision,...args})).document;
const lookup=(d,name,target='layer-filter',extra={})=>({documentId:d.id,expectedRevision:d.revision,target,...(target==='layer-filter'?{layerId:d.layers[0].id}:{}),data:authoredCube(name).toString('base64'),sourceName:`${name}.cube`,inputSpace:'srgb',...extra});
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lookup-owner-')),b=await new NativeBackend({dataDir:dir}).init();t.after(async()=>{await b.close();await fs.rm(dir,{recursive:true,force:true});});const rgba=Buffer.from(Array.from({length:64},(_,p)=>[(p*17)%256,(p*47)%256,(p*101)%256,[0,1,128,255][p%4]]).flat()),png=await sharp(rgba,{raw:{width:8,height:8,channels:4}}).png().toBuffer();const d=(await b.execute('import_image',{mimeType:'image/png',data:png.toString('base64')})).document;return{b,d,dir};}
const graph=(b,d)=>structuredClone(b.project(d.id).states[b.project(d.id).cursor].graph);

test('atomic file replacement retains both context settings and descriptors reuse only as a complete verified replacement',async t=>{
 const{b,d:initial}=await fixture(t);let imported=await b.execute('import_color_lookup',lookup(initial,'cross-products')),d=imported.document;const layerId=imported.layerId,filterId=imported.filterId;
 d=await edit(b,d,'update_layer_filter',{layerId,filterId,opacity:.375,blendMode:'screen',enabled:false});d=await edit(b,d,'set_layer_filter_mask',{layerId,source:'none'});const before=structuredClone(d.layers[0]),replacement=await b.execute('import_color_lookup',lookup(d,'rgb-cycle','layer-filter',{filterId}));d=replacement.document;
 assert.equal(replacement.filterId,filterId);assert.deepEqual({...d.layers[0],filters:before.filters,filterMask:before.filterMask},before);assert.deepEqual({...d.layers[0].filters[0],parameters:before.filters[0].parameters},before.filters[0]);assert.deepEqual(d.layers[0].filterMask,before.filterMask);
 const parameters=d.layers[0].filters[0].parameters;d=await edit(b,d,'update_layer_filter',{layerId,filterId,parameters:{}});assert.deepEqual(d.layers[0].filters[0].parameters,parameters);await assert.rejects(edit(b,d,'update_layer_filter',{layerId,filterId,parameters:{gridSize:3}}));
 let reads=0;const read=b.readProjectAsset;b.readProjectAsset=async function(...args){reads++;return read.apply(this,args);};try{d=await edit(b,d,'update_layer_filter',{layerId,filterId,opacity:.5});assert.equal(reads,0);d=await edit(b,d,'add_adjustment',{kind:'color_lookup',value:0,parameters});assert.equal(reads,1);}finally{b.readProjectAsset=read;}
 const adjustment=d.layers.at(-1);d=await edit(b,d,'set_layer',{layerId:adjustment.id,name:'Retain this name',opacity:.625});d=await edit(b,d,'set_layer_mask',{layerId:adjustment.id,mask:{shape:'rectangle',x:0,y:0,width:4,height:8}});const saved=structuredClone(d.layers.at(-1));const result=await b.execute('import_color_lookup',lookup(d,'gain-half','adjustment',{layerId:adjustment.id}));assert.deepEqual({...result.document.layers.at(-1),parameters:saved.parameters},saved);
 assert.equal(result.document.revision,d.revision+1);assert.deepEqual(await fs.readFile(path.join(b.assetsDir,parameters.asset)),authoredCube('rgb-cycle'));
});

test('call-time queue snapshots own imports and reused descriptors without invoking accessor fields',async t=>{
 const{b,d}=await fixture(t);const{expectedRevision,...unbound}=lookup(d,'identity');await assert.rejects(b.dispatch('import_color_lookup',unbound));let release;const hold=new Promise(r=>release=r);b.enqueue(()=>hold);
 const args=lookup(d,'rgb-cycle');const pending=b.execute('import_color_lookup',args);args.data=authoredCube('identity').toString('base64');args.sourceName='changed.cube';release();const first=await pending;assert.equal(first.document.layers[0].filters[0].parameters.sourceName,'rgb-cycle.cube');
 let reads=0;const parameters={...first.document.layers[0].filters[0].parameters};Object.defineProperty(parameters,'asset',{enumerable:true,get(){reads++;return'a'.repeat(64);}});await assert.rejects(edit(b,first.document,'add_adjustment',{kind:'color_lookup',value:0,parameters}));assert.equal(reads,0);
 const inactive=Buffer.from([13,127,253,1]),prepare=b.prepareColorLookup;b.prepareColorLookup=async()=>{throw Error('Inactive lookup read an asset');};try{assert.equal(await b.applyAdjustment(inactive,1,1,{kind:'color_lookup',value:0,parameters:first.document.layers[0].filters[0].parameters,opacity:0}),inactive);}finally{b.prepareColorLookup=prepare;}
 let release2;const hold2=new Promise(r=>release2=r);b.enqueue(()=>hold2);const patch=structuredClone(first.document.layers[0].filters[0].parameters),promise=b.execute('add_adjustment',{documentId:d.id,expectedRevision:first.document.revision,kind:'color_lookup',value:0,parameters:patch});patch.asset='0'.repeat(64);patch.sourceName='mutated.cube';release2();const second=await promise;assert.equal(second.document.layers.at(-1).parameters.sourceName,'rgb-cycle.cube');
});

test('transaction import budgets and real persistence or late Bake failures publish neither new assets nor partial history',async t=>{
 const{b,d}=await fixture(t),before=JSON.stringify(b.project(d.id)),files=(await fs.readdir(b.assetsDir)).sort(),bytes=authoredCube('rgb-cycle');
 const padded=Buffer.concat([bytes,Buffer.from(('#'+'x'.repeat(4000)+'\n').repeat(550))]);assert.ok(padded.length>2*1024*1024&&padded.length<4*1024*1024);
 const importArgs={target:'layer-filter',layerId:d.layers[0].id,data:padded.toString('base64'),sourceName:'large.cube',inputSpace:'srgb'};
 await assert.rejects(edit(b,d,'apply_transaction',{operations:[{command:'import_color_lookup',args:importArgs},{command:'import_color_lookup',args:importArgs}]}));assert.deepEqual((await fs.readdir(b.assetsDir)).sort(),files);assert.equal(JSON.stringify(b.project(d.id)),before);
 const {documentId,expectedRevision,...small}=lookup(d,'cross-products');await assert.rejects(edit(b,d,'apply_transaction',{operations:[{command:'import_color_lookup',args:small},{command:'bake_layer_filters',args:{layerId:d.layers[0].id}},{command:'delete_layer',args:{layerId:randomUUID()}}]}));assert.equal(JSON.stringify(b.project(d.id)),before);assert.deepEqual((await fs.readdir(b.assetsDir)).sort(),files);
 const directory=b.projectsDir;b.projectsDir=path.join(b.assetsDir,d.layers[0].asset);try{await assert.rejects(b.execute('import_color_lookup',lookup(d,'gentle-crosscolor')),{code:'ENOTDIR'});}finally{b.projectsDir=directory;}assert.equal(JSON.stringify(b.project(d.id)),before);assert.deepEqual((await fs.readdir(b.assetsDir)).sort(),files);
});

test('inactive and history-only lookups retain originals through portable export and restart, and corruption rejects before source evaluation',async t=>{
 const{b,d:initial,dir}=await fixture(t);let d=(await b.execute('import_color_lookup',lookup(initial,'rgb-cycle'))).document;const parameters=d.layers[0].filters[0].parameters;d=await edit(b,d,'update_layer_filter',{layerId:d.layers[0].id,filterId:d.layers[0].filters[0].id,enabled:false});
 const bundle=await b.exportProject({documentId:d.id});const restored=(await b.importProject({data:bundle.data})).document;assert.deepEqual(restored.layers[0].filters[0].parameters,parameters);assert.deepEqual(await fs.readFile(path.join(b.assetsDir,parameters.asset)),authoredCube('rgb-cycle'));
 d=await edit(b,d,'clear_layer_filters',{layerId:d.layers[0].id});const restart=await new NativeBackend({dataDir:dir}).init();try{assert.ok(restart.projects.has(d.id));assert.deepEqual(graph(restart,d).layers[0].filters,[]);}finally{await restart.close();}
 const asset=path.join(b.assetsDir,parameters.asset),original=await fs.readFile(asset);await fs.writeFile(asset,Buffer.alloc(original.length,32));const corrupt=await new NativeBackend({dataDir:dir}).init();try{assert.equal(corrupt.projects.has(d.id),false);assert.equal(corrupt.projects.has(restored.id),false);assert.ok(corrupt.loadWarnings.length>=2);}finally{await corrupt.close();await fs.writeFile(asset,original);}
 const check=await new NativeBackend({dataDir:dir}).init();try{assert.equal(check.projects.has(d.id),true);}finally{await check.close();}
});
