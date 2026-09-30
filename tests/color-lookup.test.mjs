import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { parseColorLookupBytes, prepareColorLookup } from '../server/color-lookup.mjs';
import { applyLayerFilters } from '../server/layer-filters.mjs';
import { compileFilterBlend, LAYER_FILTER_BLEND_MODES } from '../server/filter-blend.mjs';
import { authoredCube, authoredLookupNativeOrder } from './fixtures/color-lookup/reference.mjs';
const descriptor = (bytes,name='rgb-cycle',size=2) => ({asset:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,gridSize:size,inputSpace:'srgb',sourceName:`${name}.cube`,title:`Prism authored ${name}`});

test('all grids and endpoint axes preserve identity and red-first channel order without a mutable table export',async()=>{
 for(let size=2;size<=33;size++){
  const lines=[`LUT_3D_SIZE ${size}`];for(let b=0;b<size;b++)for(let g=0;g<size;g++)for(let r=0;r<size;r++)lines.push([g,b,r].map(v=>String(v/(size-1))).join(' '));
  const parsed=await parseColorLookupBytes(Buffer.from(lines.join('\n')));assert.deepEqual(Object.keys(parsed),['gridSize','transform']);assert.deepEqual(Reflect.ownKeys(parsed.transform),['length','name','prototype']);
  for(let c=0;c<256;c++)for(const rgb of[[c,0,255],[255,c,0],[0,255,c]])assert.deepEqual(parsed.transform(...rgb),[rgb[1],rgb[2],rgb[0]]);
 }
});

test('parser owns text before yielding, detaches title and transform results, and rejects exact decimal domain/range neighbors',async()=>{
 const raw=authoredCube('rgb-cycle'),prefix=Buffer.from(('#'+'x'.repeat(4000)+'\n').repeat(40)),bytes=Buffer.concat([prefix,raw]);let yields=0;
 const parsed=await parseColorLookupBytes(bytes,{yieldFn:async()=>{yields++;bytes.fill(0);}});assert.ok(yields>=2);assert.equal(parsed.title,'Prism authored rgb-cycle');assert.deepEqual(parsed.transform(13,127,253),[127,253,13]);const first=parsed.transform(1,2,3);first[0]=99;assert.deepEqual(parsed.transform(1,2,3),[2,3,1]);
 for(const token of['1.000000000000000001','1e-999','-1e-999'])await assert.rejects(parseColorLookupBytes(Buffer.from(raw.toString().replace('\n0 0 0\n',`\n${token} 0 0\n`))));
 await assert.rejects(parseColorLookupBytes(Buffer.from(raw.toString().replace('DOMAIN_MAX 1 1 1','DOMAIN_MAX .999999999999999999 1 1'))));
 const prepared=await prepareColorLookup(descriptor(raw),async()=>raw);raw.fill(0);assert.deepEqual(prepared(13,127,253),[127,253,13]);
});

test('lookup candidates use all26 source blend modes before deferred effect-mask interpolation and preserve source alpha',async()=>{
 const bytes=authoredCube('cross-products'),parameters=descriptor(bytes,'cross-products'),options={prepareColorLookup:p=>prepareColorLookup(p,async()=>bytes)};
 const input=Buffer.from(Array.from({length:256},(_,p)=>[p,(p*37)%256,(p*113)%256,[0,1,128,255][p%4]]).flat()),before=Buffer.from(input);
 for(const blendMode of LAYER_FILTER_BLEND_MODES){const entry={id:randomUUID(),kind:'color_lookup',value:0,parameters,enabled:true,opacity:.625,blendMode},fn=compileFilterBlend(blendMode,.625),expected=Buffer.from(input),mask={sourceWidth:256,sourceHeight:1,coverage:{shape:'bitmap',x:0,y:0,width:256,height:1,runs:Array.from({length:255},(_,p)=>[p+1,1,p+1]).flat(),feather:0,invert:false},density:.1,enabled:true};
  for(let p=0;p<256;p++)if(input[p*4+3]){const old=[...input.subarray(p*4,p*4+3)],candidate=authoredLookupNativeOrder('cross-products',old),mixed=fn(old,candidate),m=Math.round(255-.1*(255-p));for(let c=0;c<3;c++)expected[p*4+c]=Math.floor((2*(old[c]*(255-m)+mixed[c]*m)+255)/510);}
  assert.deepEqual(await applyLayerFilters(input,256,1,{version:1,entries:[entry],mask},options),expected,blendMode);
 }
 assert.deepEqual(input,before);await assert.rejects(applyLayerFilters(input,256,1,[{id:randomUUID(),kind:'color_lookup',value:0,parameters,enabled:true,opacity:1}]),/resolver/);
});

test('lookup identity, gain half and cross-channel bytes are stable in two ordinary fresh optimized processes',async()=>{
 const run=promisify(execFile),file=new URL('./fixtures/color-lookup/cold-worker.mjs',import.meta.url);const first=await run(process.execPath,[file.pathname],{timeout:15000}),second=await run(process.execPath,[file.pathname],{timeout:15000});assert.equal(first.stderr,'');assert.equal(second.stderr,'');assert.equal(first.stdout,second.stdout);assert.match(first.stdout.trim(),/^[a-f0-9]{64}$/);
});
