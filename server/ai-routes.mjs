import sharp from 'sharp';
import {IMAGE_MODELS,DEFAULT_IMAGE_MODEL,validateGeneration,jobIdSchema,applyGenerationSchema} from '../shared/generation.mjs';

const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
export async function imageGenerationStatus(manager,getKey,{includeOpenAI=false}={}){
  let configured=false,configurationError;
  if(includeOpenAI)try{configured=Boolean(await getKey());}catch{configurationError='The local OpenAI key configuration could not be read. Run npm run configure:ai.';}
  const codexWorker=manager.codexWorker?.status()??{enabled:false,available:false,state:'unavailable',message:'Automatic local Codex image generation is disabled. Manual conversation handoff remains available.'};
  return {configured,configurationChecked:includeOpenAI,models:IMAGE_MODELS,defaultModel:DEFAULT_IMAGE_MODEL,defaultQuality:'medium',defaultProvider:'codex',codexWorker,providers:[
    {id:'codex',label:codexWorker.enabled?'Local Codex':'Codex conversation',available:true,requiresApiKey:false,requiresConversation:!codexWorker.enabled},
    {id:'openai',label:'OpenAI API',available:configured,configurationChecked:includeOpenAI,requiresApiKey:true},
  ],limits:{maxQueued:5,maxActive:1,maxPending:6},...(configurationError?{configurationError}:{})};
}

// Called only after the companion has validated origin and its session token.
export async function handleAIRoute({request,response,url,manager,getKey,readJson,json}){
  if(!url.pathname.startsWith('/api/ai/'))return false;
  const path=url.pathname.slice('/api/ai/'.length);
  if(request.method==='GET'&&path==='status'){
    const provider=url.searchParams.get('provider')||'codex';
    if(!['codex','openai'].includes(provider))fail('INVALID_ARGUMENTS','Choose the Codex conversation or OpenAI API provider.');
    json(response,200,await imageGenerationStatus(manager,getKey,{includeOpenAI:provider==='openai'}));return true;
  }
  if(path==='jobs'&&request.method==='GET'){json(response,200,await manager.list());return true;}
  if(path==='jobs'&&request.method==='POST'){
    const args=validateGeneration(await readJson(request));
    json(response,202,await manager.start(args));return true;
  }
  const match=/^jobs\/([^/]+)(?:\/(preview|cancel|apply|handoff|complete))?$/.exec(path);
  if(!match)fail('NOT_FOUND','Unknown image generation endpoint.');
  const parsed=jobIdSchema.safeParse(match[1]);if(!parsed.success)fail('INVALID_ARGUMENTS','Use a valid generation job ID.');
  const id=parsed.data,action=match[2];
  if(request.method==='GET'&&!action){json(response,200,await manager.get(id));return true;}
  if(request.method==='GET'&&action==='handoff'){
    const {image,mask,...metadata}=await manager.handoff(id);
    json(response,200,{...metadata,...(image?{image:{data:image.toString('base64'),mimeType:'image/png'}}:{}),...(mask?{mask:{data:mask.toString('base64'),mimeType:'image/png'}}:{})});return true;
  }
  if(request.method==='POST'&&action==='complete'){
    const body=await readJson(request);
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>key!=='data')||typeof body.data!=='string'||!body.data.length||body.data.length>40*1024*1024||body.data.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(body.data))fail('INVALID_ARGUMENTS','Completion accepts only a base64 PNG data field, at most 30 MiB decoded.');
    const data=Buffer.from(body.data,'base64');
    if(!data.length||data.length>30*1024*1024||data.toString('base64')!==body.data)fail('INVALID_ARGUMENTS','Completion requires a valid PNG file no larger than 30 MiB.');
    json(response,200,await manager.complete({jobId:id,data}));return true;
  }
  if(request.method==='GET'&&action==='preview'){
    const size=Number(url.searchParams.get('maxWidth')||600);
    if(!Number.isInteger(size)||size<32||size>2400)fail('INVALID_ARGUMENTS','Preview width must be between32 and2400.');
    const result=await manager.output(id);
    const preview=await sharp(result.data,{limitInputPixels:24_000_000}).resize({width:size,withoutEnlargement:true}).png().toBuffer({resolveWithObject:true});
    json(response,200,{data:preview.data.toString('base64'),mimeType:'image/png',width:preview.info.width,height:preview.info.height});return true;
  }
  if(request.method==='POST'&&action==='cancel'){
    const body=await readJson(request);if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)fail('INVALID_ARGUMENTS','Cancellation requires an empty object.');
    json(response,200,await manager.cancel(id));return true;
  }
  if(request.method==='POST'&&action==='apply'){
    const parsed=applyGenerationSchema.safeParse(await readJson(request));if(!parsed.success)fail('INVALID_ARGUMENTS','Apply accepts only an optional expectedRevision.');
    json(response,200,await manager.apply({jobId:id,...parsed.data}));return true;
  }
  fail('NOT_FOUND','Unknown image generation endpoint.');
}
