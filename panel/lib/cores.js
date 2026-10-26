"use strict";
// Índices de cor de marcador do Premiere (Constants.MarkerColor, conferido em 26.5.2).
const MARKER_COLORS = ["green", "red", "purple", "orange", "yellow", "white", "blue", "cyan"];
function colorIndex(name) {
  const n = String(name || "green").toLowerCase();
  const i = n === "magenta" ? 2 : MARKER_COLORS.indexOf(n);
  if (i < 0) throw new Error(`cor inválida: ${name}. Use: ${MARKER_COLORS.join(", ")}`);
  return i;
}
function colorName(i) { return MARKER_COLORS[i] || "green"; }
module.exports = { MARKER_COLORS, colorIndex, colorName };
