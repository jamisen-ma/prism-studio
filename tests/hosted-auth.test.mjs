import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { hostedFixture, client } from './hosted-helpers.mjs';
import { hashPassword, verifyPassword, hostedConfigFromEnv } from '../server/hosted.mjs';

test('hosted sign-up requires the invite code and sets an httpOnly SameSite session cookie', async t => {
  const { base, dataRoot } = await hostedFixture(t);
  const user = client(base);
  const anonymous = await user.request('GET', '/api/session');
  assert.equal(anonymous.status, 401);
  assert.deepEqual(anonymous.data.hosted, { signupOpen: true, signupCodeRequired: true });
  assert.equal((await user.signUp('ada@example.com', 'correct horse battery', 'wrong')).status, 403);
  assert.equal((await user.signUp('ada@example.com', 'correct horse battery', '')).status, 403);
  assert.equal(user.cookie, '');
  assert.equal((await user.signUp('not-an-email')).status, 400);
  assert.equal((await user.signUp('ada@example.com', 'short')).status, 400);
  const created = await user.signUp('Ada@Example.com');
  assert.equal(created.status, 200);
  const cookie = created.headers.get('set-cookie');
  assert.match(cookie, /^prism_session=[A-Za-z0-9_-]{43};/);
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Path=\//);
  assert.doesNotMatch(cookie, /Secure/, 'Plain local HTTP cannot keep a Secure cookie.');
  assert.equal(created.data.hosted.email, 'ada@example.com');
  const session = await user.request('GET', '/api/session');
  assert.equal(session.status, 200); assert.equal(session.data.token, user.token);
  // Stored credentials use scrypt; neither the password nor a raw session token is persisted.
  const stored = await fs.readFile(path.join(dataRoot, 'accounts', 'users.json'), 'utf8');
  assert.doesNotMatch(stored, /correct horse battery/);
  assert.match(stored, /"params":\{"N":16384,"r":8,"p":1\}/);
  assert.doesNotMatch(await fs.readFile(path.join(dataRoot, 'accounts', 'sessions.json'), 'utf8'), new RegExp(user.cookie.split('=')[1]));
  const duplicate = await client(base).signUp('ada@example.com');
  assert.equal(duplicate.status, 409);
});

test('hosted sign-in, sign-out and persisted sessions across restart', async t => {
  const first = await hostedFixture(t, { keep: true });
  const user = client(first.base);
  await user.signUp('grace@example.com');
  const other = client(first.base);
  assert.equal((await other.signIn('grace@example.com', 'wrong password')).status, 401);
  assert.equal((await other.signIn('nobody@example.com')).status, 401);
  const signedIn = await other.signIn('grace@example.com');
  assert.equal(signedIn.status, 200);
  assert.notEqual(other.token, user.token, 'Each session gets its own request token.');
  await first.server.close();

  const second = await hostedFixture(t, { dataRoot: first.dataRoot });
  const restored = client(second.base); restored.cookie = user.cookie; restored.token = user.token;
  assert.equal((await restored.request('GET', '/api/session')).status, 200, 'Sessions survive a redeploy.');
  const out = await restored.request('POST', '/api/auth/signout', { body: {} });
  assert.equal(out.status, 200); assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  const reuse = client(second.base); reuse.cookie = user.cookie; reuse.token = user.token;
  assert.equal((await reuse.request('GET', '/api/session')).status, 401);
  assert.equal((await reuse.command('list_documents')).status, 401);
  const otherSession = client(second.base); otherSession.cookie = other.cookie; otherSession.token = other.token;
  assert.equal((await otherSession.command('list_documents')).status, 200, 'Signing out one session leaves the others.');
});

