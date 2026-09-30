import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { BLEND_MODES } from '../server/blend.mjs';
import { setLayerFillOpacity, layerFillOpacity } from '../server/layer-fill.mjs';
import { layerFillReference, LAYER_FILL_REFERENCE_MODES } from './fixtures/layer-fill/reference.mjs';
const coded=code=>e=>e.code===code;
const same=(a,b)=>{assert.equal(a.length,b.length);const i=a.findIndex((v,i)=>v!==b[i]);assert.equal(i,-1,`byte ${i}: ${a[i]} vs ${b[i]}`);};
const base=extra=>({id:randomUUID(),name:'Fill owner',type:'solid',color:'#6789ab',visible:true,opacity:1,blendMode:'normal',width:12,height:10,transforms:[],...extra});
const graph=(layers,w=12,h=10)=>({name:'Fill owner',width:w,height:h,layers,selection:null});
const current=(n,d)=>n.project(d.id).states[n.project(d.id).cursor].graph;
const edit=async(n,d,c,a={})=>(await n.execute(c,{documentId:d.id,expectedRevision:d.revision,...a})).document;
async function setup(t,options={}){const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'prism-fill-owner-'));const n=await new NativeBackend({dataDir,...options}).init();t.after(async()=>{await n.close();await fs.rm(dataDir,{recursive:true,force:true});});return n;}
async function raster(n,rgba,w,h,extra={}){const asset=await n.storeAsset(await sharp(rgba,{raw:{width:w,height:h,channels:4}}).png().toBuffer());return base({type:'raster',width:w,height:h,asset,sourceAsset:asset,sourceFormat:'png',...extra});}

test('Fill1 preserves every native blend path and partial body matches independent source-over with unfilled styles',async t=>{
 const n=await setup(t),w=12,h=10,rgba=Buffer.alloc(w*h*4),backdrop=Buffer.alloc(w*h*4);
 for(let i=0;i<w*h;i++){backdrop.set([43,97,153,255],i*4);if(i%w>=3&&i%w<=6&&Math.floor(i/w)>=3&&Math.floor(i/w)<=5)rgba.set([39+i%173,77,205,[0,1,128,255][i%4]],i*4);}
 const body=await raster(n,rgba,w,h,{opacity:.5,outline:{width:1,color:'#ffffff'},effects:{shadow:{color:'#ef3311',opacity:.6,blur:0,x:3,y:0},glow:{color:'#1177ee',opacity:.4,blur:1}}});
 const lower=await raster(n,backdrop,w,h);
 for(const mode of BLEND_MODES){const layer={...body,blendMode:mode},before=await n.renderGraph(graph([lower,layer]));same(await n.renderGraph(graph([lower,setLayerFillOpacity(layer,1)])),before);}
 const decoration=await n.layerDecoration(graph([body]),body,rgba,()=>1);
 for(const mode of LAYER_FILL_REFERENCE_MODES)for(const fill of [0,.25,.5,1]){
  const layer=setLayerFillOpacity({...body,blendMode:mode},fill),actual=await n.renderGraph(graph([lower,layer]));
  same(actual,layerFillReference(backdrop,rgba,{decoration,opacity:.5,fillOpacity:fill,blendMode:mode}));
 }
 const single=await raster(n,Buffer.from([200,30,90,1]),1,1,{opacity:.5});assert.equal((await n.renderGraph(graph([setLayerFillOpacity(single,.5)],1,1)))[3],0);
});

