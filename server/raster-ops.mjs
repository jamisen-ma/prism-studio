import {bitmapMask, maskCoverage} from './masks.mjs';
import {applyStroke} from './retouch.mjs';

const fail=(message)=>{throw Object.assign(new Error(message),{code:'INVALID_ARGUMENT'});};
function validImage(pixels,width,height){
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>8192||height>8192||width*height>24_000_000||!(pixels instanceof Uint8Array)||pixels.length!==width*height*4)fail('Invalid RGBA image.');
}
function point(x,y,width,height){if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>=width||y>=height)fail('Sample point must be inside the image.');}
const byte=(x)=>Math.max(0,Math.min(255,Math.round(x)));

// Four-connected region growing. Mark every queued pixel immediately so the
// work and queue stay bounded by the number of image pixels.
export function selectColorAlpha({pixels,width,height,x,y,tolerance=32,contiguous=true}){
  validImage(pixels,width,height);point(x,y,width,height);
  if(!Number.isFinite(tolerance)||tolerance<0||tolerance>255||typeof contiguous!=='boolean')fail('Invalid color selection options.');
  const seed=(y*width+x)*4,alpha=pixels[seed+3], selected=new Uint8Array(width*height);
  const matches=(index)=>{
    const i=index*4;
    if(alpha===0)return pixels[i+3]===0;
    return Math.max(Math.abs(pixels[i]-pixels[seed]),Math.abs(pixels[i+1]-pixels[seed+1]),Math.abs(pixels[i+2]-pixels[seed+2]),Math.abs(pixels[i+3]-alpha))<=tolerance;
  };
  if(!contiguous){for(let i=0;i<selected.length;i++)if(matches(i))selected[i]=255;}
  else{
    const seen=new Uint8Array(selected.length),queue=new Uint32Array(selected.length);let head=0,tail=0;
    const push=(index)=>{if(!seen[index]){seen[index]=1;if(matches(index)){selected[index]=255;queue[tail++]=index;}}};
    push(y*width+x);
    while(head<tail){const i=queue[head++],xx=i%width;if(xx>0)push(i-1);if(xx<width-1)push(i+1);if(i>=width)push(i-width);if(i<selected.length-width)push(i+width);}
  }
  return selected;
}

export function selectColor(args){return bitmapMask(selectColorAlpha(args),args.width,args.height);}

export function fillPixels({pixels,width,height,color,opacity=1,erase=false,coverage}){
  validImage(pixels,width,height);
  if(!Number.isFinite(opacity)||opacity<0||opacity>1||typeof erase!=='boolean'||(coverage!==undefined&&typeof coverage!=='function'))fail('Invalid fill options.');
  if(!erase && (typeof color!=='string'||!/^#[a-f0-9]{6}$/i.test(color)))fail('Fill requires a six-digit hex color.');
  const rgb=erase?[0,0,0]:[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)),output=Buffer.from(pixels);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=(y*width+x)*4,amount=opacity*(coverage?coverage(x,y):1);
    if(!Number.isFinite(amount)||amount<0||amount>1)fail('Fill coverage must be between zero and one.');
    if(amount===0)continue;
    if(erase){output[i+3]=byte(pixels[i+3]*(1-amount));continue;}
    const before=pixels[i+3]/255,after=amount+before*(1-amount);
    if(after===0)continue;
    for(let c=0;c<3;c++)output[i+c]=byte((rgb[c]*amount+pixels[i+c]*before*(1-amount))/after);
    output[i+3]=byte(after*255);
  }
  return output;
}

export function sampleColor({pixels,width,height,x,y,radius=0}){
  validImage(pixels,width,height);point(x,y,width,height);
  if(!Number.isInteger(radius)||radius<0||radius>50)fail('Sample radius must be an integer from zero to 50.');
  let n=0,alpha=0;const totals=[0,0,0];
  for(let yy=Math.max(0,y-radius);yy<=Math.min(height-1,y+radius);yy++)for(let xx=Math.max(0,x-radius);xx<=Math.min(width-1,x+radius);xx++){
    const i=(yy*width+xx)*4,a=pixels[i+3]/255;n++;alpha+=a;for(let c=0;c<3;c++)totals[c]+=pixels[i+c]*a;
  }
  const rgb=totals.map(v=>alpha?byte(v/alpha):0),a=byte(alpha/n*255);
  return {x,y,radius,red:rgb[0],green:rgb[1],blue:rgb[2],alpha:a,hex:'#'+rgb.map(v=>v.toString(16).padStart(2,'0')).join('')};
}

export function paintSelectionAlpha({width,height,selection,points,size,hardness=1,opacity=1,mode='add',startingCoverage}){
  if(!['add','subtract','replace'].includes(mode))fail('Selection paint mode must be add, subtract or replace.');
  if(startingCoverage!==undefined&&typeof startingCoverage!=='function')fail('Starting mask coverage must be a function.');
  const pixels=Buffer.alloc(width*height*4);validImage(pixels,width,height);
  if((selection||startingCoverage)&&mode!=='replace'){
    const coverage=startingCoverage??maskCoverage(selection);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4;pixels[i]=pixels[i+1]=pixels[i+2]=255;pixels[i+3]=byte(coverage(x,y)*255);}
  }
  const painted=applyStroke({pixels,width,height,tool:mode==='subtract'?'eraser':'brush',points,size,hardness,opacity,color:'#ffffff'});
  const alpha=new Uint8Array(width*height);for(let i=0;i<alpha.length;i++)alpha[i]=painted[i*4+3];
  return alpha;
}

export function paintSelection(args){return bitmapMask(paintSelectionAlpha(args),args.width,args.height);}
