"use strict";
// Servidor WebSocket só no loopback. O painel UXP é o cliente; um painel por vez.
const { WebSocketServer } = require("ws");
const { parse, call, ERR, PonteError } = require("../panel/lib/protocol");
const { tokensEqual } = require("./token");

const DEFAULT_PORT = 47321;
const DEFAULT_TIMEOUT_MS = 90000;

function isBrowserOrigin(origin) { return typeof origin === "string" && /^https?:\/\//i.test(origin); }
function result(id, code, message) { return { type: "result", id, ok: false, error: { code, message } }; }

function createBridge({ port = DEFAULT_PORT, host = "127.0.0.1", token, log = () => {}, helloTimeoutMs = 3000 } = {}) {
  if (!token) throw new Error("token obrigatório");
  let wss = null;
  let panel = null;
  let panelInfo = null;
  let nextId = 1;
  const pending = new Map();
  const waiters = new Set();

  function onConnection(ws, req) {
    if (isBrowserOrigin(req.headers.origin)) { log("recusado Origin " + req.headers.origin); ws.close(1008, "origin"); return; }
    const helloTimer = setTimeout(() => { if (ws !== panel) ws.close(1008, "sem hello"); }, helloTimeoutMs);
    ws.on("message", (raw) => {
      const m = parse(raw);
      if (!m) return;
      if (m.type === "hello") {
        clearTimeout(helloTimer);
        if (!tokensEqual(m.token, token)) {
          ws.send(JSON.stringify({ type: "rejected", reason: "token inválido — cole o token de ~/Library/Application Support/stocker-premiere/token" }));
          ws.close(1008, "token");
          return;
        }
        if (panel && panel !== ws) { try { panel.close(1000, "substituído"); } catch (e) {} }
        panel = ws;
        panelInfo = { panel: m.panel, premiere: m.premiere, tools: Array.isArray(m.tools) ? m.tools : null };
        ws.send(JSON.stringify({ type: "welcome" }));
        log("painel conectado " + JSON.stringify({ panel: m.panel, premiere: m.premiere }));
        for (const w of waiters) w();
        waiters.clear();
        return;
      }
      if (m.type === "result" && ws === panel) {
        const p = pending.get(m.id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(m.id);
        p.resolve(m);
      }
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (ws !== panel) return;
      panel = null;
      panelInfo = null;
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.resolve(result(id, ERR.NOT_CONNECTED, "O painel do Premiere desconectou durante o comando."));
      }
      pending.clear();
      log("painel desconectado");
    });
    ws.on("error", () => {});
  }

  function start() {
    return new Promise((resolve, reject) => {
      wss = new WebSocketServer({ host, port });
      wss.once("listening", () => resolve(wss.address().port));
      wss.once("error", (e) => {
        reject(e.code === "EADDRINUSE"
          ? new PonteError(ERR.BUSY, `A porta ${port} já está em uso: outra sessão do Claude está usando a ponte do Premiere. Feche-a e tente de novo.`)
          : e);
      });
      wss.on("connection", onConnection);
    });
  }
  function stop() {
    return new Promise((resolve) => {
      if (!wss) return resolve();
      for (const c of wss.clients) c.terminate();
      wss.close(() => resolve());
    });
  }
  function isConnected() { return !!panel && panel.readyState === 1; }
  function info() { return panelInfo; }
  function waitForPanel(ms) {
    if (isConnected()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const w = () => { clearTimeout(t); resolve(true); };
      const t = setTimeout(() => { waiters.delete(w); resolve(false); }, ms);
      waiters.add(w);
    });
  }
  function send(tool, input, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!isConnected()) {
      return Promise.resolve(result(null, ERR.NOT_CONNECTED,
        "O Premiere não está conectado. Abra o Premiere, abra Janela > Plug-ins UXP > Stocker Premiere e confira se o painel mostra 'conectado'."));
    }
    if (panelInfo.tools && !panelInfo.tools.includes(tool)) {
      return Promise.resolve(result(null, ERR.UNKNOWN_TOOL,
        `O painel ${panelInfo.panel} não implementa '${tool}'. Atualize o painel Stocker Premiere.`));
    }
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(result(id, ERR.TIMEOUT, `O Premiere não respondeu em ${Math.round(timeoutMs / 1000)} s (${tool}). Pode estar com um diálogo aberto.`));
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      panel.send(JSON.stringify(call(id, tool, input)));
    });
  }

  return { start, stop, send, isConnected, info, waitForPanel };
}

module.exports = { createBridge, DEFAULT_PORT, DEFAULT_TIMEOUT_MS, isBrowserOrigin };
