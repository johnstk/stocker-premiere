"use strict";
const { CLIP_PROPS, pixelsToNormalized, normalizedToPixels } = require("../lib/params");
const { parseTime, alignTicksToFrame, secondsToTicks, ticksToSeconds } = require("../lib/tempo");
const { PonteError, ERR } = require("../lib/protocol");
const { matchNameIs } = require("../lib/params");

const STATIC_KEYS = ["scale", "position", "rotation", "opacity"];
function asArr(v) {
  if (v && !Array.isArray(v) && typeof v === "object" && typeof v.x === "number" && typeof v.y === "number") return [v.x, v.y];
  return v;
}
function near(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 0.5);
  return typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 0.01;
}

module.exports = (P) => {
  const x = require("./ppro")(P);
  const kfValue = (v) => (Array.isArray(v) && v.length === 2 && v.every(Number.isFinite) ? new P.PointF(v[0], v[1]) : v);

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
          acts.push(prm.createSetValueAction(prm.createKeyframe(kfValue(staticVals[key])), true));
        }
        for (const key of kfKeys) {
          const spec = CLIP_PROPS[key];
          const prm = comps[spec.component].getParam(spec.index);
          if (!prm.isTimeVarying()) acts.push(prm.createSetTimeVaryingAction(true));
          for (const k of kfPlan[key]) {
            const kf = prm.createKeyframe(kfValue(k.value));
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
        const v = asArr((await fresh[spec.component].getParam(spec.index).getValueAtTime(P.TickTime.createWithTicks(String(inTicks)))).value);
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
          let v = asArr((await prm.getValueAtTime(P.TickTime.createWithTicks(String(k.tl - startTicks + inTicks)))).value);
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

  async function componentName(c) {
    try { return String(await c.getDisplayName()); } catch (e) { return ""; }
  }

  // Componente do próprio clipe pelo matchName ou pelo nome exibido (serve para os de áudio, fora do catálogo de vídeo).
  async function componentOfClip(trackItem, want, occurrence = 1) {
    const chain = await trackItem.getComponentChain();
    const w = String(want).trim().toLowerCase();
    let seen = 0;
    for (let i = 0; i < (await chain.getComponentCount()); i++) {
      const c = await chain.getComponentAtIndex(i);
      const m = String(await c.getMatchName()).toLowerCase();
      if ((m === w || m.endsWith("." + w) || (await componentName(c)).toLowerCase() === w) && ++seen === occurrence) return { chain, component: c, index: i };
    }
    return { chain, component: null, index: -1 };
  }

  async function componentList(trackItem) {
    const chain = await trackItem.getComponentChain();
    const out = [];
    for (let i = 0; i < (await chain.getComponentCount()); i++) {
      const c = await chain.getComponentAtIndex(i);
      const params = [];
      for (let j = 0; j < c.getParamCount(); j++) {
        let v = "";
        try { v = JSON.stringify(asArr((await c.getParam(j).getValueAtTime(x.tickSeconds(0))).value)); } catch (e) { v = "?"; }
        // Parâmetro animado: lista os keyframes (segundos da fonte: valor) para não apagá-los sem saber.
        try {
          const prm = c.getParam(j);
          if (prm.isTimeVarying()) {
            const kfs = [];
            for (const t of await prm.getKeyframeListAsTickTimes()) kfs.push(`${(Number(t.ticksNumber) / 254016000000).toFixed(2)}s:${JSON.stringify(asArr((await prm.getValueAtTime(t)).value))}`);
            v += ` [animado ${kfs.join(" ")}]`;
          }
        } catch (e) { v += " [animado ?]"; }
        params.push(`#${j} ${c.getParam(j).displayName}=${v}`);
      }
      out.push(`${await c.getMatchName()} (${await componentName(c)}: ${params.join(", ")})`);
    }
    return out.join("; ");
  }

  async function pr_setEffectProperties(input) {
    const refs = input.clips || [];
    const params = input.params || {};
    if (!refs.length || !Object.keys(params).length) throw new PonteError(ERR.BAD_INPUT, "clips e params são obrigatórios.");
    const want = String(input.effect || "");
    // Efeito de vídeo pelo catálogo; se não estiver lá (o Volume dos clipes de áudio, por exemplo), procura no próprio clipe.
    let mn = null;
    if (/ADBE (Motion|Opacity)$/.test(want)) mn = want;
    else { try { mn = await resolveEffect(want); } catch (e) { if (!(e instanceof PonteError)) throw e; } }
    const occ = input.occurrence || 1;
    const p = await x.project();
    const seq = await x.sequence(p, input.sequence);
    const resultados = [];
    for (const ref of refs) {
      const it = await x.findClip(seq, ref);
      const r = mn ? await x.componentByMatch(it, mn, occ) : await componentOfClip(it, want, occ);
      if (!r.component) throw new PonteError(ERR.NOT_FOUND, `O clipe não tem ${mn || want} (ocorrência ${occ}). Componentes do clipe: ${await componentList(it)}`);
      const pairs = Object.entries(params).map(([k, v]) => [k, paramIndex(r.component, k), v]);
      x.tx(p, `stocker-premiere: ajustar ${mn}`, () => {
        const acts = [];
        for (const [, idx, v] of pairs) {
          const prm = r.component.getParam(idx);
          if (prm.isTimeVarying()) acts.push(prm.createSetTimeVaryingAction(false));
          acts.push(prm.createSetValueAction(prm.createKeyframe(kfValue(v)), true));
        }
        return acts;
      });
      const fresh = (mn ? await x.componentByMatch(it, mn, occ) : await componentOfClip(it, want, occ)).component;
      const valores = {};
      let ok = true;
      for (const [k, idx, v] of pairs) {
        const lido = asArr((await fresh.getParam(idx).getValueAtTime(x.tickSeconds(0))).value);
        valores[k] = lido;
        if (Array.isArray(v) && Array.isArray(lido)) { if (v.length !== lido.length || !v.every((n, i) => Math.abs(n - lido[i]) <= 0.001)) ok = false; }
        else if (typeof lido === "number" && typeof v === "number") { if (Math.abs(lido - v) > 0.01) ok = false; }
        else if (JSON.stringify(lido) !== JSON.stringify(v)) ok = false;
      }
      resultados.push({ clip: ref, efeito: mn, valores, verificado: ok });
    }
    return { resultados, verificado: resultados.every((r) => r.verificado) };
  }

  // Efeito de áudio pelo nome exibido (Simple Parametric EQ, Highpass, Mastering…), num ou mais clipes de áudio.
  async function pr_applyAudioEffect(input) {
    const refs = input.clips || [];
    if (!P.AudioFilterFactory) throw new PonteError(ERR.PREMIERE, "Esta versão do Premiere não expõe AudioFilterFactory.");
    if (input.listar) return { efeitos: await P.AudioFilterFactory.getDisplayNames() };
    if (!refs.length || !input.effect) throw new PonteError(ERR.BAD_INPUT, "clips e effect são obrigatórios (ou listar:true).");
    const p = await x.project();
    const seq = await x.sequence(p, input.sequence);
    let certos = 0;
    for (const ref of refs) {
      const it = await x.findClip(seq, ref);
      const comp = await P.AudioFilterFactory.createComponentByDisplayName(input.effect, it);
      const chain = await it.getComponentChain();
      const antes = await chain.getComponentCount();
      x.tx(p, `stocker-premiere: aplicar ${input.effect}`, () => [chain.createAppendComponentAction(comp)]);
      if ((await (await it.getComponentChain()).getComponentCount()) === antes + 1) certos++;
    }
    return { aplicados: refs.length, efeito: input.effect, verificado: certos === refs.length };
  }

  return { pr_setClipProperties, pr_findEffects, pr_applyEffect, pr_setEffectProperties, pr_applyAudioEffect };
};
