import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { applyLayerFilters, validateLayerFilterResources } from '../server/layer-filters.mjs';
import { compileFilterMaskDensity, prepareBitmapCoverage, prepareFilterMaskBytes, mixFilterMask, planFilterMaskCapture, estimateFilterMaskCapture, captureFilterMask, estimateFilterMaskSourceBytes, filterEntries } from '../server/filter-mask.mjs';
import { estimateFilterBakeBytes, bakeFilterSource } from '../server/filter-bake.mjs';
import { maskCoverage } from '../server/masks.mjs';
import { layerTree } from '../server/groups.mjs';
import { encodeProjectBundle, decodeProjectBundle } from '../server/project-bundle.mjs';

const base=extra=>({id:randomUUID(),name:'Independent filter-mask audit',visible:true,opacity:1,blendMode:'normal',...extra});
const filter=(kind='invert',extra={})=>({id:randomUUID(),kind,value:kind==='invert'?100:0,enabled:true,opacity:1,...extra});
const image=(w,h,fn)=>Buffer.from(Array.from({length:w*h},(_,i)=>typeof fn==='function'?fn(i%w,Math.floor(i/w),i):fn).flat());
const bitmap=(bytes,w,h,extra={})=>{const runs=[];for(let i=0;i<bytes.length;){const value=bytes[i];let end=i+1;while(end<bytes.length&&bytes[end]===value)end++;if(value)runs.push(i,end-i,value);i=end;}return{shape:'bitmap',x:0,y:0,width:w,height:h,runs,feather:0,invert:false,...extra};};
const mask=(w,h,coverage={shape:'rectangle',x:0,y:0,width:w,height:h,feather:0,invert:false},extra={})=>({sourceWidth:w,sourceHeight:h,coverage,density:1,enabled:true,...extra});
const wrap=(entries,scope)=>({version:1,entries,mask:scope});
const edit=(native,doc,command,args={})=>native.execute(command,{documentId:doc.id,expectedRevision:doc.revision,...(command==='apply_transaction'?{label:'Filter-mask audit transaction'}:{}),...args});
const get=async(native,doc)=>(await native.execute('get_document',{documentId:doc.id})).document;
const graph=(native,doc)=>{const project=native.projects.get(doc.id);return structuredClone(project.states[project.cursor].graph);};
const layerOf=(native,doc,id)=>graph(native,doc).layers.find(layer=>layer.id===id);
const files=async dir=>Object.fromEntries(await Promise.all((await fs.readdir(dir)).sort().map(async name=>[name,await fs.readFile(path.join(dir,name))])));
const decode=data=>sharp(data).toColourspace('srgb').ensureAlpha().raw().toBuffer();
const project=async(native,width,height,layers,extra={})=>(await native.newProject({name:'Filter-mask audit',width,height,selection:null,layers,...extra},'Fixture')).document;
async function fixture(t){const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'prism-filter-mask-audit-'));const native=await new NativeBackend({dataDir,segmentSubject:()=>assert.fail('Filter masks must not call a model')}).init();t.after(async()=>{await native.close();await fs.rm(dataDir,{recursive:true,force:true});});return{native,dataDir};}
async function raster(native,input,width,height,extra={}){const asset=await native.storeAsset(await sharp(input,{raw:{width,height,channels:4}}).png().toBuffer());return base({type:'raster',width,height,asset,sourceAsset:asset,sourceFormat:'png',transforms:[],...extra});}
async function noPixels(native,run,noFilesystem=false){const restore=[],calls=[];for(const key of ['render','renderGraph','renderLayer','readAlpha','storeAlpha','storeAsset','readProjectAsset','validateProjectAsset','segmentSubject'])if(typeof native[key]==='function'){const old=native[key];native[key]=()=>{calls.push(key);assert.fail(`Unexpected ${key}`);};restore.push(()=>{native[key]=old;});}if(noFilesystem)for(const key of ['readFile','writeFile','open','rename','link','stat']){const old=fs[key];fs[key]=()=>{calls.push(`fs.${key}`);assert.fail(`Unexpected fs.${key}`);};restore.push(()=>{fs[key]=old;});}try{return await run();}finally{restore.reverse().forEach(fn=>fn());assert.deepEqual(calls,[],'An intercepted I/O failure cannot be mistaken for metadata rejection.');}}

