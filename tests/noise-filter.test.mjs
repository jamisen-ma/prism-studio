import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { normalizeNoiseParameters, compileNoiseParameters, noiseHash32, sourceNoiseSample, sourceNoiseByte, sourceNoisePlan, sourceNoiseCandidate, SOURCE_NOISE_POLICY } from '../server/source-noise-filters.mjs';
import { gaussianNoiseDeviate, GAUSSIAN_NOISE_TABLE_SHA256 } from '../server/noise-table.mjs';
import { normalizeLayerFilter, editedFilterStack, applyLayerFilters, layerFilterSharedBytes, layerFilterSpatialCacheBytes, filterWork, validateLayerFilterResources } from '../server/layer-filters.mjs';
import { estimateFilterBakeBytes } from '../server/filter-bake.mjs';
import { layerTree } from '../server/groups.mjs';
import { ADJUSTMENTS, PARAMETERIZED_ADJUSTMENTS } from '../server/color.mjs';

const positive = await fs.readFile(new URL('./fixtures/noise/gaussian-positive-q8192.bin', import.meta.url));
const table = index => index < 2048 ? -positive.readInt16LE((2047-index)*2) : positive.readInt16LE((index-2048)*2);
const coded = code => cause => cause.code === code;
const filter = (parameters, extra = {}) => ({ id: randomUUID(), kind: 'add_noise', value: 0, enabled: true, opacity: 1, ...(parameters === undefined ? {} : { parameters }), ...extra });
const pixels = (w, h) => Buffer.from(Array.from({ length: w*h }, (_, p) => [(p*53+17)%256,(p*173+40)%256,(p*97+121)%256,[0,1,128,255][p%4]]).flat());
function hash(value) { let x=BigInt(value),mask=0xffffffffn; x=((x^(x>>16n))*0x7feb352dn)&mask; x=((x^(x>>15n))*0x846ca68bn)&mask; return Number(x^(x>>16n)); }
function sample(counter, seed, distribution) {
  const key=hash(Number((BigInt(seed)+0x9e3779b9n)&0xffffffffn)),word=hash(Number(((BigInt(counter)*0x9e3779b9n)&0xffffffffn)^BigInt(key)));
  return distribution==='uniform'?2*Math.floor(word/65536)+1-65536:table(Math.floor(word/1048576));
}
function byte(c,q,amount,distribution) {
  const d=BigInt(distribution==='uniform'?65536:8192)*10000n,n=BigInt(c)*d+BigInt(q)*255n*BigInt(Math.round(amount*100));
  return n<=0n?0:n>=255n*d?255:Number((2n*n+d)/(2n*d));
}
function reference(input, parameters) {
  const {amount=5,distribution='uniform',monochromatic=true,seed=1}=parameters,output=Buffer.from(input);
  for(let p=0;p<input.length/4;p++)if(input[p*4+3])for(let c=0;c<3;c++)output[p*4+c]=byte(input[p*4+c],sample(p*3+(monochromatic?0:c),seed,distribution),amount,distribution);
  return output;
}
const mix=(input,candidate,opacity)=>Buffer.from(input.map((v,i)=>i%4===3||!input[i-i%4+3]?v:Math.round(v+(candidate[i]-v)*opacity)));
const edit=async(native,doc,command,args={})=>(await native.execute(command,{documentId:doc.id,expectedRevision:doc.revision,...args})).document;
const graphOf=(native,doc)=>structuredClone(native.project(doc.id).states[native.project(doc.id).cursor].graph);
async function fixture(t){const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'prism-noise-')),native=await new NativeBackend({dataDir}).init();t.after(async()=>{await native.close();await fs.rm(dataDir,{recursive:true,force:true});});const input=pixels(7,5),original=await sharp(input,{raw:{width:7,height:5,channels:4}}).png().toBuffer();const doc=(await native.execute('import_image',{mimeType:'image/png',data:original.toString('base64')})).document;return{native,doc,dataDir,input,original};}

