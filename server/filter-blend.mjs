// Source-filter-only RGB blending. Existing layer/clipping compositing remains unchanged.
// Exact coefficient, opacity and quotient bounds: docs/FILTER_BLEND_DESIGN.md.
import { blendRGB } from './blend.mjs';
import { LAYER_FILTER_BLEND_MODES, LAYER_FILTER_BLEND_POLICY } from '../shared/filter-blend-modes.mjs';
export { LAYER_FILTER_BLEND_MODES, LAYER_FILTER_BLEND_POLICY };
const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' }); };
export function normalizeFilterBlendMode(value) {
  if (value === undefined) return undefined;
  if (!LAYER_FILTER_BLEND_MODES.includes(value)) fail('Choose a supported RGB filter blend mode. Dissolve is unavailable because filter blending preserves alpha.');
  return value === 'normal' ? undefined : value;
}
export function layerFilterBlendWork(entry, pixels) {
  const mode = normalizeFilterBlendMode(entry.blendMode);
  return mode && entry.enabled && entry.opacity > 0 ? 40 * pixels : 0;
}
const GUARD = 64 * Number.EPSILON * 255;
const clamp = value => Math.max(0, Math.min(255, Math.round(value)));
const FLOAT_MODES = new Set(['soft_light', 'hue', 'saturation', 'color', 'luminosity']);
function binaryFraction(value) {
  if(value===0)return [0n,1n];
  const view=new DataView(new ArrayBuffer(8));view.setFloat64(0,value,false);
  const high=view.getUint32(0,false),low=view.getUint32(4,false),exponent=(high>>>20)&2047;
  let n=(BigInt(high&0xfffff)<<32n)|BigInt(low),shift=exponent?exponent-1023-52:-1074;
  if(exponent)n|=1n<<52n;
  let d=1n;if(shift>=0)n<<=BigInt(shift);else d<<=BigInt(-shift);
  while(n!==0n&&(n&1n)===0n&&(d&1n)===0n){n>>=1n;d>>=1n;}
  return[n,d];
}
function roundBlend(back,n,d,plan) {
  // Q <= 2^36: products are exact below 2^53, quotient floor margin exceeds twice the maximum rounding error.
  if(plan.fast){
    const numerator=back*d*plan.q+(n-back*d)*plan.p,denominator=d*plan.q;
    return Math.floor((2*numerator+denominator)/(2*denominator));
  }
  // Estimate error < 4*255*2^-53; guard is over 32 times that bound.
  const signed=n-back*d, value=(back*d+signed*plan.opacity)/d;
  if(value<=0)return 0;if(value>=255)return 255;
  if(Math.abs(value-(Math.floor(value)+.5))>GUARD)return Math.round(value);
  const [p,q]=plan.fraction??=(binaryFraction(plan.opacity));
  const numerator=BigInt(back*d)*q+BigInt(signed)*p,denominator=BigInt(d)*q;
  return Number((2n*numerator+denominator)/(2n*denominator));
}
function ratio(back,front,mode,out=[0,1]) {
  let n,d=1;
  switch(mode){
    case 'darken':n=Math.min(back,front);break;
    case 'lighten':n=Math.max(back,front);break;
    case 'multiply':n=back*front;d=255;break;
    case 'screen':n=255*back+(255-back)*front;d=255;break;
    case 'color_burn':if(back===255)n=255;else if(front===0)n=0;else{d=front;n=Math.max(0,255*front-255*(255-back));}break;
    case 'color_dodge':if(back===0)n=0;else if(front===255)n=255;else{d=255-front;n=Math.min(255*d,255*back);}break;
    case 'linear_burn':n=Math.max(0,back+front-255);break;
    case 'linear_dodge':n=Math.min(255,back+front);break;
    case 'overlay':d=255;n=back<=127?2*back*front:65025-2*(255-back)*(255-front);break;
    case 'hard_light':d=255;n=front<=127?2*back*front:65025-2*(255-back)*(255-front);break;
    case 'vivid_light':case 'hard_mix':
      if(front<=127){if(back===255)n=255;else if(front===0)n=0;else{d=2*front;n=Math.max(0,255*d-255*(255-back));}}
      else if(back===0)n=0;else if(front===255)n=255;else{d=510-2*front;n=Math.min(255*d,255*back);}
      if(mode==='hard_mix'){n=2*n<255*d?0:255;d=1;}break;
    case 'linear_light':n=Math.max(0,Math.min(255,back+2*front-255));break;
    case 'pin_light':n=front<=127?Math.min(back,2*front):Math.max(back,2*front-255);break;
    case 'difference':n=Math.abs(back-front);break;
    case 'exclusion':n=255*(back+front)-2*back*front;d=255;break;
    case 'subtract':n=Math.max(0,back-front);break;
    case 'divide':if(front===0)n=255;else{d=front;n=Math.min(255*d,255*back);}break;
    default:fail('Unsupported rational filter blend mode.');
  }
  out[0]=n;out[1]=d;return out;
}
// Compile before candidate construction: the transient 8-byte IEEE view is
// unreachable on return. Only bounded scalar fractions and RGB triples remain.
export function compileFilterBlend(value, opacity) {
  const mode = normalizeFilterBlendMode(value) ?? 'normal';
  if (typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) fail('Filter opacity must be between zero and one.');
  const fraction = FLOAT_MODES.has(mode) || mode === 'normal' ? null : binaryFraction(opacity);
  const fast = fraction !== null && fraction[1] <= 2n ** 36n;
  const plan={opacity,fraction,fast,p:fast?Number(fraction[0]):null,q:fast?Number(fraction[1]):null},backdrop=[0,0,0],foreground=[0,0,0],nd=[0,1];
  const transform=(back,front,out=[0,0,0])=>{
    if(mode==='normal'){for(let c=0;c<3;c++)out[c]=clamp(back[c]+(front[c]-back[c])*opacity);return out;}
    if(FLOAT_MODES.has(mode)){
      for(let c=0;c<3;c++){backdrop[c]=back[c]/255;foreground[c]=front[c]/255;}
      const mixed=blendRGB(backdrop,foreground,mode);
      for(let c=0;c<3;c++)out[c]=clamp(back[c]+(mixed[c]*255-back[c])*opacity);
    }else if(mode==='darker_color'||mode==='lighter_color'){
      const bsum=back[0]+back[1]+back[2],fsum=front[0]+front[1]+front[2];
      const selected=(mode==='darker_color'?bsum<=fsum:bsum>=fsum)?back:front;
      for(let c=0;c<3;c++)out[c]=roundBlend(back[c],selected[c],1,plan);
    }else for(let c=0;c<3;c++){ratio(back[c],front[c],mode,nd);out[c]=roundBlend(back[c],nd[0],nd[1],plan);}
    return out;
  };
  return transform;
}
