// Stocker Premiere ES: funções ExtendScript (ES3) chamadas pelo painel CEP via spCall(nome, argsJSON).
// Cobre o que a API UXP do Premiere 27.1 não tem: desfazer, trilhas, legenda por SRT, unlink, MOGRT.
// SP fica no global: recarregar o arquivo (SP.reload) atualiza as funções sem reabrir o painel.
$.global.SP = $.global.SP || {};
var SP = $.global.SP;
var HOST_FILE = $.fileName;
var TICKS = 254016000000;

function _str(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t").replace(/[\x00-\x1f]/g, " ") + '"';
}
function _j(v) {
  if (v === null || v === undefined) return "null";
  var t = typeof v;
  if (t === "number") return isFinite(v) ? String(v) : "null";
  if (t === "boolean") return v ? "true" : "false";
  if (t === "string") return _str(v);
  if (v instanceof Array) { var a = []; for (var i = 0; i < v.length; i++) a.push(_j(v[i])); return "[" + a.join(",") + "]"; }
  if (t === "object") { var o = []; for (var k in v) if (v.hasOwnProperty(k)) o.push(_str(k) + ":" + _j(v[k])); return "{" + o.join(",") + "}"; }
  return _str(String(v));
}
function _parse(s) { if (!s) return {}; return eval("(" + s + ")"); }
function _r3(n) { return Math.round(n * 1000) / 1000; }

function _seq(name) {
  if (!name) { if (!app.project.activeSequence) throw new Error("Não há sequência ativa."); return app.project.activeSequence; }
  var achou = [];
  for (var i = 0; i < app.project.sequences.numSequences; i++) if (app.project.sequences[i].name === name) achou.push(app.project.sequences[i]);
  if (!achou.length) throw new Error("Sequência '" + name + "' não encontrada.");
  if (achou.length > 1) throw new Error("Há " + achou.length + " sequências chamadas '" + name + "'.");
  return achou[0];
}
function _track(seq, label) {
  var m = /^([VA])(\d+)$/i.exec(String(label || ""));
  if (!m) throw new Error("Trilha inválida '" + label + "'. Use V1, A2…");
  var kind = m[1].toUpperCase(), idx = Number(m[2]) - 1;
  var col = kind === "V" ? seq.videoTracks : seq.audioTracks;
  if (idx >= col.numTracks) throw new Error("A sequência tem " + col.numTracks + " trilha(s) " + (kind === "V" ? "de vídeo" : "de áudio") + ".");
  return { kind: kind, idx: idx, track: col[idx] };
}
function _clip(seq, ref) {
  var t = _track(seq, ref.track);
  var n = Number(ref.clip);
  if (!(n >= 1) || n > t.track.clips.numItems) throw new Error(ref.track + " tem " + t.track.clips.numItems + " clipe(s); não existe o clipe " + ref.clip + ".");
  return t.track.clips[n - 1];
}
function _counts(seq) { return { video: seq.videoTracks.numTracks, audio: seq.audioTracks.numTracks }; }
// QE age na sequência ativa: ativa a pedida e devolve a anterior no fim.
function _qe(seq, fn) {
  app.enableQE();
  var prev = app.project.activeSequence;
  var trocou = !prev || prev.sequenceID !== seq.sequenceID;
  if (trocou) app.project.activeSequence = seq;
  try { return fn(qe.project.getActiveSequence()); }
  finally { if (trocou && prev) app.project.activeSequence = prev; }
}

$.global.spCall = spCall;
function spCall(nome, argsJson) {
  try {
    if (!SP.hasOwnProperty(nome)) throw new Error("Função ES desconhecida: " + nome);
    return _j({ ok: true, data: SP[nome](_parse(argsJson)) });
  } catch (e) {
    return _j({ ok: false, error: String(e && e.message ? e.message : e) + (e && e.line ? " (linha " + e.line + ")" : "") });
  }
}

SP.status = function () {
  var s = app.project.activeSequence;
  var qeOk = false;
  try { app.enableQE(); qeOk = !!qe.project; } catch (e) { qeOk = false; }
  return { premiere: app.version, projeto: app.project.name, sequenciaAtiva: s ? s.name : null, qe: qeOk };
};

function _undoIdx() { try { var v = qe.project.undoStackIndex; return typeof v === "function" ? qe.project.undoStackIndex() : v; } catch (e) { return null; } }
SP.undo = function (a) {
  app.enableQE();
  var n = Number(a.n || 1), antes = _undoIdx();
  for (var i = 0; i < n; i++) qe.project.undo();
  return { passos: n, antes: antes, depois: _undoIdx() };
};
SP.redo = function (a) {
  app.enableQE();
  var n = Number(a.n || 1), antes = _undoIdx();
  for (var i = 0; i < n; i++) qe.project.redo();
  return { passos: n, antes: antes, depois: _undoIdx() };
};
SP.reload = function () {
  var f = new File(HOST_FILE);
  if (!f.exists) throw new Error("host.jsx não encontrado em " + HOST_FILE);
  $.evalFile(f);
  var fns = [];
  for (var k in $.global.SP) fns.push(k);
  return { recarregado: f.fsName, funcoes: fns };
};