test('maintained Gaussian fixture matches every scalar coefficient and uses one private dedicated lazy backing without metadata allocation',async()=>{
  assert.equal(positive.length,4096);assert.equal(createHash('sha256').update(positive).digest('hex'),GAUSSIAN_NOISE_TABLE_SHA256);
  for(let i=0;i<4096;i++){assert.equal(gaussianNoiseDeviate(i),table(i));assert.equal(gaussianNoiseDeviate(i),-gaussianNoiseDeviate(4095-i));}
  for(const index of[-1,4096,1.5,NaN])assert.throws(()=>gaussianNoiseDeviate(index),coded('INVALID_ARGUMENT'));
  const script=`import assert from 'node:assert/strict';
const real=Buffer.allocUnsafeSlow;let allocations=0;
Buffer.allocUnsafeSlow=function(size){const b=real(size);if(size===4096){allocations++;assert.equal(b.byteOffset,0);assert.equal(b.buffer.byteLength,4096);}return b;};
const helper=await import('./server/source-noise-filters.mjs');const table=await import('./server/noise-table.mjs');
for(const value of Object.values(table))assert.ok(!ArrayBuffer.isView(value));
const entry={kind:'add_noise',value:0,parameters:{distribution:'gaussian'}};
helper.normalizeNoiseParameters(entry.parameters);helper.compileNoiseParameters(entry.parameters);helper.sourceNoisePlan(entry,7,5);assert.equal(allocations,0);
const rgba=Buffer.from([17,128,231,255]);await helper.sourceNoiseCandidate(rgba,1,1,{...entry,parameters:{distribution:'gaussian',amount:0}});assert.equal(allocations,0);
await helper.sourceNoiseCandidate(rgba,1,1,entry);assert.equal(allocations,1);await helper.sourceNoiseCandidate(rgba,1,1,entry);assert.equal(allocations,1);`;
  await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{cwd:path.resolve(new URL('..',import.meta.url).pathname),timeout:5000});
});

test('noise parameters are source-only complete independent defaults, preserve seed endpoints and reject malformed bypass entries',()=>{
  assert.deepEqual(normalizeNoiseParameters(),{amount:5,distribution:'uniform',monochromatic:true,seed:1});
  const input=Object.freeze({seed:0,distribution:'gaussian'}),normalized=normalizeNoiseParameters(input);assert.notEqual(input,normalized);assert.equal(normalized.seed,0);
  assert.equal(normalizeNoiseParameters({seed:0xffffffff}).seed,0xffffffff);assert.equal(Object.keys(ADJUSTMENTS).length,28);assert.ok(!('add_noise'in ADJUSTMENTS));assert.ok(!PARAMETERIZED_ADJUSTMENTS.includes('add_noise'));
  const original=filter({seed:0}),updated=editedFilterStack([original],'update_layer_filter',{filterId:original.id,parameters:{monochromatic:false}});assert.deepEqual(updated[0].parameters,{amount:5,distribution:'uniform',monochromatic:false,seed:0});assert.deepEqual(original.parameters,{seed:0});
  for(const parameters of[null,[],{amount:.001},{amount:-1},{amount:401},{amount:'5'},{seed:-1},{seed:2**32},{seed:1.5},{seed:null},{distribution:'normal'},{monochromatic:1},{sigma:1},{seed:Infinity}])assert.throws(()=>normalizeLayerFilter(filter(parameters,{enabled:false,opacity:0})),coded('INVALID_ARGUMENT'));
  assert.throws(()=>normalizeLayerFilter(filter({amount:0},{value:1})),coded('INVALID_ARGUMENT'));
});

test('refined uint32 hash and both exact additive domains match independent BigInt oracles including opposite deviates and seed endpoints',()=>{
  for(const seed of[0,1,2,0x80000000,0xfffffffe,0xffffffff])for(const distribution of['uniform','gaussian']){
    const compiled=compileNoiseParameters({seed,distribution});
    for(const counter of[0,1,2,3,8191,8192,71999997,71999998,71999999])assert.equal(sourceNoiseSample(counter,compiled),sample(counter,seed,distribution));
  }
  let state=79193;for(let i=0;i<20000;i++){state=(Math.imul(state,1664525)+1013904223)>>>0;assert.equal(noiseHash32(state),hash(state));}
  let count=0;for(const distribution of['uniform','gaussian'])for(const amount of[.01,.1,1,5,12.5,33.33,100,399.99,400]){
    const compiled=compileNoiseParameters({amount,distribution}),length=distribution==='uniform'?65536:4096;
    for(let i=0;i<length;i++){const q=distribution==='uniform'?2*i+1-65536:table(i),c=i%256;assert.equal(sourceNoiseByte(c,q,compiled),byte(c,q,amount,distribution));count++;}
  }assert.equal(count,626688);
  assert.equal(sourceNoiseSample(0,compileNoiseParameters({seed:0})),23775);assert.equal(sourceNoiseSample(1,compileNoiseParameters({seed:0,distribution:'gaussian'})),-4706);
});