// Independent emulation of the declared multiply, subtraction and final byte
// rounding. This distinguishes the native stage from unrounded IEEE rationals.
function fraction(value){let n=value,q=1n;while(!Number.isInteger(n)){n*=2;q*=2n;}return[BigInt(n),q];}
function roundedDyadic(n,q){if(n===0n)return[0n,1n];const denominatorExponent=q.toString(2).length-1,top=n.toString(2).length-1-denominatorExponent,unit=Math.max(-1074,top-52),shift=denominatorExponent+unit;let significand;if(shift<=0)significand=n<<BigInt(-shift);else{const divider=1n<<BigInt(shift),low=n%divider;significand=n/divider;if(2n*low>divider||2n*low===divider&&significand%2n===1n)significand++;}return unit>=0?[significand<<BigInt(unit),1n]:[significand,1n<<BigInt(-unit)];}
function densityByte(d,m){if(d===0)return 255;if(d===1)return m;const[p,q]=fraction(d),[n,r]=roundedDyadic(p*BigInt(255-m),q),[a,b]=roundedDyadic(255n*r-n,r);return Number((2n*a+b)/(2n*b));}
const mixedByte=(o,f,m)=>Number((2n*(BigInt(o)*BigInt(255-m)+BigInt(f)*BigInt(m))+255n)/510n);
function mixedImage(original,filtered,raw,scope){const out=Buffer.from(filtered);for(let p=0;p<raw.length;p++){const at=4*p,e=scope.enabled?densityByte(scope.density,raw[p]):255;for(let c=0;c<3;c++)out[at+c]=original[at+3]?mixedByte(original[at+c],filtered[at+c],e):original[at+c];out[at+3]=original[at+3];}return out;}

test('production LUT and whole-stack mixing match an independent IEEE-stage and integer oracle without changing source alpha',async()=>{
  const densities=[0,Number.MIN_VALUE,.09999999999999999,.1,.10000000000000002,.25,.3,.5-2**-54,.5,.5+2**-53,.75,.9,1-2**-53,1];
  const w=256,h=4,input=image(w,h,(x,y)=>[x,(x*73)%256,255-x,[0,1,128,255][y]]),copy=Buffer.from(input),entries=[filter()],full=Buffer.from(input);
  for(let p=0;p<w*h;p++)if(full[4*p+3])for(let c=0;c<3;c++)full[4*p+c]=255-full[4*p+c];
  for(const d of densities){const lut=compileFilterMaskDensity(d);for(let m=0;m<256;m++)assert.equal(lut[m],densityByte(d,m));for(const invert of [false,true]){
    const raw=Uint8Array.from({length:w*h},(_,p)=>invert?255-p%w:p%w),scope=mask(w,h,bitmap(Uint8Array.from({length:w*h},(_,p)=>p%w),w,h,{invert}),{density:d}),actual=await applyLayerFilters(input,w,h,wrap(entries,scope));
    assert.deepEqual(actual,mixedImage(input,full,raw,scope));assert.deepEqual(input,copy);assert.notEqual(actual,input);
  }}
  assert.equal(compileFilterMaskDensity(.1)[0],230);assert.equal(compileFilterMaskDensity(.5+2**-53)[0],127);
  const scope=mask(w,h,bitmap(new Uint8Array(w*h),w,h),{enabled:false,density:.1});assert.deepEqual(await applyLayerFilters(input,w,h,wrap(entries,scope)),full);
  const inactive=wrap([{...entries[0],enabled:false}],scope);assert.equal(await applyLayerFilters(input,w,h,inactive),input);
  const double=wrap([filter(),filter()],mask(w,h,bitmap(new Uint8Array(w*h).fill(128),w,h)));assert.deepEqual(await applyLayerFilters(input,w,h,double),input);
  const neighbors=Buffer.from([0,0,0,255,255,255,255,255,0,0,0,255]),blur=filter('blur',{value:1}),unmasked=await applyLayerFilters(neighbors,3,1,[blur]),masked=await applyLayerFilters(neighbors,3,1,wrap([blur],mask(3,1,bitmap([255,0,255],3,1))));
  assert.equal(masked[0],unmasked[0]);assert.ok(masked[0]>0);assert.equal(masked[4],255);
  const owned=Buffer.from(full);assert.equal(await mixFilterMask(input,owned,w,h,scope),owned);assert.deepEqual(input,copy);
});

test('async bitmap preparation preserves legacy feather bytes and yields even for sparse runs that avoid absolute boundaries',async()=>{
  let seed=0x15402;const next=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
  for(let trial=0;trial<64;trial++){const w=1+next()%17,h=1+next()%13,bytes=Uint8Array.from({length:w*h},()=>next()>>>24),raw=bitmap(bytes,w,h,{feather:[0,.1,1,2.75,100][trial%5],invert:!!(trial%2)}),reference=maskCoverage(raw),actual=await prepareBitmapCoverage(raw),scope=mask(w,h,raw,{density:.1}),rawBytes=await prepareFilterMaskBytes(scope,{raw:true}),effective=await prepareFilterMaskBytes(scope);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const m=Math.round(255*reference(x,y));assert.equal(actual(x,y),reference(x,y));assert.equal(rawBytes(x,y),m);assert.equal(effective(x,y),densityByte(.1,m));}
  }
  const w=8192,h=32,runs=[];for(let i=0;i<w*h;i+=2)runs.push(i,1,137);let ticked=false;
  const pending=prepareBitmapCoverage({shape:'bitmap',width:w,height:h,runs,feather:0,invert:false});setImmediate(()=>{ticked=true;});const coverage=await pending;assert.equal(ticked,true);assert.equal(coverage(0,0),137/255);assert.equal(coverage(1,0),0);
});

