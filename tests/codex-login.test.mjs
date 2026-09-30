import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cancelCodexLogin, codexLoginOwner, codexLoginProgress, codexLoginStatus, logoutCodex, startCodexLogin } from '../server/codex-login.mjs';

// All logins use a FAKE codex binary and temp CODEX_HOME dirs; no real ChatGPT sign-in runs.
const codexBin = fileURLToPath(new URL('./fixtures/codex-login/fake-codex.mjs', import.meta.url));
await fs.chmod(codexBin, 0o755);

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-codex-login-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function home(root, name, config) {
  const dir = path.join(root, name);
  if (config) { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'fake-mode.json'), JSON.stringify(config)); }
  return dir;
}
async function waitFor(id, predicate = state => state !== 'pending', ms = 5000) {
  const end = Date.now() + ms;
  let progress;
  while (Date.now() < end) { progress = codexLoginProgress(id); if (predicate(progress.state)) return progress; await new Promise(resolve => setTimeout(resolve, 25)); }
  return progress;
}
const calls = async dir => (await fs.readFile(path.join(dir, 'calls.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));

test('start -> pending -> connected, with status reporting the account', async t => {
  const root = await tempRoot(t), codexHome = await home(root, 'alice', { mode: 'approve', delayMs: 300 });
  assert.deepEqual(await codexLoginStatus({ codexHome, codexBin }), { connected: false });
  const started = await startCodexLogin({ codexHome, codexBin });
  assert.match(started.id, /^[0-9a-f-]{36}$/);
  assert.equal(started.verificationUrl, 'https://auth.openai.com/codex/device');
  assert.equal(started.userCode, 'FAKE-C0DE9');
  assert.ok(Date.parse(started.expiresAt) > Date.now() + 14 * 60_000, 'Expires about 15 minutes out.');
  assert.equal(codexLoginOwner(started.id), path.resolve(codexHome));
  assert.deepEqual(codexLoginProgress(started.id), { state: 'pending' });
  assert.equal((await fs.stat(codexHome)).mode & 0o777, 0o700, 'CODEX_HOME is private.');
  assert.deepEqual(await waitFor(started.id), { state: 'connected' });
  assert.deepEqual(await codexLoginStatus({ codexHome, codexBin }), { connected: true, account: 'alice@example.com' });
  const log = await calls(codexHome);
  assert.deepEqual(log[0].args, ['login', '--device-auth', '-c', 'cli_auth_credentials_store="file"']);
  assert.ok(log.every(call => call.codexHome === path.resolve(codexHome)));
});

test('logout removes credentials and reports disconnected', async t => {
  const root = await tempRoot(t), codexHome = await home(root, 'bob', { delayMs: 50 });
  const { id } = await startCodexLogin({ codexHome, codexBin });
  assert.equal((await waitFor(id)).state, 'connected');
  assert.equal((await codexLoginStatus({ codexHome, codexBin })).connected, true);
  assert.deepEqual(await logoutCodex({ codexHome, codexBin }), { connected: false });
  await assert.rejects(fs.access(path.join(codexHome, 'auth.json')));
  assert.deepEqual(await codexLoginStatus({ codexHome, codexBin }), { connected: false });
  assert.ok((await calls(codexHome)).some(call => call.args[0] === 'logout'));
});

test('cancel stops a pending device login', async t => {
  const root = await tempRoot(t), codexHome = await home(root, 'carol', { mode: 'never' });
  const { id } = await startCodexLogin({ codexHome, codexBin });
  assert.equal(codexLoginProgress(id).state, 'pending');
  assert.equal(cancelCodexLogin(id), true);
  assert.equal(cancelCodexLogin(id), false, 'Cancelling twice is a no-op.');
  assert.equal(codexLoginProgress(id).state, 'expired', 'A cancelled id is no longer active.');
  await new Promise(resolve => setTimeout(resolve, 200));
  await assert.rejects(fs.access(path.join(codexHome, 'auth.json')));
  assert.deepEqual(await codexLoginStatus({ codexHome, codexBin }), { connected: false });
});

test('starting again for the same user replaces the earlier pending login', async t => {
  const root = await tempRoot(t), codexHome = await home(root, 'dave', { mode: 'never' });
  const first = await startCodexLogin({ codexHome, codexBin });
  const second = await startCodexLogin({ codexHome, codexBin });
  assert.notEqual(first.id, second.id);
  assert.equal(codexLoginProgress(first.id).state, 'expired');
  assert.equal(codexLoginProgress(second.id).state, 'pending');
  cancelCodexLogin(second.id);
});

test('abandoned logins expire on the server timeout, and CLI-reported expiry maps to expired', async t => {
  const root = await tempRoot(t);
  const idle = await home(root, 'erin', { mode: 'never' });
  const started = await startCodexLogin({ codexHome: idle, codexBin, timeoutMs: 300 });
  assert.ok(Date.parse(started.expiresAt) - Date.now() < 1000);
  const timedOut = await waitFor(started.id);
  assert.equal(timedOut.state, 'expired'); assert.match(timedOut.message, /expired/i);

  const cliExpired = await home(root, 'frank', { mode: 'expire', delayMs: 100 });
  const { id } = await startCodexLogin({ codexHome: cliExpired, codexBin });
  const progress = await waitFor(id);
  assert.equal(progress.state, 'expired');
  assert.doesNotMatch(progress.message, /device code expired/, 'Raw CLI output is not echoed.');
});

test('failures: CLI without --device-auth, missing binary, missing codexHome', async t => {
  const root = await tempRoot(t);
  await assert.rejects(startCodexLogin({ codexHome: await home(root, 'old', { mode: 'old' }), codexBin }), error => error.code === 'CODEX_LOGIN_FAILED' && /too old/.test(error.message));
  await assert.rejects(startCodexLogin({ codexHome: path.join(root, 'nobin'), codexBin: path.join(root, 'missing-codex') }), { code: 'CODEX_LOGIN_FAILED' });
  await assert.rejects(startCodexLogin({ codexBin }), { code: 'INVALID_ARGUMENTS' }, 'Never falls back to ~/.codex.');
  await assert.rejects(codexLoginStatus({ codexBin }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(logoutCodex({}), { code: 'INVALID_ARGUMENTS' });
  assert.equal(codexLoginProgress('not-a-real-id').state, 'expired');
});

test('two users stay isolated in their own CODEX_HOME', async t => {
  const root = await tempRoot(t);
  const a = await home(root, 'user-a', { delayMs: 100 }), b = await home(root, 'user-b', { mode: 'never' });
  const loginA = await startCodexLogin({ codexHome: a, codexBin }), loginB = await startCodexLogin({ codexHome: b, codexBin });
  assert.equal((await waitFor(loginA.id)).state, 'connected');
  assert.equal(codexLoginProgress(loginB.id).state, 'pending', 'B is unaffected by A approving.');
  assert.deepEqual(await codexLoginStatus({ codexHome: a, codexBin }), { connected: true, account: 'user-a@example.com' });
  assert.deepEqual(await codexLoginStatus({ codexHome: b, codexBin }), { connected: false });
  await assert.rejects(fs.access(path.join(b, 'auth.json')));
  assert.ok((await calls(a)).every(call => call.codexHome === path.resolve(a)));
  assert.ok((await calls(b)).every(call => call.codexHome === path.resolve(b)));
  await logoutCodex({ codexHome: b, codexBin });
  assert.equal(codexLoginProgress(loginB.id).state, 'expired', 'Logging B out cancels its pending login.');
  assert.equal((await codexLoginStatus({ codexHome: a, codexBin })).connected, true, 'Logging B out leaves A connected.');
});
