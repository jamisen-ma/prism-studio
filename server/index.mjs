import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { NativeBackend } from './native.mjs';import { GenerationManager } from './generation.mjs';
import { CodexWorker } from './codex-worker.mjs';
import { ChatManager } from './chat.mjs';
import { handleChatRoute, handleChatToolRoute } from './chat-routes.mjs';
import { createChatToolContext } from './chat-tools.mjs';
import { readOpenAIKey } from './ai-config.mjs';
import { handleAIRoute, imageGenerationStatus } from './ai-routes.mjs';
import { createProjectRoutes } from './project-routes.mjs';
import { createPsdRoutes } from './psd-routes.mjs';
import { createPsdImportRoutes } from './psd-import-routes.mjs';
import { SegmentationService } from './segmentation.mjs';
import { commandError, validateCommand, readCommands, commandLabels } from '../shared/commands.mjs';

export const PROJECT_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const MAX_BODY=42*1024*1024;

function sameToken(a,b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa=Buffer.from(a), bb=Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa,bb);
}
const MIME={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon','.woff2':'font/woff2'};

async function getToken(dataDir) {
  await fs.mkdir(dataDir,{recursive:true,mode:0o700});
  const filename=path.join(dataDir,'bridge-token');
  try {
    const token=(await fs.readFile(filename,'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw commandError('INVALID_CONFIGURATION','Pairing key file is malformed. Move it aside and restart to generate a new key.');
    return token;
  } catch(error) {if(error.code!=='ENOENT')throw error;}
  const token=randomBytes(32).toString('hex');
  try {await fs.writeFile(filename,token+'\n',{mode:0o600,flag:'wx'});}
  catch(error) {if(error.code==='EEXIST')return getToken(dataDir);throw error;}
  return token;
}

export function trustedRequest(request,serverPort) {
  const host=request.headers.host;
  if(!host || ![`127.0.0.1:${serverPort}`,`localhost:${serverPort}`,'127.0.0.1:43110','localhost:43110'].includes(host))return false;
  const origin=request.headers.origin;
  if(origin && ![`http://127.0.0.1:${serverPort}`,`http://localhost:${serverPort}`,'http://127.0.0.1:43110','http://localhost:43110'].includes(origin))return false;
  if(request.headers['sec-fetch-site']==='cross-site')return false;
  return true;
}

async function readJson(request,{maxBytes=MAX_BODY}={}) {
  if(!String(request.headers['content-type']||'').startsWith('application/json'))throw commandError('INVALID_ARGUMENTS','Send application/json.');
  const declared=Number(request.headers['content-length']);
  if(declared>maxBytes)throw commandError('PAYLOAD_TOO_LARGE',maxBytes===MAX_BODY?'The request exceeds the 42 MiB limit.':'The request exceeds this endpoint’s bounded JSON size.');
  const chunks=[];let size=0;
  for await(const chunk of request) {size+=chunk.length;if(size>maxBytes)throw commandError('PAYLOAD_TOO_LARGE',maxBytes===MAX_BODY?'The request exceeds the 42 MiB limit.':'The request exceeds this endpoint’s bounded JSON size.');chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch{throw commandError('INVALID_ARGUMENTS','The request body is not valid JSON.');}
}

export function statusCode(error) {
  if(error.code==='UNAUTHORIZED')return 401;
  if(error.code==='FORBIDDEN')return 403;
  if(['REVISION_CONFLICT','STALE_REVISION','REQUEST_CONFLICT','IDEMPOTENCY_CONFLICT'].includes(error.code))return 409;
  if(error.code==='PAYLOAD_TOO_LARGE'||error.code==='IMAGE_TOO_LARGE')return 413;
  if(error.code==='COMMAND_TIMEOUT')return 504;
  if(error.code==='QUEUE_FULL')return 503;
  if(error.code==='NOT_FOUND'||error.code==='DOCUMENT_NOT_FOUND')return 404;
  return error.code ? 400:500;
}

// Serves the built workspace from dist/. Shared by local and hosted servers.
export async function serveDist(request,response,url,json,missingMessage,extraHeaders={}){
    if(!['GET','HEAD'].includes(request.method)){json(response,405,{ok:false,error:{code:'METHOD_NOT_ALLOWED',message:'Use GET.'}});return;}
    const dist=path.join(PROJECT_ROOT,'dist');let resource;
    try {const decoded=decodeURIComponent(url.pathname);resource=path.resolve(dist,`.${decoded==='/'?'/index.html':decoded}`);}
    catch{throw commandError('INVALID_ARGUMENTS','Invalid resource path.');}
    if(!resource.startsWith(dist+path.sep))throw commandError('FORBIDDEN','Invalid resource path.');
    let content;
    try {content=await fs.readFile(resource);}
    catch(error){if(error.code!=='ENOENT'&&error.code!=='EISDIR')throw error;json(response,404,{ok:false,error:{code:'NOT_FOUND',message:missingMessage}});return;}
    response.writeHead(200,{'Content-Type':MIME[path.extname(resource)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'",'Cache-Control':path.extname(resource)==='.html'?'no-cache':'public, max-age=3600',...extraHeaders});
    response.end(request.method==='HEAD'?undefined:content);
}

// `hosted` builds one per-user workspace for server/hosted.mjs: it creates no
// listener or pairing key, and exposes `handleApi` for use
// only after the hosted front server has authenticated that user.
export async function createCompanion({dataDir=path.join(PROJECT_ROOT,'.prism'),port=43120,imageProvider,getImageKey,segmentSubject,codexWorkerEnabled=false,codexImageAdapter,chatEnabled=false,chatAdapter,chatToolContextFactory=createChatToolContext,hosted=false,codexHome,segmentation:sharedSegmentation,segmentationEnabled=true,getBaseUrl,maxBody=MAX_BODY,maxDocuments=Infinity,beforeMutation}={}) {
  const token=hosted?randomBytes(32).toString('hex'):await getToken(dataDir);
  if(hosted)await fs.mkdir(dataDir,{recursive:true,mode:0o700});
  const segmentation=sharedSegmentation||new SegmentationService({dataDir});
  const native=await new NativeBackend({dataDir:path.join(dataDir,'native'),segmentSubject:segmentationEnabled?(segmentSubject||((data)=>segmentation.segment(data))):undefined}).init();
  const imageKey=getImageKey||(()=>readOpenAIKey(dataDir));
  const generation=await new GenerationManager({dataDir,native,getKey:imageKey,provider:imageProvider,automaticCodex:codexWorkerEnabled}).init();
  const codexAdapter=codexWorkerEnabled?(codexImageAdapter??(await import('./codex-image-runner.mjs')).createCodexImageRunner(codexHome?{codexHome}:{})):null;
  const codexWorker=codexWorkerEnabled?new CodexWorker({manager:generation,adapter:codexAdapter}):null;
  const nativeCapabilities=await native.execute('capabilities',{});
  const handleProjectRoute=createProjectRoutes(native);
  const handlePsdRoute=createPsdRoutes(native);
  const handlePsdImportRoute=createPsdImportRoutes(native);
  const activity=[];const queues=new Map();const queueSizes=new Map();const requests=new Map();
  let actualPort=port;
  const server=hosted?null:http.createServer((request,response)=>{handle(request,response).catch(error=>{
    if(!response.headersSent)json(response,statusCode(error),{ok:false,error:{code:error.code||'INTERNAL_ERROR',message:error.code?error.message:'The companion could not complete this request.'}});
    else response.end();
  });});
  if(server){server.requestTimeout=120_000;server.headersTimeout=15_000;}
  const readBody=(request,{maxBytes=MAX_BODY}={})=>readJson(request,{maxBytes:Math.min(maxBytes,maxBody)});
  function log(event){const item={id:randomUUID(),timestamp:new Date().toISOString(),...event};activity.unshift(item);activity.splice(150);return item;}
  function json(response,status,data){response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(JSON.stringify(data));}
  function serialize(backend,task){
    const count=queueSizes.get(backend)||0;if(count>=40)return Promise.reject(commandError('QUEUE_FULL','Too many editing requests are queued. Wait for the current work to finish.'));
    queueSizes.set(backend,count+1);
    const previous=queues.get(backend)||Promise.resolve();
    const next=previous.catch(()=>{}).then(task).finally(()=>queueSizes.set(backend,(queueSizes.get(backend)||1)-1));
    queues.set(backend,next);next.catch(()=>{});return next;
  }
  async function execute({backend,command,args={},requestId}={}){
    if(backend!=='native')throw commandError('INVALID_ARGUMENTS','Choose the native backend.');
    if(backend==='native'&&['create_document','import_image'].includes(command)&&native.projects.size>=maxDocuments)throw commandError('LIMIT_EXCEEDED',`This account has reached its ${maxDocuments}-document limit. Delete a document before adding another.`);
    const validated=validateCommand(command,args);
    if(requestId!==undefined && (typeof requestId!=='string'||requestId.length<1||requestId.length>160))throw commandError('INVALID_ARGUMENTS','requestId must contain 1–160 characters.');
    const mutating=!readCommands.has(command),key=requestId && mutating ? `${backend}:${requestId}`:null;
    if(mutating&&beforeMutation)await beforeMutation(command);
    const fingerprint=key?createHash('sha256').update(JSON.stringify({command,args:validated})).digest('hex'):null;
    if(key && requests.has(key)){
      const prior=requests.get(key);
      if(prior.fingerprint!==fingerprint)throw commandError('REQUEST_CONFLICT','This requestId was already used for a different edit.');
      return prior.promise;
    }
    const promise=serialize(backend,async()=>{
      const tracked=!['get_preview','get_layer_preview','get_mask_preview','get_channel_preview','get_color_range_preview','get_document','list_documents','capabilities','get_histogram','sample_color','get_edit_recipe','validate_edit_recipe'].includes(command);
      const started=Date.now();
      const event=tracked?log({backend,command,label:command==='apply_transaction'?validated.label:commandLabels[command],status:'running'}):null;
      try{
        const result=await native.execute(command,validated);
        if(event)Object.assign(event,{status:'success',durationMs:Date.now()-started});
        return result;
      }catch(error){if(event)Object.assign(event,{status:'error',durationMs:Date.now()-started,error:error.code?error.message:'The edit failed.'});throw error;}
    });
    if(key){
      const entry={fingerprint,promise,settled:false};requests.set(key,entry);
      promise.finally(()=>{
        entry.settled=true;
        if(requests.size>500)for(const [oldKey,old]of requests){if(old.settled&&oldKey!==key)requests.delete(oldKey);if(requests.size<=400)break;}
      }).catch(()=>{});
    }
    return promise;
  }
  // Authenticated API routes. Local mode reaches this only after Host/Origin and
  // token checks in handle(); hosted mode only after its own user session check.
  async function handleApi(request,response,url){
      if(await handleChatRoute({request,response,url,manager:chat,readJson:readBody,json}))return;
      if(await handleAIRoute({request,response,url,manager:generation,getKey:imageKey,readJson:readBody,json}))return;
      if(await handleProjectRoute({request,response,url,json}))return;
      if(await handlePsdImportRoute({request,response,url,json}))return;
      if(await handlePsdRoute({request,response,url,json}))return;
      if(request.method==='GET' && url.pathname==='/api/status'){
        json(response,200,{name:'Prism Studio',version:'0.1.0',backends:[
          {id:'native',label:'Prism Native',connected:true,commands:nativeCapabilities.commands,limitations:nativeCapabilities.limitations,adjustmentKinds:nativeCapabilities.adjustmentKinds,curvesInterpolationPolicy:nativeCapabilities.curvesInterpolationPolicy,curvesInterpolationModes:nativeCapabilities.curvesInterpolationModes,photoFilterPolicy:nativeCapabilities.photoFilterPolicy,colorLookupPolicy:nativeCapabilities.colorLookupPolicy,colorLookupFormats:nativeCapabilities.colorLookupFormats,colorLookupInputSpaces:nativeCapabilities.colorLookupInputSpaces,colorLookupLimits:nativeCapabilities.colorLookupLimits,curvesBanksPolicy:nativeCapabilities.curvesBanksPolicy,curvesBankNames:nativeCapabilities.curvesBankNames,selectiveColorPolicy:nativeCapabilities.selectiveColorPolicy,selectiveColorMethods:nativeCapabilities.selectiveColorMethods,selectiveColorRanges:nativeCapabilities.selectiveColorRanges,hueSaturationPolicy:nativeCapabilities.hueSaturationPolicy,hueSaturationRanges:nativeCapabilities.hueSaturationRanges,layerFilterKinds:nativeCapabilities.layerFilterKinds,layerFilterCoordinates:nativeCapabilities.layerFilterCoordinates,layerFilterBaking:nativeCapabilities.layerFilterBaking,layerFilterSpatialPolicy:nativeCapabilities.layerFilterSpatialPolicy,layerFilterUnsharpPolicy:nativeCapabilities.layerFilterUnsharpPolicy,layerFilterNoisePolicy:nativeCapabilities.layerFilterNoisePolicy,layerFilterHighPassPolicy:nativeCapabilities.layerFilterHighPassPolicy,layerFilterLocalTonePolicy:nativeCapabilities.layerFilterLocalTonePolicy,layerFilterMaskPolicy:nativeCapabilities.layerFilterMaskPolicy,layerFilterMaskCoordinates:nativeCapabilities.layerFilterMaskCoordinates,layerFilterMaskSources:nativeCapabilities.layerFilterMaskSources,layerFilterMaskShapes:nativeCapabilities.layerFilterMaskShapes,layerFilterMaskProperties:nativeCapabilities.layerFilterMaskProperties,layerFilterMaskCaptureGeometry:nativeCapabilities.layerFilterMaskCaptureGeometry,layerFilterBlendPolicy:nativeCapabilities.layerFilterBlendPolicy,layerFilterBlendModes:nativeCapabilities.layerFilterBlendModes,layerDistortPolicy:nativeCapabilities.layerDistortPolicy,layerDistortCoordinates:nativeCapabilities.layerDistortCoordinates,layerDistortContentTypes:nativeCapabilities.layerDistortContentTypes,documentResizeMethods:nativeCapabilities.documentResizeMethods,documentResizeDefault:nativeCapabilities.documentResizeDefault,morphologyOperations:nativeCapabilities.morphologyOperations,layeredExportFormats:nativeCapabilities.layeredExportFormats,layeredImportFormats:nativeCapabilities.layeredImportFormats,psdImporterVersion:nativeCapabilities.psdImporterVersion,psdImportPolicy:nativeCapabilities.psdImportPolicy,layerStyleProperties:nativeCapabilities.layerStyleProperties,layerFillPolicy:nativeCapabilities.layerFillPolicy,layerFillContentTypes:nativeCapabilities.layerFillContentTypes,layerMaskProperties:nativeCapabilities.layerMaskProperties,layerMaskPositioning:nativeCapabilities.layerMaskPositioning,layerMaskPositionUnits:nativeCapabilities.layerMaskPositionUnits,layerMaskPositionOperations:nativeCapabilities.layerMaskPositionOperations,layerSelectionSources:nativeCapabilities.layerSelectionSources,layerSelectionMaskModes:nativeCapabilities.layerSelectionMaskModes,layerSelectionContentTypes:nativeCapabilities.layerSelectionContentTypes,denseMaskPolicy:nativeCapabilities.denseMaskPolicy,denseMaskLimits:nativeCapabilities.denseMaskLimits,channelSelectionPolicy:nativeCapabilities.channelSelectionPolicy,channelSelectionChannels:nativeCapabilities.channelSelectionChannels,channelPreviewLimits:nativeCapabilities.channelPreviewLimits,colorRangePolicy:nativeCapabilities.colorRangePolicy,colorRangeLimits:nativeCapabilities.colorRangeLimits,colorRangePreviewLimits:nativeCapabilities.colorRangePreviewLimits,maskPreviewSources:nativeCapabilities.maskPreviewSources,maskPreviewMaskModes:nativeCapabilities.maskPreviewMaskModes,textSpacingProperties:nativeCapabilities.textSpacingProperties,textTrackingUnits:nativeCapabilities.textTrackingUnits,textLeadingUnits:nativeCapabilities.textLeadingUnits,retouchSampleModes:nativeCapabilities.retouchSampleModes,retouchSamplingTools:nativeCapabilities.retouchSamplingTools,retouchIgnoreAdjustments:nativeCapabilities.retouchIgnoreAdjustments,retouchCurrentAndBelowScope:nativeCapabilities.retouchCurrentAndBelowScope,repairLayerPlacement:nativeCapabilities.repairLayerPlacement,editRecipeVersion:nativeCapabilities.editRecipeVersion,editRecipeCommands:nativeCapabilities.editRecipeCommands,editRecipeSlotTypes:nativeCapabilities.editRecipeSlotTypes,blendModes:nativeCapabilities.blendModes,groupModes:nativeCapabilities.groupModes,groupBlendModes:nativeCapabilities.groupBlendModes,clippingLayerTypes:nativeCapabilities.clippingLayerTypes,clippingBlendPolicy:nativeCapabilities.clippingBlendPolicy,guideAxes:nativeCapabilities.guideAxes,guideCoordinates:nativeCapabilities.guideCoordinates,projectFormats:nativeCapabilities.projectFormats,projectBundleVersion:nativeCapabilities.projectBundleVersion,exportFormats:nativeCapabilities.exportFormats,exportOptions:nativeCapabilities.exportOptions,exportDensityFormats:nativeCapabilities.exportDensityFormats,limits:nativeCapabilities.limits},
        ],ai:await imageGenerationStatus(generation,imageKey),segmentation:await segmentation.status(),activity});return;
      }
      if(request.method==='GET' && url.pathname==='/api/activity'){json(response,200,{activity});return;}      if(!hosted && request.method==='GET' && url.pathname==='/api/setup'){
        json(response,200,{mcpCommand:process.execPath,mcpArgs:[path.join(PROJECT_ROOT,'server/mcp.mjs')]});return;
      }
      if(request.method==='POST' && url.pathname==='/api/command'){
        const body=await readBody(request);
        if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['backend','command','args','requestId'].includes(k)))throw commandError('INVALID_ARGUMENTS','Expected backend, command, args, and optional requestId.');
        json(response,200,{ok:true,result:await execute(body)});return;
      }
      json(response,404,{ok:false,error:{code:'NOT_FOUND',message:'Unknown API endpoint.'}});
  }
  async function handle(request,response){
    if(!trustedRequest(request,actualPort))throw commandError('FORBIDDEN','Only this computer’s Prism workspace may access the companion.');
    const url=new URL(request.url,`http://127.0.0.1:${actualPort}`);
    if(url.pathname.startsWith('/api/')){
      if(await handleChatToolRoute({request,response,url,manager:chat,readJson,json}))return;
      if(request.method==='GET' && url.pathname==='/api/session'){
        if(request.headers.authorization&&!sameToken(request.headers.authorization.replace(/^Bearer /,''),token))throw commandError('UNAUTHORIZED','A valid Prism session is required.');
        json(response,200,{token});return;
      }
      const auth=request.headers.authorization?.replace(/^Bearer /,'');
      if(!sameToken(auth,token))throw commandError('UNAUTHORIZED','A valid Prism session is required.');
      await handleApi(request,response,url);return;
    }
    await serveDist(request,response,url,json,'Run npm run build to serve the workspace here, or use http://127.0.0.1:43110 during development.');
  }
  const agent=chatEnabled?(chatAdapter??(await import('./codex-chat-runner.mjs')).createCodexChatRunner(codexHome?{codexHome}:{})):{check:async()=>({available:false})};
  const chat=await new ChatManager({dataDir,native,generation,adapter:agent,createToolContext:chatToolContextFactory,execute,getBaseUrl:getBaseUrl||(()=>`http://127.0.0.1:${actualPort}`),enabled:chatEnabled}).init();
  if(codexWorker)await codexWorker.start();
  if(hosted)return {native,generation,codexWorker,chat,segmentation,execute,dataDir,handleApi,
    handleChatTool:(request,response,url)=>handleChatToolRoute({request,response,url,manager:chat,readJson,json}),
    // The shared segmentation service belongs to the hosted server, not a user.
    async close(){await chat.close();await codexWorker?.close();await generation.close();await native.close();},
  };
  return {server,native,generation,codexWorker,chat,segmentation,execute,token,dataDir,
    async listen(){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.off('error',reject);resolve();});});actualPort=server.address().port;return actualPort;},
    async close(){await chat.close();await codexWorker?.close();await generation.close();await segmentation.close();await native.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});},
  };
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url) && process.env.PRISM_HOSTED==='1'){
  // Not awaited: hosted.mjs imports this module, which must finish evaluating first.
  import('./hosted.mjs').then(hosted=>hosted.startHostedFromEnv()).catch(error=>{console.error(error);process.exit(1);});
}else if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const port=Number(process.env.PRISM_PORT||43120);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PRISM_PORT must be a valid port number.');
  const app=await createCompanion({port,dataDir:process.env.PRISM_DATA_DIR||path.join(PROJECT_ROOT,'.prism'),codexWorkerEnabled:process.env.PRISM_CODEX_WORKER!=='0',chatEnabled:process.env.PRISM_CHAT!=='0'});
  await app.listen();console.log(`Prism Studio companion is running at http://127.0.0.1:${port}`);
  let stopping=false;
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(stopping)return;stopping=true;await app.close();process.exit(0);});
}
