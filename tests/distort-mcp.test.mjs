import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCompanion } from '../server/index.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const value=response=>{assert.notEqual(response.isError,true,JSON.stringify(response.content));return response.structuredContent??JSON.parse(response.content.find(item=>item.type==='text').text);};
const failure=response=>{assert.equal(response.isError,true);const message=response.content.find(item=>item.type==='text').text;try{return JSON.parse(message);}catch{return{message};}};
const corners=(width,height,x=0,y=0)=>[{x,y},{x:x+width,y},{x:x+width,y:y+height},{x,y:y+height}];
const displayed=input=>{const output=Buffer.from(input);for(let i=0;i<output.length;i+=4)if(!output[i+3])output.fill(0,i,i+3);return output;};
const half=(n,d)=>Number((2n*n+d)/(2n*d));
function copy(input,width,height,dx,dy){const output=Buffer.alloc(input.length);for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(x-dx>=0&&x-dx<width&&y-dy>=0&&y-dy<height)input.copy(output,4*(y*width+x),4*((y-dy)*width+x-dx),4*((y-dy)*width+x-dx+1));return output;}
// Exact quarter-pixel translation reference: integer coordinates and rational
// premultiplied taps, with no production geometry/matrix/sampling imports.
function fractional(input,width,height,dx4,dy4){
  const output=Buffer.alloc(input.length);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const sx=4*x-dx4,sy=4*y-dy4,left=Math.floor(sx/4),top=Math.floor(sy/4),fx=sx-left*4,fy=sy-top*4;
    let a=0n;const rgb=[0n,0n,0n];
    for(let oy=0;oy<2;oy++)for(let ox=0;ox<2;ox++){
      const px=left+ox,py=top+oy;if(px<0||py<0||px>=width||py>=height)continue;
      const i=4*(py*width+px),w=BigInt((ox?fx:4-fx)*(oy?fy:4-fy)*input[i+3]);a+=w;
      for(let c=0;c<3;c++)rgb[c]+=w*BigInt(input[i+c]);
    }
    if(a){const i=4*(y*width+x);for(let c=0;c<3;c++)output[i+c]=half(rgb[c],a);output[i+3]=half(a,16n);}
  }
  return output;
}
function nearest(input,oldW,oldH,width,height){const output=Buffer.alloc(width*height*4);for(let y=0;y<height;y++)for(let x=0;x<width;x++){const sx=Math.floor((2*x+1)*oldW/(2*width)),sy=Math.floor((2*y+1)*oldH/(2*height));input.copy(output,4*(y*width+x),4*(sy*oldW+sx),4*(sy*oldW+sx+1));}return output;}
async function setup(t){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'prism-distort-mcp-'));let companion,client,stderr='',forbiddenCalls=0;const tokens=[];
  const forbidden=async()=>{forbiddenCalls++;throw Error('Distort must not use generation, segmentation or a key');};
  async function start(){
    companion=await createCompanion({dataDir,port:0,getImageKey:forbidden,imageProvider:forbidden,segmentSubject:forbidden});const port=await companion.listen();tokens.push(companion.token);
    client=new Client({name:'distort-verification',version:'1.0.0'});
    const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'server/mcp.mjs')],cwd:root,env:{PRISM_URL:`http://127.0.0.1:${port}`,PRISM_DATA_DIR:dataDir},stderr:'pipe'});
    transport.stderr?.on('data',bytes=>{stderr+=bytes;});await client.connect(transport);
  }
  t.after(async()=>{await client?.close();await companion?.close();await fs.rm(dataDir,{recursive:true,force:true});assert.equal(forbiddenCalls,0);for(const token of tokens)assert.ok(!stderr.includes(token));});
  await start();return{dataDir,call:(name,args={})=>client.callTool({name:`prism_${name}`,arguments:args}),get native(){return companion.native;},get client(){return client;},restart:async()=>{await client.close();await companion.close();await start();}};
}

