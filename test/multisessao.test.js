"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const WebSocket = require("ws");
const { createPonte, createQueue } = require("../server/bridge");
const { createHandlers } = require("../server/index");

const TOKEN = "a".repeat(48);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
}
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error("tempo esgotado esperando condição"); await sleep(20); }
}

// Painel falso que reconecta sozinho, como o de verdade. Guarda a ordem dos comandos e responde depois de `atraso` ms.
function fakePanel(port, { atraso = 30, tools = null } = {}) {
  const log = [];
  let ws = null;
  let vivo = true;
  let emAndamento = 0;
  let maxSimultaneo = 0;
  function connect() {
    if (!vivo) return;
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", v: 1, token: TOKEN, panel: "0.2.0", premiere: "26.5.2", tools })));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type !== "call") return;
      log.push(m.input.tag || m.tool);
      emAndamento++;
      maxSimultaneo = Math.max(maxSimultaneo, emAndamento);
      setTimeout(() => {
        emAndamento--;
        try { ws.send(JSON.stringify({ type: "result", id: m.id, ok: true, data: { tool: m.tool, tag: m.input.tag } })); } catch (e) {}
      }, atraso);
    });
    ws.on("error", () => {});
    ws.on("close", () => { if (vivo) setTimeout(connect, 50); });
  }
  connect();
  return { log, max: () => maxSimultaneo, close: () => { vivo = false; if (ws) ws.close(); } };
}

test("fila: um por vez, na ordem de chegada", async () => {
  const q = createQueue();
  const ordem = [];
  let ativos = 0, max = 0;
  const job = (n) => async () => { ativos++; max = Math.max(max, ativos); await sleep(10); ordem.push(n); ativos--; return n; };
  const r = await Promise.all([q.run("a", job(1)), q.run("b", job(2)), q.run("a", job(3))]);
  assert.deepEqual(r, [1, 2, 3]);
  assert.deepEqual(ordem, [1, 2, 3]);
  assert.equal(max, 1);
});

test("fila: quem segura a vez exclusiva passa direto; os outros esperam o fim", async () => {
  const q = createQueue();
  const ordem = [];
  const release = await q.lock("a");
  const b = q.run("b", async () => ordem.push("b"));
  await q.run("a", async () => ordem.push("a1"));
  await q.run("a", async () => ordem.push("a2"));
  await sleep(10);
  assert.deepEqual(ordem, ["a1", "a2"]);
  release();
  await b;
  assert.deepEqual(ordem, ["a1", "a2", "b"]);
});

test("duas sessões: a segunda vira cliente e os comandos das duas vão em fila ao painel", async () => {
  const port = await freePort();
  const dona = createPonte({ port, token: TOKEN });
  const cliente = createPonte({ port, token: TOKEN });
  assert.equal(await dona.start(), "dona");
  assert.equal(await cliente.start(), "cliente");
  const painel = fakePanel(port);
  await until(() => dona.isConnected() && cliente.isConnected());
  assert.equal(dona.sessoes(), 2);
  assert.equal(cliente.sessoes(), 2);

  const rs = await Promise.all([
    dona.send("pr_x", { tag: "d1" }), cliente.send("pr_x", { tag: "c1" }),
    dona.send("pr_x", { tag: "d2" }), cliente.send("pr_x", { tag: "c2" }),
  ]);
  assert.deepEqual(rs.map((r) => r.data.tag), ["d1", "c1", "d2", "c2"]);
  assert.equal(painel.max(), 1);
  assert.equal(painel.log.length, 4);

  painel.close();
  await cliente.stop();
  await dona.stop();
});

test("plano de uma sessão roda inteiro, sem comando de outra no meio", async () => {
  const port = await freePort();
  const dona = createPonte({ port, token: TOKEN });
  const cliente = createPonte({ port, token: TOKEN });
  await dona.start();
  await cliente.start();
  const painel = fakePanel(port, { atraso: 20 });
  await until(() => dona.isConnected() && cliente.isConnected());

  const hCliente = createHandlers({ bridge: cliente });
  const hDona = createHandlers({ bridge: dona });
  const plano = hCliente.callTool("pr_applyEditPlan", { steps: [1, 2, 3].map((n) => ({ tool: "pr_addMarkers", input: { sequence: "S", tag: "p" + n } })) });
  await sleep(5);
  const solto = hDona.callTool("pr_addMarkers", { sequence: "S", tag: "solto" });
  const [rp, rs] = await Promise.all([plano, solto]);
  assert.equal(rp.ok, true);
  assert.equal(rs.ok, true);
  const i = painel.log.indexOf("solto");
  assert.ok(i === 0 || i === 3, "o comando solto entrou no meio do plano: " + painel.log.join(","));

  painel.close();
  await cliente.stop();
  await dona.stop();
});

