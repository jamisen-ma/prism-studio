import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createPsdImportRoutes } from '../server/psd-import-routes.mjs';
import { PSD_IMPORT_MAX_BYTES } from '../shared/psd-import.mjs';

const id = '530fbfbe-a165-4baf-98aa-c5c11d8001f7';
const source = Buffer.from('bounded fixture bytes; parser tested independently');
const hash = data => createHash('sha256').update(data).digest('hex');
const report = { format: 'psd', importerVersion: 1, supported: true, validation: 'complete', input: { sha256: hash(source), bytes: source.length }, issues: [], warnings: [] };
const result = { document: { id, revision: 1 }, report, historyIncluded: false };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function headers(overrides = {}) { return { 'Content-Type': 'application/octet-stream', 'X-Prism-Request-Id': 'import-once', 'X-Prism-Expected-Sha256': hash(source), 'X-Prism-Importer-Version': '1', ...overrides }; }
async function fixture(t, native) {
  const handler = createPsdImportRoutes(native);
  const json = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  const server = http.createServer((request, response) => {
    handler({ request, response, url: new URL(request.url, 'http://127.0.0.1'), json }).then(handled => { if (!handled) json(response, 404, {}); }).catch(error => {
      if (!response.destroyed && !response.headersSent) json(response, 400, { error: { code: error.code, message: error.message } });
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  return { url: `http://127.0.0.1:${server.address().port}`, server };
}

test('PSD binary inspection and imports bind exact bytes, interpretation, names and policy with bounded coalescing receipts', async t => {
  const inspected = [], imported = [], queried = [];
  const { url } = await fixture(t, {
    inspectPsdImport: async args => { inspected.push(args); return report; },
    importPsd: async args => { imported.push(args); return result; },
    execute: async (command, args) => { queried.push({ command, args }); return { document: { id, revision: 2 } }; },
  });
  const options = '?assumeSrgb=true&sourceName=Original%20%CE%A9.psd&name=Editable';
  const inspection = await fetch(`${url}/api/psd/inspect-import${options}`, { method: 'POST', headers: { 'Content-Type': 'image/vnd.adobe.photoshop' }, body: source });
  assert.deepEqual(await inspection.json(), report); assert.equal(imported.length, 0); assert.equal(inspected.length, 1);
  const { signal, ...inspectedOptions } = inspected[0]; assert.equal(signal.aborted, false);
  assert.deepEqual(inspectedOptions, { data: source, assumeSrgb: true, sourceName: 'Original Ω.psd', name: 'Editable' });
  const post = (suffix = options, data = source, extra = {}) => fetch(`${url}/api/psd/import${suffix}`, { method: 'POST', headers: headers(extra), body: data });
  assert.deepEqual(await (await post()).json(), result);
  const retried = await (await post()).json(); assert.equal(retried.document.id, id); assert.equal(retried.document.revision, 2); assert.deepEqual(retried.report, report); assert.equal(imported.length, 1);
  assert.deepEqual(queried, [{ command: 'get_document', args: { documentId: id } }]);
  assert.equal(imported[0].requestId, 'import-once'); assert.equal(imported[0].expectedSha256, hash(source)); assert.equal(imported[0].importerVersion, 1);
  for (const changed of ['?assumeSrgb=false&sourceName=Original%20%CE%A9.psd&name=Editable', '?assumeSrgb=true&sourceName=Other.psd&name=Editable', '?assumeSrgb=true&sourceName=Original%20%CE%A9.psd&name=Other']) {
    assert.equal((await (await post(changed)).json()).error.code, 'REQUEST_CONFLICT');
  }
  assert.equal((await (await post(options, Buffer.from('changed'))).json()).error.code, 'INSPECTION_STALE');
  assert.equal((await (await post(options, source, { 'X-Prism-Importer-Version': '0' })).json()).error.code, 'INSPECTION_STALE');
  assert.equal((await (await post(options, source, { 'X-Prism-Expected-Sha256': 'wrong' })).json()).error.code, 'INVALID_ARGUMENTS');
  assert.equal(imported.length, 1);
});

test('PSD routes reject malformed binary options and headers before native work, while preserving bounded unsupported reports', async t => {
  let calls = 0;
  const rejected = { ...report, supported: false, validation: 'rejected', issues: [{ code: 'ICC_PROFILE_UNSUPPORTED', message: 'Unknown color profile.' }] };
  const { url } = await fixture(t, {
    inspectPsdImport: async () => { calls++; return rejected; },
    importPsd: async () => { calls++; throw Object.assign(new Error('Unsupported PSD.'), { code: 'PSD_UNSUPPORTED', report: rejected }); },
  });
  for (const options of ['?assumeSrgb=1', '?assumeSrgb=true&assumeSrgb=false', '?unknown=true', '?name=', '?sourceName=%00']) {
    const response = await fetch(`${url}/api/psd/inspect-import${options}`, { method: 'POST', headers: headers(), body: source });
    assert.equal((await response.json()).error.code, 'INVALID_ARGUMENTS');
  }
  for (const [body, type] of [[source, 'application/json'], [Buffer.alloc(0), 'application/octet-stream']]) {
    const response = await fetch(`${url}/api/psd/inspect-import`, { method: 'POST', headers: { 'Content-Type': type }, body });
    assert.ok(['INVALID_ARGUMENTS', 'PAYLOAD_TOO_LARGE'].includes((await response.json()).error.code));
  }
  const oversized = await new Promise((resolve, reject) => {
    const request = http.request(`${url}/api/psd/inspect-import`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(PSD_IMPORT_MAX_BYTES + 1) } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve(JSON.parse(Buffer.concat(chunks))));
    }); request.on('error', reject); request.end(source);
  });
  assert.equal(oversized.error.code, 'PAYLOAD_TOO_LARGE'); assert.equal(calls, 0);
  const inspect = await fetch(`${url}/api/psd/inspect-import`, { method: 'POST', headers: headers(), body: source }); assert.equal(inspect.status, 200); assert.deepEqual(await inspect.json(), rejected);
  for (let index = 0; index < 2; index++) {
    const response = await fetch(`${url}/api/psd/import`, { method: 'POST', headers: headers(), body: source });
    assert.equal(response.status, 422); const payload = await response.json(); assert.equal(payload.error.code, 'PSD_UNSUPPORTED'); assert.deepEqual(payload.report, rejected);
  }
  assert.equal(calls, 3, 'failed import receipt is removed so exact retry can run');
});

test('PSD routes coalesce concurrent identical imports, retain success after a lost response and release transfer slots', async t => {
  const barrier = deferred(), entered = deferred(); let count = 0;
  const { url } = await fixture(t, {
    importPsd: async () => { count++; entered.resolve(); await barrier.promise; return result; },
    inspectPsdImport: async () => report,
    execute: async () => ({ document: result.document }),
  });
  const lost = http.request(`${url}/api/psd/import`, { method: 'POST', headers: { ...headers(), 'Content-Length': source.length } }); lost.on('error', () => {}); lost.end(source);
  await entered.promise;
  const waiting = fetch(`${url}/api/psd/import`, { method: 'POST', headers: headers(), body: source });
  // A distinct inspection consumes no parser work when two import transfers wait.
  await new Promise(resolve => setTimeout(resolve, 20));
  const busy = await fetch(`${url}/api/psd/inspect-import`, { method: 'POST', headers: headers(), body: source }); assert.equal((await busy.json()).error.code, 'QUEUE_FULL');
  lost.destroy(); barrier.resolve(); assert.equal((await (await waiting).json()).document.id, id); assert.equal(count, 1);
  const retry = await fetch(`${url}/api/psd/import`, { method: 'POST', headers: headers(), body: source }); assert.equal((await retry.json()).document.id, id); assert.equal(count, 1);
  const free = await fetch(`${url}/api/psd/inspect-import`, { method: 'POST', headers: headers(), body: source }); assert.equal(free.status, 200); await free.json();
});

test('original PSD download verifies current archive hash and sends an inert exact attachment independently of export routes', async t => {
  const calls = []; let corrupt = false;
  const { url } = await fixture(t, { exportOriginalPsd: async args => { calls.push(args); return { data: source, sha256: corrupt ? '0'.repeat(64) : hash(source), filename: 'Original\nΩ.psd', documentId: id, revision: 4 }; } });
  const response = await fetch(`${url}/api/psd/${id}/original?expectedRevision=4`);
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), source);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream'); assert.equal(response.headers.get('content-length'), String(source.length));
  assert.equal(response.headers.get('x-prism-source-sha256'), hash(source)); assert.equal(response.headers.get('x-prism-revision'), '4'); assert.equal(response.headers.get('x-prism-document-id'), id);
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="Original__.psd"'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(calls, [{ documentId: id, expectedRevision: 4 }]);
  assert.equal((await fetch(`${url}/api/psd/${id}/export`)).status, 404);
  assert.equal((await (await fetch(`${url}/api/psd/${id}/original?expectedRevision=0`)).json()).error.code, 'INVALID_ARGUMENTS');
  corrupt = true; assert.equal((await (await fetch(`${url}/api/psd/${id}/original`)).json()).error.code, 'CORRUPT_ASSET');
});

