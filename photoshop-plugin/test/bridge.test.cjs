const test = require("node:test");
const assert = require("node:assert/strict");
const {BridgeClient, BRIDGE_URL} = require("../bridge.js");
const {COMMANDS} = require("../helpers.js");
const tick = () => new Promise(resolve => setImmediate(resolve));
class Socket {
  constructor(url) { this.url = url; this.readyState = 0; this.messages = []; }
  send(message) { this.messages.push(JSON.parse(message)); }
  open() { this.readyState = 1; this.onopen(); }
  receive(message) { this.onmessage({data: JSON.stringify(message)}); }
  close() { this.readyState = 3; if (this.onclose) this.onclose({}); }
}
test("bridge follows authenticated hello/welcome and exact result protocol", async () => {
  const calls = [];
  const client = new BridgeClient({WebSocket: Socket, appVersion: "25.12.0", engine: {async execute(command, args) { calls.push({command, args}); return {document: {id: "12"}}; }}});
  client.connect("01234567890123456789");
  const socket = client.socket; assert.equal(socket.url, BRIDGE_URL); socket.open();
  assert.deepEqual(socket.messages[0], {type: "hello", token: "01234567890123456789", pluginVersion: "0.1.0", appVersion: "25.12.0", capabilities: [...COMMANDS]});
  socket.receive({type: "command", id: "too-early", command: "set_layer", args: {}});
  socket.receive({type: "welcome", protocolVersion: 1});
  socket.receive({type: "command", id: "request-1", command: "get_document", args: {documentId: "12"}});
  await tick();
  assert.deepEqual(calls, [{command: "get_document", args: {documentId: "12"}}]);
  assert.deepEqual(socket.messages[1], {type: "result", id: "request-1", result: {document: {id: "12"}}});
  client.disconnect();
});
test("failed request returns structured error and duplicate IDs do not mutate twice", async () => {
  let executions = 0;
  const client = new BridgeClient({WebSocket: Socket, appVersion: "25", engine: {async execute() { executions++; throw Object.assign(Error("Missing layer"), {code: "LAYER_NOT_FOUND"}); }}});
  client.connect("01234567890123456789"); const socket = client.socket;
  socket.open(); socket.receive({type: "welcome", protocolVersion: 1});
  socket.receive({type: "command", id: "once", command: "delete_layer", args: {}});
  await tick();
  socket.receive({type: "command", id: "once", command: "delete_layer", args: {}});
  await tick();
  assert.equal(executions, 1);
  assert.equal(socket.messages[1].error.code, "LAYER_NOT_FOUND");
  assert.equal(socket.messages[2].error.code, "DUPLICATE_REQUEST");
  client.disconnect();
});
