import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCommand,readCommands,transactionCommands} from '../shared/commands.mjs';

const base={documentId:'example-document'};
test('professional color settings enforce kind-specific ranges and valid transfer curves',()=>{
  assert.equal(validateCommand('add_adjustment',{...base,kind:'hue',value:180}).value,180);
  assert.throws(()=>validateCommand('add_adjustment',{...base,kind:'brightness',value:180}),{code:'INVALID_ARGUMENTS'});
  assert.throws(()=>validateCommand('add_adjustment',{...base,kind:'levels',value:1}),{code:'INVALID_ARGUMENTS'});
  const levels={black:20,white:220,gamma:1.2,outputBlack:0,outputWhite:255};
  assert.deepEqual(validateCommand('add_adjustment',{...base,kind:'levels',value:0,parameters:levels}).parameters,levels);
  assert.throws(()=>validateCommand('add_adjustment',{...base,kind:'levels',value:0,parameters:{...levels,white:10}}),{code:'INVALID_ARGUMENTS'});
  assert.throws(()=>validateCommand('add_adjustment',{...base,kind:'curves',value:0,parameters:levels}),{code:'INVALID_ARGUMENTS'});
  assert.throws(()=>validateCommand('add_adjustment',{...base,kind:'curves',value:0,parameters:{points:[{x:1,y:0},{x:255,y:255}]}}),{code:'INVALID_ARGUMENTS'});
  assert.throws(()=>validateCommand('update_adjustment',{...base,layerId:'layer',parameters:{points:[{x:0,y:0},{x:128,y:128},{x:128,y:140},{x:255,y:255}]}}),{code:'INVALID_ARGUMENTS'});
});
test('stroke schemas require actual targets and source for tools that need them',()=>{
  const stroke={...base,tool:'brush',points:[{x:-10,y:40,pressure:0.8},{x:100,y:40}],size:40,hardness:0.5,opacity:0.4,color:'#bbaacc'};
  assert.equal(validateCommand('paint_stroke',stroke).points.length,2);
  assert.throws(()=>validateCommand('paint_stroke',{...stroke,tool:'eraser'}),{code:'INVALID_ARGUMENTS'});
  assert.throws(()=>validateCommand('paint_stroke',{...stroke,tool:'clone',layerId:'target'}),{code:'INVALID_ARGUMENTS'});
  assert.equal(validateCommand('paint_stroke',{...stroke,tool:'clone',layerId:'target',source:{x:12,y:20}}).source.x,12);
  assert.throws(()=>validateCommand('paint_stroke',{...stroke,points:[{x:2,y:3,pressure:2}]}),{code:'INVALID_ARGUMENTS'});
  assert.throws(()=>validateCommand('paint_stroke',{...stroke,size:50000}),{code:'INVALID_ARGUMENTS'});
});
test('selections and masks distinguish polygons from rectangle bounds',()=>{
  const points=[{x:0,y:0},{x:100,y:0},{x:30,y:100}];
  assert.equal(validateCommand('select_region',{...base,shape:'polygon',points,feather:10}).points.length,3);
  assert.throws(()=>validateCommand('select_region',{...base,shape:'polygon'}),{code:'INVALID_ARGUMENTS'});
  assert.throws(()=>validateCommand('select_region',{...base,shape:'ellipse',x:1,y:2}),{code:'INVALID_ARGUMENTS'});
  assert.throws(()=>validateCommand('select_region',{...base,shape:'ellipse',x:0,y:0,width:100,height:100,points}),{code:'INVALID_ARGUMENTS'});
  assert.equal(validateCommand('set_layer_mask',{...base,layerId:'image',mask:null}).mask,null);
  assert.throws(()=>validateCommand('set_layer_mask',{...base,layerId:'image',mask:{shape:'polygon',x:0,y:0,width:100,height:100}}),{code:'INVALID_ARGUMENTS'});
});
test('new mutation commands can be grouped while histogram remains read only',()=>{
  const result=validateCommand('apply_transaction',{...base,label:'Retouch',operations:[
    {command:'add_paint_layer',args:{name:'Clean up'}},
    {command:'select_region',args:{shape:'ellipse',x:10,y:10,width:50,height:30}},
    {command:'paint_stroke',args:{tool:'brush',points:[{x:20,y:20}],size:5,hardness:0,opacity:0.5,color:'#ffffff'}},
  ]});
  assert.equal(result.operations.length,3);assert.ok(transactionCommands.has('update_text'));assert.ok(readCommands.has('get_histogram'));
  assert.throws(()=>validateCommand('apply_transaction',{...base,label:'No reads',operations:[{command:'get_histogram',args:{}}]}),{code:'INVALID_TRANSACTION'});
});
test('editable layer filters have strict bounded contracts, transactions and explicit native-only scope',()=>{
  const args={...base,layerId:'raster',kind:'median',value:3};
  assert.equal(validateCommand('add_layer_filter',args).value,3);
  assert.equal(validateCommand('add_layer_filter',{...args,kind:'threshold',value:0}).value,0);
  for(const invalid of [{kind:'unknown_filter',value:1},{value:4},{value:17},{value:2.5},{opacity:1.1},{mask:{x:0,y:0,width:2,height:2}},{parameters:{black:0,white:255,gamma:1,outputBlack:0,outputWhite:255}}]) {
    assert.throws(()=>validateCommand('add_layer_filter',{...args,...invalid}),{code:'INVALID_ARGUMENTS'});
  }
  const update={...base,layerId:'raster',filterId:'entry'};
  assert.throws(()=>validateCommand('update_layer_filter',update),{code:'INVALID_ARGUMENTS'});
  assert.throws(()=>validateCommand('update_layer_filter',{...update,kind:'invert',value:100}),{code:'INVALID_ARGUMENTS'});
  assert.equal(validateCommand('update_layer_filter',{...update,enabled:false}).enabled,false);
  assert.equal(validateCommand('update_layer_filter',{...update,opacity:0}).opacity,0);
  assert.throws(()=>validateCommand('reorder_layer_filter',{...update,index:8}),{code:'INVALID_ARGUMENTS'});
  const operations=[{command:'add_layer_filter',args:{layerId:'raster',kind:'brightness',value:12}},{command:'clear_layer_filters',args:{layerId:'raster'}}];
  assert.equal(validateCommand('apply_transaction',{...base,label:'Filter changes',operations}).operations.length,2);
  for(const command of ['add_layer_filter','update_layer_filter','reorder_layer_filter','delete_layer_filter','clear_layer_filters']) {
    assert.ok(transactionCommands.has(command));assert.equal(readCommands.has(command),false);
  }
});

