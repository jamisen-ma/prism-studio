import test from 'node:test';
import assert from 'node:assert/strict';
import {BLEND_MODES,blendRGB,dissolveAlpha} from '../server/blend.mjs';
const near=(actual,expected)=>actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<1e-8,`${v} != ${expected[i]}`));
test('blend modes obey compositing reference values and neutral colors',()=>{
  near(blendRGB([.2,.4,.8],[.5,.25,1],'multiply'),[.1,.1,.8]);
  near(blendRGB([.2,.4,.8],[.5,.25,1],'screen'),[.6,.55,1]);
  near(blendRGB([.2,.4,.8],[.5,.5,.5],'soft_light'),[.2,.4,.8]);
  near(blendRGB([.2,.4,.8],[.5,.5,.5],'linear_light'),[.2,.4,.8]);
  near(blendRGB([.2,.4,.8],[1,1,1],'color_burn'),[.2,.4,.8]);
  near(blendRGB([.2,.4,.8],[0,0,0],'color_dodge'),[.2,.4,.8]);
  near(blendRGB([.2,.4,.8],[1,1,1],'divide'),[.2,.4,.8]);
});
test('nonseparable modes preserve specified luminance and saturation',()=>{
  const b=[.2,.3,.4],s=[.7,.4,.1],lum=c=>.3*c[0]+.59*c[1]+.11*c[2];
  for(const mode of ['hue','saturation','color'])assert.ok(Math.abs(lum(blendRGB(b,s,mode))-lum(b))<1e-8);
  assert.ok(Math.abs(lum(blendRGB(b,s,'luminosity'))-lum(s))<1e-8);
  near(blendRGB([.3,.3,.3],s,'saturation'),[.3,.3,.3]);
});
test('all27 modes stay finite and bounded at boundary values',()=>{
  assert.equal(BLEND_MODES.length,27);
  for(const mode of BLEND_MODES)for(const b of [0,.2,.5,.9,1])for(const s of [0,.1,.5,.8,1]){
    const out=blendRGB([b,1-b,b],[s,s,1-s],mode);
    for(const c of out)assert.ok(Number.isFinite(c)&&c>=0&&c<=1,mode);
  }
});
test('dissolve is repeatable, respects alpha endpoints and approximates coverage',()=>{
  let covered=0;
  for(let i=0;i<10000;i++){assert.equal(dissolveAlpha(0,i),0);assert.equal(dissolveAlpha(1,i),1);assert.equal(dissolveAlpha(.3,i),dissolveAlpha(.3,i));covered+=dissolveAlpha(.3,i);}
  assert.ok(covered>2800&&covered<3200);
});
