import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { transformWithOxc } from 'vite';
import { NativeBackend } from '../server/native.mjs';

const helperDirectory=await fs.mkdtemp(path.join(os.tmpdir(),'prism-alignment-helper-audit-'));
after(()=>fs.rm(helperDirectory,{recursive:true,force:true}));
const {code}=await transformWithOxc(await fs.readFile(new URL('../client/clone-session.ts',import.meta.url),'utf8'),'clone-session.ts');
await fs.writeFile(path.join(helperDirectory,'clone-session.mjs'),code);
const sessionAPI=await import(pathToFileURL(path.join(helperDirectory,'clone-session.mjs')).href);
const {createCloneSession,syncCloneSession,setCloneAnchor,setCloneAligned,beginCloneStroke,submitCloneStroke,cancelCloneStroke,ownsCloneStroke,acceptCloneDocument,finishCloneStroke,cloneSampleCenter}=sessionAPI;
const context=extra=>({backend:'native',documentId:'document-a',targetLayerId:'layer-a',width:30,height:20,revision:7,tool:'clone',capabilityKey:'paint+current',samplingKey:'current,false',available:true,...extra});
function sampledSession(aligned=true,anchor={x:2.5,y:3.5},initial=context()){const session=createCloneSession();syncCloneSession(session,initial);setCloneAligned(session,aligned);setCloneAnchor(session,anchor);return session;}
function acknowledge(session,ticket){assert.equal(submitCloneStroke(session,ticket),true);const result={...ticket.context,revision:ticket.predecessorRevision+1};assert.equal(acceptCloneDocument(session,ticket,result),true);assert.equal(session.offset,null);syncCloneSession(session,result);assert.equal(ownsCloneStroke(session,ticket),true);assert.equal(finishCloneStroke(session,ticket,true),true);return result;}

const base=extra=>({id:randomUUID(),name:'Alignment independent fixture',visible:true,opacity:1,blendMode:'normal',...extra});
const image=(width,height,fn)=>Buffer.from(Array.from({length:width*height},(_,i)=>typeof fn==='function'?fn(i%width,Math.floor(i/width),i):fn).flat());
const at=(pixels,width,x,y)=>[...pixels.subarray(4*(y*width+x),4*(y*width+x)+4)];
const edit=(native,doc,command,args={})=>native.execute(command,{documentId:doc.id,expectedRevision:doc.revision,...args});
const stroke=(layerId,points,source,extra={})=>({layerId,tool:'clone',points,source,size:1,hardness:1,opacity:1,...extra});
async function fixture(t){const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'prism-alignment-audit-')),native=await new NativeBackend({dataDir}).init();t.after(async()=>{await native.close();await fs.rm(dataDir,{recursive:true,force:true});});return native;}
async function raster(native,pixels,width,height,extra={}){const asset=await native.storeAsset(await sharp(pixels,{raw:{width,height,channels:4}}).png().toBuffer());return base({type:'raster',width,height,asset,sourceAsset:asset,sourceFormat:'png',transforms:[],...extra});}
const project=async(native,width,height,layers,selection=null)=>(await native.newProject({name:'Alignment audit',width,height,layers,selection},'Fixture')).document;
const pixels=async(native,doc,layerId)=>sharp(await fs.readFile(path.join(native.assetsDir,doc.layers.find(l=>l.id===layerId).asset))).ensureAlpha().raw().toBuffer();
const sample=(rgba,w,h,x,y)=>{
  const observations=[];for(let sy=Math.floor(y);sy<=Math.floor(y)+1;sy++)for(let sx=Math.floor(x);sx<=Math.floor(x)+1;sx++)if(sx>=0&&sy>=0&&sx<w&&sy<h){const weight=(1-Math.abs(x-sx))*(1-Math.abs(y-sy)),p=at(rgba,w,sx,sy);observations.push({p,a:weight*p[3]/255});}
  const alpha=observations.reduce((sum,o)=>sum+o.a,0);return alpha?[...Array.from({length:3},(_,c)=>observations.reduce((sum,o)=>sum+o.p[c]*o.a,0)/alpha),alpha]:[0,0,0,0];
};
// Size-one, hard, unit-opacity, pixel-centered dabs touch one destination.
// This small independent oracle includes the existing healing annulus, rather
// than importing the production stroke kernel to predict chosen source pixels.
function expectedDab(original,composite,w,h,point,source,tool){
  const result=Buffer.from(original),x=Math.floor(point.x),y=Math.floor(point.y),color=sample(composite,w,h,source.x-.5,source.y-.5);
  if(tool==='heal'){
    const mean=center=>{const observations=[];for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)if(Math.hypot(dx,dy)>=1&&Math.hypot(dx,dy)<=2)observations.push(sample(composite,w,h,center.x+dx-.5,center.y+dy-.5));const alpha=observations.reduce((a,p)=>a+p[3],0);return alpha?Array.from({length:3},(_,c)=>observations.reduce((a,p)=>a+p[c]*p[3],0)/alpha):null;};
    const a=mean(point),b=mean(source);if(a&&b)for(let c=0;c<3;c++)color[c]=Math.max(0,Math.min(255,color[c]+a[c]-b[c]));
  }
  if(color[3]){const old=at(original,w,x,y),remaining=old[3]/255*(1-color[3]),alpha=color[3]+remaining,index=4*(y*w+x);for(let c=0;c<3;c++)result[index+c]=Math.round((color[c]*color[3]+old[c]*remaining)/alpha);result[index+3]=Math.round(alpha*255);}
  return result;
}

