// scripts/generate_index_html.js
// Generador de index + páginas /equipos/
// Lee calendarios/*.ics, genera index.html y equipos/<slug>.html
// Integra: federado_ids.json, calendarios/imd_clasificaciones.json
// Añade caché para clasificaciones federadas (calendarios/federado_rankings_cache.json)

const { fetchFederadoRanking } = require("./fetch_federado_ranking");
const fs = require("fs");
const path = require("path");
const { normalizeTeamDisplay } = require("./team_name_utils");

const OUTPUT_HTML = "index.html";
const CALENDAR_DIR = "calendarios";
const EQUIPOS_DIR = "equipos";
const TEMPLATE_DIR = "templates";
const BASE_WEBCAL_HOST = "dplmrdp.github.io";
const BASE_REPO_PATH = "lasflores"; // repo/site path

// caché file para rankings federados (últimos válidos)
const FEDERADO_CACHE_PATH = path.join(CALENDAR_DIR, "federado_rankings_cache.json");
const IMD_CLASIF_PATH = path.join(CALENDAR_DIR, "imd_clasificaciones.json");

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
// Tabla de iconos (rutas relativas desde repo root)
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
  const up = (team || "").toUpperCase();
  const isEVB = up.startsWith("EVB");
  const color = detectColorNorm(up);

  const keyExact = (isEVB ? "EVB " : "") + "LAS FLORES" + (color ? ` ${color}` : "");
  if (TEAM_ICONS[keyExact]) return TEAM_ICONS[keyExact];

  const keyBase = "LAS FLORES" + (color ? ` ${color}` : "");
  if (TEAM_ICONS[keyBase]) return TEAM_ICONS[keyBase];

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

// -------------------------
// Util: convertir path a URL-friendly (posix)
function toPosix(p) {
  return p.split(path.sep).join("/");
}

// -------------------------
// Recopilar ficheros .ics
// -------------------------
function collectCalendars() {
  if (!fs.existsSync(CALENDAR_DIR)) return {};
  const allFiles = fs.readdirSync(CALENDAR_DIR).filter(f => f.toLowerCase().endsWith(".ics"));
  const data = {};

  for (const file of allFiles) {
    const competition = file.toLowerCase().startsWith("federado_") ? "FEDERADO" : "IMD";

    const category = detectCategoryFromFilename(file);

    const clean = file
      .replace(/^federado_/, "")
      .replace(/^imd_/, "")
      .replace(/\.ics$/i, "")
      .replace(/_/g, " ")
      .toUpperCase();

    const rawName = clean.replace(category.toUpperCase(), "").trim();
    const pretty = normalizeTeamDisplay(rawName);

    const filePath = path.join(CALENDAR_DIR, file); // filesystem path
    const fileUrlPath = toPosix(filePath); // url path with forward slashes
    const slug = file.replace(/\.ics$/i, ""); // filename without extension

    if (!data[category]) data[category] = { FEDERADO: [], IMD: [] };

    data[category][competition].push({
      team: pretty,
      path: filePath,
      urlPath: fileUrlPath,
      filename: file,
      slug: slug,
    });
  }

  return data;
}

// -------------------------
// PLACEHOLDERS (clasificación y próximos partidos)
// -------------------------
function buildClasificacionHTML(rows) {
  if (!rows || !rows.length) {
    return `<p>Clasificación no disponible.</p>`;
  }

  let html = `
<table class="clasificacion">
  <thead>
    <tr>
      <th>Equipo</th>
      <th>PTS</th>
      <th>PJ</th>
      <th>PG</th>
      <th>PP</th>
      <th>SG</th>
      <th>SP</th>
    </tr>
  </thead>
  <tbody>
`;

  for (const r of rows) {
    html += `
    <tr>
      <td>${escapeHtml(r.team)}</td>
      <td>${r.pts}</td>
      <td>${r.pj}</td>
      <td>${r.pg}</td>
      <td>${r.pp}</td>
      <td>${r.sg}</td>
      <td>${r.sp}</td>
    </tr>`;
  }

  html += `
  </tbody>
</table>`;

  return html;
}

// -------------------------
// Build IMD classification (compact)
// -------------------------
function buildClasificacionIMD(rows) {
  if (!rows || !rows.length) return `<p>Clasificación no disponible.</p>`;

  // compact variant: no team column header repeated, fewer paddings
  let html = `
<table class="clasificacion compact">
  <thead>
    <tr>
      <th>Equipo</th>
      <th>PTS</th>
      <th>PJ</th>
      <th>PG</th>
      <th>PP</th>
      <th>SG</th>
      <th>SP</th>
    </tr>
  </thead>
  <tbody>
`;

  for (const r of rows) {
    html += `
    <tr>
      <td>${escapeHtml(r.team)}</td>
      <td>${r.pts}</td>
      <td>${r.pj}</td>
      <td>${r.pg}</td>
      <td>${r.pp}</td>
      <td>${r.sg}</td>
      <td>${r.sp}</td>
    </tr>`;
  }

  html += `
  </tbody>
</table>`;

  return html;
}

