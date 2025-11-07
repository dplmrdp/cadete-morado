// scripts/generate_index_html.js
// Genera automáticamente el archivo index.html agrupando los calendarios .ics del directorio /calendarios

const fs = require("fs");
const path = require("path");

const CAL_DIR = path.join(__dirname, "../calendarios");
const OUTPUT_HTML = path.join(__dirname, "../index.html");

// Leer todos los archivos .ics del directorio
const files = fs
  .readdirSync(CAL_DIR)
  .filter((f) => f.endsWith(".ics") && f.startsWith("imd_"));

// Agrupar por categoría (por ejemplo: imd_cadete_femenino_cd_las_flores_morado.ics)
const groups = {};

for (const file of files) {
  const match = file.match(/^imd_(.*?)_(cd|evb)_las_flores/i);
  if (!match) continue;

  const category = match[1].replace(/_/g, " ").toUpperCase();
  if (!groups[category]) groups[category] = [];

  const displayName = file
    .replace(/^imd_/, "")
    .replace(/\.ics$/, "")
    .replace(/_/g, " ")
    .toUpperCase()
    .replace(/\bCD\b/g, "C.D.")
    .replace(/\bEVB\b/g, "EVB");

  groups[category].push({ file, displayName });
}

// Ordenar categorías alfabéticamente
const sortedCats = Object.keys(groups).sort();

// Generar HTML
let html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>🏐 Calendarios Club Las Flores</title>
  <style>
    body {
      font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      margin: 2rem;
      background: #fafafa;
      color: #333;
    }
    h1 {
      color: #7c3aed;
    }
    h2 {
      margin-top: 2rem;
      color: #444;
      border-bottom: 2px solid #ddd;
      padding-bottom: 0.2rem;
    }
    h3 {
      margin-top: 1.2rem;
      color: #555;
    }
    ul {
      list-style: none;
      padding-left: 1rem;
    }
    li {
      margin: 0.4rem 0;
    }
    a {
      text-decoration: none;
      color: #1e40af;
      font-weight: 500;
    }
    a:hover {
      text-decoration: underline;
    }
    .emoji {
      font-size: 1.2em;
    }
  </style>
</head>
<body>
  <h1>🏐 Calendarios Club Las Flores</h1>

  <h2>🟠 FEDERADO</h2>
  <ul>
    <li><a href="calendarios/federado.ics">C.D. LAS FLORES SEVILLA MORADO (Cadete Femenino)</a></li>
  </ul>

  <h2>🟣 IMD</h2>
`;

// Agregar categorías IMD y sus enlaces
for (const cat of sortedCats) {
  html += `  <h3>🏐 ${cat}</h3>\n  <ul>\n`;
  for (const { file, displayName } of groups[cat]) {
    html += `    <li><a href="calendarios/${file}">${displayName}</a></li>\n`;
  }
  html += "  </ul>\n";
}

html += `
  <p style="margin-top:3rem;font-size:0.9em;color:#666;">
    📅 Pulsa en el nombre del equipo para <b>suscribirte</b> a su calendario (compatible con Google Calendar, Outlook, iPhone, etc.).
  </p>
</body>
</html>
`;

fs.writeFileSync(OUTPUT_HTML, html, "utf8");
console.log(`✅ Archivo HTML generado: ${OUTPUT_HTML}`);
