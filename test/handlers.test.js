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
