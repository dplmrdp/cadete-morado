// scripts/generate_index_html.js
// Genera index.html + páginas /equipos/
// Lee calendarios/*.ics, federado_ids.json y imd_clasificaciones.json

const fs = require("fs");
const path = require("path");
const { normalizeTeamDisplay } = require("./team_name_utils");
const { fetchFederadoRanking } = require("./fetch_federado_ranking");
const {
  getProximosPartidosFromICS
} = require("./ics_proximos_partidos_parser"); // <- tu parser nuevo

const OUTPUT_HTML = "index.html";
const CALENDAR_DIR = "calendarios";
const EQUIPOS_DIR = "equipos";
const TEMPLATE_DIR = "templates";
const BASE_WEBCAL_HOST = "dplmrdp.github.io";
const BASE_REPO_PATH = "lasflores";

const CATEGORIES_ORDER = [
  "BENJAMÍN",
  "ALEVÍN",
  "INFANTIL",
  "CADETE",
  "JUVENIL",
  "JUNIOR",
  "SENIOR",
];

// ---------------------------------------------------------------------------
// Detectar color normalizado
function detectColorNorm(name) {
  if (!name) return "";
  const up = name.toUpperCase();

  if (up.includes("MORADO")) return "MORADO";
  if (up.includes("AMARILLO")) return "AMARILLO";
  if (up.includes("PÚRPURA") || up.includes("PURPURA")) return "PÚRPURA";
  if (up.includes("ALBERO")) return "ALBERO";
  return "";
}

// Iconos
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

function getIconForTeam(team) {
  const up = (team || "").toUpperCase();
  const isEVB = up.startsWith("EVB");
  const color = detectColorNorm(up);

  const keyExact =
    (isEVB ? "EVB " : "") + "LAS FLORES" + (color ? ` ${color}` : "");
  if (TEAM_ICONS[keyExact]) return TEAM_ICONS[keyExact];

  const keyBase = "LAS FLORES" + (color ? ` ${color}` : "");
  if (TEAM_ICONS[keyBase]) return TEAM_ICONS[keyBase];

  return TEAM_ICONS["LAS FLORES"];
}

// ---------------------------------------------------------------------------
// Detectar categoría desde filename
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

