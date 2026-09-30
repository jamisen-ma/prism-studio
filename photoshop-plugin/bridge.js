"use strict";
const {COMMANDS, makeQueue} = require("./helpers.js");
const BRIDGE_URL = "ws://127.0.0.1:43120/bridge";

class BridgeClient {
  constructor({WebSocket, engine, appVersion, onStatus = () => {}, onActivity = () => {}}) {
    this.WebSocket = WebSocket; this.engine = engine; this.appVersion = appVersion;
    this.onStatus = onStatus; this.onActivity = onActivity;
    this.socket = null; this.connected = false; this.queue = makeQueue();
  }
  connect(token) {
    if (typeof token !== "string" || token.trim().length < 16) throw new Error("Paste the pairing token from Prism Studio's Photoshop setup.");
    if (this.socket) this.disconnect();
    const socket = new this.WebSocket(BRIDGE_URL);
    const seen = new Set();
    this.socket = socket;
    this.connected = false;
    this.onStatus("connecting", "Connecting to Prism Studio…");
    const handshakeTimeout = setTimeout(() => {
      if (this.socket === socket && !this.connected) {
        this.onStatus("error", "The companion did not accept pairing. Check the token and try again.");
        socket.close();
      }
    }, 5000);
    socket.onopen = () => {
      socket.send(JSON.stringify({type: "hello", token: token.trim(), pluginVersion: "0.1.0", appVersion: this.appVersion, capabilities: [...COMMANDS]}));
      token = "";
    };
    socket.onmessage = event => {
      if (this.socket !== socket) return;
      let message;
      try { message = JSON.parse(event.data); } catch (_) { this.onActivity("error", "Companion sent invalid JSON."); return; }
      if (message.type === "welcome") {
        if (message.protocolVersion !== 1) { this.onStatus("error", "Companion protocol version is incompatible."); socket.close(); return; }
        clearTimeout(handshakeTimeout); this.connected = true;
        this.onStatus("connected", "Connected · ready for edits"); return;
      }
      if (message.type !== "command" || !this.connected) return;
      if (typeof message.id !== "string" || !message.id || typeof message.command !== "string") return;
      if (seen.has(message.id)) {
        this.send({type: "result", id: message.id, error: {code: "DUPLICATE_REQUEST", message: "This request ID was already received. It was not executed again."}}, socket); return;
      }
      if (seen.size >= 10000) {
        this.send({type: "result", id: message.id, error: {code: "RECONNECT_REQUIRED", message: "Reconnect the panel to continue after 10000 requests."}}, socket); return;
      }
      seen.add(message.id);
      this.queue(async () => {
        if (this.socket !== socket || !this.connected) return;
        this.onActivity("running", message.command.replace(/_/g, " "));
        try {
          if (!message.args || typeof message.args !== "object" || Array.isArray(message.args)) message.args = {};
          const result = await this.engine.execute(message.command, message.args);
          this.send({type: "result", id: message.id, result}, socket);
          this.onActivity("success", message.command.replace(/_/g, " "));
        } catch (error) {
          this.send({type: "result", id: message.id, error: {code: error.code || "PHOTOSHOP_ERROR", message: String(error.message || error)}}, socket);
          this.onActivity("error", String(error.message || error));
        }
      });
    };
    socket.onerror = () => {
      if (this.socket === socket) this.onStatus("error", "Cannot reach Prism Studio. Start the companion and check its setup token.");
    };
    socket.onclose = event => {
      clearTimeout(handshakeTimeout);
      if (this.socket !== socket) return;
      this.socket = null; this.connected = false;
      const reason = event && event.reason;
      this.onStatus("disconnected", reason ? `Disconnected: ${reason}` : "Disconnected · connect when ready");
    };
  }
  send(message, socket = this.socket) {
    if (socket && socket === this.socket && socket.readyState === 1) socket.send(JSON.stringify(message));
  }
  documentChanged() {
    if (this.connected) this.send({type: "event", event: "document_changed"});
  }
  disconnect() {
    const socket = this.socket;
    this.socket = null; this.connected = false;
    if (socket) socket.close();
    this.onStatus("disconnected", "Disconnected · connect when ready");
  }
}

module.exports = {BridgeClient, BRIDGE_URL};
