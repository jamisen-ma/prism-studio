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
function error(response){assert.equal(response.isError,true,JSON.stringify(response.content));return JSON.parse(response.content.find(item=>item.type==='text').text);}

test('official MCP exports and imports a portable editable project with exact assets and pixels, as a fresh document', {timeout:20000},async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'prism-project-mcp-'));
  const companion=await createCompanion({dataDir,port:0,getImageKey:async()=>{throw new Error('No key');},imageProvider:async()=>{throw new Error('No provider');}});
  const port=await companion.listen(),client=new Client({name:'prism-project-tests',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'server/mcp.mjs')],cwd:root,env:{PRISM_URL:`http://127.0.0.1:${port}`,PRISM_DATA_DIR:dataDir},stderr:'pipe'});
  transport.stderr?.on('data',()=>{});
  t.after(async()=>{await client.close();await companion.close();await fs.rm(dataDir,{recursive:true,force:true});});
  await client.connect(transport);
  const call=(name,args={})=>client.callTool({name:`prism_${name}`,arguments:args});
  const source=await sharp({create:{width:64,height:48,channels:4,background:'#305070'}}).png().toBuffer();
  const sourceFile=path.join(dataDir,'original.png');await fs.writeFile(sourceFile,source);
  let document=result(await call('import_file',{path:sourceFile,name:'Layered portable original'})).document;
  async function edit(command,args={}){document=result(await call(command,{backend:'native',documentId:document.id,expectedRevision:document.revision,...args})).document;}
  await edit('add_shape',{shape:'ellipse',x:10,y:8,width:24,height:28,fill:'#ee6633'});
  const shapeId=document.layers.at(-1).id;
  await edit('set_layer_effects',{layerId:shapeId,effects:{shadow:{blur:2,x:3,y:2,color:'#000000',opacity:0.5}}});
  await edit('set_layer_protection',{layerId:shapeId,protected:true});
  await edit('group_layers',{layerIds:[shapeId],name:'Protected contents'});
  await edit('select_rectangle',{x:8,y:4,width:32,height:36});
  await edit('save_selection',{name:'Reusable outfit region'});
  await edit('clear_selection');
  const originalDocument=structuredClone(document);
  async function preview(documentId){const response=await call('get_preview',{backend:'native',documentId,maxWidth:64});result(response);return sharp(Buffer.from(response.content.find(item=>item.type==='image').data,'base64')).ensureAlpha().raw().toBuffer();}
  const before=await preview(document.id);
  const exported=result(await call('export_project',{documentId:document.id,expectedRevision:document.revision}));
  assert.equal(exported.historyIncluded,false);assert.equal(exported.editable,true);assert.equal(path.extname(exported.path),'.prism');
  assert.equal(path.dirname(exported.path),path.join(dataDir,'exports'));
  const file=await fs.readFile(exported.path);assert.equal(file.subarray(0,8).toString(),'PRISMB01');
  const importArgs={path:exported.path,name:'Reopened editable project',requestId:'portable-import-once'};
  const responses=await Promise.all([call('import_project_file',importArgs),call('import_project_file',importArgs)]);
  const imported=result(responses[0]);assert.equal(result(responses[1]).document.id,imported.document.id);
  assert.notEqual(imported.document.id,document.id);assert.equal(imported.document.name,importArgs.name);assert.equal(imported.historyIncluded,false);
  assert.equal(imported.document.history.length,1);assert.equal(imported.document.canUndo,false);
  assert.deepEqual(imported.document.layers,document.layers);assert.deepEqual(imported.document.savedSelections,document.savedSelections);
  assert.deepEqual(await preview(imported.document.id),before);
  assert.deepEqual(result(await call('get_document',{backend:'native',documentId:document.id})).document,originalDocument);
  assert.deepEqual(await fs.readFile(sourceFile),source);
  assert.deepEqual(await fs.readFile(path.join(dataDir,'native','assets',imported.document.layers[0].sourceAsset)),source);
  assert.equal(result(await call('list_documents',{backend:'native'})).documents.length,2);
  assert.equal(error(await call('import_project_file',{...importArgs,name:'Changed retry'})).code,'REQUEST_CONFLICT');
  assert.equal(error(await call('export_project',{documentId:document.id,expectedRevision:document.revision-1})).code,'REVISION_CONFLICT');
  assert.equal(error(await call('import_project_file',{...importArgs,path:'relative.prism'})).code,'INVALID_ARGUMENTS');
  const corrupted=path.join(dataDir,'corrupted.prism'),bad=Buffer.from(file);bad[bad.length-1]^=1;await fs.writeFile(corrupted,bad);
  assert.ok(error(await call('import_project_file',{path:corrupted,requestId:'corrupt-project-once'})).code);
  assert.equal(result(await call('list_documents',{backend:'native'})).documents.length,2);
  const restored=result(await call('load_selection',{backend:'native',documentId:imported.document.id,expectedRevision:imported.document.revision,selectionId:imported.document.savedSelections[0].id})).document;
  assert.deepEqual(restored.selection,imported.document.savedSelections[0].mask);
  assert.equal(result(await call('set_layer',{backend:'native',documentId:restored.id,expectedRevision:restored.revision,layerId:shapeId,name:'Still editable after import'})).document.layers.find(layer=>layer.id===shapeId).name,'Still editable after import');
});
