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
  "LAS FLORES": "icons/flores.svg",
  "LAS FLORES MORADO": "icons/flores morado.svg",
  "LAS FLORES AMARILLO": "icons/flores amarillo.svg",
  "LAS FLORES PÚRPURA": "icons/flores purpura.svg",
  "LAS FLORES ALBERO": "icons/flores albero.svg",
};

// --- Recopilar los ficheros .ics ---
function collectCalendars() {
  const allFiles = fs.readdirSync(CALENDAR_DIR).filter(f => f.endsWith(".ics"));
  const data = {};

  for (const file of allFiles) {
    const parts = file.replace("federado_", "").replace(".ics", "").split("_");
    const competition = file.startsWith("federado_") ? "FEDERADO" : "IMD";

    const category = (parts[0] || "").toUpperCase();
    const teamName = file
      .replace(/^federado_/, "")
      .replace(/^imd_/, "")
      .replace(category.toLowerCase() + "_", "")
      .replace(/_/g, " ")
      .replace(/\.ics$/, "")
      .toUpperCase();

    if (!data[category]) data[category] = { FEDERADO: [], IMD: [] };

    data[category][competition].push({
      team: teamName,
      path: path.join(CALENDAR_DIR, file),
    });
  }

  return data;
}

// --- Generar HTML ordenado con estilo ---
function generateHTML(calendars) {
  let html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Calendarios C.D. Las Flores</title>
<style>
  body {
    font-family: "Segoe UI", Roboto, sans-serif;
    background: #fafafa;
    color: #222;
    margin: 2em;
    line-height: 1.5;
  }
  h1 {
    text-align: center;
    font-size: 2.4em;
    margin-bottom: 1em;
    color: #333;
  }
  h2 {
    font-size: 2em;
    color: #004aad;
    border-bottom: 3px solid #004aad;
    margin-top: 2em;
    margin-bottom: 0.5em;
    padding-bottom: 0.2em;
  }
  h3 {
    font-size: 1.4em;
    color: #333;
    margin-top: 1em;
    margin-left: 0.5em;
    border-left: 4px solid #ccc;
    padding-left: 0.5em;
  }
  ul {
    list-style: none;
    margin-left: 2em;
    padding-left: 0;
  }
  li {
    margin: 0.4em 0;
    display: flex;
    align-items: center;
    font-size: 1.1em;
  }
  .icon {
    font-size: 1.3em;
    margin-right: 0.5em;
  }
  a {
    text-decoration: none;
    color: #0056b3;
  }
  a:hover {
    text-decoration: underline;
  }
</style>
</head>
<body>
<h1>🏐 Calendarios C.D. Las Flores</h1>
`;

  for (const category of CATEGORIES_ORDER) {
    if (!calendars[category]) continue;
    html += `<h2>${category}</h2>\n`;

    for (const competition of ["FEDERADO", "IMD"]) {
      const teams = calendars[category][competition];
      if (!teams || !teams.length) continue;

      html += `<h3>${competition}</h3>\n<ul>\n`;

      teams.sort((a, b) => {
        const ai = TEAM_ORDER.findIndex(t => a.team.includes(t)) ?? 999;
        const bi = TEAM_ORDER.findIndex(t => b.team.includes(t)) ?? 999;
        return ai - bi;
      });

      for (const { team, path: filePath } of teams) {
        const icon = TEAM_ICONS[
          Object.keys(TEAM_ICONS).find(k => team.includes(k)) || "LAS FLORES"
        ];
        const label = team.replace("C.D.", "").trim();
        html += `<li><img src="${icon}" alt="${team}" class="icon">${icon}</span><a href="${filePath}">${label}</a></li>\n`;
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
