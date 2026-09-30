import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCompanion } from '../server/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const value = response => { assert.notEqual(response.isError, true, JSON.stringify(response.content)); return response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text); };
async function snapshot(directory, prefix = '') {
  const result = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const filename = path.join(directory, entry.name), name = prefix + entry.name;
    if (entry.isDirectory()) result.push([name, 'directory'], ...await snapshot(filename, name + '/'));
    else result.push([name, createHash('sha256').update(await fs.readFile(filename)).digest('hex')]);
  }
  return result;
}

test('all custom MCP tools reject unknown options before file, HTTP, generation or document effects', { timeout: 20000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-strict-mcp-'));
  let forbiddenCalls = 0, stderr = ''; const traffic = [];
  const forbidden = async () => { forbiddenCalls++; throw Error('This isolated schema test cannot use a provider, key or segmentation model'); };
  const companion = await createCompanion({ dataDir, port: 0, getImageKey: forbidden, imageProvider: forbidden, segmentSubject: forbidden });
  companion.server.on('request', request => traffic.push(new URL(request.url, 'http://127.0.0.1').pathname));
  const port = await companion.listen(), client = new Client({ name: 'strict-public-input-tests', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
  transport.stderr?.on('data', bytes => { stderr += bytes; });
  t.after(async () => { await client.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); assert.equal(forbiddenCalls, 0); assert.ok(!stderr.includes(companion.token)); });
  await client.connect(transport);
  const call = (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args });
  const tools = (await client.listTools()).tools;
  for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must advertise strict input`);

  // Valid setup uses public SDK tools and a real Codex awaiting-image job.
  // The malformed calls below have otherwise usable arguments and real files.
  assert.equal(value(await call('ai_status')).configurationChecked, false);
  let document = value(await call('create_document', { backend: 'native', name: 'Strict input fixture', width: 32, height: 32, background: '#804020' })).document;
  document = value(await call('select_rectangle', { backend: 'native', documentId: document.id, expectedRevision: document.revision, x: 0, y: 0, width: 16, height: 32 })).document;
  const doc = { documentId: document.id, expectedRevision: document.revision };
  const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#2255bb' } }).png().toBuffer(), filename = path.join(dataDir, 'fixture.png'); await fs.writeFile(filename, png);
  const bundle = value(await call('export_project', doc)), psd = value(await call('export_psd', doc));
  const psdReport = value(await call('inspect_psd_import_file', { path: psd.path })); assert.equal(psdReport.supported, true);
  const psdArgs = { path: psd.path, expectedSha256: psdReport.input.sha256, importerVersion: psdReport.importerVersion, requestId: 'valid-strict-psd-fixture' };
  const imported = value(await call('import_psd_file', psdArgs)).document;
  const job = value(await call('generate_image', { prompt: 'Cream paper background', requestId: 'valid-strict-handoff' })).job;
  assert.equal(job.status, 'awaiting_image'); assert.equal(job.provider, 'codex');
  const jobArgs = { jobId: job.id };
  const cases = [
    ['status', {}, { verbose: true }],
    ['tool_catalog', {}, { engine: 'native' }],
    ['import_file', { path: filename, requestId: 'invalid-extra-import' }, { resize: 8 }],
    ['ai_status', {}, { apiKey: 'not-a-credential' }],
    ['generate_image', { prompt: 'A background', requestId: 'invalid-extra-mode' }, { mode: 'edit' }],
    ['generate_image', { provider: 'openai', prompt: 'A background', requestId: 'invalid-extra-mask' }, { mask: { x: 0, y: 0, width: 1, height: 1 } }],
    ['edit_image', { ...doc, scope: 'selection', prompt: 'Change only the selected background', requestId: 'invalid-edit-mode' }, { mode: 'generate' }],
    ['edit_image', { ...doc, scope: 'selection', prompt: 'Keep exact people', requestId: 'invalid-edit-mask' }, { mask: filename, strength: .5 }],
    ['list_generation_jobs', {}, { includeCredentials: true }],
    ['get_generation_job', jobArgs, { includeCredentials: true }],
    ['get_generation_preview', jobArgs, { format: 'jpeg' }],
    ['cancel_generation', jobArgs, { force: true }],
    ['apply_generation', { ...jobArgs, expectedRevision: document.revision }, { replaceProtected: true }],
    ['inspect_psd_export', doc, { flatten: true }],
    ['export_psd', doc, { flatten: true }],
    ['export_project', doc, { includeHistory: true }],
    ['import_project_file', { path: bundle.path, requestId: 'invalid-project-import' }, { replaceDocumentId: document.id }],
    ['get_generation_handoff', jobArgs, { regenerate: true }],
    ['complete_generation', { ...jobArgs, path: filename }, { replaceProtected: true }],
    ['inspect_psd_import_file', { path: psd.path }, { flatten: true }],
    ['import_psd_file', { ...psdArgs, requestId: 'invalid-psd-import' }, { flatten: true }],
    ['export_original_psd', { documentId: imported.id, expectedRevision: imported.revision }, { flatten: true }],
  ];
  assert.equal(new Set(cases.map(([name]) => name)).size, 20);
  const before = await snapshot(dataDir), requestCount = traffic.length;
  for (const [name, args, extra] of cases) {
    const response = await call(name, { ...args, ...extra });
    assert.equal(response.isError, true, name);
    const message = response.content.filter(item => item.type === 'text').map(item => item.text).join(' ');
    assert.match(message, /Input validation error|Invalid arguments for tool/, name);
    assert.match(message, /[Uu]nrecognized key/, name);
    assert.equal(traffic.length, requestCount, `${name} must reject before its HTTP callback`);
  }
  assert.deepEqual(await snapshot(dataDir), before, 'Malformed calls must not change projects, jobs, assets, handoff files or exports');
  assert.equal(forbiddenCalls, 0);
  assert.equal(value(await call('get_generation_job', jobArgs)).job.status, 'awaiting_image');
  assert.deepEqual(value(await call('get_document', { backend: 'native', documentId: document.id })).document, document);
  // Legitimate optional/default fields and exact completion retry still work.
  const completed = value(await call('complete_generation', { ...jobArgs, path: filename })); assert.equal(completed.job.status, 'succeeded');
  const repeated = value(await call('complete_generation', { ...jobArgs, path: filename })); assert.equal(repeated.job.id, completed.job.id); assert.equal(repeated.job.status, 'succeeded');
  assert.deepEqual(value(await call('get_document', { backend: 'native', documentId: completed.document.id })).document, completed.document);
  assert.deepEqual(await fs.readFile(filename), png);
});