test('exact capture remembers every clipped source domain and admits polygon CPU separately from pixels',async()=>{
  const source={width:4,height:1,transforms:[{type:'crop',x:1,y:0,width:2,height:1},{type:'canvas',x:1,y:0,width:4,height:1}]},g={width:4,height:1,selection:{shape:'rectangle',x:0,y:0,width:4,height:1,feather:0,invert:false}};
  const captured=await captureFilterMask(source,g);assert.deepEqual(captured.runs,[1,2,255]);assert.equal(planFilterMaskCapture(source,g).sampledPixels,2);
  for(const transform of [{type:'resize',width:4,height:1},{type:'resample',width:4,height:1,kernel:'nearest'},{type:'affine',width:4,height:1,x:.5,y:0,scaleX:1,scaleY:1,rotation:0},{type:'affine',width:4,height:1,x:0,y:0,scaleX:1,scaleY:1,rotation:0,flipX:true}])assert.throws(()=>planFilterMaskCapture({...source,transforms:[transform]},g),{code:'FILTER_MASK_CAPTURE_GEOMETRY'});
  let seed=0xa7b39;const next=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
  for(let trial=0;trial<80;trial++){
    const sw=1+next()%9,sh=1+next()%7;let w=sw,h=sh;const transforms=[];
    for(let j=0;j<4;j++){const type=next()%3,crop=type===0,affine=type===2,nw=crop?1+next()%w:affine?w:1+next()%11,nh=crop?1+next()%h:affine?h:1+next()%9;transforms.push({type:crop?'crop':affine?'affine':'canvas',width:nw,height:nh,x:crop?next()%(w-nw+1):next()%13-6,y:crop?next()%(h-nh+1):next()%11-5,...(affine?{scaleX:1,scaleY:1,rotation:0,flipX:false,flipY:false}:{})});w=nw;h=nh;}
    const bytes=Uint8Array.from({length:w*h},()=>next()>>>24),selection=bitmap(bytes,w,h,{invert:!!(trial%2)}),result=maskCoverage(await captureFilterMask({width:sw,height:sh,transforms},{width:w,height:h,selection}));
    for(let sy=0;sy<sh;sy++)for(let sx=0;sx<sw;sx++){let x=sx,y=sy,alive=true;for(const tr of transforms){x+=tr.type==='crop'?-tr.x:tr.x;y+=tr.type==='crop'?-tr.y:tr.y;if(x<0||y<0||x>=tr.width||y>=tr.height){alive=false;break;}}const expected=alive?(selection.invert?255-bytes[y*w+x]:bytes[y*w+x]):0;assert.equal(Math.round(255*result(sx,sy)),expected);}
  }
  const polygon=(w,h)=>({shape:'polygon',points:Array.from({length:256},(_,i)=>({x:(i+.5)*w/256,y:i%2?h:0})),feather:1_000_000,invert:false});
  const layer={width:1024,height:717,transforms:[]},large={width:1024,height:717,selection:polygon(1024,717)},estimate=estimateFilterMaskCapture({layer,graph:large});
  assert.equal(estimate.captureWork,1024*717*(1+8+512)+717*256*10);assert.ok(estimate.captureWork>384_000_000);await assert.rejects(captureFilterMask(layer,large),{code:'LIMIT_EXCEEDED'});
  const thin={width:1,height:717,transforms:[{type:'canvas',width:1024,height:717,x:0,y:0}]},thinEstimate=estimateFilterMaskCapture({layer:thin,graph:large});assert.equal(thinEstimate.captureWork,717*(1+8+512)+717*256*10);
  const bitmapHuge={width:6000,height:4000,selection:{shape:'bitmap',width:6000,height:4000,x:0,y:0,runs:[],feather:1,invert:false}};await assert.rejects(captureFilterMask({width:6000,height:4000,transforms:[]},bitmapHuge),{code:'LIMIT_EXCEEDED'});
});

