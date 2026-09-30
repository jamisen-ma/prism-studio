import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const validSize = bytes => Number.isSafeInteger(bytes) && bytes > 0;
const DEFAULT_MESSAGE = 'The image asset is missing, corrupt or unreadable.';

/** The caller retains this descriptor from admission through the bounded read.
 * Never follow a symlink or reopen by pathname after inspecting its size. */
export async function openBoundedFile(file, { maxBytes, exactBytes, code = 'INVALID_IMAGE', message = DEFAULT_MESSAGE } = {}) {
  if (!validSize(maxBytes) || (exactBytes !== undefined && (!validSize(exactBytes) || exactBytes > maxBytes))) fail(code, message);
  let handle;
  try {
    // A FIFO can block in open before fstat rejects it. Nonblocking open has
    // no effect on ordinary files and lets us reject nonregular nodes safely.
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || !validSize(stat.size) || (exactBytes !== undefined && stat.size !== exactBytes)) fail(code, message);
    if (stat.size > maxBytes) fail('LIMIT_EXCEEDED', 'The image asset exceeds its bounded file-size limit.');
    return { handle, bytes: stat.size };
  } catch (cause) {
    if (handle) await handle.close().catch(() => {});
    if (cause.code === 'LIMIT_EXCEEDED') throw cause;
    fail(code, message);
  }
}

/** Read precisely the admitted length. Growth never enlarges the allocation;
 * truncation, final size changes and an immutable hash mismatch all reject. */
export async function readBoundedHandle(handle, { bytes, expectedHash, code = 'INVALID_IMAGE', message = DEFAULT_MESSAGE } = {}) {
  if (!validSize(bytes) || (expectedHash !== undefined && !/^[a-f0-9]{64}$/.test(expectedHash))) fail(code, message);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== bytes) fail(code, message);
    const data = Buffer.allocUnsafe(bytes), hash = createHash('sha256');
    let offset = 0;
    while (offset < bytes) {
      const length = Math.min(64 * 1024, bytes - offset);
      const read = await handle.read(data, offset, length, offset);
      if (!Number.isInteger(read.bytesRead) || read.bytesRead <= 0 || read.bytesRead > length) fail(code, message);
      hash.update(data.subarray(offset, offset + read.bytesRead));
      offset += read.bytesRead;
    }
    const after = await handle.stat(), sha256 = hash.digest('hex');
    if (!after.isFile() || after.size !== bytes || (expectedHash !== undefined && sha256 !== expectedHash)) fail(code, message);
    return { data, sha256 };
  } catch { fail(code, message); }
}
