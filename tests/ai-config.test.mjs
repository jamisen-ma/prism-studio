import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {readOpenAIKey,saveOpenAIKey} from '../server/ai-config.mjs';
import {validateGeneration} from '../shared/generation.mjs';

test('AI key configuration stays private, rotates, and never appears in errors',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'prism-ai-config-'));
  const previous=process.env.OPENAI_API_KEY;delete process.env.OPENAI_API_KEY;
  t.after(async()=>{if(previous!==undefined)process.env.OPENAI_API_KEY=previous;else delete process.env.OPENAI_API_KEY;await fs.rm(directory,{recursive:true,force:true});});
  assert.equal(await readOpenAIKey(directory),null);
  const key='sk-test-'+ 'x'.repeat(30);
  await saveOpenAIKey(directory,key);assert.equal(await readOpenAIKey(directory),key);
  assert.equal((await fs.stat(path.join(directory,'secrets','openai-api-key'))).mode&0o777,0o600);
  assert.equal((await fs.stat(path.join(directory,'secrets'))).mode&0o777,0o700);
  await saveOpenAIKey(directory,key+'y');assert.equal(await readOpenAIKey(directory),key+'y');
  await assert.rejects(()=>saveOpenAIKey(directory,'private invalid value'),error=>!error.message.includes('private invalid value'));
  process.env.OPENAI_API_KEY='invalid environment secret';
  await assert.rejects(()=>readOpenAIKey(directory),error=>!error.message.includes('invalid environment secret'));
});

test('generation schema requires explicit document revision and model-supported quality',()=>{
  assert.equal(validateGeneration({mode:'generate',prompt:'  A lavender ceramic vase  '}).prompt,'A lavender ceramic vase');
  for(const args of [
    {mode:'edit',prompt:'edit'},
    {mode:'generate',prompt:'generate',documentId:'doc'},
    {mode:'generate',prompt:'generate',scope:'selection'},
    {provider:'openai',mode:'generate',prompt:'generate',model:'gpt-image-2',quality:'max'},
    {mode:'generate',prompt:'generate',apiKey:'not-accepted'},
  ])assert.throws(()=>validateGeneration(args),{code:'INVALID_ARGUMENTS'});
  assert.equal(validateGeneration({mode:'edit',prompt:'Add flowers',documentId:'doc',expectedRevision:1,scope:'selection'}).scope,'selection');
});