test('persisted wrappers project to public arrays and every source-edit guard still sees disabled masked entries',async t=>{
  const{native}=await fixture(t),w=7,h=5,input=image(w,h,(x,y,i)=>[x*35,y*51,199,[0,1,128,255][i%4]]),entry=filter('invert',{enabled:false}),source=await raster(native,input,w,h,{filters:[entry],alphaAsset:await native.storeAlpha(Buffer.alloc(w*h,128),w,h)});
  let doc=await project(native,w,h,[source],{selection:{shape:'rectangle',x:0,y:0,width:w,height:h}});
  const legacy=layerOf(native,doc,source.id);await get(native,doc);assert.deepEqual(layerOf(native,doc,source.id),legacy);
  doc=(await noPixels(native,()=>edit(native,doc,'set_layer_filter_mask',{layerId:source.id,source:'none'}))).document;
  doc=(await noPixels(native,()=>edit(native,doc,'modify_layer_filter_mask',{layerId:source.id,enabled:false,density:0}))).document;
  assert.deepEqual(doc.layers[0].filters,[entry]);assert.equal(doc.layers[0].filterMask.enabled,false);assert.equal(layerOf(native,doc,source.id).filters.version,1);assert.equal(Object.hasOwn(layerOf(native,doc,source.id),'filterMask'),false);
  const cases=[['fill_area',{color:'#ff0000'}],['extract_subject',{}],['paint_cutout_mask',{mode:'remove',points:[{x:2,y:2}],size:3}],['refine_cutout_from_selection',{mode:'intersect'}],...['brush','clone','heal'].map(tool=>['paint_stroke',{tool,points:[{x:2,y:2,pressure:1}],size:3,color:'#ff0000',source:{x:0,y:0}}]),['place_layer',{sourceDocumentId:doc.id,sourceExpectedRevision:doc.revision,sourceLayerId:source.id,x:0,y:0,width:w,height:h}]];
  for(const[command,args]of cases)await noPixels(native,()=>assert.rejects(edit(native,doc,command,{layerId:source.id,...args}),{code:'FILTER_STACK_ACTIVE'}));
  const loaded=await native.execute('load_layer_selection',{documentId:doc.id,expectedRevision:doc.revision,layerId:source.id,source:'content'});doc=loaded.document;
  const coverage=maskCoverage(graph(native,doc).selection);for(let i=0;i<w*h;i++)assert.equal(Math.round(coverage(i%w,Math.floor(i/w))*255),Math.round(input[4*i+3]*128/255));
  const savedMask=structuredClone(doc.layers[0].filterMask);doc=(await noPixels(native,()=>edit(native,doc,'add_layer_filter',{layerId:source.id,kind:'invert',value:100}))).document;
  assert.deepEqual(doc.layers[0].filterMask,savedMask);const added=doc.layers[0].filters[1];doc=(await edit(native,doc,'reorder_layer_filter',{layerId:source.id,filterId:added.id,index:0})).document;assert.deepEqual(doc.layers[0].filterMask,savedMask);
  doc=(await edit(native,doc,'clear_layer_filter_mask',{layerId:source.id})).document;assert.equal(doc.layers[0].filterMask,undefined);assert.deepEqual(layerOf(native,doc,source.id).filters,[added,entry]);
  doc=(await edit(native,doc,'set_layer_filter_mask',{layerId:source.id,source:'all'})).document;doc=(await edit(native,doc,'delete_layer_filter',{layerId:source.id,filterId:added.id})).document;assert.ok(doc.layers[0].filterMask);
  doc=(await edit(native,doc,'delete_layer_filter',{layerId:source.id,filterId:entry.id})).document;assert.deepEqual(layerOf(native,doc,source.id).filters,[]);assert.equal(doc.layers[0].filterMask,undefined);
});

test('source-framed raw and effective inspection never reads corrupt RGB or alpha assets and leaves storage untouched',async t=>{
  const{native}=await fixture(t),w=64,h=3,bytes=Uint8Array.from({length:w*h},(_,i)=>i*37%256),scope=mask(w,h,bitmap(bytes,w,h,{invert:true}),{density:.1}),source=base({type:'raster',width:w,height:h,asset:'a'.repeat(64),sourceAsset:'a'.repeat(64),alphaAsset:'b'.repeat(64),transforms:[{type:'crop',x:11,y:0,width:5,height:h}],filters:wrap([filter()],scope)});
  let doc=await project(native,5,h,[source]);const before=await files(native.projectsDir),assets=await files(native.assetsDir),cache=native.previewCache.stats();
  for(const mode of ['raw','effective']){const result=await noPixels(native,()=>edit(native,doc,'get_mask_preview',{source:'filter-mask',layerId:source.id,maskMode:mode,maxEdge:32}),true);assert.equal(result.coordinates,'source');assert.deepEqual([result.sourceWidth,result.sourceHeight,result.width,result.height],[64,3,32,2]);const pixels=await decode(Buffer.from(result.data,'base64'));
    for(let y=0;y<2;y++)for(let x=0;x<32;x++){const raw=255-bytes[[0,2][y]*64+2*x+1],e=mode==='raw'?raw:densityByte(.1,raw),at=4*(y*32+x);assert.deepEqual([...pixels.subarray(at,at+4)],[e,e,e,255]);}}
  assert.deepEqual(await files(native.projectsDir),before);assert.deepEqual(await files(native.assetsDir),assets);assert.deepEqual(native.previewCache.stats(),cache);
  doc=(await noPixels(native,()=>edit(native,doc,'modify_layer_filter_mask',{layerId:source.id,enabled:false}))).document;
  const result=await noPixels(native,()=>edit(native,doc,'get_mask_preview',{source:'filter-mask',layerId:source.id,maskMode:'effective',maxEdge:32}),true);assert.ok((await decode(Buffer.from(result.data,'base64'))).every(value=>value===255));
});

