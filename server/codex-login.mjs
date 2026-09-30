import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Per-user Codex ChatGPT sign-in for hosted Prism. Each account has its own
// CODEX_HOME; the server owner's ~/.codex is never read. The device-code flow
// prints a verification URL and one-time code, which are the only child output
// ever returned to the browser (after strict validation).
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const URL_PATTERN = /https:\/\/[^\s"'<>]+/;
const CODE_PATTERN = /\b([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/;
const ALLOWED_HOSTS = ['auth.openai.com', 'chatgpt.com', 'openai.com'];
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000, PROMPT_TIMEOUT_MS = 30_000, MAX_OUTPUT = 64 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });

export function parseDeviceAuthOutput(text) {
  const plain = String(text).replace(ANSI, '');
  const urlMatch = URL_PATTERN.exec(plain), codeMatch = CODE_PATTERN.exec(plain.slice(urlMatch ? urlMatch.index + urlMatch[0].length : 0));
  if (!urlMatch || !codeMatch) return null;
  let url;
  try { url = new URL(urlMatch[0].replace(/[).,;]+$/, '')); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || !ALLOWED_HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return null;
  return { url: url.href, code: codeMatch[1] };
}

function childEnv(codexHome) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(_API_KEY|_TOKEN|_SECRET|_PASSWORD)$/.test(key) && !key.startsWith('PRISM_')));
  return { ...env, CODEX_HOME: path.resolve(codexHome), NO_COLOR: '1' };
}

// Maps a failed device-login's output to a user-facing state. Only fixed
// messages are returned; raw CLI output never reaches the browser.
function describeLoginFailure(output) {
  const plain = String(output).replace(ANSI, '');
  if (/unexpected argument '--device-auth'|unrecognized.*--device-auth/i.test(plain)) return { state: 'failed', message: 'This server\'s Codex CLI is too old for device-code sign-in. Upgrade Codex (0.159 or newer is known to work).' };
  if (/device code/i.test(plain) && /enable|disabled|not allowed/i.test(plain)) return { state: 'failed', message: 'Device code sign-in is turned off for this ChatGPT account. Enable it in ChatGPT security settings, then try again.' };
  if (/expired|timed? ?out/i.test(plain)) return { state: 'expired', message: 'The sign-in code expired. Start again.' };
  return { state: 'failed', message: 'Codex sign-in did not complete. Start again.' };
}

export class CodexLogin {
  constructor({ codexHome, executable = process.env.PRISM_CODEX_BIN || 'codex', spawnProcess = spawn, onChange = () => {}, loginTimeoutMs = LOGIN_TIMEOUT_MS, promptTimeoutMs = PROMPT_TIMEOUT_MS }) {
    this.codexHome = path.resolve(codexHome); this.executable = executable; this.spawnProcess = spawnProcess; this.onChange = onChange;
    this.loginTimeoutMs = loginTimeoutMs; this.promptTimeoutMs = promptTimeoutMs;
    this.login = null; this.child = null; this.statusCache = null;
  }

  async hasCredentials() {
    try { const stat = await fs.stat(path.join(this.codexHome, 'auth.json')); return stat.isFile() && stat.size > 0; } catch { return false; }
  }

  run(args, { timeout = 15_000 } = {}) {
    return new Promise(resolve => {
      let child, output = '';
      try { child = this.spawnProcess(this.executable, args, { env: childEnv(this.codexHome), stdio: ['ignore', 'pipe', 'pipe'], shell: false }); }
      catch { resolve({ code: -1, output: '' }); return; }
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeout);
      const collect = chunk => { if (output.length < MAX_OUTPUT) output += chunk.toString(); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      child.on('error', () => {});
      child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
    });
  }

  async connected({ refresh = false } = {}) {
    if (!(await this.hasCredentials())) { this.statusCache = null; return false; }
    if (!refresh && this.statusCache && Date.now() - this.statusCache.at < 30_000) return this.statusCache.connected;
    await fs.mkdir(this.codexHome, { recursive: true, mode: 0o700 });
    const { code, output } = await this.run(['login', 'status']);
    const connected = code === 0 && /Logged in using ChatGPT/i.test(output);
    this.statusCache = { at: Date.now(), connected };
    return connected;
  }

  publicLogin() {
    const login = this.login;
    if (!login) return null;
    return { state: login.state, ...(login.url ? { url: login.url, code: login.code, expiresAt: login.expiresAt } : {}), ...(login.message ? { message: login.message } : {}) };
  }

  async status() {
    const connected = await this.connected();
    return { connected, login: this.publicLogin() };
  }

