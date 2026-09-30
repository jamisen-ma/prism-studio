import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { encodeDenseMaskFrame, materializeMaskAlpha, prepareMaskCoverage } from '../server/dense-mask.mjs';
import { maskCoverage, bitmapMask } from '../server/masks.mjs';
import { channelCoverageByte } from '../server/mask-operations.mjs';
const plane = (length, fn) => Buffer.from(Uint8Array.from({length}, fn));
const equalBytes = (a,b) => { assert.equal(a.length,b.length); const i=a.findIndex((v,i)=>v!==b[i]); assert.equal(i,-1,`first differing byte ${i}: ${a[i]} vs ${b[i]}`); };
const base = extra => ({ id: randomUUID(), name: 'Dense owner fixture', type: 'solid', color: '#ffffff', visible: true, opacity: 1, blendMode: 'normal', transforms: [], ...extra });
const graph = (w,h,layers,extra={}) => ({name:'Dense owner',width:w,height:h,layers,selection:null,...extra});
const current = (n,d) => n.projects.get(d.id).states[n.projects.get(d.id).cursor].graph;
const edit = (n,d,c,a={}) => n.execute(c,{documentId:d.id,expectedRevision:d.revision,...a});
async function setup(t){const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'prism-dense-owner-'));const n=await new NativeBackend({dataDir}).init();t.after(async()=>{await n.close();await fs.rm(dataDir,{recursive:true,force:true});});return n;}
async function raw(n,alpha,w,h,extra={}){const {frame,descriptor}=await encodeDenseMaskFrame(alpha,w,h);await n.storeAsset(frame);return {...descriptor,...extra};}
async function rgba(n,bytes,w,h,extra={}){const asset=await n.storeAsset(await sharp(bytes,{raw:{width:w,height:h,channels:4}}).png().toBuffer());return base({type:'raster',width:w,height:h,asset,sourceAsset:asset,sourceFormat:'png',...extra});}
const values=(n,mask,w,h)=>materializeMaskAlpha(mask,w,h,m=>n.readDenseMask(m));

test('dense channel production publishes exact 512 square coverage and adaptive paint/morphology preserves ownership',async t=>{
 const n=await setup(t),w=512,h=512,bytes=Buffer.alloc(w*h*4);for(let i=0;i<w*h;i++){bytes[4*i]=1+i%255;bytes[4*i+1]=(i*71)%256;bytes[4*i+2]=(i*37)%256;bytes[4*i+3]=255;}
 const layer=await rgba(n,bytes,w,h);let d=(await n.newProject(graph(w,h,[layer]),'Fixture')).document;
 d=(await edit(n,d,'load_channel_selection',{channel:'red'})).document;assert.equal(d.selection.shape,'alpha8');const original=await values(n,d.selection,w,h);equalBytes(original,plane(w*h,(_,i)=>bytes[4*i]));
 const before=await fs.readFile(path.join(n.assetsDir,d.selection.asset));
 d=(await edit(n,d,'paint_selection',{mode:'subtract',size:8,hardness:1,opacity:1,points:[{x:20,y:20}]})).document;assert.equal(d.selection.shape,'alpha8');const painted=await values(n,d.selection,w,h);assert.equal(painted[20*w+20],0);assert.equal(painted[300*w+300],original[300*w+300]);
 d=(await edit(n,d,'morph_selection',{operation:'expand',radius:1})).document;assert.ok(d.selection);
 assert.deepEqual(await fs.readFile(path.join(n.assetsDir,JSON.parse(JSON.stringify(n.projects.get(d.id).states[1].graph.selection)).asset)),before);
});

test('dense generation protection and cutout refinement consume byte coverage without changing source frames',async t=>{
 const n=await setup(t),w=8,h=5,alpha=plane(w*h,(_,i)=>(i*43)%256),mask=await raw(n,alpha,w,h);
 const pixels=Buffer.alloc(w*h*4,255),layer=await rgba(n,pixels,w,h,{alphaAsset:await n.storeAlpha(Buffer.alloc(w*h,128),w,h)});
 let d=(await n.newProject(graph(w,h,[layer],{selection:mask}),'Fixture')).document;
 const snap=await n.snapshotForGeneration({documentId:d.id,expectedRevision:d.revision,scope:'selection'});const gray=await sharp(snap.mask).ensureAlpha().raw().toBuffer();for(let i=0;i<alpha.length;i++)assert.equal(gray[4*i+3],255-alpha[i]);
 d=(await edit(n,d,'refine_cutout_from_selection',{layerId:layer.id,mode:'intersect'})).document;assert.deepEqual(await n.readAlpha(current(n,d).layers[0].alphaAsset,w,h),Buffer.from(alpha.map(a=>Math.round(128*a/255))));assert.deepEqual(await values(n,mask,w,h),alpha);
 const protectedLayer=base({width:w,height:h,protected:true,mask});const protectedDoc=(await n.newProject(graph(w,h,[protectedLayer],{selection:{...mask,invert:true}}),'Protection')).document;
 const protectedSnap=await n.snapshotForGeneration({documentId:protectedDoc.id,scope:'selection'}),out=await sharp(protectedSnap.mask).ensureAlpha().raw().toBuffer();for(let i=0;i<alpha.length;i++)assert.equal(out[4*i+3],alpha[i]>0?255:0);
});

