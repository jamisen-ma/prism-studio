import { PSD_EXPORT_LIMITS, PSD_MIME_TYPE } from './psd-export.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

// Authentication and Host/Origin checks are enforced by the companion before
// this handler. Downloads are binary and do not consume the JSON body budget.
export function createPsdRoutes(native) {
  let transfers = 0;
  return async function handlePsdRoute({ request, response, url, json }) {
    if (!url.pathname.startsWith('/api/psd/')) return false;
    const match = /^\/api\/psd\/([^/]+)\/(inspect|export)$/.exec(url.pathname);
    if (request.method !== 'GET' || !match) fail('NOT_FOUND', 'Unknown PSD export endpoint.');
    if (!UUID.test(match[1])) fail('INVALID_ARGUMENTS', 'Use a valid native document ID.');
    const raw = url.searchParams.get('expectedRevision'), expectedRevision = raw === null ? undefined : Number(raw);
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) fail('INVALID_ARGUMENTS', 'Use a positive expectedRevision for PSD export.');
    if (transfers >= 2) fail('QUEUE_FULL', 'Two PSD inspections or downloads are already in progress. Wait for one to finish.');
    transfers++;
    try {
      const args = { documentId: match[1], ...(expectedRevision === undefined ? {} : { expectedRevision }) };
      if (match[2] === 'inspect') {
        const report = await native.inspectPsdExport(args);
        if (!response.destroyed) json(response, 200, report);
        return true;
      }
      let result;
      try { result = await native.exportPsd(args); }
      catch (error) {
        if (error.code === 'PSD_UNSUPPORTED' && error.report) {
          if (!response.destroyed) json(response, 422, { ok: false, error: { code: error.code, message: error.message }, report: error.report });
          return true;
        }
        throw error;
      }
      if (response.destroyed || request.aborted) return true;
      if (!Buffer.isBuffer(result.data) || result.data.length < 1 || result.data.length > PSD_EXPORT_LIMITS.maxOutputBytes) fail('LIMIT_EXCEEDED', 'The PSD exceeds its 64 MiB output limit.');
      const filename = String(result.filename || 'Image.psd').replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 160);
      response.writeHead(200, { 'Content-Type': PSD_MIME_TYPE, 'Content-Length': result.data.length,
        'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'X-Prism-Document-Id': result.documentId, 'X-Prism-Revision': String(result.revision), 'X-Prism-Layer-Count': String(result.report.layerCount) });
      await new Promise(resolve => {
        const done = () => { response.off('finish', done); response.off('close', done); resolve(); };
        response.once('finish', done); response.once('close', done); response.end(result.data);
      });
      return true;
    } finally { transfers--; }
  };
}
