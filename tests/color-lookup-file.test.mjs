import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readColorLookupFile } from '../server/color-lookup-mcp.mjs';
import { COLOR_LOOKUP_LIMITS } from '../shared/color-lookup.mjs';

test('local Color Lookup reader preserves original bytes through the exact size boundary', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-lut-reader-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'Original.CUBE');
  const bytes = Buffer.from('\ufeffTITLE "Original # metadata"\r\nLUT_3D_SIZE 2\r\n');
  await fs.writeFile(filename, bytes); assert.deepEqual(await readColorLookupFile(filename), bytes);
  const maximum = Buffer.alloc(COLOR_LOOKUP_LIMITS.maxBytes, 35);
  await fs.writeFile(filename, maximum); assert.deepEqual(await readColorLookupFile(filename), maximum);
  await fs.appendFile(filename, 'x'); await assert.rejects(readColorLookupFile(filename), { code: 'LIMIT_EXCEEDED' });
});

test('local Color Lookup reader refuses nonregular files without hanging or leaking contents', { timeout: 3000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-lut-reader-types-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'look.cube'); await fs.writeFile(filename, 'private-file-content');
  await assert.rejects(readColorLookupFile('look.cube'), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(readColorLookupFile(path.join(directory, 'look.png')), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(readColorLookupFile(path.join(directory, 'missing.cube')), error => error.code === 'INVALID_ARGUMENTS' && !error.message.includes(directory));
  const folder = path.join(directory, 'folder.cube'); await fs.mkdir(folder);
  await assert.rejects(readColorLookupFile(folder), { code: 'LIMIT_EXCEEDED' });
  const empty = path.join(directory, 'empty.cube'); await fs.writeFile(empty, '');
  await assert.rejects(readColorLookupFile(empty), { code: 'LIMIT_EXCEEDED' });
  if (process.platform !== 'win32') {
    const alias = path.join(directory, 'alias.cube'); await fs.symlink(filename, alias);
    await assert.rejects(readColorLookupFile(alias), { code: 'INVALID_ARGUMENTS' });
    const fifo = path.join(directory, 'pipe.cube'); execFileSync('mkfifo', [fifo]);
    await assert.rejects(readColorLookupFile(fifo), { code: 'LIMIT_EXCEEDED' });
  }
  assert.equal(await fs.readFile(filename, 'utf8'), 'private-file-content');
});
