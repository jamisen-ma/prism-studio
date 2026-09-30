import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {CURVES_BANKS_POLICY,CURVES_BANK_NAMES,CURVES_BANKS_CACHE_BYTES,normalizeCurvesBanksParameters,mergeCurvesBanksParameters,compileCurvesBankLookup,compileCurvesBanksLookup} from '../shared/curves-banks.mjs';
import {normalizeParameters,mergeCurvesParameters,adjustmentTransform,COLOR_MAPPING_KINDS} from '../server/color.mjs';
const invalid={code:'INVALID_ARGUMENT'},identity=[{x:0,y:0},{x:255,y:255}],line=(a,b)=>[{x:0,y:a},{x:255,y:b}],entry=parameters=>({kind:'curves',value:0,parameters});
const sequence=parameters=>CURVES_BANK_NAMES.map(name=>adjustmentTransform(entry({...parameters.banks[name],channel:name==='master'?'rgb':name})));
const apply=(functions,rgb)=>functions.reduce((out,fn)=>fn(...out),rgb);

test('banked Curves defaults and strict owned metadata reject malformed structures without invoking accessors',()=>{
 assert.equal(CURVES_BANKS_POLICY,'master-byte-then-channel-byte-v1');assert.equal(CURVES_BANKS_CACHE_BYTES,1280);assert.deepEqual(CURVES_BANK_NAMES,['master','red','green','blue']);assert.ok(Object.isFrozen(CURVES_BANK_NAMES));assert.ok(!COLOR_MAPPING_KINDS.includes('curves'));
 const p=normalizeCurvesBanksParameters({mode:'banks'});for(const name of CURVES_BANK_NAMES)assert.deepEqual(p.banks[name],{points:identity,interpolation:'linear'});p.banks.master.points[0].y=12;assert.equal(p.banks.red.points[0].y,0);assert.equal(normalizeCurvesBanksParameters({mode:'banks'}).banks.master.points[0].y,0);
 let calls=0;const getter=Object.defineProperty({},'points',{enumerable:true,get(){calls++;return identity;}}),modeGetter=Object.defineProperty({},'mode',{enumerable:true,get(){calls++;return'banks';}}),point=Object.defineProperty({y:0},'x',{enumerable:true,get(){calls++;return 0;}}),array=[identity[0],identity[1]];Object.defineProperty(array,'1',{enumerable:true,get(){calls++;return identity[1];}});
 const malformed=[null,[],{mode:undefined},{banks:{}},{mode:'future'},{mode:'banks',channel:'rgb'},{mode:'single',banks:{}},{mode:'banks',banks:null},{mode:'banks',banks:{cyan:{}}},{mode:'banks',banks:{red:null}},{mode:'banks',banks:{red:getter}},{mode:'banks',banks:{red:{points:[point,identity[1]]}}},{mode:'banks',banks:{red:{points:array}}},{mode:'banks',banks:{red:{points:[identity[0],,identity[1]]}}},{mode:'banks',banks:{red:{points:[{...identity[0],extra:true},identity[1]]}}},{mode:'banks',banks:{red:{points:[{x:0,y:0},{x:0,y:1},{x:255,y:255}]}}},{mode:'banks',banks:{red:{interpolation:null}}},{mode:'banks',banks:{[Symbol('bad')]:{}}},{mode:'banks',banks:Object.create({red:{}})},modeGetter];
 for(const value of malformed)assert.throws(()=>normalizeParameters('curves',value),invalid);assert.throws(()=>adjustmentTransform(entry(modeGetter)),invalid);assert.equal(calls,0);
 const old={points:[{x:0,y:0,ignored:'legacy'},identity[1]],channel:'red',interpolation:'linear'};assert.deepEqual(normalizeParameters('curves',old),{points:identity,channel:'red'});
});

test('dedicated merging retains every unmentioned bank and requires explicit cross-representation replacement',()=>{
 const legacy={points:line(255,0),channel:'blue',interpolation:'smooth'},a=normalizeCurvesBanksParameters({mode:'banks',banks:{red:{points:line(1,200),interpolation:'smooth'},blue:{points:line(5,220)}}}),snapshot=structuredClone(a);
 const b=mergeCurvesParameters(a,{mode:'banks',banks:{red:{interpolation:'linear'}}});assert.deepEqual(b.banks.red.points,a.banks.red.points);assert.equal(b.banks.red.interpolation,'linear');assert.deepEqual(b.banks.blue,a.banks.blue);assert.deepEqual(a,snapshot);
 const c=mergeCurvesBanksParameters(a,{mode:'banks',banks:{red:{points:line(0,220)}}});assert.equal(c.banks.red.interpolation,'smooth');assert.deepEqual(mergeCurvesParameters(a,{}),a);assert.deepEqual(mergeCurvesParameters(a,{mode:'banks',banks:{red:{}}}),a);
 for(const p of [{channel:'blue'},{interpolation:'linear'},{points:identity},{banks:{}}])assert.throws(()=>mergeCurvesParameters(a,p),invalid);
 assert.deepEqual(mergeCurvesParameters(a,{mode:'single',channel:'blue'}),{points:identity,channel:'blue'});assert.deepEqual(mergeCurvesParameters(legacy,{mode:'single',channel:'red'}),{...legacy,channel:'red'});
 assert.deepEqual(mergeCurvesParameters(legacy,{mode:'banks',banks:{green:{interpolation:'smooth'}}}),normalizeCurvesBanksParameters({mode:'banks',banks:{green:{interpolation:'smooth'}}}));
 b.banks.blue.points[0].y=7;assert.equal(a.banks.blue.points[0].y,5);
});

