"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");
const { createBridge } = require("../server/bridge");

const TOKEN = "a".repeat(48);
function connect(port, headers) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    ws.once("open", () => res(ws));
    ws.once("error", rej);
  });
}
function next(ws) { return new Promise((res) => ws.once("message", (d) => res(JSON.parse(d.toString())))); }
function closed(ws) { return new Promise((res) => ws.once("close", (code) => res(code))); }
async function panel(port, tools) {
  const ws = await connect(port);
  ws.send(JSON.stringify({ type: "hello", v: 1, token: TOKEN, panel: "0.1.0", premiere: "26.5.2", tools }));
  assert.equal((await next(ws)).type, "welcome");
  return ws;
}

test("recusa token errado", async () => {
  const b = createBridge({ port: 0, token: TOKEN });
  const port = await b.start();
  const ws = await connect(port);
  ws.send(JSON.stringify({ type: "hello", token: "b".repeat(48) }));
  assert.equal((await next(ws)).type, "rejected");
  await b.stop();
});

test("recusa Origin de navegador", async () => {
  const b = createBridge({ port: 0, token: TOKEN });
  const port = await b.start();
  const ws = await connect(port, { Origin: "https://exemplo.com" });
  assert.equal(await closed(ws), 1008);
  await b.stop();
});

test("encaminha call e devolve result", async () => {
  const b = createBridge({ port: 0, token: TOKEN });
  const port = await b.start();
  const ws = await panel(port, ["pr_teste"]);
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === "call") ws.send(JSON.stringify({ type: "result", id: m.id, ok: true, data: { eco: m.input } }));
  });
  const r = await b.send("pr_teste", { a: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { eco: { a: 1 } });
  assert.equal(b.info().premiere, "26.5.2");
  ws.close();
  await b.stop();
});

test("sem painel → nao_conectado", async () => {
  const b = createBridge({ port: 0, token: TOKEN });
  await b.start();
  const r = await b.send("pr_status", {});
  assert.equal(r.error.code, "nao_conectado");
  await b.stop();
});

test("tool que o painel não implementa é recusada sem enviar", async () => {
  const b = createBridge({ port: 0, token: TOKEN });
  const port = await b.start();
  const ws = await panel(port, ["pr_status"]);
  let recebeu = false;
  ws.on("message", () => { recebeu = true; });
  const r = await b.send("pr_placeClip", {});
  assert.equal(r.error.code, "tool_desconhecida");
  assert.equal(recebeu, false);
  ws.close();
  await b.stop();
});

test("timeout", async () => {
  const b = createBridge({ port: 0, token: TOKEN });
  const port = await b.start();
  const ws = await panel(port, ["pr_lento"]);
  const r = await b.send("pr_lento", {}, { timeoutMs: 50 });
  assert.equal(r.error.code, "tempo_esgotado");
  ws.close();
  await b.stop();
});

test("porta ocupada → ponte_ocupada", async () => {
  const b1 = createBridge({ port: 0, token: TOKEN });
  const port = await b1.start();
  const b2 = createBridge({ port, token: TOKEN });
  await assert.rejects(b2.start(), (e) => e.code === "ponte_ocupada");
  await b1.stop();
});

test("painel B substitui A: chamada pendente resolve nao_conectado rápido", async () => {
  const b = createBridge({ port: 0, token: TOKEN });
  const port = await b.start();
  const a = await panel(port, ["pr_lento"]);
  const t0 = Date.now();
  const p = b.send("pr_lento", {}, { timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 50));
  const bb = await panel(port, ["pr_lento"]);
  const r = await p;
  assert.equal(r.error.code, "nao_conectado");
  assert.ok(Date.now() - t0 < 2000);
  a.close();
  bb.close();
  await b.stop();
});

test("painel desconecta com chamada em andamento → nao_conectado", async () => {
  const b = createBridge({ port: 0, token: TOKEN });
  const port = await b.start();
  const ws = await panel(port, ["pr_lento"]);
  const t0 = Date.now();
  const p = b.send("pr_lento", {}, { timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 50));
  ws.close();
  const r = await p;
  assert.equal(r.error.code, "nao_conectado");
  assert.ok(Date.now() - t0 < 2000);
  await b.stop();
});
