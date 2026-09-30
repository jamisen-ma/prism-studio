import { createHash } from 'node:crypto';
import { PSD_MIME_TYPE } from './psd-export.mjs';
import { PSD_IMPORT_VERSION, PSD_IMPORT_MAX_BYTES, PSD_ARCHIVE_MIME, psdImportFingerprint } from '../shared/psd-import.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const sha256 = data => createHash('sha256').update(data).digest('hex');

function options(url) {
  for (const key of url.searchParams.keys()) if (!['assumeSrgb', 'sourceName', 'name'].includes(key) || url.searchParams.getAll(key).length !== 1) fail('INVALID_ARGUMENTS', 'Use one value for each supported PSD import option.');
  const rawAssumption = url.searchParams.get('assumeSrgb');
  if (rawAssumption !== null && !['true', 'false'].includes(rawAssumption)) fail('INVALID_ARGUMENTS', 'assumeSrgb must be true or false.');
  const sourceName = url.searchParams.get('sourceName') ?? 'Original.psd', name = url.searchParams.get('name');
  for (const value of [sourceName, ...(name === null ? [] : [name])]) if (!value.trim() || value.length > 200 || !value.isWellFormed() || /[\u0000-\u001f\u007f]/.test(value)) fail('INVALID_ARGUMENTS', 'PSD names must contain 1–200 characters without control characters.');
  return { assumeSrgb: rawAssumption === 'true', sourceName, ...(name === null ? {} : { name }) };
}

async function readPsd(request) {
  const type = String(request.headers['content-type'] || '').split(';')[0].trim();
  if (![PSD_MIME_TYPE, 'application/octet-stream'].includes(type)) fail('INVALID_ARGUMENTS', 'Send binary PSD bytes.');
  const rawLength = request.headers['content-length'], declared = rawLength === undefined ? undefined : Number(rawLength);
  if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 1 || declared > PSD_IMPORT_MAX_BYTES)) fail('PAYLOAD_TOO_LARGE', 'PSD files must be nonempty and no larger than 64 MiB.');
  let total = 0; const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > PSD_IMPORT_MAX_BYTES || (declared !== undefined && total > declared)) fail('PAYLOAD_TOO_LARGE', 'The PSD upload exceeds its file limit.');
    chunks.push(chunk);
  }
  if (!total || declared !== undefined && total !== declared) fail('INVALID_ARGUMENTS', 'The PSD upload was incomplete.');
  return Buffer.concat(chunks, total);
}

