import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { adjustmentTransform } from '../server/color.mjs';
import { spatialAdjustment } from '../server/adjustment-filters.mjs';
import { NativeBackend } from '../server/native.mjs';
import { validateCommand } from '../shared/commands.mjs';

test('new color transforms have defined endpoints and quantization', () => {
  const transform = (kind, value, rgb) => adjustmentTransform({kind,value})(...rgb);
  assert.deepEqual(transform('invert',100,[15,80,225]),[240,175,30]);
  assert.deepEqual(transform('invert',100,transform('invert',100,[15,80,225])),[15,80,225]);
  for (const kind of ['invert','grayscale','sepia']) assert.deepEqual(transform(kind,0,[25,100,210]),[25,100,210]);
  assert.deepEqual(transform('grayscale',100,[255,0,0]),[54,54,54]);
  assert.deepEqual(transform('sepia',100,[255,255,255]),[255,255,239]);
  assert.deepEqual(transform('posterize',4,[40,127,220]),[0,85,255]);
  for (let tone=0;tone<256;tone++) assert.deepEqual(transform('posterize',256,[tone,tone,tone]),[tone,tone,tone]);
  assert.deepEqual(transform('threshold',0,[0,0,0]),[255,255,255]);
  assert.deepEqual(transform('threshold',255,[254,254,254]),[0,0,0]);
  assert.deepEqual(transform('threshold',255,[255,255,255]),[255,255,255]);
});

test('mosaic uses alpha-weighted tiles and preserves transparent RGB and input bytes', async () => {
  const input = Buffer.from([255,0,0,255, 0,0,255,255, 1,2,3,128, 0,255,0,0, 255,0,255,0, 10,20,30,0]);
  const before=Buffer.from(input);
  const output=await spatialAdjustment(input,3,2,{kind:'mosaic',value:2});
  assert.deepEqual([...output.subarray(0,8)],[128,0,128,255,128,0,128,255]);
  assert.deepEqual(output.subarray(8,12),input.subarray(8,12));
  assert.deepEqual(output.subarray(12),input.subarray(12));
  assert.deepEqual(input,before);
  assert.deepEqual(await spatialAdjustment(input,3,2,{kind:'mosaic',value:1}),input);
});

test('median removes an isolated impulse while retaining original alpha and validating work bounds', async () => {
  const input=Buffer.alloc(5*5*4);
  for(let i=0;i<25;i++)input.set([100,80,60,i===12?128:255],i*4);
  input.set([255,255,255,128],12*4);
  const before=Buffer.from(input),output=await spatialAdjustment(input,5,5,{kind:'median',value:3});
  assert.deepEqual([...output.subarray(48,52)],[100,80,60,128]);
  assert.deepEqual(input,before);
  for(let i=3;i<input.length;i+=4)assert.equal(output[i],input[i]);
  await assert.rejects(spatialAdjustment(input,5,5,{kind:'median',value:4}),{code:'INVALID_ARGUMENT'});
  await assert.rejects(spatialAdjustment(input,5,5,{kind:'mosaic',value:129}),{code:'INVALID_ARGUMENT'});
});

test('new adjustment schemas allow full useful ranges and reject fractional/even kernel settings', () => {
  const documentId='example';
  for(const [kind,value] of [['posterize',256],['threshold',255],['threshold',0],['median',15],['mosaic',128]])assert.equal(validateCommand('add_adjustment',{documentId,kind,value}).value,value);
  for(const [kind,value] of [['posterize',1],['posterize',3.5],['threshold',-1],['median',2],['median',17],['mosaic',1.1],['invert',101]])assert.throws(()=>validateCommand('add_adjustment',{documentId,kind,value}),{code:'INVALID_ARGUMENTS'});
});

test('median ignores hidden RGB and weights soft samples without creating transparent-edge halos', async () => {
  const input=Buffer.alloc(5*5*4);
  for(let i=0;i<25;i++)input.set([255,0,0,0],i*4);
  input.set([0,0,255,255],12*4);
  input.set([255,0,0,1],11*4);
  const result=await spatialAdjustment(input,5,5,{kind:'median',value:3});
  assert.deepEqual([...result.subarray(48,52)],[0,0,255,255]);
  assert.deepEqual([...result.subarray(44,48)],[0,0,255,1]);
  for(let i=0;i<25;i++)if(!input[i*4+3])assert.deepEqual(result.subarray(i*4,i*4+4),input.subarray(i*4,i*4+4));
});

test('all seven native adjustments preserve unselected pixels, source files, alpha, undo and reopening', async t => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'prism-extended-adjustments-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const rgba=Buffer.alloc(8*8*4);
  for(let i=0;i<64;i++)rgba.set([i%2?220:15,(i*11)%256,180-i,i===12?128:255],i*4);
  const original=await sharp(rgba,{raw:{width:8,height:8,channels:4}}).png().toBuffer();
  const native=await new NativeBackend({dataDir:directory}).init();
  let document=(await native.execute('import_image',{name:'Filter source',mimeType:'image/png',data:original.toString('base64')})).document;
  const source=document.layers[0],baseline=await native.render(native.project(document.id));
  for(const [kind,value] of [['invert',100],['grayscale',100],['sepia',100],['posterize',3],['threshold',0],['median',3],['mosaic',4]]){
    document=(await native.execute('add_adjustment',{documentId:document.id,expectedRevision:document.revision,kind,value,mask:{x:2,y:2,width:4,height:4}})).document;
    const actual=await native.render(native.project(document.id));let changed=0;
    for(let y=0;y<8;y++)for(let x=0;x<8;x++){
      const i=(y*8+x)*4;
      assert.equal(actual[i+3],baseline[i+3]);
      if(x<2||x>=6||y<2||y>=6)assert.deepEqual(actual.subarray(i,i+4),baseline.subarray(i,i+4));
      else if(!actual.subarray(i,i+3).equals(baseline.subarray(i,i+3)))changed++;
    }
    assert.ok(changed>0,`${kind} must actually change selected pixels.`);
    const reopened=await new NativeBackend({dataDir:directory}).init();
    assert.deepEqual(await reopened.render(reopened.project(document.id)),actual);
    document=(await native.execute('undo',{documentId:document.id,expectedRevision:document.revision})).document;
    assert.deepEqual(await native.render(native.project(document.id)),baseline);
  }
  assert.deepEqual(await fs.readFile(path.join(directory,'assets',source.sourceAsset)),original);
  document=(await native.execute('set_layer_protection',{documentId:document.id,layerId:source.id,protected:true})).document;
  for(const [kind,value] of [['invert',100],['grayscale',100],['sepia',100],['posterize',2],['threshold',0],['median',3],['mosaic',8]]){
    document=(await native.execute('add_adjustment',{documentId:document.id,kind,value})).document;
    assert.deepEqual(await native.render(native.project(document.id)),baseline,`${kind} must not change protected content.`);
  }
});
