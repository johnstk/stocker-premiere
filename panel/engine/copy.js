"use strict";
const { PonteError, ERR } = require("../lib/protocol");
const { matchNameIs } = require("../lib/params");

// Copia um efeito inteiro (todos os parâmetros) de um clipe para outros: o "Colar atributos" do Premiere.
// Serve para levar a cor do Lumetri (LUT de entrada, look, ajustes), que não atravessa o XML.
const igual = (a, b) => {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-4;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return a === b; }
};

module.exports = (P) => {
  const x = require("./ppro")(P);

  async function resolveMatch(effect) {
    const want = String(effect || "ADBE Lumetri").trim();
    const nomes = await P.VideoFilterFactory.getMatchNames();
    const mn = nomes.find((m) => matchNameIs(m, want));
    if (!mn) throw new PonteError(ERR.NOT_FOUND, `Efeito '${want}' não encontrado. Use pr_findEffects.`);
    return mn;
  }

  // Valores de todos os parâmetros do componente no ponto de entrada do clipe (um efeito de cor é estático).
  async function lerParams(component, inTicks) {
    const t = P.TickTime.createWithTicks(String(inTicks));
    const out = [];
    const n = component.getParamCount();
    for (let i = 0; i < n; i++) {
      const prm = component.getParam(i);
      let valor;
      try { valor = (await prm.getValueAtTime(t)).value; } catch (e) { valor = undefined; }
      out.push({ i, nome: String(prm.displayName || "").trim(), valor, animado: !!prm.isTimeVarying() });
    }
    return out;
  }

  async function pr_copyEffect(input) {
    const de = input.from || {};
    const refs = input.clips || [];
    if (!de.track || !refs.length) throw new PonteError(ERR.BAD_INPUT, "from ({sequence, track, clip}) e clips são obrigatórios.");
    const mn = await resolveMatch(input.effect);
    const occ = input.occurrence || 1;
    const p = await x.project();

    const seqOrigem = await x.sequence(p, de.sequence);
    const itOrigem = await x.findClip(seqOrigem, de);
    const origem = (await x.componentByMatch(itOrigem, mn, occ)).component;
    if (!origem) throw new PonteError(ERR.NOT_FOUND, `O clipe de origem não tem ${mn} (ocorrência ${occ}).`);
    const params = await lerParams(origem, Number((await itOrigem.getInPoint()).ticksNumber));
    const animadosNaOrigem = params.filter((q) => q.animado).map((q) => q.i);

    const seq = await x.sequence(p, input.sequence);
    const resultados = [];
    for (const ref of refs) {
      const it = await x.findClip(seq, ref);
      let alvo = (await x.componentByMatch(it, mn, occ)).component;
      let criado = false;
      if (!alvo) {
        const comp = await P.VideoFilterFactory.createComponent(mn);
        const chain = await it.getComponentChain();
        x.tx(p, `stocker-premiere: aplicar ${mn}`, () => [chain.createAppendComponentAction(comp)]);
        alvo = (await x.componentByMatch(it, mn, occ)).component;
        if (!alvo) throw new PonteError(ERR.PREMIERE, `Não consegui aplicar ${mn} no clipe.`);
        criado = true;
      }
      // as ações saem uma por parâmetro; o que o Premiere não deixa montar fica de fora e é relatado
      const recusados = [];
      x.tx(p, `stocker-premiere: copiar ${mn}`, () => {
        const acts = [];
        for (const q of params) {
          if (q.valor === undefined) continue;
          try {
            const prm = alvo.getParam(q.i);
            if (prm.isTimeVarying()) acts.push(prm.createSetTimeVaryingAction(false));
            acts.push(prm.createSetValueAction(prm.createKeyframe(q.valor), true));
          } catch (e) { recusados.push({ i: q.i, nome: q.nome, erro: String((e && e.message) || e) }); }
        }
        return acts;
      });
      const lidos = await lerParams((await x.componentByMatch(it, mn, occ)).component, Number((await it.getInPoint()).ticksNumber));
      const diferentes = [];
      for (const q of params) {
        if (q.valor === undefined || recusados.some((r) => r.i === q.i)) continue;
        const l = lidos[q.i];
        if (!l || !igual(l.valor, q.valor)) diferentes.push({ i: q.i, nome: q.nome });
      }
      resultados.push({ clip: ref, criado, copiados: params.length - recusados.length - diferentes.length, recusados, diferentes,
        verificado: !recusados.length && !diferentes.length });
    }
    return { efeito: mn, parametros: params.length, animadosNaOrigem, resultados, verificado: resultados.every((r) => r.verificado) };
  }

  return { pr_copyEffect };
};
