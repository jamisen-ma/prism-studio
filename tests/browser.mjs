import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { createCompanion } from '../server/index.mjs';

const artifacts=path.resolve('test-results');await fs.mkdir(artifacts,{recursive:true});
const fixture=path.join(artifacts,'browser-fixture.png');
await sharp({create:{width:320,height:240,channels:4,background:'#69859b'}}).png().toFile(fixture);
const testData=await fs.mkdtemp(path.join(os.tmpdir(),'prism-browser-'));
const companion=process.env.PRISM_UI_URL?null:await createCompanion({dataDir:testData,port:0});
const companionPort=companion?await companion.listen():null;
const browser=await chromium.launch({headless:true,...(process.platform==='darwin'?{channel:'chrome'}:{})});
const page=await browser.newPage({viewport:{width:1536,height:1000},deviceScaleFactor:1});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
async function current(){
  return page.evaluate(async()=>{
    const token=(await(await fetch('/api/session')).json()).token;
    const id=document.querySelector('select[aria-label="Open document"]').value;
    const response=await fetch('/api/command',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({backend:'native',command:'get_document',args:{documentId:id}})});
    const data=await response.json();if(!data.ok)throw new Error(data.error.message);return data.result.document;
  });
}
async function waitFor(predicate,message){
  const deadline=Date.now()+15_000;
  while(Date.now()<deadline){if(await predicate())return;await page.waitForTimeout(100);}
  throw new Error(message);
}
async function settled(){await waitFor(async()=>!(await page.locator('.save-status .spin').count()),'Editing did not settle');}
try{
  await page.goto(process.env.PRISM_UI_URL||`http://127.0.0.1:${companionPort}`,{waitUntil:'networkidle'});
  await page.locator('.artboard img').waitFor({state:'visible',timeout:30_000});
  await page.screenshot({path:path.join(artifacts,'workspace.png'),fullPage:true});
  assert.equal(await page.getByRole('alert').count(),0,'Initial workspace should have no error');
  await page.getByLabel('Import image file').setInputFiles(fixture);
  await waitFor(async()=>(await current()).name==='browser-fixture.png','Import should create a new document even with one already open');
  await settled();
  let doc=await current();assert.equal(doc.width,320);assert.equal(doc.height,240);
  const originalLayers=doc.layers.length;
  await page.locator('.inspector-tabs').getByRole('button',{name:'Adjustments',exact:true}).click();
  await page.getByRole('button',{name:/A touch of contrast/}).click();
  await waitFor(async()=>(await current()).layers.length===originalLayers+1,'Contrast adjustment should add an actual layer');
  await settled();
  await page.getByRole('button',{name:'Undo (⌘Z)',exact:true}).click();
  await waitFor(async()=>(await current()).layers.length===originalLayers,'Undo should remove adjustment layer');
  await settled();
  await page.getByRole('button',{name:'Rectangle selection (M)',exact:true}).click();
  const rect=await page.locator('.artboard').boundingBox();
  await page.mouse.move(rect.x+rect.width*.2,rect.y+rect.height*.2);await page.mouse.down();
  await page.mouse.move(rect.x+rect.width*.65,rect.y+rect.height*.65,{steps:8});await page.mouse.up();
  await waitFor(async()=>Boolean((await current()).selection),'Drawn selection should exist in backend');
  await settled();
  await page.getByRole('button',{name:/A touch of contrast/}).click();
  await waitFor(async()=>(await current()).layers.length===originalLayers+1,'Masked adjustment should apply');await settled();
  await page.getByRole('button',{name:'Undo (⌘Z)',exact:true}).click();
  await waitFor(async()=>(await current()).layers.length===originalLayers,'Masked adjustment should undo');await settled();
  assert.ok((await current()).selection,'Undo retains the previous selection');
  assert.ok(await page.locator('.canvas-selection').count(),'UI shows the selection after undo');
  await page.getByRole('button',{name:'Deselect',exact:true}).click();await waitFor(async()=>!(await current()).selection,'Deselect clears backend state');await settled();
  await page.getByRole('button',{name:/^File/}).click();
  await page.getByRole('button',{name:/Save project/}).click();
  await page.getByText('Project saved.',{exact:true}).waitFor();
  await page.getByRole('button',{name:/^File/}).click();
  await page.getByRole('button',{name:/New canvas/}).click();
  const modal=page.getByRole('dialog');
  await modal.getByLabel('Document name').fill('Browser verified canvas');
  await modal.getByLabel('Width, px').fill('640');await modal.getByLabel('Height, px').fill('480');
  await modal.getByRole('button',{name:'Create canvas'}).click();
  await waitFor(async()=>(await current()).name==='Browser verified canvas','New canvas should be created');await settled();
  await page.locator('.inspector-tabs').getByRole('button',{name:'Layers',exact:true}).click();
  await page.getByRole('button',{name:'Add text',exact:true}).click();
  await page.getByRole('dialog').getByLabel('Your text').fill('Prism works');
  await page.getByRole('button',{name:'Add text layer',exact:true}).click();
  await waitFor(async()=>(await current()).layers.some(l=>l.type==='text'),'Add text must create an editable layer');await settled();
  await page.locator('.export-header').click();
  const downloading=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download PNG'}).click();
  const download=await downloading;const exported=path.join(artifacts,'browser-export.png');await download.saveAs(exported);
  const metadata=await sharp(exported).metadata();assert.equal(metadata.width,640);assert.equal(metadata.height,480);
  await page.screenshot({path:path.join(artifacts,'edited-workspace.png'),fullPage:true});
  await page.locator('.backend-button').click();
  await page.locator('.backend-popover').getByRole('button',{name:/Adobe Photoshop/}).click();
  await page.getByRole('button',{name:'Connect Photoshop',exact:true}).waitFor();
  await page.getByRole('button',{name:'Connect Photoshop',exact:true}).click();
  await page.getByText('Waiting for the Photoshop plugin',{exact:true}).waitFor();
  await page.screenshot({path:path.join(artifacts,'photoshop-setup.png'),fullPage:true});
  await page.getByRole('button',{name:'Close dialog'}).click();
  await page.setViewportSize({width:900,height:800});
  await page.screenshot({path:path.join(artifacts,'compact-workspace.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,'Compact layout should not overflow horizontally');
  assert.deepEqual(errors,[],'No uncaught browser errors');
  console.log('Browser checks passed: import, actual adjustment layers, undo, selection recovery, save, create, editable text, PNG export, disconnected Photoshop setup, compact layout.');
  console.log(`Screenshots: ${artifacts}`);
}finally{await browser.close();if(companion)await companion.close();await fs.rm(testData,{recursive:true,force:true});}
