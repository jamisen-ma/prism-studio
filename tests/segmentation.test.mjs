import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SegmentationService } from '../server/segmentation.mjs';
import { SEGMENTATION_MODEL, modelStatus, segmentationModelPath, verifyModel } from '../server/segmentation-model.mjs';

class FakeWorker extends EventEmitter{
  unref(){}
  postMessage(message){this.message=message;}
  async terminate(){this.stopped=true;this.emit('exit',0);}
  result(value){this.emit('message',{id:this.message.id,result:value});}
}
async function fixture(t,{installed=true,timeout=1000}={}){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'prism-segment-test-'));
  if(installed){await fs.mkdir(path.join(dataDir,'models'));const file=await fs.open(segmentationModelPath(dataDir),'w');await file.truncate(SEGMENTATION_MODEL.bytes);await file.close();}
  const workers=[];
  const service=new SegmentationService({dataDir,timeout,workerFactory:()=>{const worker=new FakeWorker();workers.push(worker);return worker;}});
  t.after(async()=>{await service.close();await fs.rm(dataDir,{recursive:true,force:true});});
  return {service,workers,dataDir};
}
async function started(workers,count=1){for(let i=0;i<100&&workers.length<count;i++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(workers.length,count);}
test('missing model is actionable and never starts a worker',async t=>{
  const {service,workers}=await fixture(t,{installed:false});
  assert.equal((await service.status()).installed,false);
  await assert.rejects(service.segment(Buffer.from('image')),{code:'SEGMENTATION_NOT_INSTALLED'});assert.equal(workers.length,0);
});
test('local extraction returns only alpha, serializes requests, and reuses its worker',async t=>{
  const {service,workers}=await fixture(t);
  const first=service.segment(Buffer.from('image'));await started(workers);
  await assert.rejects(service.segment(Buffer.from('second')),{code:'SEGMENTATION_BUSY'});
  workers[0].result({alpha:new Uint8Array([0,64,128,255]),width:2,height:2,model:'ignored'});
  const result=await first;assert.deepEqual(result.alpha,Buffer.from([0,64,128,255]));assert.equal(result.model,SEGMENTATION_MODEL.id);assert.equal('image' in result,false);
  const second=service.segment(Buffer.from('again'));await new Promise(resolve=>setTimeout(resolve,5));
  workers[0].result({alpha:new Uint8Array([255]),width:1,height:1});await second;assert.equal(workers.length,1);
});
test('invalid mask and worker exceptions never reach the document',async t=>{
  const {service,workers}=await fixture(t);
  const first=service.segment(Buffer.from('image'));await started(workers);
  workers[0].result({alpha:new Uint8Array([255]),width:2,height:2});await assert.rejects(first,{code:'SEGMENTATION_FAILED'});
  const second=service.segment(Buffer.from('image'));await new Promise(resolve=>setTimeout(resolve,5));
  workers[0].emit('error',new Error('private worker details'));
  await assert.rejects(second,error=>error.code==='SEGMENTATION_FAILED'&&!error.message.includes('private'));
});
test('timeout terminates inference and close rejects pending work without accepting late output',async t=>{
  const {service,workers}=await fixture(t,{timeout:30});
  const first=service.segment(Buffer.from('image'));await started(workers);await assert.rejects(first,{code:'SEGMENTATION_TIMEOUT'});assert.equal(workers[0].stopped,true);
  const second=service.segment(Buffer.from('image'));const rejected=assert.rejects(second,{code:'CLOSED'});await started(workers,2);
  await service.close();await rejected;assert.equal(workers[1].stopped,true);await assert.rejects(service.segment(Buffer.from('image')),{code:'CLOSED'});
});
test('model checksum rejects a same-size corrupt model',async t=>{
  const {dataDir}=await fixture(t);
  assert.equal((await modelStatus(dataDir)).installed,true);
  await assert.rejects(verifyModel(segmentationModelPath(dataDir)),/checksum/);
});
