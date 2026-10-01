import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOpenAIKey } from '../server/ai-config.mjs';
import { modelStatus } from '../server/segmentation-model.mjs';
import { runtimeStatus } from '../server/segmentation-runtime.mjs';
import { createCodexImageRunner } from '../server/codex-image-runner.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dataDir=process.env.PRISM_DATA_DIR||path.join(root,'.prism');
const checks=[];
const [segModel,segRuntime]=await Promise.all([modelStatus(dataDir),runtimeStatus(dataDir)]);
checks.push({check:'Local subject extraction',status:segModel.installed&&segRuntime.installed?'ready':'setup required',detail:`Model ${segModel.installed?'installed':'missing'}; CPU runtime ${segRuntime.installed?'installed':'missing'}. Run npm run setup:segmentation to install or verify both.`});
const codex=await createCodexImageRunner().check();
checks.push({check:'Automatic Codex image worker',status:process.env.PRISM_CODEX_WORKER==='0'?'disabled':codex.available?'ready':'setup required',detail:codex.available?'Local Codex is signed in with ChatGPT and its built-in image tool is enabled. The running companion checks its durable queue every five seconds.':codex.reason});
if(process.argv.includes('--check-api')){
  try{checks.push({check:'Optional OpenAI API',status:await readOpenAIKey(dataDir)?'configured':'not configured',detail:'This optional route uses separate API billing. Default Codex handoffs do not use it.'});}
  catch{checks.push({check:'Optional OpenAI API',status:'configuration error',detail:'Run npm run configure:ai only if you want to use the API route.'});}
}
checks.push({check:'Node.js',status:Number(process.versions.node.split('.')[0])>=22?'ready':'update required',detail:process.version});
try{await fs.access(path.join(root,'dist/index.html'));checks.push({check:'Production workspace',status:'built',detail:'npm start serves the compiled workspace on port 43120.'});}
catch{checks.push({check:'Production workspace',status:'not built',detail:'Run npm run build; development uses port 43110.'});}
try{
  const token=(await fs.readFile(path.join(dataDir,'bridge-token'),'utf8')).trim();
  const response=await fetch(`${process.env.PRISM_URL||'http://127.0.0.1:43120'}/api/status`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(3000)});
  if(!response.ok)throw new Error('Companion rejected the local connection.');
  const status=await response.json();
  checks.push({check:'Companion service',status:'running',detail:`Prism ${status.version}`});
  const chatResponse=await fetch(`${process.env.PRISM_URL||'http://127.0.0.1:43120'}/api/chat`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5000)});
  if(chatResponse.ok){const chat=await chatResponse.json();checks.push({check:'Chat editing agent',status:chat.available?'ready':'unavailable',detail:chat.available?'The Chat sidebar can choose native edits, image generation, or both.':chat.message||'Check local Codex sign-in and companion settings.'});}
  checks.push({check:'Native backend',status:'ready',detail:`${status.backends.find(b=>b.id==='native')?.commands.length||0} commands available; 8-bit sRGB initial implementation.`});
}catch{checks.push({check:'Companion service',status:'not reachable',detail:'Run npm run dev or npm start.'});}
for(const item of checks)console.log(`${item.check}: ${item.status}\n  ${item.detail}`);