SP.addTracks = function (a) {
  var seq = _seq(a.sequence), antes = _counts(seq);
  var nv = Number(a.video || 0), na = Number(a.audio || 0);
  if (!nv && !na) throw new Error("Passe video e/ou audio (quantas trilhas).");
  _qe(seq, function (q) {
    // (vídeos, inserir depois da V índice, áudios, tipo de áudio 1 = estéreo, depois da A índice, submix 0…)
    q.addTracks(nv, antes.video, na, 1, antes.audio, 0, 0, 0);
  });
  var depois = _counts(seq);
  return { antes: antes, depois: depois, verificado: depois.video === antes.video + nv && depois.audio === antes.audio + na };
};

SP.removeTrack = function (a) {
  var seq = _seq(a.sequence), t = _track(seq, a.track), antes = _counts(seq);
  if (t.track.clips.numItems > 0) throw new Error(a.track + " tem " + t.track.clips.numItems + " clipe(s). Só tiro trilha vazia.");
  _qe(seq, function (q) { if (t.kind === "V") q.removeVideoTrack(t.idx); else q.removeAudioTrack(t.idx); });
  var depois = _counts(seq);
  return { antes: antes, depois: depois, verificado: (t.kind === "V" ? depois.video : depois.audio) === (t.kind === "V" ? antes.video : antes.audio) - 1 };
};

function _itemPorCaminho(caminho) {
  var alvo = String(caminho);
  function busca(bin) {
    for (var i = 0; i < bin.children.numItems; i++) {
      var it = bin.children[i];
      if (it.type === ProjectItemType.BIN) { var r = busca(it); if (r) return r; continue; }
      try { if (it.getMediaPath && it.getMediaPath() === alvo) return it; } catch (e) {}
    }
    return null;
  }
  return busca(app.project.rootItem);
}

SP.importCaptions = function (a) {
  var seq = _seq(a.sequence);
  if (!a.srt) throw new Error("srt (caminho absoluto do arquivo) é obrigatório.");
  var f = new File(a.srt);
  if (!f.exists) throw new Error("Arquivo não existe: " + a.srt);
  var item = _itemPorCaminho(f.fsName);
  if (!item) {
    app.project.importFiles([f.fsName], true, app.project.getInsertionBin(), false);
    item = _itemPorCaminho(f.fsName);
  }
  if (!item) throw new Error("Importei o SRT, mas não achei o item no projeto.");
  var formato = a.formato === "608" ? Sequence.CAPTION_FORMAT_608 : (a.formato === "708" ? Sequence.CAPTION_FORMAT_708 : Sequence.CAPTION_FORMAT_SUBTITLE);
  var ok = seq.createCaptionTrack(item, Number(a.start || 0), formato);
  return { item: item.name, criada: ok !== false, nota: "Confira com pr_getCaptions (a trilha nova aparece como C1, C2…)." };
};

// Seleção e (des)vinculação só valem na sequência ativa: ativa a pedida e devolve a anterior no fim.
function _naAtiva(seq, fn) {
  var prev = app.project.activeSequence;
  var trocou = !prev || prev.sequenceID !== seq.sequenceID;
  if (trocou) app.project.activeSequence = seq;
  try {
    var sel = seq.getSelection();
    for (var i = 0; i < sel.length; i++) sel[i].setSelected(false, true);
    return fn();
  } finally {
    var z = seq.getSelection();
    for (var k = 0; k < z.length; k++) z[k].setSelected(false, true);
    if (trocou && prev) app.project.activeSequence = prev;
  }
}
function _nVinculados(c) { var l = c.getLinkedItems(); return l ? l.numItems : 0; }

SP.unlink = function (a) {
  var seq = _seq(a.sequence);
  if (!a.clips || !a.clips.length) throw new Error("clips é obrigatório.");
  return _naAtiva(seq, function () {
    var alvo = [];
    for (var j = 0; j < a.clips.length; j++) {
      var c = _clip(seq, a.clips[j]);
      alvo.push(c);
      c.setSelected(true, true);
      var l = c.getLinkedItems();
      if (l) for (var i = 0; i < l.numItems; i++) l[i].setSelected(true, true);
    }
    var ok = seq.unlinkSelection();
    var res = [];
    for (var k = 0; k < alvo.length; k++) res.push({ clipe: alvo[k].name, vinculados: _nVinculados(alvo[k]) });
    var certo = true;
    for (var m = 0; m < res.length; m++) if (res[m].vinculados) certo = false;
    return { separados: res, ok: ok !== false, verificado: certo };
  });
};

