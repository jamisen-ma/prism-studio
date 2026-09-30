import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createHostedServer } from '../server/hosted.mjs';

export const png = await sharp({ create: { width: 16, height: 12, channels: 4, background: '#3366cc' } }).png().toBuffer();
const offline = { check: async () => ({ available: false }), generate: async () => { throw new Error('No generation in tests.'); }, run: async () => { throw new Error('No chat in tests.'); } };

export async function hostedFixture(t, options = {}) {
  const dataRoot = options.dataRoot ?? await fs.mkdtemp(path.join(os.tmpdir(), 'prism-hosted-'));
  const server = await createHostedServer({ port: 0, dataRoot, signupCode: 'let-me-in', segmentationEnabled: false, codexImageAdapter: offline, chatAdapter: offline, codexExecutable: '/nonexistent/codex', ...options });
  const port = await server.listen('127.0.0.1');
  t.after(async () => { await server.close(); if (!options.keep) await fs.rm(dataRoot, { recursive: true, force: true }); });
  return { server, dataRoot, base: `http://127.0.0.1:${port}` };
}

/** Minimal browser-like client: one cookie jar plus the session's CSRF token. */
export function client(base) {
  let cookie = '', token = '';
  async function request(method, pathname, { body, headers = {}, raw, auth = true } = {}) {
    const response = await fetch(base + pathname, {
      method, redirect: 'manual',
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(auth && token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : raw !== undefined ? { body: raw } : {}),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) { const value = setCookie.split(';')[0]; cookie = value.endsWith('=') ? '' : value; }
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, headers: response.headers };
  }
  return {
    request,
    get cookie() { return cookie; }, set cookie(value) { cookie = value; },
    get token() { return token; }, set token(value) { token = value; },
    async signUp(email, password = 'correct horse battery', inviteCode = 'let-me-in') {
      const result = await request('POST', '/api/auth/signup', { body: { email, password, inviteCode } });
      if (result.data?.token) token = result.data.token;
      return result;
    },
    async signIn(email, password = 'correct horse battery') {
      const result = await request('POST', '/api/auth/signin', { body: { email, password } });
      if (result.data?.token) token = result.data.token;
      return result;
    },
    command(command, args = {}, backend = 'native') { return request('POST', '/api/command', { body: { backend, command, args } }); },
    importImage(name = 'Photo') { return this.command('import_image', { name, data: png.toString('base64'), mimeType: 'image/png' }); },
  };
}
