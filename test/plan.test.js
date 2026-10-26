"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validatePlan, runPlan } = require("../server/plan");

const ALLOWED = new Set(["pr_placeClip", "pr_addMarkers"]);

test("valida a lista de passos", () => {
  assert.throws(() => validatePlan({}, ALLOWED), /steps/);
  assert.throws(() => validatePlan({ steps: [{ tool: "pr_saveProject" }] }, ALLOWED), /passo 1: 'pr_saveProject' não é permitido/);
  assert.deepEqual(validatePlan({ steps: [{ tool: "pr_addMarkers" }] }, ALLOWED),
    { steps: [{ tool: "pr_addMarkers", input: {} }], stopOnError: true });
});

test("para no primeiro erro", async () => {
  const plan = validatePlan({ steps: [{ tool: "pr_placeClip" }, { tool: "pr_addMarkers" }, { tool: "pr_placeClip" }] }, ALLOWED);
  const chamadas = [];
  const r = await runPlan(plan, async (tool) => {
    chamadas.push(tool);
    return tool === "pr_addMarkers" ? { ok: false, error: { code: "x", message: "falhou" } } : { ok: true, data: { feito: tool } };
  });
  assert.deepEqual(chamadas, ["pr_placeClip", "pr_addMarkers"]);
  assert.equal(r.parou_em, 2);
  assert.equal(r.resultados[1].ok, false);
});

test("stopOnError:false segue até o fim", async () => {
  const plan = validatePlan({ stopOnError: false, steps: [{ tool: "pr_addMarkers" }, { tool: "pr_placeClip" }] }, ALLOWED);
  const r = await runPlan(plan, async (tool) => (tool === "pr_addMarkers" ? { ok: false, error: { code: "x", message: "m" } } : { ok: true, data: {} }));
  assert.equal(r.resultados.length, 2);
  assert.equal(r.parou_em, undefined);
});

test("verificado:false para o plano com stopOnError", async () => {
  const plan = validatePlan({ steps: [{ tool: "pr_placeClip" }, { tool: "pr_addMarkers" }] }, ALLOWED);
  const chamadas = [];
  const r = await runPlan(plan, async (tool) => { chamadas.push(tool); return { ok: true, data: { verificado: false, diferenca: "fim 5 != 6" } }; });
  assert.deepEqual(chamadas, ["pr_placeClip"]);
  assert.equal(r.parou_em, 1);
  assert.equal(r.resultados[0].ok, false);
  assert.equal(r.resultados[0].verificado, false);
  assert.equal(r.resultados[0].error.code, "nao_verificado");
  assert.match(r.resultados[0].error.message, /A releitura não bateu: fim 5 != 6/);
});

test("verificado:false com stopOnError:false segue, mas registra", async () => {
  const plan = validatePlan({ stopOnError: false, steps: [{ tool: "pr_placeClip" }, { tool: "pr_addMarkers" }] }, ALLOWED);
  const r = await runPlan(plan, async (tool) => ({ ok: true, data: tool === "pr_placeClip" ? { verificado: false } : { verificado: true } }));
  assert.equal(r.resultados.length, 2);
  assert.equal(r.parou_em, undefined);
  assert.equal(r.resultados[0].ok, false);
  assert.match(r.resultados[0].error.message, /sem detalhe/);
  assert.equal(r.resultados[1].ok, true);
});
