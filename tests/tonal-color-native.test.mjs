import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { ADJUSTMENTS, normalizeParameters, adjustmentTransform, colorTransformYieldRows } from '../server/color.mjs';
import { applyLayerFilters, filterWork, MAX_FILTER_WORK } from '../server/layer-filters.mjs';

const kinds = ['color_balance', 'black_white'];
const coded = code => error => error.code === code;
const input = Buffer.from([1,89,1,255, 11,89,11,128, 31,89,31,1, 1,89,1,0, 255,0,0,255, 0,255,0,128, 0,0,255,1, 91,91,91,255]);
const balance = { shadows:[100,-100,100], midtones:[100,-100,100], highlights:[100,-100,100] };
const entry = (kind, parameters, other={}) => ({id:randomUUID(),kind,value:0,parameters:normalizeParameters(kind,parameters),enabled:true,opacity:1,...other});
const edit = async (native,doc,command,args={}) => (await native.execute(command,{documentId:doc.id,expectedRevision:doc.revision,...args})).document;
const get = async (native,doc) => (await native.execute('get_document',{documentId:doc.id})).document;
const render = (native,doc) => native.render(native.project(doc.id));
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(),'prism-tonal-native-'));
  const native = await new NativeBackend({dataDir}).init();
  t.after(async()=>{ await native.close(); await fs.rm(dataDir,{recursive:true,force:true}); });
  const original = await sharp(input,{raw:{width:4,height:2,channels:4}}).png().toBuffer();
  const doc = (await native.execute('import_image',{name:'Tonal source',data:original.toString('base64'),mimeType:'image/png'})).document;
  return {native,doc,dataDir,original};
}

test('value-zero tonal paths preserve source alpha, invisible RGB and bypass bytes while producing exact tie and hue pixels', async t => {
  const {native} = await fixture(t), original = Buffer.from(input);
  for (const kind of kinds) {
    const f = entry(kind,kind==='color_balance'?balance:undefined);
    const out = await applyLayerFilters(input,4,2,[f]);
    const global = await native.applyAdjustment(input,4,2,f);
    assert.deepEqual(out,global);
    for(let p=0;p<8;p++) {
      const i=p*4; assert.equal(out[i+3],input[i+3]);
      if(!input[i+3]) assert.deepEqual(out.subarray(i,i+4),input.subarray(i,i+4));
    }
    if(kind==='color_balance') {
      assert.deepEqual([...out.subarray(0,4)],[225,0,225,255]);
      assert.deepEqual([...out.subarray(4,8)],[235,0,235,128]);
      assert.deepEqual([...out.subarray(8,12)],[255,0,255,1]);
    } else {
      assert.deepEqual([...out.subarray(16,28)],[102,102,102,255,102,102,102,128,51,51,51,1]);
    }
    for(const options of [{enabled:false},{opacity:0}]) assert.deepEqual(await applyLayerFilters(input,4,2,[{...f,...options}]),original);
  }
  assert.deepEqual(await applyLayerFilters(input,4,2,[entry('color_balance')]),input);
  const a=entry('color_balance',balance), b=entry('black_white',{tint:true,tintColor:'#339966',tintAmount:46.25});
  assert.notDeepEqual(await applyLayerFilters(input,4,2,[a,b]),await applyLayerFilters(input,4,2,[b,a]));
  assert.deepEqual(input,original);
});

test('tonal global coverage preserves protected pixels and applies density and opacity once; selection is adjustment-only', async t => {
  const {native,doc:start}=await fixture(t);
  for(const kind of kinds) {
    const f=entry(kind,kind==='color_balance'?balance:{tint:true}), coverage={shape:'rectangle',x:1,y:0,width:2,height:2,feather:0,invert:false};
    const layer={...f,opacity:.5,mask:coverage,maskDensity:.5}, protection=Uint8Array.from([0,1,0,0,0,0,0,0]);
    const out=await native.applyAdjustment(input,4,2,layer,protection), transform=adjustmentTransform(f);
    for(let p=0;p<8;p++) {
      const i=p*4, own=p%4>=1&&p%4<3, amount=.5*(own?1:.5), expected=[...input.subarray(i,i+4)];
      if(!protection[p]&&input[i+3]) {const rgb=transform(...expected.slice(0,3)); for(let c=0;c<3;c++) expected[c]=Math.round(expected[c]+(rgb[c]-expected[c])*amount);}
      assert.deepEqual([...out.subarray(i,i+4)],expected);
    }
  }
  let doc=await edit(native,start,'select_rectangle',{x:1,y:0,width:1,height:2});
  const before=await render(native,doc);
  doc=await edit(native,doc,'add_adjustment',{kind:'black_white',value:0});
  const out=await render(native,doc), transform=adjustmentTransform({kind:'black_white',value:0});
  for(let p=0;p<8;p++) {const i=p*4; assert.deepEqual([...out.subarray(i,i+4)],p%4===1?[...transform(...before.subarray(i,i+3)),before[i+3]]:[...before.subarray(i,i+4)]);}
  doc=await edit(native,doc,'undo');
  doc=await edit(native,doc,'add_layer_filter',{layerId:doc.layers[0].id,kind:'black_white',value:0});
  const filtered=await native.renderLayer(doc.layers[0]);
  assert.deepEqual([...filtered.subarray(16,20)],[102,102,102,255],'filter ignores live selection');
});