function buildPlaceholderProximos(team) {
  return `
<div class="partido">
  <div class="fecha">Sáb 18 — 12:00</div>
  <div class="vs">${escapeHtml(team)} vs Rival X</div>
</div>
<div class="partido">
  <div class="fecha">Dom 19 — 10:00</div>
  <div class="vs">Rival Y vs ${escapeHtml(team)}</div>
</div>`;
}

// -------------------------
// GENERAR PÁGINA INDIVIDUAL
// Ahora acepta imdClasifMap y federadoCache para fallback
// -------------------------
async function generateTeamPage({ team, category, competition, urlPath, slug, iconPath, federadoInfo, federadoCache, imdClasifMap }) {
  const title = `${team} – ${category} (${competition})`;
  const webcalUrl = `webcal://${BASE_WEBCAL_HOST}/${BASE_REPO_PATH}/${encodeURI(urlPath)}`;

  // URLs oficiales (si existen)
  let rankingUrl = "";
  let calendarOfficialUrl = "";
  if (federadoInfo && federadoInfo.tournament && federadoInfo.group) {
    const t = federadoInfo.tournament;
    const g = federadoInfo.group;
    if (Number(g) !== 0) {
      rankingUrl = `https://favoley.es/es/tournament/${t}/ranking/${g}`;
      calendarOfficialUrl = `https://favoley.es/es/tournament/${t}/calendar/${g}/all`;
    } else {
      calendarOfficialUrl = `https://favoley.es/es/tournament/${t}/calendar/`;
    }
  }

  // ================================
  // CLASIFICACIÓN
  // ================================
  let clasificacionHtml = "<p>Cargando…</p>";

  if (competition === "FEDERADO" && federadoInfo && federadoInfo.group !== 0) {
    const cacheKey = slug; // usamos slug como clave en el caché
    // Intentar descargar clasificación oficial (live)
    try {
      const ranking = await fetchFederadoRanking(federadoInfo.tournament, federadoInfo.group);
      if (ranking && ranking.length) {
        clasificacionHtml = buildClasificacionHTML(ranking);
        // guardar en caché local
        try {
          const existing = fs.existsSync(FEDERADO_CACHE_PATH) ? JSON.parse(fs.readFileSync(FEDERADO_CACHE_PATH, "utf8")) : {};
          existing[cacheKey] = ranking;
          fs.writeFileSync(FEDERADO_CACHE_PATH, JSON.stringify(existing, null, 2), "utf8");
        } catch (e) {
          console.warn("⚠️ No se pudo guardar caché federado:", e && e.message ? e.message : e);
        }
      } else {
        // si la descarga no devuelve nada, usar caché si existe
        throw new Error("Ranking vacío");
      }
    } catch (err) {
      // fallback a caché si existe
      try {
        const existing = fs.existsSync(FEDERADO_CACHE_PATH) ? JSON.parse(fs.readFileSync(FEDERADO_CACHE_PATH, "utf8")) : {};
        if (existing && existing[cacheKey]) {
          clasificacionHtml = buildClasificacionHTML(existing[cacheKey]);
        } else {
          clasificacionHtml = "<p>Clasificación no disponible.</p>";
        }
      } catch (e) {
        clasificacionHtml = "<p>Clasificación no disponible.</p>";
      }
    }
  } else if (competition === "IMD") {
    // buscar en imdClasifMap por clave = slug
    const rows = imdClasifMap && imdClasifMap[slug];
    if (rows && rows.length) {
      clasificacionHtml = buildClasificacionIMD(rows);
    } else {
      clasificacionHtml = "<p>No disponible para esta categoría.</p>";
    }
  } else {
    clasificacionHtml = "<p>No disponible.</p>";
  }

  // ================================
  // PRÓXIMOS PARTIDOS (ICS)
  // ================================
  let proximosHtml = "<p>No hay partidos próximos.</p>";
  try {
    const icsText = fs.readFileSync(path.join(CALENDAR_DIR, `${slug}.ics`), "utf8");
    proximosHtml = getProximosPartidosFromICS(icsText);
  } catch (e) {
    proximosHtml = "<p>Próximos partidos no disponibles.</p>";
  }

  // ================================
  // CARGAR PLANTILLA
  // ================================
  const templatePath = path.join(TEMPLATE_DIR, "equipo.html");
  let tpl = fs.readFileSync(templatePath, "utf8");

  tpl = tpl
    .replace(/{{title}}/g, escapeHtml(title))
    .replace(/{{team}}/g, escapeHtml(team))
    .replace(/{{category}}/g, escapeHtml(category))
    .replace(/{{competition}}/g, escapeHtml(competition))
    .replace(/{{icon}}/g, iconPath)
    .replace(/{{webcal}}/g, webcalUrl)
    .replace(/{{clasificacion}}/g, clasificacionHtml)
    .replace(/{{proximosPartidos}}/g, proximosHtml);

  // generar archivo HTML
  const outDir = EQUIPOS_DIR;
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const outPath = path.join(outDir, `${slug}.html`);
  fs.writeFileSync(outPath, tpl, "utf8");
}

