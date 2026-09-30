import { createHash } from 'node:crypto';
import { PSD_IMPORT_MAX_BYTES } from '../shared/psd-import.mjs';

const HASH = /^[a-f0-9]{64}$/;
const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_PROJECT_BUNDLE' }); };
export function safePsdFilename(value) {
  const basename = value.replaceAll('\\', '/').split('/').at(-1).replace(/[^a-zA-Z0-9 ._-]/g, '_').replace(/^\.+/, '').replace(/\.psd$/i, '').trim().slice(0, 156).trim();
  return `${basename || 'Original'}.psd`;
}
export function validateSourceDocument(graph) {
  if (graph.sourceDocument === undefined) return;
  const source = graph.sourceDocument;
  if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).length !== 4 || !['format', 'asset', 'bytes', 'name'].every(key => Object.hasOwn(source, key)) || source.format !== 'psd' || !HASH.test(source.asset) || !Number.isSafeInteger(source.bytes) || source.bytes < 26 || source.bytes > PSD_IMPORT_MAX_BYTES || typeof source.name !== 'string' || source.name !== safePsdFilename(source.name)) fail('The preserved source document metadata is invalid.');
  for (const layer of graph.layers ?? []) for (const field of ['asset', 'sourceAsset', 'alphaAsset']) if (layer[field] === source.asset) fail('A preserved source document cannot also be a raster asset.');
}
/** Passive archive validation only. No PSD parser or raster decoder runs here;
 * the attached archive never certifies or changes the independently read graph. */
export function validateSourceDocumentBytes(data, source) {
  if (!Buffer.isBuffer(data) || data.length !== source.bytes || data.length < 26 || data.length > PSD_IMPORT_MAX_BYTES || createHash('sha256').update(data).digest('hex') !== source.asset) fail('The preserved PSD source does not match its immutable length and hash.');
  if (data.toString('ascii', 0, 4) !== '8BPS' || data.readUInt16BE(4) !== 1 || !data.subarray(6, 12).every(v => v === 0)) fail('The preserved source is not a supported PSD v1 archive.');
  const channels = data.readUInt16BE(12), height = data.readUInt32BE(14), width = data.readUInt32BE(18), depth = data.readUInt16BE(22), mode = data.readUInt16BE(24);
  if (channels !== 3 || depth !== 8 || mode !== 3 || !width || !height || width > 8192 || height > 8192 || width * height > 24_000_000) fail('The preserved PSD archive header exceeds the supported bounds.');
}