test('official MCP Distort retains exact scoped source pixels, editable historical stages, Bake and portable/restart history',{timeout:35000},async t=>{
  const env=await setup(t),{call,dataDir}=env,caps=value(await call('capabilities',{backend:'native'})),status=value(await call('status')).backends.find(item=>item.id==='native');
  assert.equal(caps.layerDistortPolicy,'fixed-frame-projective-bilinear-v1');assert.equal(caps.layerDistortCoordinates,'stage-pixel-edges');assert.deepEqual(caps.layerDistortContentTypes,['raster','solid','text','shape','path','gradient']);
  for(const key of ['layerDistortPolicy','layerDistortCoordinates','layerDistortContentTypes'])assert.deepEqual(status[key],caps[key]);
  assert.equal(caps.limits.maxDistortWork,384_000_000);assert.equal(caps.limits.maxDistortWorkingBytes,268_435_456);assert.equal(caps.limits.maxDistortCorner,16384);
  const tools=(await env.client.listTools()).tools;
  for(const name of ['add_layer_distort','update_layer_distort','delete_layer_distort']){const tool=tools.find(item=>item.name===`prism_${name}`);assert.ok(tool);assert.ok(tool.inputSchema.required.includes('expectedRevision'));assert.equal(tool.inputSchema.additionalProperties,false);assert.match(tool.description,/fixed-frame/i);}
  let document,layerId;
  const args=()=>({backend:'native',documentId:document.id}),get=async()=>value(await call('get_document',args())).document,layer=()=>document.layers.find(item=>item.id===layerId);
  async function edit(command,fields={}){const result=value(await call(command,{...args(),expectedRevision:document.revision,...fields}));document=result.document;return result;}
  async function exported(id=document.id){const file=value(await call('export_document',{backend:'native',documentId:id,format:'png'}));return sharp(await fs.readFile(file.path)).ensureAlpha().raw().toBuffer();}
  const width=8,height=8,raw=Buffer.alloc(width*height*4),alpha=Buffer.alloc(width*height);
  for(let i=0;i<alpha.length;i++){raw.set([(i*31+17)%256,(i*53+3)%256,(i*7+99)%256,[0,1,128,255][i%4]],i*4);alpha[i]=[255,128,64,0][Math.floor(i/4)%4];}
  const png=await sharp(raw,{raw:{width,height,channels:4}}).png().toBuffer(),input=path.join(dataDir,'source.png');await fs.writeFile(input,png);
  document=value(await call('import_file',{path:input,name:'Editable Distort'})).document;layerId=document.layers[0].id;
  const project=env.native.project(document.id),graph=structuredClone(project.states[project.cursor].graph);graph.layers[0].alphaAsset=await env.native.storeAlpha(alpha,width,height);await env.native.commit(project,graph,'Fixture separate alpha');document=await get();
  await edit('add_layer_filter',{layerId,kind:'invert',value:100});await edit('set_layer_filter_mask',{layerId,source:'mask',mask:{shape:'rectangle',x:0,y:0,width:4,height:8}});
  await edit('select_rectangle',{x:1,y:1,width:2,height:2});await edit('save_selection',{name:'Document selection'});await edit('add_guide',{axis:'vertical',position:2});
  const source=Buffer.from(raw);for(let i=0;i<alpha.length;i++){source[i*4+3]=Math.round(raw[i*4+3]*alpha[i]/255);if(source[i*4+3]&&i%width<4)for(let c=0;c<3;c++)source[i*4+c]=255-source[i*4+c];}
  const before=structuredClone(document),assets=new Map();for(const name of await fs.readdir(env.native.assetsDir))assets.set(name,await fs.readFile(path.join(env.native.assetsDir,name)));
  assert.deepEqual(await exported(),displayed(source));
  const once={...args(),expectedRevision:document.revision,layerId,corners:corners(width,height),requestId:'distort-once'};
  const added=value(await call('add_layer_distort',once));document=added.document;assert.deepEqual(value(await call('add_layer_distort',once)),added);assert.equal(document.history.length,before.history.length+1);assert.deepEqual(layer().transforms,[{type:'distort',width,height,corners:corners(width,height)}]);assert.deepEqual(await exported(),displayed(source));
  for(const key of ['selection','savedSelections','guides'])assert.deepEqual(document[key],before[key]);
  await edit('update_layer_distort',{layerId,transformIndex:0,corners:corners(width,height,.25,-.5)});
  assert.deepEqual(await exported(),displayed(fractional(source,width,height,1,-2)));
  const wrong={...args(),expectedRevision:document.revision,layerId,corners:corners(width,height),fitCanvas:true};failure(await call('add_layer_distort',wrong));const stable=await get();assert.deepEqual(stable,document);
  assert.equal(failure(await call('set_layer_filter_mask',{...args(),expectedRevision:document.revision,layerId,source:'selection'})).code,'FILTER_MASK_CAPTURE_GEOMETRY');assert.deepEqual(await get(),stable);
  await edit('transform_layer',{layerId,x:1,y:0});await edit('resize_document',{width:16,height:8,resample:'nearest'});
  const suffix=structuredClone(layer().transforms.slice(1)),context=structuredClone({selection:document.selection,savedSelections:document.savedSelections,guides:document.guides});
  await edit('update_layer_distort',{layerId,transformIndex:0,corners:corners(8,8,2,0)});
  assert.deepEqual(layer().transforms.slice(1),suffix);assert.equal(layer().transforms[0].width,8);
  let expected=nearest(copy(copy(source,8,8,2,0),8,8,1,0),8,8,16,8);assert.deepEqual(await exported(),displayed(expected));
  assert.deepEqual({selection:document.selection,savedSelections:document.savedSelections,guides:document.guides},context);
  await edit('add_layer_distort',{layerId,corners:corners(16,8,-2,0)});expected=copy(expected,16,8,-2,0);assert.deepEqual(await exported(),displayed(expected));
  const middle=structuredClone(document),savedPixels=await exported();
  await edit('delete_layer_distort',{layerId,transformIndex:0});assert.deepEqual(layer().transforms,middle.layers[0].transforms.slice(1));assert.deepEqual(await exported(),displayed(copy(nearest(copy(source,8,8,1,0),8,8,16,8),16,8,-2,0)));
  assert.equal(failure(await call('delete_layer_distort',{...args(),expectedRevision:document.revision,layerId,transformIndex:0})).code,'INVALID_TARGET');assert.equal(failure(await call('update_layer_distort',{...args(),expectedRevision:document.revision,layerId,transformIndex:499,corners:corners(8,8)})).code,'NOT_FOUND');
  await edit('undo');assert.deepEqual(document.layers,middle.layers);assert.deepEqual(await exported(),savedPixels);await edit('redo');await edit('undo');
  const saved=structuredClone(layer());await edit('bake_layer_filters',{layerId});assert.deepEqual(await exported(),savedPixels);assert.deepEqual(layer().transforms,saved.transforms);assert.equal(layer().alphaAsset,saved.alphaAsset);assert.equal(layer().sourceAsset,saved.sourceAsset);assert.deepEqual(layer().filters,[]);assert.equal(layer().filterMask,undefined);
  await edit('set_layer_protection',{layerId,protected:true});const protectedGraph=structuredClone(document);
  for(const command of ['add_layer_distort','update_layer_distort','delete_layer_distort']){const fields={layerId,...(command==='add_layer_distort'?{}:{transformIndex:0}),...(command==='delete_layer_distort'?{}:{corners:corners(8,8)})};assert.equal(failure(await call(command,{...args(),expectedRevision:document.revision,...fields})).code,'PROTECTED_LAYER');assert.deepEqual(await get(),protectedGraph);}
  await edit('undo');await edit('undo');assert.deepEqual(layer(),saved);assert.deepEqual(await exported(),savedPixels);
  await edit('set_layer_mask',{layerId,mask:{x:1,y:0,width:8,height:6}});await edit('set_layer_mask_position',{layerId,x:1,y:0});const mask=structuredClone(layer().mask),scoped=await exported();
  await edit('update_layer_distort',{layerId,transformIndex:0,corners:corners(8,8,1,0)});assert.deepEqual(layer().mask,mask);await edit('undo');assert.deepEqual(await exported(),scoped);
  const portable=value(await call('export_project',{documentId:document.id,expectedRevision:document.revision}));const restored=value(await call('import_project_file',{path:portable.path,requestId:'distort-project'})).document;
  assert.deepEqual(restored.layers,document.layers);assert.deepEqual(await exported(restored.id),scoped);
  const persisted=structuredClone(document);await env.restart();document=await get();assert.deepEqual(document,persisted);assert.deepEqual(await exported(),scoped);assert.equal(failure(await call('add_layer_distort',once)).code,'REVISION_CONFLICT');
  for(const[name,bytes]of assets)assert.deepEqual(await fs.readFile(path.join(env.native.assetsDir,name)),bytes);assert.deepEqual(await fs.readFile(input),png);
});