test('mixed bank lookups match four existing byte stages across full precision and preserve all legacy channel upgrades',()=>{
 let seed=0x14aa2901;const random=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
 const configurations=[];for(let j=0;j<96;j++){const banks={};for(const [k,name]of CURVES_BANK_NAMES.entries()){const xs=new Set([0,255]);while(xs.size<2+j%15)xs.add((random()%25500000)/100000);banks[name]={points:[...xs].sort((x,y)=>x-y).map(x=>({x,y:(random()%25500000)/100000})),interpolation:(j+k)%2?'smooth':'linear'};}configurations.push(normalizeCurvesBanksParameters({mode:'banks',banks}));}
 for(const p of configurations){const lookup=compileCurvesBanksLookup(p),fn=adjustmentTransform(entry(p)),seq=sequence(p);assert.equal(lookup.byteLength,768);assert.equal(lookup.buffer.byteLength,768);for(let i=0;i<256;i++){const input=[i,(i*137+13)%256,(i*251+71)%256],expected=apply(seq,input);assert.deepEqual(fn(...input),expected);assert.deepEqual([lookup[input[0]],lookup[256+input[1]],lookup[512+input[2]]],expected);}}
 const pointsList=[[{x:0,y:255},{x:Number.MIN_VALUE,y:0},{x:1,y:255},{x:255,y:0}],[{x:0,y:0},{x:.1,y:220},{x:.2,y:30},{x:255,y:255}],[{x:0,y:0},{x:1,y:100},{x:1+Number.EPSILON,y:200},{x:255,y:0}],line(255,.49999999999999994)];
 for(const points of pointsList)for(const channel of ['rgb','red','green','blue'])for(const interpolation of ['linear','smooth']){const old=adjustmentTransform(entry({points,channel,interpolation})),up=adjustmentTransform(entry({mode:'banks',banks:{[channel==='rgb'?'master':channel]:{points,interpolation}}}));for(let i=0;i<256;i++)assert.deepEqual(up(i,255-i,i),old(i,255-i,i));}
});

test('byte-stage half ties, order, inversion cancellation and private compiler ownership are explicit',()=>{
 assert.equal(compileCurvesBankLookup({points:line(255,.49999999999999994),interpolation:'linear'})[255],1);assert.equal(compileCurvesBankLookup({points:line(255,.49999999999999994),interpolation:'smooth'})[255],0);
 const half=adjustmentTransform(entry({mode:'banks',banks:{master:{points:line(0,127.5)},red:{points:line(0,127.5)}}}));assert.deepEqual(half(1,0,0),[1,0,0]);assert.equal(Math.round(.25),0);
 const order=adjustmentTransform(entry({mode:'banks',banks:{master:{points:[{x:0,y:0},{x:96,y:144},{x:255,y:255}]},red:{points:[{x:0,y:0},{x:160,y:112},{x:255,y:255}]}}}));assert.deepEqual(order(1,150,66),[1,182,99]);
 const p=normalizeCurvesBanksParameters({mode:'banks',banks:Object.fromEntries(CURVES_BANK_NAMES.map(name=>[name,{points:line(255,0)}]))}),fn=adjustmentTransform(entry(p)),table=compileCurvesBanksLookup(p);p.banks.red.points[0].y=0;table.fill(9);for(let i=0;i<256;i++)assert.deepEqual(fn(i,255-i,i),[i,255-i,i]);const out=fn(12,13,14);out[0]=200;assert.deepEqual(fn(12,13,14),[12,13,14]);assert.deepEqual(Reflect.ownKeys(fn),['length','name']);
});

test('ordinary fresh Node processes retain exact legacy-to-bank bytes through optimized repeated calls',async()=>{
 const run=promisify(execFile),reports=[];for(let i=0;i<2;i++){const {stdout}=await run(process.execPath,['tests/fixtures/curves-banks/cold-worker.mjs'],{cwd:process.cwd()});reports.push(JSON.parse(stdout));}assert.deepEqual(reports[0],reports[1]);assert.equal(reports[0].bytes,2359296);
});
