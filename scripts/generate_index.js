// scripts/generate_index.js
const fs = require("fs");
const path = require("path");

const OUTPUT_HTML = "index.html";
const CALENDAR_DIR = "calendarios";
const ICON_DIR = path.join(CALENDAR_DIR, "icons");

// orden deseado de categorías (mayúsculas)
const CATEGORIES_ORDER = [
  "BENJAMÍN",
  "ALEVÍN",
  "INFANTIL",
  "CADETE",
  "JUVENIL",
  "JUNIOR",
  "SENIOR",
];

// orden de equipos preferido (mayúsculas normalizadas)
const TEAM_ORDER = [
  "LAS FLORES",
  "LAS FLORES MORADO",
  "LAS FLORES AMARILLO",
  "LAS FLORES PÚRPURA",
  "LAS FLORES ALBERO",
];

// mapa de iconos esperados (clave normalizada)
const DEFAULT_ICON = "flores.svg";
function normKey(s) {
  return (s || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toUpperCase();
}

function loadIcons() {
  const icons = {};
  if (!fs.existsSync(ICON_DIR)) return icons;
  const files = fs.readdirSync(ICON_DIR);
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (![".svg", ".png", ".jpg", ".jpeg", ".webp"].includes(ext)) continue;
    const name = path.basename(f, ext);
    const key = normKey(name);
    icons[key] = path.join("calendarios", "icons", f);
  }
  return icons;
}

// lee archivos .ics y agrupa por categoría y competición
function collectCalendars() {
  const icons = loadIcons();
  if (!fs.existsSync(CALENDAR_DIR)) return {};

  const files = fs.readdirSync(CALENDAR_DIR).filter(f => f.toLowerCase().endsWith(".ics"));
  const data = {};

  for (const file of files) {
    const lower = file.toLowerCase();

    // competición
    const competition = lower.includes("imd") ? "IMD" : "FEDERADO";

    // identificar categoría posible en nombre de archivo (busca palabras conocidas)
    let category = CATEGORIES_ORDER.find(cat =>
      lower.includes(cat.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase())
    );
    if (!category) {
      // intenta extraer token que parezca categoría
      const tryMatch = lower.match(/_(benjamin|alevin|infantil|cadete|juvenil|junior|senior)[_\.\-]/i);
      category = tryMatch ? tryMatch[1].toUpperCase() : "OTROS";
    }

    // obtener parte correspondiente al equipo
    // quitamos prefijos comunes y sufijos
    let candidate = file.replace(/(imd|federado|femenino|masculino|_?\.?ics)/gi, " ");
    candidate = candidate.replace(/[_\-.]+/g, " ").trim();

    // normalizamos y tratamos de mapear a alguno de TEAM_ORDER
    const normCandidate = normKey(candidate);

    let matchedTeam = TEAM_ORDER.find(t => normCandidate.includes(normKey(t)));
    if (!matchedTeam) {
      // heurística: buscar cualquier token 'FLORES' y si aparece, tratar de detectar color
      if (normCandidate.includes("FLORES")) {
        if (normCandidate.includes("MORADO")) matchedTeam = "LAS FLORES MORADO";
        else if (normCandidate.includes("AMARILLO")) matchedTeam = "LAS FLORES AMARILLO";
        else if (normCandidate.includes("PURPURA") || normCandidate.includes("PÚRPURA")) matchedTeam = "LAS FLORES PÚRPURA";
        else if (normCandidate.includes("ALBERO")) matchedTeam = "LAS FLORES ALBERO";
        else matchedTeam = "LAS FLORES";
      } else {
        matchedTeam = candidate; // fallback: el propio texto
      }
    }

    if (!data[category]) {
      data[category] = { FEDERADO: [], IMD: [] };
    }

    // icono: buscar por clave normalizada en icons; si no, usar default
    const iconKey = normKey(matchedTeam);
    const iconsMap = loadIcons(); // recarga possible, cheap
    const iconPath = iconsMap[iconKey] || iconsMap["LAS FLORES"] || path.join("calendarios","icons", DEFAULT_ICON);

    data[category][competition].push({
      originalFile: file,
      team: matchedTeam,
      href: path.join(CALENDAR_DIR, file),
      icon: iconPath,
    });
  }

  // Ordenar categorías según CATEGORIES_ORDER y dentro de cada compet por TEAM_ORDER
  for (const cat of Object.keys(data)) {
    for (const comp of ["FEDERADO", "IMD"]) {
      data[cat][comp].sort((a, b) => {
        const ai = TEAM_ORDER.indexOf(a.team);
        const bi = TEAM_ORDER.indexOf(b.team);
        if (ai === -1 && bi === -1) return a.team.localeCompare(b.team);
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });
    }
  }

  return data;
}

function generateHTML(calendars) {
  const icons = loadIcons();

  let html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Calendarios - C.D. Las Flores</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<h1>Calendarios C.D. Las Flores</h1>
`;

  // siempre recorrer en el orden deseado (incluir categorías vacías)
  for (const cat of CATEGORIES_ORDER) {
    const catData = calendars[cat] || { FEDERADO: [], IMD: [] };
    html += `<section class="category-block"><h2>${cat}</h2>`;

    for (const comp of ["FEDERADO", "IMD"]) {
      const teams = catData[comp] || [];
      if (teams.length === 0) {
        // mostramos el encabezado aunque no haya equipos, para mantener la estructura
        html += `<div class="competition"><h3>${comp}</h3><p class="empty">— sin calendarios —</p></div>`;
        continue;
      }

      html += `<div class="competition"><h3>${comp}</h3><ul class="team-list">`;
      for (const t of teams) {
        const icon = t.icon && fs.existsSync(t.icon) ? t.icon : (icons["LAS FLORES"] || path.join("calendarios","icons", DEFAULT_ICON));
        html += `<li class="team-item"><img src="${icon}" alt="${t.team}" class="team-icon" /><a href="${t.href}">${t.team}</a></li>`;
      }
      html += `</ul></div>`;
    }

    html += `</section>`;
  }

  html += `</body></html>`;
  fs.writeFileSync(OUTPUT_HTML, html, "utf-8");
  console.log("✅ index.html generado");
}

// MAIN
(function main() {
  try {
    const calendars = collectCalendars();
    generateHTML(calendars);
  } catch (err) {
    console.error("ERROR generando index:", err);
    process.exit(1);
  }
})();