// Call only after Host/Origin/session validation. This handler deliberately
// leaves the existing PSD export routes for their separate compatibility path.
export function createPsdImportRoutes(native) {
  let transfers = 0;
  const requests = new Map();
  return async function handlePsdImportRoute({ request, response, url, json }) {
    const inspect = url.pathname === '/api/psd/inspect-import', importing = url.pathname === '/api/psd/import';
    const original = /^\/api\/psd\/([^/]+)\/original$/.exec(url.pathname);
    if (!inspect && !importing && !original) return false;
    if (request.method !== (original ? 'GET' : 'POST')) fail('NOT_FOUND', 'Unknown PSD import endpoint.');
    if (transfers >= 2) fail('QUEUE_FULL', 'Two PSD import transfers are already in progress. Wait for one to finish.');
    transfers++;
    try {
      if (original) {
        if (!UUID.test(original[1])) fail('INVALID_ARGUMENTS', 'Use a valid native document ID.');
        for (const key of url.searchParams.keys()) if (key !== 'expectedRevision' || url.searchParams.getAll(key).length !== 1) fail('INVALID_ARGUMENTS', 'Only one expectedRevision is supported for original PSD download.');
        const rawRevision = url.searchParams.get('expectedRevision'), expectedRevision = rawRevision === null ? undefined : Number(rawRevision);
        if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) fail('INVALID_ARGUMENTS', 'Use a positive expectedRevision for original PSD download.');
        const result = await native.exportOriginalPsd({ documentId: original[1], ...(expectedRevision === undefined ? {} : { expectedRevision }) });
        if (response.destroyed || request.aborted) return true;
        if (!Buffer.isBuffer(result.data) || result.data.length < 1 || result.data.length > PSD_IMPORT_MAX_BYTES) fail('LIMIT_EXCEEDED', 'The original PSD exceeds its 64 MiB archive limit.');
        const hash = sha256(result.data);
        if (result.sha256 !== hash) fail('CORRUPT_ASSET', 'The original PSD no longer matches its immutable identifier.');
        const filename = String(result.filename || 'Original.psd').replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 160);
        response.writeHead(200, { 'Content-Type': PSD_ARCHIVE_MIME, 'Content-Length': result.data.length,
          'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'X-Prism-Document-Id': result.documentId, 'X-Prism-Revision': String(result.revision), 'X-Prism-Source-Sha256': hash });
        await new Promise(resolve => {
          const done = () => { response.off('finish', done); response.off('close', done); resolve(); };
          response.once('finish', done); response.once('close', done); response.end(result.data);
        });
        return true;
      }
      const interpretation = options(url);
      let requestId, expectedSha256, importerVersion;
      if (importing) {
        requestId = request.headers['x-prism-request-id']; expectedSha256 = request.headers['x-prism-expected-sha256'];
        const rawVersion = request.headers['x-prism-importer-version'];
        if (typeof requestId !== 'string' || !requestId.length || requestId.length > 160) fail('INVALID_ARGUMENTS', 'Use a stable PSD import request ID containing 1–160 characters.');
        if (typeof expectedSha256 !== 'string' || !HASH.test(expectedSha256)) fail('INVALID_ARGUMENTS', 'Use the SHA-256 from the PSD inspection report.');
        if (rawVersion !== String(PSD_IMPORT_VERSION)) fail('INSPECTION_STALE', 'The PSD importer version changed. Inspect this file again.');
        importerVersion = PSD_IMPORT_VERSION;
      }
      const data = await readPsd(request);
      if (inspect) {
        if (response.destroyed || request.aborted) return true;
        const controller = new AbortController(), cancel = () => controller.abort();
        request.once('aborted', cancel); response.once('close', cancel);
        try {
          const report = await native.inspectPsdImport({ data, ...interpretation, signal: controller.signal });
          if (!response.destroyed) json(response, 200, report);
        } finally { request.off('aborted', cancel); response.off('close', cancel); }
        return true;
      }
      const hash = sha256(data);
      if (hash !== expectedSha256) fail('INSPECTION_STALE', 'The PSD bytes differ from the inspected file. Inspect this file again.');
      const fingerprint = psdImportFingerprint({ sha256: hash, ...interpretation, importerVersion });
      let entry = requests.get(requestId);
      if (entry && entry.fingerprint !== fingerprint) fail('REQUEST_CONFLICT', 'This request ID was already used for a different PSD import.');
      if (entry) {
        const result = entry.promise ? await entry.promise : { ...(await native.execute('get_document', { documentId: entry.documentId })), report: entry.report, historyIncluded: false };
        if (!response.destroyed) json(response, 200, result);
        return true;
      }
      entry = { fingerprint, promise: null, documentId: null, report: null };
      requests.set(requestId, entry);
      // An accepted import finishes despite any one caller disconnecting.
      // Another waiter may share it, and its durable receipt recovers a lost
      // response. Read-only inspections above have a different abort policy.
      const operation = Promise.resolve().then(() => native.importPsd({ data, ...interpretation, expectedSha256, importerVersion, requestId }));
      entry.promise = operation;
      let result;
      try { result = await operation; entry.documentId = result.document.id; entry.report = result.report; }
      catch (error) { requests.delete(requestId); throw error; }
      finally { entry.promise = null; }
      // Only small receipts are retained here. Native publication also stores
      // request identity atomically, so restart recovery does not duplicate it.
      for (const [key, value] of requests) { if (requests.size <= 200) break; if (!value.promise) requests.delete(key); }
      if (!response.destroyed) json(response, 200, result);
      return true;
    } catch (error) {
      if (error.report) {
        if (!response.destroyed) json(response, 422, { ok: false, error: { code: error.code || 'INVALID_PSD', message: error.message }, report: error.report });
        return true;
      }
      throw error;
    } finally { transfers--; }
  };
}