test('partial updates retain authored rows and disabled tint settings through stable filter IDs, undo, bundle and reopen', async t => {
  const {native,doc:start,dataDir,original}=await fixture(t), layerId=start.layers[0].id;
  let doc=await edit(native,start,'add_layer_filter',{layerId,kind:'color_balance',value:0,parameters:{shadows:[-12.34,0,8],preserveLuminosity:false}});
  const id=doc.layers[0].filters[0].id;
  doc=await edit(native,doc,'update_layer_filter',{layerId,filterId:id,parameters:{midtones:[7,-4,9],preserveLuminosity:true}});
  assert.deepEqual(doc.layers[0].filters[0].parameters.shadows,[-12.34,0,8]); assert.equal(doc.layers[0].filters[0].id,id);
  doc=await edit(native,doc,'add_adjustment',{kind:'black_white',value:0,parameters:{tint:false,tintColor:'#ABCDEF',tintAmount:23.45,reds:18.75}});
  const grade=doc.layers.at(-1).id; assert.equal(doc.layers.at(-1).name,'Black & White');
  doc=await edit(native,doc,'set_layer',{layerId:grade,name:'My authored grade'});
  doc=await edit(native,doc,'update_adjustment',{layerId:grade,parameters:{tint:true,blues:71.25}});
  assert.equal(doc.layers.at(-1).name,'My authored grade'); assert.equal(doc.layers.at(-1).parameters.tintColor,'#abcdef'); assert.equal(doc.layers.at(-1).parameters.tintAmount,23.45); assert.equal(doc.layers.at(-1).parameters.reds,18.75);
  const pixels=await render(native,doc); doc=await edit(native,doc,'undo'); assert.equal(doc.layers.at(-1).parameters.tint,false);
  doc=await edit(native,doc,'redo'); assert.deepEqual(await render(native,doc),pixels);
  const imported=(await native.importProject({data:(await native.exportProject({documentId:doc.id})).data})).document;
  assert.deepEqual(imported.layers,doc.layers); assert.deepEqual(await render(native,imported),pixels);
  const reopened=await new NativeBackend({dataDir}).init(); t.after(()=>reopened.close()); assert.deepEqual(await render(reopened,doc),pixels);
  assert.deepEqual(await fs.readFile(path.join(native.assetsDir,doc.layers[0].sourceAsset)),original);
  assert.deepEqual(await fs.readdir(native.assetsDir),[doc.layers[0].asset]);
});

test('tonal recipe steps store complete independent defaults and replace authored target parameters atomically', async t => {
  const {native,doc:start,original}=await fixture(t);
  let doc=await edit(native,start,'add_adjustment',{kind:'black_white',value:0,parameters:{reds:-200,tint:true,tintColor:'#ff0000'}});
  const args={name:'Reusable tonal treatment',slots:[{key:'photo',type:'raster'},{key:'grade',type:'adjustment',kind:'black_white'}],steps:[
    {command:'add_layer_filter',target:'photo',args:{kind:'color_balance',value:0,parameters:{shadows:[-5,0,10]}}},
    {command:'update_adjustment',target:'grade',args:{value:0,parameters:{tintColor:'#ABCDEF',tintAmount:12.5}}},
  ]};
  const saved=await native.execute('save_edit_recipe',{documentId:doc.id,expectedRevision:doc.revision,...args}); doc=saved.document;
  const recipe=doc.editRecipes[0]; assert.deepEqual(recipe.steps[0].args.parameters.midtones,[0,0,0]); assert.equal(recipe.steps[0].args.parameters.preserveLuminosity,true);
  assert.equal(recipe.steps[1].args.parameters.reds,40); assert.equal(recipe.steps[1].args.parameters.tint,false);
  const before=doc, bindings={photo:doc.layers[0].id,grade:doc.layers[1].id};
  doc=await edit(native,doc,'apply_edit_recipe',{recipeId:saved.recipeId,bindings});
  assert.equal(doc.history.length,before.history.length+1); assert.deepEqual(doc.layers[1].parameters,recipe.steps[1].args.parameters);
  args.steps[0].args.parameters.shadows[0]=99; assert.equal(doc.layers[0].filters[0].parameters.shadows[0],-5);
  doc=await edit(native,doc,'undo'); assert.deepEqual(doc.layers,before.layers);
  assert.deepEqual(await fs.readFile(path.join(native.assetsDir,doc.layers[0].sourceAsset)),original);
});

