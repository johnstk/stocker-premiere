"use strict";
const { parseTime, alignSeconds, fpsFromTimebase } = require("../lib/tempo");
const { colorIndex } = require("../lib/cores");
const { PonteError, ERR } = require("../lib/protocol");

const roundDur = (n) => Math.round(n * 1000) / 1000;

module.exports = (P) => {
  const x = require("./ppro")(P);

  async function removeAudioStartingAt(p, seq, label, time, frame) {
    const alvo = [];
    for (const it of await x.trackItems(seq, label)) {
      if (Math.abs(x.sec(await it.getStartTime()) - time) <= frame / 2 + 1e-6) alvo.push(it);
    }
    if (!alvo.length) return;
    const sel = await x.newSelection(alvo);
    const editor = P.SequenceEditor.getEditor(seq);
    x.tx(p, "stocker-premiere: tirar o áudio", () => [editor.createRemoveItemsAction(sel, false, P.Constants.MediaType.AUDIO, false)]);
  }

  async function pr_placeClip(input) {
    const p = await x.project();
    const seq = await x.sequence(p, input.sequence);
    const tb = await seq.getTimebase();
    const frame = 1 / fpsFromTimebase(tb);
    const found = await x.findProjectItem(p, input.item);
    const clip = P.ClipProjectItem.cast(found._item);
    const v = x.parseTrack(input.track || "V1");
    if (v.kind !== "V") throw new PonteError(ERR.BAD_INPUT, "track deve ser de vídeo (V1, V2…).");
    let aIndex = v.index;
    if (input.audioTrack === null) aIndex = -1;
    else if (input.audioTrack !== undefined) {
      const a = x.parseTrack(input.audioTrack);
      if (a.kind !== "A") throw new PonteError(ERR.BAD_INPUT, "audioTrack deve ser A1, A2… ou null.");
      aIndex = a.index;
    }
    const time = alignSeconds(parseTime(input.time ?? 0, tb), tb);
    const VIDEO = P.Constants.MediaType.VIDEO;
    const origIn = await clip.getInPoint(VIDEO);
    const origOut = await clip.getOutPoint(VIDEO);
    const hasRange = input.sourceIn !== undefined || input.sourceOut !== undefined;
    if (hasRange) {
      const sIn = input.sourceIn !== undefined ? x.tickAligned(parseTime(input.sourceIn, tb), tb) : origIn;
      const sOut = input.sourceOut !== undefined ? x.tickAligned(parseTime(input.sourceOut, tb), tb) : origOut;
      x.tx(p, "stocker-premiere: marcar in/out", () => [clip.createSetInOutPointsAction(sIn, sOut)]);
    }
    try {
      const editor = P.SequenceEditor.getEditor(seq);
      const at = x.tickAligned(time, tb);
      const insert = input.mode === "insert";
      const place = (aIdx) => x.tx(p, `stocker-premiere: colocar ${found.name}`, () => [
        insert ? editor.createInsertProjectItemAction(found._item, at, v.index, aIdx, false) : editor.createOverwriteItemAction(found._item, at, v.index, aIdx),
      ]);
      // aIdx -1 ainda coloca o áudio no Premiere: coloca na trilha do vídeo e tira depois.
      place(aIndex === -1 ? v.index : aIndex);
      if (aIndex === -1) await removeAudioStartingAt(p, seq, `A${v.index + 1}`, time, frame);
    } finally {
      if (hasRange) x.tx(p, "stocker-premiere: restaurar in/out do item", () => [clip.createSetInOutPointsAction(origIn, origOut)]);
    }
    const items = await x.trackItems(seq, `V${v.index + 1}`);
    const startsAt = (it) => it.then((t) => Math.abs(x.sec(t) - time) <= frame / 2 + 1e-6);
    for (let j = 0; j < items.length; j++) {
      const it = items[j];
      if (!(await startsAt(it.getStartTime()))) continue;
      const res = {
        track: `V${v.index + 1}`, clip: j + 1, start: x.sec(await it.getStartTime()), end: x.sec(await it.getEndTime()),
        sourceIn: x.sec(await it.getInPoint()), sourceOut: x.sec(await it.getOutPoint()), audioTrack: aIndex === -1 ? null : `A${aIndex + 1}`,
      };
      const diffs = [];
      // é mesmo o item colocado?
      let mesmo = null;
      try {
        const pi = await it.getProjectItem();
        const idLido = await x.nodeIdOf(pi);
        if (idLido && found.nodeId) mesmo = idLido === String(found.nodeId);
        else {
          const mp = await P.ClipProjectItem.cast(pi).getMediaFilePath();
          if (mp && found.mediaPath) mesmo = mp.normalize("NFC") === found.mediaPath.normalize("NFC");
        }
      } catch (e) { diffs.push(`não consegui reler o item do clipe colocado: ${(e && e.message) || e}`); }
      if (mesmo === false) diffs.push("o clipe que começa nesse tempo não é o item pedido");
      if (input.sourceIn !== undefined && Math.abs(res.sourceIn - parseTime(input.sourceIn, tb)) > frame) diffs.push(`sourceIn ficou ${res.sourceIn}`);
      if (input.sourceOut !== undefined && Math.abs(res.sourceOut - parseTime(input.sourceOut, tb)) > frame) diffs.push(`sourceOut ficou ${res.sourceOut}`);
      if (input.sourceIn !== undefined && input.sourceOut !== undefined) {
        const esperado = parseTime(input.sourceOut, tb) - parseTime(input.sourceIn, tb);
        if (Math.abs((res.end - res.start) - esperado) > frame) diffs.push(`duração ficou ${roundDur(res.end - res.start)}s; esperado ${roundDur(esperado)}s`);
      }
      // áudio: só confere o que foi pedido explicitamente
      if (aIndex === -1 || typeof input.audioTrack === "string") {
        const rot = `A${(aIndex === -1 ? v.index : aIndex) + 1}`;
        let temAudio = false;
        try {
          for (const a of await x.trackItems(seq, rot)) {
            if (await startsAt(a.getStartTime())) { temAudio = true; break; }
          }
        } catch (e) { temAudio = false; }
        if (aIndex === -1 && temAudio) diffs.push(`ficou áudio em ${rot} no tempo ${time}s`);
        if (aIndex !== -1 && !temAudio) diffs.push(`não há clipe de áudio em ${rot} no tempo ${time}s`);
      }
      res.verificado = diffs.length === 0;
      if (diffs.length) res.diferenca = diffs.join("; ");
      return res;
    }
    return { track: `V${v.index + 1}`, verificado: false, diferenca: `nenhum clipe começa em ${time}s em V${v.index + 1} depois de colocar` };
  }

  async function pr_setClipEnabled(input) {
    if (!Array.isArray(input.clips) || !input.clips.length || typeof input.enabled !== "boolean") throw new PonteError(ERR.BAD_INPUT, "clips (lista) e enabled (true/false) são obrigatórios.");
    const p = await x.project();
    const seq = await x.sequence(p, input.sequence);
    const alvo = [];
    for (const ref of input.clips) alvo.push(await x.findClip(seq, ref));
    x.tx(p, `stocker-premiere: ${input.enabled ? "ligar" : "desligar"} ${alvo.length} clipe(s)`, () => alvo.map((it) => it.createSetDisabledAction(!input.enabled)));
    const erradas = [];
    for (const ref of input.clips) {
      let ok = false;
      try { ok = (await (await x.findClip(seq, ref)).isDisabled()) === !input.enabled; } catch (e) { ok = false; }
      if (!ok) erradas.push(JSON.stringify(ref));
    }
    const res = { alterados: alvo.length, verificado: erradas.length === 0 };
    if (erradas.length) res.diferenca = `não ficaram ${input.enabled ? "ligados" : "desligados"}: ${erradas.join(", ")}`;
    return res;
  }

  async function pr_addMarkers(input) {
    if (!Array.isArray(input.markers) || !input.markers.length) throw new PonteError(ERR.BAD_INPUT, "markers deve ser uma lista [{time, name, comment, duration, color}].");
    const p = await x.project();
    const seq = await x.sequence(p, input.sequence);
    const tb = await seq.getTimebase();
    const want = input.markers.map((m) => ({ t: alignSeconds(parseTime(m.time, tb), tb), dur: Number(m.duration) || 0, name: m.name || "", comment: m.comment || "", color: colorIndex(m.color) }));
    const markers = await P.Markers.getMarkers(seq);
    const antes = [];
    for (const m of await markers.getMarkers([])) antes.push({ t: x.sec(await m.getStart()), name: await m.getName() });
    const existia = (w) => antes.some((a) => a.name === w.name && Math.abs(a.t - w.t) < 1e-3);
    const novos = want.map((w) => !existia(w));
    x.tx(p, `stocker-premiere: ${want.length} marcador(es)`, () => want.map((w) =>
      markers.createAddMarkerAction(w.name, P.Marker.MARKER_TYPE_COMMENT, x.tickAligned(w.t, tb), x.tickSeconds(w.dur), w.comment)));
    const frame = 1 / fpsFromTimebase(tb);
    const lerDepois = async () => {
      const after = await (await P.Markers.getMarkers(seq)).getMarkers([]);
      const lidos = [];
      for (const m of after) lidos.push({ m, t: x.sec(await m.getStart()), name: await m.getName(), dur: x.sec(await m.getDuration()), cor: await m.getColorIndex() });
      return lidos;
    };
    let lidos = await lerDepois();
    const achar = (w) => lidos.find((l) => l.name === w.name && Math.abs(l.t - w.t) < 1e-3);
    const toColor = [];
    for (const w of want) { const l = achar(w); if (l && l.cor !== w.color) toColor.push([l.m, w.color]); }
    if (toColor.length) {
      x.tx(p, "stocker-premiere: cor dos marcadores", () => toColor.map(([m, c]) => m.createSetColorByIndexAction(c)));
      lidos = await lerDepois();
    }
    const diffs = [];
    let adicionados = 0;
    want.forEach((w, i) => {
      const l = achar(w);
      const rotulo = `'${w.name}' em ${w.t}s`;
      if (!l) { diffs.push(`marcador ${rotulo} não apareceu`); return; }
      const d = [];
      if (Math.abs(l.dur - w.dur) > frame) d.push(`duração ${l.dur}s (pedido ${w.dur}s)`);
      if (l.cor !== w.color) d.push(`cor índice ${l.cor} (pedido ${w.color})`);
      if (!novos[i]) d.push("já existia um marcador igual antes");
      if (d.length) diffs.push(`marcador ${rotulo}: ${d.join(", ")}`);
      else adicionados++;
    });
    const res = { adicionados, verificado: diffs.length === 0 };
    if (diffs.length) res.diferenca = diffs.join("; ");
    return res;
  }

  return { pr_placeClip, pr_setClipEnabled, pr_addMarkers };
};
