import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// This non-generative model predicts alpha coverage only. The RGB source is
// never reconstructed. The checksum is published by rembg's model adapter.
export const SEGMENTATION_MODEL = Object.freeze({
  id: 'birefnet-general-lite',
  filename: 'BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx',
  url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx',
  md5: '4fab47adc4ff364be1713e97b7e66334',
  bytes: 224005088,
  inputSize: 1024,
  source: 'https://github.com/ZhengPeng7/BiRefNet',
});
export function segmentationModelPath(dataDir) { return path.join(dataDir, 'models', SEGMENTATION_MODEL.filename); }
export async function modelStatus(dataDir) {
  try { const s=await fs.stat(segmentationModelPath(dataDir)); return {installed:s.isFile()&&s.size===SEGMENTATION_MODEL.bytes,model:SEGMENTATION_MODEL.id}; }
  catch { return {installed:false,model:SEGMENTATION_MODEL.id}; }
}
export async function verifyModel(file) {
  const handle=await fs.open(file,'r');
  try {
    const stat=await handle.stat();
    if(!stat.isFile()||stat.size!==SEGMENTATION_MODEL.bytes)throw new Error('The segmentation model has an unexpected size. Run npm run setup:segmentation.');
    const hash=createHash('md5');
    for await(const chunk of handle.createReadStream({autoClose:false}))hash.update(chunk);
    if(hash.digest('hex')!==SEGMENTATION_MODEL.md5)throw new Error('The segmentation model checksum does not match. Run npm run setup:segmentation.');
  }finally{await handle.close();}
}
export async function installSegmentationModel(dataDir,{progress=()=>{},signal}={}) {
  const file=segmentationModelPath(dataDir);
  if((await modelStatus(dataDir)).installed){try{await verifyModel(file);return {path:file,installed:true,reused:true};}catch{/* Replace a corrupt cache only after a new download verifies. */}}
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const temp=path.join(path.dirname(file),`.model-${randomUUID()}.tmp`);
  const controller=new AbortController();
  const combined=AbortSignal.any([controller.signal,signal||AbortSignal.timeout(1_800_000)]);
  const handle=await fs.open(temp,'wx',0o600);let received=0;
  try {
    // The fixed release endpoint supports byte ranges. Bounded parallel parts
    // avoid a single slow connection while keeping one final checksum check.
    const parts=8,partSize=Math.ceil(SEGMENTATION_MODEL.bytes/parts);
    const results=await Promise.allSettled(Array.from({length:parts},async(_,part)=>{
      try{
        const start=part*partSize,end=Math.min(SEGMENTATION_MODEL.bytes-1,start+partSize-1);
        const response=await fetch(SEGMENTATION_MODEL.url,{headers:{Range:`bytes=${start}-${end}`},signal:combined,redirect:'follow'});
        if(response.status!==206||response.headers.get('content-range')!==`bytes ${start}-${end}/${SEGMENTATION_MODEL.bytes}`||!response.body)throw new Error('The model host did not return the requested byte range.');
        let position=start;
        for await(const chunk of response.body){
          if(position+chunk.length>end+1)throw new Error('The model download exceeded its expected size.');
          let written=0;while(written<chunk.length){const result=await handle.write(chunk,written,chunk.length-written,position+written);written+=result.bytesWritten;}
          position+=chunk.length;received+=chunk.length;progress(received,SEGMENTATION_MODEL.bytes);
        }
        if(position!==end+1)throw new Error('The model download ended early.');
      }catch(cause){controller.abort();throw cause;}
    }));
    const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
    await handle.sync();await handle.close();await verifyModel(temp);await fs.rename(temp,file);
    return {path:file,installed:true,reused:false};
  }finally{await handle.close().catch(()=>{});await fs.unlink(temp).catch(()=>{});}
}