test('disconnecting read-only PSD inspection aborts its worker signal and releases admission after termination', async t => {
  const entered = deferred(), terminated = deferred(); let calls = 0;
  const { url } = await fixture(t, { inspectPsdImport: async ({ signal }) => {
    calls++; if (calls > 1) return report;
    assert.equal(signal.aborted, false); entered.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    terminated.resolve(); throw Object.assign(new Error('Inspection cancelled.'), { code: 'ABORTED' });
  } });
  const request = http.request(`${url}/api/psd/inspect-import`, { method: 'POST', headers: { ...headers(), 'Content-Length': source.length } }); request.on('error', () => {}); request.end(source);
  await entered.promise; request.destroy(); await terminated.promise;
  const response = await fetch(`${url}/api/psd/inspect-import`, { method: 'POST', headers: headers(), body: source }); assert.equal(response.status, 200); await response.json(); assert.equal(calls, 2);
});

test('a synchronous native import rejection cannot leave a dangling successful receipt', async t => {
  let calls = 0;
  const { url } = await fixture(t, { importPsd: () => { if (++calls === 1) throw Object.assign(new Error('Admission full.'), { code: 'QUEUE_FULL' }); return result; } });
  const post = () => fetch(`${url}/api/psd/import`, { method: 'POST', headers: headers(), body: source });
  assert.equal((await (await post()).json()).error.code, 'QUEUE_FULL');
  assert.deepEqual(await (await post()).json(), result); assert.equal(calls, 2);
});