test('two accepted explicit-source strokes distinguish Restart from Aligned without depending on the previous endpoint',async t=>{
  const native=await fixture(t),w=30,h=20,input=image(w,h,(x,y)=>[x*7,y*11,(x+y)*3,255]),source=await raster(native,input,w,h),original=await fs.readFile(path.join(native.assetsDir,source.sourceAsset));
  const anchor={x:2.5,y:3.5},first={x:10.5,y:8.5},next={x:18.5,y:12.5},delta={x:anchor.x-first.x,y:anchor.y-first.y};
  for(const end of [{x:10.5,y:8.5},{x:14.5,y:8.5}])for(const aligned of [false,true]){
    let doc=await project(native,w,h,[source]);const initialRevision=doc.revision;doc=(await edit(native,doc,'paint_stroke',stroke(source.id,[first,end],anchor,{sampleMode:'current'}))).document;assert.deepEqual(at(await pixels(native,doc,source.id),w,10,8),[14,33,15,255]);
    const sent=aligned?{x:next.x+delta.x,y:next.y+delta.y}:anchor;doc=(await edit(native,doc,'paint_stroke',stroke(source.id,[next],sent,{sampleMode:'current'}))).document;
    assert.deepEqual(at(await pixels(native,doc,source.id),w,18,12),aligned?[70,77,51,255]:[14,33,15,255]);assert.equal(doc.revision,initialRevision+2);assert.equal(doc.history.length,3);assert.equal(doc.layers[0].sourceAsset,source.sourceAsset);
    assert.equal(Object.hasOwn(doc,'aligned'),false);assert.equal(Object.hasOwn(doc.layers[0],'sourceOffset'),false);
  }
  assert.deepEqual(await fs.readFile(path.join(native.assetsDir,source.sourceAsset)),original);
});

test('one stroke observes a frozen source while the next aligned stroke sees accepted working pixels',async t=>{
  const native=await fixture(t),w=30,h=20,input=image(w,h,(x,y)=>[x*7,y*11,(x+y)*3,255]),layer=await raster(native,input,w,h);let doc=await project(native,w,h,[layer]);
  const anchor={x:2.5,y:8.5},delta={x:-8,y:0},centers=Array.from({length:13},(_,i)=>({x:10.5+i,y:8.5}));doc=(await edit(native,doc,'paint_stroke',stroke(layer.id,centers,anchor,{sampleMode:'current'}))).document;
  const once=await pixels(native,doc,layer.id);for(let x=10;x<=22;x++)assert.deepEqual(at(once,w,x,8),at(input,w,x-8,8));assert.deepEqual(at(once,w,18,8),[70,88,54,255]);
  const next={x:18.5,y:8.5};doc=(await edit(native,doc,'paint_stroke',stroke(layer.id,[next],{x:next.x+delta.x,y:next.y+delta.y},{sampleMode:'current'}))).document;assert.deepEqual(at(await pixels(native,doc,layer.id),w,18,8),[14,88,30,255]);
  assert.deepEqual(await sharp(await fs.readFile(path.join(native.assetsDir,layer.sourceAsset))).ensureAlpha().raw().toBuffer(),input);
});