test('mask activation and feather phases reject before pixel access across full-source, graph and Bake budgets',async t=>{
  const{native,dataDir}=await fixture(t),hash='a'.repeat(64),large=base({type:'raster',width:6000,height:4000,asset:hash,sourceAsset:hash,transforms:[],filters:wrap([filter()],mask(6000,4000,undefined,{enabled:false}))});
  const largeDoc=await project(native,6000,4000,[large]);assert.equal(estimateFilterMaskSourceBytes({width:6000,height:4000,stack:{...large.filters,mask:{...large.filters.mask,enabled:true}}}).estimatedWorkingBytes,288_000_000);
  for(const args of [{enabled:true},{enabled:true,density:Number.MIN_VALUE}])await noPixels(native,()=>assert.rejects(edit(native,largeDoc,'modify_layer_filter_mask',{layerId:large.id,...args}),{code:'LIMIT_EXCEEDED'}));
  const d0=(await noPixels(native,()=>edit(native,largeDoc,'modify_layer_filter_mask',{layerId:large.id,enabled:true,density:0}))).document;await noPixels(native,()=>assert.rejects(edit(native,d0,'set_layer_filter_mask',{layerId:large.id,source:'all'}),{code:'LIMIT_EXCEEDED'}));
  const w=8192,h=64,s=w*h,outer=base({type:'group',mode:'isolated',opacity:.5}),inner=base({type:'group',mode:'isolated',parentId:outer.id,opacity:.5}),content=base({type:'raster',width:w,height:h,asset:hash,sourceAsset:hash,transforms:[],parentId:inner.id,filters:wrap([filter()],mask(w,h,bitmap([],w,h),{density:.5}))}),member=base({type:'solid',width:w,height:h,color:'#ffffff',transforms:[],parentId:inner.id,clipBaseId:content.id});
  const retained=(width,height)=>base({type:'solid',width:w,height:h,color:'#ffffff',transforms:[],visible:false,mask:{shape:'positioned',sourceWidth:width,sourceHeight:height,x:0,y:0,source:{shape:'bitmap',x:0,y:0,width,height,runs:[],feather:0,invert:false}}});
  const noise=base({type:'raster',width:1,height:1,asset:hash,sourceAsset:hash,transforms:[{type:'resize',width:w,height:h}],filters:[filter('add_noise',{value:0,parameters:{distribution:'gaussian'}})]}),layers=[noise,outer,inner,content,member,...Array.from({length:5},()=>retained(6000,4000)),retained(3850,2000)],g={width:w,height:h,selection:null,layers};
  assert.equal(validateLayerFilterResources(g,layerTree(layers)).estimatedScratchBytes,24*s+2*127_700_000+4096);
  const doc=await project(native,w,h,layers);for(const command of ['modify_layer_filter_mask','apply_transaction'])await noPixels(native,()=>assert.rejects(edit(native,doc,command,command==='apply_transaction'?{operations:[{command:'modify_layer_filter_mask',args:{layerId:content.id,feather:1}},{command:'rasterize_layer',args:{layerId:noise.id}}]}:{layerId:content.id,feather:1}),{code:'LIMIT_EXCEEDED'}));assert.deepEqual(await get(native,doc),doc);assert.deepEqual(await fs.readdir(native.assetsDir),[]);
  const bh=1821,bs=w*bh,bakeStack=wrap([filter()],mask(w,bh,bitmap([],w,bh,{feather:1}),{density:.5})),estimate=estimateFilterBakeBytes({width:w,height:bh,hasAlpha:true,filters:bakeStack});assert.equal(estimate.maskBytes,18*bs+256);assert.ok(estimate.filterBytes<estimate.maxWorkingBytes&&estimate.maskBytes>estimate.maxWorkingBytes);
  const tiny=await raster(native,Buffer.from([20,80,170,255]),1,1),layer={...tiny,width:w,height:bh,alphaAsset:tiny.asset,filters:bakeStack};await assert.rejects(bakeFilterSource({layer,filters:bakeStack,assetsDir:native.assetsDir,tempRoot:dataDir}),{code:'LIMIT_EXCEEDED'});assert.equal((await fs.readdir(dataDir)).some(name=>name.startsWith('.filter-bake-')),false);
});

