#!/usr/bin/env node
"use strict";
// Chama uma tool direto pela ponte, sem o Claude. Só roda com o MCP stocker-premiere parado
// (os dois usam a porta 47321).
const { createBridge } = require("../server/bridge");
const { loadOrCreateToken } = require("../server/token");
const { createHandlers } = require("../server/index");

(async () => {
  const [tool, json] = process.argv.slice(2);
  if (!tool) { console.error("uso: node smoke/run.js <tool> '<json de entrada>'"); process.exit(2); }
  const bridge = createBridge({ token: loadOrCreateToken(), log: (m) => console.error("[ponte]", m) });
  await bridge.start();
  console.error("esperando o painel (até 30 s)…");
  if (!(await bridge.waitForPanel(30000))) { console.error("o painel não conectou"); process.exit(1); }
  const r = await createHandlers({ bridge }).callTool(tool, json ? JSON.parse(json) : {});
  if (r.image) r.image = { mimeType: r.image.mimeType, bytes: Buffer.from(r.image.data, "base64").length };
  console.log(JSON.stringify(r, null, 2));
  await bridge.stop();
  process.exit(r.ok ? 0 : 1);
})();
