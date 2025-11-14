function normalizeBase(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function removeNoise(n) {
  return n
    .replace(/\bC\.?D\.?\b/g, " ")
    .replace(/\bC\s*D\b/g, " ")
    .replace(/\bCLUB\b/g, " ")
    .replace(/\bVOLEIBOL\b/g, " ")
    .replace(/\bSEVILLA\b/g, " ")
    .replace(/\bJUVENIL\b/g, " ")
    .replace(/\bJUVENOL\b/g, " ")
    .replace(/\bCADETE\b/g, " ")
    .replace(/\bINFANTIL\b/g, " ")
    .replace(/\bALEVIN\b/g, " ")
    .replace(/\bALEV[IÍ]N\b/g, " ")
    .replace(/\bSENIOR\b/g, " ")
    .replace(/\bSUB\b/g, " ")
    .replace(/\b20\d{2}\b/g, " ") // años tipo "2025"
    .replace(/\s+/g, " ")
    .trim();
}

function detectColor(n) {
  if (n.includes("AMARILLO")) return "AMARILLO";
  if (n.includes("ALBERO")) return "ALBERO";
  if (n.includes("MORADO")) return "MORADO";
  if (n.includes("PURPURA") || n.includes("PÚRPURA")) return "PÚRPURA";
  return null;
}

// -------------------------
// NORMALIZADOR PRINCIPAL
// -------------------------
function normalizeTeamDisplay(raw) {
  if (!raw) return "LAS FLORES";

  let n = normalizeBase(raw);
  n = removeNoise(n);

  const isEVB = n.includes("EVB");

  const color = detectColor(n);

  // Si es EVB
  if (isEVB) {
    if (color) return `EVB LAS FLORES ${color}`;
    return `EVB LAS FLORES`;
  }

  // No es EVB → LAS FLORES solamente
  if (color) return `LAS FLORES ${color}`;

  return "LAS FLORES";
}

// -------------------------
// SLUG (nombre de archivo ICS)
// -------------------------
function normalizeTeamSlug(raw) {
  const disp = normalizeTeamDisplay(raw).toUpperCase();

  return disp
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^\w_]/g, "");
}

module.exports = {
  normalizeTeamDisplay,
  normalizeTeamSlug
};
