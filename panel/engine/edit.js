"use strict";
// Edição de timeline que antes era feita pela tela: aparar, cortar (razor), remover com ou sem ondulação,
// extrair/levantar um trecho em várias trilhas, deslocar clipes, abrir sequência, agulha e In/Out.
const { parseTime, alignSeconds, fpsFromTimebase, secondsToTicks, alignTicksToFrame } = require("../lib/tempo");
const { PonteError, ERR } = require("../lib/protocol");

const EPS = 1e-6;

module.exports = (P) => {
  const x = require("./ppro")(P);
  const VIDEO = () => P.Constants.MediaType.VIDEO;
  const AUDIO = () => P.Constants.MediaType.AUDIO;

  async function ctx(input) {
    const p = await x.project();
    const seq = await x.sequence(p, input.sequence);
    const tb = await seq.getTimebase();
    return { p, seq, tb, frame: 1 / fpsFromTimebase(tb) };
  }
  const tt = (sec, tb) => x.tickAligned(sec, tb);
  const delta = (sec, tb) => P.TickTime.createWithTicks(String(alignTicksToFrame(secondsToTicks(sec), tb)));

  async function info(it) {
    return { name: await it.getName(), start: x.sec(await it.getStartTime()), end: x.sec(await it.getEndTime()), sourceIn: x.sec(await it.getInPoint()), sourceOut: x.sec(await it.getOutPoint()) };
  }

  // Lista de rótulos de trilha a partir de "all" | "video" | "audio" | "V1,A2".
  async function trackLabels(seq, spec) {
    const want = String(spec || "all");
    const nv = await seq.getVideoTrackCount();
    const na = await seq.getAudioTrackCount();
    const todos = [...Array.from({ length: nv }, (_, i) => `V${i + 1}`), ...Array.from({ length: na }, (_, i) => `A${i + 1}`)];
    if (want === "all") return todos;
    if (want === "video") return todos.filter((l) => l[0] === "V");
    if (want === "audio") return todos.filter((l) => l[0] === "A");
    return want.split(/[\s,]+/).filter(Boolean).map((l) => { const t = x.parseTrack(l); return `${t.kind}${t.index + 1}`; });
  }

  // Apara um clipe: start/end na timeline (segundos) mexem na borda e no ponto da fonte junto, como o
  // trim do Premiere; sourceIn/sourceOut mudam só a fonte. Tudo numa transação.
  // No Premiere 27.1 a borda e o ponto da fonte andam juntos: setStart também move o In da fonte, e
  // setInPoint também move o início (medido ao vivo em 27/11/2026). Então aparar é um primitivo só por borda.
  async function trimActions(it, want, tb) {
    const acts = [];
    if (want.start !== undefined) acts.push(() => it.createSetStartAction(tt(want.start, tb)));
    if (want.end !== undefined) acts.push(() => it.createSetEndAction(tt(want.end, tb)));
    if (want.sourceIn !== undefined) acts.push(() => it.createSetInPointAction(tt(want.sourceIn, tb)));
    if (want.sourceOut !== undefined) acts.push(() => it.createSetOutPointAction(tt(want.sourceOut, tb)));
    return acts;
  }

  async function pr_trimClip(input) {
    const { p, seq, tb, frame } = await ctx(input);
    if (!input.clip) throw new PonteError(ERR.BAD_INPUT, "clip é obrigatório ({track, clip} ou {track, time}).");
    const it = await x.findClip(seq, input.clip);
    const antes = await info(it);
    const want = {};
    for (const k of ["start", "end", "sourceIn", "sourceOut"]) if (input[k] !== undefined) want[k] = alignSeconds(parseTime(input[k], tb), tb);
    if (!Object.keys(want).length) throw new PonteError(ERR.BAD_INPUT, "Passe start, end, sourceIn ou sourceOut.");
    if (input.raw) {
      // Modo de diagnóstico: aplica cada primitivo cru, sem compensar a fonte.
      x.tx(p, "stocker-premiere: aparar (cru)", () => {
        const a = [];
        if (want.start !== undefined) a.push(it.createSetStartAction(tt(want.start, tb)));
        if (want.end !== undefined) a.push(it.createSetEndAction(tt(want.end, tb)));
        if (want.sourceIn !== undefined) a.push(it.createSetInPointAction(tt(want.sourceIn, tb)));
        if (want.sourceOut !== undefined) a.push(it.createSetOutPointAction(tt(want.sourceOut, tb)));
        return a;
      });
    } else {
      const acts = await trimActions(it, want, tb);
      x.tx(p, `stocker-premiere: aparar ${antes.name}`, () => acts.map((f) => f()));
    }
    const depois = await info(it);
    const diffs = [];
    for (const k of Object.keys(want)) if (Math.abs(depois[k] - want[k]) > frame / 2) diffs.push(`${k} ficou ${depois[k]} (pedido ${want[k]})`);
    return { antes, depois, verificado: diffs.length === 0, ...(diffs.length ? { diferenca: diffs.join("; ") } : {}) };
  }

  // Trilha do mesmo tipo livre em [ini, fim), diferente de `label`.
  async function trilhaLivre(seq, label, ini, fim, frame) {
    const kind = label[0];
    const n = kind === "V" ? await seq.getVideoTrackCount() : await seq.getAudioTrackCount();
    const atual = Number(label.slice(1));
    const ordem = Array.from({ length: n }, (_, i) => i + 1).filter((i) => i !== atual).sort((a, b) => Math.abs(a - atual) - Math.abs(b - atual));
    for (const i of ordem) {
      const l = `${kind}${i}`;
      if (!(await x.itemsInRange(await x.trackItems(seq, l), ini + frame / 2, fim - frame / 2)).length) return l;
    }
    return null;
  }

  // Divide um clipe em `t` sem perder efeitos, volume nem keyframes. Uma trilha não aceita clipes sobrepostos
  // (o clone no mesmo lugar sobrescreve o original), então: clona numa trilha livre do mesmo tipo, apara o
  // original até t e o clone a partir de t, e traz o clone de volta para a trilha original.
  async function splitAt(p, seq, label, it, t, tb, frame) {
    const cur = await info(it);
    if (t <= cur.start + frame / 2 || t >= cur.end - frame / 2) return null;
    const kind = label[0];
    const livre = await trilhaLivre(seq, label, cur.start, cur.end, frame);
    if (!livre) throw new PonteError(ERR.PREMIERE, `Para cortar ${cur.name} em ${t}s preciso de uma trilha ${kind === "V" ? "de vídeo" : "de áudio"} livre entre ${cur.start}s e ${cur.end}s. Adicione uma trilha vazia no Premiere.`);
    const dv = Number(livre.slice(1)) - Number(label.slice(1));
    await x.cloneItem(p, seq, it, { kind, video: kind === "V" ? dv : 0, audio: kind === "A" ? dv : 0, label: `stocker-premiere: cortar ${cur.name}` });
    const copia = (await x.itemsStartingAt(await x.trackItems(seq, livre), cur.start, frame))[0];
    if (!copia) throw new PonteError(ERR.PREMIERE, `A cópia de ${cur.name} não apareceu em ${livre}.`);
    const c = copia.it;
    x.tx(p, `stocker-premiere: aparar as metades de ${cur.name}`, () => [it.createSetEndAction(tt(t, tb)), c.createSetStartAction(tt(t, tb))]);
    await x.cloneItem(p, seq, c, { kind, video: kind === "V" ? -dv : 0, audio: kind === "A" ? -dv : 0, label: `stocker-premiere: devolver a metade de ${cur.name}` });
    const volta = (await x.itemsStartingAt(await x.trackItems(seq, label), t, frame))[0];
    if (!volta) throw new PonteError(ERR.PREMIERE, `A segunda metade de ${cur.name} ficou em ${livre} (não voltou para ${label}).`);
    const sobra = (await x.itemsStartingAt(await x.trackItems(seq, livre), t, frame))[0];
    if (sobra) await removeItems(p, seq, [sobra.it], kind, false, `stocker-premiere: limpar ${livre}`);
    const primeira = (await x.itemsStartingAt(await x.trackItems(seq, label), cur.start, frame))[0];
    return { original: await info(primeira ? primeira.it : it), novo: await info(volta.it), via: livre };
  }

  async function pr_razor(input) {
    const { p, seq, tb, frame } = await ctx(input);
    const t = alignSeconds(parseTime(input.time, tb), tb);
    const labels = await trackLabels(seq, input.tracks);
    const cortes = [];
    for (const label of labels) {
      for (const { it } of await x.itemsInRange(await x.trackItems(seq, label), t - EPS, t + EPS)) {
        const r = await splitAt(p, seq, label, it, t, tb, frame);
        if (r) cortes.push({ track: label, ...r });
      }
    }
    const ok = cortes.every((c) => Math.abs(c.original.end - t) <= frame / 2 && Math.abs(c.novo.start - t) <= frame / 2 && Math.abs(c.novo.sourceIn - c.original.sourceOut) <= frame / 2);
    return { time: t, cortes, verificado: ok };
  }

  async function removeItems(p, seq, items, kind, ripple, label) {
    if (!items.length) return;
    const editor = P.SequenceEditor.getEditor(seq);
    try {
      const sel = await x.newSelection(seq, items);
      x.tx(p, label, () => [editor.createRemoveItemsAction(sel, !!ripple, kind === "A" ? AUDIO() : VIDEO(), false)]);
    } finally { try { await seq.clearSelection(); } catch (e) { /* sem seleção */ } }
  }

  async function pr_removeClips(input) {
    const refs = input.clips || [];
    if (!refs.length) throw new PonteError(ERR.BAD_INPUT, "clips é obrigatório.");
    const { p, seq, tb, frame } = await ctx(input);
    const alvo = [];
    for (const ref of refs) {
      const it = await x.findClip(seq, ref);
      const t = x.parseTrack(ref.track);
      alvo.push({ ref, it, label: `${t.kind}${t.index + 1}`, ...(await info(it)) });
    }
    for (const kind of ["V", "A"]) await removeItems(p, seq, alvo.filter((a) => a.label[0] === kind).map((a) => a.it), kind, false, `stocker-premiere: remover clipes`);
    // ripple: fecha o vão só na trilha de cada clipe, do fim para o começo (para não somar deslocamentos errados).
    let puxados = 0;
    if (input.ripple) {
      for (const a of [...alvo].sort((u, v) => v.start - u.start)) {
        const depois = (await x.itemsInRange(await x.trackItems(seq, a.label), a.end - frame / 2, Infinity)).filter((r) => r.start >= a.end - frame / 2);
        if (!depois.length) continue;
        const d = a.end - a.start;
        x.tx(p, `stocker-premiere: fechar o vão em ${a.label}`, () => depois.map((r) => r.it.createMoveAction(delta(-d, tb))));
        puxados += depois.length;
      }
    }
    const sobrou = [];
    for (const a of alvo) for (const r of await x.itemsStartingAt(await x.trackItems(seq, a.label), a.start, frame)) if (!input.ripple && (await r.it.getName()) === a.name) sobrou.push(`${a.label} ${a.name}`);
    return { removidos: alvo.map((a) => ({ clip: a.ref, track: a.label, name: a.name, start: a.start, end: a.end })), ripple: !!input.ripple, puxados, verificado: sobrou.length === 0, ...(sobrou.length ? { diferenca: `continuam na timeline: ${sobrou.join(", ")}` } : {}) };
  }

  // Desloca clipes no tempo (offset em segundos, + para a direita).
  async function pr_shiftClips(input) {
    const refs = input.clips || [];
    if (!refs.length || typeof input.offset !== "number") throw new PonteError(ERR.BAD_INPUT, "clips e offset (segundos) são obrigatórios.");
    const { p, seq, tb, frame } = await ctx(input);
    const alvo = [];
    for (const ref of refs) { const it = await x.findClip(seq, ref); alvo.push({ ref, it, antes: await info(it) }); }
    x.tx(p, `stocker-premiere: deslocar ${alvo.length} clipe(s)`, () => alvo.map((a) => a.it.createMoveAction(delta(input.offset, tb))));
    const resultados = [];
    for (const a of alvo) {
      const depois = await info(a.it);
      resultados.push({ clip: a.ref, name: a.antes.name, start: depois.start, verificado: Math.abs(depois.start - (a.antes.start + input.offset)) <= frame / 2 });
    }
    return { resultados, verificado: resultados.every((r) => r.verificado) };
  }

  // Extrair (ripple, fecha o vão) ou Levantar (deixa lacuna) o trecho [from, to) nas trilhas pedidas.
  async function pr_removeRange(input) {
    const { p, seq, tb, frame } = await ctx(input);
    const from = alignSeconds(parseTime(input.from, tb), tb);
    const to = alignSeconds(parseTime(input.to, tb), tb);
    if (!(to - from >= frame / 2)) throw new PonteError(ERR.BAD_INPUT, "to precisa ser maior que from.");
    const ripple = input.ripple !== false;
    const labels = await trackLabels(seq, input.tracks || "all");
    const dur = to - from;
    const dur0 = x.sec(await seq.getEndTime());
    const relatorio = [];
    for (const label of labels) {
      const kind = label[0];
      // 1) corta nas bordas
      for (const t of [from, to]) {
        for (const { it } of await x.itemsInRange(await x.trackItems(seq, label), t - EPS, t + EPS)) await splitAt(p, seq, label, it, t, tb, frame);
      }
      // 2) remove o que ficou dentro
      const dentro = (await x.itemsInRange(await x.trackItems(seq, label), from + frame / 2, to - frame / 2)).filter((r) => r.start >= from - frame / 2 && r.end <= to + frame / 2);
      const nomes = [];
      for (const r of dentro) nomes.push(await r.it.getName());
      await removeItems(p, seq, dentro.map((r) => r.it), kind, false, `stocker-premiere: tirar o trecho de ${label}`);
      // 3) fecha o vão: puxa tudo que começa depois de `to`
      let movidos = 0;
      if (ripple) {
        const depois = (await x.itemsInRange(await x.trackItems(seq, label), to - frame / 2, Infinity)).filter((r) => r.start >= to - frame / 2);
        if (depois.length) {
          x.tx(p, `stocker-premiere: fechar o vão em ${label}`, () => depois.map((r) => r.it.createMoveAction(delta(-dur, tb))));
          movidos = depois.length;
        }
      }
      if (nomes.length || movidos) relatorio.push({ track: label, removidos: nomes, puxados: movidos });
    }
    // Marcadores depois do trecho acompanham (só em extrair, e só se pedir em todas as trilhas)
    let marcadores = 0;
    if (ripple && input.moveMarkers !== false) {
      const mk = await P.Markers.getMarkers(seq);
      const mover = [];
      for (const m of await mk.getMarkers([])) { const s = x.sec(await m.getStart()); if (s >= to - frame / 2) mover.push([m, s]); }
      if (mover.length) {
        x.tx(p, "stocker-premiere: mover marcadores", () => mover.map(([m, s]) => mk.createMoveMarkerAction(m, tt(s - dur, tb))));
        marcadores = mover.length;
      }
    }
    const dur1 = x.sec(await seq.getEndTime());
    // Confere: nada mais começa dentro do trecho que foi tirado (no levantar) e a sequência encurtou (no extrair).
    const diffs = [];
    if (ripple && labels.length && Math.abs((dur0 - dur1) - dur) > frame && dur0 > to) diffs.push(`a sequência encurtou ${Math.round((dur0 - dur1) * 1000) / 1000}s; esperado ${Math.round(dur * 1000) / 1000}s`);
    if (!ripple) {
      for (const label of labels) {
        const sobra = await x.itemsInRange(await x.trackItems(seq, label), from + frame / 2, to - frame / 2);
        if (sobra.length) diffs.push(`${label} ainda tem ${sobra.length} clipe(s) no trecho`);
      }
    }
    return { from, to, duracao: Math.round(dur * 1000) / 1000, modo: ripple ? "extrair" : "levantar", trilhas: relatorio, marcadoresMovidos: marcadores, duracaoAntes: dur0, duracaoDepois: dur1, verificado: diffs.length === 0, ...(diffs.length ? { diferenca: diffs.join("; ") } : {}) };
  }

  async function pr_openSequence(input) {
    if (!input.sequence) throw new PonteError(ERR.BAD_INPUT, "sequence é obrigatório.");
    const p = await x.project();
    const seq = await x.sequence(p, input.sequence);
    const ok = await p.openSequence(seq);
    try { await p.setActiveSequence(seq); } catch (e) { /* já ativa */ }
    const ativa = await p.getActiveSequence();
    return { aberta: ok !== false, ativa: ativa ? ativa.name : null, verificado: !!ativa && ativa.name === seq.name };
  }

  async function pr_closeSequence(input) {
    if (!input.sequence) throw new PonteError(ERR.BAD_INPUT, "sequence é obrigatório.");
    const p = await x.project();
    const seq = await x.sequence(p, input.sequence);
    return { fechada: await p.closeSequence(seq) };
  }

  async function pr_setPlayhead(input) {
    const { seq, tb, frame } = await ctx(input);
    const t = alignSeconds(parseTime(input.time, tb), tb);
    await seq.setPlayerPosition(tt(t, tb));
    const lido = x.sec(await seq.getPlayerPosition());
    return { playhead: lido, verificado: Math.abs(lido - t) <= frame / 2 };
  }

  async function pr_setSequenceInOut(input) {
    const { p, seq, tb, frame } = await ctx(input);
    if (input.in === undefined && input.out === undefined) throw new PonteError(ERR.BAD_INPUT, "Passe in e/ou out.");
    const tIn = input.in !== undefined ? alignSeconds(parseTime(input.in, tb), tb) : null;
    const tOut = input.out !== undefined ? alignSeconds(parseTime(input.out, tb), tb) : null;
    x.tx(p, "stocker-premiere: In/Out da sequência", () => {
      const acts = [];
      if (tIn !== null) acts.push(seq.createSetInPointAction(tt(tIn, tb)));
      if (tOut !== null) acts.push(seq.createSetOutPointAction(tt(tOut, tb)));
      return acts;
    });
    const lidoIn = x.sec(await seq.getInPoint());
    const lidoOut = x.sec(await seq.getOutPoint());
    const ok = (input.in === undefined || Math.abs(lidoIn - parseTime(input.in, tb)) <= frame) && (input.out === undefined || Math.abs(lidoOut - parseTime(input.out, tb)) <= frame);
    return { in: lidoIn, out: lidoOut, verificado: ok };
  }

  return { pr_trimClip, pr_razor, pr_removeClips, pr_shiftClips, pr_removeRange, pr_openSequence, pr_closeSequence, pr_setPlayhead, pr_setSequenceInOut };
};
