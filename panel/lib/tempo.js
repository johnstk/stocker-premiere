"use strict";
// Tempo do Premiere: 254016000000 ticks por segundo. Código puro (painel UXP e servidor).
const TICKS_PER_SECOND = 254016000000;

function fpsFromTimebase(timebase) {
  const tb = Number(timebase);
  if (!(tb > 0)) throw new Error("timebase inválido: " + timebase);
  return TICKS_PER_SECOND / tb;
}
function secondsToTicks(s) { return Math.round(Number(s) * TICKS_PER_SECOND); }
function ticksToSeconds(t) { return Number(t) / TICKS_PER_SECOND; }
function alignTicksToFrame(ticks, timebase) {
  const f = Number(timebase);
  return Math.round(Number(ticks) / f) * f;
}
function roundSec(s) { return Math.round(Number(s) * 1000) / 1000; }
function alignSeconds(s, timebase) { return roundSec(ticksToSeconds(alignTicksToFrame(secondsToTicks(s), timebase))); }
function parseTime(v, timebase) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const tc = /^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{2})$/.exec(v.trim());
    if (tc) {
      const [h, m, s, f] = tc.slice(1).map(Number);
      return h * 3600 + m * 60 + s + f / Math.round(fpsFromTimebase(timebase));
    }
    if (v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  throw new Error("tempo inválido: " + v + ' (use segundos ou "HH:MM:SS:FF")');
}

module.exports = { TICKS_PER_SECOND, fpsFromTimebase, secondsToTicks, ticksToSeconds, alignTicksToFrame, alignSeconds, parseTime, roundSec };