  // Resolves once the child printed a valid URL and code (or failed). The
  // same child keeps polling OpenAI until the user approves the code.
  async start() {
    if (this.login?.state === 'pending' && this.child) return this.status();
    await fs.mkdir(this.codexHome, { recursive: true, mode: 0o700 });
    let child;
    try { child = this.spawnProcess(this.executable, ['login', '--device-auth', '-c', 'cli_auth_credentials_store="file"'], { env: childEnv(this.codexHome), stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' }); }
    catch { throw fail('CODEX_UNAVAILABLE', 'The Codex CLI could not start on this server.'); }
    const login = { state: 'starting' };
    this.login = login; this.child = child;
    let output = '';
    const kill = () => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} } };
    const deadline = setTimeout(() => { if (login.state === 'pending' || login.state === 'starting') { Object.assign(login, { state: 'expired', message: 'The sign-in code expired. Start again.' }); kill(); } }, this.loginTimeoutMs);
    deadline.unref?.();
    const ready = new Promise(resolve => {
      const promptTimer = setTimeout(() => { if (login.state === 'starting') { Object.assign(login, { state: 'failed', message: 'Codex did not return a sign-in code. Try again later.' }); kill(); } resolve(); }, this.promptTimeoutMs);
      const collect = chunk => {
        if (output.length < MAX_OUTPUT) output += chunk.toString();
        if (login.state !== 'starting') return;
        const parsed = parseDeviceAuthOutput(output);
        if (parsed) { Object.assign(login, { state: 'pending', ...parsed, expiresAt: new Date(Date.now() + this.loginTimeoutMs).toISOString() }); clearTimeout(promptTimer); resolve(); }
      };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      child.on('error', () => { if (['starting', 'pending'].includes(login.state)) Object.assign(login, { state: 'failed', message: 'The Codex CLI could not start on this server.' }); clearTimeout(promptTimer); resolve(); });
      child.on('close', async code => {
        clearTimeout(deadline); clearTimeout(promptTimer);
        if (this.child === child) this.child = null;
        if (['starting', 'pending'].includes(login.state)) {
          const connected = code === 0 && await this.connected({ refresh: true });
          Object.assign(login, connected ? { state: 'connected', url: undefined, code: undefined, expiresAt: undefined } : describeLoginFailure(output));
          if (connected) this.onChange();
        }
        resolve();
      });
    });
    await ready;
    return this.status();
  }

  cancel() {
    const child = this.child;
    if (child) { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch {} }
    if (this.login && ['starting', 'pending'].includes(this.login.state)) this.login = null;
    this.child = null;
  }

  async disconnect() {
    this.cancel(); this.login = null;
    await this.run(['logout']);
    await fs.rm(path.join(this.codexHome, 'auth.json'), { force: true });
    this.statusCache = null; this.onChange();
    return this.status();
  }

  close() { this.cancel(); }
}

// ---------------------------------------------------------------------------
// Functional API for hosted routes. Every call is scoped to an explicit
// codexHome (the user's own CODEX_HOME); nothing here falls back to ~/.codex.
//   GET  /api/codex/status     -> codexLoginStatus()   {connected, account?}
//   POST /api/codex/login      -> startCodexLogin()    {id, verificationUrl, userCode, expiresAt}
//   GET  /api/codex/login/:id  -> codexLoginProgress() {state, message?}
//   POST /api/codex/logout     -> logoutCodex()        {connected:false}
// Login ids are unguessable, but routes must still check the id belongs to the
// requesting user (see codexLoginOwner / the codexHome passed at start).
// ---------------------------------------------------------------------------
const logins = new Map(); // id -> { client: CodexLogin, codexHome, startedAt, finishedAt }
const MAX_ACTIVE_LOGINS = 64, RETAIN_FINISHED_MS = 10 * 60_000, STATUS_CACHE_MS = 30_000;
const statusCache = new Map(); // codexHome -> { key, at, value }
const TERMINAL = new Set(['connected', 'failed', 'expired']);

function requireHome(codexHome) {
  if (typeof codexHome !== 'string' || !codexHome.trim()) throw fail('INVALID_ARGUMENTS', 'A per-user codexHome directory is required.');
  return path.resolve(codexHome);
}
const clientFor = ({ codexHome, codexBin, timeoutMs }) => new CodexLogin({ codexHome: requireHome(codexHome), ...(codexBin ? { executable: codexBin } : {}), ...(timeoutMs ? { loginTimeoutMs: timeoutMs } : {}) });

