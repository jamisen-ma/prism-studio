import test from 'node:test';
import assert from 'node:assert/strict';
import {selectColor,fillPixels,sampleColor,paintSelection} from '../server/raster-ops.mjs';
import {maskCoverage,normalizeMask,transformMask,bitmapBytes} from '../server/masks.mjs';
const pixels=()=>Buffer.from([255,0,0,255,0,0,255,255,255,0,0,255,255,0,0,255,0,0,255,255,255,0,0,255]);
test('magic wand isolates connected pixels; noncontiguous mode selects separated matches',()=>{
  const original=pixels(),args={pixels:original,width:3,height:2,x:0,y:0,tolerance:0};
  const region=selectColor(args);assert.deepEqual([...bitmapBytes(region)],[255,0,0,255,0,0]);
  assert.deepEqual([...bitmapBytes(selectColor({...args,contiguous:false}))],[255,0,255,255,0,255]);
  assert.deepEqual(original,pixels());assert.deepEqual(normalizeMask(region,3,2,{persisted:true}),region);
});
test('flood matching handles invisible colors and tolerance boundaries',()=>{
  const input=Buffer.from([10,10,10,0,250,250,250,0,10,10,10,255]);
  assert.deepEqual([...bitmapBytes(selectColor({pixels:input,width:3,height:1,x:0,y:0,tolerance:0}))],[255,255,0]);
  assert.throws(()=>selectColor({pixels:input,width:3,height:1,x:3,y:0}));
});
test('fill and erase alter only selected pixels with correct alpha compositing',()=>{
  const input=pixels(),coverage=maskCoverage(selectColor({pixels:input,width:3,height:2,x:0,y:0,tolerance:0}));
  const out=fillPixels({pixels:input,width:3,height:2,color:'#00ff00',opacity:.5,coverage});
  assert.deepEqual([...out.subarray(0,4)],[128,128,0,255]);assert.deepEqual(out.subarray(4,12),input.subarray(4,12));
  const erased=fillPixels({pixels:input,width:3,height:2,erase:true,opacity:.5,coverage});assert.equal(erased[3],128);assert.equal(erased[7],255);assert.deepEqual(input,pixels());
});
test('bitmap mask crop resize invert and feather are real and persisted',()=>{
  const region=selectColor({pixels:pixels(),width:3,height:2,x:0,y:0,tolerance:0});
  const crop=transformMask(region,{type:'crop',x:0,y:0,width:2,height:2},3,2);assert.deepEqual([...bitmapBytes(crop)],[255,0,255,0]);
  const resized=transformMask(crop,{type:'resize',width:4,height:2},2,2);assert.deepEqual([...bitmapBytes(resized)],[255,255,0,0,255,255,0,0]);
  assert.equal(maskCoverage({...crop,invert:true})(0,0),0);assert.equal(maskCoverage({...crop,invert:true})(1,0),1);
  assert.ok(maskCoverage({...crop,feather:2})(0,0)>0);assert.ok(maskCoverage({...crop,feather:2})(0,0)<1);assert.equal(maskCoverage({...crop,feather:2})(1,0),0);
  assert.throws(()=>normalizeMask({...crop,runs:[0,10,255]},2,2));
});
test('eyedropper returns alpha-weighted average and never changes input',()=>{
  const input=Buffer.from([255,0,0,255,0,255,0,0]);
  assert.deepEqual(sampleColor({pixels:input,width:2,height:1,x:0,y:0,radius:1}),{x:0,y:0,radius:1,red:255,green:0,blue:0,alpha:128,hex:'#ff0000'});
});
test('selection brush adds subtracts and replaces actual coverage',()=>{
  const args={width:20,height:20,points:[{x:5,y:5}],size:6,hardness:1,opacity:1};
  const first=paintSelection(args);assert.equal(maskCoverage(first)(5,5),1);assert.equal(maskCoverage(first)(15,15),0);
  const both=paintSelection({...args,selection:first,points:[{x:15,y:15}]});assert.equal(maskCoverage(both)(5,5),1);assert.equal(maskCoverage(both)(15,15),1);
  const sub=paintSelection({...args,selection:both,mode:'subtract'});assert.equal(maskCoverage(sub)(5,5),0);assert.equal(maskCoverage(sub)(15,15),1);
  const replacement=paintSelection({...args,selection:both,mode:'replace'});assert.equal(maskCoverage(replacement)(15,15),0);
});
