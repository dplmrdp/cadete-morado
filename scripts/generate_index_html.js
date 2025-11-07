// scripts/generate_index_html.js
// Genera automáticamente el index.html con enlaces a todos los calendarios .ics
// Agrupa por categoría y ordena por edad: Benjamín → Alevín → Infantil → Cadete → Juvenil → Senior

const fs = require("fs");
const path = require("path");

const CAL_DIR = path.join("calendarios");
const OUT_FILE = "index.html";

// Orden de categorías por edad (normalizadas)
const ORDER = ["BENJAMIN", "ALEVIN", "INFANTIL", "CADETE", "JUVENIL", "SENIOR"];

function normalize(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

// Leer todos los archivos .ics del directorio
const files = fs
  .readdirSync(CAL_DIR)
  .filter((f) => f.endsWith(".ics") && !f.includes("debug") && !f.startsWith("."))
  .sort();

// Mapear categorías → equipos
const categorias = {};

for (const file of files) {
  const fullName = file.replace(".ics", "");
  const fullPath = path.join(CAL_DIR, file);

  // Detectar si es federado
  if (normalize(fullName).includes("FEDERADO")) {
    if (!categorias["FEDERADO"]) categorias["FEDERADO"] = [];
    categorias["FEDERADO"].push({ name: fullName, path: fullPath });
    continue;
  }

  // Detectar categoría según el nombre
  let cat = "OTROS";
  for (const c of ORDER) {
    if (normalize(fullName).includes(c)) {
      cat = c.charAt(0) + c.slice(1).toLowerCase(); // ejemplo: "CADETE" → "Cadete"
      break;
    }
  }

  if (!categorias[cat]) categorias[cat] = [];
  categorias[cat].push({ name: fullName, path: fullPath });
}

// Ordenar categorías según el orden definido (Benjamín → Senior), federado siempre primero
const orderedCats = Object.keys(categorias).sort((a, b) => {
  if (a === "FEDERADO") return -1;
  if (b === "FEDERADO") return 1;

  const ai = ORDER.indexOf(normalize(a));
  const bi = ORDER.indexOf(normalize(b));
  if (ai === -1 && bi === -1) return a.localeCompare(b);
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
});

// Generar HTML
let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>🏐 Calendarios C.D. Las Flores Sevilla</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 40px; background: #fafafa; color: #222; }
    h1 { color: #800080; }
    h2 { color: #444; margin-top: 2em; border-bottom: 2px solid #ddd; padding-bottom: 0.2em; }
    ul { list-style-type: none; padding-left: 0; }
    li { margin: 6px 0; }
    a { text-decoration: none; color: #0055cc; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>🏐 Calendarios C.D. Las Flores Sevilla</h1>
  <p>Suscríbete directamente a los calendarios de los equipos del club:</p>
`;

for (const cat of orderedCats) {
  const equipos = categorias[cat];

  if (cat === "FEDERADO") {
    html += `
  <h2>🏆 ${cat}</h2>
  <ul>
`;
  } else {
    html += `
  <h2>${cat}</h2>
  <ul>
`;
  }

  for (const eq of equipos) {
    const nameShown = eq.name.replace(/_/g, " ");
    html += `    <li><a href="${eq.path}">📅 ${nameShown}</a></li>\n`;
  }

  html += "  </ul>\n";
}

html += `
  <footer style="margin-top:3em; font-size:0.9em; color:#666;">
    Generado automáticamente por <b>update_calendars_imd_multi.js</b> — ${new Date().toLocaleString("es-ES")}
  </footer>
</body>
</html>
`;

// Escribir archivo
fs.writeFileSync(OUT_FILE, html, "utf8");

console.log(`✅ Archivo ${OUT_FILE} generado correctamente con ${files.length} calendarios.`);
