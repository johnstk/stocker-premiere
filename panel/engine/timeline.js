"use strict";
const { parseTime, alignSeconds, fpsFromTimebase } = require("../lib/tempo");
const { colorIndex } = require("../lib/cores");
const { PonteError, ERR } = require("../lib/protocol");

const roundDur = (n) => Math.round(n * 1000) / 1000;

module.exports = (P) => {
  const x = require("./ppro")(P);

  // Itens da trilha de áudio que começam em `time`, com uma chave de identidade.
  async function audioAt(seq, label, time, frame) {
    const out = [];
    let items = [];
    try { items = await x.trackItems(seq, label); } catch (e) { return out; }
    for (const { it, start: st } of await x.itemsStartingAt(items, time, frame)) {
      let pid = null;
      try { pid = await x.nodeIdOf(await it.getProjectItem()); } catch (e) { pid = null; }
      out.push({ it, key: `${st}|${pid}|${await it.getName()}` });
    }
    return out;
  }

  // Remove só o áudio que NÃO existia antes (snapshot de chaves).
  async function removeAudioStartingAt(p, seq, label, time, frame, antes) {
    const alvo = (await audioAt(seq, label, time, frame)).filter((a) => !antes.has(a.key)).map((a) => a.it);
    if (!alvo.length) return;
    await x.removeSelected(p, seq, alvo, P.Constants.MediaType.AUDIO, "stocker-premiere: tirar o áudio");
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
    let antesAudio = new Set();
    if (aIndex === -1) antesAudio = new Set((await audioAt(seq, `A${v.index + 1}`, time, frame)).map((a) => a.key));
    try {
      const editor = P.SequenceEditor.getEditor(seq);
      const at = x.tickAligned(time, tb);
      const insert = input.mode === "insert";
      const place = (aIdx) => x.tx(p, `stocker-premiere: colocar ${found.name}`, () => [
        insert ? editor.createInsertProjectItemAction(found._item, at, v.index, aIdx, false) : editor.createOverwriteItemAction(found._item, at, v.index, aIdx),
      ]);
      // aIdx -1 ainda coloca o áudio no Premiere: coloca na trilha do vídeo e tira depois.
      place(aIndex === -1 ? v.index : aIndex);
      if (aIndex === -1) await removeAudioStartingAt(p, seq, `A${v.index + 1}`, time, frame, antesAudio);
    } finally {
      if (hasRange) x.tx(p, "stocker-premiere: restaurar in/out do item", () => [clip.createSetInOutPointsAction(origIn, origOut)]);
    }
    // Confere só os clipes que começam em `time` (busca binária), não a trilha inteira.
    const items = await x.trackItems(seq, `V${v.index + 1}`);
    for (const { j, it, start, end } of await x.itemsStartingAt(items, time, frame)) {
      const res = {
        track: `V${v.index + 1}`, clip: j + 1, start, end,
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
          const lidos = await audioAt(seq, rot, time, frame);
          temAudio = aIndex === -1 ? lidos.some((l) => !antesAudio.has(l.key)) : lidos.length > 0;
        } catch (e) { temAudio = false; }
        if (aIndex === -1 && temAudio) diffs.push(`ficou áudio novo em ${rot} no tempo ${time}s`);
        if (aIndex !== -1 && !temAudio) diffs.push(`não há clipe de áudio em ${rot} no tempo ${time}s`);
      }
      res.verificado = diffs.length === 0;
      if (diffs.length) res.diferenca = diffs.join("; ");
      return res;
    }
    // Item só de áudio (ex.: WAV da lapela): não gera clipe em V(n); confere na trilha de áudio usada.
    // (Item só de áudio com audioTrack:null está fora de escopo: não há trilha de áudio para conferir.)
    if (aIndex !== -1) {
      const rotA = `A${aIndex + 1}`;
      let itensA = [];
      try { itensA = await x.trackItems(seq, rotA); } catch (e) { itensA = []; }
      for (const { j, it, start, end } of await x.itemsStartingAt(itensA, time, frame)) {
        let mesmo = null;
        try {
          const pi = await it.getProjectItem();
          const idLido = await x.nodeIdOf(pi);
          if (idLido && found.nodeId) mesmo = idLido === String(found.nodeId);
          else {
            const mp = await P.ClipProjectItem.cast(pi).getMediaFilePath();
            if (mp && found.mediaPath) mesmo = mp.normalize("NFC") === found.mediaPath.normalize("NFC");
          }
        } catch (e) { mesmo = null; }
        if (mesmo !== true) continue;
        const res = {
          track: rotA, clip: j + 1, start, end,
          sourceIn: x.sec(await it.getInPoint()), sourceOut: x.sec(await it.getOutPoint()), audioTrack: rotA, somenteAudio: true,
        };
        const diffs = [];
        if (input.sourceIn !== undefined && Math.abs(res.sourceIn - parseTime(input.sourceIn, tb)) > frame) diffs.push(`sourceIn ficou ${res.sourceIn}`);
        if (input.sourceOut !== undefined && Math.abs(res.sourceOut - parseTime(input.sourceOut, tb)) > frame) diffs.push(`sourceOut ficou ${res.sourceOut}`);
        if (input.sourceIn !== undefined && input.sourceOut !== undefined) {
          const esperado = parseTime(input.sourceOut, tb) - parseTime(input.sourceIn, tb);
          if (Math.abs((res.end - res.start) - esperado) > frame) diffs.push(`duração ficou ${roundDur(res.end - res.start)}s; esperado ${roundDur(esperado)}s`);
        }
        res.verificado = diffs.length === 0;
        if (diffs.length) res.diferenca = diffs.join("; ");
        return res;
      }
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

  // Move clipes para outra trilha do mesmo tipo, no mesmo tempo: clona com o deslocamento vertical (leva volume,
  // efeitos e nome) e tira o original. A trilha de destino precisa estar livre no intervalo do clipe.
  async function pr_moveClip(input) {
    const refs = input.clips || [];
    if (!refs.length || !input.toTrack) throw new PonteError(ERR.BAD_INPUT, "clips e toTrack são obrigatórios.");
    const p = await x.project();
    const seq = await x.sequence(p, input.sequence);
    const tb = await seq.getTimebase();
    const frame = 1 / fpsFromTimebase(tb);
    const dest = x.parseTrack(input.toTrack);
    const alvo = [];
    for (const ref of refs) {
      const src = x.parseTrack(ref.track);
      if (src.kind !== dest.kind) throw new PonteError(ERR.BAD_INPUT, `Não dá para mover de ${ref.track} para ${input.toTrack}: tipos de trilha diferentes.`);
      const it = await x.findClip(seq, ref);
      alvo.push({ ref, it, src, nome: await it.getName(), ini: x.sec(await it.getStartTime()), fim: x.sec(await it.getEndTime()) });
    }
    const editor = P.SequenceEditor.getEditor(seq);
    const resultados = [];
    for (const a of alvo) {
      const label = `${dest.kind}${a.src.index + 1}`;
      const destLabel = `${dest.kind}${dest.index + 1}`;
      if (a.src.index === dest.index) { resultados.push({ clip: a.ref, nome: a.nome, track: destLabel, verificado: true }); continue; }
      const ocupado = [];
      for (const { it: o, start: oi, end: of } of await x.itemsInRange(await x.trackItems(seq, destLabel), a.ini + frame / 2, a.fim - frame / 2)) {
        ocupado.push(`${await o.getName()} (${oi}–${of})`);
      }
      if (ocupado.length) { resultados.push({ clip: a.ref, nome: a.nome, verificado: false, erro: `${destLabel} ocupada no intervalo: ${ocupado.join(", ")}` }); continue; }
      const delta = dest.index - a.src.index;
      await x.cloneItem(p, seq, a.it, { video: dest.kind === "V" ? delta : 0, audio: dest.kind === "A" ? delta : 0, kind: dest.kind, label: `stocker-premiere: mover ${a.nome} para ${destLabel}` });
      let novo = null;
      for (const { it: o } of await x.itemsStartingAt(await x.trackItems(seq, destLabel), a.ini, frame)) {
        if ((await o.getName()) === a.nome) { novo = o; break; }
      }
      if (!novo) { resultados.push({ clip: a.ref, nome: a.nome, verificado: false, erro: `o clone não apareceu em ${destLabel}; o original ficou em ${label}` }); continue; }
      await x.removeSelected(p, seq, [a.it], dest.kind === "A" ? P.Constants.MediaType.AUDIO : P.Constants.MediaType.VIDEO, `stocker-premiere: tirar o original de ${a.nome}`);
      let sobrou = false;
      for (const { it: o } of await x.itemsStartingAt(await x.trackItems(seq, label), a.ini, frame)) {
        if ((await o.getName()) === a.nome) { sobrou = true; break; }
      }
      resultados.push({ clip: a.ref, nome: a.nome, track: destLabel, inicio: a.ini, verificado: !sobrou, erro: sobrou ? `o original continua em ${label}` : undefined });
    }
    return { resultados, verificado: resultados.every((r) => r.verificado) };
  }

  return { pr_placeClip, pr_setClipEnabled, pr_addMarkers, pr_moveClip };
};
