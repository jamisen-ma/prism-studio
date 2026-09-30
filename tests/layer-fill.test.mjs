import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEffects } from '../server/layer-effects.mjs';
import { normalizeLayerFillOpacity, normalizeLayerFillEffects, layerFillOpacity, layerOutsideEffects, setLayerFillOpacity, setLayerOutsideEffects, projectLayerFill } from '../server/layer-fill.mjs';
const shadow = { color:'#000000', opacity:.35, blur:8, x:4, y:6 };
const wrapper = (fillOpacity=.375, styles={shadow}) => ({version:1,fillOpacity,styles});
const invalid = fn => assert.throws(fn, e=>e.code==='INVALID_ARGUMENT');

test('Fill helper preserves legacy reads, owns updates and canonicalizes exact one',()=>{
 for (const effects of [undefined,null,{}, {shadow:{}}]) {
  const layer = {opacity:.8,...(effects===undefined?{}:{effects})};
  assert.equal(layerFillOpacity(layer),1);assert.equal(layerOutsideEffects(layer),effects);
  assert.deepEqual(setLayerFillOpacity(layer,1),layer);assert.deepEqual(projectLayerFill(layer),layer);
  const next=setLayerFillOpacity(layer,.375);assert.equal(next.opacity,.8);assert.equal(layerFillOpacity(next),.375);
  assert.deepEqual(next.effects.styles,effects===undefined?null:normalizeEffects(effects));
  const restored=setLayerFillOpacity(next,1);assert.equal(layerFillOpacity(restored),1);assert.equal(Object.hasOwn(restored,'fillOpacity'),false);
  if(next.effects.styles)assert.deepEqual(restored.effects,next.effects.styles);else assert.equal(Object.hasOwn(restored,'effects'),false);
 }
 const layer={opacity:.7,effects:wrapper()},publicLayer=projectLayerFill(layer);
 assert.equal(publicLayer.fillOpacity,.375);assert.deepEqual(publicLayer.effects,{shadow});assert.equal(publicLayer.opacity,.7);
 publicLayer.effects.shadow.blur=2;assert.equal(layer.effects.styles.shadow.blur,8);
 const cleared=setLayerOutsideEffects(layer,null);assert.deepEqual(cleared.effects,wrapper(.375,null));assert.equal(layer.effects.styles.shadow.blur,8);
 const changed=setLayerOutsideEffects(cleared,{glow:{}});assert.equal(changed.effects.fillOpacity,.375);assert.deepEqual(changed.effects.styles,normalizeEffects({glow:{}}));
 invalid(()=>layerFillOpacity(publicLayer));
});

test('Fill metadata checks exact Number boundaries and new canonical style shape',()=>{
 for(const value of [0,-0,Number.MIN_VALUE,.375,1-Number.EPSILON/2,1])assert.equal(normalizeLayerFillOpacity(value),value===0?0:value);
 for(const value of [NaN,Infinity,-Infinity,-Number.MIN_VALUE,1+Number.EPSILON,'0.5',null,undefined])invalid(()=>normalizeLayerFillOpacity(value));
 assert.equal(Object.is(normalizeLayerFillOpacity(-0),-0),false);
 assert.equal(Object.is(setLayerFillOpacity({effects:wrapper(-0,null)},0).effects.fillOpacity,-0),false);
 for(const styles of [null,{shadow},{glow:{color:'#ffffff',opacity:.5,blur:8}}]) {
  const value=wrapper(.25,styles),normalized=normalizeLayerFillEffects(value);assert.deepEqual(normalized,value);assert.notEqual(normalized,value);
  invalid(()=>normalizeEffects(value));
 }
 for(const value of [wrapper(1),wrapper(-1),wrapper(NaN),{...wrapper(),version:2},{...wrapper(),extra:1},wrapper(.5,{}),wrapper(.5,{shadow:{}}),wrapper(.5,{shadow:{...shadow,color:'#ABCDEF'}}),wrapper(.5,{shadow:{...shadow,unknown:0}})])invalid(()=>normalizeLayerFillEffects(value));
 assert.deepEqual(normalizeLayerFillEffects({shadow:{}}),{shadow});
});

test('Fill wrappers reject accessors, inherited markers and hidden/symbol keys without getters',()=>{
 let calls=0;
 for(const key of ['version','fillOpacity','styles']){const value=wrapper();Object.defineProperty(value,key,{enumerable:true,get(){calls++;return 1;}});invalid(()=>normalizeLayerFillEffects(value));}
 for(const key of Object.keys(shadow)){const value=wrapper(.5,{shadow:{...shadow}});Object.defineProperty(value.styles.shadow,key,{enumerable:true,get(){calls++;return 1;}});invalid(()=>normalizeLayerFillEffects(value));}
 const inherited=Object.create({get version(){calls++;return 1;},get fillOpacity(){calls++;return .5;},get styles(){calls++;return null;}});invalid(()=>normalizeLayerFillEffects(inherited));
 const symbol=wrapper();symbol[Symbol('extra')]=0;invalid(()=>normalizeLayerFillEffects(symbol));
 const hidden=wrapper();Object.defineProperty(hidden,'extra',{value:0});invalid(()=>normalizeLayerFillEffects(hidden));
 const top={};Object.defineProperty(top,'effects',{get(){calls++;return wrapper();},enumerable:true});invalid(()=>projectLayerFill(top));
 assert.equal(calls,0);
 const nullPrototype=Object.assign(Object.create(null),wrapper(.5,null));assert.deepEqual(normalizeLayerFillEffects(nullPrototype),wrapper(.5,null));
});