test("quando a dona fecha, a cliente vira dona e o painel reconecta nela", async () => {
  const port = await freePort();
  const dona = createPonte({ port, token: TOKEN });
  const cliente = createPonte({ port, token: TOKEN });
  await dona.start();
  await cliente.start();
  const painel = fakePanel(port);
  await until(() => cliente.isConnected());

  await dona.stop();
  await until(() => cliente.papel() === "dona" && cliente.isConnected(), 5000);
  assert.equal(cliente.sessoes(), 1);
  const r = await cliente.send("pr_x", { tag: "depois" });
  assert.equal(r.ok, true);
  assert.equal(r.data.tag, "depois");

  painel.close();
  await cliente.stop();
});

test("três sessões, a dona sai: só uma das outras vira dona e a outra continua cliente", async () => {
  const port = await freePort();
  const a = createPonte({ port, token: TOKEN });
  const b = createPonte({ port, token: TOKEN });
  const c = createPonte({ port, token: TOKEN });
  await a.start(); await b.start(); await c.start();
  const painel = fakePanel(port);
  await until(() => b.isConnected() && c.isConnected());
  assert.equal(a.sessoes(), 3);

  await a.stop();
  await until(() => b.papel() && c.papel() && b.isConnected() && c.isConnected() && b.sessoes() === 2 && c.sessoes() === 2, 5000);
  assert.deepEqual([b.papel(), c.papel()].sort(), ["cliente", "dona"]);
  const r = await c.send("pr_x", { tag: "c" });
  assert.equal(r.data.tag, "c");

  painel.close();
  await b.stop(); await c.stop();
});

test("porta com uma dona antiga (sem modo cliente) dá ponte_ocupada claro, sem derrubar o painel dela", async () => {
  const port = await freePort();
  // A versão antiga só conhece 'hello': ignora o hello_cliente e fecha por falta de hello.
  const nova = createPonte({ port, token: TOKEN });
  const srv = new (require("ws").WebSocketServer)({ host: "127.0.0.1", port });
  srv.on("connection", (ws) => setTimeout(() => ws.close(1008, "sem hello"), 50));
  await new Promise((r) => srv.once("listening", r));
  await assert.rejects(nova.start(), (e) => e.code === "ponte_ocupada" && /antigo/.test(e.message));
  const r = await nova.send("pr_x", {});
  assert.equal(r.error.code, "ponte_ocupada");
  await nova.stop();
  await new Promise((r) => srv.close(r));
});

test("com duas sessões, tool de edição sem 'sequence' recusa com erro claro e não chega ao painel", async () => {
  const calls = [];
  const bridge = { isConnected: () => true, sessoes: () => 2, send: async (tool, input) => { calls.push(tool); return { ok: true, data: {} }; } };
  const h = createHandlers({ bridge });
  const r = await h.callTool("pr_placeClip", { item: "x", time: 0 });
  assert.equal(r.error.code, "entrada_invalida");
  assert.match(r.error.message, /sequence/);
  assert.equal(calls.length, 0);
  assert.equal((await h.callTool("pr_placeClip", { item: "x", time: 0, sequence: "Reel" })).ok, true);
  assert.equal((await h.callTool("pr_getSequenceState", {})).ok, true, "leitura continua sem sequence");
  const plano = await h.callTool("pr_applyEditPlan", { steps: [
    { tool: "pr_addMarkers", input: { sequence: "Reel", markers: [] } },
    { tool: "pr_setClipEnabled", input: { clips: [], enabled: false } },
  ] });
  assert.equal(plano.error.code, "entrada_invalida");
  assert.match(plano.error.message, /passo\(s\) 2/);
});

test("sozinha, a sessão continua podendo omitir 'sequence'", async () => {
  const bridge = { isConnected: () => true, sessoes: () => 1, send: async () => ({ ok: true, data: {} }) };
  assert.equal((await createHandlers({ bridge }).callTool("pr_placeClip", { item: "x", time: 0 })).ok, true);
});

test("pr_status mostra sessões e papel", async () => {
  const port = await freePort();
  const dona = createPonte({ port, token: TOKEN });
  const cliente = createPonte({ port, token: TOKEN });
  await dona.start();
  await cliente.start();
  const r = await createHandlers({ bridge: cliente }).callTool("pr_status", {});
  assert.equal(r.data.conectado, false);
  assert.equal(r.data.sessoes, 2);
  assert.equal(r.data.papel, "cliente");
  await cliente.stop();
  await dona.stop();
});
