import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { hostedFixture, client, png } from './hosted-helpers.mjs';

async function twoUsers(t, options) {
  const fixture = await hostedFixture(t, options);
  const a = client(fixture.base), b = client(fixture.base);
  assert.equal((await a.signUp('a@example.com')).status, 200);
  assert.equal((await b.signUp('b@example.com')).status, 200);
  return { ...fixture, a, b };
}

test('user B cannot list, read, modify, export or delete user A documents and assets', async t => {
  const { a, b, server, dataRoot } = await twoUsers(t);
  const imported = await a.importImage('A private photo');
  assert.equal(imported.status, 200);
  const document = imported.data.result.document, documentId = document.id, layer = document.layers[0];
  assert.equal((await a.command('list_documents')).data.result.documents.length, 1);
  assert.deepEqual((await b.command('list_documents')).data.result.documents, []);
  for (const [command, args] of [
    ['get_document', { documentId }],
    ['get_preview', { documentId, maxWidth: 64 }],
    ['get_layer_preview', { documentId, layerId: layer.id, view: 'source', maxWidth: 64 }],
    ['export_document', { documentId, format: 'png' }],
    ['set_layer', { documentId, layerId: layer.id, opacity: 0.5 }],
    ['add_adjustment', { documentId, kind: 'exposure', value: 1 }],
    ['undo', { documentId }],
  ]) {
    const result = await b.command(command, args);
    assert.equal(result.status, 404, `${command} must not reach another account's document`);
    assert.match(result.data.error.code, /^(DOCUMENT_)?NOT_FOUND$/);
  }
  assert.equal((await b.request('GET', `/api/projects/${documentId}/export`)).status, 404);
  assert.equal((await b.request('GET', `/api/psd/${documentId}/export`)).status, 404);
  assert.equal((await b.request('DELETE', `/api/documents/${documentId}`)).status, 404);
  // A can still edit its own document, and B's own document is invisible to A.
  const edited = await a.command('add_adjustment', { documentId, kind: 'exposure', value: 0.5 });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  const own = (await b.importImage('B photo')).data.result.document;
  assert.equal((await a.command('get_document', { documentId: own.id })).status, 404);
  assert.deepEqual((await a.command('list_documents')).data.result.documents.map(item => item.id), [documentId]);
  // Chat history and image jobs are per account too.
  assert.deepEqual((await b.request('GET', '/api/ai/jobs')).data.jobs, []);
  assert.deepEqual((await b.request('GET', '/api/chat')).data.turns, []);
  // Each account's files live under its own directory.
  const [userA, userB] = [...server.users.values()].sort((x, y) => x.email.localeCompare(y.email));
  const projectsA = await fs.readdir(path.join(dataRoot, 'users', userA.id, 'native', 'projects'));
  const projectsB = await fs.readdir(path.join(dataRoot, 'users', userB.id, 'native', 'projects'));
  assert.deepEqual(projectsA, [`${documentId}.json`]); assert.deepEqual(projectsB, [`${own.id}.json`]);
  await assert.rejects(fs.access(path.join(dataRoot, 'users', userB.id, 'native', 'projects', `${documentId}.json`)));
  // Codex state is per account and never the owner's ~/.codex.
  assert.equal((await fs.stat(path.join(dataRoot, 'users', userA.id, 'codex-home'))).isDirectory(), true);
  assert.deepEqual((await b.request('GET', '/api/codex/status')).data, { connected: false });
});

test('deleting a document frees its assets without touching other documents', async t => {
  const { a, server, dataRoot } = await twoUsers(t);
  const first = (await a.importImage('First')).data.result.document;
  const second = (await a.importImage('Second')).data.result.document;
  const [user] = [...server.users.values()].filter(item => item.email === 'a@example.com');
  const assets = path.join(dataRoot, 'users', user.id, 'native', 'assets');
  const before = (await fs.readdir(assets)).filter(name => /^[a-f0-9]{64}$/.test(name));
  const removed = await a.request('DELETE', `/api/documents/${first.id}`);
  assert.equal(removed.status, 200); assert.equal(removed.data.deleted, true);
  assert.equal(removed.data.removedAssets, 0, 'Identical imported bytes remain referenced by the second document.');
  assert.deepEqual((await a.command('list_documents')).data.result.documents.map(item => item.id), [second.id]);
  assert.equal((await a.command('get_preview', { documentId: second.id, maxWidth: 32 })).status, 200);
  assert.deepEqual((await fs.readdir(assets)).filter(name => /^[a-f0-9]{64}$/.test(name)).sort(), before.sort());
  const last = await a.request('DELETE', `/api/documents/${second.id}`);
  assert.ok(last.data.removedAssets >= 1);
  assert.deepEqual((await fs.readdir(assets)).filter(name => /^[a-f0-9]{64}$/.test(name)), []);
  const usage = await a.request('GET', '/api/account');
  assert.equal(usage.data.usage.documents, 0);
});

test('per-account document, upload and storage limits', async t => {
  const { a, b } = await twoUsers(t, { maxDocuments: 2, maxUploadBytes: 1024 * 1024, maxStorageBytes: 16 * 1024 * 1024 });
  assert.equal((await a.importImage('One')).status, 200);
  const two = (await a.importImage('Two')).data.result.document;
  const third = await a.importImage('Three');
  assert.equal(third.status, 400); assert.equal(third.data.error.code, 'LIMIT_EXCEEDED');
  assert.equal((await a.command('create_document', { name: 'Blank', width: 32, height: 32 })).data.error.code, 'LIMIT_EXCEEDED');
  assert.equal((await b.importImage('B is separate')).status, 200, 'Limits are per account.');
  await a.request('DELETE', `/api/documents/${two.id}`);
  assert.equal((await a.importImage('Three again')).status, 200);
  const big = await a.request('POST', '/api/command', { raw: JSON.stringify({ backend: 'native', command: 'import_image', args: { name: 'Big', data: 'A'.repeat(2 * 1024 * 1024), mimeType: 'image/png' } }), headers: { 'Content-Type': 'application/json' } });
  assert.equal(big.status, 413);
  const project = await a.request('POST', '/api/projects/import', { raw: Buffer.alloc(2 * 1024 * 1024), headers: { 'Content-Type': 'application/x-prism-project' } });
  assert.equal(project.status, 413);
  assert.ok(png.length < 1024);
});

test('storage quota blocks new writes once an account is full', async t => {
  const { a, server, dataRoot } = await twoUsers(t, { maxStorageBytes: 16 * 1024 * 1024 });
  assert.equal((await a.importImage('Seed')).status, 200);
  const [user] = [...server.users.values()].filter(item => item.email === 'a@example.com');
  await fs.writeFile(path.join(dataRoot, 'users', user.id, 'filler.bin'), Buffer.alloc(17 * 1024 * 1024));
  server.workspaces.get(user.id).usage = null;
  const blocked = await a.importImage('Over quota');
  assert.equal(blocked.status, 413); assert.equal(blocked.data.error.code, 'STORAGE_LIMIT');
  assert.equal((await a.command('list_documents')).status, 200, 'Reads keep working while full.');
});
