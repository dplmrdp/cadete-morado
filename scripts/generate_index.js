const fs = require("fs");
const path = require("path");

const OUTPUT_HTML = "index.html";
const CALENDAR_DIR = "calendarios";

const CATEGORIES_ORDER = [
  "BENJAMÍN",
  "ALEVÍN",
  "INFANTIL",
  "CADETE",
  "JUVENIL",
  "JUNIOR",
  "SENIOR",
];

const TEAM_ORDER = [
  "LAS FLORES",
  "LAS FLORES MORADO",
  "LAS FLORES AMARILLO",
  "LAS FLORES PÚRPURA",
  "LAS FLORES ALBERO",
];

// --- Iconos SVG (asegúrate de tener estos nombres en /icons) ---
const TEAM_ICONS = {
  "LAS FLORES": "icons/flores.svg",
  "LAS FLORES MORADO": "icons/flores morado.svg",
  "LAS FLORES AMARILLO": "icons/flores amarillo.svg",
  "LAS FLORES PÚRPURA": "icons/flores purpura.svg",
  "LAS FLORES ALBERO": "icons/flores albero.svg",
};

// Normaliza nombres para comparar
function normalize(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\./g, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

// --- Recopilar los ficheros .ics ---
function collectCalendars() {
  const allFiles = fs.readdirSync(CALENDAR_DIR).filter(f => f.endsWith(".ics"));
  const data = {};

  for (const file of allFiles) {
    const lower = file.toLowerCase();

    const competition = lower.includes("imd") ? "IMD" : "FEDERADO";

    // Detectar categoría
    let category = CATEGORIES_ORDER.find(cat =>
      lower.includes(cat.toLowerCase())
    );
    if (!category) category = "OTROS";

    // Nombre legible del equipo
    let teamName = file
      .replace(/_/g, " ")
      .replace(/.ics$/i, "")
      .replace(/federado|imd/gi, "")
      .replace(/femenino/gi, "")
      .replace(/c\.d\.|cd|evb/gi, "")
      .replace(/sevi?lla/gi, "")
      .replace(/\s+/g, " ")
      .trim()
      .toUpperCase();

    // Alinear con orden oficial
    const matchKey =
      Object.keys(TEAM_ICONS).find(k => teamName.includes(k)) || "LAS FLORES";

    if (!data[category]) data[category] = { FEDERADO: [], IMD: [] };

    data[category][competition].push({
      team: matchKey,
      path: path.join(CALENDAR_DIR, file),
    });
  }

  return data;
}

// --- Generar HTML ---
function generateHTML(calendars) {
  let html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Calendarios C.D. Las Flores</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<h1>🏐 Calendarios C.D. Las Flores</h1>
`;

  for (const category of CATEGORIES_ORDER) {
    const catData = calendars[category];
    if (!catData) continue;

    html += `<h2 class="category">${category}</h2>\n`;

    for (const competition of ["FEDERADO", "IMD"]) {
      const teams = catData[competition];
      if (!teams || !teams.length) continue;

      html += `<h3 class="${competition.toLowerCase()}">${competition}</h3>\n<ul class="team-list">\n`;

      teams.sort((a, b) => {
        const ai = TEAM_ORDER.findIndex(t => a.team === t);
        const bi = TEAM_ORDER.findIndex(t => b.team === t);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      });

      for (const { team, path: filePath } of teams) {
        const icon = TEAM_ICONS[team] || TEAM_ICONS["LAS FLORES"];
        html += `<li><img src="${icon}" alt="${team}" class="icon"><a href="${filePath}">${team}</a></li>\n`;
      }

      html += `</ul>\n`;
    }
  }

  html += `
</body>
</html>
`;
  fs.writeFileSync(OUTPUT_HTML, html, "utf-8");
  console.log(`✅ Archivo HTML generado: ${OUTPUT_HTML}`);
}

// --- Main ---
(function main() {
  console.log("📋 Generando index.html agrupado por categoría y competición...");
  const calendars = collectCalendars();
  generateHTML(calendars);
})();