function progressOf(entry) {
  const login = entry.client.login;
  if (!login) return { state: 'failed', message: 'Sign-in was cancelled.' };
  const state = login.state === 'starting' ? 'pending' : login.state;
  return { state, ...(login.message ? { message: login.message } : {}) };
}

function sweep() {
  const now = Date.now();
  for (const [id, entry] of logins) {
    const { state } = progressOf(entry);
    if (TERMINAL.has(state) && !entry.finishedAt) entry.finishedAt = now;
    const stale = entry.finishedAt ? now - entry.finishedAt > RETAIN_FINISHED_MS : now - entry.startedAt > entry.client.loginTimeoutMs + RETAIN_FINISHED_MS;
    if (stale) { entry.client.cancel(); logins.delete(id); }
  }
}
const sweeper = setInterval(sweep, 60_000); sweeper.unref?.();
// Device-login children run in their own process group; never orphan them.
process.once('exit', () => { for (const entry of logins.values()) entry.client.cancel(); });

// Reads the signed-in account's email from the id_token claims in auth.json.
// The token itself is never logged or returned.
async function accountOf(codexHome) {
  try {
    const auth = JSON.parse(await fs.readFile(path.join(codexHome, 'auth.json'), 'utf8'));
    const idToken = auth?.tokens?.id_token;
    if (typeof idToken !== 'string') return undefined;
    const claims = JSON.parse(Buffer.from(idToken.split('.')[1] || '', 'base64url').toString('utf8'));
    const email = claims?.email ?? claims?.['https://api.openai.com/profile']?.email;
    return typeof email === 'string' && email.length <= 320 ? email : undefined;
  } catch { return undefined; }
}

export async function codexLoginStatus({ codexHome, codexBin } = {}) {
  const home = requireHome(codexHome);
  let key;
  try { const stat = await fs.stat(path.join(home, 'auth.json')); key = `${stat.size}:${stat.mtimeMs}`; } catch { statusCache.delete(home); return { connected: false }; }
  const cached = statusCache.get(home);
  if (cached && cached.key === key && Date.now() - cached.at < STATUS_CACHE_MS) return cached.value;
  const connected = await clientFor({ codexHome: home, codexBin }).connected({ refresh: true });
  const account = connected ? await accountOf(home) : undefined;
  const value = { connected, ...(account ? { account } : {}) };
  statusCache.set(home, { key, at: Date.now(), value });
  return value;
}

export async function startCodexLogin({ codexHome, codexBin, timeoutMs } = {}) {
  const home = requireHome(codexHome);
  sweep();
  for (const [id, entry] of logins) if (entry.codexHome === home && progressOf(entry).state === 'pending') { entry.client.cancel(); logins.delete(id); }
  if ([...logins.values()].filter(entry => progressOf(entry).state === 'pending').length >= MAX_ACTIVE_LOGINS) throw fail('RATE_LIMITED', 'Too many Codex sign-ins are in progress. Try again in a few minutes.');
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.chmod(home, 0o700).catch(() => {});
  const client = clientFor({ codexHome: home, codexBin, timeoutMs });
  client.onChange = () => statusCache.delete(home);
  await client.start();
  const login = client.login;
  if (!login || login.state !== 'pending' || !login.url || !login.code) {
    client.cancel();
    throw fail('CODEX_LOGIN_FAILED', login?.message || 'Codex did not return a sign-in code. Try again later.');
  }
  const id = randomUUID();
  logins.set(id, { client, codexHome: home, startedAt: Date.now(), finishedAt: 0 });
  return { id, verificationUrl: login.url, userCode: login.code, expiresAt: login.expiresAt };
}

export function codexLoginProgress(id) {
  const entry = typeof id === 'string' ? logins.get(id) : undefined;
  if (!entry) return { state: 'expired', message: 'This sign-in is no longer active. Start again.' };
  return progressOf(entry);
}

/** The codexHome a login id was started for, so routes can verify ownership. */
export function codexLoginOwner(id) { return typeof id === 'string' ? logins.get(id)?.codexHome : undefined; }

export function cancelCodexLogin(id) {
  const entry = typeof id === 'string' ? logins.get(id) : undefined;
  if (!entry) return false;
  entry.client.cancel(); logins.delete(id);
  return true;
}

export async function logoutCodex({ codexHome, codexBin } = {}) {
  const home = requireHome(codexHome);
  for (const [id, entry] of logins) if (entry.codexHome === home) { entry.client.cancel(); logins.delete(id); }
  statusCache.delete(home);
  await clientFor({ codexHome: home, codexBin }).disconnect();
  return { connected: false };
}