test('official MCP Distort rejects graph/work limits and invalid transactions without assets or history changes',{timeout:35000},async t=>{
  const env=await setup(t),{call}=env;let document=value(await call('create_document',{backend:'native',name:'Distort memory refusal',width:5000,height:4000,background:'#807050'})).document;
  const args=()=>({backend:'native',documentId:document.id}),get=async()=>value(await call('get_document',args())).document;
  const assetsBefore=(await fs.readdir(env.native.assetsDir)).sort(),file=()=>path.join(env.native.projectsDir,`${document.id}.json`);
  let stable=structuredClone(document),bytes=await fs.readFile(file());
  const refused=failure(await call('add_layer_distort',{...args(),expectedRevision:document.revision,layerId:document.layers[0].id,corners:corners(5000,4000)}));assert.equal(refused.code,'LIMIT_EXCEEDED');assert.deepEqual(await get(),stable);assert.deepEqual(await fs.readFile(file()),bytes);assert.deepEqual((await fs.readdir(env.native.assetsDir)).sort(),assetsBefore);
  document=value(await call('create_document',{backend:'native',name:'Distort work boundary',width:1200,height:1000,background:'#807050'})).document;const layerId=document.layers[0].id;
  const operations=Array.from({length:20},()=>({command:'add_layer_distort',args:{layerId,corners:corners(1200,1000)}}));
  document=value(await call('apply_transaction',{...args(),expectedRevision:document.revision,label:'Exact distortion work budget',operations})).document;assert.equal(document.layers[0].transforms.length,20);assert.equal(document.history.length,2);
  stable=structuredClone(document);bytes=await fs.readFile(file());
  assert.equal(failure(await call('add_layer_distort',{...args(),expectedRevision:document.revision,layerId,corners:corners(1200,1000)})).code,'LIMIT_EXCEEDED');
  assert.equal(failure(await call('apply_transaction',{...args(),expectedRevision:document.revision,label:'Cannot hide intermediate excess',operations:[{command:'add_layer_distort',args:{layerId,corners:corners(1200,1000)}},{command:'delete_layer_distort',args:{layerId,transformIndex:20}}]})).code,'LIMIT_EXCEEDED');
  assert.deepEqual(await get(),stable);assert.deepEqual(await fs.readFile(file()),bytes);
  const invalid=failure(await call('apply_transaction',{...args(),expectedRevision:document.revision,label:'Rollback after valid corners',operations:[{command:'update_layer_distort',args:{layerId,transformIndex:3,corners:corners(1200,1000,.25,0)}},{command:'set_layer',args:{layerId:'missing',name:'No target'}}]}));assert.equal(invalid.code,'NOT_FOUND');assert.deepEqual(await get(),stable);assert.deepEqual(await fs.readFile(file()),bytes);
  const cross=[{x:0,y:0},{x:1200,y:1000},{x:1200,y:0},{x:0,y:1000}];assert.equal(failure(await call('update_layer_distort',{...args(),expectedRevision:document.revision,layerId,transformIndex:3,corners:cross})).code,'INVALID_ARGUMENT');assert.deepEqual(await get(),stable);
  const request={...args(),expectedRevision:document.revision,label:'Revise and remove saved geometry',requestId:'distort-transaction',operations:[{command:'update_layer_distort',args:{layerId,transformIndex:3,corners:corners(1200,1000,.25,0)}},{command:'delete_layer_distort',args:{layerId,transformIndex:7}}]};
  const result=value(await call('apply_transaction',request));document=result.document;assert.deepEqual(value(await call('apply_transaction',request)),result);assert.equal(document.layers[0].transforms.length,19);
  document=value(await call('undo',{...args(),expectedRevision:document.revision})).document;assert.deepEqual(document.layers,stable.layers);assert.deepEqual((await fs.readdir(env.native.assetsDir)).sort(),assetsBefore);
});
