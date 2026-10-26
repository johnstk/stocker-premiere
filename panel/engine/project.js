"use strict";
const { fpsFromTimebase, roundSec } = require("../lib/tempo");
const { PonteError, ERR } = require("../lib/protocol");

module.exports = (P) => {
  const x = require("./ppro")(P);

  async function ensureBin(p, binPath) {
    let folder = await p.getRootItem();
    for (const name of String(binPath).split("/").filter(Boolean)) {
      const findChild = async () => (await folder.getItems()).find((k) => k.type === P.ProjectItem.TYPE_BIN && k.name === name);
      let child = await findChild();
      if (!child) {
        const parent = folder;
        x.tx(p, `stocker-premiere: criar bin ${name}`, () => [parent.createBinAction(name, false)]);
        child = await findChild();
        if (!child) throw new PonteError(ERR.PREMIERE, `Criei o bin '${name}', mas ele não apareceu.`);
      }
      folder = P.FolderItem.cast(child);
    }
    return folder;
  }

  async function pr_importFiles(input) {
    const paths = input.paths || [];
    if (!paths.length || !paths.every((s) => typeof s === "string" && s.startsWith("/"))) throw new PonteError(ERR.BAD_INPUT, "paths deve ser uma lista de caminhos absolutos.");
    const p = await x.project();
    const target = input.bin ? await ensureBin(p, input.bin) : await p.getRootItem();
    const ids = async () => {
      const all = [];
      await x.walkItems(target, input.bin || "", all, 0, 0);
      return all;
    };
    const antes = new Set((await ids()).map((i) => i.nodeId));
    const ok = await p.importFiles(paths, true, target, false);
    if (!ok) throw new PonteError(ERR.PREMIERE, "O Premiere recusou o import (importFiles devolveu false).");
    const novos = (await ids()).filter((i) => !antes.has(i.nodeId) && i.mediaPath);
    const usados = new Set();
    const importados = paths.map((path) => {
      const alvo = path.normalize("NFC");
      const it = novos.find((i) => !usados.has(i.nodeId) && i.mediaPath.normalize("NFC") === alvo);
      if (!it) return { path, erro: "nenhum item novo com esse caminho apareceu no bin depois do import" };
      usados.add(it.nodeId);
      return { path, nodeId: it.nodeId, name: it.name };
    });
    return { importados, verificado: importados.every((i) => !i.erro) };
  }

  async function removeAllTrackItems(p, seq) {
    const editor = P.SequenceEditor.getEditor(seq);
    for (const kind of ["V", "A"]) {
      const todos = [];
      const count = kind === "V" ? await seq.getVideoTrackCount() : await seq.getAudioTrackCount();
      for (let i = 0; i < count; i++) for (const it of await x.trackItems(seq, `${kind}${i + 1}`)) todos.push(it);
      if (!todos.length) continue;
      const sel = await x.newSelection(todos);
      const tipo = kind === "V" ? P.Constants.MediaType.VIDEO : P.Constants.MediaType.AUDIO;
      x.tx(p, `stocker-premiere: esvaziar ${kind === "V" ? "vídeo" : "áudio"}`, () => [editor.createRemoveItemsAction(sel, false, tipo, false)]);
    }
  }

  async function pr_createSequence(input) {
    if (!input.name || !Array.isArray(input.fromItems) || !input.fromItems.length) throw new PonteError(ERR.BAD_INPUT, "name e fromItems são obrigatórios.");
    const p = await x.project();
    if ((await p.getSequences()).some((s) => s.name === input.name)) throw new PonteError(ERR.BAD_INPUT, `Já existe uma sequência '${input.name}'. Escolha outro nome ou apague a antiga.`);
    const items = [];
    for (const ref of input.fromItems) items.push(P.ClipProjectItem.cast((await x.findProjectItem(p, ref))._item));
    const target = input.bin ? await ensureBin(p, input.bin) : await p.getInsertionBin();
    const seq = await p.createSequenceFromMedia(input.name, items, target);
    if (!seq) throw new PonteError(ERR.PREMIERE, "createSequenceFromMedia não devolveu a sequência.");
    if (input.empty) await removeAllTrackItems(p, seq);
    await p.openSequence(seq);
    let verificado = true;
    let diferenca;
    if (input.empty) {
      let sobraram = 0;
      for (const kind of ["V", "A"]) {
        const count = kind === "V" ? await seq.getVideoTrackCount() : await seq.getAudioTrackCount();
        for (let i = 0; i < count; i++) sobraram += (await x.trackItems(seq, `${kind}${i + 1}`)).length;
      }
      if (sobraram) { verificado = false; diferenca = `a sequência deveria estar vazia, mas ficaram ${sobraram} clipe(s)`; }
    }
    const tb = await seq.getTimebase();
    const fs = await seq.getFrameSize();
    return { name: seq.name, nodeId: await x.nodeIdOf(await seq.getProjectItem()), fps: roundSec(fpsFromTimebase(tb)), width: fs.width, height: fs.height, verificado, ...(diferenca ? { diferenca } : {}) };
  }

  async function pr_duplicateSequence(input) {
    const p = await x.project();
    const seq = await x.sequence(p, input.sequence);
    if (input.name && (await p.getSequences()).some((s) => s.name === input.name)) throw new PonteError(ERR.BAD_INPUT, `Já existe uma sequência '${input.name}'. Escolha outro nome ou apague a antiga.`);
    const ids = async () => {
      const m = new Map();
      for (const s of await p.getSequences()) m.set(await x.nodeIdOf(await s.getProjectItem()), s);
      return m;
    };
    const before = await ids();
    x.tx(p, `stocker-premiere: duplicar ${seq.name}`, () => [seq.createCloneAction()]);
    const after = await ids();
    const novo = [...after.entries()].find(([id]) => !before.has(id));
    if (!novo) throw new PonteError(ERR.PREMIERE, "Dupliquei, mas não achei a sequência nova.");
    const [nodeId, copy] = novo;
    const name = input.name || `${seq.name} · cópia`;
    const item = await copy.getProjectItem();
    x.tx(p, `stocker-premiere: renomear ${name}`, () => [item.createSetNameAction(name)]);
    if (input.open !== false) await p.openSequence(copy);
    let lido = null;
    try { lido = (await copy.getProjectItem()).name; } catch (e) { lido = null; }
    const res = { name, nodeId, verificado: lido === name };
    if (!res.verificado) res.diferenca = `o nome da cópia ficou '${lido}'; esperado '${name}'`;
    return res;
  }

  async function pr_saveProject() {
    const p = await x.project();
    return { salvo: await p.save(), caminho: p.path };
  }

  return { pr_importFiles, pr_createSequence, pr_duplicateSequence, pr_saveProject };
};
