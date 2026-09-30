import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {HUE_SATURATION_POLICY,HUE_SATURATION_RANGES as ranges,normalizeHueSaturationParameters as normalize,hueSaturationIsIdentity as identity,hueSaturationTransform as compile} from '../server/hue-saturation.mjs';
const invalid=error=>error.code==='INVALID_ARGUMENT';
const all=row=>Object.fromEntries(ranges.slice(1).map(k=>[k,row]));
test('strict complete owned HSL defaults preserve canonical centiunits without changing caller metadata',()=>{
 assert.equal(HUE_SATURATION_POLICY,'rgb-hue-triangle-hsl-v1');assert.deepEqual(ranges,['master','reds','yellows','greens','cyans','blues','magentas']);assert.ok(Object.isFrozen(ranges));
 const defaults=normalize();for(const key of ranges)assert.deepEqual(defaults[key],[0,0,0]);defaults.reds[0]=12;assert.deepEqual(normalize().reds,[0,0,0]);assert.notEqual(defaults.greens,defaults.blues);
 const p=Object.assign(Object.create(null),{master:[180,-100,100],reds:[-.01,-0,99.99]}),before=structuredClone(p),out=normalize(p);assert.equal(Object.is(out.reds[1],-0),false);assert.deepEqual({...p},before);assert.equal(Object.getPrototypeOf(p),null);out.master[0]=0;assert.equal(p.master[0],180);
 const authored={reds:[17.25,-35.37,12.51]},transform=compile(authored),expected=transform(200,100,50);authored.reds[0]=-180;assert.deepEqual(transform(200,100,50),expected);expected[0]=0;assert.notDeepEqual(transform(200,100,50),expected);assert.deepEqual(Reflect.ownKeys(transform),['length','name']);
});
test('malformed rows, accessors, symbols, prototypes and finer controls reject without invoking getters',()=>{
 let reads=0;const accessor=Object.defineProperty({},'reds',{enumerable:true,get(){reads++;return[0,0,0];}}),row=[0,0,0];Object.defineProperty(row,'1',{enumerable:true,get(){reads++;return 0;}});
 for(const p of [null,[],1,{unknown:0},{reds:null},{reds:[0,0]},{reds:[0,0,0,0]},{reds:[,0,0]},{reds:[180.01,0,0]},{reds:[0,100.01,0]},{reds:[0,0,-100.01]},{reds:[.001,0,0]},{reds:[NaN,0,0]},{reds:[0,Infinity,0]},{reds:['0',0,0]},{reds:Object.assign([0,0,0],{x:1})},Object.create({reds:[0,0,0]}),{[Symbol()]:0},accessor,{reds:row},Object.defineProperty({},'reds',{value:[0,0,0]})])assert.throws(()=>normalize(p),invalid);
 assert.equal(reads,0);assert.throws(()=>identity({master:[0,.001,0]}),invalid);
});
test('all-zero, exact aggregate cancellation and full hue turns retain RGB; authored nonzero remains computing',()=>{
 let seed=0x31ab97;const next=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
 const zero=compile(),turn=compile({master:[180,0,0],...all([180,0,0])}),cancel=compile({master:[30,25,0],...all([-30,-25,0])});
 assert.equal(identity(),true);assert.equal(identity({reds:[-.01,0,0]}),false);assert.equal(identity({master:[180,0,0],...all([180,0,0])}),false);
 for(let j=0;j<8192;j++){const rgb=j<256?[j,j,j]:[next()>>>24,next()>>>24,next()>>>24];assert.deepEqual(zero(...rgb),rgb);assert.deepEqual(turn(...rgb),rgb);assert.deepEqual(cancel(...rgb),rgb);}
});
test('gray, hue knots, dark/pastel targets and chroma-softened Lightness use fixed native endpoint semantics',()=>{
 for(let gray=0;gray<256;gray++){
  assert.deepEqual(compile({master:[180,100,0],...all([180,100,100])})(gray,gray,gray),[gray,gray,gray]);
  for(const light of[-100,-13.37,0,10,100]){const expected=Math.round(light<0?gray*(1+light/100):gray+(255-gray)*light/100);assert.deepEqual(compile({master:[0,0,light]})(gray,gray,gray),[expected,expected,expected]);}
 }
 for(const [rgb,expected]of[[[32,0,0],[16,16,16]],[[255,223,223],[239,239,239]],[[200,100,100],[150,150,150]]])assert.deepEqual(compile({reds:[0,-100,0]})(...rgb),expected);
 for(const sat of[10,30])assert.deepEqual(compile({reds:[0,sat,0]})(128,127,127),[128,127,127]);
 assert.deepEqual(compile({reds:[0,0,10]})(128,127,127),[128,127,127]);assert.deepEqual(compile({reds:[0,0,10]})(1,0,0),[1,0,0]);
 assert.deepEqual(compile({master:[120,0,0]})(255,0,0),[0,255,0]);assert.deepEqual(compile({master:[-120,0,0]})(255,0,0),[0,0,255]);
 assert.deepEqual(compile({reds:[0,-100,0]})(224,1,127),[176,49,121]);assert.deepEqual(compile({reds:[0,-100,0]})(224,127,1),[176,121,49]);
});
test('literal half ties and endpoint goldens stay stable in two ordinary cold and warmed processes',async()=>{
 const run=promisify(execFile),worker=new URL('./fixtures/hue-saturation/cold-worker.mjs',import.meta.url);
 const first=await run(process.execPath,[worker.pathname],{timeout:15000}),second=await run(process.execPath,[worker.pathname],{timeout:15000});assert.equal(first.stderr,'');assert.equal(second.stderr,'');assert.match(first.stdout.trim(),/^[a-f0-9]{64}$/);assert.equal(first.stdout,second.stdout);
});
