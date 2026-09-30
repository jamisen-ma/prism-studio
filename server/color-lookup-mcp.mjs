import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { commandSchemas, validateCommand } from '../shared/commands.mjs';
import { COLOR_LOOKUP_LIMITS } from '../shared/color-lookup.mjs';

const fail = (message, code = 'INVALID_ARGUMENTS') => { throw Object.assign(new Error(message), { code }); };

export async function readColorLookupFile(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || path.extname(filename).toLowerCase() !== '.cube') fail('Choose an absolute path to a local .cube file.');
  let handle;
  try {
    handle = await fs.open(filename, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > COLOR_LOOKUP_LIMITS.maxBytes) fail('Choose a regular .cube file between 1 byte and 4 MiB.', 'LIMIT_EXCEEDED');
    const bytes = Buffer.alloc(stat.size + 1); let total = 0;
    while (total < bytes.length) {
      const result = await handle.read(bytes, total, bytes.length - total, null);
      if (!result.bytesRead) break;
      total += result.bytesRead;
    }
    if (total !== stat.size || (await handle.stat()).size !== stat.size) fail('The lookup file changed size while being read. Wait for it to finish saving.');
    return bytes.subarray(0, total);
  } catch (cause) {
    if (cause.code === 'LIMIT_EXCEEDED' || cause.code === 'INVALID_ARGUMENTS') throw cause;
    fail('The selected lookup file is missing, unreadable or not a regular local file.');
  } finally { if (handle) await handle.close().catch(() => {}); }
}

export function registerColorLookupTools(server, { request, textResult, failure }) {
  server.registerTool('prism_import_color_lookup_file', {
    title: 'Import a local Color Lookup',
    description: 'Read one explicit local .cube file, at most 4 MiB, and atomically add or replace a native Color Lookup. Require colorLookupPolicy=cube3d-f64-trilinear-srgb-v1, cube-3d format and the context kind/command. Explicit inputSpace=srgb interprets both input and output as encoded sRGB; no log/HDR conversion or automatic detection occurs. Supports 3D grids 2–33, exact identity domain and unit-range samples. target=adjustment adds unless layerId selects an existing lookup; target=layer-filter requires layerId and replaces only when filterId is supplied. Replacement retains identity, name, mask, blend, opacity and enabled state. A new global lookup adopts the current selection mask. Original bytes travel with .prism and Undo; lookup-bearing recipes are unsupported. Supply the latest positive expectedRevision and stable requestId. Reuse identical arguments after an uncertain response only within the same companion session; no automatic retry or durable receipt. Symbolic links and nonregular files are refused.',
    inputSchema: commandSchemas.import_color_lookup.omit({ data: true, sourceName: true }).extend({
      path: z.string().min(1).max(4096),
      requestId: z.string().min(1).max(160).describe('Stable identifier for this exact file and target; do not generate a new ID to retry an uncertain import.'),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ path: filename, requestId, ...target }) => {
    try {
      // Target validation precedes file access; the real encoding is checked
      // again by the companion/native schema before any decoded allocation.
      const sourceName = path.basename(filename);
      validateCommand('import_color_lookup', { ...target, data: 'AA==', sourceName });
      const data = await readColorLookupFile(filename);
      return textResult(await request('/api/command', { backend: 'native', command: 'import_color_lookup', requestId, args: { ...target, sourceName, data: data.toString('base64') } }));
    } catch (cause) { return failure(cause); }
  });
}
