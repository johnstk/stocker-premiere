"use strict";
const { CLIP_PROPS, pixelsToNormalized, normalizedToPixels } = require("../lib/params");
const { parseTime } = require("../lib/tempo");
const { PonteError, ERR } = require("../lib/protocol");

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
    const toValue = (key, v) => (key === "position" ? pixelsToNormalized(v, size) : v);
    const resultados = [];
    for (const ref of refs) {
      const it = await x.findClip(seq, ref);
      const clipStart = x.sec(await it.getStartTime());
      const clipIn = x.sec(await it.getInPoint());
      const comps = await propComponents(it, [...statics, ...kfKeys]);
      x.tx(p, "stocker-premiere: propriedades do clipe", () => {
        const acts = [];
        for (const key of statics) {
          const spec = CLIP_PROPS[key];
          const prm = comps[spec.component].getParam(spec.index);
          if (prm.isTimeVarying()) acts.push(prm.createSetTimeVaryingAction(false));
          acts.push(prm.createSetValueAction(prm.createKeyframe(toValue(key, input[key])), true));
        }
        for (const key of kfKeys) {
          const spec = CLIP_PROPS[key];
          const prm = comps[spec.component].getParam(spec.index);
          if (!prm.isTimeVarying()) acts.push(prm.createSetTimeVaryingAction(true));
          for (const f of kfs.filter((k) => k[key] !== undefined)) {
            const kf = prm.createKeyframe(toValue(key, f[key]));
            kf.position = x.tickSeconds(parseTime(f.time, tb) - clipStart + clipIn); // tempo do keyframe = tempo da mídia
            acts.push(prm.createAddKeyframeAction(kf));
          }
        }
        return acts;
      });
      const fresh = await propComponents(it, [...statics, ...kfKeys]);
      const lido = {};
      for (const key of statics) {
        const spec = CLIP_PROPS[key];
        const v = (await fresh[spec.component].getParam(spec.index).getValueAtTime(x.tickSeconds(clipIn))).value;
        lido[key] = key === "position" ? normalizedToPixels(v, size) : v;
      }
      const keyframes = {};
      for (const key of kfKeys) {
        const spec = CLIP_PROPS[key];
        const list = await fresh[spec.component].getParam(spec.index).getKeyframeListAsTickTimes();
        keyframes[key] = list.map((t) => x.sec(t) - clipIn + clipStart).map((s) => Math.round(s * 1000) / 1000);
      }
      const okStatic = statics.every((k) => near(lido[k], input[k]));
      const okKf = kfKeys.every((k) => keyframes[k].length === kfs.filter((f) => f[k] !== undefined).length);
      resultados.push({ clip: ref, lido, keyframes: kfKeys.length ? keyframes : undefined, verificado: okStatic && okKf });
    }
    return { resultados, verificado: resultados.every((r) => r.verificado) };
  }

  return { pr_setClipProperties };
};
