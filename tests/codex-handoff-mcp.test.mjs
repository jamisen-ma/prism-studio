import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCompanion } from '../server/index.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function result(response){assert.notEqual(response.isError,true,JSON.stringify(response.content));return response.structuredContent??JSON.parse(response.content.find(item=>item.type==='text').text);}
function failure(response){assert.equal(response.isError,true);return JSON.parse(response.content.find(item=>item.type==='text').text);}
async function fixture(t){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'prism-codex-mcp-'));
  let keyReads=0,providerCalls=0;
  const companion=await createCompanion({dataDir,port:0,getImageKey:async()=>{keyReads++;throw new Error('No API key may be read.');},imageProvider:async()=>{providerCalls++;throw new Error('No provider may be called.');}});
  const port=await companion.listen();
  const client=new Client({name:'prism-codex-handoff-tests',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'server/mcp.mjs')],cwd:root,env:{PRISM_URL:`http://127.0.0.1:${port}`,PRISM_DATA_DIR:dataDir},stderr:'pipe'});
  transport.stderr?.on('data',()=>{});
  t.after(async()=>{await client.close();await companion.close();await fs.rm(dataDir,{recursive:true,force:true});assert.equal(keyReads,0);assert.equal(providerCalls,0);});
  await client.connect(transport);
  const call=(name,args={})=>client.callTool({name:`prism_${name}`,arguments:args});
  const png=await sharp({create:{width:64,height:48,channels:4,background:'#35b780'}}).png().toBuffer();
  const filename=path.join(dataDir,'generated-in-conversation.png');await fs.writeFile(filename,png);
  return{call,client,dataDir,filename,png};
}

test('default MCP generation waits for this conversation and returns its PNG to an editable project exactly once', {timeout:15000},async t=>{
  const{call,client,filename,png,dataDir}=await fixture(t);
  const tools=(await client.listTools()).tools;
  const status=result(await call('ai_status'));
  assert.equal(status.defaultProvider,'codex');assert.equal(status.configurationChecked,false);
  assert.equal(result(await call('status')).ai.configurationChecked,false);
  for(const name of ['get_generation_handoff','complete_generation'])assert.ok(tools.some(tool=>tool.name===`prism_${name}`));
  const args={prompt:'A calm cream paper background only',requestId:'conversation-background-once'};
  const job=result(await call('generate_image',args)).job;
  assert.equal(job.provider,'codex');assert.equal(job.model,'codex-imagegen');assert.equal(job.status,'awaiting_image');
  const handoff=result(await call('get_generation_handoff',{jobId:job.id}));
  assert.equal(handoff.request.prompt,args.prompt);assert.deepEqual(handoff.assets,{});
  assert.match(handoff.instructions,/this conversation/);
  assert.equal(result(await call('generate_image',args)).job.id,job.id);
  assert.deepEqual(result(await call('list_documents',{backend:'native'})).documents,[]);
  const complete=result(await call('complete_generation',{jobId:job.id,path:filename}));
  assert.equal(complete.job.status,'succeeded');assert.equal(complete.document.layers.length,1);
  assert.equal(complete.document.layers[0].role,'generated');
  const original=await fs.readFile(path.join(dataDir,'native','assets',complete.document.layers[0].sourceAsset));assert.deepEqual(original,png);
  const preview=await call('get_generation_preview',{jobId:job.id,maxWidth:64});
  const block=preview.content.find(item=>item.type==='image');assert.ok(block);
  assert.deepEqual(await sharp(Buffer.from(block.data,'base64')).raw().toBuffer(),await sharp(png).raw().toBuffer());
  assert.equal(result(await call('complete_generation',{jobId:job.id,path:filename})).job.status,'succeeded');
  assert.deepEqual(result(await call('get_document',{backend:'native',documentId:complete.document.id})).document,complete.document);
  const different=path.join(dataDir,'different.png');await fs.writeFile(different,await sharp({create:{width:64,height:48,channels:4,background:'#ff0044'}}).png().toBuffer());
  assert.equal(failure(await call('complete_generation',{jobId:job.id,path:different})).code,'IDEMPOTENCY_CONFLICT');
  assert.equal(failure(await call('complete_generation',{jobId:job.id,path:'relative.png'})).code,'INVALID_ARGUMENTS');
});

