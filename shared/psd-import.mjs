import { createHash } from 'node:crypto';

// Interpretation and transport identity, shared by native publication and HTTP.
// Browser code reads these values from capabilities/reports, never this Node module.
export const PSD_IMPORT_VERSION = 1;
export const PSD_IMPORT_SUBSET = 'rgb8-flat-raster-v1';
export const PSD_IMPORT_MAX_BYTES = 64 * 1024 * 1024;
export const PSD_ARCHIVE_MIME = 'application/octet-stream';

export function psdImportFingerprint({ sha256, sourceName = 'Original.psd', name, assumeSrgb = false, importerVersion = PSD_IMPORT_VERSION }) {
  return createHash('sha256').update(JSON.stringify({ sha256, sourceName, name: name ?? null, assumeSrgb, importerVersion })).digest('hex');
}
