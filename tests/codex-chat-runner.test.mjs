import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createCodexChatRunner } from '../server/codex-chat-runner.mjs';

const id = '01234567-89ab-cdef-0123-456789abcdef';
const toolContext = { turnId: id, baseUrl: 'http://127.0.0.1:12345', capabilityToken: 'a'.repeat(64) };
const turn = { id, message: 'Warm the current photo and add editable text.', documentId: 'document-one' };
const lines = value => value.map(item => JSON.stringify(item)).join('\n');
const completed = [{ type: 'thread.started', thread_id: id }, { type: 'item.completed', item: { type: 'agent_message', text: 'Added an editable warmth adjustment.' } }, { type: 'turn.completed' }];
async function fixture(t) { const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-chat-runner-test-')); t.after(() => fs.rm(workDir, { recursive: true, force: true })); return { workDir, turn, toolContext, history: [{ role: 'assistant', content: 'Previous output', resultDocumentId: 'prior-result' }] }; }
function fakeChild() {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { queueMicrotask(() => child.emit('close', null)); return true; }; return child;
}
const imageEvent = data => ({ type: 'item.completed', item: { id: 'preview', type: 'mcp_tool_call', server: 'prism', tool: 'prism_execute', status: 'completed', arguments: { name: 'get_preview', args: { documentId: 'synthetic-document' } }, result: { content: [{ type: 'image', mimeType: 'image/png', data }] } } });

test('chat runner uses only private MCP, sends context without credentials, and removes its capability file', async t => {
  const fixtureArgs = await fixture(t); let observed, input = '';
  fixtureArgs.turn = { ...fixtureArgs.turn, attachments: [{ documentId: 'current-attachment', name: 'New reference.png', data: 'untrusted-image-bytes' }] };
  fixtureArgs.history.unshift({ role: 'user', content: 'Use this reference', attachments: [{ documentId: 'historical-attachment', name: 'Earlier reference.png', data: 'historical-image-bytes' }] });
  const runner = createCodexChatRunner({ spawnProcess: (executable, args, options) => {
    const child = fakeChild(); observed = { executable, args, options };
    child.stdin.on('data', bytes => { input += bytes; });
    child.stdin.on('end', () => { child.stdout.write(lines(completed)); child.emit('close', 0); }); return child;
  } });
  assert.deepEqual(await runner.run(fixtureArgs), { reply: 'Added an editable warmth adjustment.' });
  assert.equal(observed.options.shell, false);
  assert.ok(observed.args.includes('--ignore-user-config')); assert.ok(observed.args.includes('image_generation')); assert.ok(observed.args.includes('shell_tool'));
  assert.ok(observed.args.some(arg => arg.startsWith('mcp_servers.prism.args=')));
  assert.ok(!observed.args.some(arg => arg.includes(toolContext.capabilityToken))); assert.ok(!input.includes(toolContext.capabilityToken));
  assert.ok(input.includes('prior-result')); assert.ok(input.includes(turn.message)); assert.ok(input.includes('prism_generate_image'));
  const context = JSON.parse(input.split('\n\n').at(-1));
  assert.deepEqual(context.current.attachments, [{ documentId: 'current-attachment', name: 'New reference.png' }]);
  assert.deepEqual(context.history[0].attachments, [{ documentId: 'historical-attachment', name: 'Earlier reference.png' }]);
  assert.ok(input.includes('get_document and get_preview')); assert.ok(input.includes('use its documentId and fresh revision'));
  assert.ok(input.includes('maxWidth: 700')); assert.ok(input.includes('reuse an already inspected preview while that document is unchanged'));
  assert.ok(!input.includes('untrusted-image-bytes')); assert.ok(!input.includes('historical-image-bytes'));
  await assert.rejects(fs.stat(path.join(fixtureArgs.workDir, 'mcp-context.json')), { code: 'ENOENT' });
});

test('chat runner rejects failed, malformed and incomplete receipts without exposing process output', async t => {
  const inputs = ['bad secret log', lines(completed.slice(0, 2)), lines([...completed, { type: 'turn.failed', error: 'private-secret' }]), lines([completed[0], completed[0], ...completed.slice(1)]), 'x'.repeat(8 * 1024 * 1024 + 1)];
  for (const input of inputs) {
    const fixtureArgs = await fixture(t);
    const runner = createCodexChatRunner({ spawnProcess: () => { const child = fakeChild(); child.stdin.on('finish', () => { child.stdout.write(input); child.emit('close', 0); }); return child; } });
    await assert.rejects(runner.run(fixtureArgs), cause => !/private-secret|secret log/.test(cause.message));
    await assert.rejects(fs.stat(path.join(fixtureArgs.workDir, 'mcp-context.json')), { code: 'ENOENT' });
  }
});

test('chat runner streams repeated image receipts beyond the old aggregate limit including one maximum native preview', async t => {
  const fixtureArgs = await fixture(t); let totalBytes = 0, kills = 0;
  const runner = createCodexChatRunner({ spawnProcess: () => {
    const child = fakeChild(), kill = child.kill; child.kill = signal => { kills++; return kill(signal); };
    child.stdin.on('finish', () => {
      const write = value => {
        const bytes = Buffer.from(`${JSON.stringify(value)}\n`); totalBytes += bytes.length;
        // Deliberately split base64 JSON across pipe-sized chunks. Each event
        // is released before creating the next synthetic preview receipt.
        for (let offset = 0; offset < bytes.length; offset += 32749) child.stdout.write(bytes.subarray(offset, offset + 32749));
      };
      write(completed[0]);
      for (let i = 0; i < 5; i++) write(imageEvent(Buffer.alloc(2 * 1024 * 1024, i).toString('base64')));
      write(imageEvent(Buffer.alloc(8 * 1024 * 1024, 1).toString('base64')));
      child.stderr.write('Diagnostic text that is discarded.\n');
      write(completed[1]); child.stdout.write(JSON.stringify(completed[2])); child.emit('close', 0);
    });
    return child;
  } });
  assert.deepEqual(await runner.run(fixtureArgs), { reply: completed[1].item.text });
  assert.ok(totalBytes > 24 * 1024 * 1024); assert.equal(kills, 0);
  await assert.rejects(fs.stat(path.join(fixtureArgs.workDir, 'mcp-context.json')), { code: 'ENOENT' });
});

test('chat runner frames multiple events from one chunk and preserves split UTF-8 through a final unterminated line', async t => {
  const fixtureArgs = await fixture(t), reply = 'Réglé 🙂 漢字 — café';
  const runner = createCodexChatRunner({ spawnProcess: () => {
    const child = fakeChild();
    child.stdin.on('finish', () => {
      child.stdout.write(`${JSON.stringify(completed[0])}\n\n${JSON.stringify({ type: 'turn.started' })}\r\n`);
      const bytes = Buffer.from(lines([{ type: 'item.completed', item: { type: 'agent_message', text: reply } }, completed[2]]));
      // Every multibyte character crosses at least one subprocess chunk.
      for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
      child.emit('close', 0);
    }); return child;
  } });
  assert.deepEqual(await runner.run(fixtureArgs), { reply });
});

test('chat runner rejects oversized incomplete events, metadata and diagnostic streams with a safe output-limit reason', async t => {
  for (const kind of ['incomplete', 'metadata', 'stderr']) {
    const fixtureArgs = await fixture(t); let kills = 0;
    const runner = createCodexChatRunner({ spawnProcess: () => {
      const child = fakeChild(), kill = child.kill; child.kill = signal => { kills++; return kill(signal); };
      child.stdin.on('finish', () => {
        child.stdout.write(`${JSON.stringify(completed[0])}\n`);
        if (kind === 'incomplete') {
          child.stdout.write('{"type":"item.completed","item":{"type":"mcp_tool_call","private":"');
          const chunk = Buffer.alloc(64 * 1024, 0x78);
          for (let i = 0; i < 256; i++) child.stdout.write(chunk);
        } else if (kind === 'metadata') child.stdout.write(`${JSON.stringify({ type: 'unknown.metadata', private: 'x'.repeat(1024 * 1024) })}\n`);
        else child.stderr.write(Buffer.alloc(2 * 1024 * 1024 + 1, 0x78));
        // Data arriving after rejection cannot restore a successful result.
        child.stdout.write(lines(completed.slice(1))); child.emit('close', 0);
      }); return child;
    } });
    await assert.rejects(runner.run(fixtureArgs), cause => cause.code === 'CHAT_OUTPUT_LIMIT' && !cause.message.includes('private'));
    assert.equal(kills, 1);
    await assert.rejects(fs.stat(path.join(fixtureArgs.workDir, 'mcp-context.json')), { code: 'ENOENT' });
  }
});

test('chat runner gives fixed safe reasons for malformed UTF-8, invalid receipts, agent failures and process failures', async t => {
  const cases = [
    { chunks: [Buffer.from('{"type":"item.completed","item":{"type":"agent_message","text":"'), Buffer.from([0xc3]), Buffer.from([0x28]), Buffer.from('"}}\n')], code: 'CHAT_INVALID_RECEIPT' },
    { chunks: [Buffer.from('{"type":"truncated-'), Buffer.from([0xe2, 0x82])], code: 'CHAT_INVALID_RECEIPT' },
    { chunks: [Buffer.from('null\n')], code: 'CHAT_INVALID_RECEIPT' },
    { chunks: [Buffer.from(`${JSON.stringify(completed[0])}\n${JSON.stringify(completed[0])}\n`)], code: 'CHAT_INVALID_RECEIPT' },
    { chunks: [Buffer.from(lines([completed[0], { type: 'turn.failed', error: { message: 'private-provider-message' } }]))], code: 'CHAT_AGENT_FAILED' },
    { chunks: [Buffer.from(lines([completed[0], { type: 'error', message: 'private-provider-message' }]))], code: 'CHAT_AGENT_FAILED' },
    { chunks: [Buffer.from(lines(completed))], exitCode: 7, code: 'CHAT_PROCESS_FAILED' },
    { chunks: [Buffer.from(lines(completed.slice(0, 2)))], code: 'CHAT_INCOMPLETE_REPLY' },
    { chunks: [], spawnThrows: true, code: 'CHAT_START_FAILED' },
    { chunks: [], childError: true, code: 'CHAT_START_FAILED' },
  ];
  for (const entry of cases) {
    const fixtureArgs = await fixture(t);
    const runner = createCodexChatRunner({ spawnProcess: () => {
      if (entry.spawnThrows) throw new Error('private-executable-path');
      const child = fakeChild(); child.stdin.on('finish', () => {
        for (const bytes of entry.chunks) child.stdout.write(bytes);
        if (entry.childError) child.emit('error', new Error('private-executable-path'));
        child.emit('close', entry.exitCode ?? 0);
      }); return child;
    } });
    await assert.rejects(runner.run(fixtureArgs), cause => cause.code === entry.code && !/private-provider-message|private-executable-path/.test(cause.message));
    await assert.rejects(fs.stat(path.join(fixtureArgs.workDir, 'mcp-context.json')), { code: 'ENOENT' });
  }
});

test('chat runner cancellation after image events ignores late successful receipts', async t => {
  const fixtureArgs = await fixture(t), controller = new AbortController(); let killed = false;
  const runner = createCodexChatRunner({ spawnProcess: () => {
    const child = fakeChild(), kill = child.kill; child.kill = signal => { killed = true; return kill(signal); };
    child.stdin.on('finish', () => {
      child.stdout.write(`${JSON.stringify(completed[0])}\n`);
      child.stdout.write(`${JSON.stringify(imageEvent(Buffer.alloc(1024 * 1024).toString('base64')))}\n`);
      controller.abort(); child.stdout.write(lines(completed.slice(1))); child.emit('close', 0);
    }); return child;
  } });
  await assert.rejects(runner.run({ ...fixtureArgs, signal: controller.signal }), { code: 'CHAT_CANCELLED' }); assert.equal(killed, true);
  await assert.rejects(fs.stat(path.join(fixtureArgs.workDir, 'mcp-context.json')), { code: 'ENOENT' });
});

test('chat runner allows advisory errors to recover only through a later completed turn and successful process exit', async t => {
  const warning = { type: 'error', message: 'Reconnecting... 1/5 (private diagnostic)' };
  const cases = [
    { events: [completed[0], warning, imageEvent('YQ=='), completed[1], completed[2]] },
    // Recovery follows protocol receipts, not English reconnect matching.
    { events: [completed[0], { type: 'error', message: 'private unclassified diagnostic' }, completed[1], completed[2]] },
    { events: [...completed, warning, completed[2]] },
    { events: [...completed, warning], code: 'CHAT_AGENT_FAILED' },
    { events: [completed[0], warning, completed[1]], code: 'CHAT_AGENT_FAILED' },
    { events: [completed[0], warning, completed[1], { type: 'turn.failed', error: { message: 'private terminal failure' } }, completed[2]], code: 'CHAT_AGENT_FAILED' },
    { events: [...completed, warning, { type: 'turn.failed' }], code: 'CHAT_AGENT_FAILED' },
    { events: [completed[0], warning, completed[1], completed[2]], exitCode: 9, code: 'CHAT_PROCESS_FAILED' },
    { events: [completed[0], warning, completed[2]], code: 'CHAT_INCOMPLETE_REPLY' },
  ];
  for (const entry of cases) {
    const fixtureArgs = await fixture(t); let kills = 0;
    const runner = createCodexChatRunner({ spawnProcess: () => {
      const child = fakeChild(), kill = child.kill; child.kill = signal => { kills++; return kill(signal); };
      child.stdin.on('finish', () => { child.stdout.write(lines(entry.events)); child.emit('close', entry.exitCode ?? 0); }); return child;
    } });
    if (entry.code) await assert.rejects(runner.run(fixtureArgs), cause => cause.code === entry.code && !cause.message.includes('private'));
    else { assert.deepEqual(await runner.run(fixtureArgs), { reply: completed[1].item.text }); assert.equal(kills, 0); }
    await assert.rejects(fs.stat(path.join(fixtureArgs.workDir, 'mcp-context.json')), { code: 'ENOENT' });
  }
});

test('cancel and timeout stop actual dummy subprocesses and revoke the local capability file', { timeout: 10000 }, async t => {
  for (const kind of ['cancel', 'timeout']) {
    const fixtureArgs = await fixture(t); let pid, ready;
    const started = new Promise(resolve => { ready = resolve; });
    const runner = createCodexChatRunner({ timeoutMs: kind === 'timeout' ? 60 : 2000, spawnProcess: (_exe, _args, options) => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options); pid = child.pid; child.on('spawn', ready); return child;
    } });
    const controller = new AbortController();
    const rejected = assert.rejects(runner.run({ ...fixtureArgs, signal: controller.signal }), { code: kind === 'cancel' ? 'CHAT_CANCELLED' : 'CHAT_TIMEOUT' });
    await started; if (kind === 'cancel') controller.abort(); await rejected;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    await assert.rejects(fs.stat(path.join(fixtureArgs.workDir, 'mcp-context.json')), { code: 'ENOENT' });
  }
});
