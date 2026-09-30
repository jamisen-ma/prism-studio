import {z} from 'zod';

export const IMAGE_MODELS=[
  {id:'gpt-image-2.5-sunburst',label:'GPT Image 2.5 · Sunburst',description:'Precise generation and editing',qualities:['auto','low','medium','high','xhigh','max']},
  {id:'gpt-image-2.5-flare',label:'GPT Image 2.5 · Flare',description:'Fast everyday image generation',qualities:['auto','low','medium','high','xhigh','max']},
  {id:'gpt-image-2',label:'GPT Image 2',description:'Compatibility model',qualities:['auto','low','medium','high']},
];
export const DEFAULT_IMAGE_MODEL=IMAGE_MODELS[0].id;
export const CODEX_IMAGE_MODEL='codex-imagegen';
export const generationSchema=z.object({
  provider:z.enum(['codex','openai']).default('codex'),
  mode:z.enum(['generate','edit']),
  prompt:z.string().trim().min(1).max(16000),
  model:z.enum([CODEX_IMAGE_MODEL,...IMAGE_MODELS.map(model=>model.id)]).optional(),
  quality:z.enum(['auto','low','medium','high','xhigh','max']).default('medium'),
  size:z.enum(['auto','1024x1024','1536x1024','1024x1536']).default('1024x1024'),
  background:z.enum(['auto','opaque','transparent']).default('auto'),
  fit:z.enum(['contain','cover']).optional(),
  documentId:z.string().min(1).max(160).optional(),
  expectedRevision:z.number().int().min(1).optional(),
  scope:z.enum(['canvas','selection']).default('canvas'),
  name:z.string().trim().min(1).max(200).optional(),
  requestId:z.string().min(1).max(160).optional(),
}).strict();
export const jobIdSchema=z.string().uuid();
export const applyGenerationSchema=z.object({expectedRevision:z.number().int().min(1).optional()}).strict();

function invalid(message){throw Object.assign(new Error(message),{code:'INVALID_ARGUMENTS'});}
export function validateGeneration(input){
  const result=generationSchema.safeParse(input);
  if(!result.success)invalid(result.error.issues.map(issue=>`${issue.path.join('.')||'arguments'}: ${issue.message}`).join('; '));
  const args=result.data;
  args.model??=args.provider==='codex'?CODEX_IMAGE_MODEL:DEFAULT_IMAGE_MODEL;
  if(args.provider==='codex'&&args.model!==CODEX_IMAGE_MODEL)invalid('Codex generation uses the built-in Codex image tool. Omit model or choose codex-imagegen.');
  if(args.provider==='openai'){
    const model=IMAGE_MODELS.find(model=>model.id===args.model);
    if(!model)invalid('Choose an OpenAI image model for the explicit API provider.');
    if(!model.qualities.includes(args.quality))invalid('This quality is not supported by the chosen image model.');
  }
  if(args.mode==='edit'&&!args.documentId)invalid('Image editing requires an open native document.');
  if(args.fit!==undefined&&(args.mode!=='generate'||!args.documentId))invalid('Fit applies only when generating a new layer into an existing document.');
  if(args.documentId&&args.expectedRevision===undefined)invalid('Use the document’s latest expectedRevision when generating into a document.');
  if(!args.documentId&&args.expectedRevision!==undefined)invalid('expectedRevision requires a documentId.');
  if(args.scope==='selection'&&(args.mode!=='edit'||!args.documentId))invalid('Selection fill requires edit mode and a native document.');
  return args;
}