test('weighted admission includes hidden layers, exact 9.6 MP boundary and preserve-flag updates before any source I/O', async t => {
  const {native,doc:start}=await fixture(t), project=native.project(start.id), base=structuredClone(project.states[project.cursor].graph);
  assert.equal(filterWork(entry('color_balance'),9_600_000),MAX_FILTER_WORK);
  assert.equal(filterWork(entry('color_balance',{preserveLuminosity:false}),24_000_000),240_000_000);
  assert.equal(filterWork(entry('black_white'),24_000_000),168_000_000);
  assert.equal(filterWork(entry('color_balance',undefined,{enabled:false}),24_000_000),0);
  const layer=base.layers[0]; layer.width=4000; layer.height=2400; layer.transforms=[{type:'resize',width:4,height:2}]; layer.visible=false; layer.filters=[entry('color_balance')];
  assert.doesNotThrow(()=>native.validateGraph(base)); layer.height=2401; assert.throws(()=>native.validateGraph(base),coded('LIMIT_EXCEEDED'));
  layer.height=3000; layer.filters[0].parameters.preserveLuminosity=false; assert.doesNotThrow(()=>native.validateGraph(base));
  let doc=(await native.newProject(base,'Large hidden source')).document;
  const before=await fs.readFile(path.join(native.projectsDir,`${doc.id}.json`)), assets=await fs.readdir(native.assetsDir);
  native.renderLayer=native.renderGraph=native.sourcePixels=native.storeAsset=async()=>{throw new Error('Unexpected source I/O');};
  await assert.rejects(edit(native,doc,'update_layer_filter',{layerId:layer.id,filterId:layer.filters[0].id,parameters:{preserveLuminosity:true}}),coded('LIMIT_EXCEEDED'));
  assert.deepEqual(await get(native,doc),doc); assert.deepEqual(await fs.readFile(path.join(native.projectsDir,`${doc.id}.json`)),before); assert.deepEqual(await fs.readdir(native.assetsDir),assets);
  layer.filters[0].enabled=false; layer.filters[0].parameters.preserveLuminosity=true; assert.doesNotThrow(()=>native.validateGraph(base));
  layer.filters[0].enabled=true; layer.filters[0].opacity=0; assert.doesNotThrow(()=>native.validateGraph(base));
  for(const kind of kinds) assert.deepEqual(ADJUSTMENTS[kind],[0,0]);
});

test('tonal failures preserve committed graph, cache, assets and protection; widest permitted rows yield in both paths', async t => {
  const {native,doc:start}=await fixture(t), layerId=start.layers[0].id;
  let doc=await edit(native,start,'set_layer_protection',{layerId,protected:true});
  await assert.rejects(edit(native,doc,'add_layer_filter',{layerId,kind:'black_white',value:0}),coded('PROTECTED_LAYER'));
  doc=await edit(native,doc,'set_layer_protection',{layerId,protected:false});
  doc=await edit(native,doc,'add_adjustment',{kind:'color_balance',value:0}); const grade=doc.layers.at(-1).id; assert.equal(doc.layers.at(-1).name,'Color Balance');
  const preview=await native.execute('get_preview',{documentId:doc.id}), disk=await fs.readFile(path.join(native.projectsDir,`${doc.id}.json`)), assets=await fs.readdir(native.assetsDir);
  for(const args of [{parameters:{shadows:[.001,0,0]}},{parameters:{tint:true}},{value:1}]) await assert.rejects(edit(native,doc,'update_adjustment',{layerId:grade,...args}),coded('INVALID_ARGUMENT'));
  await assert.rejects(edit(native,doc,'update_adjustment',{layerId:grade,expectedRevision:start.revision,parameters:balance}),coded('REVISION_CONFLICT'));
  const persist=native.persist; native.persist=async()=>{throw Object.assign(new Error('Full disk'),{code:'ENOSPC'});};
  await assert.rejects(edit(native,doc,'update_adjustment',{layerId:grade,parameters:balance}),coded('ENOSPC')); native.persist=persist;
  assert.deepEqual(await get(native,doc),doc); assert.deepEqual(await fs.readFile(path.join(native.projectsDir,`${doc.id}.json`)),disk); assert.deepEqual(await fs.readdir(native.assetsDir),assets); assert.deepEqual(await native.execute('get_preview',{documentId:doc.id}),preview);
  assert.equal(colorTransformYieldRows('color_balance',8192),8); assert.equal(colorTransformYieldRows('color_balance',3000),21); assert.equal(colorTransformYieldRows('color_balance',1),32);
  const width=8192,height=8,rgba=Buffer.alloc(width*height*4); for(let i=0;i<rgba.length;i+=4) rgba.set([1,89,1,255],i);
  for(const mode of ['global','filter']) {let yielded=false; setImmediate(()=>{yielded=true;}); const f=entry('color_balance',balance); const out=mode==='global'?await native.applyAdjustment(rgba,width,height,f):await applyLayerFilters(rgba,width,height,[f]); assert.ok(yielded); assert.deepEqual([...out.subarray(0,4)],[225,0,225,255]);}
});
