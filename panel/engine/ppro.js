"use strict";
// Ajudantes sobre a API premierepro. Regra: buscar objetos com await FORA do lock;
// criar Actions só dentro de tx() (lockedAccess + executeTransaction, sem await).
const { secondsToTicks, ticksToSeconds, alignTicksToFrame, parseTime, roundSec } = require("../lib/tempo");
const { PonteError, ERR } = require("../lib/protocol");
const { matchNameIs } = require("../lib/params");

// Compartilhado por todos os módulos do painel (cada um chama makePpro). Só texto, nunca objeto do Premiere.
const INDEX_TTL_MS = 5 * 60 * 1000;
const projectIndex = { at: 0, items: null };

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
  // Os clipes de uma trilha não se sobrepõem e vêm em ordem de tempo: busca binária em vez de ler todos.
  // Cada getStartTime/getEndTime cria objetos nativos no UXP; ler a trilha inteira (1000+ clipes) derrubava o Premiere.
  async function firstEndingAfter(items, t) {
    let lo = 0, hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sec(await items[mid].getEndTime()) <= t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  // Índices (0-based) dos clipes que tocam [from, to), com início e fim já lidos.
  async function itemsInRange(items, from, to) {
    const out = [];
    for (let j = from === -Infinity ? 0 : await firstEndingAfter(items, from); j < items.length; j++) {
      const start = sec(await items[j].getStartTime());
      if (start >= to) break;
      const end = sec(await items[j].getEndTime());
      if (end > from) out.push({ j, it: items[j], start, end });
    }
    return out;
  }
  // Clipes que começam em `time` (± meio quadro).
  async function itemsStartingAt(items, time, frame) {
    return (await itemsInRange(items, time - frame / 2 - 1e-6, time + frame / 2 + 1e-6)).filter((r) => Math.abs(r.start - time) <= frame / 2 + 1e-6);
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
      const j = await firstEndingAfter(items, t);
      if (j < items.length && t >= sec(await items[j].getStartTime())) return items[j];
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
  // Seleção da sequência (a de createEmptySelection só vale dentro da callback).
  async function newSelection(seq, trackItems) {
    await seq.clearSelection();
    const sel = await seq.getSelection();
    for (const it of trackItems || []) await sel.addItem(it);
    return sel;
  }
  // Remove os itens pela seleção da sequência e limpa a seleção no fim.
  async function removeSelected(p, seq, items, mediaType, label) {
    const editor = P.SequenceEditor.getEditor(seq);
    try {
      const sel = await newSelection(seq, items);
      tx(p, label, () => [editor.createRemoveItemsAction(sel, false, mediaType, false)]);
    } finally {
      try { await seq.clearSelection(); } catch (e) { /* sem seleção */ }
    }
  }
  // Clona um clipe da timeline. O createCloneTrackItemAction do 27.1 Beta chama TrackItemSelection.createWithTrackItems,
  // que não existe; aqui a seleção vem da sequência e a ação é a mesma createAddItemsAction que ele usaria.
  async function cloneItem(p, seq, it, { offset = 0, video = 0, audio = 0, kind = "V", label = "stocker-premiere: clonar" } = {}) {
    const editor = P.SequenceEditor.getEditor(seq);
    try {
      const sel = await newSelection(seq, [it]);
      const mt = kind === "A" ? P.Constants.MediaType.AUDIO : P.Constants.MediaType.VIDEO;
      tx(p, label, () => [editor.createAddItemsAction(sel, tickSeconds(offset), video, audio, false, true, true, mt)]);
    } finally {
      try { await seq.clearSelection(); } catch (e) { /* sem seleção */ }
    }
  }
  async function nodeIdOf(item) { try { return String(await item.getId()); } catch (e) { return null; } }
  async function walkItems(folder, binPath, out, depth, maxDepth, keep = true) {
    for (const k of await folder.getItems()) {
      const base = { name: k.name, binPath, nodeId: await nodeIdOf(k), ...(keep ? { _item: k } : {}) };
      if (k.type === P.ProjectItem.TYPE_BIN) {
        out.push({ ...base, type: "bin" });
        if (depth < maxDepth) await walkItems(P.FolderItem.cast(k), binPath ? `${binPath}/${k.name}` : k.name, out, depth + 1, maxDepth, keep);
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
  // Índice só de texto (nada de objeto do Premiere) de onde está cada item: evita varrer o projeto inteiro a cada placeClip.
  // Vale INDEX_TTL_MS; import/criar/duplicar invalidam. Um acerto no índice ainda é relido no bin antes de usar.
  function invalidateIndex() { projectIndex.at = 0; projectIndex.items = null; }
  async function binByPath(p, binPath) {
    let folder = await p.getRootItem();
    for (const name of String(binPath).split("/").filter(Boolean)) {
      const child = (await folder.getItems()).find((k) => k.type === P.ProjectItem.TYPE_BIN && k.name === name);
      if (!child) return null;
      folder = P.FolderItem.cast(child);
    }
    return folder;
  }
  function matches(i, ref) {
    if (i.type === "bin") return false;
    if (ref && typeof ref === "object" && ref.nodeId) return i.nodeId === String(ref.nodeId);
    if (ref && typeof ref === "object" && ref.mediaPath) return i.mediaPath === ref.mediaPath;
    if (typeof ref === "string" && ref.includes("/")) return (i.binPath ? `${i.binPath}/${i.name}` : i.name) === ref || i.mediaPath === ref;
    if (typeof ref === "string") return i.name === ref;
    return false;
  }
  async function fullIndex(p) {
    if (!projectIndex.items || Date.now() - projectIndex.at > INDEX_TTL_MS) {
      const all = [];
      await walkItems(await p.getRootItem(), "", all, 0, 20, false);
      projectIndex.items = all.filter((i) => i.type !== "bin");
      projectIndex.at = Date.now();
    }
    return projectIndex.items;
  }
  async function findProjectItem(p, ref) {
    const desc = JSON.stringify(ref);
    let hits = (await fullIndex(p)).filter((i) => matches(i, ref));
    if (hits.length === 0) { invalidateIndex(); hits = (await fullIndex(p)).filter((i) => matches(i, ref)); }
    if (hits.length === 0) throw new PonteError(ERR.NOT_FOUND, `Item '${desc}' não está no projeto. Use pr_getProjectState ou pr_importFiles.`);
    if (hits.length > 1) throw new PonteError(ERR.BAD_INPUT, `Há ${hits.length} itens '${desc}'. Use {nodeId} ou o caminho "Bin/Nome". Candidatos: ${hits.slice(0, 5).map((h) => `${h.binPath}/${h.name} (${h.nodeId})`).join(", ")}`);
    // Relê só o bin do item e confere que ainda é ele.
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      const h = hits[0];
      const folder = await binByPath(p, h.binPath);
      if (folder) {
        for (const k of await folder.getItems()) {
          if (k.type === P.ProjectItem.TYPE_BIN || k.name !== h.name) continue;
          if (h.nodeId && (await nodeIdOf(k)) !== h.nodeId) continue;
          return { ...h, _item: k };
        }
      }
      if (tentativa === 0) {
        invalidateIndex();
        hits = (await fullIndex(p)).filter((i) => matches(i, ref));
        if (hits.length !== 1) break;
      }
    }
    throw new PonteError(ERR.NOT_FOUND, `Item '${desc}' não está mais onde estava no projeto. Tente de novo ou use pr_getProjectState.`);
  }
  return { cloneItem, project, sequence, tickSeconds, tickAligned, sec, parseTrack, trackItems, findClip, tx, componentByMatch, newSelection, removeSelected, nodeIdOf, walkItems, findProjectItem, invalidateIndex, firstEndingAfter, itemsInRange, itemsStartingAt, CLIP };
};
