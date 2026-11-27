"use strict";
// Segunda ponte: painel CEP que roda o ExtendScript (host.jsx) e atende o servidor MCP num HTTP local.
// Só 127.0.0.1, só com o token da stocker-premiere, sem Origin (navegador não entra), um comando por vez.
const VERSAO = "0.1.0";
const PORTA = 47322;
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TOKEN_FILE = path.join(os.homedir(), "Library", "Application Support", "stocker-premiere", "token");
const el = (id) => document.getElementById(id);
const estado = (t, cls) => { el("estado").textContent = t; el("estado").className = cls || ""; };
el("versao").textContent = VERSAO;

function token() { try { return fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch (e) { return ""; } }

function evalES(script, timeoutMs) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(JSON.stringify({ ok: false, error: "O Premiere não respondeu a tempo (diálogo aberto?)" })), timeoutMs);
    window.__adobe_cep__.evalScript(script, (r) => { clearTimeout(t); resolve(r); });
  });
}

let fila = Promise.resolve();
function chamar(fn, args, timeoutMs) {
  const script = `spCall(${JSON.stringify(String(fn))}, ${JSON.stringify(JSON.stringify(args || {}))})`;
  const p = fila.then(() => evalES(script, timeoutMs));
  fila = p.catch(() => {});
  return p;
}

function responder(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  if (req.headers.origin) return responder(res, 403, { ok: false, error: "origem recusada" });
  const tk = token();
  if (!tk || req.headers["x-stocker-token"] !== tk) return responder(res, 401, { ok: false, error: "token inválido" });
  if (req.method !== "POST" || req.url !== "/call") return responder(res, 404, { ok: false, error: "use POST /call" });
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 5e6) req.destroy(); });
  req.on("end", async () => {
    let m;
    try { m = JSON.parse(body); } catch (e) { return responder(res, 400, { ok: false, error: "JSON inválido" }); }
    el("ultimo").textContent = `${m.fn} …`;
    const bruto = await chamar(m.fn, m.args, Number(m.timeoutMs) || 90000);
    let r;
    try { r = JSON.parse(bruto); } catch (e) { r = { ok: false, error: `resposta do ExtendScript não é JSON: ${String(bruto).slice(0, 300)}` }; }
    el("ultimo").textContent = `${m.fn} ${r.ok ? "✓" : "✗ " + r.error}`;
    responder(res, 200, r);
  });
});
server.on("error", (e) => estado(`porta ${PORTA} ocupada ou erro: ${e.message}`, "bad"));
server.listen(PORTA, "127.0.0.1", () => estado(`ouvindo 127.0.0.1:${PORTA}`, "ok"));
