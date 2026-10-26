"use strict";
const PANEL_VERSION = require("../lib/versao");

module.exports = (P) => {
  async function pr_status() {
    let premiere = "?";
    try { premiere = require("uxp").host.version; } catch (e) { /* fora do UXP */ }
    const p = await P.Project.getActiveProject();
    let seq = null;
    try { seq = p ? await p.getActiveSequence() : null; } catch (e) { seq = null; }
    return { premiere, painel: PANEL_VERSION, projeto: p ? p.name : null, caminho: p ? p.path : null, sequenciaAtiva: seq ? seq.name : null };
  }
  return { pr_status };
};
