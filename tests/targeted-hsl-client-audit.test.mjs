import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transformWithOxc } from 'vite';
const temporary=await mkdtemp(join(tmpdir(),'prism-targeted-hsl-client-audit-'));
after(()=>rm(temporary,{recursive:true,force:true}));
const source=await readFile(new URL('../client/targeted-hsl.ts',import.meta.url),'utf8');
const {code}=await transformWithOxc(source,'targeted-hsl.ts');await writeFile(join(temporary,'helper.mjs'),code);
const {HSL_RANGES,targetedHSLParameters,toTargetedHSLDraft,targetedHSLNumber,invalidTargetedHSLRanges,parseTargetedHSLDraft,supportsTargetedHSL,targetedHSLCapabilityKey}=await import(pathToFileURL(join(temporary,'helper.mjs')).href);

test('actual HSL client parser preserves all21 strings and applies channel-specific exact centiunit limits',()=>{
  const sparse={master:[180,-.29,0],reds:[-180,100,-100]},effective=targetedHSLParameters(sparse),draft=toTargetedHSLDraft(sparse);
  draft.master=['+1.8e2','-.2900','-0'];draft.reds=['-180.00','1e2','-1e2'];
  assert.deepEqual(parseTargetedHSLDraft(draft),effective);assert.deepEqual(invalidTargetedHSLRanges(draft),[]);assert.equal(draft.master[0],'+1.8e2');
  assert.equal(Object.is(parseTargetedHSLDraft(draft).master[2],-0),false);
  for(const range of HSL_RANGES)for(let channel=0;channel<3;channel++){
    const invalid=structuredClone(draft);invalid[range][channel]='1e';assert.equal(parseTargetedHSLDraft(invalid),null);assert.deepEqual(invalidTargetedHSLRanges(invalid),[range]);assert.equal(invalid[range][channel],'1e');
  }
  for(const text of ['', ' ','NaN','Infinity','0x10','1_0','.001','5e-324','180.01','-180.01'])for(let c=0;c<3;c++)assert.equal(targetedHSLNumber(text,c),undefined);
  for(const text of ['100.01','180','-180']){assert.equal(targetedHSLNumber(text,0),Number(text));assert.equal(targetedHSLNumber(text,1),undefined);assert.equal(targetedHSLNumber(text,2),undefined);}
  for(const [text,value]of [['-.01',-.01],['1e-2',.01],[' 12.50 ',12.5],['100',100],['-100',-100]])for(let c=0;c<3;c++)assert.equal(targetedHSLNumber(text,c),value);
  assert.equal(targetedHSLNumber('0',3),undefined);
  const both=structuredClone(draft);both.cyans[0]='';both.magentas[2]='.001';assert.deepEqual(invalidTargetedHSLRanges(both),['cyans','magentas']);
  effective.reds[0]=50;assert.equal(sparse.reds[0],-180);const parsed=parseTargetedHSLDraft(draft);parsed.master[0]=0;assert.equal(draft.master[0],'+1.8e2');
  const defaults=toTargetedHSLDraft();defaults.reds[0]='25';assert.equal(defaults.blues[0],'0');assert.equal(toTargetedHSLDraft().reds[0],'0');
});

test('actual HSL semantic capability gates require complete typed ranges and preserve independent global/source support',()=>{
  const caps={id:'native',hueSaturationPolicy:'rgb-hue-triangle-hsl-v1',hueSaturationRanges:[...HSL_RANGES],adjustmentKinds:['hue_saturation'],layerFilterKinds:['hue_saturation'],layerFilterCoordinates:'source'};
  for(const scope of ['global','source']){
    assert.equal(supportsTargetedHSL(caps,'native',scope),true);
    assert.equal(supportsTargetedHSL({...caps,hueSaturationRanges:[...HSL_RANGES,'future']},'native',scope),true);
    for(const patch of [{hueSaturationPolicy:undefined},{hueSaturationPolicy:'future'},{hueSaturationRanges:undefined},{hueSaturationRanges:[]},{hueSaturationRanges:['future']},{hueSaturationRanges:HSL_RANGES.slice(1)},{hueSaturationRanges:[...HSL_RANGES,false]},{id:'photoshop'}]){
      assert.equal(supportsTargetedHSL({...caps,...patch},'native',scope),false);assert.notEqual(targetedHSLCapabilityKey({...caps,...patch}),targetedHSLCapabilityKey(caps));
    }
    assert.equal(supportsTargetedHSL(undefined,'native',scope),false);assert.equal(supportsTargetedHSL({...caps,id:'photoshop'},'photoshop',scope),false);
  }
  assert.equal(supportsTargetedHSL({...caps,adjustmentKinds:[]},'native','global'),false);assert.equal(supportsTargetedHSL({...caps,adjustmentKinds:[]},'native','source'),true);
  assert.equal(supportsTargetedHSL({...caps,layerFilterKinds:[]},'native','global'),true);assert.equal(supportsTargetedHSL({...caps,layerFilterKinds:[]},'native','source'),false);
  assert.equal(supportsTargetedHSL({...caps,layerFilterCoordinates:'canvas'},'native','source'),false);
});
