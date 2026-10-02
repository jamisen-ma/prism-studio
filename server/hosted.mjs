import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createCompanion, serveDist, statusCode } from './index.mjs';
import { SegmentationService } from './segmentation.mjs';
import { cancelCodexLogin, codexLoginOwner, codexLoginProgress, codexLoginStatus, logoutCodex, startCodexLogin } from './codex-login.mjs';
import { createCodexImageRunner } from './codex-image-runner.mjs';
import { createCodexChatRunner } from './codex-chat-runner.mjs';

// Hosted multi-user mode (PRISM_HOSTED=1). One public listener authenticates
// accounts with cookie sessions, then hands each request to that account's own
// lazily created workspace (native projects, chat, image jobs, Codex login),
// all rooted in a private directory under dataRoot/users/<id>. Local mode in
// server/index.mjs is unchanged.
const scrypt = promisify(scryptCallback);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{1,63}$/;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_DAYS = 30, MAX_SESSIONS_PER_USER = 10, COOKIE = 'prism_session';
const MB = 1024 * 1024;
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

function envNumber(env, name, fallback, { min = 0 } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) throw new Error(`${name} must be a number of at least ${min}.`);
  return value;
}

export function hostedConfigFromEnv(env = process.env) {
  const railwayDomain = env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : undefined;
  return {
    port: Number(env.PORT || env.PRISM_PORT || 8080),
    publicUrl: env.PRISM_PUBLIC_URL || railwayDomain,
    dataRoot: env.PRISM_DATA_ROOT || '/data',
    signupCode: env.PRISM_SIGNUP_CODE || undefined,
    signupOpen: env.PRISM_ALLOW_SIGNUP !== '0',
    guestAccess: env.PRISM_GUEST === '1',
    segmentationEnabled: env.PRISM_SEGMENTATION !== '0',
    segmentationDir: env.PRISM_SEGMENTATION_DIR || undefined,
    codexWorkerEnabled: env.PRISM_CODEX_WORKER !== '0',
    chatEnabled: env.PRISM_CHAT !== '0',
    maxUploadBytes: envNumber(env, 'PRISM_MAX_UPLOAD_MB', 64, { min: 1 }) * MB,
    maxDocuments: envNumber(env, 'PRISM_MAX_DOCUMENTS', 50, { min: 1 }),
    maxStorageBytes: envNumber(env, 'PRISM_MAX_STORAGE_MB', 2048, { min: 16 }) * MB,
    maxUsers: envNumber(env, 'PRISM_MAX_USERS', 50, { min: 1 }),
    idleMs: envNumber(env, 'PRISM_IDLE_MINUTES', 20, { min: 1 }) * 60_000,
  };
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}
async function readJsonFile(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function directoryBytes(directory) {
  let total = 0;
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(file);
    else if (entry.isFile()) { try { total += (await fs.stat(file)).size; } catch {} }
  }
  return total;
}
function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}
const sha256 = value => createHash('sha256').update(value).digest('hex');

export async function hashPassword(password, salt = randomBytes(16)) {
  const key = await scrypt(password.normalize('NFKC'), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * MB });
  return { salt: salt.toString('base64'), hash: key.toString('base64'), params: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p } };
}
export async function verifyPassword(password, record) {
  const { N, r, p } = record.params || SCRYPT;
  const expected = Buffer.from(record.hash, 'base64');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(record.salt, 'base64'), expected.length, { N, r, p, maxmem: 64 * MB });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Fixed-window limiter keyed by client and action. Memory only. */
class RateLimiter {
  constructor() { this.buckets = new Map(); }
  hit(key, limit, windowMs) {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.reset <= now) { bucket = { count: 0, reset: now + windowMs }; this.buckets.set(key, bucket); }
    bucket.count++;
    if (this.buckets.size > 10_000) for (const [name, value] of this.buckets) if (value.reset <= now) this.buckets.delete(name);
    if (bucket.count > limit) throw fail('RATE_LIMITED', 'Too many attempts. Wait a few minutes and try again.', { retryAfter: Math.ceil((bucket.reset - now) / 1000) });
  }
  clear(key) { this.buckets.delete(key); }
}

