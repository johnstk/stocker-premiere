"use strict";
const { PonteError, ERR } = require("../panel/lib/protocol");

function validatePlan(input, allowed) {
  if (!input || !Array.isArray(input.steps) || input.steps.length === 0) {
    throw new PonteError(ERR.BAD_INPUT, "steps deve ser uma lista com pelo menos um passo: [{tool, input}]");
  }
  input.steps.forEach((s, i) => {
    if (!s || typeof s.tool !== "string") throw new PonteError(ERR.BAD_INPUT, `passo ${i + 1}: falta 'tool'`);
    if (!allowed.has(s.tool)) throw new PonteError(ERR.BAD_INPUT, `passo ${i + 1}: '${s.tool}' não é permitido no pr_applyEditPlan`);
  });
  return { steps: input.steps.map((s) => ({ tool: s.tool, input: s.input || {} })), stopOnError: input.stopOnError !== false };
}

async function runPlan(plan, callTool) {
  const resultados = [];
  for (let i = 0; i < plan.steps.length; i++) {
    const s = plan.steps[i];
    const r = await callTool(s.tool, s.input);
    resultados.push(r.ok ? { passo: i + 1, tool: s.tool, ok: true, data: r.data } : { passo: i + 1, tool: s.tool, ok: false, error: r.error });
    if (!r.ok && plan.stopOnError) return { resultados, parou_em: i + 1 };
  }
  return { resultados };
}

module.exports = { validatePlan, runPlan };
