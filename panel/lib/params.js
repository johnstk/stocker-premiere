"use strict";
// Parâmetros por matchName + índice: independe do idioma do Premiere ("Escala", "Movimento").
function matchNameIs(actual, wanted) {
  const a = String(actual || "").trim();
  const w = String(wanted || "").trim();
  if (!a || !w) return false;
  return a === w || a.endsWith("." + w) || w.endsWith("." + a);
}
// Índices conferidos no inventário de 26/10/2026 (Premiere 26.5.2).
const CLIP_PROPS = {
  position: { component: "ADBE Motion", index: 0, kind: "point" },
  scale: { component: "ADBE Motion", index: 1, kind: "number" },
  rotation: { component: "ADBE Motion", index: 4, kind: "number" },
  anchor: { component: "ADBE Motion", index: 5, kind: "point" },
  opacity: { component: "ADBE Opacity", index: 0, kind: "number" },
};
function checkPoint(p) {
  if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite)) throw new Error("position deve ser [x, y] em pixels");
}
function pixelsToNormalized(p, { width, height }) { checkPoint(p); return [p[0] / width, p[1] / height]; }
function normalizedToPixels(p, { width, height }) {
  checkPoint(p);
  return [Math.round(p[0] * width * 100) / 100, Math.round(p[1] * height * 100) / 100];
}
module.exports = { matchNameIs, CLIP_PROPS, pixelsToNormalized, normalizedToPixels };