test('mask morphology requires explicit operation, bounded whole-pixel radius and native backend',()=>{
  for(const command of ['morph_selection','morph_layer_mask']) {
    const args={...base,...(command==='morph_layer_mask'?{layerId:'layer'}:{}),operation:'expand',radius:1};
    assert.equal(validateCommand(command,args).radius,1);
    for(const invalid of [{radius:0},{radius:101},{radius:1.5},{operation:'feather'},{kernel:'disk'}]) assert.throws(()=>validateCommand(command,{...args,...invalid}),{code:'INVALID_ARGUMENTS'});
    assert.ok(transactionCommands.has(command));
  }
  assert.throws(()=>validateCommand('morph_layer_mask',{...base,operation:'border',radius:4}),{code:'INVALID_ARGUMENTS'});
});

test('reusable style commands have bounded unique targets, strict capture fields and transactional native scope',()=>{
  const examples={save_layer_style:{layerId:'source',name:'Warm outline'},apply_layer_style:{styleId:'preset',layerIds:['a','b']},rename_layer_style:{styleId:'preset',name:'New name'},delete_layer_style:{styleId:'preset'}};
  for(const [command,fields] of Object.entries(examples)) {
    assert.doesNotThrow(()=>validateCommand(command,{...base,...fields}));
    assert.ok(transactionCommands.has(command));assert.equal(readCommands.has(command),false);
    assert.throws(()=>validateCommand(command,{...base,...fields,unknown:true}),{code:'INVALID_ARGUMENTS'});
  }
  for(const layerIds of [[],['same','same'],Array.from({length:65},(_,i)=>String(i))]) assert.throws(()=>validateCommand('apply_layer_style',{...base,styleId:'preset',layerIds}),{code:'INVALID_ARGUMENTS'});
  assert.throws(()=>validateCommand('save_layer_style',{...base,layerId:'source',effects:{glow:{blur:3}}}),{code:'INVALID_ARGUMENTS'});
  assert.throws(()=>validateCommand('rename_layer_style',{...base,styleId:'preset',name:' '}),{code:'INVALID_ARGUMENTS'});
  const operations=Object.entries(examples).map(([command,args])=>({command,args}));
  assert.equal(validateCommand('apply_transaction',{...base,label:'Style workflow',operations}).operations.length,4);
});