SP.link = function (a) {
  var seq = _seq(a.sequence);
  if (!a.clips || a.clips.length < 2) throw new Error("Passe pelo menos dois clipes (vídeo e áudio).");
  return _naAtiva(seq, function () {
    var alvo = [];
    for (var j = 0; j < a.clips.length; j++) { var c = _clip(seq, a.clips[j]); alvo.push(c); c.setSelected(true, true); }
    var ok = seq.linkSelection();
    return { ok: ok !== false, vinculados: _nVinculados(alvo[0]), verificado: _nVinculados(alvo[0]) >= alvo.length - 1 };
  });
};

// Item do QE que corresponde ao clipe n (1-based) da trilha: o QE lista também os vãos ("Empty").
function _qeItem(qs, kind, idx, n) {
  var t = kind === "V" ? qs.getVideoTrackAt(idx) : qs.getAudioTrackAt(idx), k = 0;
  for (var i = 0; i < t.numItems; i++) { var it = t.getItemAt(i); if (it.type === "Clip" && ++k === n) return it; }
  throw new Error("O QE não achou o clipe " + n + " da trilha.");
}

SP.setSpeed = function (a) {
  var seq = _seq(a.sequence), v = Number(a.speed);
  if (!(v > 0) || v > 100) throw new Error("speed é multiplicador: 0.5 = 50%, 2 = 200%.");
  if (!a.clips || !a.clips.length) throw new Error("clips é obrigatório.");
  var res = [];
  _qe(seq, function (qs) {
    for (var j = 0; j < a.clips.length; j++) {
      var ref = a.clips[j], t = _track(seq, ref.track);
      var q = _qeItem(qs, t.kind, t.idx, Number(ref.clip));
      q.setSpeed(v, "", !!a.reverse, false, a.keepPitch !== false);
    }
  });
  for (var k = 0; k < a.clips.length; k++) {
    var c = _clip(seq, a.clips[k]);
    res.push({ clipe: c.name, speed: _r3(c.getSpeed()), inicio: _r3(c.start.seconds), fim: _r3(c.end.seconds), verificado: Math.abs(c.getSpeed() - v) < 0.02 * v + 0.001 });
  }
  var ok = true;
  for (var m = 0; m < res.length; m++) if (!res[m].verificado) ok = false;
  return { resultados: res, verificado: ok, nota: "A duração na timeline fica igual (se a mídia acabar antes, o clipe encurta). Ajuste a duração com pr_trimClip." };
};

function _textoParams(clip) {
  var comp = clip.getMGTComponent();
  if (!comp) throw new Error("O clipe '" + clip.name + "' não é um gráfico (MOGRT).");
  var out = [];
  for (var i = 0; i < comp.properties.numItems; i++) {
    var p = comp.properties[i], v;
    try { v = p.getValue(); } catch (e) { continue; }
    if (typeof v === "string" && v.indexOf("textEditValue") >= 0) out.push({ i: i, nome: p.displayName, p: p, json: v });
  }
  return out;
}

SP.mogrtText = function (a) {
  var seq = _seq(a.sequence), clip = _clip(seq, a.clip);
  var campos = _textoParams(clip), lidos = [];
  for (var i = 0; i < campos.length; i++) {
    var c = campos[i], o = _parse(c.json);
    if (a.text !== undefined && (a.campo === undefined || Number(a.campo) === i)) {
      o.textEditValue = String(a.text);
      c.p.setValue(_j(o), true);
      o = _parse(c.p.getValue());
    }
    lidos.push({ campo: i, nome: c.nome, texto: o.textEditValue, fonte: o.fontEditValue || null });
  }
  if (!campos.length) throw new Error("Esse MOGRT não tem campo de texto editável.");
  return { clipe: clip.name, campos: lidos };
};

SP.insertMogrt = function (a) {
  var seq = _seq(a.sequence);
  var f = new File(a.path);
  if (!f.exists) throw new Error("MOGRT não existe: " + a.path);
  var v = _track(seq, a.track || "V2");
  if (v.kind !== "V") throw new Error("track deve ser de vídeo.");
  var ticks = String(Math.round(Number(a.time || 0) * TICKS));
  var item = seq.importMGT(f.fsName, ticks, v.idx, 0);
  if (!item) throw new Error("O Premiere não inseriu o MOGRT.");
  var res = { clipe: item.name, inicio: _r3(item.start.seconds), fim: _r3(item.end.seconds), track: a.track || "V2" };
  if (a.text !== undefined) {
    var campos = _textoParams(item);
    if (campos.length) { var o = _parse(campos[0].json); o.textEditValue = String(a.text); campos[0].p.setValue(_j(o), true); res.texto = _parse(campos[0].p.getValue()).textEditValue; }
  }
  if (a.duration) { var e = item.start.seconds + Number(a.duration); var t = new Time(); t.seconds = e; item.end = t; res.fim = _r3(item.end.seconds); }
  return res;
};

SP.eval = function (a) {
  if (!a.code) throw new Error("code é obrigatório.");
  var r = eval(String(a.code));
  return r === undefined ? null : r;
};