test('Fill style edits, capture, explicit reset, Undo and restart preserve canonical stored and public boundaries',async t=>{
 const n=await setup(t),layer=base({effects:{shadow:{}}});let d=(await n.newProject(graph([layer]),'Fixture')).document;
 const id=layer.id,assets=await fs.readdir(n.assetsDir);d=await edit(n,d,'set_layer_fill',{layerId:id,fillOpacity:.375});
 assert.equal(d.layers[0].fillOpacity,.375);assert.equal(d.layers[0].effects.version,undefined);assert.equal(current(n,d).layers[0].effects.styles.shadow.blur,8);
 d=await edit(n,d,'save_layer_style',{layerId:id,name:'Only styles'});assert.equal(Object.hasOwn(d.layerStyles[0],'fillOpacity'),false);
 d=await edit(n,d,'set_layer_effects',{layerId:id,effects:null});assert.equal(d.layers[0].fillOpacity,.375);assert.equal(d.layers[0].effects,undefined);
 d=await edit(n,d,'apply_layer_style',{styleId:d.layerStyles[0].id,layerIds:[id]});assert.equal(d.layers[0].fillOpacity,.375);assert.equal(d.layers[0].effects.shadow.blur,8);
 d=await edit(n,d,'set_layer',{layerId:id,opacity:.7});assert.equal(d.layers[0].fillOpacity,.375);const pixels=await n.render(n.project(d.id));
 const reset=await edit(n,d,'set_layer_fill',{layerId:id,fillOpacity:1});assert.equal(Object.hasOwn(reset.layers[0],'fillOpacity'),false);assert.equal(current(n,reset).layers[0].effects.version,undefined);
 d=await edit(n,reset,'undo');same(await n.render(n.project(d.id)),pixels);
 const reopened=await new NativeBackend({dataDir:n.dataDir}).init();t.after(()=>reopened.close());assert.equal(reopened.loadWarnings.length,0);assert.equal((await reopened.execute('get_document',{documentId:d.id})).document.layers[0].fillOpacity,.375);same(await reopened.render(reopened.project(d.id)),pixels);assert.deepEqual(await fs.readdir(n.assetsDir),assets);
});

test('Fill zero keeps unfilled placement, extraction and rasterized content recoverable while visible arrangement refuses',async t=>{
 const n=await setup(t,{segmentSubject:async()=>({alpha:Buffer.alloc(120,255),width:12,height:10,model:'fixture'})});
 const bytes=Buffer.alloc(120*4);for(let y=3;y<6;y++)for(let x=3;x<7;x++)bytes.set([90,140,210,255],(y*12+x)*4);
 const layer=await raster(n,bytes,12,10,{effects:{shadow:{color:'#ee1100',opacity:1,blur:0,x:2,y:0}}});let d=(await n.newProject(graph([layer]),'Fixture')).document;
 d=await edit(n,d,'set_layer_fill',{layerId:layer.id,fillOpacity:0});const raw=await n.renderLayer(current(n,d).layers[0]);same(raw,bytes);
 const pixels=await n.render(n.project(d.id));assert.equal(pixels[(4*12+4)*4+3],0);assert.equal(pixels[(4*12+8)*4+3],255);
 await assert.rejects(edit(n,d,'align_layers',{layerIds:[layer.id],axis:'horizontal',alignment:'start',relativeTo:'canvas'}),coded('EMPTY_LAYER'));
 let target=(await n.execute('create_document',{width:12,height:10})).document;
 target=await edit(n,target,'place_layer',{sourceDocumentId:d.id,sourceLayerId:layer.id,x:3,y:3,width:4,height:3,protect:false});
 assert.equal(target.layers.at(-1).fillOpacity,0);assert.deepEqual(target.layers.at(-1).placement.sourceBounds,{left:3,top:3,width:4,height:3});
 const placed=current(n,target).layers.at(-1),placedRaw=await n.renderLayer(placed);assert.equal(placedRaw[(4*12+4)*4+3],255);
 d=await edit(n,d,'extract_subject',{layerId:layer.id,protect:false});assert.equal(d.layers.at(-1).fillOpacity,0);
 let vector=(await n.execute('create_document',{width:12,height:10})).document;vector=await edit(n,vector,'add_shape',{shape:'rectangle',x:3,y:3,width:4,height:3,fill:'#4488cc'});const vid=vector.layers.at(-1).id;
 vector=await edit(n,vector,'set_layer_fill',{layerId:vid,fillOpacity:.25});const before=await n.render(n.project(vector.id));vector=await edit(n,vector,'rasterize_layer',{layerId:vid});assert.equal(vector.layers.at(-1).fillOpacity,.25);same(await n.render(n.project(vector.id)),before);
});

