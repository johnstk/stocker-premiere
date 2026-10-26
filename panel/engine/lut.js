"use strict";
const { PonteError, ERR } = require("../lib/protocol");

const semLut = (id) => !id || /^0{8}-0{4}-0{4}-0{4}-0{12}$/i.test(String(id));
const norm = (id) => (semLut(id) ? null : String(id));

module.exports = (P) => {
  const x = require("./ppro")(P);

  async function clips(p, refs) {
    if (!Array.isArray(refs) || !refs.length) throw new PonteError(ERR.BAD_INPUT, "items é obrigatório.");
    const out = [];
    for (const ref of refs) out.push({ ref, clip: P.ClipProjectItem.cast((await x.findProjectItem(p, ref))._item) });
    return out;
  }

  async function pr_getInputLut(input) {
    const p = await x.project();
    const itens = [];
    for (const { ref, clip } of await clips(p, input.items)) {
      let embeddedLutId = null;
      try { embeddedLutId = await clip.getEmbeddedLUTID(); } catch (e) { embeddedLutId = null; }
      itens.push({ item: ref, inputLutId: norm(await clip.getInputLUTID()), embeddedLutId: norm(embeddedLutId) });
    }
    return { itens };
  }

  async function pr_setInputLut(input) {
    if (input.lutId !== null && typeof input.lutId !== "string") throw new PonteError(ERR.BAD_INPUT, "lutId deve ser o ID lido com pr_getInputLut, ou null.");
    const p = await x.project();
    const alvo = await clips(p, input.items);
    x.tx(p, "stocker-premiere: LUT de entrada", () => alvo.map(({ clip }) => clip.createSetInputLUTIDAction(input.lutId || "")));
    let certos = 0;
    for (const { clip } of alvo) if (norm(await clip.getInputLUTID()) === norm(input.lutId)) certos++;
    return { alterados: alvo.length, verificado: certos === alvo.length };
  }

  return { pr_getInputLut, pr_setInputLut };
};