test('whole-stack source mixing survives cutout alpha, positioned masks, isolated clipping and exact Bake',async t=>{
  const{native}=await fixture(t),w=9,h=7,input=image(w,h,(x,y,i)=>[x*29,y*37,i*53%256,[0,1,128,255][i%4]]),alpha=Buffer.from(Array.from({length:w*h},(_,i)=>[255,1,128,197,0][i%5])),raw=Uint8Array.from({length:w*h},(_,i)=>i*79%256),scope=mask(w,h,bitmap(raw,w,h,{invert:true}),{density:.1});
  const entries=[filter('high_pass',{value:0,opacity:.625}),filter('invert',{opacity:.37,blendMode:'multiply'})],effective=Buffer.from(input),full=Buffer.from(input);
  for(let i=0;i<alpha.length;i++){effective[4*i+3]=Number((2n*BigInt(input[4*i+3])*BigInt(alpha[i])+255n)/510n);full[4*i+3]=effective[4*i+3];if(full[4*i+3])for(let c=0;c<3;c++){const b=Math.round(input[4*i+c]+(128-input[4*i+c])*.625),f=255-b,[p,q]=fraction(.37),n=BigInt(b)*255n*q+(BigInt(b*f)-BigInt(b)*255n)*p;full[4*i+c]=Number((2n*n+255n*q)/(510n*q));}}
  const expected=mixedImage(effective,full,raw.map(v=>255-v),scope),group=base({type:'group',mode:'isolated',blendMode:'screen',opacity:.7,mask:{x:1,y:0,width:7,height:6},maskDensity:.4});
  const content=await raster(native,input,w,h,{parentId:group.id,filters:wrap(entries,scope),alphaAsset:await native.storeAlpha(alpha,w,h),transforms:[{type:'affine',width:w,height:h,x:.4,y:-.3,scaleX:1.1,scaleY:.9,rotation:17,flipX:false,flipY:false}],mask:{shape:'positioned',sourceWidth:w,sourceHeight:h,x:1,y:-1,source:{shape:'ellipse',x:1,y:1,width:5,height:4,feather:1.2,invert:true}},maskDensity:.5});
  assert.deepEqual(await native.renderLayer({...content,transforms:[]}),expected);
  const member=base({type:'solid',width:w,height:h,color:'#7d4ac1',transforms:[],parentId:group.id,clipBaseId:content.id,opacity:.43}),protectedTop=await raster(native,image(w,h,(x,y)=>[177,123,81,x>6&&y>4?255:0]),w,h,{protected:true});
  let doc=await project(native,w,h,[base({type:'solid',width:w,height:h,transforms:[],color:'#aabbcc'}),group,content,member,protectedTop],{selection:{shape:'rectangle',x:2,y:2,width:2,height:2}});const before=await native.renderGraph(graph(native,doc)),assets=await files(native.assetsDir);
  doc=(await edit(native,doc,'bake_layer_filters',{layerId:content.id})).document;const baked=layerOf(native,doc,content.id),stored=await decode(await fs.readFile(path.join(native.assetsDir,baked.asset)));for(let i=0;i<alpha.length;i++)expected[4*i+3]=input[4*i+3];assert.deepEqual(stored,expected);assert.deepEqual(await native.renderGraph(graph(native,doc)),before);assert.deepEqual(baked.filters,[]);assert.equal(doc.layers.find(l=>l.id===content.id).filterMask,undefined);
  for(const key of Object.keys(content).filter(k=>!['asset','filters'].includes(k)))assert.deepEqual(baked[key],content[key]);for(const[name,data]of Object.entries(assets))assert.deepEqual(await fs.readFile(path.join(native.assetsDir,name)),data);
});