// -------------------------
// Escapar HTML simple
// -------------------------
function escapeHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// -------------------------
// Generar HTML principal (index)
// -------------------------
async function generateHTML(calendars, federadoMap) {
  // cargar IMD clasificaciones (si existen)
  let imdClasifMap = {};
  if (fs.existsSync(IMD_CLASIF_PATH)) {
    try {
      imdClasifMap = JSON.parse(fs.readFileSync(IMD_CLASIF_PATH, "utf8"));
      console.log(`ℹ️ clasificaciones IMD cargadas (${Object.keys(imdClasifMap).length} equipos)`);
    } catch (e) {
      console.warn("⚠️ No se pudo parsear imd_clasificaciones.json:", e.message);
      imdClasifMap = {};
    }
  } else {
    console.log("ℹ️ imd_clasificaciones.json no encontrado — las páginas IMD no mostrarán clasificaciones.");
  }

  // cargar caché federado (si existe)
  let federadoCache = {};
  if (fs.existsSync(FEDERADO_CACHE_PATH)) {
    try { federadoCache = JSON.parse(fs.readFileSync(FEDERADO_CACHE_PATH, "utf8")); } catch (e) { federadoCache = {}; }
  }

  // Asegurar carpeta equipos existencia (vacía/creada)
  if (!fs.existsSync(EQUIPOS_DIR)) fs.mkdirSync(EQUIPOS_DIR, { recursive: true });

  let html = `<!DOCTYPE html>
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

      for (const { team, path: filePath, urlPath, filename, slug } of teams) {
        const icon = getIconForTeam(team);

        // link to team page (opción A: slug = filename without .ics)
        const equipoPage = `equipos/${slug}.html`;

        // buscar mapping federado por clave = filename sin .ics
        const key = slug;
        const federadoInfo = (federadoMap && federadoMap[key]) ? federadoMap[key] : null;

        // 🔍 DEBUG: comprobar si federadoInfo existe
        if (comp === "FEDERADO" && !federadoInfo) {
          console.log(`ℹ️ federado_ids.json: no mapping for key="${key}" (file=${filename})`);
        }

        // generar la página individual también, pasándole imdClasifMap y federadoCache
        await generateTeamPage({
          team: team,
          category,
          competition: comp,
          urlPath,
          slug,
          iconPath: icon,
          federadoInfo,
          federadoCache,
          imdClasifMap
        });

        html += `
<li class="team-item">
  <img class="team-icon" src="${icon}" alt="${escapeHtml(team)}" />
  <a class="team-link" href="${equipoPage}">${escapeHtml(team)}</a>
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

// -------------------------
// MAIN (async)
// -------------------------
(async function main() {
  try {
    console.log("📋 Generando index.html con nombres normalizados y páginas /equipos/ (integrando federado_ids.json y clasificaciones IMD) ...");

    // intentar cargar federado_ids.json si existe
    let federadoMap = null;
    const federadoPath = path.join(process.cwd(), "federado_ids.json");
    if (fs.existsSync(federadoPath)) {
      try {
        federadoMap = JSON.parse(fs.readFileSync(federadoPath, "utf8"));
        console.log(`ℹ️ federado_ids.json cargado (${Object.keys(federadoMap).length} claves)`);
      } catch (e) {
        console.warn("⚠️ No se pudo parsear federado_ids.json:", e.message);
        federadoMap = null;
      }
    } else {
      console.log("ℹ️ federado_ids.json no encontrado — se generarán páginas sin enlaces a clasificación oficial.");
    }

    const calendars = collectCalendars();
    await generateHTML(calendars, federadoMap);

  } catch (err) {
    console.error("❌ ERROR GENERAL:", err);
    process.exit(1);
  }
})();

// -------------------------
// getProximosPartidosFromICS (reutilizada - debe existir en tu proyecto)
// -------------------------
// Si ya la tienes en otro módulo, puedes requirearla;
// aquí asumo que tu repo ya tiene esa función en scope (como en tu parser).
// Si no la tienes, deja que te la pegue también; por ahora se asume presente.

