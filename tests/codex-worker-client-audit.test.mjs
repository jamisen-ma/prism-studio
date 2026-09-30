import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, root: new URL('..', import.meta.url).pathname, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
let codexJobPresentation;
try { ({ codexJobPresentation } = await server.ssrLoadModule('/client/generation.ts')); }
finally { await server.close(); }

test('actual worker UI never offers manual handoff for an automatic job, including unavailable and interrupted workers', () => {
  const base = { status: 'awaiting_image', provider: 'codex', model: 'codex-imagegen' };
  for (const state of ['queued', 'generating', 'returning', 'interrupted', 'failed']) {
    for (const worker of [undefined, { enabled: false, available: false, state: 'unavailable' }, { enabled: true, available: false, state: 'checking' }, { enabled: true, available: true, state: 'ready' }]) {
      const result = codexJobPresentation({ ...base, automation: { state } }, worker);
      assert.equal(result.manualHandoff, false);
      assert.equal(result.spinning, state === 'generating' || state === 'returning');
      assert.equal(result.stopped, state === 'interrupted' || state === 'failed');
    }
  }
  for (const state of ['ready', 'working', 'unavailable']) assert.equal(codexJobPresentation(base, { enabled: true, available: true, state }).manualHandoff, true, 'Unmarked legacy handoff stays manual.');
  assert.equal(codexJobPresentation({ ...base, status: 'ready' }), null);
  assert.equal(codexJobPresentation({ ...base, provider: 'openai', model: 'gpt-image-1' }), null);
});