test('black or disabled effect masks cannot bypass protected original context, generated clipping or Bake guards',async t=>{
  const{native}=await fixture(t),w=9,h=7,person=await raster(native,image(w,h,(x,y)=>[188,127,81,x<3&&y>1?[1,128,255][x]:0]),w,h,{protected:true}),original=image(w,h,(x,y)=>[x%2?220:20,y*35,150,255]),scope=mask(w,h,bitmap(Uint8Array.from({length:w*h},(_,i)=>i*53%256),w,h),{density:.5});
  const group=base({type:'group',mode:'isolated',opacity:.6}),content=await raster(native,original,w,h,{parentId:group.id,filters:wrap([filter()],scope)}),generated=await raster(native,image(w,h,[33,88,199,173]),w,h,{parentId:group.id,clipBaseId:content.id,role:'generated',provenance:{jobId:randomUUID(),mode:'generate'},filters:wrap([filter('high_pass',{value:0})],scope)});
  const doc=await project(native,w,h,[person,group,content,generated]),g=graph(native,doc),footprint=await native.protectedPixels(g,{beforeLayerId:content.id}),altered=await native.renderLayer(content,{protectedPixels:footprint});let changed=0,restored=0;
  for(let i=0;i<w*h;i++)if(footprint[i]){assert.deepEqual(altered.subarray(4*i,4*i+3),original.subarray(4*i,4*i+3));restored++;}else if(!altered.subarray(4*i,4*i+3).equals(original.subarray(4*i,4*i+3)))changed++;assert.ok(restored&&changed);
  const actual=await native.renderGraph(g),control=await native.renderGraph({...g,layers:g.layers.filter(l=>l.id!==generated.id).map(l=>l.id===content.id?{...l,filters:[]}:l)});for(let i=0;i<w*h;i++)if(footprint[i])assert.deepEqual(actual.subarray(4*i,4*i+4),control.subarray(4*i,4*i+4));
  const preview=await native.execute('get_layer_preview',{documentId:doc.id,layerId:generated.id,view:'layer',maxWidth:32}),rgba=await decode(Buffer.from(preview.data,'base64'));for(let i=0;i<w*h;i++)if(footprint[i])assert.equal(rgba[4*i+3],0);
  for(const coverage of [mask(w,h,bitmap(new Uint8Array(w*h),w,h)),{...scope,enabled:false}]){const hidden=await project(native,w,h,[{...person,visible:false},{...content,parentId:undefined,filters:wrap([filter()],coverage)}]);await noPixels(native,()=>assert.rejects(edit(native,hidden,'bake_layer_filters',{layerId:content.id}),{code:'FILTER_BAKE_PROTECTED_CONTEXT'}));await noPixels(native,()=>assert.rejects(edit(native,hidden,'set_layer_protection',{layerId:content.id,protected:true}),{code:'PROTECTED_LAYER'}));}
  const protectedDoc=await project(native,w,h,[{...content,parentId:undefined,protected:true,filters:wrap([filter('invert',{enabled:false})],scope)}]);await noPixels(native,()=>assert.rejects(edit(native,protectedDoc,'modify_layer_filter_mask',{layerId:content.id,enabled:false}),{code:'PROTECTED_LAYER'}));
});