test('group isolation explicitly separates pass-through and isolated blend semantics',()=>{
  const args={...base,layerId:'group'};
  for(const mode of ['pass-through','isolated']) assert.equal(validateCommand('set_group_compositing',{...args,mode}).mode,mode);
  assert.equal(validateCommand('set_group_compositing',{...args,mode:'isolated',blendMode:'multiply'}).blendMode,'multiply');
  for(const fields of [{mode:'pass-through',blendMode:'multiply'},{mode:'normal'},{mode:'isolated',blendMode:'unknown'},{mode:'isolated',opacity:0.5}]) assert.throws(()=>validateCommand('set_group_compositing',{...args,...fields}),{code:'INVALID_ARGUMENTS'});
  assert.ok(transactionCommands.has('set_group_compositing'));assert.equal(readCommands.has('set_group_compositing'),false);
  const operations=[{command:'set_group_compositing',args:{layerId:'group',mode:'isolated',blendMode:'screen'}}];
  assert.equal(validateCommand('apply_transaction',{...base,label:'Isolate group',operations}).operations.length,1);
});

test('guide commands require whole document-pixel positions and preserve fixed axes on update',()=>{
  const examples={add_guide:{axis:'horizontal',position:0},update_guide:{guideId:'guide',position:8192},delete_guide:{guideId:'guide'},clear_guides:{}};
  for(const [command,fields] of Object.entries(examples)) {
    assert.doesNotThrow(()=>validateCommand(command,{...base,...fields}));
    assert.ok(transactionCommands.has(command));assert.equal(readCommands.has(command),false);
    assert.throws(()=>validateCommand(command,{...base,...fields,unknown:true}),{code:'INVALID_ARGUMENTS'});
  }
  for(const position of [-1,8193,0.5,Infinity]) assert.throws(()=>validateCommand('add_guide',{...base,axis:'vertical',position}),{code:'INVALID_ARGUMENTS'});
  assert.throws(()=>validateCommand('add_guide',{...base,axis:'x',position:1}),{code:'INVALID_ARGUMENTS'});
  assert.throws(()=>validateCommand('update_guide',{...base,guideId:'guide',position:1,axis:'vertical'}),{code:'INVALID_ARGUMENTS'});
  const operations=Object.entries(examples).map(([command,args])=>({command,args}));
  assert.equal(validateCommand('apply_transaction',{...base,label:'Layout guides',operations}).operations.length,4);
});

test('clipping chains have an exact ordered membership contract and native-only transaction scope',()=>{
  const fields={baseLayerId:'base',layerIds:['lower-fill','upper-fill']};
  assert.deepEqual(validateCommand('set_clipping_chain',{...base,...fields}).layerIds,fields.layerIds);
  assert.deepEqual(validateCommand('set_clipping_chain',{...base,...fields,layerIds:[]}).layerIds,[]);
  assert.equal(validateCommand('set_clipping_chain',{...base,...fields,layerIds:Array.from({length:63},(_,i)=>`fill-${i}`)}).layerIds.length,63);
  for(const change of [{layerIds:['same','same']},{layerIds:['base']},{layerIds:Array.from({length:64},(_,i)=>`fill-${i}`)},{layerIds:null},{layerIds:undefined},{blendPolicy:'independent'}]) {
    assert.throws(()=>validateCommand('set_clipping_chain',{...base,...fields,...change}),{code:'INVALID_ARGUMENTS'});
  }
  assert.ok(transactionCommands.has('set_clipping_chain'));assert.equal(readCommands.has('set_clipping_chain'),false);
  const operations=[{command:'set_clipping_chain',args:fields}];
  assert.equal(validateCommand('apply_transaction',{...base,label:'Clip fills',operations}).operations.length,1);
});