test('coordinate sampling is stable through alpha skipping, unrelated IDs, monochromatic changes, source shapes and fractional stack order',async()=>{
  const input=pixels(8,4),before=Buffer.from(input),opaque=Buffer.from(input);for(let i=3;i<opaque.length;i+=4)opaque[i]=255;
  for(const seed of[0,1,0xffffffff])for(const distribution of['uniform','gaussian'])for(const monochromatic of[true,false]){
    const parameters={seed,distribution,monochromatic,amount:17.35},entry=filter(parameters),actual=await sourceNoiseCandidate(input,8,4,entry),all=await sourceNoiseCandidate(opaque,8,4,entry);
    assert.deepEqual(actual,reference(input,parameters));assert.deepEqual(await sourceNoiseCandidate(input,4,8,{...entry,id:randomUUID()}),actual);
    for(let p=0;p<32;p++){assert.equal(actual[p*4+3],input[p*4+3]);assert.deepEqual(actual.subarray(p*4,p*4+3),input[p*4+3]?all.subarray(p*4,p*4+3):input.subarray(p*4,p*4+3));}
    const mono=await sourceNoiseCandidate(input,8,4,filter({...parameters,monochromatic:true}));for(let p=0;p<32;p++)assert.equal(mono[p*4],actual[p*4]);
  }
  const a=filter({distribution:'gaussian',monochromatic:false,seed:0xffffffff,amount:33.33},{opacity:.625}),b=filter({seed:17,amount:17.35},{opacity:.75});
  const first=mix(input,reference(input,a.parameters),a.opacity),expected=mix(first,reference(first,b.parameters),b.opacity);
  assert.deepEqual(await applyLayerFilters(input,8,4,[a,b]),expected);assert.deepEqual(input,before);
  assert.notDeepEqual(await applyLayerFilters(opaque,8,4,[filter({amount:400},{opacity:.5})]),await applyLayerFilters(opaque,8,4,[filter({amount:200})]));
});

test('shared table lifetime is distinct from sequential rings and charged once at the graph peak and every bake phase',async t=>{
  const gaussian=filter({distribution:'gaussian'}),uniform=filter(),identity=filter({distribution:'gaussian',amount:0}),blur={id:randomUUID(),kind:'blur',value:.1,enabled:true,opacity:1};
  assert.equal(layerFilterSharedBytes([gaussian,gaussian]),4096);assert.equal(layerFilterSharedBytes([uniform,identity]),0);
  for(const entry of[uniform,gaussian,identity,{...gaussian,enabled:false},{...gaussian,opacity:0}]){const plan=sourceNoisePlan(entry,6000,4000);assert.equal(plan.work,filterWork(entry,24000000));assert.equal(plan.sharedBytes,layerFilterSharedBytes([entry]));}
  assert.equal(sourceNoisePlan(gaussian,6000,4000).work,192000000);assert.equal(sourceNoisePlan(identity,6000,4000).work,24000000);
  const options={width:400,height:500,hasAlpha:true,encodedWorkingBytes:71,encodedAlphaBytes:93},base=estimateFilterBakeBytes({...options,filters:[blur]}),noise=estimateFilterBakeBytes({...options,filters:[gaussian,blur,{...gaussian,id:randomUUID()}]});
  assert.equal(noise.sharedBytes,4096);assert.equal(noise.spatialCacheBytes,base.spatialCacheBytes);for(const key of['decodeBytes','filterBytes','encodeBytes','publicationBytes'])assert.equal(noise[key],base[key]+4096);
  assert.equal(layerFilterSpatialCacheBytes([gaussian],400,500),0);
  const {native,doc}=await fixture(t),graph=graphOf(native,doc);graph.layers[0].width=2000;graph.layers[0].height=2000;graph.layers[0].transforms=[{type:'resize',width:7,height:5}];graph.layers[0].filters=[blur];
  const prior=validateLayerFilterResources(graph,layerTree(graph.layers));graph.layers.push({...doc.layers[0],id:randomUUID(),filters:[gaussian],visible:false});
  const after=validateLayerFilterResources(graph,layerTree(graph.layers));assert.equal(after.estimatedScratchBytes,prior.estimatedScratchBytes+4096);
  graph.layers.reverse();assert.equal(validateLayerFilterResources(graph,layerTree(graph.layers)).estimatedScratchBytes,after.estimatedScratchBytes);
});