test('fractional and outside aligned source centers retain native bilinear alpha and size-one healing behavior',async t=>{
  const native=await fixture(t),w=12,h=9,input=image(w,h,(x,y)=>[(x*37+y*19)%256,(x*x*11+y*13)%256,(x*7+y*y*23)%256,[0,1,128,255][(x+2*y)%4]]),source=await raster(native,input,w,h),target=await raster(native,image(w,h,[0,0,0,0]),w,h);
  const original=await fs.readFile(path.join(native.assetsDir,source.sourceAsset)),first={x:6.5,y:4.5},anchor={x:2.25,y:2.125},delta={x:anchor.x-first.x,y:anchor.y-first.y};
  for(const tool of ['clone','heal'])for(const next of [{x:4.5,y:3.5},{x:3.5,y:2.5},{x:1.5,y:1.5}]){
    let doc=await project(native,w,h,[source,target]),working=Buffer.alloc(w*h*4);for(const[point,sent]of [[first,anchor],[next,{x:next.x+delta.x,y:next.y+delta.y}]]){
      // In Current & Below the already accepted repair is part of the fresh
      // sample. Render that map here, then use only the independent dab oracle.
      const composite=await native.renderGraph(doc);working=expectedDab(working,composite,w,h,point,sent,tool);doc=(await edit(native,doc,'paint_stroke',stroke(target.id,[point],sent,{tool,sampleMode:'current-and-below'}))).document;assert.deepEqual(await pixels(native,doc,target.id),working);
    }
  }
  const edgeSource=await raster(native,image(3,1,(x)=>x===0?[200,100,50,255]:[0,0,0,0]),3,1),edgeTarget=await raster(native,Buffer.alloc(12),3,1);for(const [x,expected]of [[-.25,[200,100,50,64]],[-1.5,[0,0,0,0]]]){let doc=await project(native,3,1,[edgeSource,edgeTarget]);doc=(await edit(native,doc,'paint_stroke',stroke(edgeTarget.id,[{x:1.5,y:.5}],{x,y:.5},{sampleMode:'current-and-below'}))).document;assert.deepEqual(at(await pixels(native,doc,edgeTarget.id),3,1,0),expected);}
  assert.deepEqual(await fs.readFile(path.join(native.assetsDir,source.sourceAsset)),original);
});

test('successive source points do not override selection or upper protected writes, and stale strokes cannot mutate history',async t=>{
  const native=await fixture(t),w=30,h=20,source=await raster(native,image(w,h,(x,y)=>[x*7,y*11,(x+y)*3,255]),w,h),target=await raster(native,Buffer.alloc(w*h*4),w,h),person=await raster(native,image(w,h,(x,y)=>[180,120,90,x===18&&y===12?1:0]),w,h,{protected:true});
  let doc=await project(native,w,h,[source,target,person],{shape:'rectangle',x:10,y:8,width:9,height:5,feather:0,invert:false});const old=structuredClone(doc),sourceBytes=await fs.readFile(path.join(native.assetsDir,source.sourceAsset)),anchor={x:2.5,y:3.5},first={x:10.5,y:8.5},next={x:18.5,y:12.5};
  doc=(await edit(native,doc,'paint_stroke',stroke(target.id,[first],anchor,{sampleMode:'current-and-below'}))).document;const afterFirst=await pixels(native,doc,target.id);assert.deepEqual(at(afterFirst,w,10,8),[14,33,15,255]);
  doc=(await edit(native,doc,'paint_stroke',stroke(target.id,[next],{x:10.5,y:7.5},{sampleMode:'current-and-below'}))).document;assert.deepEqual(await pixels(native,doc,target.id),afterFirst);assert.equal(doc.revision,old.revision+2,'An accepted protected no-op remains an acknowledged stroke');
  const afterSecond=structuredClone(doc);await assert.rejects(edit(native,old,'paint_stroke',stroke(target.id,[next],anchor,{sampleMode:'current-and-below'})),{code:'REVISION_CONFLICT'});assert.deepEqual((await native.execute('get_document',{documentId:doc.id})).document,afterSecond);
  doc=(await edit(native,doc,'paint_stroke',stroke(target.id,[{x:20.5,y:14.5}],{x:12.5,y:9.5},{sampleMode:'current-and-below'}))).document;assert.deepEqual(await pixels(native,doc,target.id),afterFirst,'A source point cannot expand selection coverage');
  assert.deepEqual(doc.layers.find(l=>l.id===person.id),person);assert.deepEqual(doc.layers.find(l=>l.id===source.id),source);assert.deepEqual(await fs.readFile(path.join(native.assetsDir,source.sourceAsset)),sourceBytes);
});

