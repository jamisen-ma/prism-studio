import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSegmentationModel } from '../server/segmentation-model.mjs';
import { installSegmentationRuntime } from '../server/segmentation-runtime.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let last=-1;
console.log('Setting up local CPU subject extraction. Photos remain on this computer.');
try{
  const dataDir=process.env.PRISM_DATA_DIR||path.join(root,'.prism');
  const runtime=await installSegmentationRuntime(dataDir);
  console.log(runtime.reused?'Verified the existing Python inference runtime.':'Installed and verified the isolated Python inference runtime.');
  console.log('Verifying the BiRefNet Lite segmentation model (224 MB).');
  const result=await installSegmentationModel(dataDir,{progress(received,total){const percent=Math.floor(received/total*10)*10;if(percent!==last){last=percent;console.log(`Download ${percent}%`);}}});
  console.log(result.reused?'Verified the existing model.':'Model installed and checksum verified.');
}catch(error){console.error(error.message);process.exitCode=1;}
