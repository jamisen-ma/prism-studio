import { createHash, randomUUID } from 'node:crypto';
import { PROJECT_BUNDLE_LIMITS } from './project-bundle.mjs';

export const PROJECT_MIME = 'application/x-prism-project';
export const MAX_PROJECT_BUNDLE_BYTES = PROJECT_BUNDLE_LIMITS.maxBundleBytes;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

async function readBundle(request) {
  const type = String(request.headers['content-type'] || '').split(';')[0].trim();
  if (![PROJECT_MIME, 'application/octet-stream'].includes(type)) fail('INVALID_ARGUMENTS', 'Send a binary .prism project file.');
  const declared = request.headers['content-length'] === undefined ? undefined : Number(request.headers['content-length']);
  if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 1 || declared > MAX_PROJECT_BUNDLE_BYTES)) fail('PAYLOAD_TOO_LARGE', 'Project files must be nonempty and no larger than 256 MiB.');
  let total = 0;
  const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_PROJECT_BUNDLE_BYTES) fail('PAYLOAD_TOO_LARGE', 'The project file exceeds the 256 MiB limit.');
    chunks.push(chunk);
  }
  if (!total || declared !== undefined && total !== declared) fail('INVALID_ARGUMENTS', 'The project upload was incomplete.');
  return Buffer.concat(chunks, total);
}

// This handler runs only after the companion's Host/Origin and token checks.
// Its binary limit is separate from the regular JSON command-body limit.
export function createProjectRoutes(native) {
  let transfers = 0;
  const requests = new Map();
  return async function handleProjectRoute({ request, response, url, json }) {
    if (!url.pathname.startsWith('/api/projects/')) return false;
    if (transfers >= 2) fail('QUEUE_FULL', 'Two project transfers are already in progress. Wait for one to finish.');
    transfers++;
    try {
      if (request.method === 'POST' && url.pathname === '/api/projects/import') {
        const rawName = url.searchParams.get('name');
        const name = rawName?.trim();
        if (rawName !== null && (!name || name.length > 200)) fail('INVALID_ARGUMENTS', 'Project names must contain 1–200 characters.');
        const requestId = request.headers['x-prism-request-id'] ?? randomUUID();
        if (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 160) fail('INVALID_ARGUMENTS', 'Use a stable project import request ID containing 1–160 characters.');
        const data = await readBundle(request);
        const fingerprint = createHash('sha256').update(data).update('\0').update(name ?? '').digest('hex');
        let entry = requests.get(requestId);
        if (entry) {
          if (entry.fingerprint !== fingerprint) fail('REQUEST_CONFLICT', 'This request ID was already used for a different project import.');
          const result = entry.promise ? await entry.promise : { ...(await native.execute('get_document', { documentId: entry.documentId })), historyIncluded: false };
          json(response, 200, result); return true;
        }
        entry = { fingerprint, promise: null, documentId: null };
        requests.set(requestId, entry);
        const operation = native.importProject({ data, ...(name ? { name } : {}) });
        entry.promise = operation;
        let result;
        try {
          result = await operation;
          entry.documentId = result.document.id;
        } catch (error) { requests.delete(requestId); throw error; }
        finally { entry.promise = null; }
        // Retain only small receipts, never completed file buffers/graphs.
        for (const [key, value] of requests) {
          if (requests.size <= 200) break;
          if (!value.promise) requests.delete(key);
        }
        // Keep a successful receipt even when the client disconnects or its
        // response write fails after native persistence. A retry must recover
        // the imported document, not create another one.
        if (!response.destroyed) json(response, 200, result);
        return true;
      }
      const match = /^\/api\/projects\/([^/]+)\/export$/.exec(url.pathname);
      if (request.method === 'GET' && match) {
        if (!UUID.test(match[1])) fail('INVALID_ARGUMENTS', 'Use a valid native document ID.');
        const rawRevision = url.searchParams.get('expectedRevision');
        const expectedRevision = rawRevision === null ? undefined : Number(rawRevision);
        if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) fail('INVALID_ARGUMENTS', 'Use a positive expectedRevision for project export.');
        const result = await native.exportProject({ documentId: match[1], ...(expectedRevision === undefined ? {} : { expectedRevision }) });
        // A disconnected client may have emitted close while native encoding
        // was still queued. Do not wait for a second close event that cannot
        // occur, or its bounded transfer slot would remain occupied forever.
        if (response.destroyed || request.aborted) return true;
        if (!Buffer.isBuffer(result.data) || result.data.length > MAX_PROJECT_BUNDLE_BYTES) fail('LIMIT_EXCEEDED', 'The project exceeds the portable file limit.');
        const filename = String(result.filename || 'Project.prism').replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 160);
        response.writeHead(200, { 'Content-Type': PROJECT_MIME, 'Content-Length': result.data.length,
          'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'X-Prism-Document-Id': result.documentId, 'X-Prism-Revision': String(result.revision), 'X-Prism-History-Included': 'false' });
        await new Promise(resolve => {
          const done = () => { response.off('finish', done); response.off('close', done); resolve(); };
          response.once('finish', done); response.once('close', done);
          response.end(result.data);
        });
        return true;
      }
      fail('NOT_FOUND', 'Unknown project transfer endpoint.');
    } finally { transfers--; }
  };
}
