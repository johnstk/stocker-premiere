"use strict";
// Mensagens entre o servidor MCP e o painel UXP. Código puro.
const PROTOCOL_VERSION = 1;
const ERR = {
  NOT_CONNECTED: "nao_conectado",
  TIMEOUT: "tempo_esgotado",
  BAD_INPUT: "entrada_invalida",
  NOT_FOUND: "nao_encontrado",
  PREMIERE: "erro_premiere",
  UNKNOWN_TOOL: "tool_desconhecida",
  BUSY: "ponte_ocupada",
  NEEDS_CONFIRM: "precisa_confirmacao",
};
class PonteError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}
function hello({ token, panel, premiere, tools }) { return { type: "hello", v: PROTOCOL_VERSION, token, panel, premiere, tools }; }
function call(id, tool, input) { return { type: "call", id, tool, input: input || {} }; }
function ok(id, data) { return { type: "result", id, ok: true, data: data === undefined ? {} : data }; }
function fail(id, code, message, detail) {
  const error = { code, message };
  if (detail !== undefined) error.detail = detail;
  return { type: "result", id, ok: false, error };
}
function parse(raw) {
  let m;
  try { m = JSON.parse(typeof raw === "string" ? raw : raw.toString()); } catch (e) { return null; }
  if (!m || typeof m.type !== "string") return null;
  return m;
}
module.exports = { PROTOCOL_VERSION, ERR, PonteError, hello, call, ok, fail, parse };