test('pure session commits only its acknowledged first offset and retains legacy Restart coordinates',()=>{
  const empty=createCloneSession();assert.equal(empty.aligned,false);assert.equal(beginCloneStroke(empty,{x:1,y:1}),null);
  const anchor={x:2.5,y:3.5},first={x:10.5,y:8.5},session=sampledSession(true,anchor),ticket=beginCloneStroke(session,first);assert.ok(ticket);anchor.x=200;first.x=201;
  assert.deepEqual(ticket.source,{x:2.5,y:3.5});assert.deepEqual(ticket.firstPoint,{x:10.5,y:8.5});assert.deepEqual(ticket.tentativeOffset,{x:-8,y:-5});assert.equal(session.offset,null);assert.equal(beginCloneStroke(session,{x:2,y:2}),null);
  assert.equal(cancelCloneStroke(session,ticket),true);assert.equal(session.offset,null);assert.deepEqual(session.anchor,{x:2.5,y:3.5});assert.equal(submitCloneStroke(session,ticket),false);
  const accepted=beginCloneStroke(session,{x:12.5,y:9.5});acknowledge(session,accepted);assert.deepEqual(session.offset,{x:-10,y:-6});
  const next=beginCloneStroke(session,{x:18.5,y:12.5});assert.deepEqual(next.source,{x:8.5,y:6.5});assert.equal(next.tentativeOffset,null);assert.equal(cancelCloneStroke(session,next),true);assert.deepEqual(session.offset,{x:-10,y:-6});
  setCloneAligned(session,false);assert.deepEqual(session.anchor,{x:2.5,y:3.5});assert.equal(session.offset,null);const restart=beginCloneStroke(session,{x:25.5,y:17.5});assert.deepEqual(restart.source,{x:2.5,y:3.5});acknowledge(session,restart);assert.equal(session.offset,null);
  setCloneAligned(session,true);assert.equal(session.offset,null);const fresh=beginCloneStroke(session,{x:20.5,y:15.5});assert.deepEqual(fresh.source,{x:2.5,y:3.5});assert.deepEqual(fresh.tentativeOffset,{x:-18,y:-12});
});

test('pure handoff requires the exact owned response before its revision can be observed',()=>{
  const session=sampledSession(),ticket=beginCloneStroke(session,{x:10.5,y:8.5}),result={...context(),revision:8};assert.equal(acceptCloneDocument(session,ticket,result),false);assert.equal(submitCloneStroke(session,ticket),true);assert.equal(submitCloneStroke(session,ticket),false);assert.equal(cancelCloneStroke(session,ticket),false);
  for(const wrong of [{revision:7},{revision:9},{documentId:'document-b'},{targetLayerId:'layer-b'},{width:31},{height:21},{backend:'photoshop'},{tool:'heal'},{capabilityKey:'withdrawn'},{samplingKey:'all,false'},{available:false}]){assert.equal(acceptCloneDocument(session,ticket,{...result,...wrong}),false);assert.equal(ownsCloneStroke(session,ticket),true);assert.equal(ticket.acceptedOwnRevision,undefined);}
  assert.equal(acceptCloneDocument(session,ticket,result),true);assert.equal(acceptCloneDocument(session,ticket,result),false);assert.equal(session.offset,null);syncCloneSession(session,{...context()});assert.equal(ownsCloneStroke(session,ticket),true,'Pre-install live props can still show the predecessor');syncCloneSession(session,result);assert.equal(ownsCloneStroke(session,ticket),true);assert.equal(session.offset,null,'Metadata acceptance does not yet finalize the offset');assert.equal(finishCloneStroke(session,ticket,true),true);assert.deepEqual(session.offset,{x:-8,y:-5});
  const foreign=sampledSession(),pending=beginCloneStroke(foreign,{x:10.5,y:8.5});submitCloneStroke(foreign,pending);syncCloneSession(foreign,result);assert.equal(foreign.anchor,null);assert.equal(acceptCloneDocument(foreign,pending,result),false);assert.equal(finishCloneStroke(foreign,pending,true),false,'An unrelated successor revision is not our acknowledgement');
  const premature=sampledSession(),unacknowledged=beginCloneStroke(premature,{x:10.5,y:8.5});submitCloneStroke(premature,unacknowledged);assert.equal(finishCloneStroke(premature,unacknowledged,true),true);assert.equal(premature.anchor,null);assert.equal(premature.offset,null);
});

