import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDeviceAuthOutput } from '../server/codex-login.mjs';
import { hostedFixture, client } from './hosted-helpers.mjs';

// Captured from `codex login --device-auth` (codex-cli 0.159.1), code altered.
const DEVICE_OUTPUT = '\nWelcome to Codex [v\u001b[90m0.159.1\u001b[0m]\n\u001b[90mOpenAI\'s command-line coding agent\u001b[0m\n\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n\n2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\n   \u001b[94mABCD-EFGHJ\u001b[0m\n\n\u001b[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.\u001b[0m\n';

test('device-auth output parsing accepts only OpenAI HTTPS verification pages', () => {
  assert.deepEqual(parseDeviceAuthOutput(DEVICE_OUTPUT), { url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGHJ' });
  assert.equal(parseDeviceAuthOutput('Open https://auth.openai.com/codex/device'), null, 'A code is required.');
  assert.equal(parseDeviceAuthOutput(DEVICE_OUTPUT.replace('auth.openai.com', 'auth.openai.com.evil.example')), null);
  assert.equal(parseDeviceAuthOutput(DEVICE_OUTPUT.replace('https://', 'http://')), null);
  assert.equal(parseDeviceAuthOutput(DEVICE_OUTPUT.replace('auth.openai.com', 'user:pw@auth.openai.com')), null);
});

// Shared fake CLI (mimics codex-cli 0.159.1); behaviour per CODEX_HOME via fake-mode.json.
const executable = fileURLToPath(new URL('./fixtures/codex-login/fake-codex.mjs', import.meta.url));
const FAKE_CODE = 'FAKE-C0DE9';

test('hosted Connect Codex runs device auth in that user’s own CODEX_HOME and gates Codex checks', async t => {
  let checks = 0;
  const adapter = { check: async () => { checks++; return { available: true }; }, generate: async () => Buffer.alloc(0), run: async () => ({ reply: 'unused' }) };
  const { base, server, dataRoot } = await hostedFixture(t, { codexExecutable: executable, codexImageAdapter: adapter, chatAdapter: adapter });
  const a = client(base), b = client(base);
  await a.signUp('a@example.com'); await b.signUp('b@example.com');
  const chat = await a.request('GET', '/api/chat');
  assert.equal(chat.data.available, false);
  assert.equal(checks, 0, 'No Codex check runs for an account without credentials.');
  const started = await a.request('POST', '/api/codex/login', { body: {} });
  assert.equal(started.status, 200);
  assert.deepEqual({ url: started.data.verificationUrl, code: started.data.userCode }, { url: 'https://auth.openai.com/codex/device', code: FAKE_CODE });
  assert.ok(Date.parse(started.data.expiresAt) > Date.now());
  let progress;
  for (let i = 0; i < 50; i++) { progress = (await a.request('GET', `/api/codex/login/${started.data.id}`)).data; if (progress.state !== 'pending') break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal(progress.state, 'connected');
  assert.equal((await a.request('GET', '/api/codex/status')).data.connected, true);
  const [userA, userB] = [...server.users.values()].sort((x, y) => x.email.localeCompare(y.email));
  const homeA = path.join(dataRoot, 'users', userA.id, 'codex-home'), homeB = path.join(dataRoot, 'users', userB.id, 'codex-home');
  assert.ok((await fs.stat(path.join(homeA, 'auth.json'))).size > 0);
  assert.equal((await a.request('GET', '/api/codex/status')).data.account, `codex-home@example.com`);
  await assert.rejects(fs.access(path.join(homeB, 'auth.json')));
  assert.match(await fs.readFile(path.join(homeA, 'calls.log'), 'utf8'), /"login","--device-auth","-c","cli_auth_credentials_store=\\"file\\""/);
  for (let i = 0; i < 20 && !(await a.request('GET', '/api/chat')).data.available; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await a.request('GET', '/api/chat')).data.available, true, 'Chat becomes available after connecting.');
  assert.ok(checks > 0);
  assert.equal((await b.request('GET', '/api/codex/status')).data.connected, false, 'Another account stays disconnected.');
  assert.equal((await b.request('GET', '/api/chat')).data.available, false);
  const disconnected = await a.request('POST', '/api/codex/logout', { body: {} });
  assert.equal(disconnected.data.connected, false);
  await assert.rejects(fs.access(path.join(homeA, 'auth.json')));
});

test('a cancelled Codex sign-in stops the pending device login', async t => {
  const { base, server, dataRoot } = await hostedFixture(t, { codexExecutable: executable });
  const a = client(base); await a.signUp('a@example.com');
  await a.request('GET', '/api/codex/status');
  const [user] = server.users.values();
  await fs.writeFile(path.join(dataRoot, 'users', user.id, 'codex-home', 'fake-mode.json'), '{"mode":"never"}');
  const started = (await a.request('POST', '/api/codex/login', { body: {} })).data;
  assert.match(started.userCode, /^[A-Z0-9]+-[A-Z0-9]+$/);
  assert.equal((await a.request('DELETE', `/api/codex/login/${started.id}`)).status, 200);
  assert.notEqual((await a.request('GET', `/api/codex/login/${started.id}`)).status, 200, 'A cancelled login is gone.');
  assert.deepEqual((await a.request('GET', '/api/codex/status')).data, { connected: false });
});

test('id-based Codex login routes are scoped to the signed-in account', async t => {
  const { base } = await hostedFixture(t, { codexExecutable: executable });
  const a = client(base), b = client(base);
  await a.signUp('a@example.com'); await b.signUp('b@example.com');
  const started = await a.request('POST', '/api/codex/login', { body: {} });
  assert.equal(started.status, 200);
  assert.deepEqual({ url: started.data.verificationUrl, code: started.data.userCode }, { url: 'https://auth.openai.com/codex/device', code: FAKE_CODE });
  assert.match(started.data.id, /^[a-f0-9-]{36}$/);
  assert.equal((await b.request('GET', `/api/codex/login/${started.data.id}`)).status, 404, 'Another account cannot observe this login.');
  let progress;
  for (let i = 0; i < 50; i++) { progress = (await a.request('GET', `/api/codex/login/${started.data.id}`)).data; if (progress.state !== 'pending') break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal(progress.state, 'connected');
  assert.equal((await a.request('GET', '/api/codex/status')).data.connected, true);
  assert.equal((await a.request('POST', '/api/codex/logout', { body: {} })).data.connected, false);
});
