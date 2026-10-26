"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const t = require("../panel/lib/tempo");

const TB_23976 = "10594584000"; // timebase real de uma sequência 23,976 (ticks por quadro)

test("fps a partir do timebase", () => {
  assert.ok(Math.abs(t.fpsFromTimebase(TB_23976) - 24000 / 1001) < 1e-9);
  assert.throws(() => t.fpsFromTimebase("0"), /timebase inválido/);
});

test("segundos ↔ ticks", () => {
  assert.equal(t.secondsToTicks(1), 254016000000);
  assert.equal(t.ticksToSeconds(254016000000 * 2), 2);
  assert.equal(t.ticksToSeconds("508032000000"), 2);
});

test("alinha ao quadro mais próximo", () => {
  assert.equal(t.alignSeconds(1.01, TB_23976), 1.001); // quadro 24 a 23,976 fps
  assert.equal(t.alignSeconds(0, TB_23976), 0);
  assert.equal(t.alignTicksToFrame(10594584000 * 3 + 100, TB_23976), 10594584000 * 3);
});

test("parseTime aceita segundos, texto numérico e timecode", () => {
  assert.equal(t.parseTime(2.5, TB_23976), 2.5);
  assert.equal(t.parseTime("3", TB_23976), 3);
  assert.equal(t.parseTime("00:00:01:12", TB_23976), 1.5); // 12 quadros a 24 (fps arredondado)
  assert.throws(() => t.parseTime("abc", TB_23976), /tempo inválido/);
});

test("roundSec arredonda para 3 casas", () => {
  assert.equal(t.roundSec(1.23456), 1.235);
});
