import '../server/font-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { ensureBundledFonts } from '../server/fonts.mjs';
import { validateCommand } from '../shared/commands.mjs';

test('bundled Fraunces resolves to real distinct glyphs without a system font installation',async()=>{
  await ensureBundledFonts();
  const render=family=>sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="450" height="110"><text x="10" y="85" font-family="${family}" font-size="72" font-weight="bold">AUTUMN</text></svg>`)).ensureAlpha().raw().toBuffer();
  const [retro,serif,sans]=await Promise.all([render('Fraunces'),render('serif'),render('sans-serif')]);
  assert.equal(retro.equals(sans),false,'The custom font must not silently fall back to sans serif');
  assert.equal(retro.equals(serif),false,'The custom font must not silently fall back to generic serif');
  assert.ok(retro.some((value,index)=>index%4===3&&value>0),'Visible glyphs are present');
});
test('retro serif text stays editable and survives save/reopen/undo',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'prism-font-test-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  let native=await new NativeBackend({dataDir}).init();
  let {document}=await native.execute('create_document',{width:600,height:800,name:'Cover',background:'#f5e8d5'});
  const args=validateCommand('add_text',{documentId:document.id,expectedRevision:document.revision,text:'AUTUMN\nOUTFITS',x:300,y:40,fontSize:68,fontFamily:'Fraunces',fontWeight:'bold',color:'#583b2b',align:'center'});
  ({document}=await native.execute('add_text',args));const layer=document.layers.at(-1);assert.equal(layer.type,'text');assert.equal(layer.fontFamily,'Fraunces');
  const before=await native.render(native.project(document.id));
  native=await new NativeBackend({dataDir}).init();const reopened=(await native.execute('get_document',{documentId:document.id})).document;
  assert.equal(reopened.layers.at(-1).text,'AUTUMN\nOUTFITS');assert.equal((await native.render(native.project(document.id))).equals(before),true);
  await native.execute('update_text',{documentId:document.id,expectedRevision:reopened.revision,layerId:layer.id,text:'LAYERED\nDESIGN',fontStyle:'italic'});
  assert.equal((await native.render(native.project(document.id))).equals(before),false);
  await native.execute('undo',{documentId:document.id});assert.equal((await native.render(native.project(document.id))).equals(before),true);
});
