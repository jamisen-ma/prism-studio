#!/usr/bin/env node
// Private per-turn transport. No filesystem/editor tools are implemented here;
// the companion owns validation, cancellation and durable execution receipts.
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { openBoundedFile, readBoundedHandle } from './bounded-file.mjs';

const configFile = process.argv[2];
const opened = await openBoundedFile(configFile, { maxBytes: 8192 });
let context;
try { context = JSON.parse((await readBoundedHandle(opened.handle, { bytes: opened.bytes })).data); }
finally { await opened.handle.close(); }
const address = new URL(context.baseUrl);
if (address.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(address.hostname) || address.username || address.password || !/^[a-f0-9-]{36}$/.test(context.turnId) || !/^[a-f0-9]{64}$/.test(context.capabilityToken)) throw new Error('Invalid private chat context.');
const endpoint = new URL(`/api/chat/${context.turnId}/`, address);
async function request(route, body) {
  const response = await fetch(new URL(route, endpoint), {
    method: body ? 'POST' : 'GET', redirect: 'error',
    headers: { Authorization: `Bearer ${context.capabilityToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw new Error('The editor tool result exceeded its limit.');
    chunks.push(chunk);
  }
  const result = JSON.parse(Buffer.concat(chunks).toString());
  if (!response.ok) throw new Error(result.error?.message || 'The local editing tool could not complete this request.');
  return result;
}
const server = new Server({ name: 'prism-chat', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: 'Use Prism tools to inspect, edit or generate actual images. Discover a command schema before executing it. Changes are retained in the editor; only report observed results.' });
server.setRequestHandler(ListToolsRequestSchema, async () => request('tools'));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try { return await request('tool', { name: params.name, arguments: params.arguments || {}, callId: randomUUID() }); }
  catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
});
await server.connect(new StdioServerTransport());
