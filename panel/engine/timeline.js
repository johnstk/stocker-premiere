"use strict";
const { parseTime, alignSeconds } = require("../lib/tempo");
const { colorIndex } = require("../lib/cores");
const { PonteError, ERR } = require("../lib/protocol");

module.exports = (P) => {
  const x = require("./ppro")(P);

  async function removeAudioStartingAt(p, seq, label, time, frame) {
    for (const it of await x.trackItems(seq, label)) {
      if (Math.abs(x.sec(await it.getStartTime()) - time) <= frame / 2 + 1e-6) {
        const sel = await P.TrackItemSelection.createEmptySelection();
        await sel.addItem(it);
        const editor = P.SequenceEditor.getEditor(seq);
        x.tx(p, "stocker-premiere: tirar o áudio", () => [editor.createRemoveItemsAction(sel, false, P.Constants.MediaType.AUDIO, false)]);
        return;
      }
    }
  }

  async function pr_placeClip(input) {
    const p = await x.project();
    const seq = await x.sequence(p, input.sequence);
    const tb = await seq.getTimebase();
    const frame = Number(tb) / 254016000000;
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
        insert ? editor.createInsertProjectItemAction(clip, at, v.index, aIdx, false) : editor.createOverwriteItemAction(clip, at, v.index, aIdx),
      ]);
      if (aIndex === -1) {
        let semAudio = true;
        try { place(-1); } catch (e) { semAudio = false; place(v.index); }
        if (!semAudio) await removeAudioStartingAt(p, seq, `A${v.index + 1}`, time, frame);
      } else {
        place(aIndex);
      }
    } finally {
      if (hasRange) x.tx(p, "stocker-premiere: restaurar in/out do item", () => [clip.createSetInOutPointsAction(origIn, origOut)]);
    }
    const items = await x.trackItems(seq, `V${v.index + 1}`);
    for (let j = 0; j < items.length; j++) {
      const it = items[j];
      if (Math.abs(x.sec(await it.getStartTime()) - time) > frame / 2 + 1e-6) continue;
      const res = {
        track: `V${v.index + 1}`, clip: j + 1, start: x.sec(await it.getStartTime()), end: x.sec(await it.getEndTime()),
        sourceIn: x.sec(await it.getInPoint()), sourceOut: x.sec(await it.getOutPoint()), audioTrack: aIndex === -1 ? null : `A${aIndex + 1}`,
      };
      const diffs = [];
      if (input.sourceIn !== undefined && Math.abs(res.sourceIn - parseTime(input.sourceIn, tb)) > frame) diffs.push(`sourceIn ficou ${res.sourceIn}`);
      if (input.sourceOut !== undefined && Math.abs(res.sourceOut - parseTime(input.sourceOut, tb)) > frame) diffs.push(`sourceOut ficou ${res.sourceOut}`);
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
    let certos = 0;
    for (const ref of input.clips) if ((await (await x.findClip(seq, ref)).isDisabled()) === !input.enabled) certos++;
    return { alterados: alvo.length, verificado: certos === alvo.length };
  }

  async function pr_addMarkers(input) {
    if (!Array.isArray(input.markers) || !input.markers.length) throw new PonteError(ERR.BAD_INPUT, "markers deve ser uma lista [{time, name, comment, duration, color}].");
    const p = await x.project();
    const seq = await x.sequence(p, input.sequence);
    const tb = await seq.getTimebase();
    const want = input.markers.map((m) => ({ t: alignSeconds(parseTime(m.time, tb), tb), dur: Number(m.duration) || 0, name: m.name || "", comment: m.comment || "", color: colorIndex(m.color) }));
    const markers = await P.Markers.getMarkers(seq);
    x.tx(p, `stocker-premiere: ${want.length} marcador(es)`, () => want.map((w) =>
      markers.createAddMarkerAction(w.name, P.Marker.MARKER_TYPE_COMMENT, x.tickAligned(w.t, tb), x.tickSeconds(w.dur), w.comment)));
    const after = await (await P.Markers.getMarkers(seq)).getMarkers([]);
    const toColor = [];
    let achados = 0;
    for (const w of want) {
      for (const m of after) {
        if (Math.abs(x.sec(await m.getStart()) - w.t) < 1e-3 && (await m.getName()) === w.name) {
          achados++;
          if ((await m.getColorIndex()) !== w.color) toColor.push([m, w.color]);
          break;
        }
      }
    }
    if (toColor.length) x.tx(p, "stocker-premiere: cor dos marcadores", () => toColor.map(([m, c]) => m.createSetColorByIndexAction(c)));
    return { adicionados: achados, verificado: achados === want.length };
  }

  return { pr_placeClip, pr_setClipEnabled, pr_addMarkers };
};
