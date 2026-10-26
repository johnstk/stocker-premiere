"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

function defaultDir() { return path.join(os.homedir(), "Library", "Application Support", "stocker-premiere"); }

function loadOrCreateToken(dir = defaultDir()) {
  const file = path.join(dir, "token");
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    if (/^[a-f0-9]{48}$/.test(t)) return t;
  } catch (e) { /* ainda não existe */ }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const t = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(file, t + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return t;
}

function tokensEqual(a, b) {
  const A = Buffer.from(String(a || ""));
  const B = Buffer.from(String(b || ""));
  return A.length === B.length && A.length > 0 && crypto.timingSafeEqual(A, B);
}

module.exports = { defaultDir, loadOrCreateToken, tokensEqual };