test('hosted auth endpoints are rate limited', async t => {
  const { base } = await hostedFixture(t);
  await client(base).signUp('lin@example.com');
  const attacker = client(base);
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await attacker.signIn('lin@example.com', `guess-${i}-password`)).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
  assert.equal(statuses[10], 429);
  const limited = await attacker.signIn('lin@example.com');
  assert.equal(limited.status, 429, 'The correct password is also refused while limited.');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('unauthenticated, token-less and cross-origin API requests are rejected', async t => {
  const { base } = await hostedFixture(t);
  const health = await client(base).request('GET', '/api/health', { headers: { Host: 'healthcheck.railway.app' } });
  assert.equal(health.status, 200); assert.equal(health.data.ok, true);
  const anonymous = client(base);
  for (const [method, pathname] of [['GET', '/api/status'], ['GET', '/api/chat'], ['GET', '/api/ai/jobs'], ['GET', '/api/codex/status'], ['GET', '/api/account'], ['POST', '/api/command']]) {
    const result = await anonymous.request(method, pathname, method === 'POST' ? { body: { backend: 'native', command: 'list_documents', args: {} } } : {});
    assert.equal(result.status, 401, `${method} ${pathname}`);
  }
  const user = client(base); await user.signUp('kay@example.com');
  assert.equal((await user.request('GET', '/api/status', { auth: false })).status, 401, 'A cookie without the session token is refused (CSRF).');
  const tokenOnly = client(base); tokenOnly.token = user.token;
  assert.equal((await tokenOnly.request('GET', '/api/status')).status, 401, 'A token without the cookie is refused.');
  assert.equal((await user.request('GET', '/api/status', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await user.request('GET', '/api/status', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  // fetch cannot override Host; send a raw request for the DNS-rebinding case.
  const rebound = await new Promise((resolve, reject) => http.get(`${base}/api/status`, { headers: { Host: 'evil.example', Cookie: user.cookie, Authorization: `Bearer ${user.token}` } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject));
  assert.equal(rebound, 403);
  assert.equal((await user.request('GET', '/api/status')).status, 200);
  assert.equal((await user.request('GET', '/api/setup')).status, 404, 'No pairing key or local MCP setup is exposed.');
  const photoshop = await user.command('list_documents', {}, 'photoshop');
  assert.equal(photoshop.status, 400); assert.equal(photoshop.data.error.code, 'UNSUPPORTED_COMMAND');
  const tool = await user.request('GET', '/api/chat/00000000-0000-4000-8000-000000000000/tools', { headers: { Authorization: `Bearer ${'a'.repeat(64)}` } });
  assert.equal(tool.status, 401, 'Chat tool capabilities require an active turn.');
});

test('invite-free and closed sign-up configurations', async t => {
  const open = await hostedFixture(t, { signupCode: undefined });
  assert.equal((await client(open.base).signUp('open@example.com', 'correct horse battery', undefined)).status, 200);
  const closed = await hostedFixture(t, { signupOpen: false });
  assert.equal((await client(closed.base).signUp('closed@example.com')).status, 403);
  const full = await hostedFixture(t, { maxUsers: 1 });
  assert.equal((await client(full.base).signUp('one@example.com')).status, 200);
  assert.equal((await client(full.base).signUp('two@example.com')).status, 403);
});

test('password hashing and hosted configuration defaults', async () => {
  const record = await hashPassword('p4ssword!');
  assert.equal(await verifyPassword('p4ssword!', record), true);
  assert.equal(await verifyPassword('p4ssword?', record), false);
  const config = hostedConfigFromEnv({ PORT: '9000', RAILWAY_PUBLIC_DOMAIN: 'prism.up.railway.app', PRISM_SEGMENTATION: '0', PRISM_MAX_UPLOAD_MB: '10' });
  assert.equal(config.port, 9000); assert.equal(config.publicUrl, 'https://prism.up.railway.app');
  assert.equal(config.dataRoot, '/data'); assert.equal(config.segmentationEnabled, false); assert.equal(config.maxUploadBytes, 10 * 1024 * 1024);
  assert.equal(hostedConfigFromEnv({ PRISM_PUBLIC_URL: 'https://photos.example', RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' }).publicUrl, 'https://photos.example');
  assert.throws(() => hostedConfigFromEnv({ PRISM_MAX_DOCUMENTS: 'many' }), /PRISM_MAX_DOCUMENTS/);
});
