#!/usr/bin/env node
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { createBridge, DEFAULT_PORT } = require("./bridge");
const { loadOrCreateToken } = require("./token");
const { TOOLS, TOOL_NAMES, EDIT_PLAN_ALLOWED, timeoutFor, INSTRUCTIONS, VERSION } = require("./tools");
const { validatePlan, runPlan } = require("./plan");
const { ERR } = require("../panel/lib/protocol");

const FRAME_DIR = path.join(os.tmpdir(), "stocker-premiere");
function log(...a) { console.error("[stocker-premiere]", ...a); }

function toContent(r) {
  const content = [{ type: "text", text: JSON.stringify(r.ok ? (r.data ?? {}) : { error: r.error }) }];
  if (r.ok && r.image) content.push({ type: "image", data: r.image.data, mimeType: r.image.mimeType || "image/png" });
  return { content, isError: !r.ok };
}

function locateFrame(dir, p) {
  if (p && fs.existsSync(p)) return p;
  const stem = path.basename(p || "").replace(/\.png$/i, "");
  const hit = fs.readdirSync(dir).find((f) => stem && f.startsWith(stem));
  return hit ? path.join(dir, hit) : null;
}

async function waitForFile(p, { interval = 100, max = 5000 } = {}) {
  let last = -1;
  for (let t = 0; t <= max; t += interval) {
    let size = -1;
    try { size = fs.statSync(p).size; } catch (e) { size = -1; }
    if (size > 0 && size === last) return true;
    last = size;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

async function waitStable(p, { interval, stable, max, baseline = null }) {
  let last = -1, same = 0;
  for (let t = 0; t <= max; t += interval) {
    let size = -1;
    try {
      const st = fs.statSync(p);
      if (!baseline || st.mtimeMs > baseline.mtimeMs) size = st.size;
    } catch (e) { size = -1; }
    if (size > 0 && size === last) { if (++same >= stable) return size; } else same = 0;
    last = size;
    await new Promise((r) => setTimeout(r, interval));
  }
  return null;
}

function createHandlers({ bridge, startError = null, frameDir = FRAME_DIR, exportPollMs = 1000, exportStableCount = 5, exportMaxMs = 55 * 60 * 1000 }) {
  async function callTool(name, args) {
    if (startError) return { ok: false, error: { code: startError.code || ERR.BUSY, message: startError.message } };
    args = args || {};
    if (name === "pr_status") {
      if (!bridge.isConnected()) return { ok: true, data: { conectado: false, servidor: VERSION, dica: "No Premiere: Janela > Plug-ins UXP > Stocker Premiere, e confira o token no painel." } };
      const r = await bridge.send("pr_status", {}, { timeoutMs: timeoutFor("pr_status") });
      return r.ok ? { ok: true, data: { conectado: true, servidor: VERSION, ...r.data } } : r;
    }
    if (name === "pr_applyEditPlan") {
      let plan;
      try { plan = validatePlan(args, EDIT_PLAN_ALLOWED); } catch (e) { return { ok: false, error: { code: e.code || ERR.BAD_INPUT, message: e.message } }; }
      return { ok: true, data: await runPlan(plan, (tool, input) => callTool(tool, input)) };
    }
    if (name === "pr_exportSequence" && args.confirmado !== true) {
      return { ok: false, error: { code: ERR.NEEDS_CONFIRM, message: "Exportar exige confirmado:true. Peça a aprovação explícita do usuário antes." } };
    }
    if (name === "pr_exportFrame") {
      fs.mkdirSync(frameDir, { recursive: true });
      args = { ...args, dir: frameDir };
    }
    let baseline = null;
    if (name === "pr_exportSequence" && args.outputPath) {
      try { const st = fs.statSync(args.outputPath); baseline = { mtimeMs: st.mtimeMs, size: st.size }; } catch (e) { baseline = null; }
    }
    const r = await bridge.send(name, args, { timeoutMs: timeoutFor(name) });
    if (r.ok && name === "pr_exportFrame") {
      if (r.data && r.data.path) await waitForFile(r.data.path);
      const file = locateFrame(frameDir, r.data && r.data.path);
      if (!file) return { ok: false, error: { code: ERR.PREMIERE, message: `O Premiere disse que exportou o quadro, mas ${r.data && r.data.path} não existe.` } };
      r.data.path = file;
      r.image = { data: fs.readFileSync(file).toString("base64"), mimeType: "image/png" };
    }
    if (r.ok && name === "pr_exportSequence" && r.data && r.data.modo === "agora" && r.data.outputPath) {
      const bytes = await waitStable(r.data.outputPath, { interval: exportPollMs, stable: exportStableCount, max: exportMaxMs, baseline });
      if (bytes === null) return { ...r, data: { ...r.data, concluido: false, aviso: `o arquivo não estabilizou em ${Math.round(exportMaxMs / 60000)} min; confira no disco` } };
      return { ...r, data: { ...r.data, concluido: true, bytes } };
    }
    return r;
  }
  return { callTool };
}

async function main() {
  const token = loadOrCreateToken();
  const bridge = createBridge({ port: Number(process.env.STOCKER_PREMIERE_PORT) || DEFAULT_PORT, token, log });
  let startError = null;
  try { log("ponte ouvindo em ws://127.0.0.1:" + (await bridge.start())); } catch (e) { startError = e; log("ponte não abriu:", e.message); }
  const { callTool } = createHandlers({ bridge, startError });
  const server = new Server({ name: "stocker-premiere", version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (!TOOL_NAMES.has(name)) return toContent({ ok: false, error: { code: ERR.UNKNOWN_TOOL, message: "Tool desconhecida: " + name } });
    return toContent(await callTool(name, args));
  });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await bridge.stop(); } catch (e) { /* saindo */ }
    process.exit(0);
  };
  server.onclose = shutdown;
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  await server.connect(new StdioServerTransport());
  log(`MCP ${VERSION} pronto (${TOOLS.length} tools)`);
}

if (require.main === module) main().catch((e) => { log("fatal:", e); process.exit(1); });

module.exports = { createHandlers, toContent };