test('late success, null and cleanup callbacks cannot own replacement anchors or away-and-back sessions',()=>{
  for(const transition of ['anchor','reset','toggle','document','layer','tool','dimensions','capability','sampling','disconnect','revision']){
    const session=sampledSession(),ticket=beginCloneStroke(session,{x:10.5,y:8.5});submitCloneStroke(session,ticket);const result={...context(),revision:8};assert.equal(acceptCloneDocument(session,ticket,result),true);syncCloneSession(session,result);
    if(transition==='anchor')setCloneAnchor(session,{x:9,y:9});else if(transition==='reset')setCloneAnchor(session,null);else if(transition==='toggle')setCloneAligned(session,false);else{
      const change={document:{documentId:'other'},layer:{targetLayerId:'other'},tool:{tool:'heal'},dimensions:{width:29},capability:{capabilityKey:'withdrawn'},sampling:{samplingKey:'all,false'},disconnect:{available:false},revision:{revision:9}}[transition];syncCloneSession(session,{...result,...change});syncCloneSession(session,result);
    }
    setCloneAnchor(session,{x:5.25,y:6.75});const replacement=beginCloneStroke(session,{x:15.5,y:11.5}),before=structuredClone(session);assert.ok(replacement);assert.equal(ownsCloneStroke(session,ticket),false);assert.equal(acceptCloneDocument(session,ticket,result),false);assert.equal(cancelCloneStroke(session,ticket),false);assert.equal(finishCloneStroke(session,ticket,true),false);assert.equal(finishCloneStroke(session,ticket,false),false);assert.deepEqual(session,before);assert.equal(ownsCloneStroke(session,replacement),true);
  }
  for(const accepted of [false,true]){const session=sampledSession(),ticket=beginCloneStroke(session,{x:10.5,y:8.5});submitCloneStroke(session,ticket);if(accepted){const result={...context(),revision:8};acceptCloneDocument(session,ticket,result);syncCloneSession(session,result);}assert.equal(finishCloneStroke(session,ticket,false),true);assert.equal(session.anchor,null);assert.equal(session.offset,null);assert.equal(session.stroke,null);}
  for(const aligned of [false,true]){const session=sampledSession(aligned),epoch=session.epoch;syncCloneSession(session,{...context()});assert.equal(session.epoch,epoch);syncCloneSession(session,context({tool:'heal'}));assert.equal(Boolean(session.anchor),!aligned);syncCloneSession(session,context({tool:'heal',revision:8}));assert.equal(Boolean(session.anchor),!aligned);syncCloneSession(session,context({tool:'heal',revision:8,samplingKey:'all,false'}));assert.equal(session.anchor,null);}
});

test('moving and pending sample centers use captured API arithmetic without accumulating or clamping the offset',()=>{
  const session=sampledSession(true,{x:.1,y:.5}),first=beginCloneStroke(session,{x:.2,y:1.5});acknowledge(session,first);assert.deepEqual(session.offset,{x:-.1,y:-1});assert.equal(cloneSampleCenter(session,null),null);
  const next=beginCloneStroke(session,{x:1.3,y:.5});assert.equal(next.source.x,1.2);assert.equal(next.source.y,-.5);assert.equal(next.source.x-next.firstPoint.x,-.10000000000000009);assert.deepEqual(cloneSampleCenter(session,{x:0,y:0}),{x:-.10000000000000009,y:-1});assert.deepEqual(session.offset,{x:-.1,y:-1});
  next.lastPoint={x:2.3,y:3.5};submitCloneStroke(session,next);assert.deepEqual(cloneSampleCenter(session,{x:20,y:19}),{x:2.3+(1.2-1.3),y:2.5});const result={...session.context,revision:session.context.revision+1};acceptCloneDocument(session,next,result);syncCloneSession(session,result);finishCloneStroke(session,next,true);assert.deepEqual(session.offset,{x:-.1,y:-1});assert.deepEqual(cloneSampleCenter(session,{x:0,y:0}),{x:-.1,y:-1});
  setCloneAligned(session,false);assert.deepEqual(cloneSampleCenter(session,null),{x:.1,y:.5});const restart=beginCloneStroke(session,{x:10,y:10});assert.deepEqual(cloneSampleCenter(session,{x:11,y:12}),{x:11+(.1-10),y:2.5});cancelCloneStroke(session,restart);assert.deepEqual(cloneSampleCenter(session,null),{x:.1,y:.5});
});
