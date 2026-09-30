import {after,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {transformWithOxc} from 'vite';

const temporary=await mkdtemp(join(tmpdir(),'prism-selective-client-audit-'));
after(()=>rm(temporary,{recursive:true,force:true}));
const source=await readFile(new URL('../client/selective-color.ts',import.meta.url),'utf8');
const {code}=await transformWithOxc(source,'selective-color.ts');
await writeFile(join(temporary,'selective-color.mjs'),code);
const {SELECTIVE_RANGES,selectiveColorParameters,toSelectiveColorDraft,selectivePercentage,invalidSelectiveRanges,parseSelectiveColorDraft,supportsSelectiveColor,selectiveColorCapabilityKey,isPreciseColorKind}=await import(pathToFileURL(join(temporary,'selective-color.mjs')).href);

test('actual Selective client parser validates all hidden rows while retaining exact strings and canonical clean comparisons',()=>{
  const sparse={method:'absolute',reds:[12.5,-.29,0,100]},effective=selectiveColorParameters(sparse),draft=toSelectiveColorDraft(sparse);
  draft.reds=['1.250e1','-.2900','-0','+1e2'];
  assert.deepEqual(parseSelectiveColorDraft(draft),effective);assert.deepEqual(invalidSelectiveRanges(draft),[]);
  assert.deepEqual(draft.reds,['1.250e1','-.2900','-0','+1e2']);
  assert.equal(Object.is(parseSelectiveColorDraft(draft).reds[2],-0),false);
  for(const range of SELECTIVE_RANGES){
    const invalid=structuredClone(draft);invalid[range][2]='1e';
    assert.deepEqual(invalidSelectiveRanges(invalid),[range]);assert.equal(parseSelectiveColorDraft(invalid),null);assert.equal(invalid[range][2],'1e');
  }
  for(const text of ['', ' ', 'NaN','Infinity','0x10','1_0','100.01','-100.01','.001','5e-324'])assert.equal(selectivePercentage(text),undefined);
  for(const [text,value]of [['-.01',-.01],['1e-2',.01],[' 12.50 ',12.5],['100',100],['-100',-100]])assert.equal(selectivePercentage(text),value);
  const other=toSelectiveColorDraft();other.whites[0]='25';assert.equal(other.reds[0],'0');assert.equal(toSelectiveColorDraft().whites[0],'0');
  effective.reds[0]=88;assert.equal(sparse.reds[0],12.5);const parsed=parseSelectiveColorDraft(draft);parsed.reds[0]=42;assert.equal(draft.reds[0],'1.250e1');
  const both=structuredClone(draft);both.cyans[0]='';both.blacks[3]='.001';assert.deepEqual(invalidSelectiveRanges(both),['cyans','blacks']);
  assert.equal(parseSelectiveColorDraft({...draft,method:'Absolute'}),null);
});

test('actual Selective capability gates require complete typed lists and independent native global/source scope',()=>{
  const caps={id:'native',selectiveColorPolicy:'rgb-partition-cmyk-v1',selectiveColorMethods:['relative','absolute'],selectiveColorRanges:[...SELECTIVE_RANGES],adjustmentKinds:['selective_color'],layerFilterKinds:['selective_color'],layerFilterCoordinates:'source'};
  for(const scope of ['global','source']){
    assert.equal(supportsSelectiveColor(caps,'native',scope),true);
    assert.equal(supportsSelectiveColor({...caps,selectiveColorMethods:[...caps.selectiveColorMethods,'future'],selectiveColorRanges:[...caps.selectiveColorRanges,'future']},'native',scope),true);
    for(const patch of [{selectiveColorPolicy:undefined},{selectiveColorPolicy:'future'},{selectiveColorMethods:[]},{selectiveColorMethods:['relative']},{selectiveColorMethods:['relative','absolute',1]},{selectiveColorRanges:[]},{selectiveColorRanges:SELECTIVE_RANGES.slice(0,-1)},{selectiveColorRanges:[...SELECTIVE_RANGES,false]},{id:'photoshop'}]){
      assert.equal(supportsSelectiveColor({...caps,...patch},'native',scope),false);
      assert.notEqual(selectiveColorCapabilityKey({...caps,...patch}),selectiveColorCapabilityKey(caps));
    }
    assert.equal(supportsSelectiveColor(undefined,'native',scope),false);assert.equal(supportsSelectiveColor({...caps,id:'photoshop'},'photoshop',scope),false);
  }
  assert.equal(supportsSelectiveColor({...caps,adjustmentKinds:[]},'native','global'),false);assert.equal(supportsSelectiveColor({...caps,adjustmentKinds:[]},'native','source'),true);
  assert.equal(supportsSelectiveColor({...caps,layerFilterKinds:[]},'native','global'),true);assert.equal(supportsSelectiveColor({...caps,layerFilterKinds:[]},'native','source'),false);
  assert.equal(supportsSelectiveColor({...caps,layerFilterCoordinates:'canvas'},'native','source'),false);
  assert.equal(isPreciseColorKind('curves'),true);assert.equal(isPreciseColorKind('selective_color'),true);assert.equal(isPreciseColorKind('color_balance'),false);
});