test('MCP edit handoff exposes saved input/mask and clips returned pixels around grouped protected content and selection', {timeout:15000},async t=>{
  const{call,filename}=await fixture(t);
  let document=result(await call('create_document',{backend:'native',name:'Protected handoff',width:64,height:48,background:'#804020'})).document;
  const common={backend:'native',documentId:document.id};
  async function edit(command,args={}){document=result(await call(command,{...common,expectedRevision:document.revision,...args})).document;}
  await edit('add_shape',{shape:'rectangle',x:8,y:10,width:12,height:20,fill:'#2255ee'});
  const subject=document.layers.at(-1).id;
  await edit('set_layer_protection',{layerId:subject,protected:true});
  await edit('group_layers',{layerIds:[subject],name:'Protected outfit'});
  await edit('select_rectangle',{x:0,y:0,width:32,height:48});
  async function render(){const response=await call('get_preview',{...common,maxWidth:64});result(response);return sharp(Buffer.from(response.content.find(item=>item.type==='image').data,'base64')).ensureAlpha().raw().toBuffer();}
  const before=await render();
  const args={documentId:document.id,expectedRevision:document.revision,scope:'selection',prompt:'Only replace the selected background',requestId:'conversation-edit-once'};
  const job=result(await call('edit_image',args)).job;
  const response=await call('get_generation_handoff',{jobId:job.id});const handoff=result(response);
  assert.equal(response.content.filter(item=>item.type==='image').length,2);
  assert.deepEqual(await sharp(await fs.readFile(handoff.assets.input.path)).ensureAlpha().raw().toBuffer(),before);
  const mask=await sharp(await fs.readFile(handoff.assets.mask.path)).ensureAlpha().raw().toBuffer();
  assert.equal(mask[(15*64+10)*4+3],255);assert.equal(mask[(15*64+50)*4+3],255);assert.equal(mask[(15*64+25)*4+3],0);
  assert.deepEqual(result(await call('get_generation_handoff',{jobId:job.id})).assets,handoff.assets,'References remain stable.');
  assert.equal((await fs.stat(handoff.assets.input.path)).mode&0o777,0o600);
  document=result(await call('complete_generation',{jobId:job.id,path:filename})).document;
  const after=await render();let changed=0;
  for(let i=0;i<mask.length;i+=4){if(mask[i+3])assert.deepEqual(after.subarray(i,i+4),before.subarray(i,i+4));else{assert.deepEqual([...after.subarray(i,i+4)],[53,183,128,255]);changed++;}}
  assert.ok(changed>0);await edit('undo');assert.deepEqual(await render(),before);
});

test('MCP completion retains stale images and cancellation rejects late artifacts without mutating documents', {timeout:15000},async t=>{
  const{call,filename,dataDir}=await fixture(t);
  let document=result(await call('create_document',{backend:'native',name:'Stale handoff',width:64,height:48,background:'#804020'})).document;
  const args={documentId:document.id,expectedRevision:document.revision,prompt:'Background',requestId:'stale-codex-job'};
  const started=result(await call('generate_image',args)).job;
  document=result(await call('set_layer',{backend:'native',documentId:document.id,expectedRevision:document.revision,layerId:document.layers[0].id,name:'Renamed during generation'})).document;
  const complete=result(await call('complete_generation',{jobId:started.id,path:filename}));
  assert.equal(complete.job.status,'ready');assert.equal(complete.job.error.code,'REVISION_CONFLICT');
  assert.deepEqual(result(await call('get_document',{backend:'native',documentId:document.id})).document,document);
  assert.equal(result(await call('complete_generation',{jobId:started.id,path:filename})).job.status,'ready');
  document=result(await call('apply_generation',{jobId:started.id,expectedRevision:document.revision})).document;
  assert.equal(document.layers.length,2);
  const cancelled=result(await call('generate_image',{prompt:'Cancelled artifact',requestId:'cancelled-codex-job'})).job;
  await call('cancel_generation',{jobId:cancelled.id});
  const assets=await fs.readdir(path.join(dataDir,'generation','assets'));
  assert.equal(failure(await call('complete_generation',{jobId:cancelled.id,path:filename})).code,'INVALID_TARGET');
  assert.equal(failure(await call('get_generation_handoff',{jobId:cancelled.id})).code,'INVALID_TARGET');
  assert.deepEqual(await fs.readdir(path.join(dataDir,'generation','assets')),assets);
  assert.deepEqual(result(await call('get_document',{backend:'native',documentId:document.id})).document,document);
});
