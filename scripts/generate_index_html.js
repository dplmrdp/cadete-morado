// scripts/generate_index_html.js
const fs = require("fs");
const path = require("path");
const { normalizeTeamDisplay } = require("./team_name_utils");

const OUTPUT_HTML = "index.html";
const CALENDAR_DIR = "calendarios";

// orden de categorías en el HTML
const CATEGORIES_ORDER = [
  "BENJAMÍN",
  "ALEVÍN",
  "INFANTIL",
  "CADETE",
  "JUVENIL",
  "JUNIOR",
  "SENIOR",
];

// -------------------------
// Detectar color normalizado
// -------------------------
function detectColorNorm(name) {
  if (!name) return "";
  const up = name.toUpperCase();

  if (up.includes("MORADO")) return "MORADO";
  if (up.includes("AMARILLO")) return "AMARILLO";
  if (up.includes("PÚRPURA") || up.includes("PURPURA")) return "PÚRPURA";
  if (up.includes("ALBERO")) return "ALBERO";

  return ""; // sin color
}

// -------------------------
// Tabla de iconos (tipo A, rutas completas correctas)
// -------------------------
const TEAM_ICONS = {
  "LAS FLORES": "calendarios/icons/flores.svg",
  "LAS FLORES MORADO": "calendarios/icons/flores-morado.svg",
  "LAS FLORES AMARILLO": "calendarios/icons/flores-amarillo.svg",
  "LAS FLORES PÚRPURA": "calendarios/icons/flores-purpura.svg",
  "LAS FLORES ALBERO": "calendarios/icons/flores-albero.svg",

  "EVB LAS FLORES": "calendarios/icons/flores.svg",
  "EVB LAS FLORES MORADO": "calendarios/icons/flores-morado.svg",
  "EVB LAS FLORES AMARILLO": "calendarios/icons/flores-amarillo.svg",
  "EVB LAS FLORES PÚRPURA": "calendarios/icons/flores-purpura.svg",
  "EVB LAS FLORES ALBERO": "calendarios/icons/flores-albero.svg",
};

// -------------------------
// Asignar icono a cada equipo
// -------------------------
function getIconForTeam(team) {
  const up = team.toUpperCase();
  const isEVB = up.startsWith("EVB");
  const color = detectColorNorm(up);

  // clave exacta
  const keyExact =
    (isEVB ? "EVB " : "") + "LAS FLORES" + (color ? ` ${color}` : "");

  if (TEAM_ICONS[keyExact]) return TEAM_ICONS[keyExact];

  // fallback sin EVB
  const keyBase = "LAS FLORES" + (color ? ` ${color}` : "");
  if (TEAM_ICONS[keyBase]) return TEAM_ICONS[keyBase];

  // fallback final
  return TEAM_ICONS["LAS FLORES"];
}

// -------------------------
function detectCategoryFromFilename(filename) {
  const lower = filename.toLowerCase();
  if (lower.includes("benjamin")) return "BENJAMÍN";
  if (lower.includes("alevin")) return "ALEVÍN";
  if (lower.includes("infantil")) return "INFANTIL";
  if (lower.includes("cadete")) return "CADETE";
  if (lower.includes("juvenil")) return "JUVENIL";
  if (lower.includes("junior")) return "JUNIOR";
  if (lower.includes("senior")) return "SENIOR";
  return "OTROS";
}

// -------------------------
// Ordenar equipos según reglas
// -------------------------
function sortTeams(a, b) {
  const A = a.team.toUpperCase();
  const B = b.team.toUpperCase();

  const aIsEVB = A.startsWith("EVB");
  const bIsEVB = B.startsWith("EVB");

  if (aIsEVB !== bIsEVB) return aIsEVB ? 1 : -1;

  const order = ["", "MORADO", "AMARILLO", "PÚRPURA", "ALBERO"];

  const colA = detectColorNorm(A);
  const colB = detectColorNorm(B);

  const idxA = order.indexOf(colA);
  const idxB = order.indexOf(colB);

  if (idxA !== idxB) return idxA - idxB;

  return A.localeCompare(B, "es", { sensitivity: "base" });
}

// -------------------------
function collectCalendars() {
  const allFiles = fs.readdirSync(CALENDAR_DIR).filter(f => f.endsWith(".ics"));
  const data = {};

  for (const file of allFiles) {
    const competition = file.startsWith("federado_") ? "FEDERADO" : "IMD";

    const category = detectCategoryFromFilename(file);

    const clean = file
      .replace(/^federado_/, "")
      .replace(/^imd_/, "")
      .replace(/\.ics$/, "")
      .replace(/_/g, " ")
      .toUpperCase();

    const rawName = clean.replace(category.toUpperCase(), "").trim();
    const pretty = normalizeTeamDisplay(rawName);

    if (!data[category]) data[category] = { FEDERADO: [], IMD: [] };

    data[category][competition].push({
      team: pretty,
      path: path.join(CALENDAR_DIR, file),
    });
  }

  return data;
}

// -------------------------
function generateHTML(calendars) {
  let html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Calendarios C.D. Las Flores</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<div class="container">
<h1>Calendarios C.D. Las Flores</h1>
`;

  for (const category of CATEGORIES_ORDER) {
    if (!calendars[category]) continue;

    html += `<section class="category-block"><h2 class="category-title">${category}</h2>`;

    for (const comp of ["FEDERADO", "IMD"]) {
      const teams = calendars[category][comp];
      if (!teams || !teams.length) continue;

      html += `<div class="competition"><h3 class="competition-title">${comp}</h3><ul class="team-list">`;

      teams.sort(sortTeams);

      for (const { team, path: filePath } of teams) {
        const icon = getIconForTeam(team);

        html += `
<li class="team-item">
  <img class="team-icon" src="${icon}" alt="${team}" />
  <a class="team-link" href="${filePath}">${team}</a>
</li>`;
      }

      html += `</ul></div>`;
    }

    html += `</section>`;
  }

  html += `
</div>
</body>
</html>
`;

  fs.writeFileSync(OUTPUT_HTML, html, "utf-8");
  console.log("✅ index.html generado correctamente.");
}

// -------------------------
(function main() {
  console.log("📋 Generando index.html con nombres normalizados...");
  const calendars = collectCalendars();
  generateHTML(calendars);
})();
