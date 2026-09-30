// The separable and nonseparable core follows W3C Compositing and Blending:
// https://www.w3.org/TR/compositing-1/#blending
export {BLEND_MODES} from '../shared/blend-modes.mjs';
const clamp=x=>Math.max(0,Math.min(1,x));
const lum=c=>.3*c[0]+.59*c[1]+.11*c[2];
const sat=c=>Math.max(...c)-Math.min(...c);
function setLum(c,target){
  let output=c.map(v=>v+target-lum(c)),low=Math.min(...output),high=Math.max(...output);
  if(low<0)output=output.map(v=>target+(v-target)*target/(target-low));
  if(high>1)output=output.map(v=>target+(v-target)*(1-target)/(high-target));
  return output.map(clamp);
}
function setSat(c,target){
  const order=[0,1,2].sort((a,b)=>c[a]-c[b]),[lo,mid,hi]=order,out=[0,0,0];
  if(c[hi]>c[lo]){out[mid]=(c[mid]-c[lo])*target/(c[hi]-c[lo]);out[hi]=target;}
  return out;
}
const burn=(b,s)=>b===1?1:s===0?0:1-Math.min(1,(1-b)/s);
const dodge=(b,s)=>b===0?0:s===1?1:Math.min(1,b/(1-s));
function channel(b,s,mode){
  switch(mode){
    case 'multiply':return b*s;
    case 'screen':return b+s-b*s;
    case 'darken':return Math.min(b,s);
    case 'lighten':return Math.max(b,s);
    case 'color_burn':return burn(b,s);
    case 'linear_burn':return Math.max(0,b+s-1);
    case 'color_dodge':return dodge(b,s);
    case 'linear_dodge':return Math.min(1,b+s);
    case 'overlay':return b<=.5?2*b*s:1-2*(1-b)*(1-s);
    case 'hard_light':return s<=.5?2*b*s:1-2*(1-b)*(1-s);
    case 'soft_light':return s<=.5?b-(1-2*s)*b*(1-b):b+(2*s-1)*((b<=.25?((16*b-12)*b+4)*b:Math.sqrt(b))-b);
    case 'vivid_light':return s<.5?burn(b,2*s):dodge(b,2*s-1);
    case 'linear_light':return clamp(b+2*s-1);
    case 'pin_light':return s<.5?Math.min(b,2*s):Math.max(b,2*s-1);
    case 'hard_mix':return channel(b,s,'vivid_light')<.5?0:1;
    case 'difference':return Math.abs(b-s);
    case 'exclusion':return b+s-2*b*s;
    case 'subtract':return Math.max(0,b-s);
    case 'divide':return s===0?1:Math.min(1,b/s);
    default:return s;
  }
}
// Colors are normalized 0..1, independent of source/destination alpha.
export function blendRGB(backdrop,source,mode){
  switch(mode){
    case 'hue':return setLum(setSat(source,sat(backdrop)),lum(backdrop));
    case 'saturation':return setLum(setSat(backdrop,sat(source)),lum(backdrop));
    case 'color':return setLum(source,lum(backdrop));
    case 'luminosity':return setLum(backdrop,lum(source));
    case 'darker_color':return backdrop.reduce((a,b)=>a+b,0)<=source.reduce((a,b)=>a+b,0)?backdrop:source;
    case 'lighter_color':return backdrop.reduce((a,b)=>a+b,0)>=source.reduce((a,b)=>a+b,0)?backdrop:source;
    default:return backdrop.map((b,i)=>channel(b,source[i],mode));
  }
}
// Deterministic spatial noise makes repeated renders, exports and undo agree.
export function dissolveAlpha(alpha,pixel){
  let hash=Math.imul(pixel+1,0x45d9f3b);hash=Math.imul(hash^(hash>>>16),0x45d9f3b);hash^=hash>>>16;
  return (hash>>>0)/4294967296<alpha?1:0;
}
