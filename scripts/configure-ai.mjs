#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {saveOpenAIKey} from '../server/ai-config.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function hiddenInput(){
  if(!process.stdin.isTTY){let value='';for await(const chunk of process.stdin){value+=chunk;if(value.length>1024)throw new Error('Input is too long.');}return value.trim();}
  process.stdout.write('OpenAI API key (hidden): ');
  process.stdin.setRawMode(true);process.stdin.resume();process.stdin.setEncoding('utf8');
  return new Promise((resolve,reject)=>{
    let value='';
    const finish=(error)=>{process.stdin.off('data',read);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');error?reject(error):resolve(value.trim());};
    const read=chunk=>{for(const character of chunk){if(character==='\u0003'){finish(new Error('Configuration cancelled.'));return;}if(character==='\r'||character==='\n'){finish();return;}if(character==='\u007f'||character==='\b')value=value.slice(0,-1);else if(character>=' '){value+=character;if(value.length>1024){finish(new Error('Input is too long.'));return;}}}};
    process.stdin.on('data',read);
  });
}
try{
  await saveOpenAIKey(process.env.PRISM_DATA_DIR||path.join(root,'.prism'),await hiddenInput());
  console.log('OpenAI key saved with owner-only permissions. Prism reads the updated key on the next request.');
}catch(error){console.error(error.code==='AI_CONFIGURATION_ERROR'||['Configuration cancelled.','Input is too long.'].includes(error.message)?error.message:'Could not save the OpenAI key. Check the local data directory permissions.');process.exitCode=1;}
