import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import WebSocket from 'ws';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCompanion } from '../server/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const paintTools = ['brush', 'pencil', 'eraser', 'clone', 'heal', 'dodge', 'burn', 'blur', 'sharpen', 'smudge', 'sponge', 'red_eye', 'color_replace'];
const levelParameters = { black: 0, white: 255, gamma: 1.4, outputBlack: 0, outputWhite: 255 };
const curveParameters = { channel: 'red', points: [{ x: 0, y: 0 }, { x: 128, y: 180 }, { x: 255, y: 255 }] };

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-pro-service-'));
  let app;
  let url;
  const clients = [];
  const start = async () => {
    app = await createCompanion({ dataDir, port: 0 });
    url = `http://127.0.0.1:${await app.listen()}`;
  };
  t.after(async () => {
    for (const client of clients) await client.close();
    if (app) await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await start();
  const request = async (route, body) => {
    const response = await fetch(url + route, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${app.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const command = (command, args = {}, extra = {}) => request('/api/command', { backend: 'native', command, args, ...extra });
  const run = async (commandName, args = {}, extra = {}) => {
    const response = await command(commandName, args, extra);
    assert.equal(response.status, 200, `${commandName}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.ok, true);
    return response.body.result;
  };
  const preview = async documentId => {
    const result = await run('get_preview', { documentId, maxWidth: 128 });
    return sharp(Buffer.from(result.data, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  };
  const mcp = async () => {
    const client = new Client({ name: 'prism-professional-integration', version: '1.0.0' });
    clients.push(client);
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { ...process.env, PRISM_URL: url, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
    transport.stderr.on('data', () => {});
    await client.connect(transport);
    return { client, call: (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args }) };
  };
  return { dataDir, request, command, run, preview, mcp, get app() { return app; }, get url() { return url; }, async reopen() { await app.close(); await start(); } };
}

async function create(env, options = {}) {
  return (await env.run('create_document', { name: 'Professional service fixture', width: 40, height: 32, background: '#406080', ...options })).document;
}

async function importPattern(env) {
  const width = 32, height = 24;
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    raw[offset] = 150 + x * 2 + ((x + y) % 2) * 25;
    raw[offset + 1] = 30 + y * 2;
    raw[offset + 2] = 20 + ((x * 3 + y * 7) % 60);
    raw[offset + 3] = 255;
  }
  const bytes = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const { document } = await env.run('import_image', { name: 'Retouch pixel fixture', mimeType: 'image/png', data: bytes.toString('base64') });
  return { document, bytes };
}

function mcpResult(response) {
  assert.notEqual(response.isError, true, JSON.stringify(response.content));
  return response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text);
}

test('all paint tools execute over authenticated HTTP, alter real pixels only within the selection, and undo exactly', async t => {
  const env = await fixture(t);
  for (const tool of paintTools) await t.test(tool, async () => {
    const { document, bytes } = await importPattern(env);
    const initial = await env.preview(document.id);
    const layerId = document.layers[0].id;
    const selected = (await env.run('select_region', { documentId: document.id, shape: 'rectangle', x: 8, y: 6, width: 16, height: 12 })).document;
    const args = {
      documentId: document.id, expectedRevision: selected.revision, layerId, tool,
      points: [{ x: 10.5, y: 12.5, pressure: 1 }, { x: 21.5, y: 12.5, pressure: 0.8 }],
      size: 18, hardness: 0.6, opacity: 1, color: '#22aa66',
      strength: tool === 'sponge' ? -100 : 100,
      ...(tool === 'color_replace' ? { tolerance: 80 } : {}),
      ...(['clone', 'heal'].includes(tool) ? { source: { x: 2.5, y: 2.5 } } : {}),
    };
    const edited = (await env.run('paint_stroke', args, { requestId: `paint-${tool}` })).document;
    assert.equal(edited.revision, selected.revision + 1);
    assert.equal(edited.history.length, selected.history.length + 1);
    assert.equal(edited.layers.length, 1);
    assert.equal(edited.layers[0].id, layerId);
    assert.equal(edited.layers[0].sourceAsset, document.layers[0].sourceAsset);
    const after = await env.preview(document.id);
    let changed = 0;
    for (let y = 0; y < 24; y++) for (let x = 0; x < 32; x++) {
      const offset = (y * 32 + x) * 4;
      const beforePixel = initial.data.subarray(offset, offset + 4);
      const afterPixel = after.data.subarray(offset, offset + 4);
      if (x < 8 || x >= 24 || y < 6 || y >= 18) assert.deepEqual(afterPixel, beforePixel, `${tool} changed protected pixel ${x},${y}`);
      else if (!afterPixel.equals(beforePixel)) changed++;
    }
    assert.ok(changed > 0, `${tool} must change at least one selected pixel`);
    assert.deepEqual((await env.run('paint_stroke', args, { requestId: `paint-${tool}` })).document, edited, 'Retries must not reapply the stroke');
    assert.deepEqual(await fs.readFile(path.join(env.dataDir, 'native', 'assets', document.layers[0].sourceAsset)), bytes);
    await env.run('undo', { documentId: document.id, expectedRevision: edited.revision });
    assert.deepEqual((await env.preview(document.id)).data, initial.data);
  });
});

test('histogram describes the actual visible composite without changing revision, history, or activity', async t => {
  const env = await fixture(t);
  const initial = await create(env, { width: 32, height: 32, background: '#804020' });
  const document = (await env.run('set_layer_mask', { documentId: initial.id, layerId: initial.layers[0].id, mask: { x: 4, y: 8, width: 12, height: 8 } })).document;
  const activity = (await env.request('/api/activity')).body.activity;
  const first = await env.run('get_histogram', { documentId: document.id });
  assert.equal(first.pixelCount, 96);
  assert.equal(first.red[128], 96);
  assert.equal(first.green[64], 96);
  assert.equal(first.blue[32], 96);
  for (const channel of ['red', 'green', 'blue', 'luminance']) {
    assert.equal(first[channel].length, 256);
    assert.equal(first[channel].reduce((sum, count) => sum + count, 0), 96);
  }
  assert.deepEqual((await env.run('get_document', { documentId: document.id })).document, document);
  assert.deepEqual((await env.request('/api/activity')).body.activity, activity);
  await env.run('set_layer_mask', { documentId: document.id, layerId: document.layers[0].id, mask: null });
  assert.equal((await env.run('get_histogram', { documentId: document.id })).pixelCount, 1024);
});

test('curves and levels remain editable through masked transactions, rollback, save, service restart, and undo', async t => {
  const env = await fixture(t);
  const initial = await create(env);
  const initialPixels = (await env.preview(initial.id)).data;
  const mask = { shape: 'ellipse', x: 8, y: 4, width: 24, height: 24, feather: 1 };
  const added = (await env.run('apply_transaction', { documentId: initial.id, expectedRevision: initial.revision, label: 'Masked tonal correction', operations: [
    { command: 'add_adjustment', args: { kind: 'levels', value: 0, parameters: levelParameters, mask, name: 'Editable levels' } },
    { command: 'add_adjustment', args: { kind: 'curves', value: 0, parameters: curveParameters, mask, name: 'Editable red curve' } },
  ] })).document;
  assert.equal(added.revision, initial.revision + 1);
  assert.equal(added.history.length, initial.history.length + 1);
  assert.equal(added.layers.length, 3);
  const [levels, curves] = added.layers.slice(1);
  assert.deepEqual(levels.parameters, levelParameters);
  assert.deepEqual(curves.parameters, curveParameters);
  const beforeUpdate = (await env.preview(initial.id)).data;
  assert.notDeepEqual(beforeUpdate, initialPixels);
  assert.deepEqual(beforeUpdate.subarray(0, 4), initialPixels.subarray(0, 4));
  const polygon = { shape: 'polygon', x: 5, y: 4, width: 30, height: 24, points: [{ x: 5, y: 4 }, { x: 35, y: 4 }, { x: 5, y: 28 }], feather: 0 };
  const updatedParameters = { ...levelParameters, gamma: 1.8 };
  const updatedCurve = { channel: 'blue', points: [{ x: 0, y: 0 }, { x: 128, y: 200 }, { x: 255, y: 255 }] };
  const updated = (await env.run('apply_transaction', { documentId: initial.id, expectedRevision: added.revision, label: 'Revise tone and masks', operations: [
    { command: 'update_adjustment', args: { layerId: levels.id, parameters: updatedParameters, mask: polygon } },
    { command: 'update_adjustment', args: { layerId: curves.id, parameters: updatedCurve } },
    { command: 'set_layer_mask', args: { layerId: curves.id, mask: polygon } },
  ] })).document;
  assert.equal(updated.layers.length, 3);
  assert.deepEqual(updated.layers.map(layer => layer.id), added.layers.map(layer => layer.id));
  assert.equal(updated.revision, added.revision + 1);
  assert.equal(updated.history.length, added.history.length + 1);
  assert.deepEqual(updated.layers[1].parameters, updatedParameters);
  assert.deepEqual(updated.layers[2].parameters, updatedCurve);
  const finalPixels = (await env.preview(initial.id)).data;
  assert.notDeepEqual(finalPixels, beforeUpdate);
  assert.deepEqual(finalPixels.subarray(0, 4), initialPixels.subarray(0, 4));

  const failed = await env.command('apply_transaction', { documentId: initial.id, expectedRevision: updated.revision, label: 'Rollback partial edit', operations: [
    { command: 'update_adjustment', args: { layerId: levels.id, parameters: { ...levelParameters, gamma: 0.5 } } },
    { command: 'set_layer_mask', args: { layerId: 'missing-layer', mask: null } },
  ] });
  assert.equal(failed.status, 404);
  assert.equal(failed.body.error.code, 'NOT_FOUND');
  assert.deepEqual((await env.run('get_document', { documentId: initial.id })).document, updated);
  assert.deepEqual((await env.preview(initial.id)).data, finalPixels);
  assert.equal((await env.run('save_document', { documentId: initial.id })).saved, true);
  await env.reopen();
  assert.deepEqual((await env.run('get_document', { documentId: initial.id })).document, updated);
  assert.deepEqual((await env.preview(initial.id)).data, finalPixels);
  const undone = (await env.run('undo', { documentId: initial.id, expectedRevision: updated.revision })).document;
  assert.equal(undone.revision, updated.revision + 1);
  assert.deepEqual((await env.preview(initial.id)).data, beforeUpdate);
  assert.deepEqual(undone.layers[1].parameters, levelParameters);
  await env.run('undo', { documentId: initial.id, expectedRevision: undone.revision });
  assert.deepEqual((await env.preview(initial.id)).data, initialPixels);
});

test('competing professional edits enforce expectedRevision and preserve the winning stroke', async t => {
  const env = await fixture(t);
  const { document } = await importPattern(env);
  const args = { documentId: document.id, layerId: document.layers[0].id, expectedRevision: document.revision, tool: 'pencil', points: [{ x: 12, y: 12 }], size: 7, hardness: 1, opacity: 1, color: '#00ff00' };
  const responses = await Promise.all([
    env.command('paint_stroke', args, { requestId: 'concurrent-pencil-1' }),
    env.command('paint_stroke', { ...args, color: '#0000ff' }, { requestId: 'concurrent-pencil-2' }),
  ]);
  assert.equal(responses.filter(response => response.status === 200).length, 1);
  const conflict = responses.find(response => response.status !== 200);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'REVISION_CONFLICT');
  const winner = responses.find(response => response.status === 200).body.result.document;
  assert.deepEqual((await env.run('get_document', { documentId: document.id })).document, winner);
  const pixels = (await env.preview(document.id)).data;
  const staleMask = await env.command('set_layer_mask', { documentId: document.id, expectedRevision: document.revision, layerId: args.layerId, mask: { x: 0, y: 0, width: 4, height: 4 } });
  assert.equal(staleMask.status, 409);
  assert.deepEqual((await env.preview(document.id)).data, pixels);
});

test('unsupported Photoshop options return explicit errors before any command reaches a fake UXP peer', async t => {
  const env = await fixture(t);
  const peer = new WebSocket(env.url.replace('http:', 'ws:') + '/bridge');
  t.after(() => peer.terminate());
  await once(peer, 'open');
  const welcome = once(peer, 'message');
  peer.send(JSON.stringify({ type: 'hello', token: env.app.token, pluginVersion: 'test-fake', appVersion: 'test-fake', capabilities: ['add_adjustment', 'add_text', 'apply_transaction'] }));
  assert.equal(JSON.parse((await welcome)[0].toString()).type, 'welcome');
  const received = [];
  peer.on('message', bytes => received.push(JSON.parse(bytes.toString())));
  const unsupported = [
    ['add_adjustment', { kind: 'levels', value: 0, parameters: levelParameters }, /scalar adjustments/i],
    ['add_adjustment', { kind: 'curves', value: 0, parameters: curveParameters }, /scalar adjustments/i],
    ['add_adjustment', { kind: 'exposure', value: 1, mask: { shape: 'ellipse', x: 0, y: 0, width: 10, height: 10 } }, /rectangular masks/i],
    ['add_text', { text: 'Unsupported style', x: 0, y: 0, fontSize: 12, color: '#ffffff', fontFamily: 'serif' }, /typography.*native/i],
    ['get_histogram', {}, /does not support get_histogram/i],
    ['paint_stroke', { layerId: 'fake-layer', tool: 'pencil', points: [{ x: 3, y: 3 }], size: 3, hardness: 1, opacity: 1, color: '#ffffff' }, /does not support paint_stroke/i],
    ['apply_transaction', { label: 'Unsupported native curve', operations: [{ command: 'add_adjustment', args: { kind: 'curves', value: 0, parameters: curveParameters } }] }, /scalar adjustments/i],
  ];
  for (const [command, args, message] of unsupported) {
    const response = await env.command(command, { documentId: 'fake-document', ...args }, { backend: 'photoshop' });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'UNSUPPORTED_COMMAND');
    assert.match(response.body.error.message, message);
  }
  assert.deepEqual(received, [], 'Unsupported options must never be silently stripped or forwarded');
});

test('official MCP client can discover professional tools, paint pencil and color replacement, and read real histograms', { timeout: 15000 }, async t => {
  const env = await fixture(t);
  const { document } = await importPattern(env);
  const { client, call } = await env.mcp();
  const { tools } = await client.listTools();
  const strokeTool = tools.find(tool => tool.name === 'prism_paint_stroke');
  for (const tool of paintTools) assert.ok(strokeTool.inputSchema.properties.tool.enum.includes(tool));
  assert.equal(tools.find(tool => tool.name === 'prism_get_histogram').annotations.readOnlyHint, true);
  const before = await env.preview(document.id);
  const pencil = mcpResult(await call('paint_stroke', { backend: 'native', documentId: document.id, layerId: document.layers[0].id, expectedRevision: document.revision, tool: 'pencil', points: [{ x: 16, y: 12 }], size: 8, hardness: 0, opacity: 1, color: '#ff0000' })).document;
  assert.equal(pencil.revision, document.revision + 1);
  const painted = await env.preview(document.id);
  assert.notDeepEqual(painted.data, before.data);
  assert.deepEqual([...painted.data.subarray((12 * 32 + 16) * 4, (12 * 32 + 16) * 4 + 4)], [255, 0, 0, 255]);
  const replaced = mcpResult(await call('paint_stroke', { backend: 'native', documentId: document.id, layerId: document.layers[0].id, expectedRevision: pencil.revision, tool: 'color_replace', points: [{ x: 16.5, y: 12.5 }], size: 6, hardness: 1, opacity: 1, strength: 100, tolerance: 0, color: '#00ff00' })).document;
  assert.equal(replaced.revision, pencil.revision + 1);
  const after = await env.preview(document.id);
  const center = after.data.subarray((12 * 32 + 16) * 4, (12 * 32 + 16) * 4 + 4);
  assert.ok(center[1] > center[0] && center[1] > center[2], 'Color replacement must make the target green');
  const histogram = mcpResult(await call('get_histogram', { backend: 'native', documentId: document.id }));
  assert.deepEqual(histogram, await env.run('get_histogram', { documentId: document.id }));
  assert.equal(histogram.pixelCount, 32 * 24);
  assert.deepEqual((await env.run('get_document', { documentId: document.id })).document, replaced);
  const response = await call('get_preview', { backend: 'native', documentId: document.id, maxWidth: 32 });
  mcpResult(response);
  const block = response.content.find(item => item.type === 'image');
  assert.ok(block);
  assert.deepEqual(await sharp(Buffer.from(block.data, 'base64')).ensureAlpha().raw().toBuffer(), after.data);
});

test('MCP creates and revises editable shapes, Bezier paths, and gradients in atomic transactions that survive service restart', { timeout: 15000 }, async t => {
  const env = await fixture(t);
  const initial = await create(env, { width: 64, height: 48, background: '#000000' });
  const before = (await env.preview(initial.id)).data;
  const { client, call } = await env.mcp();
  const { tools } = await client.listTools();
  for (const command of ['add_shape', 'update_shape', 'add_path', 'update_path', 'add_gradient', 'update_gradient']) {
    assert.ok(tools.some(tool => tool.name === `prism_${command}`));
  }
  const added = mcpResult(await call('apply_transaction', { backend: 'native', documentId: initial.id, expectedRevision: initial.revision, label: 'Editable vector composition', operations: [
    { command: 'add_gradient', args: { kind: 'linear', start: { x: 0.5, y: 0.5 }, end: { x: 63.5, y: 0.5 }, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#0000ff' }], name: 'Blue gradient' } },
    { command: 'add_shape', args: { shape: 'rectangle', x: 6, y: 8, width: 20, height: 24, fill: '#00ff00', stroke: null, name: 'Editable shape' } },
    { command: 'add_path', args: { nodes: [{ x: 36, y: 8, out: { x: 44, y: 2 } }, { x: 58, y: 8, in: { x: 50, y: 2 } }, { x: 48, y: 36 }], closed: true, fill: '#ff0000', stroke: null, name: 'Bezier path' } },
  ] })).document;
  assert.equal(added.revision, initial.revision + 1);
  assert.equal(added.history.length, initial.history.length + 1);
  assert.deepEqual(added.layers.map(layer => layer.type), ['solid', 'gradient', 'shape', 'path']);
  const [gradient, shape, vectorPath] = added.layers.slice(1);
  assert.equal(vectorPath.vector.nodes[0].out.y, 2);
  const composed = (await env.preview(initial.id)).data;
  const pixel = (buffer, x, y) => [...buffer.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4)];
  assert.deepEqual(pixel(composed, 16, 20), [0, 255, 0, 255]);
  assert.deepEqual(pixel(composed, 48, 16), [255, 0, 0, 255]);
  assert.deepEqual(pixel(composed, 63, 47), [0, 0, 255, 255]);

  const updated = mcpResult(await call('apply_transaction', { backend: 'native', documentId: initial.id, expectedRevision: added.revision, label: 'Revise vectors without flattening', operations: [
    { command: 'update_gradient', args: { layerId: gradient.id, kind: 'radial', start: { x: 32, y: 24 }, end: { x: 64, y: 24 } } },
    { command: 'update_shape', args: { layerId: shape.id, shape: 'ellipse', fill: '#ffff00' } },
    { command: 'update_path', args: { layerId: vectorPath.id, fill: '#ffffff', nodes: [{ x: 34, y: 8, out: { x: 40, y: 0 } }, { x: 60, y: 8, in: { x: 54, y: 0 } }, { x: 48, y: 38 }] } },
  ] })).document;
  assert.equal(updated.revision, added.revision + 1);
  assert.deepEqual(updated.layers.map(layer => layer.id), added.layers.map(layer => layer.id));
  assert.equal(updated.layers[1].gradient.kind, 'radial');
  assert.equal(updated.layers[2].vector.shape, 'ellipse');
  assert.equal(updated.layers[3].vector.nodes[0].out.y, 0);
  const revised = (await env.preview(initial.id)).data;
  assert.deepEqual(pixel(revised, 16, 20), [255, 255, 0, 255]);
  assert.deepEqual(pixel(revised, 48, 16), [255, 255, 255, 255]);
  assert.notDeepEqual(revised, composed);
  const stale = await env.command('update_shape', { documentId: initial.id, layerId: shape.id, expectedRevision: added.revision, fill: '#ff00ff' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'REVISION_CONFLICT');
  await env.run('save_document', { documentId: initial.id });
  await env.reopen();
  assert.deepEqual((await env.run('get_document', { documentId: initial.id })).document, updated);
  assert.deepEqual((await env.preview(initial.id)).data, revised);
  await env.run('undo', { documentId: initial.id, expectedRevision: updated.revision });
  assert.deepEqual((await env.preview(initial.id)).data, composed);
  await env.run('undo', { documentId: initial.id });
  assert.deepEqual((await env.preview(initial.id)).data, before);
});

test('color selection, fill, eyedropper, and bitmap layer masks agree over MCP and HTTP and survive reopening', { timeout: 15000 }, async t => {
  const env = await fixture(t);
  const width = 32, height = 24;
  const source = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const red = y >= 6 && y < 18 && ((x >= 4 && x < 10) || (x >= 22 && x < 28));
    source.set(red ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * width + x) * 4);
  }
  const png = await sharp(source, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const initial = (await env.run('import_image', { name: 'Disconnected color islands', mimeType: 'image/png', data: png.toString('base64') })).document;
  const layerId = initial.layers[0].id;
  const { client, call } = await env.mcp();
  const tools = (await client.listTools()).tools;
  for (const name of ['sample_color', 'select_color', 'fill_area', 'mask_from_selection']) assert.ok(tools.some(tool => tool.name === `prism_${name}`));
  assert.equal(tools.find(tool => tool.name === 'prism_sample_color').annotations.readOnlyHint, true);
  const sample = mcpResult(await call('sample_color', { backend: 'native', documentId: initial.id, x: 6, y: 10 }));
  assert.deepEqual(sample, { x: 6, y: 10, radius: 0, red: 255, green: 0, blue: 0, alpha: 255, hex: '#ff0000' });
  assert.deepEqual((await env.run('get_document', { documentId: initial.id })).document, initial);
  const filled = mcpResult(await call('apply_transaction', { backend: 'native', documentId: initial.id, expectedRevision: initial.revision, label: 'Fill one connected red island', operations: [
    { command: 'select_color', args: { x: 6, y: 10, tolerance: 0, contiguous: true } },
    { command: 'fill_area', args: { layerId, color: '#00ff00' } },
  ] })).document;
  assert.equal(filled.history.length, initial.history.length + 1);
  assert.equal(filled.revision, initial.revision + 1);
  assert.equal(filled.selection.shape, 'bitmap');
  const painted = (await env.preview(initial.id)).data;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    if (x >= 4 && x < 10 && y >= 6 && y < 18) assert.deepEqual([...painted.subarray(offset, offset + 4)], [0, 255, 0, 255]);
    else assert.deepEqual(painted.subarray(offset, offset + 4), source.subarray(offset, offset + 4));
  }
  const undone = (await env.run('undo', { documentId: initial.id, expectedRevision: filled.revision })).document;
  assert.deepEqual((await env.preview(initial.id)).data, source);
  const masked = (await env.run('apply_transaction', { documentId: initial.id, expectedRevision: undone.revision, label: 'Mask all matching islands', operations: [
    { command: 'select_color', args: { x: 6, y: 10, tolerance: 0, contiguous: false } },
    { command: 'mask_from_selection', args: { layerId } },
    { command: 'clear_selection', args: {} },
  ] })).document;
  assert.equal(masked.layers[0].mask.shape, 'bitmap');
  assert.equal(masked.selection, null);
  assert.equal((await env.run('get_histogram', { documentId: initial.id })).pixelCount, 144);
  assert.equal((await env.run('sample_color', { documentId: initial.id, x: 0, y: 0 })).alpha, 0);
  assert.equal((await env.run('sample_color', { documentId: initial.id, x: 24, y: 10 })).hex, '#ff0000');
  const maskedPixels = (await env.preview(initial.id)).data;
  await env.run('save_document', { documentId: initial.id });
  await env.reopen();
  assert.deepEqual((await env.run('get_document', { documentId: initial.id })).document, masked);
  assert.deepEqual((await env.preview(initial.id)).data, maskedPixels);
  await env.run('undo', { documentId: initial.id, expectedRevision: masked.revision });
  assert.deepEqual((await env.preview(initial.id)).data, source);
  const erased = (await env.run('fill_area', { documentId: initial.id, layerId, x: 6, y: 10, mode: 'erase', tolerance: 0, contiguous: true })).document;
  assert.equal((await env.run('sample_color', { documentId: initial.id, x: 6, y: 10 })).alpha, 0);
  assert.equal((await env.run('sample_color', { documentId: initial.id, x: 24, y: 10 })).alpha, 255);
  await env.run('undo', { documentId: initial.id, expectedRevision: erased.revision });
  assert.deepEqual((await env.preview(initial.id)).data, source);
  assert.deepEqual(await fs.readFile(path.join(env.dataDir, 'native', 'assets', initial.layers[0].sourceAsset)), png);
});
