"use strict";
// Projeto e trilhas: revincular mídia, cor de rótulo, renomear, mover para bin, transições, mute de trilha,
// exportar XML/OTIO da sequência. Tudo o que antes era feito clicando no Premiere.
const { alignSeconds } = require("../lib/tempo");
const { PonteError, ERR } = require("../lib/protocol");

// Nomes em português e os do Premiere (inglês), para o índice de Constants.ProjectItemColorLabel.
const CORES_PT = { violeta: "VIOLET", iris: "IRIS", caribe: "CARIBBEAN", lavanda: "LAVENDER", ceruleo: "CERULEAN", floresta: "FOREST", rosa: "ROSE", manga: "MANGO", roxo: "PURPLE", azul: "BLUE", "azul-petroleo": "TEAL", petroleo: "TEAL", magenta: "MAGENTA", bege: "TAN", verde: "GREEN", marrom: "BROWN", amarelo: "YELLOW" };
const semAcento = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

module.exports = (P) => {
  const x = require("./ppro")(P);

  function corIndex(cor) {
    if (Number.isInteger(cor)) return cor;
    const tabela = P.Constants.ProjectItemColorLabel;
    const chave = CORES_PT[semAcento(cor)] || String(cor || "").toUpperCase();
    if (tabela[chave] === undefined) throw new PonteError(ERR.BAD_INPUT, `Cor '${cor}' não existe. Use: ${Object.keys(CORES_PT).join(", ")} (ou ${Object.keys(tabela).join(", ")}).`);
    return tabela[chave];
  }
  const corNome = (i) => { const t = P.Constants.ProjectItemColorLabel; return Object.keys(t).find((k) => t[k] === i) || String(i); };

  // Itens do projeto a partir de items (nome, "Bin/Nome", {nodeId}, {mediaPath}) e/ou clips da timeline.
  async function itensDe(p, input) {
    const out = [];
    for (const ref of input.items || []) { const f = await x.findProjectItem(p, ref); out.push({ ref, item: f._item, name: f.name }); }
    if (Array.isArray(input.clips) && input.clips.length) {
      const seq = await x.sequence(p, input.sequence);
      for (const ref of input.clips) {
        const it = await x.findClip(seq, ref);
        const pi = await it.getProjectItem();
        out.push({ ref, item: pi, name: pi.name });
      }
    }
    if (!out.length) throw new PonteError(ERR.BAD_INPUT, "Passe items (do projeto) e/ou clips (da timeline).");
    return out;
  }

  async function pr_setColorLabel(input) {
    const p = await x.project();
    const idx = corIndex(input.color);
    const alvo = await itensDe(p, input);
    // um item pode aparecer várias vezes (vários clipes da mesma mídia): uma ação por item
    const unicos = [];
    const vistos = new Set();
    for (const a of alvo) { const id = await x.nodeIdOf(a.item); if (!vistos.has(id)) { vistos.add(id); unicos.push(a); } }
    x.tx(p, `stocker-premiere: cor ${corNome(idx)}`, () => unicos.map((a) => P.ProjectItem.cast(a.item).createSetColorLabelAction(idx)));
    const errados = [];
    for (const a of unicos) if ((await P.ProjectItem.cast(a.item).getColorLabelIndex()) !== idx) errados.push(a.name);
    return { cor: corNome(idx), itens: unicos.map((a) => a.name), verificado: errados.length === 0, ...(errados.length ? { diferenca: `não mudaram: ${errados.join(", ")}` } : {}), nota: "A cor é do item do projeto: vale para todos os clipes dessa mídia na timeline." };
  }

  async function pr_rename(input) {
    const nome = String(input.name || "").trim();
    if (!nome) throw new PonteError(ERR.BAD_INPUT, "name é obrigatório.");
    const p = await x.project();
    let alvo, ler, rotulo;
    if (input.renameSequence) {
      const seq = await x.sequence(p, input.renameSequence);
      if ((await p.getSequences()).some((s) => s.name === nome)) throw new PonteError(ERR.BAD_INPUT, `Já existe uma sequência '${nome}'.`);
      const pi = await seq.getProjectItem();
      alvo = () => pi.createSetNameAction(nome); ler = async () => (await seq.getProjectItem()).name; rotulo = `sequência ${seq.name}`;
    } else if (input.item) {
      const f = await x.findProjectItem(p, input.item);
      alvo = () => f._item.createSetNameAction(nome); ler = async () => (await x.findProjectItem(p, { nodeId: f.nodeId }))._item.name; rotulo = `item ${f.name}`;
      x.invalidateIndex();
    } else if (input.bin) {
      const partes = String(input.bin).split("/").filter(Boolean);
      const pai = partes.length > 1 ? await binDe(p, partes.slice(0, -1).join("/")) : await p.getRootItem();
      const bin = pai && (await pai.getItems()).find((k) => k.type === P.ProjectItem.TYPE_BIN && k.name === partes[partes.length - 1]);
      if (!bin) throw new PonteError(ERR.NOT_FOUND, `Bin '${input.bin}' não encontrado.`);
      alvo = () => bin.createSetNameAction(nome); ler = async () => ((await pai.getItems()).find((k) => k.type === P.ProjectItem.TYPE_BIN && k.name === nome) ? nome : null); rotulo = `bin ${input.bin}`;
      x.invalidateIndex();
    } else if (input.clip) {
      const seq = await x.sequence(p, input.sequence);
      const it = await x.findClip(seq, input.clip);
      alvo = () => it.createSetNameAction(nome); ler = async () => await it.getName(); rotulo = `clipe ${await it.getName()}`;
    } else if (input.track) {
      const seq = await x.sequence(p, input.sequence);
      const t = x.parseTrack(input.track);
      const tr = t.kind === "V" ? await seq.getVideoTrack(t.index) : await seq.getAudioTrack(t.index);
      alvo = () => tr.createSetNameAction(nome); ler = async () => nome; rotulo = `trilha ${input.track}`;
    } else throw new PonteError(ERR.BAD_INPUT, "Diga o que renomear: renameSequence, item, bin, clip ou track.");
    x.tx(p, `stocker-premiere: renomear ${rotulo}`, () => [alvo()]);
    const lido = await ler();
    return { renomeado: rotulo, para: nome, verificado: lido === nome, ...(lido !== nome ? { diferenca: `ficou '${lido}'` } : {}) };
  }

  async function binDe(p, binPath) {
    let folder = await p.getRootItem();
    for (const name of String(binPath).split("/").filter(Boolean)) {
      const child = (await folder.getItems()).find((k) => k.type === P.ProjectItem.TYPE_BIN && k.name === name);
      if (!child) return null;
      folder = P.FolderItem.cast(child);
    }
    return folder;
  }

  async function garantirBin(p, binPath) {
    let folder = await p.getRootItem();
    for (const name of String(binPath).split("/").filter(Boolean)) {
      const achar = async () => (await folder.getItems()).find((k) => k.type === P.ProjectItem.TYPE_BIN && k.name === name);
      let child = await achar();
      if (!child) {
        const pai = folder;
        x.tx(p, `stocker-premiere: criar bin ${name}`, () => [pai.createBinAction(name, false)]);
        child = await achar();
        if (!child) throw new PonteError(ERR.PREMIERE, `Criei o bin '${name}', mas ele não apareceu.`);
      }
      folder = P.FolderItem.cast(child);
    }
    return folder;
  }

  async function pr_moveToBin(input) {
    if (!input.bin) throw new PonteError(ERR.BAD_INPUT, "bin é obrigatório (caminho, criado se faltar).");
    const p = await x.project();
    const alvo = [];
    for (const ref of input.items || []) { const f = await x.findProjectItem(p, ref); alvo.push(f); }
    for (const nome of input.sequences || []) { const s = await x.sequence(p, nome); const pi = await s.getProjectItem(); alvo.push({ _item: pi, name: s.name, nodeId: await x.nodeIdOf(pi) }); }
    if (!alvo.length) throw new PonteError(ERR.BAD_INPUT, "Passe items e/ou sequences.");
    const destino = await garantirBin(p, input.bin);
    x.invalidateIndex();
    x.tx(p, `stocker-premiere: mover para ${input.bin}`, () => alvo.map((a) => destino.createMoveItemAction(a._item, destino)));
    const ids = new Set();
    for (const k of await destino.getItems()) ids.add(await x.nodeIdOf(k));
    const fora = alvo.filter((a) => !ids.has(String(a.nodeId))).map((a) => a.name);
    return { bin: input.bin, movidos: alvo.map((a) => a.name), verificado: fora.length === 0, ...(fora.length ? { diferenca: `não chegaram: ${fora.join(", ")}` } : {}) };
  }

  // Revincular: para cada item, troca o caminho da mídia. mapping {de: para} por item, ou fromDir/toDir para
  // trocar o começo do caminho em todos os itens que estão naquela pasta (os 67 HUDs de uma vez).
  async function pr_relinkMedia(input) {
    const p = await x.project();
    const pares = [];
    if (input.fromDir && input.toDir) {
      const de = String(input.fromDir).replace(/\/+$/, "") + "/";
      const para = String(input.toDir).replace(/\/+$/, "") + "/";
      const todos = [];
      await x.walkItems(await p.getRootItem(), "", todos, 0, 20, true);
      for (const i of todos) if (i.type === "clip" && i.mediaPath && i.mediaPath.normalize("NFC").startsWith(de.normalize("NFC"))) pares.push({ item: i._item, name: i.name, de: i.mediaPath, para: para + i.mediaPath.normalize("NFC").slice(de.normalize("NFC").length) });
    }
    for (const m of input.items || []) {
      const f = await x.findProjectItem(p, m.item);
      pares.push({ item: f._item, name: f.name, de: f.mediaPath, para: m.path });
    }
    if (!pares.length) throw new PonteError(ERR.BAD_INPUT, "Nada para revincular: passe fromDir+toDir ou items:[{item, path}].");
    const resultados = [];
    for (const r of pares) {
      if (input.dryRun) { resultados.push({ name: r.name, de: r.de, para: r.para }); continue; }
      const clip = P.ClipProjectItem.cast(r.item);
      let ok = false, erro;
      try {
        if (!(await clip.canChangeMediaPath())) throw new Error("o Premiere não deixa trocar o caminho deste item");
        ok = await clip.changeMediaFilePath(r.para, !!input.ignorarCompatibilidade);
      } catch (e) { erro = String((e && e.message) || e); }
      let lido = null;
      try { lido = await clip.getMediaFilePath(); } catch (e) { lido = null; }
      const certo = !!lido && lido.normalize("NFC") === String(r.para).normalize("NFC");
      resultados.push({ name: r.name, para: r.para, verificado: certo, ...(certo ? {} : { lido, erro: erro || (ok === false ? "changeMediaFilePath devolveu false (arquivo inexistente ou incompatível?)" : undefined) }) });
    }
    x.invalidateIndex();
    return { total: pares.length, simulacao: !!input.dryRun, resultados, verificado: !!input.dryRun || resultados.every((r) => r.verificado) };
  }

  async function pr_addTransition(input) {
    const refs = input.clips || [];
    if (!refs.length) throw new PonteError(ERR.BAD_INPUT, "clips é obrigatório.");
    const p = await x.project();
    const seq = await x.sequence(p, input.sequence);
    const tb = await seq.getTimebase();
    const nomes = await P.TransitionFactory.getVideoTransitionMatchNames();
    const want = String(input.transition || "ADBE Cross Dissolve New");
    const mn = nomes.find((n) => n === want) || nomes.find((n) => n.toLowerCase().includes(want.toLowerCase()));
    if (!mn) throw new PonteError(ERR.NOT_FOUND, `Transição '${want}' não encontrada. Algumas: ${nomes.slice(0, 15).join(", ")}`);
    const dur = Number(input.duration ?? 0.5);
    const onde = input.position || "end";
    const resultados = [];
    for (const ref of refs) {
      if (x.parseTrack(ref.track).kind !== "V") throw new PonteError(ERR.BAD_INPUT, "Transição pela ponte só em clipes de vídeo (a API não tem transição de áudio).");
      const it = await x.findClip(seq, ref);
      const tr = await P.TransitionFactory.createVideoTransition(mn);
      const posicoes = onde === "both" ? ["start", "end"] : [onde];
      for (const pos of posicoes) {
        const opt = new P.AddTransitionOptions();
        opt.setApplyToStart(pos === "start");
        opt.setDuration(x.tickAligned(alignSeconds(dur, tb), tb));
        if (input.alignment !== undefined) opt.setTransitionAlignment(Number(input.alignment));
        const trx = pos === "start" ? tr : await P.TransitionFactory.createVideoTransition(mn);
        x.tx(p, `stocker-premiere: transição ${mn}`, () => [it.createAddVideoTransitionAction(trx, opt)]);
      }
      resultados.push({ clip: ref, name: await it.getName(), transicao: mn, posicao: onde, duracao: dur });
    }
    return { resultados, nota: "A API não relê transições: confira com pr_exportFrame no ponto do corte." };
  }

  async function pr_setTrackMute(input) {
    const p = await x.project();
    const seq = await x.sequence(p, input.sequence);
    const labels = String(input.tracks || "").split(/[\s,]+/).filter(Boolean);
    if (!labels.length || typeof input.muted !== "boolean") throw new PonteError(ERR.BAD_INPUT, "tracks (\"A3,V2\") e muted (true/false) são obrigatórios.");
    const res = [];
    for (const l of labels) {
      const t = x.parseTrack(l);
      const tr = t.kind === "V" ? await seq.getVideoTrack(t.index) : await seq.getAudioTrack(t.index);
      await tr.setMute(input.muted);
      res.push({ track: l, muted: await tr.isMuted() });
    }
    return { trilhas: res, verificado: res.every((r) => r.muted === input.muted), nota: "Em trilha de vídeo, mute = olho desligado." };
  }

  async function pr_exportTimeline(input) {
    if (!input.outputPath || !/^\//.test(input.outputPath)) throw new PonteError(ERR.BAD_INPUT, "outputPath (absoluto) é obrigatório.");
    const p = await x.project();
    const seq = await x.sequence(p, input.sequence);
    const formato = input.format || (/\.otio$/i.test(input.outputPath) ? "otio" : "fcpxml");
    let ok;
    if (formato === "otio") ok = await P.ProjectConverter.exportAsOpenTimelineIO(seq, input.outputPath);
    else ok = await P.ProjectConverter.exportAsFinalCutProXML(seq, input.outputPath);
    return { formato, outputPath: input.outputPath, ok };
  }

  async function pr_listTransitions(input) {
    const q = String(input.query || "").toLowerCase();
    return { transicoes: (await P.TransitionFactory.getVideoTransitionMatchNames()).filter((n) => !q || n.toLowerCase().includes(q)) };
  }

  // Lê as trilhas de legenda: tempos e o que a API mostra de cada item (o texto não é exposto no 27.1).
  async function pr_getCaptions(input) {
    const p = await x.project();
    const seq = await x.sequence(p, input.sequence);
    const n = await seq.getCaptionTrackCount();
    const trilhas = [];
    const max = input.maxItems ?? 20;
    for (let i = 0; i < n; i++) {
      const tr = await seq.getCaptionTrack(i);
      let itens = [];
      try { itens = await tr.getTrackItems(P.Constants.TrackItemType.CLIP, false); } catch (e) { itens = []; }
      const lista = [];
      for (const it of itens.slice(0, max)) {
        const d = {};
        for (const m of ["getName", "getStartTime", "getEndTime", "getMatchName", "getType"]) { try { const v = await it[m](); d[m] = v && v.ticksNumber !== undefined ? x.sec(v) : v; } catch (e) { d[m] = `erro: ${(e && e.message) || e}`; } }
        try { d.classe = Object.getPrototypeOf(it).constructor.name; } catch (e) { d.classe = "?"; }
        lista.push(d);
      }
      trilhas.push({ track: `C${i + 1}`, muted: await tr.isMuted(), total: itens.length, itens: lista });
    }
    return { sequencia: seq.name, trilhas };
  }

  return { pr_setColorLabel, pr_getCaptions, pr_rename, pr_moveToBin, pr_relinkMedia, pr_addTransition, pr_setTrackMute, pr_exportTimeline, pr_listTransitions };
};
