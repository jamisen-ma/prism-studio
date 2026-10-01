import test from 'node:test';
import assert from 'node:assert/strict';
import { commandSchemas, validateCommand, validateEditRecipeDefinition, readCommands, transactionCommands } from '../shared/commands.mjs';

const base={documentId:'document',expectedRevision:7,layerId:'photo'};
const corners=[{x:0,y:0},{x:16,y:0},{x:16,y:12},{x:0,y:12}];
const commands=['add_layer_distort','update_layer_distort','delete_layer_distort'];
const fields=command=>({...base,...(command==='add_layer_distort'?{}:{transformIndex:3}),...(command==='delete_layer_distort'?{}:{corners})});

test('Distort shared schemas retain exact complete four-corner coordinates and reject malformed shapes',()=>{
  for(const command of commands)assert.deepEqual(validateCommand(command,fields(command)),fields(command));
  const authored=[{x:-16384,y:Number.MIN_VALUE},{x:16384,y:-.25},{x:123.45678901234567,y:16384},{x:-.125,y:0}];
  assert.deepEqual(validateCommand('add_layer_distort',{...base,corners:authored}).corners,authored);
  for(const bad of [undefined,null,{},[],corners.slice(0,3),[...corners,corners[0]],Array(4),corners.map((p,i)=>i? p:null),corners.map((p,i)=>i? p:{x:0}),corners.map((p,i)=>i? p:{...p,z:0}),corners.map((p,i)=>i? p:{x:'0',y:0})])assert.throws(()=>validateCommand('add_layer_distort',{...base,corners:bad}),{code:'INVALID_ARGUMENTS'});
  for(const number of [-16384.0001,16384.0001,Infinity,-Infinity,NaN])for(const axis of ['x','y'])assert.throws(()=>validateCommand('add_layer_distort',{...base,corners:corners.map((p,i)=>i?p:{...p,[axis]:number})}),{code:'INVALID_ARGUMENTS'});
  for(const extra of [{width:16},{height:12},{type:'distort'},{resample:'nearest'},{fitCanvas:true},{transformIndex:0}])assert.throws(()=>validateCommand('add_layer_distort',{...base,corners,...extra}),{code:'INVALID_ARGUMENTS'});
  assert.throws(()=>validateCommand('update_layer_distort',{...base,transformIndex:3,corner:0,x:2,y:3}),{code:'INVALID_ARGUMENTS'});
  assert.throws(()=>validateCommand('delete_layer_distort',{...fields('delete_layer_distort'),corners}),{code:'INVALID_ARGUMENTS'});
});

test('Distort requires positive revisions and indexes the full bounded transform list',()=>{
  for(const command of commands){
    for(const expectedRevision of [undefined,null,0,-1,.5,'7'])assert.throws(()=>validateCommand(command,{...fields(command),expectedRevision}),{code:'INVALID_ARGUMENTS'});
    assert.equal(readCommands.has(command),false);assert.equal(transactionCommands.has(command),true);
  }
  for(const command of commands.slice(1)){
    for(const transformIndex of [0,499])assert.equal(validateCommand(command,{...fields(command),transformIndex}).transformIndex,transformIndex);
    for(const transformIndex of [undefined,null,-1,500,.5,'3'])assert.throws(()=>validateCommand(command,{...fields(command),transformIndex}),{code:'INVALID_ARGUMENTS'});
  }
});

test('Distort transactions inherit one positive revision and preserve sequential indexes without nested revisions',()=>{
  const operations=commands.map(command=>{const {documentId,expectedRevision,...args}=fields(command);return{command,args};});
  const transaction={documentId:base.documentId,expectedRevision:base.expectedRevision,label:'Edit geometry',operations};
  assert.deepEqual(validateCommand('apply_transaction',transaction),transaction);
  for(const expectedRevision of [undefined,0])assert.throws(()=>validateCommand('apply_transaction',{...transaction,expectedRevision}),{code:'INVALID_TRANSACTION'});
  for(const command of commands){
    const {documentId,expectedRevision,...args}=fields(command);
    assert.throws(()=>validateCommand('apply_transaction',{...transaction,operations:[{command,args:{...args,expectedRevision}}]}),{code:'INVALID_TRANSACTION'});
    assert.throws(()=>validateCommand('apply_transaction',{...transaction,operations:[{command,args:{...args,documentId:'other'}}]}),{code:'INVALID_TRANSACTION'});
  }
});

test('Distort extends no legacy affine, resize, selection or recipe shape',()=>{
  assert.deepEqual(validateCommand('transform_layer',{documentId:'d',layerId:'l',x:0,y:0}),{documentId:'d',layerId:'l',x:0,y:0});
  assert.equal(commandSchemas.resize_document.shape.resample.unwrap().options.length,4);
  assert.throws(()=>validateCommand('transform_layer',{...base,x:0,y:0,corners}),{code:'INVALID_ARGUMENTS'});
  assert.throws(()=>validateCommand('resize_document',{documentId:'d',width:16,height:12,corners}),{code:'INVALID_ARGUMENTS'});
  for(const command of commands){
    const {documentId,expectedRevision,layerId,...args}=fields(command);
    assert.throws(()=>validateEditRecipeDefinition({name:'Geometry',slots:[{key:'photo',type:'raster'}],steps:[{command,target:'photo',args}]}),{code:'INVALID_ARGUMENTS'});
  }
});
