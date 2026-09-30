import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PSD_IMPORT_VERSION, PSD_IMPORT_MAX_BYTES, PSD_ARCHIVE_MIME } from '../shared/psd-import.mjs';

const HASH = /^[a-f0-9]{64}$/;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

async function readLocalPsd(filename) {
  if (!path.isAbsolute(filename) || path.extname(filename).toLowerCase() !== '.psd') fail('INVALID_ARGUMENTS', 'Use an absolute path to the selected .psd file.');
  const handle = await fs.open(filename, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > PSD_IMPORT_MAX_BYTES) fail('LIMIT_EXCEEDED', 'Choose a nonempty PSD file no larger than 64 MiB.');
    const buffer = Buffer.alloc(before.size + 1); let total = 0;
    while (total < buffer.length) { const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null); if (!bytesRead) break; total += bytesRead; }
    const after = await handle.stat();
    if (total !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail('INVALID_ARGUMENTS', 'The PSD file changed while being read. Wait for it to finish saving and inspect it again.');
    return buffer.subarray(0, total);
  } finally { await handle.close(); }
}

export function registerPsdImportTools(server, { companion, dataDir, textResult, failure }) {
  async function transfer(route, { data, requestId, expectedSha256, importerVersion } = {}) {
    let token;
    try { token = (await fs.readFile(path.join(dataDir, 'bridge-token'), 'utf8')).trim(); }
    catch { fail('COMPANION_UNAVAILABLE', 'Start the local Prism companion before transferring PSD files.'); }
    let response;
    try {
      response = await fetch(new URL(route, companion), { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`,
        ...(data ? { 'Content-Type': 'application/octet-stream' } : {}),
        ...(requestId ? { 'X-Prism-Request-Id': requestId, 'X-Prism-Expected-Sha256': expectedSha256, 'X-Prism-Importer-Version': String(importerVersion) } : {}) },
        ...(data ? { body: data } : {}), signal: AbortSignal.timeout(100_000), redirect: 'error' });
    } catch { fail('TRANSFER_INTERRUPTED', requestId ? 'The PSD import response was interrupted. Retry the identical file, options and requestId to recover its document; do not create a new requestId.' : 'The local PSD transfer was interrupted. The selected file was not changed.'); }
    if (!response.ok) {
      const payload = await response.json();
      throw Object.assign(new Error(payload.error?.message || 'The PSD transfer failed.'), { code: payload.error?.code, ...(payload.report ? { report: payload.report } : {}) });
    }
    if (data) return response.json();
    if (response.headers.get('content-type') !== PSD_ARCHIVE_MIME) { await response.body?.cancel(); fail('INVALID_RESPONSE', 'The companion did not return an original PSD attachment.'); }
    const declared = Number(response.headers.get('content-length')), sha256 = response.headers.get('x-prism-source-sha256'), revision = Number(response.headers.get('x-prism-revision')), documentId = response.headers.get('x-prism-document-id');
    if (!Number.isSafeInteger(declared) || declared < 1 || declared > PSD_IMPORT_MAX_BYTES || !HASH.test(sha256 || '') || !Number.isSafeInteger(revision) || revision < 1) { await response.body?.cancel(); fail('INVALID_RESPONSE', 'The original PSD response has invalid size or identity metadata.'); }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > declared) fail('INVALID_RESPONSE', 'The original PSD exceeds its declared size.'); chunks.push(Buffer.from(chunk)); }
    if (size !== declared) fail('INVALID_RESPONSE', 'The original PSD download was incomplete.');
    const bytes = Buffer.concat(chunks, size);
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) fail('CORRUPT_ASSET', 'The downloaded PSD does not match its preserved source hash.');
    return { data: bytes, sha256, revision, documentId, filename: response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] || 'Original.psd' };
  }
  const fileSchema = { path: z.string().min(1).max(4096).describe('Absolute local path to the selected .psd file.'), assumeSrgb: z.boolean().optional().describe('Explicitly interpret untagged RGB as sRGB. Never overrides an unknown embedded ICC profile.'), name: z.string().trim().min(1).max(200).optional() };
  function query(filename, assumeSrgb, name) {
    const params = new URLSearchParams({ sourceName: path.basename(filename), assumeSrgb: String(assumeSrgb ?? false) });
    if (name !== undefined) params.set('name', name);
    return params;
  }
  server.registerTool('prism_inspect_psd_import_file', {
    title: 'Inspect a local layered PSD for import',
    description: 'Read one local PSD and validate the supported RGB8 flat raster/mask subset without creating a document or storing assets. Maximum 64 MiB. Raw and PackBits channels only; unsupported structures are reported, never flattened. The complete report contains source SHA-256 and importerVersion required by prism_import_psd_file. Untagged RGB requires explicit assumeSrgb:true; unknown ICC profiles remain unsupported. Reinspect if bytes or interpretation change. Original file remains unchanged.',
    inputSchema: z.object(fileSchema).strict(),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ path: filename, assumeSrgb, name }) => { try {
    return textResult(await transfer(`/api/psd/inspect-import?${query(filename, assumeSrgb, name)}`, { data: await readLocalPsd(filename) }));
  } catch (error) { return failure(error); } });
  server.registerTool('prism_import_psd_file', {
    title: 'Import supported PSD layers and retain the original',
    description: 'Import the exact inspected local PSD as a new native document. Retains supported raster RGB/alpha, additional masks, ordering, opacity and visibility, plus an unchanged original PSD archive. Native rendering can differ from the saved Photoshop composite; review the report. Supply the inspected SHA-256/importerVersion and same interpretation/name, plus a stable requestId. Reuse the identical request after an interrupted response or restart to recover one document. Unsupported files reject with no flattening. Later edits do not change the archive. Off-canvas content follows the documented native clipping limits.',
    inputSchema: z.object({ ...fileSchema, expectedSha256: z.string().regex(HASH), importerVersion: z.literal(PSD_IMPORT_VERSION), requestId: z.string().min(1).max(160) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ path: filename, assumeSrgb, name, expectedSha256, importerVersion, requestId }) => { try {
    const data = await readLocalPsd(filename);
    if (createHash('sha256').update(data).digest('hex') !== expectedSha256) fail('INSPECTION_STALE', 'The local PSD changed since inspection. Inspect the current file again.');
    return textResult(await transfer(`/api/psd/import?${query(filename, assumeSrgb, name)}`, { data, expectedSha256, importerVersion, requestId }));
  } catch (error) { return failure(error); } });
  server.registerTool('prism_export_original_psd', {
    title: 'Download the unchanged original PSD archive',
    description: 'Write the exact retained original PSD container to a new private local file and return its path, SHA-256 and byte count. This is the archived import, not a rendering of current edits. Native documents without a source PSD archive reject. Verify the requested revision and preserved hash before writing. Use prism_export_psd for a new layered copy of the current document instead.',
    inputSchema: z.object({ documentId: z.string().uuid(), expectedRevision: z.number().int().positive().optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ documentId, expectedRevision }) => { try {
    const result = await transfer(`/api/psd/${documentId}/original${expectedRevision === undefined ? '' : `?expectedRevision=${expectedRevision}`}`);
    if (result.documentId !== documentId || (expectedRevision !== undefined && result.revision !== expectedRevision)) fail('INVALID_RESPONSE', 'The original PSD response did not match the requested document revision.');
    const directory = path.join(dataDir, 'exports'); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = String(result.filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-160) || 'Original.psd';
    const destination = path.join(directory, `${randomUUID()}-${filename}`); await fs.writeFile(destination, result.data, { flag: 'wx', mode: 0o600 });
    return textResult({ path: destination, mimeType: PSD_ARCHIVE_MIME, documentId, revision: result.revision, bytes: result.data.length, sha256: result.sha256, original: true });
  } catch (error) { return failure(error); } });
}
