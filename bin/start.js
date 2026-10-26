#!/usr/bin/env node
"use strict";
// Entrada do plugin do Claude Code: instala as dependências na primeira vez e sobe o servidor.
// Saída do npm vai para stderr, porque stdout é o canal MCP.
const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
if (!fs.existsSync(path.join(root, "node_modules", "ws"))) {
  execSync("npm install --omit=dev --no-audit --no-fund", { cwd: root, stdio: ["ignore", 2, 2] });
}
const child = spawn(process.execPath, [path.join(root, "server", "index.js")], { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : code));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => child.kill(sig));
