import sharp from 'sharp';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';

const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' }); };

// Candidate RGB surface. The compositor retains original alpha and applies
// masks, layer opacity and protected-pixel exclusions afterward.
export async function spatialAdjustment(input, width, height, layer) {
  if (!['median', 'mosaic'].includes(layer.kind)) return null;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || width > 8192 || height > 8192 || width * height > 24_000_000
      || !Buffer.isBuffer(input) || input.length !== width * height * 4) fail('Invalid filter image dimensions.');
  const size = layer.value;
  if (!Number.isInteger(size) || size < 1 || size > (layer.kind === 'median' ? 15 : 128)) fail('Filter size is outside its supported range.');
  if (layer.kind === 'median' && size % 2 === 0) fail('Median size must be an odd integer.');
  if (size === 1) return Buffer.from(input);
  if (layer.kind === 'median') {
    let opaque = true;
    for (let i = 3; i < input.length; i += 4) if (input[i] !== 255) { opaque = false; break; }
    if (!opaque) return alphaWeightedMedian(input, width, height, size);
    const result = await sharp(input, { raw: { width, height, channels: 4 }, limitInputPixels: 24_000_000 }).median(size).raw().toBuffer();
    for (let offset = 3; offset < result.length; offset += 4) result[offset] = input[offset];
    return result;
  }
  const result = Buffer.from(input);
  // Alpha-weighted blocks avoid sampling hidden RGB into visible mosaic tiles.
  for (let top = 0; top < height; top += size) for (let left = 0; left < width; left += size) {
    const bottom = Math.min(height, top + size), right = Math.min(width, left + size);
    let red = 0, green = 0, blue = 0, alpha = 0;
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const i = (y * width + x) * 4, a = input[i + 3];
      red += input[i] * a; green += input[i + 1] * a; blue += input[i + 2] * a; alpha += a;
    }
    if (alpha === 0) continue;
    red = Math.round(red / alpha); green = Math.round(green / alpha); blue = Math.round(blue / alpha);
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const i = (y * width + x) * 4;
      if (input[i + 3] === 0) continue;
      result[i] = red; result[i + 1] = green; result[i + 2] = blue;
    }
  }
  return result;
}

// Sliding weighted histograms ignore invisible RGB and give soft-alpha
// samples proportional influence. Two-level histograms bound each lookup to
// at most 32 bins per channel; the window updates only its entering/exiting
// columns. Fully opaque images use the optimized native median above.
async function alphaWeightedMedian(input, width, height, size) {
  const output = Buffer.from(input), radius = (size - 1) / 2;
  const histograms = [new Uint32Array(256),new Uint32Array(256),new Uint32Array(256)];
  const groups = [new Uint32Array(16),new Uint32Array(16),new Uint32Array(16)];
  const clampX = x => Math.max(0,Math.min(width-1,x));
  const clampY = y => Math.max(0,Math.min(height-1,y));
  let total = 0;
  function accumulate(x,y,sign) {
    const index=(y*width+x)*4, weight=input[index+3]*sign;
    if(!weight)return;
    total+=weight;
    for(let c=0;c<3;c++) { const tone=input[index+c];histograms[c][tone]+=weight;groups[c][tone>>4]+=weight; }
  }
  for(let y=0;y<height;y++) {
    for(let c=0;c<3;c++){histograms[c].fill(0);groups[c].fill(0);}total=0;
    for(let dy=-radius;dy<=radius;dy++)for(let dx=-radius;dx<=radius;dx++)accumulate(clampX(dx),clampY(y+dy),1);
    for(let x=0;x<width;x++) {
      const index=(y*width+x)*4;
      if(input[index+3]>0&&total>0) {
        const target=Math.ceil(total/2);
        for(let c=0;c<3;c++) {
          let sum=0,group=0;
          while(group<15&&sum+groups[c][group]<target){sum+=groups[c][group];group++;}
          let tone=group*16;
          while(tone<255&&sum+histograms[c][tone]<target){sum+=histograms[c][tone];tone++;}
          output[index+c]=tone;
        }
      }
      if(x+1<width) {
        const leaving=clampX(x-radius),entering=clampX(x+radius+1);
        if(leaving!==entering)for(let dy=-radius;dy<=radius;dy++){const row=clampY(y+dy);accumulate(leaving,row,-1);accumulate(entering,row,1);}
      }
    }
    if((y+1)%32===0)await yieldEventLoop();
  }
  return output;
}