// ---------------------------------------------------------------------------
// Ordenar equipos dentro de categoría
function sortTeams(a, b) {
  const A = (a.team || "").toUpperCase();
  const B = (b.team || "").toUpperCase();

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

function toPosix(p) {
  return p.split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// Recopilar calendarios
function collectCalendars() {
  if (!fs.existsSync(CALENDAR_DIR)) return {};

  const files = fs
    .readdirSync(CALENDAR_DIR)
    .filter((f) => f.toLowerCase().endsWith(".ics"));

  const acc = {};

  for (const file of files) {
    const competition =
      file.toLowerCase().startsWith("federado_") ? "FEDERADO" : "IMD";

    const category = detectCategoryFromFilename(file);

    const clean = file
      .replace(/^federado_/, "")
      .replace(/^imd_/, "")
      .replace(/\.ics$/i, "")
      .replace(/_/g, " ")
      .toUpperCase();

    const rawName = clean.replace(category.toUpperCase(), "").trim();
    const pretty = normalizeTeamDisplay(rawName);

    const filePath = path.join(CALENDAR_DIR, file);
    const slug = file.replace(/\.ics$/i, "");

    if (!acc[category]) acc[category] = { FEDERADO: [], IMD: [] };

    acc[category][competition].push({
      team: pretty,
      filename: file,
      slug,
      category,
      competition,
      pathFs: filePath,
      urlPath: toPosix(filePath),
    });
  }

  return acc;
}

// ---------------------------------------------------------------------------
// HTML clasificación federado
function buildClasificacionHTML(rows) {
  if (!rows || !rows.length) return "<p>Clasificación no disponible.</p>";

  let html = `
<table class="clasificacion">
  <thead>
    <tr>
      <th>Equipo</th><th>PTS</th><th>PJ</th><th>PG</th>
      <th>PP</th><th>SG</th><th>SP</th>
    </tr>
  </thead>
  <tbody>
`;

  for (const r of rows) {
    html += `
    <tr>
      <td>${r.team}</td>
      <td>${r.pts}</td>
      <td>${r.pj}</td>
      <td>${r.pg}</td>
      <td>${r.pp}</td>
      <td>${r.sg}</td>
      <td>${r.sp}</td>
    </tr>
`;
  }

  html += `</tbody></table>`;
  return html;
}

// ---------------------------------------------------------------------------
// HTML clasificación IMD
function buildClasificacionIMD(rows) {
  if (!rows || !rows.length)
    return "<p>Clasificación IMD no disponible.</p>";

  let html = `
<table class="clasificacion">
<thead>
<tr>
<th>Equipo</th><th>PJ</th><th>PG</th><th>PE</th><th>PP</th>
<th>PNP</th><th>JF</th><th>JC</th><th>TF</th><th>TC</th><th>PTS</th>
</tr>
</thead>
<tbody>
`;

  for (const r of rows) {
    html += `
<tr>
<td>${r.team}</td><td>${r.pj}</td><td>${r.pg}</td><td>${r.pe}</td>
<td>${r.pp}</td><td>${r.pnp}</td><td>${r.jf}</td><td>${r.jc}</td>
<td>${r.tf}</td><td>${r.tc}</td><td>${r.pts}</td>
</tr>
`;
  }

  html += "</tbody></table>";
  return html;
}

// ---------------------------------------------------------------------------
// Escapar HTML
function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Página individual de un equipo
async function generateTeamPage({
  team,
  category,
  competition,
  urlPath,
  slug,
  iconPath,
  federadoInfo,
  imdClasif,
}) {
  const title = `${team} – ${category} (${competition})`;
  const webcalUrl = `webcal://${BASE_WEBCAL_HOST}/${BASE_REPO_PATH}/${encodeURI(
    urlPath
  )}`;

  // Clasificación
  let clasificacionHtml = "<p>Cargando…</p>";

  if (competition === "FEDERADO" && federadoInfo) {
    try {
      const ranking = await fetchFederadoRanking(
        federadoInfo.tournament,
        federadoInfo.group
      );
      clasificacionHtml = ranking
        ? buildClasificacionHTML(ranking)
        : "<p>Clasificación no disponible.</p>";
    } catch {
      clasificacionHtml = "<p>Error cargando clasificación federada.</p>";
    }
  } else if (competition === "IMD") {
    clasificacionHtml = buildClasificacionIMD(imdClasif || []);
  } else {
    clasificacionHtml = "<p>No disponible.</p>";
  }

  // Próximos partidos
  const icsText = fs.readFileSync(
    path.join(CALENDAR_DIR, `${slug}.ics`),
    "utf8"
  );
  const proximosHtml = getProximosPartidosFromICS(icsText);

  // Plantilla
  const tplPath = path.join(TEMPLATE_DIR, "equipo.html");
  let tpl = fs.readFileSync(tplPath, "utf8");

  tpl = tpl
    .replace(/{{title}}/g, escapeHtml(title))
    .replace(/{{team}}/g, escapeHtml(team))
    .replace(/{{category}}/g, escapeHtml(category))
    .replace(/{{competition}}/g, escapeHtml(competition))
    .replace(/{{icon}}/g, iconPath)
    .replace(/{{webcal}}/g, webcalUrl)
    .replace(/{{clasificacion}}/g, clasificacionHtml)
    .replace(/{{proximosPartidos}}/g, proximosHtml);

  fs.mkdirSync(EQUIPOS_DIR, { recursive: true });
  fs.writeFileSync(path.join(EQUIPOS_DIR, `${slug}.html`), tpl, "utf8");
}

// ---------------------------------------------------------------------------
// Generar index + páginas
async function generateHTML(calendars, federadoMap, imdClasifMap) {
  let html = `
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Calendarios C.D. Las Flores</title>
<link rel="stylesheet" href="style.css">
<meta name="viewport" content="width=device-width,initial-scale=1">
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

      for (const t of teams) {
        const icon = getIconForTeam(t.team);

        // Clave IMD
        let imdClasif = null;
        if (comp === "IMD") {
          const key = `imd_${category}_${t.team}`
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_");
          imdClasif = imdClasifMap[key] || null;
        }

        const federadoInfo =
          comp === "FEDERADO" ? federadoMap[t.slug] || null : null;

        await generateTeamPage({
          team: t.team,
          category,
          competition: comp,
          urlPath: t.urlPath,
          slug: t.slug,
          iconPath: icon,
          federadoInfo,
          imdClasif,
        });

        html += `
<li class="team-item">
  <img class="team-icon" src="${icon}" alt="${escapeHtml(t.team)}" />
  <a class="team-link" href="equipos/${t.slug}.html">${escapeHtml(
          t.team
        )}</a>
</li>`;
      }

      html += `</ul></div>`;
    }

    html += `</section>`;
  }

  html += `
</div>
</body>
</html>`;

  fs.writeFileSync(OUTPUT_HTML, html, "utf8");
  console.log("✅ index.html generado correctamente.");
}

// ---------------------------------------------------------------------------
// MAIN
(async function main() {
  try {
    console.log(
      "📋 Generando index.html con clasificaciones (FEDERADO + IMD)..."
    );

    let federadoMap = null;
    const federadoPath = path.join("federado_ids.json");
    if (fs.existsSync(federadoPath)) {
      try {
        federadoMap = JSON.parse(fs.readFileSync(federadoPath, "utf8"));
        console.log(
          `ℹ️ federado_ids.json cargado (${Object.keys(federadoMap).length} claves)`
        );
      } catch {
        federadoMap = null;
      }
    }

    let imdClasifMap = {};
    const imdPath = path.join(CALENDAR_DIR, "imd_clasificaciones.json");
    if (fs.existsSync(imdPath)) {
      try {
        imdClasifMap = JSON.parse(fs.readFileSync(imdPath, "utf8"));
        console.log(
          `ℹ️ clasificaciones IMD cargadas (${Object.keys(imdClasifMap).length} equipos)`
        );
      } catch {
        console.log("⚠ No se pudo parsear imd_clasificaciones.json");
      }
    } else {
      console.log("ℹ No existen clasificaciones IMD previas");
    }

    const calendars = collectCalendars();
    await generateHTML(calendars, federadoMap || {}, imdClasifMap);
  } catch (err) {
    console.error("❌ ERROR GENERAL:", err);
    process.exit(1);
  }
})();