test('dense PSD compatibility and export prepare exact masks while keeping fractional density refusal',async t=>{
 const n=await setup(t),w=7,h=4,alpha=plane(w*h,(_,i)=>(i*47)%256),mask=await raw(n,alpha,w,h);
 const lower=base({width:w,height:h}),upper=base({width:w,height:h,color:'#4455aa',mask});let d=(await n.newProject(graph(w,h,[lower,upper]),'PSD')).document;
 assert.equal((await n.inspectPsdExport({documentId:d.id})).supported,true);const output=await n.exportPsd({documentId:d.id});assert.equal(output.data.toString('ascii',0,4),'8BPS');
 d=(await edit(n,d,'modify_layer_mask',{layerId:upper.id,density:.5})).document;const refused=await n.inspectPsdExport({documentId:d.id});assert.equal(refused.supported,false);assert.ok(refused.issues.some(i=>i.code==='MASK_NOT_REPRESENTABLE'));
 assert.deepEqual(await values(n,mask,w,h),alpha);
});

test('dense layer selection, saved combination and positioned materialization retain legacy geometric fractional order',async t=>{
 const n=await setup(t),w=3,h=2,alpha=Buffer.from([69,128,255,1,0,200]),mask=await raw(n,alpha,w,h),layer=base({width:w,height:h,mask});let d=(await n.newProject(graph(w,h,[layer],{selection:{shape:'rectangle',x:0,y:0,width:1,height:1,feather:3,invert:false}}),'Combine')).document;
 d=(await edit(n,d,'load_layer_selection',{layerId:layer.id,source:'layer-mask',mode:'intersect'})).document;assert.equal((await values(n,d.selection,w,h))[0],11);
 d=(await edit(n,d,'set_layer_mask_position',{layerId:layer.id,x:1,y:0})).document;d=(await edit(n,d,'apply_layer_mask_position',{layerId:layer.id})).document;assert.deepEqual(await values(n,current(n,d).layers[0].mask,w,h),Buffer.from([0,69,128,0,1,0]));
});

test('raw and legacy preparation have exact feather/invert/density bytes across wide and tall small fixtures',async t=>{
 const n=await setup(t);for(const [w,h] of [[129,2],[2,129],[17,11]])for(const feather of [0,.25,1,3.75,100])for(const invert of [false,true]){
 const alpha=plane(w*h,(_,i)=>i%7===0?0:(i*73)%256),legacy={...bitmapMask(alpha,w,h),feather,invert},dense=await raw(n,alpha,w,h,{feather,invert}),expected=maskCoverage(legacy),actual=await prepareMaskCoverage(dense,m=>n.readDenseMask(m));
 for(let y=-1;y<=h;y++)for(let x=-1;x<=w;x++)assert.equal(actual(x,y),expected(x,y));
 }
});

test('channel integer coverage keeps hidden RGB, double rounding and final inversion explicit',()=>{
 for(let a=0;a<256;a++)for(const rgb of [[0,0,0],[255,255,255],[14,1,122],[224,1,127]]){const bytes=Buffer.from([...rgb,a]);const y=Math.floor((2126*rgb[0]+7152*rgb[1]+722*rgb[2]+5000)/10000);for(const [channel,c]of[['red',rgb[0]],['green',rgb[1]],['blue',rgb[2]],['luma',y],['alpha',255]]){const expected=channel==='alpha'?a:Math.floor((c*a+127)/255);assert.equal(channelCoverageByte(bytes,0,channel),expected);assert.equal(channelCoverageByte(bytes,0,channel,true),255-expected);}}
 assert.equal(channelCoverageByte(Buffer.from([14,1,122,128]),0,'luma'),7);
});

test('optimized fresh-process masked photographic Invert preserves all scalar, alpha and protection bytes',async()=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),run=promisify(execFile),worker=new URL('./fixtures/dense-mask/invert-worker.mjs',import.meta.url);
 const first=await run(process.execPath,[worker.pathname],{timeout:20000}),second=await run(process.execPath,[worker.pathname],{timeout:20000});assert.equal(first.stderr,'');assert.equal(second.stderr,'');assert.match(first.stdout.trim(),/^[a-f0-9]{64}$/);assert.equal(first.stdout,second.stdout);
});
