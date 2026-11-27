"use strict";
// Base para a ponte crescer sem recarregar o painel:
// - pr_inspectApi lê a API premierepro viva (classes, métodos, constantes).
// - pr_reloadPanel recarrega o próprio painel (código novo do disco) sem clicar no UDT.
const { PonteError, ERR } = require("../lib/protocol");

function membros(obj) {
  const out = new Set();
  let o = obj;
  for (let n = 0; o && o !== Object.prototype && o !== Function.prototype && n < 6; n++, o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) if (k !== "constructor" && k !== "prototype" && k !== "length" && k !== "name") out.add(k);
  }
  return [...out].sort();
}

// Converte qualquer retorno em JSON simples: objeto nativo do Premiere vira "[Classe]".
function plano(v, depth = 0, vistos = new Set()) {
  if (v === null || v === undefined) return v ?? null;
  const t = typeof v;
  if (t === "number" || t === "string" || t === "boolean") return v;
  if (t === "bigint") return String(v);
  if (t === "function") return `[função ${v.name || ""}]`;
  if (depth > 6) return "[…]";
  if (vistos.has(v)) return "[ciclo]";
  vistos.add(v);
  if (Array.isArray(v)) return v.slice(0, 2000).map((e) => plano(e, depth + 1, vistos));
  const proto = Object.getPrototypeOf(v);
  const nome = proto && proto.constructor && proto.constructor.name;
  if (nome && nome !== "Object") {
    if (v.ticksNumber !== undefined || v.ticks !== undefined) return { ticks: String(v.ticks ?? v.ticksNumber), seconds: v.seconds };
    const simples = {};
    let algum = false;
    for (const k of Object.keys(v)) { const e = v[k]; if (e === null || ["number", "string", "boolean"].includes(typeof e)) { simples[k] = e; algum = true; } }
    return algum ? { _classe: nome, ...simples } : `[${nome}]`;
  }
  const o = {};
  for (const k of Object.keys(v)) o[k] = plano(v[k], depth + 1, vistos);
  return o;
}

module.exports = (P) => {
  const x = require("./ppro")(P);

  async function pr_inspectApi(input) {
    const alvo = String(input.path || "").trim();
    if (!alvo) {
      const classes = {};
      for (const k of Object.keys(P).sort()) {
        const v = P[k];
        if (typeof v === "function") classes[k] = { estaticos: membros(v).filter((m) => typeof v[m] === "function"), constantes: membros(v).filter((m) => typeof v[m] !== "function").slice(0, 40), metodos: v.prototype ? membros(v.prototype) : [] };
        else if (v && typeof v === "object") classes[k] = { objeto: membros(v).slice(0, 80) };
        else classes[k] = v;
      }
      return { classes };
    }
    let v = P;
    for (const parte of alvo.split(".")) { v = v ? v[parte] : undefined; }
    if (v === undefined) throw new PonteError(ERR.NOT_FOUND, `'${alvo}' não existe na API premierepro.`);
    const ar = (o, m) => { try { const f = o[m]; return typeof f === "function" ? `${m}/${f.length} ${String(f).slice(0, 600).replace(/\\s+/g, " ")}` : m; } catch (e) { return m; } };
    if (typeof v === "function") return { path: alvo, estaticos: membros(v).map((m) => ar(v, m)), metodos: v.prototype ? membros(v.prototype).map((m) => ar(v.prototype, m)) : [] };
    if (v && typeof v === "object") { const o = {}; for (const m of membros(v)) { try { o[m] = typeof v[m] === "function" ? "função" : plano(v[m], 4); } catch (e) { o[m] = "?"; } } return { path: alvo, membros: o }; }
    return { path: alvo, valor: v };
  }

  // Roda JS dentro do painel, com a API e os ajudantes. Liberado pelo usuário em 27/11/2026 ("modo livre").
  // O código é o corpo de uma função async: recebe P (premierepro), x (ajudantes da ponte), input e lib, e devolve
  // o resultado (convertido para JSON simples). Ações que mudam o projeto continuam indo por x.tx(p, rótulo, () => [...]).
  async function pr_runScript(input) {
    const code = String(input.code || "");
    if (!code.trim()) throw new PonteError(ERR.BAD_INPUT, "code é obrigatório: corpo de uma função async que recebe (P, x, input, lib).");
    let fn;
    try {
      fn = new Function("P", "x", "input", "lib", `"use strict"; return (async () => {\n${code}\n})();`);
    } catch (e) {
      throw new PonteError(ERR.BAD_INPUT, `O script não compila: ${(e && e.message) || e}`);
    }
    const lib = { tempo: require("../lib/tempo"), cores: require("../lib/cores"), params: require("../lib/params"), PonteError, ERR, plano };
    return { resultado: plano(await fn(P, x, input.input || {}, lib)) };
  }

  async function pr_reloadPanel() {
    setTimeout(() => { try { window.location.reload(); } catch (e) { /* sem reload */ } }, 400);
    return { recarregando: true };
  }

  return { pr_inspectApi, pr_runScript, pr_reloadPanel };
};