test('Fill retains raw source and separate alpha through filters, Distort and Bake, and PSD refuses before pixels',async t=>{
 const n=await setup(t),rgba=Buffer.alloc(120*4);for(let i=0;i<120;i++)rgba.set([i,180,27,[0,1,128,255][i%4]],i*4);
 const layer=await raster(n,rgba,12,10,{alphaAsset:await n.storeAlpha(Buffer.alloc(120,128),12,10)});let d=(await n.newProject(graph([layer]),'Fixture')).document;
 d=await edit(n,d,'set_layer_fill',{layerId:layer.id,fillOpacity:.37});d=await edit(n,d,'add_layer_filter',{layerId:layer.id,kind:'invert',value:100});
 d=await edit(n,d,'add_layer_distort',{layerId:layer.id,corners:[{x:0,y:0},{x:12,y:0},{x:12,y:10},{x:0,y:10}]});
 const source=await fs.readFile(path.join(n.assetsDir,layer.sourceAsset)),before=await n.render(n.project(d.id));
 d=await edit(n,d,'bake_layer_filters',{layerId:layer.id});assert.equal(d.layers[0].fillOpacity,.37);assert.equal(d.layers[0].alphaAsset,layer.alphaAsset);same(await n.render(n.project(d.id)),before);assert.deepEqual(await fs.readFile(path.join(n.assetsDir,layer.sourceAsset)),source);
 const renderLayer=n.renderLayer;n.renderLayer=async()=>{throw Error('Unexpected source read');};try{const report=await n.inspectPsdExport({documentId:d.id});assert.equal(report.supported,false);assert.ok(report.issues.some(i=>i.code==='FILL_UNSUPPORTED'));}finally{n.renderLayer=renderLayer;}
});

test('Fill freezes partial protected values and refuses clipping and malformed stored projection before source reads',async t=>{
 const n=await setup(t),layer=base();let d=(await n.newProject(graph([layer]),'Fixture')).document;
 d=await edit(n,d,'set_layer_fill',{layerId:layer.id,fillOpacity:.25});d=await edit(n,d,'set_layer_protection',{layerId:layer.id,protected:true});d=await edit(n,d,'set_layer_fill',{layerId:layer.id,fillOpacity:.25});
 await assert.rejects(edit(n,d,'set_layer_fill',{layerId:layer.id,fillOpacity:.5}),coded('PROTECTED_LAYER'));
 d=await edit(n,d,'apply_transaction',{label:'Freeze Fill',operations:[{command:'set_layer_protection',args:{layerId:layer.id,protected:false}},{command:'set_layer_fill',args:{layerId:layer.id,fillOpacity:0}},{command:'set_layer_protection',args:{layerId:layer.id,protected:true}}]});
 assert.ok((await n.protectedPixels(current(n,d))).every(x=>x===0));
 const invalid=structuredClone(current(n,d));invalid.layers[0].fillOpacity=1;assert.throws(()=>n.validateGraph(invalid),coded('INVALID_ARGUMENT'));
 const other=base(),partial=setLayerFillOpacity(base(),.5);const clipped={...other,clipBaseId:partial.id};assert.throws(()=>n.validateGraph(graph([partial,clipped])),coded('INVALID_TARGET'));
 const future=structuredClone(current(n,d));future.layers[0].effects.styles={shadow:{}};assert.throws(()=>n.validateGraph(future),coded('INVALID_ARGUMENT'));
});

test('Fill command owns queued arguments and failed transactions leave committed metadata and disk unchanged',async t=>{
 const n=await setup(t),layer=base();let d=(await n.newProject(graph([layer]),'Fixture')).document;
 let release;const before=n.queue;n.queue=new Promise(resolve=>{release=resolve;});const args={documentId:d.id,expectedRevision:d.revision,layerId:layer.id,fillOpacity:.375};const pending=n.execute('set_layer_fill',args);args.fillOpacity=.9;release();d=(await pending).document;assert.equal(d.layers[0].fillOpacity,.375);assert.notEqual(n.queue,before);
 const disk=await fs.readFile(path.join(n.projectsDir,`${d.id}.json`)),prior=structuredClone(current(n,d));
 await assert.rejects(edit(n,d,'apply_transaction',{label:'Rollback Fill',operations:[{command:'set_layer_fill',args:{layerId:layer.id,fillOpacity:.1}},{command:'set_layer_fill',args:{layerId:randomUUID(),fillOpacity:.5}}]}),coded('NOT_FOUND'));
 assert.deepEqual(current(n,d),prior);assert.deepEqual(await fs.readFile(path.join(n.projectsDir,`${d.id}.json`)),disk);
});

test('Fill photographic masked and unmasked arithmetic agrees in fresh optimized processes',async()=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),run=promisify(execFile),worker=new URL('./fixtures/layer-fill/cold-worker.mjs',import.meta.url);
 const first=await run(process.execPath,[worker.pathname],{timeout:20000}),second=await run(process.execPath,[worker.pathname],{timeout:20000});
 assert.equal(first.stderr,'');assert.equal(second.stderr,'');assert.match(first.stdout.trim(),/^[a-f0-9]{64}$/);assert.equal(first.stdout,second.stdout);
});
