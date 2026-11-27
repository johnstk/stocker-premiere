"use strict";
// Toda tool do servidor tem handler no painel, e vice-versa (pr_applyEditPlan roda no servidor).
const test = require("node:test");
const assert = require("node:assert");
const { TOOLS, EDIT_PLAN_ALLOWED } = require("../server/tools");
const { createEngine } = require("../panel/engine/dispatch");
const { ES_TOOLS } = require("../server/es");

const P = new Proxy({}, { get: (t, k) => (k === "Constants" ? { TrackItemType: { CLIP: 1 }, MediaType: {} } : {}) });

test("catálogo do servidor e handlers do painel batem", () => {
  const eng = createEngine(P);
  const servidor = new Set(TOOLS.map((t) => t.name));
  const painel = new Set(eng.tools);
  assert.deepEqual([...servidor].filter((n) => !painel.has(n) && n !== "pr_applyEditPlan" && !ES_TOOLS[n]), []);
  assert.deepEqual([...painel].filter((n) => !servidor.has(n)), []);
});

test("o plano de edição só aceita tools que existem", () => {
  const nomes = new Set(TOOLS.map((t) => t.name));
  for (const n of EDIT_PLAN_ALLOWED) assert.ok(nomes.has(n), n);
});

test("toda tool ES chama uma função que existe no host.jsx", () => {
  const host = require("fs").readFileSync(require("path").join(__dirname, "../cep/host.jsx"), "utf8");
  for (const [tool, fn] of Object.entries(ES_TOOLS)) assert.ok(host.includes(`SP.${fn} = function`), `${tool} -> SP.${fn}`);
});
