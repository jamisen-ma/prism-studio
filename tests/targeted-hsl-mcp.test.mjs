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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const value = result => { assert.notEqual(result.isError, true, JSON.stringify(result.content)); return result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text); };
const failure = result => { assert.equal(result.isError, true); const message = result.content.find(item => item.type === 'text').text; try { return JSON.parse(message); } catch { return { message }; } };
import { targetedHslNativeReference, TARGETED_HSL_RANGES as RANGE_NAMES } from './fixtures/targeted-hsl/reference.mjs';
async function setup(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-targeted-hsl-mcp-'));
  let companion, client, forbiddenCalls = 0, stderr = ''; const tokens = [];
  const forbidden = async () => { forbiddenCalls++; throw Error('Targeted Hue / Saturation must not use a provider, segmentation or key'); };
  async function start() {
    companion = await createCompanion({ dataDir, port: 0, getImageKey: forbidden, imageProvider: forbidden, segmentSubject: forbidden });
    const port = await companion.listen(); tokens.push(companion.token); client = new Client({ name: 'targeted-hsl-verification', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
    transport.stderr?.on('data', bytes => { stderr += bytes; }); await client.connect(transport);
  }
  t.after(async () => { await client?.close(); await companion?.close(); await fs.rm(dataDir, { recursive: true, force: true }); assert.equal(forbiddenCalls, 0); for (const token of tokens) assert.ok(!stderr.includes(token)); });
  await start(); return { dataDir, call: (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args }), get native() { return companion.native; }, get client() { return client; }, restart: async () => { await client.close(); await companion.close(); await start(); } };
}

const complete = (input = {}) => ({ ...Object.fromEntries(RANGE_NAMES.map(range => [range,[0,0,0]])), ...structuredClone(input) });
const parameters = complete({ master:[12,7,-2], reds:[-13.25,2.5,7], yellows:[3,-6,0], cyans:[50,0,0], greens:[-10,3,11], blues:[5,-10,3] });
const half = (n,d) => Number((2n*n+d)/(2n*d));
const display = input => { const out = Buffer.from(input); for(let i=0;i<out.length;i+=4)if(!out[i+3])out.fill(0,i,i+3);return out; };
function reference(raw, alpha, settings, { blend = false, mask = false } = {}) {
  const output = Buffer.from(raw);
  for(let p=0;p<alpha.length;p++) {
    const i=p*4;output[i+3]=Math.round(raw[i+3]*alpha[p]/255);if(!output[i+3])continue;
    const candidate=targetedHslNativeReference([...raw.subarray(i,i+3)],settings);
    const coverage=mask&&(p%256<32||p%256>=224)?128:255;
    for(let c=0;c<3;c++) {
      const original=raw[i+c], filtered=blend?half(BigInt(original*255+original*candidate[c]),510n):candidate[c];
      output[i+c]=half(BigInt(original*(255-coverage)+filtered*coverage),255n);
    }
  }
  return output;
}
async function importFixture(env, name, transparent = true) {
  const width=256,height=4,raw=Buffer.alloc(width*height*4),alpha=Buffer.alloc(width*height,255);
  for(let p=0;p<alpha.length;p++) { const x=p%width,row=Math.floor(p/width);raw.set([x,255-x,x*37%256,transparent?[255,128,1,0][row]:255],p*4);if(transparent)alpha[p]=row===0?255:[0,1,128,255][x%4]; }
  raw.set([224,1,127,255,224,127,1,255],0);
  const png=await sharp(raw,{raw:{width,height,channels:4}}).png().toBuffer(),input=path.join(env.dataDir,`${name}.png`);await fs.writeFile(input,png);
  let document=value(await env.call('import_file',{path:input,name})).document;
  if(transparent) { const project=env.native.project(document.id),graph=structuredClone(project.states[project.cursor].graph);graph.layers[0].alphaAsset=await env.native.storeAlpha(alpha,width,height);await env.native.commit(project,graph,'Fixture alpha');document=value(await env.call('get_document',{backend:'native',documentId:document.id})).document; }
  return {width,height,raw,alpha,png,input,document};
}

test('official MCP Targeted Hue / Saturation verifies discovery, exact source RGB, sparse rows, mask/blend, Bake and portable restart', {timeout:35000}, async t => {
  const env=await setup(t),{call,dataDir}=env;
  const caps=value(await call('capabilities',{backend:'native'})),status=value(await call('status')).backends.find(item=>item.id==='native');
  assert.equal(caps.adjustmentKinds.length,28);assert.equal(caps.layerFilterKinds.length,32);
  assert.equal(caps.hueSaturationPolicy,'rgb-hue-triangle-hsl-v1');assert.deepEqual(caps.hueSaturationRanges,RANGE_NAMES);
  for(const key of ['hueSaturationPolicy','hueSaturationRanges'])assert.deepEqual(status[key],caps[key]);
  const tools=(await env.client.listTools()).tools;
  for(const name of ['add_adjustment','update_adjustment','add_layer_filter','update_layer_filter'])assert.match(tools.find(tool=>tool.name===`prism_${name}`).description,/rgb-hue-triangle-hsl-v1/);
  const fixture=await importFixture(env,'Targeted HSL source');let document=fixture.document;const {raw,alpha,width,height,png,input}=fixture,layerId=document.layers[0].id;
  const args=()=>({backend:'native',documentId:document.id}),get=async()=>value(await call('get_document',args())).document,layer=()=>document.layers.find(item=>item.id===layerId);
  async function edit(name,fields={}) { const result=value(await call(name,{...args(),expectedRevision:document.revision,...fields}));document=result.document;return result; }
  async function exported(id=document.id) { const file=value(await call('export_document',{backend:'native',documentId:id,format:'png'}));return sharp(await fs.readFile(file.path)).ensureAlpha().raw().toBuffer(); }
  const originals=new Map(await Promise.all((await fs.readdir(env.native.assetsDir)).map(async name=>[name,await fs.readFile(path.join(env.native.assetsDir,name))])));
  await edit('add_layer_filter',{layerId,kind:'hue_saturation',value:0});const filterId=layer().filters[0].id;assert.deepEqual(layer().filters[0].parameters,complete());assert.deepEqual(await exported(),display(reference(raw,alpha,{})));
  await edit('update_layer_filter',{layerId,filterId,parameters:complete({reds:[0,-100,0]})});assert.deepEqual([...(await exported()).subarray(0,3)],[176,49,121]);
  await edit('update_layer_filter',{layerId,filterId,parameters});assert.deepEqual(await exported(),display(reference(raw,alpha,parameters)));
  const next=complete({...parameters,master:[120,-10,0],magentas:[-3.75,9,4]});await edit('update_layer_filter',{layerId,filterId,parameters:{master:next.master,magentas:next.magentas}});
  assert.deepEqual(layer().filters[0].parameters,next);assert.deepEqual(await exported(),display(reference(raw,alpha,next)));
  await edit('update_layer_filter',{layerId,filterId,blendMode:'multiply',opacity:.5});
  await edit('set_layer_filter_mask',{layerId,source:'mask',mask:{shape:'rectangle',x:32,y:0,width:192,height}});await edit('modify_layer_filter_mask',{layerId,density:.5});
  const expected=reference(raw,alpha,next,{blend:true,mask:true});assert.deepEqual(await exported(),display(expected));
  const stable=structuredClone(document),projectPath=path.join(env.native.projectsDir,`${document.id}.json`),saved=await fs.readFile(projectPath);
  for(const bad of [{method:'relative'},{reds:[0,0]},{blues:[0,.001,0]},{master:[180.01,0,0]},{reds:[0,0,0,0]},{colorize:true}]) { failure(await call('update_layer_filter',{...args(),expectedRevision:document.revision,layerId,filterId,parameters:bad}));assert.deepEqual(await get(),stable);assert.deepEqual(await fs.readFile(projectPath),saved); }
  await edit('add_layer_distort',{layerId,corners:[{x:1,y:0},{x:width+1,y:0},{x:width+1,y:height},{x:1,y:height}]});const editable=structuredClone(document),appearance=await exported();
  await edit('bake_layer_filters',{layerId});assert.deepEqual(layer().filters,[]);assert.equal(layer().filterMask,undefined);assert.deepEqual(await exported(),appearance);
  const working=Buffer.from(expected);for(let p=0;p<alpha.length;p++)working[p*4+3]=raw[p*4+3];
  assert.deepEqual(await sharp(await fs.readFile(path.join(env.native.assetsDir,layer().asset))).ensureAlpha().raw().toBuffer(),working);
  await edit('undo');assert.deepEqual(document.layers,editable.layers);
  const portable=value(await call('export_project',{documentId:document.id,expectedRevision:document.revision}));const restored=value(await call('import_project_file',{path:portable.path,requestId:'targeted-hsl-source-portable'})).document;
  assert.deepEqual(restored.layers,document.layers);assert.deepEqual(await exported(restored.id),appearance);
  const persisted=structuredClone(document);await env.restart();document=await get();assert.deepEqual(document,persisted);assert.deepEqual(await exported(),appearance);
  for(const [name,bytes]of originals)assert.deepEqual(await fs.readFile(path.join(env.native.assetsDir,name)),bytes);assert.deepEqual(await fs.readFile(input),png);
});

test('official MCP Targeted HSL recipes normalize omitted rows, reset a global target, append under a mask and replay one atomic Undo', {timeout:35000}, async t => {
  const env=await setup(t),{call}=env,fixture=await importFixture(env,'Targeted HSL recipes',false);let document=fixture.document;
  const {raw,alpha,png,input}=fixture,photoId=document.layers[0].id,args=()=>({backend:'native',documentId:document.id}),get=async()=>value(await call('get_document',args())).document;
  async function edit(name,fields={}) {const result=value(await call(name,{...args(),expectedRevision:document.revision,...fields}));document=result.document;return result;}
  async function exported(){const file=value(await call('export_document',{...args(),format:'png'}));return sharp(await fs.readFile(file.path)).ensureAlpha().raw().toBuffer();}
  await edit('add_layer_filter',{layerId:photoId,kind:'hue_saturation',value:0,parameters:{reds:[10,0,0]}});await edit('set_layer_filter_mask',{layerId:photoId,source:'none'});
  await edit('add_adjustment',{kind:'hue_saturation',value:0,parameters});const gradeId=document.layers.at(-1).id;assert.deepEqual(await exported(),reference(raw,alpha,parameters));
  await edit('update_adjustment',{layerId:gradeId,parameters:{magentas:[1,2,3]}});assert.deepEqual(document.layers.at(-1).parameters.reds,parameters.reds);
  const definition={name:'Neutral Targeted HSL base',slots:[{key:'photo',type:'raster'},{key:'grade',type:'adjustment',kind:'hue_saturation'}],steps:[
    {command:'add_layer_filter',target:'photo',args:{kind:'hue_saturation',value:0,parameters:{blues:[0,-10,0]}}},
    {command:'update_adjustment',target:'grade',args:{value:0,parameters:{}}},
  ]};
  const saved=await edit('save_edit_recipe',definition),recipeId=saved.recipeId,bindings={photo:photoId,grade:gradeId};
  const inspected=value(await call('get_edit_recipe',{...args(),recipeId}));assert.deepEqual(inspected.recipe.steps[1].args.parameters,complete());assert.deepEqual(inspected.recipe.steps[0].args.parameters,complete(definition.steps[0].args.parameters));
  const before=structuredClone(document),appearance=await exported(),assets=(await fs.readdir(env.native.assetsDir)).sort();
  const report=value(await call('validate_edit_recipe',{...args(),recipeId,bindings}));assert.equal(report.valid,true);assert.equal(report.validation,'metadata-only');assert.deepEqual(await get(),before);
  const once={...args(),expectedRevision:document.revision,recipeId,bindings,requestId:'targeted-hsl-recipe-once'};const applied=value(await call('apply_edit_recipe',once));document=applied.document;assert.deepEqual(value(await call('apply_edit_recipe',once)),applied);
  assert.deepEqual(document.layers.at(-1).parameters,complete());assert.equal(document.layers[0].filters.length,2);assert.deepEqual(document.layers[0].filterMask,before.layers[0].filterMask);assert.deepEqual(await exported(),raw);assert.equal(document.history.length,before.history.length+1);
  assert.deepEqual(value(await call('get_edit_recipe',{...args(),recipeId})),{...inspected,revision:document.revision});
  await edit('undo');assert.deepEqual(document.layers,before.layers);assert.deepEqual(await exported(),appearance);
  await edit('apply_transaction',{label:'Explicit Targeted HSL default reset',operations:[{command:'update_adjustment',args:{layerId:gradeId,parameters:complete()}}]});assert.deepEqual(await exported(),raw);
  const snapshot=structuredClone(document),projectPath=path.join(env.native.projectsDir,`${document.id}.json`),bytes=await fs.readFile(projectPath);
  failure(await call('apply_transaction',{...args(),expectedRevision:document.revision,label:'Late Targeted HSL refusal',operations:[{command:'update_adjustment',args:{layerId:gradeId,parameters}},{command:'delete_layer',args:{layerId:'missing'}}]}));assert.deepEqual(await get(),snapshot);assert.deepEqual(await fs.readFile(projectPath),bytes);
  await edit('update_adjustment',{layerId:gradeId,parameters});const persisted=structuredClone(document);await env.restart();document=await get();assert.deepEqual(document,persisted);assert.deepEqual(await exported(),reference(raw,alpha,parameters));assert.equal(failure(await call('apply_edit_recipe',once)).code,'REVISION_CONFLICT');
  assert.deepEqual((await fs.readdir(env.native.assetsDir)).sort(),assets);assert.deepEqual(await fs.readFile(input),png);
});
