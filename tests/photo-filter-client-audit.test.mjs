import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transformWithOxc } from 'vite';
import { PHOTO_FILTER_DEFAULTS as REFERENCE_DEFAULTS } from './fixtures/photo-filter/reference.mjs';

const temporary=await mkdtemp(join(tmpdir(),'prism-photo-filter-client-audit-'));
after(()=>rm(temporary,{recursive:true,force:true}));
const {code}=await transformWithOxc(await readFile(new URL('../client/photo-filter.ts',import.meta.url),'utf8'),'photo-filter.ts');
await writeFile(join(temporary,'helper.mjs'),code);
const {PHOTO_FILTER_DEFAULTS,photoFilterParameters,toPhotoFilterDraft,parsePhotoFilterDraft,photoFilterColor,photoFilterDensity,photoFilterIdentity,supportsPhotoFilter,photoFilterCapabilityKey}=await import(pathToFileURL(join(temporary,'helper.mjs')).href);

test('actual Photo Filter client preserves incomplete strings and canonicalizes only valid hex and exact centipercent settings',()=>{
  assert.deepEqual(PHOTO_FILTER_DEFAULTS,REFERENCE_DEFAULTS);assert.ok(Object.isFrozen(PHOTO_FILTER_DEFAULTS));
  const sparse={color:'#ABCDEF',density:0,preserveLuminosity:false};
  assert.deepEqual(photoFilterParameters(sparse),{color:'#abcdef',density:0,preserveLuminosity:false});
  assert.deepEqual(toPhotoFilterDraft(sparse),{color:'#abcdef',density:'0',preserveLuminosity:false});
  assert.deepEqual(photoFilterParameters(),REFERENCE_DEFAULTS);
  const draft={color:'#ABCDEF',density:'+2.500e1',preserveLuminosity:false};
  assert.deepEqual(parsePhotoFilterDraft(draft),{color:'#abcdef',density:25,preserveLuminosity:false});
  assert.deepEqual(draft,{color:'#ABCDEF',density:'+2.500e1',preserveLuminosity:false});
  for(const density of ['25','025','2.5e1','25.00',' 25 '])assert.deepEqual(parsePhotoFilterDraft({...draft,density}),{color:'#abcdef',density:25,preserveLuminosity:false});
  for(const color of ['','#','#ff','#fffff','#fffffff','#abcdef\n','#abcdef\r',' #abcdef','#abcdef ','#abcdeg','abcdef']){
    const bad={...draft,color};assert.equal(photoFilterColor(color),undefined);assert.equal(parsePhotoFilterDraft(bad),null);assert.equal(bad.color,color);
  }
  for(const density of ['',' ','1e','.','NaN','Infinity','0x10','1_0','25.001','-0.01','100.01','5e-324']){
    const bad={...draft,density};assert.equal(photoFilterDensity(density),undefined);assert.equal(parsePhotoFilterDraft(bad),null);assert.equal(bad.density,density);
  }
  for(const [text,value] of [['.01',.01],['1e-2',.01],['99.99',99.99],['1e2',100],['-0',0],['.29',.29]])assert.equal(photoFilterDensity(text),value);
  assert.equal(Object.is(photoFilterDensity('-0'),-0),false);
  assert.equal(parsePhotoFilterDraft({...draft,preserveLuminosity:0}),null);
  const parsed=parsePhotoFilterDraft(draft);parsed.color='#ffffff';assert.equal(draft.color,'#ABCDEF');assert.equal(sparse.color,'#ABCDEF');
});

test('actual Photo Filter helper has scope-specific strict capability gates and stable identity semantics',()=>{
  const caps={id:'native',photoFilterPolicy:'rgb-transmission-luma-fit-v1',adjustmentKinds:['photo_filter'],layerFilterKinds:['photo_filter'],layerFilterCoordinates:'source',commands:['add_adjustment','add_layer_filter']};
  for(const scope of ['global','source']){
    const list=scope==='global'?'adjustmentKinds':'layerFilterKinds';
    assert.equal(supportsPhotoFilter(caps,'native',scope),true);
    assert.equal(supportsPhotoFilter({...caps,commands:[]},'native',scope),true,'The editor owns individual add/update command permissions');
    assert.equal(supportsPhotoFilter({...caps,[list]:['photo_filter','future']},'native',scope),true);
    for(const patch of [{id:'photoshop'},{photoFilterPolicy:undefined},{photoFilterPolicy:'future'},
      ...[undefined,null,[],false,42,'photo_filter',['temperature'],['photo_filter',false],['photo_filter',null]].map(value=>({[list]:value}))]){
      assert.equal(supportsPhotoFilter({...caps,...patch},'native',scope),false);
      assert.notEqual(photoFilterCapabilityKey({...caps,...patch}),photoFilterCapabilityKey(caps));
    }
    assert.equal(supportsPhotoFilter(undefined,'native',scope),false);assert.equal(supportsPhotoFilter(caps,'photoshop',scope),false);
  }
  assert.equal(supportsPhotoFilter({...caps,adjustmentKinds:[]},'native','source'),true);
  assert.equal(supportsPhotoFilter({...caps,layerFilterKinds:[],layerFilterCoordinates:'canvas'},'native','global'),true);
  assert.equal(supportsPhotoFilter({...caps,layerFilterCoordinates:'canvas'},'native','source'),false);
  for(const p of [{density:0},{color:'#FFFFFF',preserveLuminosity:false},{color:'#000000'},{color:'#ABABAB'}])assert.equal(photoFilterIdentity(photoFilterParameters(p)),true);
  for(const p of [{},{color:'#ababaa'},{color:'#000000',preserveLuminosity:false},{density:.01}])assert.equal(photoFilterIdentity(photoFilterParameters(p)),false);
});
