const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const UUID = '[a-fA-F0-9-]{36}';

// Called after Host/Origin validation but before the browser session check.
// A scoped capability cannot authorize any route outside these exact paths.
export async function handleChatToolRoute({ request, response, url, manager, readJson, json }) {
  const match = new RegExp(`^/api/chat/(${UUID})/(tools|tool)$`).exec(url.pathname);
  if (!match) return false;
  const [, id, action] = match, token = request.headers.authorization?.replace(/^Bearer /, '');
  manager.authenticate(id, token);
  if (action === 'tools' && request.method === 'GET') { json(response, 200, await manager.tools(id, token)); return true; }
  if (action === 'tool' && request.method === 'POST') { json(response, 200, await manager.tool(id, token, await readJson(request, { maxBytes: 1024 * 1024 }))); return true; }
  fail('NOT_FOUND', 'Unknown chat tool endpoint.');
}

// Public chat metadata/mutations require the ordinary companion session.
export async function handleChatRoute({ request, response, url, manager, readJson, json }) {
  if (!url.pathname.startsWith('/api/chat')) return false;
  if (url.pathname === '/api/chat' && request.method === 'GET') { json(response, 200, await manager.list()); return true; }
  if (url.pathname === '/api/chat' && request.method === 'POST') { json(response, 202, await manager.start(await readJson(request, { maxBytes: 128 * 1024 }))); return true; }
  const match = new RegExp(`^/api/chat/(${UUID})/cancel$`).exec(url.pathname);
  if (match && request.method === 'POST') {
    const body = await readJson(request);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) fail('INVALID_ARGUMENTS', 'Cancel accepts an empty object.');
    json(response, 200, await manager.cancel(match[1])); return true;
  }
  fail('NOT_FOUND', 'Unknown chat endpoint.');
}
