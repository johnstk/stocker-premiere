"use strict";
// Servidor WebSocket só no loopback. O painel UXP é o cliente; um painel por vez.
// Várias sessões do Claude dividem o painel: a primeira que abre a porta vira a dona e fala com o
// painel; as outras entram como clientes da dona (hello_cliente). A dona põe os comandos de todas
// numa fila e manda um por vez ao painel.
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;
const { parse, call, ERR, PonteError } = require("../panel/lib/protocol");
const { tokensEqual } = require("./token");

const DEFAULT_PORT = 47321;
const DEFAULT_TIMEOUT_MS = 90000;
const LOCAL = "local";

function isBrowserOrigin(origin) { return typeof origin === "string" && /^https?:\/\//i.test(origin); }
function result(id, code, message) { return { type: "result", id, ok: false, error: { code, message } }; }
function trySend(ws, msg) { try { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); } catch (e) { /* cliente saiu */ } }

// Fila de um por vez. Quem segura a vez exclusiva (plano de edição) passa direto com os próprios comandos.
function createQueue() {
  let holder = null;
  let exclusive = null;
  const waiting = [];
  function pump() {
    if (holder !== null || !waiting.length) return;
    const w = waiting.shift();
    holder = w.who;
    let done = false;
    w.resolve(() => {
      if (done) return;
      done = true;
      holder = null;
      if (exclusive === w.who) exclusive = null;
      pump();
    });
  }
  function acquire(who) { return new Promise((resolve) => { waiting.push({ who, resolve }); pump(); }); }
  async function run(who, fn) {
    if (exclusive === who) return fn();
    const release = await acquire(who);
    try { return await fn(); } finally { release(); }
  }
  async function lock(who) {
    const release = await acquire(who);
    exclusive = who;
    return release;
  }
  return { run, lock, size: () => waiting.length + (holder !== null ? 1 : 0) };
}

