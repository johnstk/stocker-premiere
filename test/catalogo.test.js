"use strict";
// Toda tool do servidor tem handler no painel, e vice-versa (pr_applyEditPlan roda no servidor).
const test = require("node:test");
const assert = require("node:assert");
const { TOOLS, EDIT_PLAN_ALLOWED } = require("../server/tools");
const { createEngine } = require("../panel/engine/dispatch");

const P = new Proxy({}, { get: (t, k) => (k === "Constants" ? { TrackItemType: { CLIP: 1 }, MediaType: {} } : {}) });

test("catálogo do servidor e handlers do painel batem", () => {
  const eng = createEngine(P);
  const servidor = new Set(TOOLS.map((t) => t.name));
  const painel = new Set(eng.tools);
  assert.deepEqual([...servidor].filter((n) => !painel.has(n) && n !== "pr_applyEditPlan"), []);
  assert.deepEqual([...painel].filter((n) => !servidor.has(n)), []);
});

test("o plano de edição só aceita tools que existem", () => {
  const nomes = new Set(TOOLS.map((t) => t.name));
  for (const n of EDIT_PLAN_ALLOWED) assert.ok(nomes.has(n), n);
});
