"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHandlers, toContent } = require("../server/index");
const { TOOLS, TOOL_NAMES } = require("../server/tools");

function fakeBridge(responses, connected = true) {
  const calls = [];
  return {
    calls,
    isConnected: () => connected,
    send: async (tool, input) => { calls.push({ tool, input }); const r = responses[tool]; return typeof r === "function" ? r(input) : r; },
  };
}

test("catálogo tem o contrato do spec e nomes únicos", () => {
  for (const n of ["pr_status", "pr_getProjectState", "pr_getSequenceState", "pr_importFiles", "pr_createSequence", "pr_duplicateSequence",
    "pr_placeClip", "pr_setClipEnabled", "pr_addMarkers", "pr_applyEditPlan", "pr_saveProject", "pr_exportFrame"]) assert.ok(TOOL_NAMES.has(n), n);
  assert.equal(TOOL_NAMES.size, TOOLS.length);
  for (const t of TOOLS) assert.equal(t.inputSchema.type, "object", t.name);
});

test("pr_status desconectado responde sem chamar o painel", async () => {
  const b = fakeBridge({}, false);
  const r = await createHandlers({ bridge: b }).callTool("pr_status", {});
  assert.equal(r.ok, true);
  assert.equal(r.data.conectado, false);
  assert.equal(b.calls.length, 0);
});

test("porta ocupada vira erro claro em qualquer tool", async () => {
  const r = await createHandlers({ bridge: fakeBridge({}), startError: { code: "ponte_ocupada", message: "porta ocupada" } }).callTool("pr_getProjectState", {});
  assert.equal(r.error.code, "ponte_ocupada");
});

test("pr_applyEditPlan recusa tool fora da lista e roda os passos em ordem", async () => {
  const b = fakeBridge({ pr_addMarkers: { ok: true, data: { adicionados: 1 } } });
  const h = createHandlers({ bridge: b });
  const ruim = await h.callTool("pr_applyEditPlan", { steps: [{ tool: "pr_exportSequence" }] });
  assert.equal(ruim.error.code, "entrada_invalida");
  const bom = await h.callTool("pr_applyEditPlan", { steps: [{ tool: "pr_addMarkers", input: { markers: [] } }] });
  assert.equal(bom.ok, true);
  assert.equal(bom.data.resultados[0].data.adicionados, 1);
  assert.deepEqual(b.calls.map((c) => c.tool), ["pr_addMarkers"]);
});

test("pr_exportSequence sem confirmado:true não chega ao painel", async () => {
  const b = fakeBridge({});
  const r = await createHandlers({ bridge: b }).callTool("pr_exportSequence", { outputPath: "/tmp/x.mp4", preset: "/p.epr" });
  assert.equal(r.error.code, "precisa_confirmacao");
  assert.equal(b.calls.length, 0);
});

test("pr_exportFrame injeta a pasta e anexa a imagem", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-frame-"));
  const b = fakeBridge({
    pr_exportFrame: (input) => {
      const p = path.join(input.dir, "quadro-1.png");
      fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return { ok: true, data: { path: p, time: 1 } };
    },
  });
  const r = await createHandlers({ bridge: b, frameDir: dir }).callTool("pr_exportFrame", { time: 1 });
  assert.equal(b.calls[0].input.dir, dir);
  assert.equal(r.image.mimeType, "image/png");
  assert.equal(r.image.data, Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"));
  const c = toContent(r);
  assert.equal(c.content[1].type, "image");
  assert.equal(c.isError, false);
});

test("pr_exportFrame espera o PNG que o Premiere grava depois de responder", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-frame-"));
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]);
  const b = fakeBridge({
    pr_exportFrame: (input) => {
      const p = path.join(input.dir, "quadro-2.png");
      setTimeout(() => fs.writeFileSync(p, bytes), 300);
      return { ok: true, data: { path: p, time: 1 } };
    },
  });
  const r = await createHandlers({ bridge: b, frameDir: dir }).callTool("pr_exportFrame", { time: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.image.data, bytes.toString("base64"));
});

test("pr_exportSequence agora espera o arquivo crescer e estabilizar", async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sp-exp-")), "saida.mp4");
  const b = fakeBridge({ pr_exportSequence: () => {
    setTimeout(() => fs.writeFileSync(out, Buffer.alloc(100)), 30);
    setTimeout(() => fs.appendFileSync(out, Buffer.alloc(150)), 30);
    return { ok: true, data: { ok: true, iniciado: true, outputPath: out, modo: "agora" } };
  } });
  const r = await createHandlers({ bridge: b, exportPollMs: 40, exportStableCount: 4, exportMaxMs: 5000 })
    .callTool("pr_exportSequence", { outputPath: out, preset: "x.epr", confirmado: true });
  assert.equal(r.data.concluido, true);
  assert.equal(r.data.bytes, 250);
});

test("pr_exportSequence agora sem arquivo devolve aviso ao estourar o limite", async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sp-exp-")), "nunca.mp4");
  const b = fakeBridge({ pr_exportSequence: () => ({ ok: true, data: { ok: true, iniciado: true, outputPath: out, modo: "agora" } }) });
  const r = await createHandlers({ bridge: b, exportPollMs: 10, exportStableCount: 3, exportMaxMs: 60 })
    .callTool("pr_exportSequence", { outputPath: out, preset: "x.epr", confirmado: true });
  assert.equal(r.ok, true);
  assert.equal(r.data.concluido, false);
  assert.match(r.data.aviso, /não estabilizou em 0 min/);
});

test("pr_exportSequence agora ignora arquivo antigo no destino", async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sp-exp-")), "velho.mp4");
  fs.writeFileSync(out, Buffer.alloc(10));
  const b = fakeBridge({ pr_exportSequence: () => {
    setTimeout(() => fs.writeFileSync(out, Buffer.alloc(300)), 150);
    return { ok: true, data: { ok: true, iniciado: true, outputPath: out, modo: "agora" } };
  } });
  const r = await createHandlers({ bridge: b, exportPollMs: 20, exportStableCount: 3, exportMaxMs: 5000 })
    .callTool("pr_exportSequence", { outputPath: out, preset: "x.epr", confirmado: true });
  assert.equal(r.data.concluido, true);
  assert.equal(r.data.bytes, 300);
});

test("pr_copyEffect está no catálogo e entra no plano de edição", () => {
  const { TOOLS: T, EDIT_PLAN_ALLOWED } = require("../server/tools");
  const tool = T.find((x) => x.name === "pr_copyEffect");
  assert.ok(tool, "pr_copyEffect no catálogo");
  assert.deepEqual(tool.inputSchema.required, ["from", "clips"]);
  assert.equal(tool.inputSchema.properties.from.required[0], "track");
  assert.ok(EDIT_PLAN_ALLOWED.has("pr_copyEffect"));
});