test('masked recipe budgets validate cumulatively without I/O and malformed portable wrappers reject before asset access',async t=>{
  const{native}=await fixture(t),w=2000,h=1500,scope=mask(w,h),source=base({type:'raster',width:w,height:h,asset:'a'.repeat(64),sourceAsset:'a'.repeat(64),transforms:[],visible:false,filters:wrap([filter()],scope)});let doc=await project(native,w,h,[source]);
  const definition={name:'Cumulative grade',slots:[{key:'photo',type:'raster'}],steps:Array.from({length:3},()=>({command:'add_layer_filter',target:'photo',args:{kind:'color_balance',value:0}}))};const saved=await noPixels(native,()=>edit(native,doc,'save_edit_recipe',definition));doc=saved.document;const args={recipeId:saved.recipeId,bindings:{photo:source.id}},report=await noPixels(native,()=>edit(native,doc,'validate_edit_recipe',args),true);assert.equal(report.valid,false);assert.equal(report.issues[0].stepIndex,2);assert.equal(report.issues[0].code,'LIMIT_EXCEEDED');await noPixels(native,()=>assert.rejects(edit(native,doc,'apply_edit_recipe',args),{code:'LIMIT_EXCEEDED'}));assert.deepEqual(await get(native,doc),doc);
  const valid=await noPixels(native,()=>edit(native,doc,'save_edit_recipe',{...definition,steps:[definition.steps[0]]}));doc=valid.document;const validArgs={recipeId:valid.recipeId,bindings:args.bindings};assert.equal((await noPixels(native,()=>edit(native,doc,'validate_edit_recipe',validArgs),true)).valid,true);doc=(await noPixels(native,()=>edit(native,doc,'apply_edit_recipe',validArgs))).document;assert.deepEqual(layerOf(native,doc,source.id).filters.mask,scope);assert.equal(doc.layers[0].filters.length,2);assert.deepEqual(await fs.readdir(native.assetsDir),[]);
  const rasterLayer=await raster(native,image(3,2,[33,88,199,255]),3,2),entries=[filter('invert',{enabled:false})],good=mask(3,2),asset=await fs.readFile(path.join(native.assetsDir,rasterLayer.asset)),badMasks=[null,undefined,{...good,sourceWidth:2},{...good,density:null},{...good,density:1.001},{...good,enabled:1},{sourceWidth:3,sourceHeight:2,coverage:good.coverage,density:0},...[
    {...good.coverage,clip:good.coverage},{...good.coverage,density:0},{...good.coverage,shape:'polygon',points:[{x:0,y:0},{x:1,y:0},{x:0,y:1}]},bitmap([1,2,3,4,5,6],2,3),{shape:'bitmap',width:3,height:2,runs:[0,7,255]}, {...good.coverage,x:.5}, {...good.coverage,feather:101}, {...good.coverage,feather:null}
  ].map(coverage=>({...good,enabled:false,density:0,coverage}))];
  assert.throws(()=>filterEntries(wrap(entries,undefined)));const stacks=[...badMasks.filter(scope=>scope!==undefined).map(scope=>wrap(entries,scope)),{version:1,entries},{...wrap(entries,good),version:2},wrap([],good),{...wrap(entries,good),extra:1}];
  const control={name:'Valid masked stack',width:3,height:2,selection:null,layers:[{...rasterLayer,filters:wrap(entries,good)}]},bundle=await encodeProjectBundle({graph:control,validateGraph:g=>native.validateGraph(g),readAsset:async()=>asset});
  const manifestSize=bundle.readUInt32BE(8),manifest=JSON.parse(bundle.subarray(12,12+manifestSize));
  const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
  const forged=g=>{const metadata=Buffer.from(JSON.stringify(canonical({...manifest,graph:g}))),header=Buffer.from(bundle.subarray(0,12));header.writeUInt32BE(metadata.length,8);return Buffer.concat([header,metadata,bundle.subarray(12+manifestSize)]);};
  assert.deepEqual(decodeProjectBundle(forged(control),{validateGraph:g=>native.validateGraph(g)}).graph,control,'Canonical replacement preserves a valid control and its original valid asset.');
  for(const stack of stacks){const g={...control,name:'Malformed masked stack',layers:[{...rasterLayer,filters:stack}]};await noPixels(native,()=>assert.rejects(native.importProject({data:forged(g)}),{code:'INVALID_PROJECT_BUNDLE'}),true);}
  for(const filters of [entries,wrap(entries,good)]){const g={...control,name:'Invalid public projection',layers:[{...rasterLayer,filters,filterMask:good}]};await noPixels(native,()=>assert.rejects(native.importProject({data:forged(g)}),{code:'INVALID_PROJECT_BUNDLE'}),true);}
});

test('real persistence and late mixed-transaction failures preserve masked history and remove newly owned working assets',async t=>{
  const{native}=await fixture(t),w=9,h=7,scope=mask(w,h,bitmap(Uint8Array.from({length:w*h},(_,i)=>i*41%256),w,h),{density:.37}),source=await raster(native,image(w,h,(x,y)=>[x*29,y*37,128,255]),w,h,{filters:wrap([filter()],scope)}),doc=await project(native,w,h,[source]);await native.execute('get_preview',{documentId:doc.id,maxWidth:32});
  const assets=await files(native.assetsDir),projects=await files(native.projectsDir),cache=native.previewCache.stats(),directory=native.projectsDir;native.projectsDir=path.join(native.assetsDir,source.asset);
  try{await assert.rejects(edit(native,doc,'modify_layer_filter_mask',{layerId:source.id,density:.1}),{code:'ENOTDIR'});await assert.rejects(edit(native,doc,'bake_layer_filters',{layerId:source.id}),{code:'ENOTDIR'});}finally{native.projectsDir=directory;}
  await assert.rejects(edit(native,doc,'apply_transaction',{operations:[{command:'modify_layer_filter_mask',args:{layerId:source.id,feather:1}},{command:'bake_layer_filters',args:{layerId:source.id}},{command:'paint_stroke',args:{layerId:source.id,tool:'brush',points:[{x:3,y:3,pressure:1}],size:3,hardness:1,opacity:1,color:'#ff0000'}},{command:'set_layer',args:{layerId:randomUUID(),visible:false}}]}),{code:'NOT_FOUND'});
  assert.deepEqual(await get(native,doc),doc);assert.deepEqual(layerOf(native,doc,source.id).filters,source.filters);assert.deepEqual(await files(native.assetsDir),assets);assert.deepEqual(await files(native.projectsDir),projects);assert.deepEqual(native.previewCache.stats(),cache);
});