export async function createHostedServer(options = {}) {
  const config = { ...hostedConfigFromEnv({}), ...options };
  const { port, dataRoot, signupCode, signupOpen, guestAccess, segmentationEnabled, maxUploadBytes, maxDocuments, maxStorageBytes, maxUsers, idleMs } = config;
  const root = path.resolve(dataRoot);
  const accountsFile = path.join(root, 'accounts', 'users.json'), sessionsFile = path.join(root, 'accounts', 'sessions.json');
  await fs.mkdir(path.join(root, 'users'), { recursive: true, mode: 0o700 });
  const accounts = await readJsonFile(accountsFile, { version: 1, users: [] });
  const storedSessions = await readJsonFile(sessionsFile, { version: 1, sessions: {} });
  const users = new Map(accounts.users.map(user => [user.id, user]));
  const sessions = new Map(Object.entries(storedSessions.sessions).filter(([, value]) => Date.parse(value.expiresAt) > Date.now() && users.has(value.userId)));
  const limiter = new RateLimiter();
  const segmentation = segmentationEnabled ? (config.segmentation || new SegmentationService({ dataDir: config.segmentationDir || path.join(root, 'segmentation') })) : null;
  const segmentationStub = { async status() { return { installed: false, disabled: true, model: 'disabled', local: true, running: false, limitations: ['Subject cutouts are turned off on this server.'] }; }, async segment() { throw fail('SEGMENTATION_DISABLED', 'Subject cutouts are turned off on this server.'); }, async close() {} };
  const publicOrigin = config.publicUrl ? new URL(config.publicUrl).origin : null;
  let actualPort = port;
  const trustedHosts = () => new Set([...(publicOrigin ? [new URL(publicOrigin).host] : []), `localhost:${actualPort}`, `127.0.0.1:${actualPort}`]);
  const trustedOrigins = () => new Set([...(publicOrigin ? [publicOrigin] : []), `http://localhost:${actualPort}`, `http://127.0.0.1:${actualPort}`]);
  const workspaces = new Map();
  let accountWrite = Promise.resolve(), sessionWrite = Promise.resolve(), closed = false;

  const saveAccounts = () => (accountWrite = accountWrite.catch(() => {}).then(() => writeJsonAtomic(accountsFile, { version: 1, users: [...users.values()] })));
  const saveSessions = () => (sessionWrite = sessionWrite.catch(() => {}).then(() => writeJsonAtomic(sessionsFile, { version: 1, sessions: Object.fromEntries(sessions) })));

  function json(response, status, data, headers = {}) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    response.end(JSON.stringify(data));
  }
  function clientIp(request) {
    // The edge proxy appends the real client address last; earlier entries are client-supplied.
    const forwarded = String(request.headers['x-forwarded-for'] || '').split(',').pop().trim();
    return forwarded || request.socket.remoteAddress || 'unknown';
  }
  function secureRequest(request) { return request.headers['x-forwarded-proto'] === 'https' || Boolean(request.socket.encrypted); }
  // Page loads may arrive from links on other sites; only API calls must be same-site.
  function trusted(request, { navigation = false } = {}) {
    if (!navigation && request.headers['sec-fetch-site'] === 'cross-site') return false;
    const origin = request.headers.origin;
    if (origin && !trustedOrigins().has(origin)) return false;
    const host = String(request.headers['x-forwarded-host'] || request.headers.host || '').toLowerCase();
    return trustedHosts().has(host);
  }
  async function readSmallJson(request, maxBytes = 16 * 1024) {
    if (!String(request.headers['content-type'] || '').startsWith('application/json')) throw fail('INVALID_ARGUMENTS', 'Send application/json.');
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > maxBytes) throw fail('PAYLOAD_TOO_LARGE', 'The request is too large.'); chunks.push(chunk); }
    try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch {}
    throw fail('INVALID_ARGUMENTS', 'The request body is not valid JSON.');
  }

  function sessionCookie(request, token, maxAge) {
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureRequest(request) ? '; Secure' : ''}`;
  }
  async function createSession(request, response, user) {
    const token = randomBytes(32).toString('base64url');
    const record = { userId: user.id, csrf: randomBytes(32).toString('hex'), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString() };
    sessions.set(sha256(token), record);
    const own = [...sessions.entries()].filter(([, value]) => value.userId === user.id).sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt));
    for (const [key] of own.slice(0, Math.max(0, own.length - MAX_SESSIONS_PER_USER))) sessions.delete(key);
    await saveSessions();
    json(response, 200, { ok: true, token: record.csrf, hosted: publicInfo(user) }, { 'Set-Cookie': sessionCookie(request, token, SESSION_DAYS * 86400) });
  }
  function currentSession(request) {
    const token = parseCookies(request.headers.cookie)[COOKIE];
    if (!token || token.length > 100) return null;
    const key = sha256(token), record = sessions.get(key);
    if (!record) return null;
    if (Date.parse(record.expiresAt) <= Date.now() || !users.has(record.userId)) { sessions.delete(key); void saveSessions(); return null; }
    return { key, record, user: users.get(record.userId) };
  }
  function requireSession(request) {
    const session = currentSession(request);
    const bearer = String(request.headers.authorization || '').replace(/^Bearer /, '');
    if (!session) throw fail('SIGN_IN_REQUIRED', 'Sign in to continue.');
    const expected = Buffer.from(session.record.csrf), actual = Buffer.from(bearer);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw fail('UNAUTHORIZED', 'A valid Prism session is required.');
    return session;
  }
  function publicInfo(user) {
    return { email: user.email, segmentation: segmentationEnabled, codex: config.codexWorkerEnabled || config.chatEnabled, limits: { maxUploadBytes, maxDocuments, maxStorageBytes } };
  }
  const signupInfo = () => ({ signupOpen: signupOpen && users.size < maxUsers, signupCodeRequired: Boolean(signupCode) });

  function credentials(body) {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!EMAIL.test(email) || email.length > 254) throw fail('INVALID_ARGUMENTS', 'Enter a valid email address.');
    if (password.length < 8 || password.length > 200) throw fail('INVALID_ARGUMENTS', 'Passwords must contain 8–200 characters.');
    return { email, password };
  }
  const findUser = email => [...users.values()].find(user => user.email === email);
  const dummyRecord = hashPassword('prism-timing-equalizer');

  async function signUp(request, response) {
    limiter.hit(`signup:${clientIp(request)}`, 10, 60 * 60_000);
    const body = await readSmallJson(request);
    if (!signupOpen) throw fail('FORBIDDEN', 'New accounts are closed on this server.');
    if (signupCode) {
      const provided = Buffer.from(sha256(typeof body.inviteCode === 'string' ? body.inviteCode.trim() : '')), expected = Buffer.from(sha256(signupCode));
      if (!timingSafeEqual(provided, expected)) throw fail('FORBIDDEN', 'That invite code is not valid.');
    }
    const { email, password } = credentials(body);
    if (users.size >= maxUsers) throw fail('FORBIDDEN', 'This server has reached its account limit.');
    if (findUser(email)) throw fail('CONFLICT', 'An account with this email already exists. Sign in instead.');
    const user = { id: randomUUID(), email, ...(await hashPassword(password)), createdAt: new Date().toISOString() };
    if (findUser(email)) throw fail('CONFLICT', 'An account with this email already exists. Sign in instead.');
    users.set(user.id, user);
    try { await saveAccounts(); } catch (error) { users.delete(user.id); throw error; }
    await createSession(request, response, user);
  }
  // Guest access: a visitor without a session gets a passwordless account bound
  // to their session cookie. Losing the cookie loses access to that workspace.
  async function startGuest(request, response) {
    limiter.hit(`guest:${clientIp(request)}`, 20, 60 * 60_000);
    if (users.size >= maxUsers) throw fail('FORBIDDEN', 'This server has reached its account limit.');
    const user = { id: randomUUID(), email: 'Guest', guest: true, createdAt: new Date().toISOString() };
    users.set(user.id, user);
    try { await saveAccounts(); } catch (error) { users.delete(user.id); throw error; }
    await createSession(request, response, user);
  }
  async function signIn(request, response) {
    const ip = clientIp(request);
    limiter.hit(`signin:${ip}`, 30, 15 * 60_000);
    const { email, password } = credentials(await readSmallJson(request));
    limiter.hit(`signin-email:${email}`, 10, 15 * 60_000);
    const user = findUser(email);
    const valid = user ? await verifyPassword(password, user) : (await verifyPassword(password, await dummyRecord), false);
    if (!valid) throw fail('UNAUTHORIZED', 'The email or password is incorrect.');
    limiter.clear(`signin-email:${email}`);
    await createSession(request, response, user);
  }

  function busy(app) {
    if (app.chat.active || [...app.chat.turns.values()].some(turn => ['queued', 'running'].includes(turn.status))) return true;
    if (app.codexWorker?.active || app.codexWorker?.pending) return true;
    return [...app.generation.jobs.values()].some(job => ['queued', 'running'].includes(job.status) || (job.status === 'awaiting_image' && ['queued', 'generating', 'returning'].includes(job.automation?.state)));
  }
  const storageFull = () => fail('STORAGE_LIMIT', `This account is using its full ${Math.round(maxStorageBytes / MB)} MB of storage. Delete documents to continue.`);
  async function openWorkspace(user, entry) {
    const dataDir = path.join(root, 'users', user.id), codexHome = path.join(dataDir, 'codex-home');
    entry.dataDir = dataDir;
    await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
    let app;
    const codexBin = config.codexExecutable;
    // Never spawn Codex for an account that has not connected: without
    // auth.json codexLoginStatus returns immediately. Otherwise the worker
    // would run checks every few seconds for each idle signed-in user.
    const gate = adapter => ({ ...adapter, check: async () => (await codexLoginStatus({ codexHome, codexBin })).connected ? adapter.check() : { available: false, reason: 'Connect your Codex account.' } });
    const runnerOptions = { codexHome, ...(config.codexExecutable ? { executable: config.codexExecutable } : {}) };
    app = await createCompanion({
      hosted: true, dataDir, codexHome, maxBody: maxUploadBytes, maxDocuments,
      segmentation: segmentation || segmentationStub, segmentationEnabled: Boolean(segmentation),
      codexWorkerEnabled: config.codexWorkerEnabled, chatEnabled: config.chatEnabled,
      beforeMutation: async () => { if (entry.dataDir && await storageUsed(entry) >= maxStorageBytes) throw storageFull(); },
      codexImageAdapter: config.codexWorkerEnabled ? gate(config.codexImageAdapter || createCodexImageRunner(runnerOptions)) : undefined,
      chatAdapter: config.chatEnabled ? gate(config.chatAdapter || createCodexChatRunner(runnerOptions)) : undefined,
      ...(config.chatToolContextFactory ? { chatToolContextFactory: config.chatToolContextFactory } : {}),
      getBaseUrl: () => `http://127.0.0.1:${actualPort}`,
    });
    return { app, codexHome, dataDir, codexConnected: false };
  }
  async function workspace(user) {
    if (closed) throw fail('CLOSED', 'The server is shutting down.');
    let entry = workspaces.get(user.id);
    if (!entry) {
      entry = { inflight: 0, lastUsed: Date.now(), usage: null };
      entry.ready = openWorkspace(user, entry).then(value => Object.assign(entry, value));
      workspaces.set(user.id, entry);
      entry.ready.catch(() => { if (workspaces.get(user.id) === entry) workspaces.delete(user.id); });
    }
    entry.lastUsed = Date.now();
    await entry.ready;
    return entry;
  }
  async function storageUsed(entry, { refresh = false } = {}) {
    if (refresh || !entry.usage || Date.now() - entry.usage.at > 60_000) entry.usage = { at: Date.now(), bytes: await directoryBytes(entry.dataDir) };
    return entry.usage.bytes;
  }
  async function evictIdle({ force = false } = {}) {
    for (const [id, entry] of workspaces) {
      if (!entry.app) continue;
      if (!force && (entry.inflight > 0 || Date.now() - entry.lastUsed < idleMs || busy(entry.app) || (entry.loginId && codexLoginProgress(entry.loginId).state === 'pending'))) continue;
      workspaces.delete(id);
      if (entry.loginId) cancelCodexLogin(entry.loginId);
      await entry.app.close().catch(() => {});
    }
  }
  const evictionTimer = setInterval(() => { void evictIdle(); }, 60_000);
  evictionTimer.unref?.();

  async function handleAccountApi(request, response, url, session) {
    const { user } = session;
    if (url.pathname === '/api/auth/signout' && request.method === 'POST') {
      sessions.delete(session.key); await saveSessions();
      json(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie(request, '', 0) }); return true;
    }
    if (url.pathname.startsWith('/api/codex/')) {
      const entry = await workspace(user);
      const action = url.pathname.slice('/api/codex/'.length);
      const codexBin = config.codexExecutable, { codexHome } = entry;
      // Re-check chat/worker readiness when the connection changes.
      const observe = connected => { if (connected !== entry.codexConnected) { entry.codexConnected = connected; void entry.app.codexWorker?.check(); void entry.app.chat.check(); } return connected; };
      if (action === 'status' && request.method === 'GET') { const status = await codexLoginStatus({ codexHome, codexBin }); observe(status.connected); json(response, 200, status); return true; }
      const loginMatch = /^login\/([a-f0-9-]{36})$/.exec(action);
      if (loginMatch) {
        // A login id is only visible to the account whose CODEX_HOME it signs in.
        if (codexLoginOwner(loginMatch[1]) !== path.resolve(codexHome)) throw fail('NOT_FOUND', 'This Codex sign-in is no longer active. Start again.');
        if (request.method === 'DELETE') { cancelCodexLogin(loginMatch[1]); entry.loginId = null; json(response, 200, { ok: true }); return true; }
        if (request.method !== 'GET') throw fail('NOT_FOUND', 'Unknown Codex endpoint.');
        const progress = codexLoginProgress(loginMatch[1]);
        if (progress.state === 'connected') observe((await codexLoginStatus({ codexHome, codexBin })).connected);
        json(response, 200, progress); return true;
      }
      if (action === 'login' && request.method === 'POST') {
        limiter.hit(`codex-login:${user.id}`, 10, 60 * 60_000);
        const started = await startCodexLogin({ codexHome, codexBin });
        entry.loginId = started.id;
        json(response, 200, started); return true;
      }
      if (action === 'logout' && request.method === 'POST') { entry.loginId = null; const result = await logoutCodex({ codexHome, codexBin }); observe(false); json(response, 200, result); return true; }
      throw fail('NOT_FOUND', 'Unknown Codex endpoint.');
    }
    const match = /^\/api\/documents\/([^/]+)$/.exec(url.pathname);
    if (match && request.method === 'DELETE') {
      if (!UUID.test(match[1])) throw fail('INVALID_ARGUMENTS', 'Use a valid document ID.');
      const entry = await workspace(user);
      const result = await entry.app.native.deleteDocument(match[1]);
      entry.usage = null;
      json(response, 200, { ok: true, ...result }); return true;
    }
    if (url.pathname === '/api/account' && request.method === 'GET') {
      const entry = await workspace(user);
      json(response, 200, { ...publicInfo(user), usage: { storageBytes: await storageUsed(entry, { refresh: true }), documents: entry.app.native.projects.size } }); return true;
    }
    return false;
  }

  async function handleWorkspaceApi(request, response, url, session) {
    const entry = await workspace(session.user);
    entry.inflight++;
    try {
      const mutating = !['GET', 'HEAD'].includes(request.method);
      // Editor commands are checked per command (reads stay allowed) through beforeMutation.
      const exempt = url.pathname === '/api/command' || /\/cancel$/.test(url.pathname) || url.pathname === '/api/psd/inspect-import';
      if (mutating && !exempt && await storageUsed(entry) >= maxStorageBytes) throw storageFull();
      if (request.method === 'POST' && ['/api/projects/import', '/api/psd/import'].includes(url.pathname) && entry.app.native.projects.size >= maxDocuments) throw fail('LIMIT_EXCEEDED', `This account has reached its ${maxDocuments}-document limit. Delete a document before adding another.`);
      await entry.app.handleApi(request, response, url);
      if (mutating && entry.usage) entry.usage.at = Math.min(entry.usage.at, Date.now() - 50_000);
    } finally { entry.inflight--; entry.lastUsed = Date.now(); }
  }

  async function handle(request, response) {
    const url = new URL(request.url, 'http://prism.invalid');
    if (url.pathname === '/api/health') { json(response, 200, { ok: true, name: 'Prism Studio', hosted: true }); return; }
    // Private per-turn capability calls from this server's own Codex MCP bridge.
    const tool = /^\/api\/chat\/([a-f0-9-]{36})\/(tools|tool)$/.exec(url.pathname);
    if (tool) {
      const remote = request.socket.remoteAddress;
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) || request.headers['x-forwarded-for']) throw fail('FORBIDDEN', 'Chat tool capabilities are private to this server.');
      const owner = [...workspaces.values()].find(entry => entry.app?.chat.active?.id === tool[1]);
      if (!owner) throw fail('UNAUTHORIZED', 'This active chat capability is required.');
      owner.lastUsed = Date.now();
      await owner.app.handleChatTool(request, response, url); return;
    }
    const navigation = !url.pathname.startsWith('/api/') && ['GET', 'HEAD'].includes(request.method);
    if (!trusted(request, { navigation })) throw fail('FORBIDDEN', 'This request did not come from the Prism workspace.');
    if (url.pathname.startsWith('/api/')) {
      if (!['GET', 'HEAD'].includes(request.method)) {
        const declared = request.headers['content-length'];
        if (declared === undefined && request.headers['transfer-encoding']) throw fail('LENGTH_REQUIRED', 'Uploads must declare their size.');
        if (Number(declared) > maxUploadBytes) throw fail('PAYLOAD_TOO_LARGE', `Uploads are limited to ${Math.round(maxUploadBytes / MB)} MB on this server.`);
      }
      if (url.pathname === '/api/auth/signup' && request.method === 'POST') { await signUp(request, response); return; }
      if (url.pathname === '/api/auth/signin' && request.method === 'POST') { await signIn(request, response); return; }
      if (url.pathname === '/api/session' && request.method === 'GET') {
        const session = currentSession(request);
        if (!session && guestAccess) { await startGuest(request, response); return; }
        if (!session) { json(response, 401, { ok: false, error: { code: 'SIGN_IN_REQUIRED', message: 'Sign in to continue.' }, hosted: signupInfo() }); return; }
        json(response, 200, { token: session.record.csrf, hosted: publicInfo(session.user) }); return;
      }
      const session = requireSession(request);
      if (await handleAccountApi(request, response, url, session)) return;
      await handleWorkspaceApi(request, response, url, session);
      return;
    }
    await serveDist(request, response, url, json, 'The workspace has not been built. Run npm run build.', secureRequest(request) ? { 'Strict-Transport-Security': 'max-age=31536000' } : {});
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch(error => {
      const status = error.code === 'RATE_LIMITED' ? 429 : error.code === 'SIGN_IN_REQUIRED' ? 401 : error.code === 'CONFLICT' ? 409 : error.code === 'LENGTH_REQUIRED' ? 411 : error.code === 'STORAGE_LIMIT' ? 413 : statusCode(error);
      if (!response.headersSent) json(response, status, { ok: false, error: { code: error.code || 'INTERNAL_ERROR', message: error.code ? error.message : 'The server could not complete this request.' } }, error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
      else response.end();
    });
  });
  server.requestTimeout = 300_000; server.headersTimeout = 15_000;
  // The server accepts no WebSocket upgrades.
  server.on('upgrade', (request, socket) => socket.destroy());

  return {
    server, users, sessions, workspaces, config: { ...config, dataRoot: root },
    async listen(host = '0.0.0.0') {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
      actualPort = server.address().port; return actualPort;
    },
    async close() {
      closed = true; clearInterval(evictionTimer);
      await Promise.allSettled([...workspaces.values()].map(entry => entry.ready));
      await evictIdle({ force: true });
      await segmentation?.close?.();
      await accountWrite.catch(() => {}); await sessionWrite.catch(() => {});
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    },
  };
}

export async function startHostedFromEnv() {
  const config = hostedConfigFromEnv();
  // Keep the invite code out of the environment inherited by Codex subprocesses.
  delete process.env.PRISM_SIGNUP_CODE;
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('PORT must be a valid port number.');
  if (!config.publicUrl) console.warn('PRISM_PUBLIC_URL is not set; only http://localhost and http://127.0.0.1 origins will be accepted.');
  if (!config.signupCode && config.signupOpen) console.warn('PRISM_SIGNUP_CODE is not set; anyone who can reach this server can create an account.');
  const app = await createHostedServer(config);
  const host = process.env.PRISM_HOST || '0.0.0.0';
  const port = await app.listen(host);
  console.log(`Prism Studio (hosted) is listening on ${host}:${port}${config.publicUrl ? ` for ${config.publicUrl}` : ''}. Data: ${app.config.dataRoot}`);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (stopping) return; stopping = true; await app.close(); process.exit(0); });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await startHostedFromEnv();
