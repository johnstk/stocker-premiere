"use strict";
// Ajudantes sobre a API premierepro. Regra: buscar objetos com await FORA do lock;
// criar Actions só dentro de tx() (lockedAccess + executeTransaction, sem await).
const { secondsToTicks, ticksToSeconds, alignTicksToFrame, parseTime, roundSec } = require("../lib/tempo");
const { PonteError, ERR } = require("../lib/protocol");
const { matchNameIs } = require("../lib/params");

module.exports = function makePpro(P) {
  const CLIP = P.Constants.TrackItemType.CLIP;

  async function project() {
    const p = await P.Project.getActiveProject();
    if (!p) throw new PonteError(ERR.NOT_FOUND, "Nenhum projeto aberto no Premiere.");
    return p;
  }
  async function sequence(p, name) {
    if (!name) {
      const s = await p.getActiveSequence();
      if (!s) throw new PonteError(ERR.NOT_FOUND, "Não há sequência ativa. Abra uma sequência ou passe 'sequence'.");
      return s;
    }
    const all = await p.getSequences();
    const iguais = all.filter((x) => x.name === name);
    if (iguais.length > 1) throw new PonteError(ERR.BAD_INPUT, `Há ${iguais.length} sequências chamadas '${name}'. Renomeie para um nome único.`);
    const s = iguais[0];
    if (!s) throw new PonteError(ERR.NOT_FOUND, `Sequência '${name}' não encontrada. Existem: ${all.map((x) => x.name).join(", ")}`);
    return s;
  }
  function tickSeconds(seconds) { return P.TickTime.createWithTicks(String(secondsToTicks(seconds))); }
  function tickAligned(seconds, tb) { return P.TickTime.createWithTicks(String(alignTicksToFrame(secondsToTicks(seconds), tb))); }
  function sec(tt) { return roundSec(ticksToSeconds(tt.ticksNumber !== undefined ? tt.ticksNumber : Number(tt.ticks))); }
  function parseTrack(label) {
    const m = /^([VA])(\d+)$/i.exec(String(label || ""));
    if (!m) throw new PonteError(ERR.BAD_INPUT, `Trilha inválida '${label}'. Use V1, V2… ou A1, A2…`);
    return { kind: m[1].toUpperCase(), index: Number(m[2]) - 1 };
  }
  async function trackItems(seq, label) {
    const { kind, index } = parseTrack(label);
    const count = kind === "V" ? await seq.getVideoTrackCount() : await seq.getAudioTrackCount();
    if (index >= count) throw new PonteError(ERR.NOT_FOUND, `A sequência tem ${count} trilha(s) ${kind === "V" ? "de vídeo" : "de áudio"}; ${label} não existe.`);
    const track = kind === "V" ? await seq.getVideoTrack(index) : await seq.getAudioTrack(index);
    return await track.getTrackItems(CLIP, false);
  }
  async function findClip(seq, ref) {
    if (!ref || !ref.track) throw new PonteError(ERR.BAD_INPUT, "clipe precisa de {track, clip} ou {track, time}");
    const items = await trackItems(seq, ref.track);
    if (Number.isInteger(ref.clip)) {
      const it = items[ref.clip - 1];
      if (!it) throw new PonteError(ERR.NOT_FOUND, `${ref.track} tem ${items.length} clipe(s); não existe o clipe ${ref.clip}.`);
      return it;
    }
    if (typeof ref.clip === "string") {
      for (const it of items) if ((await it.getName()) === ref.clip) return it;
      throw new PonteError(ERR.NOT_FOUND, `Nenhum clipe chamado '${ref.clip}' em ${ref.track}.`);
    }
    if (ref.time !== undefined) {
      const t = parseTime(ref.time, await seq.getTimebase());
      for (const it of items) {
        if (t >= sec(await it.getStartTime()) && t < sec(await it.getEndTime())) return it;
      }
      throw new PonteError(ERR.NOT_FOUND, `Nenhum clipe em ${ref.track} no tempo ${t}s.`);
    }
    throw new PonteError(ERR.BAD_INPUT, "clipe precisa de 'clip' (número 1-based ou nome) ou 'time'.");
  }
  function tx(p, label, build) {
    let ok = false;
    let erro = null;
    p.lockedAccess(() => {
      try { ok = p.executeTransaction((ca) => { for (const a of build()) ca.addAction(a); }, label); } catch (e) { erro = e; }
    });
    if (erro) throw new PonteError(ERR.PREMIERE, `${label}: ${erro.message || erro}`);
    if (!ok) throw new PonteError(ERR.PREMIERE, `O Premiere recusou a transação '${label}'.`);
  }
  async function componentByMatch(trackItem, matchName, occurrence = 1) {
    const chain = await trackItem.getComponentChain();
    let seen = 0;
    const n = await chain.getComponentCount();
    for (let i = 0; i < n; i++) {
      const c = await chain.getComponentAtIndex(i);
      if (matchNameIs(await c.getMatchName(), matchName) && ++seen === occurrence) return { chain, component: c, index: i };
    }
    return { chain, component: null, index: -1 };
  }
  // createEmptySelection só funciona com callback (validado ao vivo no 26.5.2).
  async function newSelection(trackItems) {
    let sel = null;
    await P.TrackItemSelection.createEmptySelection((s) => { sel = s; });
    if (!sel) throw new PonteError(ERR.PREMIERE, "O Premiere não devolveu a seleção vazia.");
    for (const it of trackItems || []) await sel.addItem(it);
    return sel;
  }
  async function nodeIdOf(item) { try { return String(await item.getId()); } catch (e) { return null; } }
  async function walkItems(folder, binPath, out, depth, maxDepth) {
    for (const k of await folder.getItems()) {
      const base = { name: k.name, binPath, nodeId: await nodeIdOf(k), _item: k };
      if (k.type === P.ProjectItem.TYPE_BIN) {
        out.push({ ...base, type: "bin" });
        if (depth < maxDepth) await walkItems(P.FolderItem.cast(k), binPath ? `${binPath}/${k.name}` : k.name, out, depth + 1, maxDepth);
        continue;
      }
      const c = P.ClipProjectItem.cast(k);
      let isSeq = false;
      try { isSeq = await c.isSequence(); } catch (e) { /* item sem mídia */ }
      let mediaPath = null;
      if (!isSeq) { try { mediaPath = await c.getMediaFilePath(); } catch (e) { mediaPath = null; } }
      out.push({ ...base, type: isSeq ? "sequence" : "clip", mediaPath });
    }
  }
  async function findProjectItem(p, ref) {
    const all = [];
    await walkItems(await p.getRootItem(), "", all, 0, 20);
    const items = all.filter((i) => i.type !== "bin");
    let hits = [];
    if (ref && typeof ref === "object" && ref.nodeId) hits = items.filter((i) => i.nodeId === String(ref.nodeId));
    else if (ref && typeof ref === "object" && ref.mediaPath) hits = items.filter((i) => i.mediaPath === ref.mediaPath);
    else if (typeof ref === "string" && ref.includes("/")) hits = items.filter((i) => (i.binPath ? `${i.binPath}/${i.name}` : i.name) === ref || i.mediaPath === ref);
    else if (typeof ref === "string") hits = items.filter((i) => i.name === ref);
    if (hits.length === 0) throw new PonteError(ERR.NOT_FOUND, `Item '${JSON.stringify(ref)}' não está no projeto. Use pr_getProjectState ou pr_importFiles.`);
    if (hits.length > 1) throw new PonteError(ERR.BAD_INPUT, `Há ${hits.length} itens '${JSON.stringify(ref)}'. Use {nodeId} ou o caminho "Bin/Nome". Candidatos: ${hits.slice(0, 5).map((h) => `${h.binPath}/${h.name} (${h.nodeId})`).join(", ")}`);
    return hits[0];
  }
  return { project, sequence, tickSeconds, tickAligned, sec, parseTrack, trackItems, findClip, tx, componentByMatch, newSelection, nodeIdOf, walkItems, findProjectItem, CLIP };
};
