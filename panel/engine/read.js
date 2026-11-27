"use strict";
const PANEL_VERSION = require("../lib/versao");
const { fpsFromTimebase, parseTime, roundSec } = require("../lib/tempo");
const { colorName } = require("../lib/cores");

module.exports = (P) => {
  const x = require("./ppro")(P);

  async function pr_status() {
    let premiere = "?";
    try { premiere = require("uxp").host.version; } catch (e) { /* fora do UXP */ }
    const p = await P.Project.getActiveProject();
    let seq = null;
    try { seq = p ? await p.getActiveSequence() : null; } catch (e) { seq = null; }
    return { premiere, painel: PANEL_VERSION, projeto: p ? p.name : null, caminho: p ? p.path : null, sequenciaAtiva: seq ? seq.name : null };
  }

  async function pr_getProjectState(input) {
    const p = await x.project();
    const all = [];
    await x.walkItems(await p.getRootItem(), "", all, 0, input.depth ?? 20, false);
    const items = input.bin ? all.filter((i) => i.binPath === input.bin || i.binPath.startsWith(input.bin + "/")) : all;
    const max = input.maxItems ?? 10000;
    const seqs = await p.getSequences();
    const active = await p.getActiveSequence();
    const sequences = [];
    for (const s of seqs) sequences.push({ name: s.name, nodeId: await x.nodeIdOf(await s.getProjectItem()) });
    return {
      projeto: p.name,
      items: items.slice(0, max),
      total: items.length,
      truncado: items.length > max,
      sequences,
      active: active ? active.name : null,
    };
  }

  async function pr_getSequenceState(input) {
    const p = await x.project();
    const seq = await x.sequence(p, input.sequence);
    const tb = await seq.getTimebase();
    const fs = await seq.getFrameSize();
    const out = {
      name: seq.name, fps: roundSec(fpsFromTimebase(tb)), width: fs.width, height: fs.height,
      duration: x.sec(await seq.getEndTime()), playhead: x.sec(await seq.getPlayerPosition()), tracks: [], markers: [],
    };
    // Só as trilhas pedidas ("all", "video", "audio" ou lista "V2,V7") e, em cada uma, só o trecho [from, to) por busca binária.
    const want = String(input.tracks || "all");
    const lista = /^(all|video|audio)$/.test(want) ? null : new Set(want.split(/[\s,]+/).filter(Boolean).map((l) => { const t = x.parseTrack(l); return `${t.kind}${t.index + 1}`; }));
    const from = input.from !== undefined ? parseTime(input.from, tb) : -Infinity;
    const to = input.to !== undefined ? parseTime(input.to, tb) : Infinity;
    const comMidia = input.detail !== false;
    let budget = input.maxClips ?? 300;
    externo: for (const kind of ["V", "A"]) {
      if ((kind === "V" && want === "audio") || (kind === "A" && want === "video")) continue;
      const n = kind === "V" ? await seq.getVideoTrackCount() : await seq.getAudioTrackCount();
      for (let i = 0; i < n; i++) {
        const label = `${kind}${i + 1}`;
        if (lista && !lista.has(label)) continue;
        const items = await x.trackItems(seq, label);
        const clips = [];
        for (const { j, it, start, end } of await x.itemsInRange(items, from, to)) {
          if (budget-- <= 0) { out.truncado = true; break; }
          let mediaPath = null;
          if (comMidia) { try { mediaPath = await P.ClipProjectItem.cast(await it.getProjectItem()).getMediaFilePath(); } catch (e) { mediaPath = null; } }
          clips.push({ clip: j + 1, name: await it.getName(), start, end, sourceIn: x.sec(await it.getInPoint()), sourceOut: x.sec(await it.getOutPoint()), disabled: await it.isDisabled(), mediaPath });
        }
        out.tracks.push({ name: label, type: kind === "V" ? "video" : "audio", clips, total: items.length });
        if (out.truncado) break externo;
      }
    }
    if (input.markers !== false) {
      const markers = await P.Markers.getMarkers(seq);
      for (const m of await markers.getMarkers([])) {
        const t = x.sec(await m.getStart());
        if (t < from || t >= to) continue;
        out.markers.push({ time: t, duration: x.sec(await m.getDuration()), name: await m.getName(), comment: await m.getComments(), color: colorName(await m.getColorIndex()) });
      }
    }
    return out;
  }

  return { pr_status, pr_getProjectState, pr_getSequenceState };
};
