"use strict";
const proto = require("../lib/protocol");
const PANEL_VERSION = require("../lib/versao");

// Cada tarefa seguinte acrescenta o seu módulo nesta lista.
const MODULES = [require("./read"), require("./project"), require("./timeline"), require("./look"), require("./lut"), require("./export")];

function createEngine(P) {
  const handlers = {};
  for (const make of MODULES) Object.assign(handlers, make(P));
  async function run(id, tool, input) {
    const h = handlers[tool];
    if (!h) return proto.fail(id, proto.ERR.UNKNOWN_TOOL, `O painel ${PANEL_VERSION} não implementa '${tool}'.`);
    try { return proto.ok(id, await h(input || {})); } catch (e) {
      return proto.fail(id, e.code || proto.ERR.PREMIERE, (e && e.message) || String(e), e && e.detail);
    }
  }
  return { run, tools: Object.keys(handlers) };
}

module.exports = { createEngine };
