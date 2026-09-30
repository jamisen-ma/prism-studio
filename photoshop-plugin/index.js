"use strict";
const photoshop = require("photoshop");
const uxp = require("uxp");
const {PhotoshopEngine} = require("./engine.js");
const {BridgeClient} = require("./bridge.js");
const engine = new PhotoshopEngine(photoshop, uxp);
const get = id => document.getElementById(id);

const bridge = new BridgeClient({
  WebSocket, engine, appVersion: photoshop.app.version,
  onStatus(state, message) {
    get("status").textContent = message;
    get("status-dot").className = `dot ${state}`;
    get("connect").disabled = state === "connected" || state === "connecting";
    get("disconnect").disabled = state !== "connected" && state !== "connecting";
    get("token").disabled = state === "connected" || state === "connecting";
    if (state === "connected") get("token").value = "";
  },
  onActivity(state, message) {
    get("activity").textContent = `${state === "running" ? "Working · " : state === "success" ? "Done · " : ""}${message}`;
    get("activity").className = state === "error" ? "error" : "";
  }
});

get("connect").addEventListener("click", () => {
  try { bridge.connect(get("token").value); }
  catch (error) { get("status").textContent = error.message; get("status-dot").className = "dot error"; }
});
get("disconnect").addEventListener("click", () => bridge.disconnect());

let changedTimer;
const changed = () => {
  clearTimeout(changedTimer);
  changedTimer = setTimeout(() => bridge.documentChanged(), 200);
};
// Explicit notifications work without the developer-only 'all' event subscription.
photoshop.action.addNotificationListener(["open", "close", "make", "delete", "set", "select", "move", "transform", "undo", "redo"], changed)
  .catch(() => { get("activity").textContent = "Event notifications unavailable; documents refresh on each request."; });

uxp.entrypoints.setup({panels: {prismBridge: {show() {}, hide() {}}}, plugin: {destroy() { bridge.disconnect(); clearTimeout(changedTimer); }}});
