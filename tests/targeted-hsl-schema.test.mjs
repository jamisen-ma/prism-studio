import test from 'node:test';
import assert from 'node:assert/strict';
import { commandSchemas, validateCommand, validateBackendOptions, validateEditRecipeDefinition } from '../shared/commands.mjs';

const ranges=['master','reds','yellows','greens','cyans','blues','magentas'];
const base={documentId:'doc',layerId:'layer'},invalid={code:'INVALID_ARGUMENTS'};

test('targeted HSL global/source discovery accepts exact typed triples with zero value and sparse defaults',()=>{
  assert.equal(commandSchemas.add_adjustment.shape.kind.options.length,28);assert.equal(commandSchemas.add_layer_filter.shape.kind.options.length,32);
  for(const command of ['add_adjustment','add_layer_filter']){
    const target=command==='add_adjustment'?{documentId:'doc'}:base;
    for(const parameters of [undefined,{},...ranges.map(range=>({[range]:[-180,100,-100]})),{master:[180,-100,100],reds:[.01,-.29,12.5]}]){
      const args={...target,kind:'hue_saturation',value:0,...(parameters===undefined?{}:{parameters})};assert.deepEqual(validateCommand(command,args),args);
    }
    for(const value of [-1,.01,1])assert.throws(()=>validateCommand(command,{...target,kind:'hue_saturation',value}),invalid);
    for(const parameters of [{reds:[1,2,3,4]},{reds:40},{shadows:[1,2,3]},{method:'relative'},{interpolation:'smooth'},{colorize:true}])assert.throws(()=>validateCommand(command,{...target,kind:'hue_saturation',value:0,parameters}),invalid);
    for(const kind of ['brightness','black_white','selective_color','color_balance','curves','channel_mixer'])assert.throws(()=>validateCommand(command,{...target,kind,value:0,parameters:{reds:[1,2,3]}}),invalid);
  }
});

test('targeted HSL enforces distinct hue/percent limits, dense triples and exact centiunit precision without coercion',()=>{
  const call=parameters=>validateCommand('add_adjustment',{documentId:'doc',kind:'hue_saturation',value:0,parameters});
  for(const range of ranges){
    for(const row of [null,[],[0,0],[0,0,0,0],[0,,0],...[-180.01,180.01,.001,Number.MIN_VALUE,NaN,Infinity,null,'0',true].map(n=>[n,0,0]),...[-100.01,100.01,.001,NaN,Infinity,null,'0'].flatMap(n=>[[0,n,0],[0,0,n]])])assert.throws(()=>call({[range]:row}),invalid);
    assert.deepEqual(call({[range]:[180,-100,100]}).parameters[range],[180,-100,100]);
  }
  for(const parameters of [null,[],{master:[0,0,0],method:'multiplicative'},{reds:[0,0,0],whites:[0,0,0]},{reds:[0,0,0],colorize:false},{reds:[0,0,0],falloff:60}])assert.throws(()=>call(parameters),invalid);
});

test('targeted HSL partial updates remain detached and native-only tuple semantics reject the bridge recursively',()=>{
  for(const command of ['update_adjustment','update_layer_filter']){
    const target={...base,...(command==='update_layer_filter'?{filterId:'filter'}:{})};
    for(const parameters of [{},...ranges.map(range=>({[range]:[180,-.01,100]}))]){
      const expected=structuredClone(parameters),parsed=validateCommand(command,{...target,parameters});for(const range of ranges)if(parameters[range])parameters[range][0]=0;
      assert.deepEqual(parsed.parameters,expected);assert.equal(parsed.value,undefined);
      if(Object.keys(expected).length){
        assert.doesNotThrow(()=>validateBackendOptions('native',command,{...target,parameters:expected}));assert.throws(()=>validateBackendOptions('photoshop',command,{...target,parameters:expected}),{code:'UNSUPPORTED_COMMAND'});
        const args={layerId:'layer',...(command==='update_layer_filter'?{filterId:'filter'}:{}),parameters:expected};const transaction=validateCommand('apply_transaction',{documentId:'doc',label:'Targeted HSL',operations:[{command,args}]});assert.throws(()=>validateBackendOptions('photoshop','apply_transaction',transaction),{code:'UNSUPPORTED_COMMAND'});
      }
    }
  }
  assert.throws(()=>validateBackendOptions('photoshop','add_adjustment',{kind:'hue_saturation',value:0}),{code:'UNSUPPORTED_COMMAND'});
});

test('targeted HSL recipes distinguish HSL triples from overlapping CMYK rows and bind only the declared adjustment family',()=>{
  for(const parameters of [{},{master:[120,10,-3]},{reds:[-180,-100,100]}]){
    const recipe={name:'Targeted HSL',slots:[{key:'photo',type:'raster'},{key:'grade',type:'adjustment',kind:'hue_saturation'}],steps:[{command:'add_layer_filter',target:'photo',args:{kind:'hue_saturation',value:0,parameters}},{command:'update_adjustment',target:'grade',args:{value:0,parameters}}]};
    assert.deepEqual(validateEditRecipeDefinition(recipe),recipe);
    if(Object.keys(parameters).length){const wrong=structuredClone(recipe);wrong.slots[1].kind='selective_color';assert.throws(()=>validateEditRecipeDefinition(wrong),invalid);}
    const wrong=structuredClone(recipe);wrong.steps[1].args.parameters={reds:[0,0,0,0]};assert.throws(()=>validateEditRecipeDefinition(wrong),invalid);
  }
});
