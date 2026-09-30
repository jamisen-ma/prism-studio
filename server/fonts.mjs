import './font-environment.mjs';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
let loaded;
export function ensureBundledFonts(){
  if(!loaded)loaded=(async()=>{
    for(const file of ['Fraunces.ttf','Fraunces-Italic.ttf']){
      // fonts.conf makes these available to SVG rendering. Registering a second
      // Pango text font map can change generic-family resolution on macOS.
      await fs.access(fileURLToPath(new URL(`../assets/fonts/${file}`,import.meta.url)));
    }
  })().catch(cause=>{loaded=undefined;throw cause;});
  return loaded;
}
