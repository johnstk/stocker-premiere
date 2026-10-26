"use strict";
const { parseTime } = require("../lib/tempo");
const { PonteError, ERR } = require("../lib/protocol");

module.exports = (P) => {
  const x = require("./ppro")(P);

  async function pr_exportFrame(input) {
    if (!input.dir) throw new PonteError(ERR.BAD_INPUT, "dir é preenchido pelo servidor; chame pela ponte.");
    const p = await x.project();
    const seq = await x.sequence(p, input.sequence);
    const tb = await seq.getTimebase();
    const fs = await seq.getFrameSize();
    const t = input.time !== undefined ? x.tickAligned(parseTime(input.time, tb), tb) : await seq.getPlayerPosition();
    const width = input.width || Math.min(1280, fs.width);
    const height = input.height || Math.round((width * fs.height) / fs.width);
    const dir = input.dir.endsWith("/") ? input.dir : input.dir + "/";
    const name = `quadro-${Date.now()}.png`;
    const ok = await P.Exporter.exportSequenceFrame(seq, t, name, dir, width, height);
    if (!ok) throw new PonteError(ERR.PREMIERE, "O Premiere não exportou o quadro (exportSequenceFrame devolveu false).");
    return { path: dir + name, time: x.sec(t), width, height };
  }

  async function pr_exportSequence(input) {
    if (input.confirmado !== true) throw new PonteError(ERR.NEEDS_CONFIRM, "Exportar exige confirmado:true.");
    if (!input.outputPath || !input.preset) throw new PonteError(ERR.BAD_INPUT, "outputPath e preset (.epr) são obrigatórios.");
    const p = await x.project();
    const seq = await x.sequence(p, input.sequence);
    const em = await P.EncoderManager.getManager();
    const fila = input.modo === "fila_ame";
    if (fila && !em.isAMEInstalled) throw new PonteError(ERR.NOT_FOUND, "O Media Encoder não está instalado.");
    const type = fila ? P.Constants.ExportType.QUEUE_TO_AME : P.Constants.ExportType.IMMEDIATELY;
    if (fila) {
      const ok = await em.exportSequence(seq, type, input.outputPath, input.preset, input.inteira !== false);
      if (!ok) throw new PonteError(ERR.PREMIERE, "O Premiere recusou o export (preset ou caminho de saída inválido?).");
      return { ok, concluido: false, enfileirado: true, outputPath: input.outputPath, modo: "fila_ame" };
    }
    const msg = (ev) => (ev && (ev.message || ev.error)) || (ev ? JSON.stringify(ev) : "");
    const EM = P.EncoderManager;
    let done;
    const evento = new Promise((resolve) => { done = resolve; });
    const handlers = [
      [EM.EVENT_RENDER_COMPLETE, (ev) => done({ tipo: "ok", ev })],
      [EM.EVENT_RENDER_ERROR, (ev) => done({ tipo: "erro", ev })],
      [EM.EVENT_RENDER_CANCEL, (ev) => done({ tipo: "cancelado", ev })],
    ];
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ tipo: "timeout" }), 55 * 60 * 1000); });
    for (const [n, h] of handlers) em.addEventListener(n, h);
    let ok, fim;
    try {
      ok = await em.exportSequence(seq, type, input.outputPath, input.preset, input.inteira !== false);
      if (!ok) throw new PonteError(ERR.PREMIERE, "O Premiere recusou o export (preset ou caminho de saída inválido?).");
      fim = await Promise.race([evento, timeout]);
    } finally {
      clearTimeout(timer);
      for (const [n, h] of handlers) em.removeEventListener(n, h);
    }
    if (fim.tipo === "erro") throw new PonteError(ERR.PREMIERE, "O render falhou" + (msg(fim.ev) ? ": " + msg(fim.ev) : "."));
    if (fim.tipo === "cancelado") throw new PonteError(ERR.PREMIERE, "O render foi cancelado" + (msg(fim.ev) ? ": " + msg(fim.ev) : "."));
    if (fim.tipo === "timeout") return { ok: true, concluido: false, aviso: "render não confirmou o fim; confira o arquivo", outputPath: input.outputPath, modo: "agora" };
    return { ok: true, concluido: true, outputPath: input.outputPath, modo: "agora" };
  }

  return { pr_exportFrame, pr_exportSequence };
};
