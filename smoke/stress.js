#!/usr/bin/env node
"use strict";
// Teste de carga do painel: N pr_placeClip seguidos numa CÓPIA da sequência (nunca salva o projeto).
// A cada 10 colocações também lê o trecho (pr_getSequenceState) e liga/desliga o clipe (pr_setClipEnabled),
// como no trabalho real. Uso:
//   node smoke/stress.js '{"sequence":"<cópia>","item":{"nodeId":"..."},"track":"V7","n":200,"from":10,"step":5}'
const { createPonte } = require("../server/bridge");
const { loadOrCreateToken } = require("../server/token");
const { createHandlers } = require("../server/index");
const { execSync } = require("child_process");

function rssPremiereMB() {
  try {
    const out = execSync("ps -axo rss,comm | grep 'MacOS/Adobe Premiere Pro' | grep -v grep", { encoding: "utf8" });
    return Math.round(Math.max(...out.trim().split("\n").map((l) => Number(l.trim().split(/\s+/)[0]))) / 1024);
  } catch (e) { return null; }
}

(async () => {
  const cfg = JSON.parse(process.argv[2] || "{}");
  if (!cfg.sequence || !cfg.item) { console.error("precisa de sequence (a cópia) e item"); process.exit(2); }
  const n = cfg.n ?? 200, track = cfg.track || "V7", from = cfg.from ?? 10, step = cfg.step ?? 5;
  const bridge = createPonte({ token: loadOrCreateToken(), log: () => {} });
  await bridge.start();
  if (!(await bridge.waitForPanel(30000))) { console.error("o painel não conectou"); process.exit(1); }
  const h = createHandlers({ bridge });
  const t0 = Date.now();
  let falhas = 0;
  for (let i = 0; i < n; i++) {
    const time = from + i * step;
    const a = Date.now();
    const r = await h.callTool("pr_placeClip", { sequence: cfg.sequence, item: cfg.item, track, time, audioTrack: null });
    const ms = Date.now() - a;
    if (!r.ok) { falhas++; console.log(`#${i + 1} t=${time} ERRO ${r.error && r.error.code}: ${r.error && r.error.message}`); if (r.error && /conect|painel/i.test(r.error.message || "")) break; continue; }
    if (!r.data.verificado) falhas++;
    let extra = "";
    if ((i + 1) % 10 === 0) {
      const s = await h.callTool("pr_getSequenceState", { sequence: cfg.sequence, tracks: track, from: time - 1, to: time + step, markers: false });
      const off = await h.callTool("pr_setClipEnabled", { sequence: cfg.sequence, clips: [{ track, time: time + 0.1 }], enabled: false });
      const on = await h.callTool("pr_setClipEnabled", { sequence: cfg.sequence, clips: [{ track, time: time + 0.1 }], enabled: true });
      const tr = s.ok && s.data.tracks[0];
      extra = ` | leitura ${s.ok ? `${tr.clips.length}/${tr.total} clipes` : "ERRO " + s.error.message} | enable ${off.ok && off.data.verificado && on.ok && on.data.verificado ? "ok" : "FALHOU"} | Premiere ${rssPremiereMB()} MB`;
    }
    console.log(`#${i + 1} t=${time} ${r.data.verificado ? "ok" : "NÃO VERIFICADO " + r.data.diferenca} ${ms}ms${extra}`);
  }
  console.log(`fim: ${n} colocações, ${falhas} falha(s), ${Math.round((Date.now() - t0) / 1000)} s`);
  await bridge.stop();
  process.exit(falhas ? 1 : 0);
})();
