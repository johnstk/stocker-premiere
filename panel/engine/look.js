"use strict";
const { CLIP_PROPS, pixelsToNormalized, normalizedToPixels } = require("../lib/params");
const { parseTime, alignTicksToFrame, secondsToTicks, ticksToSeconds } = require("../lib/tempo");
const { PonteError, ERR } = require("../lib/protocol");
const { matchNameIs } = require("../lib/params");

const STATIC_KEYS = ["scale", "position", "rotation", "opacity"];
function near(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 0.5);
  return typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 0.01;
}

module.exports = (P) => {
  const x = require("./ppro")(P);

  async function propComponents(it, keys) {
    const comps = {};
    for (const key of keys) {
      const spec = CLIP_PROPS[key];
      if (comps[spec.component]) continue;
      const r = await x.componentByMatch(it, spec.component);
      if (!r.component) throw new PonteError(ERR.NOT_FOUND, `O clipe não tem o componente ${spec.component}.`);
      comps[spec.component] = r.component;
    }
    return comps;
  }

  async function pr_setClipProperties(input) {
    const refs = input.clips || [];
    if (!refs.length) throw new PonteError(ERR.BAD_INPUT, "clips é obrigatório.");
    const statics = STATIC_KEYS.filter((k) => input[k] !== undefined);
    const kfs = Array.isArray(input.keyframes) ? input.keyframes : [];
    const kfKeys = STATIC_KEYS.filter((k) => kfs.some((f) => f[k] !== undefined));
    if (!statics.length && !kfKeys.length) throw new PonteError(ERR.BAD_INPUT, "Nada para mudar: passe scale, position, rotation, opacity ou keyframes.");
    const p = await x.project();
    const seq = await x.sequence(p, input.sequence);
    const tb = await seq.getTimebase();
    const fs = await seq.getFrameSize();
    const size = { width: fs.width, height: fs.height };
    const bad = (fn) => { try { return fn(); } catch (e) { if (e instanceof PonteError) throw e; throw new PonteError(ERR.BAD_INPUT, e.message); } };
    const toValue = (key, v) => bad(() => {
      if (key === "position") return pixelsToNormalized(v, size);
      if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${key} deve ser um número.`);
      return v;
    });
    // valida e converte tudo ANTES do lock
    const staticVals = {};
    for (const key of statics) staticVals[key] = toValue(key, input[key]);
    const kfPlan = {}; // key -> [{ tl: ticks de timeline alinhados, value }]
    for (const key of kfKeys) {
      kfPlan[key] = kfs.filter((f) => f[key] !== undefined).map((f) => ({
        tl: bad(() => alignTicksToFrame(secondsToTicks(parseTime(f.time, tb)), tb)),
        value: toValue(key, f[key]),
        raw: f[key],
      }));
    }
    const sec3 = (ticks) => Math.round(ticksToSeconds(ticks) * 1000) / 1000;
    const resultados = [];
    for (const ref of refs) {
      const it = await x.findClip(seq, ref);
      const startTicks = Number((await it.getStartTime()).ticksNumber);
      const inTicks = Number((await it.getInPoint()).ticksNumber);
      const comps = await propComponents(it, [...statics, ...kfKeys]);
      x.tx(p, "stocker-premiere: propriedades do clipe", () => {
        const acts = [];
        for (const key of statics) {
          const spec = CLIP_PROPS[key];
          const prm = comps[spec.component].getParam(spec.index);
          if (prm.isTimeVarying()) acts.push(prm.createSetTimeVaryingAction(false));
          acts.push(prm.createSetValueAction(prm.createKeyframe(staticVals[key]), true));
        }
        for (const key of kfKeys) {
          const spec = CLIP_PROPS[key];
          const prm = comps[spec.component].getParam(spec.index);
          if (!prm.isTimeVarying()) acts.push(prm.createSetTimeVaryingAction(true));
          for (const k of kfPlan[key]) {
            const kf = prm.createKeyframe(k.value);
            kf.position = P.TickTime.createWithTicks(String(k.tl - startTicks + inTicks)); // tempo da mídia
            acts.push(prm.createAddKeyframeAction(kf));
          }
        }
        return acts;
      });
      const fresh = await propComponents(it, [...statics, ...kfKeys]);
      const lido = {};
      for (const key of statics) {
        const spec = CLIP_PROPS[key];
        const v = (await fresh[spec.component].getParam(spec.index).getValueAtTime(P.TickTime.createWithTicks(String(inTicks)))).value;
        lido[key] = key === "position" ? normalizedToPixels(v, size) : v;
      }
      const keyframes = {};
      const diferenca = [];
      const frame = Number(tb);
      for (const key of kfKeys) {
        const spec = CLIP_PROPS[key];
        const prm = fresh[spec.component].getParam(spec.index);
        const list = (await prm.getKeyframeListAsTickTimes()).map((t) => Number(t.ticksNumber) - inTicks + startTicks);
        keyframes[key] = [];
        for (const k of kfPlan[key]) {
          const t = sec3(k.tl);
          if (!list.some((l) => Math.abs(l - k.tl) <= frame)) { diferenca.push({ propriedade: key, tempo: t, problema: "keyframe ausente" }); continue; }
          keyframes[key].push(t);
          let v = (await prm.getValueAtTime(P.TickTime.createWithTicks(String(k.tl - startTicks + inTicks)))).value;
          if (key === "position") v = normalizedToPixels(v, size);
          if (!near(v, k.raw)) diferenca.push({ propriedade: key, tempo: t, esperado: k.raw, lido: v, problema: "valor diferente" });
        }
      }
      for (const k of statics) if (!near(lido[k], input[k])) diferenca.push({ propriedade: k, esperado: input[k], lido: lido[k], problema: "valor diferente" });
      resultados.push({ clip: ref, lido, keyframes: kfKeys.length ? keyframes : undefined, diferenca, verificado: diferenca.length === 0 });
    }
    return { resultados, verificado: resultados.every((r) => r.verificado) };
  }

  async function effectCatalog() {
    const matchNames = await P.VideoFilterFactory.getMatchNames();
    const names = await P.VideoFilterFactory.getDisplayNames();
    return matchNames.map((m, i) => ({ matchName: m, name: names[i] }));
  }

  async function resolveEffect(effect) {
    const want = String(effect || "").trim();
    if (!want) throw new PonteError(ERR.BAD_INPUT, "effect é obrigatório.");
    const cat = await effectCatalog();
    const byMatch = cat.find((e) => matchNameIs(e.matchName, want));
    if (byMatch) return byMatch.matchName;
    const byName = cat.filter((e) => String(e.name || "").toLowerCase() === want.toLowerCase());
    if (byName.length === 1) return byName[0].matchName;
    const sugestoes = cat.filter((e) => e.matchName.toLowerCase().includes(want.toLowerCase()) || String(e.name || "").toLowerCase().includes(want.toLowerCase())).slice(0, 6);
    throw new PonteError(ERR.NOT_FOUND, `Efeito '${want}' não encontrado.` + (sugestoes.length ? ` Parecidos: ${sugestoes.map((e) => `${e.matchName} (${e.name})`).join(", ")}` : " Use pr_findEffects."));
  }

  async function pr_findEffects(input) {
    const q = String(input.query || "").toLowerCase();
    const max = input.max ?? 30;
    const hit = (s) => !q || String(s || "").toLowerCase().includes(q);
    const efeitos = input.kind === "videoTransition" ? [] : (await effectCatalog()).filter((e) => hit(e.matchName) || hit(e.name)).slice(0, max);
    const transicoes = input.kind === "videoEffect" ? [] : (await P.TransitionFactory.getVideoTransitionMatchNames()).filter(hit).slice(0, max);
    return { efeitos, transicoes };
  }

  async function pr_applyEffect(input) {
    const refs = input.clips || [];
    if (!refs.length) throw new PonteError(ERR.BAD_INPUT, "clips é obrigatório.");
    const mn = await resolveEffect(input.effect);
    const p = await x.project();
    const seq = await x.sequence(p, input.sequence);
    let certos = 0;
    for (const ref of refs) {
      const it = await x.findClip(seq, ref);
      const count = async () => {
        const chain = await it.getComponentChain();
        let n = 0;
        for (let i = 0; i < (await chain.getComponentCount()); i++) if (matchNameIs(await (await chain.getComponentAtIndex(i)).getMatchName(), mn)) n++;
        return n;
      };
      const antes = await count();
      const comp = await P.VideoFilterFactory.createComponent(mn);
      const chain = await it.getComponentChain();
      x.tx(p, `stocker-premiere: aplicar ${mn}`, () => [chain.createAppendComponentAction(comp)]);
      if ((await count()) === antes + 1) certos++;
    }
    return { aplicados: refs.length, efeito: mn, verificado: certos === refs.length };
  }

  function paramIndex(component, key) {
    const m = /^#(\d+)$/.exec(String(key));
    const n = component.getParamCount();
    const lista = () => Array.from({ length: n }, (_, i) => `#${i} ${component.getParam(i).displayName}`).join(", ");
    if (m) {
      if (Number(m[1]) >= n) throw new PonteError(ERR.BAD_INPUT, `Parâmetro '${key}' fora do intervalo (0..${n - 1}). Parâmetros: ${lista()}`);
      return Number(m[1]);
    }
    for (let i = 0; i < n; i++) if (String(component.getParam(i).displayName).trim().toLowerCase() === String(key).trim().toLowerCase()) return i;
    throw new PonteError(ERR.BAD_INPUT, `Parâmetro '${key}' não existe. Use '#índice'. Nomes: ${lista()}`);
  }

  async function pr_setEffectProperties(input) {
    const refs = input.clips || [];
    const params = input.params || {};
    if (!refs.length || !Object.keys(params).length) throw new PonteError(ERR.BAD_INPUT, "clips e params são obrigatórios.");
    const want = String(input.effect || "");
    const mn = /ADBE (Motion|Opacity)$/.test(want) ? want : await resolveEffect(want);
    const occ = input.occurrence || 1;
    const p = await x.project();
    const seq = await x.sequence(p, input.sequence);
    const resultados = [];
    for (const ref of refs) {
      const it = await x.findClip(seq, ref);
      const r = await x.componentByMatch(it, mn, occ);
      if (!r.component) throw new PonteError(ERR.NOT_FOUND, `O clipe não tem ${mn} (ocorrência ${occ}). Aplique com pr_applyEffect.`);
      const pairs = Object.entries(params).map(([k, v]) => [k, paramIndex(r.component, k), v]);
      x.tx(p, `stocker-premiere: ajustar ${mn}`, () => {
        const acts = [];
        for (const [, idx, v] of pairs) {
          const prm = r.component.getParam(idx);
          if (prm.isTimeVarying()) acts.push(prm.createSetTimeVaryingAction(false));
          acts.push(prm.createSetValueAction(prm.createKeyframe(v), true));
        }
        return acts;
      });
      const fresh = (await x.componentByMatch(it, mn, occ)).component;
      const valores = {};
      let ok = true;
      for (const [k, idx, v] of pairs) {
        const lido = (await fresh.getParam(idx).getValueAtTime(x.tickSeconds(0))).value;
        valores[k] = lido;
        if (JSON.stringify(lido) !== JSON.stringify(v) && !(typeof lido === "number" && Math.abs(lido - v) <= 0.01)) ok = false;
      }
      resultados.push({ clip: ref, efeito: mn, valores, verificado: ok });
    }
    return { resultados, verificado: resultados.every((r) => r.verificado) };
  }

  return { pr_setClipProperties, pr_findEffects, pr_applyEffect, pr_setEffectProperties };
};
