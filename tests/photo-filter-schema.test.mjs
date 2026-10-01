import test from 'node:test';
import assert from 'node:assert/strict';
import { commandSchemas, validateCommand } from '../shared/commands.mjs';

const documentId='photo-filter-schema',layerId='photo-filter-layer',filterId='photo-filter-entry';
const additions=['add_adjustment','add_layer_filter'];
const edits=['update_adjustment','update_layer_filter'];
const fields=command=>({documentId,...(command.includes('layer_filter')||command==='update_adjustment'?{layerId}:{}),...(command==='update_layer_filter'?{filterId}:{})});
const invalid=run=>assert.throws(run,error=>error.code==='INVALID_ARGUMENTS');

test('Photo Filter public schemas expose independent global/source kind, flat sparse parameters and exact color/density bounds',()=>{
  assert.ok(commandSchemas.add_adjustment.shape.kind.options.includes('photo_filter'));
  assert.ok(commandSchemas.add_layer_filter.shape.kind.options.includes('photo_filter'));
  for(const command of additions)for(const parameters of [undefined,{}, {color:'#ABCdef'}, {density:0}, {density:100}, {density:.01}, {density:99.99}, {preserveLuminosity:false}, {color:'#010203',density:37.25,preserveLuminosity:true}]){
    const input={...fields(command),kind:'photo_filter',value:0,...(parameters===undefined?{}:{parameters})};
    assert.deepEqual(validateCommand(command,input),input);
  }
  for(const command of [...additions,...edits])for(const parameters of [null,[],{color:'#abc'}, {color:'#abcdef\n'}, {color:' #abcdef'}, {color:'#abcdef00'}, {color:'#gg0000'}, {color:1}, {density:-.01}, {density:100.01}, {density:.001}, {density:Number.MIN_VALUE}, {density:Infinity}, {density:NaN}, {density:'25'}, {preserveLuminosity:0}, {preserveLuminosity:'true'}, {color:'#ff9500',kelvin:6500}, {density:25,tint:true}]){
    const input={...fields(command),...(additions.includes(command)?{kind:'photo_filter',value:0}:{}),parameters};
    invalid(()=>validateCommand(command,input));
  }
});

test('Photo Filter parameters cannot attach to unrelated kinds and creation requires the zero value',()=>{
  for(const command of additions){
    for(const value of [-1,.01,1,25])invalid(()=>validateCommand(command,{...fields(command),kind:'photo_filter',value}));
    for(const parameters of [{master:[0,0,0]},{method:'relative'},{tintColor:'#ff0000'},{amount:25},{asset:'a'.repeat(64)}])invalid(()=>validateCommand(command,{...fields(command),kind:'photo_filter',value:0,parameters}));
    for(const kind of ['brightness','color_balance','hue_saturation','selective_color'])invalid(()=>validateCommand(command,{...fields(command),kind,value:0,parameters:{color:'#ff9500',density:25}}));
  }
  for(const command of edits)for(const parameters of [{},{color:'#80ff80'},{density:0},{preserveLuminosity:false}])assert.deepEqual(validateCommand(command,{...fields(command),parameters}),{...fields(command),parameters});
});

test('Photo Filter participates in transactions and dependency-free recipes without permitting LUT dependencies',()=>{
  const operations=[{command:'add_adjustment',args:{kind:'photo_filter',value:0,parameters:{density:25}}},{command:'add_layer_filter',args:{layerId,kind:'photo_filter',value:0,parameters:{color:'#80ff80',preserveLuminosity:false}}}];
  const transaction={documentId,expectedRevision:1,label:'Photo Filter schema transaction',operations};
  assert.deepEqual(validateCommand('apply_transaction',transaction),transaction);
  invalid(()=>validateCommand('apply_transaction',{...transaction,operations:[{...operations[0],args:{...operations[0].args,parameters:{density:25.001}}}]}));
  const recipe={documentId,name:'Photo Filter grade',slots:[{key:'image',type:'raster'},{key:'grade',type:'adjustment',kind:'photo_filter'}],steps:[{command:'add_layer_filter',target:'image',args:{kind:'photo_filter',value:0,parameters:{}}},{command:'update_adjustment',target:'grade',args:{value:0,parameters:{color:'#ff9500'}}}]};
  assert.deepEqual(validateCommand('save_edit_recipe',recipe),recipe);
  invalid(()=>validateCommand('save_edit_recipe',{...recipe,steps:[{...recipe.steps[1],args:{value:0,parameters:{density:.001}}}]}));
  invalid(()=>validateCommand('save_edit_recipe',{...recipe,slots:[{key:'grade',type:'adjustment',kind:'color_lookup'}],steps:[recipe.steps[1]]}));
});

