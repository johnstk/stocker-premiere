"use strict";
// Leitura parcial: em trilha grande, achar um tempo não pode ler todos os clipes (cada leitura cria objetos nativos no UXP).
const test = require("node:test");
const assert = require("node:assert/strict");

const TPS = 254016000000;
function fakeP(nClips, binItems) {
  const calls = { time: 0, getItems: 0 };
  const tt = (s) => { calls.time++; return { ticksNumber: Math.round(s * TPS) }; };
  const clips = Array.from({ length: nClips }, (_, i) => ({ getStartTime: async () => tt(i * 2), getEndTime: async () => tt(i * 2 + 2), getName: async () => `c${i}` }));
  const item = (name, id, type = "clip", kids = []) => ({ name, type, id, kids, getId: async () => id, getItems: async () => { calls.getItems++; return kids; } });
  const root = item("root", "0", "bin", binItems(item));
  const P = {
    Constants: { TrackItemType: { CLIP: 1 }, MediaType: {} },
    ProjectItem: { TYPE_BIN: "bin" },
    FolderItem: { cast: (k) => k },
    ClipProjectItem: { cast: (k) => ({ isSequence: async () => false, getMediaFilePath: async () => `/m/${k.name}` }) },
  };
  const project = { getRootItem: async () => root };
  return { P, calls, clips, project };
}

test("itemsInRange e itemsStartingAt leem poucos clipes numa trilha de 2000", async () => {
  const { P, calls, clips } = fakeP(2000, () => []);
  const x = require("../panel/engine/ppro")(P);
  const r = await x.itemsInRange(clips, 1001, 1005);
  assert.deepEqual(r.map((c) => c.j), [500, 501, 502]);
  assert.ok(calls.time < 40, `leu ${calls.time} tempos`);
  calls.time = 0;
  const s = await x.itemsStartingAt(clips, 3000, 1 / 30);
  assert.deepEqual(s.map((c) => c.j), [1500]);
  assert.ok(calls.time < 40, `leu ${calls.time} tempos`);
  assert.equal((await x.itemsInRange(clips, -Infinity, 3)).length, 2);
  assert.equal((await x.itemsInRange(clips, 5000, Infinity)).length, 0);
});

test("findProjectItem usa o índice de texto e só relê o bin do item", async () => {
  const { P, calls, project } = fakeP(0, (item) => [
    item("HUD", "b1", "bin", Array.from({ length: 300 }, (_, i) => item(`h${i}.png`, `h${i}`))),
    item("Legendas", "b2", "bin", [item("L1 052.png", "L1")]),
  ]);
  const x = require("../panel/engine/ppro")(P);
  x.invalidateIndex();
  const a = await x.findProjectItem(project, "L1 052.png");
  assert.equal(a.nodeId, "L1");
  assert.ok(a._item);
  calls.getItems = 0;
  const b = await x.findProjectItem(project, { nodeId: "h7" });
  assert.equal(b.name, "h7.png");
  assert.ok(calls.getItems <= 2, `getItems ${calls.getItems}x`); // raiz + bin HUD, sem varrer o resto
  await assert.rejects(x.findProjectItem(project, "nao-existe.png"), /não está no projeto/);
});
