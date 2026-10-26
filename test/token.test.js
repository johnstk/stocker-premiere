"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadOrCreateToken, tokensEqual } = require("../server/token");

test("cria token 0600 e reaproveita", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-token-"));
  const a = loadOrCreateToken(dir);
  assert.match(a, /^[a-f0-9]{48}$/);
  assert.equal(fs.statSync(path.join(dir, "token")).mode & 0o777, 0o600);
  assert.equal(loadOrCreateToken(dir), a);
});

test("token corrompido é refeito", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-token-"));
  fs.writeFileSync(path.join(dir, "token"), "lixo");
  assert.match(loadOrCreateToken(dir), /^[a-f0-9]{48}$/);
});

test("comparação de token", () => {
  assert.ok(tokensEqual("abc", "abc"));
  assert.ok(!tokensEqual("abc", "abd"));
  assert.ok(!tokensEqual("abc", undefined));
});
