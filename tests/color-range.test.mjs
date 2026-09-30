import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { COLOR_RANGE_POLICY, COLOR_RANGE_LIMITS, COLOR_RANGE_PREVIEW_LIMITS, normalizeColorRangeSettings } from '../shared/color-range.mjs';
import { compileColorRange, colorRangeComparisonWork, materializeColorRangeSelection, renderColorRangePreview } from '../server/color-range.mjs';
import { COLOR_RANGE_GOLDENS, colorRangeReference, colorRangePlaneReference, colorRangePreviewReference } from './fixtures/color-range/reference.mjs';
const invalid=fn=>assert.throws(fn,{code:'INVALID_ARGUMENT'});

test('Color Range contract owns canonical settings and rejects malformed fields without getters',()=>{
 assert.equal(COLOR_RANGE_POLICY,'sampled-rgb-chebyshev-alpha-v1');assert.ok(Object.isFrozen(COLOR_RANGE_LIMITS));assert.ok(Object.isFrozen(COLOR_RANGE_PREVIEW_LIMITS));
 const input={colors:['#aAbBcC','#e06942']},normalized=normalizeColorRangeSettings(input);assert.deepEqual(normalized,{colors:['#aabbcc','#e06942'],tolerance:32,falloff:32,invert:false});input.colors[0]='#000000';assert.equal(normalized.colors[0],'#aabbcc');
 assert.deepEqual(normalizeColorRangeSettings(Object.assign(Object.create(null),{colors:Object.freeze(['#000000']),tolerance:-0,falloff:0,invert:true})),{colors:['#000000'],tolerance:0,falloff:0,invert:true});
 for(const value of [null,[],{},{colors:[]},{colors:['#ABCDEF','#abcdef']},{colors:['#abcdef\n']},{colors:['#fff']},{colors:['#123456'],tolerance:1.5},{colors:['#123456'],falloff:256},{colors:['#123456'],invert:1},{colors:['#123456'],tolerance:undefined},{colors:['#123456'],mode:'replace'}])invalid(()=>normalizeColorRangeSettings(value));
 let calls=0;for(const key of ['colors','tolerance','falloff','invert']){const value={colors:['#123456'],tolerance:32,falloff:32,invert:false};Object.defineProperty(value,key,{enumerable:true,get(){calls++;return 1;}});invalid(()=>normalizeColorRangeSettings(value));}
 const colors=['#123456'];Object.defineProperty(colors,'0',{enumerable:true,get(){calls++;return '#123456';}});invalid(()=>normalizeColorRangeSettings({colors}));assert.equal(calls,0);
});

test('Color Range private lookup follows exact independent alpha/ramp cases and comparison ceilings',()=>{
 for(const row of COLOR_RANGE_GOLDENS)assert.equal(compileColorRange(row.parameters)(...row.rgba),row.expected);
 const colors=['#e06942','#000000','#ffffff','#ff0000','#00ff00','#0000ff','#190d38','#9a988f'];
 for(const tolerance of [0,16,32,200,255])for(const falloff of [0,4,32,100,255])for(const invert of [false,true]){
  const settings={colors,tolerance,falloff,invert},pixel=compileColorRange(settings),reversed=compileColorRange({...settings,colors:[...colors].reverse()});
  for(let i=0;i<256;i++){const rgba=[i,(i*37+29)%256,(i*101+40)%256,[0,1,2,128,254,255][i%6]],expected=colorRangeReference(rgba,settings);assert.equal(pixel(...rgba),expected);assert.equal(reversed(...rgba),expected);}
 }
 const settings={colors:['#000000'],tolerance:0,falloff:4},pixel=compileColorRange(settings);settings.colors[0]='#ffffff';settings.falloff=0;assert.equal(pixel(1,0,0,2),1);
 assert.equal(colorRangeComparisonWork(24_000_000,8),192_000_000);assert.throws(()=>colorRangeComparisonWork(24_000_001,8),{code:'LIMIT_EXCEEDED'});
 for(const[points,colors]of[[0,1],[1,0],[1,9],[1.5,1],[Infinity,1]])invalid(()=>colorRangeComparisonWork(points,colors));
});

test('Color Range async extraction owns settings before render and preview samples exact full pixels',async()=>{
 const width=128,height=64,pixels=Buffer.from(Array.from({length:width*height},(_,i)=>[i%256,(i*37)%256,(i*101)%256,[0,1,2,128,255][i%5]]).flat()),before=Buffer.from(pixels),graph={width,height,selection:null};
 let release;const settings={colors:['#e06942','#190d38'],tolerance:32,falloff:32,invert:false},saved=structuredClone(settings);
 const output=materializeColorRangeSelection(graph,settings,()=>new Promise(resolve=>{release=()=>resolve(pixels);}));settings.colors[0]='#ffffff';settings.tolerance=255;release();assert.deepEqual(await output,colorRangePlaneReference(pixels,saved));assert.deepEqual(pixels,before);
 const preview=await renderColorRangePreview(graph,{...saved,maxEdge:32},async()=>pixels),reference=colorRangePreviewReference(pixels,width,height,saved,32);
 assert.deepEqual([preview.width,preview.height],[reference.width,reference.height]);assert.deepEqual(preview.colors,saved.colors);assert.equal(preview.coveragePolicy,COLOR_RANGE_POLICY);
 assert.deepEqual(await sharp(preview.data).extractChannel(0).raw().toBuffer(),reference.gray);
 let reads=0;await assert.rejects(materializeColorRangeSelection(graph,{...saved,mode:'intersect'},async()=>{reads++;return pixels;}),{code:'NO_SELECTION'});assert.equal(reads,0);
});