function createBridge({ port = DEFAULT_PORT, host = "127.0.0.1", token, log = () => {}, helloTimeoutMs = 3000 } = {}) {
  if (!token) throw new Error("token obrigatório");
  let wss = null;
  let panel = null;
  let panelInfo = null;
  let nextId = 1;
  let nextClient = 1;
  const pending = new Map();
  const waiters = new Set();
  const clients = new Map();
  const queue = createQueue();

  function estado() {
    return { type: "estado", painel: isConnected(), info: panelInfo, sessoes: clients.size + 1, fila: queue.size() };
  }
  function broadcast() { const m = estado(); for (const ws of clients.keys()) trySend(ws, m); }

  function onClientMessage(ws, c, m) {
    if (m.type === "call") {
      run(c.who, m.tool, m.input, { timeoutMs: m.timeoutMs }).then((r) => trySend(ws, { ...r, type: "result", id: m.id }));
      return;
    }
    if (m.type === "lock") {
      queue.lock(c.who).then((release) => {
        if (!clients.has(ws)) return release();
        c.release = release;
        trySend(ws, { type: "locked", id: m.id });
      });
      return;
    }
    if (m.type === "unlock" && c.release) { c.release(); c.release = null; }
  }

  function onConnection(ws, req) {
    if (isBrowserOrigin(req.headers.origin)) { log("recusado Origin " + req.headers.origin); ws.close(1008, "origin"); return; }
    const helloTimer = setTimeout(() => { if (ws !== panel && !clients.has(ws)) ws.close(1008, "sem hello"); }, helloTimeoutMs);
    ws.on("message", (raw) => {
      const m = parse(raw);
      if (!m) return;
      const c = clients.get(ws);
      if (c) return onClientMessage(ws, c, m);
      if (m.type === "hello_cliente") {
        clearTimeout(helloTimer);
        if (!tokensEqual(m.token, token)) {
          ws.send(JSON.stringify({ type: "rejected", reason: "token inválido" }));
          ws.close(1008, "token");
          return;
        }
        clients.set(ws, { who: "cliente-" + nextClient++, release: null });
        ws.send(JSON.stringify({ type: "welcome", papel: "cliente" }));
        log(`sessão cliente entrou (${clients.size + 1} sessões)`);
        broadcast();
        return;
      }
      if (m.type === "hello") {
        clearTimeout(helloTimer);
        if (!tokensEqual(m.token, token)) {
          ws.send(JSON.stringify({ type: "rejected", reason: "token inválido — cole o token de ~/Library/Application Support/stocker-premiere/token" }));
          ws.close(1008, "token");
          return;
        }
        if (panel && panel !== ws) {
          const old = panel;
          for (const [id, p] of pending) {
            clearTimeout(p.timer);
            p.resolve(result(id, ERR.NOT_CONNECTED, "O painel do Premiere foi reconectado durante o comando."));
          }
          pending.clear();
          try { old.close(1000, "substituído"); } catch (e) {}
        }
        panel = ws;
        panelInfo = { panel: m.panel, premiere: m.premiere, tools: Array.isArray(m.tools) ? m.tools : null };
        ws.send(JSON.stringify({ type: "welcome" }));
        log("painel conectado " + JSON.stringify({ panel: m.panel, premiere: m.premiere }));
        for (const w of waiters) w();
        waiters.clear();
        broadcast();
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
      const c = clients.get(ws);
      if (c) {
        clients.delete(ws);
        if (c.release) c.release();
        log(`sessão cliente saiu (${clients.size + 1} sessões)`);
        broadcast();
        return;
      }
      if (ws !== panel) return;
      panel = null;
      panelInfo = null;
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.resolve(result(id, ERR.NOT_CONNECTED, "O painel do Premiere desconectou durante o comando."));
      }
      pending.clear();
      log("painel desconectado");
      broadcast();
    });
    ws.on("error", () => {});
  }

  function start() {
    return new Promise((resolve, reject) => {
      wss = new WebSocketServer({ host, port });
      wss.once("listening", () => resolve(wss.address().port));
      wss.once("error", (e) => {
        reject(e.code === "EADDRINUSE"
          ? new PonteError(ERR.BUSY, `A porta ${port} já está em uso por outro programa.`)
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
  function sendNow(tool, input, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
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
  // O tempo limite conta a partir da saída para o painel, não da espera na fila.
  function run(who, tool, input, opts) { return queue.run(who, () => sendNow(tool, input, opts)); }
  function send(tool, input, opts) { return run(LOCAL, tool, input, opts); }
  async function exclusive(fn) {
    const release = await queue.lock(LOCAL);
    try { return await fn(); } finally { release(); }
  }

  return {
    start, stop, send, exclusive, isConnected, info, waitForPanel,
    papel: () => "dona", sessoes: () => clients.size + 1, fila: () => queue.size(),
  };
}

// Sessão que entra depois: fala com a dona pelo mesmo WebSocket.
function connectClient({ port, host = "127.0.0.1", token, onClose = () => {}, welcomeTimeoutMs = 4000 }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${host}:${port}`);
    let estado = { painel: false, info: null, sessoes: 2, fila: 0 };
    let nextId = 1;
    let opened = false;
    let welcomed = false;
    const pending = new Map();
    const locks = new Map();
    const waiters = new Set();
    const timer = setTimeout(() => { ws.terminate(); }, welcomeTimeoutMs);

    ws.on("open", () => { opened = true; ws.send(JSON.stringify({ type: "hello_cliente", v: 1, token })); });
    ws.on("error", () => {});
    ws.on("message", (raw) => {
      const m = parse(raw);
      if (!m) return;
      if (m.type === "welcome" && m.papel === "cliente") {
        welcomed = true;
        clearTimeout(timer);
        resolve(api);
        return;
      }
      if (m.type === "rejected") { clearTimeout(timer); reject(new PonteError(ERR.BUSY, "A sessão dona recusou o token: " + m.reason)); return; }
      if (m.type === "estado") {
        estado = m;
        if (estado.painel) { for (const w of waiters) w(); waiters.clear(); }
        return;
      }
      if (m.type === "result") {
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); p(m); }
        return;
      }
      if (m.type === "locked") {
        const l = locks.get(m.id);
        if (l) { locks.delete(m.id); l(); }
      }
    });
    ws.on("close", () => {
      clearTimeout(timer);
      if (!welcomed) {
        // Sem abrir: a dona saiu e a porta ficou livre (vale tentar de novo). Abriu e não deu boas-vindas: dona antiga.
        reject(opened
          ? new PonteError(ERR.BUSY, `A porta ${port} está com uma sessão que não aceita outras (provavelmente uma sessão do Claude com o stocker-premiere antigo). Reinicie essa sessão para ela pegar a versão nova.`)
          : new PonteError("sem_dona", "A sessão dona saiu antes de responder."));
        return;
      }
      for (const [id, p] of pending) p(result(id, ERR.NOT_CONNECTED, "A sessão dona da ponte fechou durante o comando. Ele pode ter rodado no Premiere: releia antes de repetir."));
      pending.clear();
      for (const l of locks.values()) l();
      locks.clear();
      onClose();
    });

    function send(tool, input, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
      if (ws.readyState !== 1) return Promise.resolve(result(null, ERR.NOT_CONNECTED, "Sem ligação com a sessão dona da ponte."));
      const id = nextId++;
      return new Promise((res) => {
        pending.set(id, res);
        ws.send(JSON.stringify({ type: "call", id, tool, input: input || {}, timeoutMs }));
      });
    }
    async function exclusive(fn) {
      if (ws.readyState !== 1) return fn();
      const id = nextId++;
      await new Promise((res) => { locks.set(id, res); ws.send(JSON.stringify({ type: "lock", id })); });
      try { return await fn(); } finally { trySend(ws, { type: "unlock" }); }
    }
    function waitForPanel(ms) {
      if (estado.painel) return Promise.resolve(true);
      return new Promise((res) => {
        const w = () => { clearTimeout(t); res(true); };
        const t = setTimeout(() => { waiters.delete(w); res(false); }, ms);
        waiters.add(w);
      });
    }
    const api = {
      send, exclusive, waitForPanel,
      stop: () => new Promise((res) => { if (ws.readyState >= 2) return res(); ws.once("close", res); ws.close(); }),
      isConnected: () => ws.readyState === 1 && !!estado.painel,
      info: () => estado.info,
      papel: () => "cliente", sessoes: () => estado.sessoes, fila: () => estado.fila,
    };
  });
}

// O que o index usa: vira dona se a porta estiver livre, senão cliente. Se a dona sair, disputa de novo.
function createPonte({ port = DEFAULT_PORT, host = "127.0.0.1", token, log = () => {}, panelGraceMs = 6000 } = {}) {
  let atual = null;
  let erro = null;
  let electing = null;
  let electedAt = 0;
  let stopped = false;

  async function tryOnce() {
    const b = createBridge({ port, host, token, log });
    try {
      await b.start();
      log(`sessão dona da ponte em ws://${host}:${port}`);
      return b;
    } catch (e) {
      if (e.code !== ERR.BUSY) throw e;
    }
    const c = await connectClient({ port, host, token, onClose: () => { atual = null; if (!stopped) elect(); } });
    log("sessão cliente: a ponte já tem dona; os comandos vão por ela");
    return c;
  }
  function elect() {
    if (electing) return electing;
    electing = (async () => {
      for (let i = 0; i < 20 && !stopped; i++) {
        try {
          atual = await tryOnce();
          erro = null;
          electedAt = Date.now();
          return atual;
        } catch (e) {
          erro = e;
          if (e.code === ERR.BUSY) break;
          // A dona acabou de sair; outra sessão pode estar abrindo a porta agora.
          await new Promise((r) => setTimeout(r, 50 + Math.floor(Math.random() * 250)));
        }
      }
      atual = null;
      return null;
    })().finally(() => { electing = null; });
    return electing;
  }
  async function ready() {
    if (!atual && !stopped) await elect();
    return atual;
  }
  async function send(tool, input, opts) {
    const b = await ready();
    if (!b) return result(null, ERR.BUSY, erro ? erro.message : "A ponte do Premiere não abriu.");
    // Logo depois de trocar de dona, o painel leva ~2 s para reconectar.
    const graca = panelGraceMs - (Date.now() - electedAt);
    if (!b.isConnected() && graca > 0) await b.waitForPanel(graca);
    return b.send(tool, input, opts);
  }
  async function exclusive(fn) {
    const b = await ready();
    return b ? b.exclusive(fn) : fn();
  }
  return {
    start: async () => { const b = await elect(); if (!b) throw erro; return b.papel(); },
    stop: async () => { stopped = true; if (atual) await atual.stop(); },
    send, exclusive, ready,
    erro: () => (atual || !erro ? null : erro.message),
    isConnected: () => !!atual && atual.isConnected(),
    info: () => (atual ? atual.info() : null),
    waitForPanel: async (ms) => { const b = await ready(); return b ? b.waitForPanel(ms) : false; },
    papel: () => (atual ? atual.papel() : null),
    sessoes: () => (atual ? atual.sessoes() : 0),
    fila: () => (atual ? atual.fila() : 0),
  };
}

module.exports = { createBridge, connectClient, createPonte, createQueue, DEFAULT_PORT, DEFAULT_TIMEOUT_MS, isBrowserOrigin };
