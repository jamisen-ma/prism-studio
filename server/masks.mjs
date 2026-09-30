import { normalizeDenseMaskDescriptor } from '../shared/dense-mask.mjs';
const fail = (message) => { throw Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' }); };
export function assertMaskDensityOwnership(mask) {
  if (!mask || typeof mask !== 'object') return;
  const positionKeys = ['maskOffset', 'maskPosition', 'position', 'offset', 'source', 'sourceWidth', 'sourceHeight', 'domain'];
  if (mask.shape === 'positioned' || positionKeys.some(key => Object.hasOwn(mask, key)) || (mask.clip && typeof mask.clip === 'object' && positionKeys.some(key => Object.hasOwn(mask.clip, key))))
    fail('Positioned masks belong only to additional layer masks; selections and raw mask descriptors cannot carry position metadata.');
  if (Object.hasOwn(mask, 'density') || Object.hasOwn(mask, 'maskDensity') || (mask.clip && typeof mask.clip === 'object' && (Object.hasOwn(mask.clip, 'density') || Object.hasOwn(mask.clip, 'maskDensity'))))
    fail('Density belongs to layer.maskDensity; raw mask and selection descriptors do not accept density.');
}
function finite(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${label} must be between ${min} and ${max}.`);
  return value;
}

export function normalizeMask(input, width, height, { persisted = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Mask must be an object.');
  if (Object.getOwnPropertyDescriptor(input, 'shape')?.value === 'alpha8') return normalizeDenseMaskDescriptor(input, { persisted });
  assertMaskDensityOwnership(input);
  const shape = input.shape ?? 'rectangle';
  if (shape === 'bitmap') {
    if(input.clip!==undefined)fail('Bitmap masks encode their clipping directly.');
    if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width < 1 || input.height < 1 || input.width > 8192 || input.height > 8192 || input.width * input.height > 24_000_000) fail('Invalid bitmap mask dimensions.');
    if (!Array.isArray(input.runs) || input.runs.length % 3 !== 0 || input.runs.length > 600_000) fail('Bitmap mask is too complex.');
    let end = 0;
    for (let i=0;i<input.runs.length;i+=3) {
      const [start,length,alpha] = input.runs.slice(i,i+3);
      if (![start,length,alpha].every(Number.isInteger) || start < end || length < 1 || start+length > input.width*input.height || alpha < 1 || alpha > 255) fail('Invalid bitmap mask runs.');
      end=start+length;
    }
    if(input.invert!==undefined && typeof input.invert!=='boolean')fail('Mask invert must be boolean.');
    return {shape:'bitmap',x:0,y:0,width:input.width,height:input.height,runs:[...input.runs],feather:finite(input.feather??0,'mask feather',0,persisted?1_000_000:100),invert:input.invert??false};
  }
  if (!['rectangle', 'ellipse', 'polygon'].includes(shape)) fail('Mask shape must be rectangle, ellipse, polygon or bitmap.');
  const limit = persisted ? 1_000_000 : Math.max(width, height);
  const mask = {};
  if (input.shape !== undefined || shape !== 'rectangle') mask.shape = shape;
  if (shape === 'polygon') {
    if (!Array.isArray(input.points) || input.points.length < 3 || input.points.length > 256) fail('A polygon requires 3–256 points.');
    mask.points = input.points.map((point) => ({ x: finite(point?.x, 'point x', persisted ? -limit : 0, persisted ? limit : width), y: finite(point?.y, 'point y', persisted ? -limit : 0, persisted ? limit : height) }));
    const xs = mask.points.map((p) => p.x), ys = mask.points.map((p) => p.y);
    mask.x = Math.min(...xs); mask.y = Math.min(...ys); mask.width = Math.max(...xs) - mask.x; mask.height = Math.max(...ys) - mask.y;
    if (mask.width === 0 || mask.height === 0) fail('Polygon must enclose a nonzero area.');
  } else {
    mask.x = finite(input.x, 'mask x', persisted ? -limit : 0, persisted ? limit : width);
    mask.y = finite(input.y, 'mask y', persisted ? -limit : 0, persisted ? limit : height);
    mask.width = finite(input.width, 'mask width', persisted ? 0 : Number.EPSILON, persisted ? limit : width);
    mask.height = finite(input.height, 'mask height', persisted ? 0 : Number.EPSILON, persisted ? limit : height);
    if (!persisted && (mask.x + mask.width > width || mask.y + mask.height > height)) fail('Mask must fit within the canvas.');
  }
  mask.feather = finite(input.feather ?? 0, 'mask feather', 0, persisted ? 1_000_000 : 100);
  if (input.invert !== undefined && typeof input.invert !== 'boolean') fail('Mask invert must be boolean.');
  mask.invert = input.invert ?? false;
  if(input.clip!==undefined){
    if(!persisted||!input.clip||typeof input.clip!=='object'||Array.isArray(input.clip))fail('Canvas mask clipping is an internal persisted value.');
    mask.clip={x:finite(input.clip.x,'mask clip x',-1_000_000,1_000_000),y:finite(input.clip.y,'mask clip y',-1_000_000,1_000_000),width:finite(input.clip.width,'mask clip width',0,1_000_000),height:finite(input.clip.height,'mask clip height',0,1_000_000)};
  }
  return mask;
}

// Call with integer pixel coordinates. Inward feathering never modifies a pixel
// outside the shape unless the user explicitly inverts the mask.
export function maskCoverage(mask) {
  if (mask?.shape === 'alpha8') fail('Alpha8 masks require asynchronous prepared coverage.');
  assertMaskDensityOwnership(mask);
  if (!mask) return () => 1;
  if(mask.clip){
    const {clip,...source}=mask,coverage=maskCoverage(source);
    return(x,y)=>x+0.5>=clip.x&&y+0.5>=clip.y&&x+0.5<clip.x+clip.width&&y+0.5<clip.y+clip.height?coverage(x,y):0;
  }
  if (mask.shape === 'bitmap') {
    const bytes=bitmapBytes(mask);
    // Two chamfer passes approximate Euclidean distance inward. The actual
    // region stays unchanged; only its edge opacity is reduced by feathering.
    if(mask.feather>0){
      const {width:w,height:h}=mask, d=new Float32Array(bytes.length), max=mask.feather+2;
      for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=y*w+x;d[i]=bytes[i]===0?0:(x===0||y===0||x===w-1||y===h-1?0.5:max);}
      for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=y*w+x; if(x)d[i]=Math.min(d[i],d[i-1]+1);if(y)d[i]=Math.min(d[i],d[i-w]+1);if(x&&y)d[i]=Math.min(d[i],d[i-w-1]+Math.SQRT2);if(x<w-1&&y)d[i]=Math.min(d[i],d[i-w+1]+Math.SQRT2);}
      for(let y=h-1;y>=0;y--)for(let x=w-1;x>=0;x--){const i=y*w+x;if(x<w-1)d[i]=Math.min(d[i],d[i+1]+1);if(y<h-1)d[i]=Math.min(d[i],d[i+w]+1);if(x<w-1&&y<h-1)d[i]=Math.min(d[i],d[i+w+1]+Math.SQRT2);if(x&&y<h-1)d[i]=Math.min(d[i],d[i+w-1]+Math.SQRT2);}
      for(let i=0;i<bytes.length;i++)bytes[i]=Math.round(bytes[i]*Math.min(1,d[i]/mask.feather));
    }
    return (x,y)=>{x=Math.floor(x);y=Math.floor(y);const amount=x>=0&&y>=0&&x<mask.width&&y<mask.height?bytes[y*mask.width+x]/255:0;return mask.invert?1-amount:amount;};
  }
  const shape = mask.shape ?? 'rectangle', feather = mask.feather ?? 0;
  const x0 = mask.x, y0 = mask.y, x1 = x0 + mask.width, y1 = y0 + mask.height;
  const edges = shape === 'polygon' ? mask.points.map((point, i) => [point, mask.points[(i + 1) % mask.points.length]]) : null;
  const rows = new Map();
  return (x, y) => {
    const px = x + 0.5, py = y + 0.5;
    let amount = 0;
    if (px > x0 && px < x1 && py > y0 && py < y1) {
      let distance;
      if (shape === 'ellipse') {
        const rx = mask.width / 2, ry = mask.height / 2;
        const radius = Math.hypot((px - x0 - rx) / rx, (py - y0 - ry) / ry);
        distance = (1 - radius) * Math.min(rx, ry);
      } else if (shape === 'polygon') {
        let row = rows.get(py);
        if (!row) {
          const crossings = [];
          for (const [a, b] of edges) if ((a.y > py) !== (b.y > py)) crossings.push(a.x + (py - a.y) * (b.x - a.x) / (b.y - a.y));
          crossings.sort((a, b) => a - b);
          row = { crossings, nearEdges: feather > 0 ? edges.filter(([a, b]) => py >= Math.min(a.y, b.y) - feather && py <= Math.max(a.y, b.y) + feather) : [] };
          rows.set(py, row);
        }
        const { crossings } = row;
        let inside = false;
        for (let i = 0; i + 1 < crossings.length; i += 2) if (px >= crossings[i] && px < crossings[i + 1]) { inside = true; break; }
        distance = inside ? (feather || 1) : -1;
        if (inside && feather > 0) for (const [a, b] of row.nearEdges) {
          if (px < Math.min(a.x, b.x) - feather || px > Math.max(a.x, b.x) + feather || py < Math.min(a.y, b.y) - feather || py > Math.max(a.y, b.y) + feather) continue;
          const dx = b.x - a.x, dy = b.y - a.y, squared = dx * dx + dy * dy;
          const t = squared === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / squared));
          distance = Math.min(distance, Math.hypot(px - a.x - t * dx, py - a.y - t * dy));
        }
      } else distance = Math.min(px - x0, x1 - px, py - y0, y1 - py);
      amount = distance > 0 ? (feather > 0 ? Math.min(1, distance / feather) : 1) : 0;
    }
    return mask.invert ? 1 - amount : amount;
  };
}

export function transformMask(mask, transform, oldWidth, oldHeight) {
  if (mask?.shape === 'alpha8') fail('Alpha8 mask transforms require asynchronous preparation.');
  assertMaskDensityOwnership(mask);
  if (!mask) return null;
  if(mask.shape==='bitmap'){
    // Cropping must retain the existing coverage, including feathering. Reusing
    // a feather radius on the cropped bitmap would invent soft edges where the
    // new canvas cuts through a fully selected interior region.
    const bakeFeather=transform.type==='crop' && (mask.feather??0)>0;
    const coverage=bakeFeather?maskCoverage({...mask,invert:false}):null;
    const input=bakeFeather?null:bitmapBytes(mask),output=new Uint8Array(transform.width*transform.height);
    for(let y=0;y<transform.height;y++)for(let x=0;x<transform.width;x++){
      const sx=transform.type==='crop'?x+transform.x:Math.min(oldWidth-1,Math.floor((x+0.5)*oldWidth/transform.width));
      const sy=transform.type==='crop'?y+transform.y:Math.min(oldHeight-1,Math.floor((y+0.5)*oldHeight/transform.height));
      if(sx>=0&&sy>=0&&sx<mask.width&&sy<mask.height)output[y*transform.width+x]=coverage?Math.round(coverage(sx,sy)*255):input[sy*mask.width+sx];
    }
    return {...bitmapMask(output,transform.width,transform.height),invert:mask.invert??false,feather:bakeFeather?0:(mask.feather??0)*(transform.type==='resize'?Math.min(transform.width/oldWidth,transform.height/oldHeight):1)};
  }
  const result = structuredClone(mask);
  const sx = transform.type === 'resize' ? transform.width / oldWidth : 1;
  const sy = transform.type === 'resize' ? transform.height / oldHeight : 1;
  const tx = transform.type === 'crop' ? -transform.x : 0, ty = transform.type === 'crop' ? -transform.y : 0;
  result.x = result.x * sx + tx; result.y = result.y * sy + ty;
  result.width *= sx; result.height *= sy;
  if (result.points) result.points = result.points.map((point) => ({ x: point.x * sx + tx, y: point.y * sy + ty }));
  if (result.feather !== undefined) result.feather *= Math.min(sx, sy);
  if(result.clip)result.clip={x:result.clip.x*sx+tx,y:result.clip.y*sy+ty,width:result.clip.width*sx,height:result.clip.height*sy};
  return result;
}

export function bitmapBytes(mask){
  assertMaskDensityOwnership(mask);
  const bytes=new Uint8Array(mask.width*mask.height);
  for(let i=0;i<mask.runs.length;i+=3)bytes.fill(mask.runs[i+2],mask.runs[i],mask.runs[i]+mask.runs[i+1]);
  return bytes;
}

export function bitmapMask(bytes,width,height){
  if(bytes.length!==width*height)fail('Mask pixels do not match dimensions.');
  const runs=[];
  for(let i=0;i<bytes.length;){const value=bytes[i];if(!value){i++;continue;}let end=i+1;while(end<bytes.length&&bytes[end]===value)end++;runs.push(i,end-i,value);i=end;if(runs.length>600_000)throw Object.assign(new Error('Selection is too complex. Reduce its detail or use a smaller image.'),{code:'LIMIT_EXCEEDED'});}
  return {shape:'bitmap',x:0,y:0,width,height,runs,feather:0,invert:false};
}
