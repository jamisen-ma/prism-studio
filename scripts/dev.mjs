import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const children=[
  spawn(process.execPath,['--watch','server/index.mjs'],{cwd:root,stdio:'inherit'}),
  spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','43110','--strictPort'],{cwd:root,stdio:'inherit'}),
];
let stopping=false;
function stop(code=0){if(stopping)return;stopping=true;process.exitCode=code;for(const child of children)child.kill('SIGTERM');setTimeout(()=>process.exit(code),300).unref();}
for(const child of children){child.on('error',error=>{console.error(error.message);stop(1);});child.on('exit',code=>{if(!stopping)stop(code||0);});}
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
