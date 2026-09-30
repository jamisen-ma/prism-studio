import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { modelStatus, segmentationModelPath, SEGMENTATION_MODEL } from './segmentation-model.mjs';
import { PythonSegmentationWorker } from './python-segmentation-worker.mjs';
import { runtimeStatus, segmentationPythonPath } from './segmentation-runtime.mjs';

const error=(code,message)=>Object.assign(new Error(message),{code});
export class SegmentationService{
  constructor({dataDir,timeout=90_000,workerFactory}){
    this.dataDir=path.resolve(dataDir);this.timeout=timeout;this.customWorker=Boolean(workerFactory);this.workerFactory=workerFactory|| (options=>new PythonSegmentationWorker(options));this.worker=null;this.pending=null;this.closed=false;
  }
  async status(){
    const [model,runtime]=await Promise.all([modelStatus(this.dataDir),this.customWorker?Promise.resolve({installed:true,engine:'injected'}):runtimeStatus(this.dataDir)]);
    return {installed:model.installed&&runtime.installed,modelInstalled:model.installed,runtime,model:SEGMENTATION_MODEL.id,local:true,running:Boolean(this.pending),limitations:['Automatic masks can miss fine hair, accessories or multiple subjects. Inspect and refine the mask before exporting.']};
  }
  async segment(data){
    if(this.closed)throw error('CLOSED','Subject extraction is closed.');
    if(this.pending)throw error('SEGMENTATION_BUSY','Another subject is being extracted. Wait for it to finish.');
    if(!Buffer.isBuffer(data)||data.length<1||data.length>32*1024*1024)throw error('INVALID_IMAGE','Subject extraction accepts a PNG image no larger than 32 MiB.');
    if(!(await this.status()).installed)throw error('SEGMENTATION_NOT_INSTALLED','Install the local model and runtime with npm run setup:segmentation before extracting subjects.');
    if(this.closed)throw error('CLOSED','Subject extraction is closed.');
    // Re-check after the async status read so concurrent callers cannot race.
    if(this.pending)throw error('SEGMENTATION_BUSY','Another subject is being extracted. Wait for it to finish.');
    if(!this.worker){
      this.worker=this.workerFactory({workerData:{modelPath:segmentationModelPath(this.dataDir),pythonPath:segmentationPythonPath(this.dataDir)}});
      const worker=this.worker;
      worker.on('message',message=>{
        if(worker!==this.worker||message.id!==this.pending?.id)return;
        const pending=this.pending;this.pending=null;clearTimeout(pending.timer);
        if(message.error)pending.reject(error('SEGMENTATION_FAILED','Local subject extraction failed. Verify the model with npm run setup:segmentation and try a smaller image.'));
        else{
          const result=message.result,alpha=Buffer.from(result?.alpha||[]);
          if(!Number.isInteger(result?.width)||!Number.isInteger(result?.height)||result.width<1||result.height<1||result.width>8192||result.height>8192||result.width*result.height>24_000_000||alpha.length!==result.width*result.height)pending.reject(error('SEGMENTATION_FAILED','The local model returned an invalid mask.'));
          else pending.resolve({...result,alpha,model:SEGMENTATION_MODEL.id});
        }
      });
      const failed=()=>{if(worker===this.worker){this.worker=null;this.rejectPending(error('SEGMENTATION_FAILED','The local extraction worker stopped. Try a smaller image.'));}};
      worker.on('error',failed);worker.on('exit',failed);
      worker.unref();
    }
    return new Promise((resolve,reject)=>{
      const id=randomUUID();
      const timer=setTimeout(()=>{const worker=this.worker;this.worker=null;this.rejectPending(error('SEGMENTATION_TIMEOUT','Local extraction timed out. Try a smaller image.'));worker?.terminate();},this.timeout);
      this.pending={id,resolve,reject,timer};
      try{this.worker.postMessage({id,data});}
      catch{const worker=this.worker;this.worker=null;this.rejectPending(error('SEGMENTATION_FAILED','The local extraction worker could not accept the image.'));worker?.terminate();}
    });
  }
  rejectPending(cause){const pending=this.pending;this.pending=null;if(pending){clearTimeout(pending.timer);pending.reject(cause);}}
  async close(){this.closed=true;const worker=this.worker;this.worker=null;this.rejectPending(error('CLOSED','Subject extraction was cancelled when the editor closed.'));if(worker)await worker.terminate();}
}
