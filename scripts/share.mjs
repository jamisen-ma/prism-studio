// Share this machine's Prism Studio through an ngrok tunnel. Runs hosted
// multi-user mode on loopback so visitors never get the local companion or your
// own Codex sign-in. By default each visitor gets a passwordless guest workspace;
// PRISM_GUEST=0 requires accounts with an invite code instead.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const port=Number(process.env.PORT||8080);
const guest=process.env.PRISM_GUEST!=='0';
const signupCode=process.env.PRISM_SIGNUP_CODE||randomBytes(6).toString('base64url');

if(!existsSync(path.join(root,'dist','index.html'))){
  console.log('Building the client…');
  if(spawnSync('npm',['run','build'],{cwd:root,stdio:'inherit'}).status!==0)process.exit(1);
}

const children=[];
let stopping=false;
function stop(code=0){if(stopping)return;stopping=true;process.exitCode=code;for(const child of children)child.kill('SIGTERM');setTimeout(()=>process.exit(code),500).unref();}
function track(child,name){children.push(child);child.on('error',error=>{console.error(`${name}: ${error.message}`);stop(1);});child.on('exit',code=>{if(!stopping){console.error(`${name} exited (${code}).`);stop(code||1);}});return child;}
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());

const ngrokArgs=['http',String(port),'--log','stdout','--log-format','json'];
if(process.env.NGROK_DOMAIN)ngrokArgs.push('--url',process.env.NGROK_DOMAIN);
const ngrok=track(spawn('ngrok',ngrokArgs,{cwd:root,stdio:['ignore','pipe','inherit']}),'ngrok');

const publicUrl=await new Promise((resolve,reject)=>{
  let buffer='';
  const timer=setTimeout(()=>reject(new Error('ngrok did not report a public URL within 20s.')),20_000);
  ngrok.stdout.on('data',chunk=>{
    buffer+=chunk;let newline;
    while((newline=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
      let entry;try{entry=JSON.parse(line);}catch{continue;}
      if(entry.lvl==='eror'||entry.lvl==='crit'){clearTimeout(timer);reject(new Error(entry.err||entry.msg));}
      if(entry.url?.startsWith('https://')){clearTimeout(timer);resolve(entry.url);}
    }
  });
}).catch(error=>{console.error(`ngrok failed: ${error.message}\nIf you have not yet, run: ngrok config add-authtoken <token>`);stop(1);});
if(!publicUrl)await new Promise(()=>{});
ngrok.stdout.resume();

track(spawn(process.execPath,['server/hosted.mjs'],{cwd:root,stdio:'inherit',env:{
  ...process.env,
  PRISM_HOST:'127.0.0.1',
  PRISM_GUEST:guest?'1':'0',
  PORT:String(port),
  PRISM_PUBLIC_URL:publicUrl,
  PRISM_SIGNUP_CODE:signupCode,
  PRISM_DATA_ROOT:process.env.PRISM_DATA_ROOT||path.join(root,'.prism','hosted'),
}}),'server');

console.log(`\n  Share URL:    ${publicUrl}\n  ${guest?'Access:       open link, no sign-in (each visitor gets a private guest workspace)':`Invite code:  ${signupCode}`}\n\n  Press Ctrl+C to stop sharing.\n`);
