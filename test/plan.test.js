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
