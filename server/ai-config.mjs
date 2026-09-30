import fs from 'node:fs/promises';
import path from 'node:path';

const validKey=value=>typeof value==='string'&&/^sk-[A-Za-z0-9_-]{20,512}$/.test(value);
export async function readOpenAIKey(dataDir){
  if(process.env.OPENAI_API_KEY){
    const key=process.env.OPENAI_API_KEY.trim();
    if(!validKey(key))throw Object.assign(new Error('OPENAI_API_KEY is malformed. Replace it in the server environment.'),{code:'AI_CONFIGURATION_ERROR'});
    return key;
  }
  try{
    const key=(await fs.readFile(path.join(dataDir,'secrets','openai-api-key'),'utf8')).trim();
    if(!validKey(key))throw Object.assign(new Error('The saved OpenAI key is malformed. Run npm run configure:ai to replace it.'),{code:'AI_CONFIGURATION_ERROR'});
    return key;
  }catch(error){if(error.code==='ENOENT')return null;throw error;}
}
export async function saveOpenAIKey(dataDir,key){
  if(!validKey(key))throw Object.assign(new Error('Enter a valid OpenAI API key.'),{code:'AI_CONFIGURATION_ERROR'});
  const directory=path.join(dataDir,'secrets');await fs.mkdir(directory,{recursive:true,mode:0o700});await fs.chmod(directory,0o700);
  const filename=path.join(directory,'openai-api-key');
  await fs.writeFile(filename,key+'\n',{mode:0o600});await fs.chmod(filename,0o600);
}
