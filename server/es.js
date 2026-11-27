"use strict";
// Cliente da segunda ponte: o painel CEP "Stocker Premiere ES" (cep/) atende em 127.0.0.1:47322 e roda
// ExtendScript no Premiere. Cobre o que a API UXP não tem: desfazer, trilhas, legenda por SRT, unlink, MOGRT.
const http = require("http");
const { ERR } = require("../panel/lib/protocol");

const ES_PORT = Number(process.env.STOCKER_PREMIERE_ES_PORT) || 47322;

// tool MCP -> função do host.jsx
const ES_TOOLS = {
  pr_esStatus: "status",
  pr_undo: "undo",
  pr_redo: "redo",
  pr_addTracks: "addTracks",
  pr_removeTrack: "removeTrack",
  pr_importCaptions: "importCaptions",
  pr_unlinkClips: "unlink",
  pr_linkClips: "link",
  pr_mogrtText: "mogrtText",
  pr_insertMogrt: "insertMogrt",
  pr_setSpeed: "setSpeed",
  pr_esReload: "reload",
  pr_esScript: "eval",
};

function esCall(fn, args, { token, timeoutMs = 90000, port = ES_PORT } = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ fn, args: args || {}, timeoutMs });
    const req = http.request({ host: "127.0.0.1", port, path: "/call", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "X-Stocker-Token": token }, timeout: timeoutMs + 5000 }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        let r;
        try { r = JSON.parse(data); } catch (e) { return resolve({ ok: false, error: { code: ERR.PREMIERE, message: `resposta inválida da ponte ES: ${data.slice(0, 200)}` } }); }
        if (r.ok) return resolve({ ok: true, data: r.data });
        const code = res.statusCode === 401 ? ERR.BUSY : ERR.PREMIERE;
        resolve({ ok: false, error: { code, message: String(r.error || "erro no ExtendScript") } });
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: { code: ERR.TIMEOUT, message: "A ponte ES não respondeu a tempo." } }); });
    req.on("error", (e) => resolve({ ok: false, error: { code: ERR.NOT_CONNECTED, message: `A ponte ES (painel Stocker Premiere ES) não está aberta: ${e.code || e.message}. No Premiere: Janela > Extensões > Stocker Premiere ES.` } }));
    req.end(body);
  });
}

module.exports = { ES_TOOLS, esCall, ES_PORT };
