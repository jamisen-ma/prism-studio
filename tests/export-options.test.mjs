import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { validateCommand } from '../shared/commands.mjs';

async function fixture(t) {
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'prism-export-options-'));
  t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  const width=24,height=16,rgba=Buffer.alloc(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)rgba.set([x*10,y*15,(x*7+y*11)%256,x<8?0:x<16?128:255],(y*width+x)*4);
  const original=await sharp(rgba,{raw:{width,height,channels:4}}).png().toBuffer();
  const native=await new NativeBackend({dataDir}).init();
  const document=(await native.execute('import_image',{name:'Export options',mimeType:'image/png',data:original.toString('base64')})).document;
  return{native,document,dataDir,original,width,height,rendered:await native.render(native.project(document.id))};
}

test('TIFF and PNG exports preserve rendered RGBA, sRGB profile and density without changing the project',async t=>{
  const{native,document,dataDir,original,width,height,rendered}=await fixture(t);
  const before=await fs.readFile(path.join(dataDir,'projects',`${document.id}.json`));
  for(const format of ['tiff','png']){
    const result=await native.execute('export_document',{documentId:document.id,format,density:300});
    const bytes=Buffer.from(result.data,'base64'),metadata=await sharp(bytes).metadata();
    assert.equal(result.mimeType,`image/${format}`);assert.ok(result.filename.endsWith(`.${format}`));
    assert.equal(result.flattened,true);assert.equal(result.bitDepth,8);assert.equal(result.colorSpace,'sRGB');
    assert.equal(metadata.width,width);assert.equal(metadata.height,height);assert.equal(metadata.depth,'uchar');assert.equal(metadata.density,300);assert.equal(metadata.hasAlpha,true);assert.ok(metadata.icc);
    assert.deepEqual(await sharp(bytes).ensureAlpha().raw().toBuffer(),rendered);
  }
  assert.deepEqual(await fs.readFile(path.join(dataDir,'projects',`${document.id}.json`)),before);
  assert.deepEqual(await fs.readFile(path.join(dataDir,'assets',document.layers[0].sourceAsset)),original);
});

test('JPEG custom matte is applied only at export and WebP lossless preserves visible pixels and alpha',async t=>{
  const{native,document,rendered}=await fixture(t);
  const jpeg=await native.execute('export_document',{documentId:document.id,format:'jpeg',quality:100,matte:'#204060',density:144});
  const jpegBytes=Buffer.from(jpeg.data,'base64'),decoded=await sharp(jpegBytes).raw().toBuffer();
  assert.equal((await sharp(jpegBytes).metadata()).density,144);
  assert.ok(Math.abs(decoded[0]-32)<=2&&Math.abs(decoded[1]-64)<=2&&Math.abs(decoded[2]-96)<=2);
  const webp=await native.execute('export_document',{documentId:document.id,format:'webp',lossless:true});
  const webpPixels=await sharp(Buffer.from(webp.data,'base64')).ensureAlpha().raw().toBuffer();
  for(let i=0;i<rendered.length;i+=4){assert.equal(webpPixels[i+3],rendered[i+3]);if(rendered[i+3])assert.deepEqual(webpPixels.subarray(i,i+4),rendered.subarray(i,i+4));}
  assert.deepEqual(await native.render(native.project(document.id)),rendered);
});

test('export capabilities and format-specific options reject silent incompatibility',async t=>{
  const{native,document}=await fixture(t);
  const caps=await native.execute('capabilities',{});
  assert.ok(caps.exportFormats.includes('tiff'));assert.deepEqual(caps.exportDensityFormats,['png','jpeg','tiff']);
  for(const args of [{format:'png',matte:'#000000'},{format:'tiff',lossless:true},{format:'webp',density:300},{format:'jpeg',density:0},{format:'tiff',density:1201}]){
    assert.throws(()=>validateCommand('export_document',{documentId:document.id,...args}),{code:'INVALID_ARGUMENTS'});
    await assert.rejects(native.execute('export_document',{documentId:document.id,...args}));
  }
});
