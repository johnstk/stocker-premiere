"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const proto = require("../panel/lib/protocol");
const { colorIndex, colorName } = require("../panel/lib/cores");
const { matchNameIs, CLIP_PROPS, pixelsToNormalized, normalizedToPixels } = require("../panel/lib/params");

test("mensagens do protocolo", () => {
  assert.deepEqual(proto.hello({ token: "t", panel: "0.1.0", premiere: "26.5.2", tools: ["pr_status"] }),
    { type: "hello", v: 1, token: "t", panel: "0.1.0", premiere: "26.5.2", tools: ["pr_status"] });
  assert.deepEqual(proto.call(7, "pr_status"), { type: "call", id: 7, tool: "pr_status", input: {} });
  assert.deepEqual(proto.ok(7, { a: 1 }), { type: "result", id: 7, ok: true, data: { a: 1 } });
  assert.deepEqual(proto.fail(7, proto.ERR.NOT_FOUND, "x"), { type: "result", id: 7, ok: false, error: { code: "nao_encontrado", message: "x" } });
  assert.equal(proto.parse("{nada"), null);
  assert.equal(proto.parse('{"a":1}'), null); // sem type
  assert.deepEqual(proto.parse(Buffer.from('{"type":"welcome"}')), { type: "welcome" });
  const e = new proto.PonteError(proto.ERR.BAD_INPUT, "ruim");
  assert.equal(e.code, "entrada_invalida");
  assert.ok(e instanceof Error);
});

test("cores de marcador seguem os índices do Premiere", () => {
  assert.equal(colorIndex("green"), 0);
  assert.equal(colorIndex("Cyan"), 7);
  assert.equal(colorIndex("magenta"), 2);
  assert.equal(colorIndex(undefined), 0);
  assert.throws(() => colorIndex("rosa"), /cor inválida/);
  assert.equal(colorName(3), "orange");
  assert.equal(colorName(99), "green");
});

test("matchName compara por sufixo (UXP prefixa AE./PR.)", () => {
  assert.ok(matchNameIs("AE.ADBE Motion", "ADBE Motion"));
  assert.ok(matchNameIs("ADBE Motion", "AE.ADBE Motion"));
  assert.ok(matchNameIs("ADBE Lumetri", "ADBE Lumetri"));
  assert.ok(!matchNameIs("AE.ADBE Motion Blur", "ADBE Motion"));
  assert.ok(!matchNameIs("", "ADBE Motion"));
});

test("mapa de propriedades do clipe (índices do inventário 26.5.2)", () => {
  assert.deepEqual(CLIP_PROPS.scale, { component: "ADBE Motion", index: 1, kind: "number" });
  assert.deepEqual(CLIP_PROPS.position, { component: "ADBE Motion", index: 0, kind: "point" });
  assert.deepEqual(CLIP_PROPS.rotation, { component: "ADBE Motion", index: 4, kind: "number" });
  assert.deepEqual(CLIP_PROPS.opacity, { component: "ADBE Opacity", index: 0, kind: "number" });
});

test("posição em pixels ↔ normalizada", () => {
  const size = { width: 3840, height: 2160 };
  assert.deepEqual(pixelsToNormalized([1920, 1080], size), [0.5, 0.5]);
  assert.deepEqual(normalizedToPixels([0.25, 0.5], size), [960, 1080]);
  assert.throws(() => pixelsToNormalized([1], size), /position/);
});
