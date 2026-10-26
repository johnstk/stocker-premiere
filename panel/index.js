"use strict";
const proto = require("./lib/protocol");
const PANEL_VERSION = require("./lib/versao");
const { createEngine } = require("./engine/dispatch");

const URL = "ws://127.0.0.1:47321";
const el = (id) => document.getElementById(id);
const engine = createEngine(require("premierepro"));
let ws = null;
let retry = null;

function token() { try { return localStorage.getItem("stockerPremiereToken") || ""; } catch (e) { return ""; } }
function setStatus(texto, cls) { el("estado").textContent = texto; el("estado").className = cls || ""; }
function premiereVersion() { try { return require("uxp").host.version; } catch (e) { return "?"; } }
function later() { clearTimeout(retry); retry = setTimeout(connect, 2000); }

function connect() {
  clearTimeout(retry);
  if (!token()) { setStatus("sem token — cole abaixo", "bad"); later(); return; }
  try { ws = new WebSocket(URL); } catch (e) { setStatus("erro: " + e.message, "bad"); later(); return; }
  ws.onopen = () => ws.send(JSON.stringify(proto.hello({ token: token(), panel: PANEL_VERSION, premiere: premiereVersion(), tools: engine.tools })));
  ws.onmessage = async (ev) => {
    const m = proto.parse(ev.data);
    if (!m) return;
    if (m.type === "welcome") { setStatus("conectado", "ok"); return; }
    if (m.type === "rejected") { setStatus("recusado: " + m.reason, "bad"); return; }
    if (m.type === "call") {
      el("ultimo").textContent = m.tool + " …";
      const reply = await engine.run(m.id, m.tool, m.input);
      try { ws.send(JSON.stringify(reply)); } catch (e) { /* desconectou */ }
      el("ultimo").textContent = m.tool + (reply.ok ? " ✓" : " ✗ " + reply.error.message);
    }
  };
  ws.onclose = () => { setStatus("desconectado — tentando de novo", "bad"); later(); };
  ws.onerror = () => {};
}

el("salvar").onclick = () => {
  try { localStorage.setItem("stockerPremiereToken", el("token").value.trim()); } catch (e) { /* sem storage */ }
  if (ws) { try { ws.close(); } catch (e) {} }
  connect();
};
el("versao").textContent = `painel ${PANEL_VERSION} · ${engine.tools.length} tools`;
connect();
