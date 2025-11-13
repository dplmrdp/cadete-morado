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

const TEAM_ICONS = {
  "LAS FLORES": "icons/flores.png",
  "LAS FLORES MORADO": "icons/morado.png",
  "LAS FLORES AMARILLO": "icons/amarillo.png",
  "LAS FLORES PÚRPURA": "icons/purpura.png",
  "LAS FLORES ALBERO": "icons/albero.png",
};

// --- Recopilar los ficheros .ics ---
function collectCalendars() {
  const allFiles = fs.readdirSync(CALENDAR_DIR).filter(f => f.endsWith(".ics"));
  const data = {};

  for (const file of allFiles) {
    const competition = file.startsWith("federado_") ? "FEDERADO" : "IMD";
    const parts = file
      .replace(/^(federado_|imd_)/, "")
      .replace(".ics", "")
      .split("_");

    const category = (parts[0] || "").toUpperCase();
    const teamName = parts.slice(1).join(" ").toUpperCase();

    if (!data[category]) data[category] = { FEDERADO: [], IMD: [] };

    data[category][competition].push({
      team: teamName,
      path: path.join(CALENDAR_DIR, file),
    });
  }

  return data;
}

// --- Generar HTML con link al CSS externo ---
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
    if (!calendars[category]) continue;
    html += `<h2 class="category">${category}</h2>\n`;

    for (const competition of ["FEDERADO", "IMD"]) {
      const teams = calendars[category][competition];
      if (!teams || !teams.length) continue;

      html += `<h3 class="${competition.toLowerCase()}">${competition}</h3>\n<ul class="team-list">\n`;

      teams.sort((a, b) => {
        const ai = TEAM_ORDER.findIndex(t => a.team.includes(t)) ?? 999;
        const bi = TEAM_ORDER.findIndex(t => b.team.includes(t)) ?? 999;
        return ai - bi;
      });

      for (const { team, path: filePath } of teams) {
        const icon =
          TEAM_ICONS[
            Object.keys(TEAM_ICONS).find(k => team.includes(k)) || "LAS FLORES"
          ];
        const label = team.replace("C.D.", "").trim();
        html += `<li><img src="${icon}" alt="${team}" class="icon"><a href="${filePath}">${label}</a></li>\n`;
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
  console.log("📋 Generando index.html agrupado por categoría...");
  const calendars = collectCalendars();
  generateHTML(calendars);
})();