test('native seeded metadata remains source-only with stable revisions, hidden cumulative-work refusal and active-identity guards before rendering',async t=>{
  const {native,doc:start}=await fixture(t),id=start.layers[0].id,assets=await fs.readdir(native.assetsDir);let doc=start;
  const cap=await native.execute('capabilities');assert.equal(cap.layerFilterKinds.length,32);assert.equal(cap.adjustmentKinds.length,28);assert.equal(cap.layerFilterNoisePolicy,SOURCE_NOISE_POLICY);
  native.renderLayer=async()=>{throw new Error('Unexpected source render');};
  doc=await edit(native,doc,'add_layer_filter',{layerId:id,kind:'add_noise',value:0});assert.deepEqual(doc.layers[0].filters[0].parameters,normalizeNoiseParameters());
  const first=doc.layers[0].filters[0].id;doc=await edit(native,doc,'update_layer_filter',{layerId:id,filterId:first,parameters:{seed:0xffffffff,amount:0}});assert.equal(doc.layers[0].filters[0].parameters.seed,0xffffffff);
  await assert.rejects(edit(native,doc,'set_layer_protection',{layerId:id,protected:true}),coded('PROTECTED_LAYER'));await assert.rejects(edit(native,doc,'add_adjustment',{kind:'add_noise',value:0}),coded('UNSUPPORTED'));
  const graph=graphOf(native,doc);graph.layers[0].width=6000;graph.layers[0].height=4000;graph.layers[0].transforms=[{type:'resize',width:7,height:5}];graph.layers[0].visible=false;graph.layers[0].filters=[filter(),filter()];doc=(await native.commit(native.project(doc.id),graph,'Maximum hidden noise')).document;
  await assert.rejects(edit(native,doc,'add_layer_filter',{layerId:id,kind:'add_noise',value:0,parameters:{amount:0}}),coded('LIMIT_EXCEEDED'));
  assert.deepEqual((await native.execute('get_document',{documentId:doc.id})).document,doc);assert.deepEqual(await fs.readdir(native.assetsDir),assets);
});

test('real separate-alpha masked and transformed noise bakes exact source RGB while preserving originals and portable seeded stacks',async t=>{
  const {native,doc:start,input,original}=await fixture(t),id=start.layers[0].id,alpha=Buffer.from(Array.from({length:35},(_,p)=>[0,1,128,255][p%4]));
  const graph=graphOf(native,start);graph.layers[0].alphaAsset=await native.storeAlpha(alpha,7,5);let doc=(await native.commit(native.project(start.id),graph,'Alpha fixture')).document;
  doc=await edit(native,doc,'add_layer_filter',{layerId:id,kind:'add_noise',value:0,parameters:{amount:17.35,distribution:'gaussian',monochromatic:false,seed:0xffffffff},opacity:.625});
  doc=await edit(native,doc,'set_layer_mask',{layerId:id,mask:{shape:'ellipse',x:0,y:0,width:6,height:4,feather:.5}});doc=await edit(native,doc,'modify_layer_mask',{layerId:id,density:.5});doc=await edit(native,doc,'set_layer_mask_position',{layerId:id,x:1,y:-1});doc=await edit(native,doc,'transform_layer',{layerId:id,x:.25,y:-.25,scaleX:1.2,scaleY:.9,rotation:17});
  const before=doc,rendered=await native.renderGraph(doc),bundle=await native.exportProject({documentId:doc.id}),imported=(await native.importProject({data:bundle.data})).document;
  assert.deepEqual(imported.layers,doc.layers);assert.deepEqual(await native.renderGraph(imported),rendered);
  doc=await edit(native,doc,'bake_layer_filters',{layerId:id});assert.deepEqual(await native.renderGraph(doc),rendered);assert.deepEqual({...doc.layers[0],asset:before.layers[0].asset,filters:before.layers[0].filters},before.layers[0]);
  const effective=Buffer.from(input);for(let p=0;p<35;p++)effective[p*4+3]=Math.round(input[p*4+3]*alpha[p]/255);const entry=before.layers[0].filters[0],expected=mix(effective,reference(effective,entry.parameters),entry.opacity),raw=await sharp(await fs.readFile(path.join(native.assetsDir,doc.layers[0].asset))).ensureAlpha().raw().toBuffer();
  for(let p=0;p<35;p++){assert.equal(raw[p*4+3],input[p*4+3]);assert.deepEqual(raw.subarray(p*4,p*4+3),expected.subarray(p*4,p*4+3));}assert.deepEqual(await fs.readFile(path.join(native.assetsDir,doc.layers[0].sourceAsset)),original);
  doc=await edit(native,doc,'undo');assert.deepEqual(doc.layers,before.layers);
});

test('wide colored Gaussian sampling yields with no random state or seed changes',async()=>{
  const input=pixels(8192,128),entry=filter({seed:0,distribution:'gaussian',monochromatic:false,amount:400});let turns=0,stopped=false;
  const tick=()=>{if(!stopped){turns++;setImmediate(tick);}};setImmediate(tick);const result=await sourceNoiseCandidate(input,8192,128,entry);stopped=true;assert.ok(turns>=16);
  for(const p of[0,1,2,8191,8192,1048575])for(let c=0;c<4;c++)assert.equal(result[p*4+c],c===3||!input[p*4+3]?input[p*4+c]:byte(input[p*4+c],sample(p*3+c,0,'gaussian'),400,'gaussian'));
  assert.equal(entry.parameters.seed,0);
});
