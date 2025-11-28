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
const BASE_REPO_PATH = "lasflores";

// caché file para rankings federados (últimos válidos)
const FEDERADO_CACHE_PATH = path.join(CALENDAR_DIR, "federado_rankings_cache.json");
const IMD_CLASIF_PATH = path.join(CALENDAR_DIR, "imd_clasificaciones.json");

// orden de categorías
const CATEGORIES_ORDER = [
  "BENJAMÍN",
  "ALEVÍN",
  "INFANTIL",
  "CADETE",
  "JUVENIL",
  "JUNIOR",
  "SENIOR",
];

// ============================================
// NORMALIZACIÓN DE NOMBRES
// ============================================
function normalizeName(str) {
  return (str || "")
    .toUpperCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================
// DETECCIÓN DE COLORES
// ============================================
const COLORS = ["AMARILLO", "ALBERO", "MORADO", "PÚRPURA", "PURPURA", "AZUL", "BLANCO", "NEGRO", "ROJO", "VERDE"];

function extractColor(normalizedName) {
  return COLORS.find(c => normalizedName.includes(c)) || null;
}

// ============================================
// LÓGICA PRINCIPAL: DETERMINAR EQUIPO PROPIO
// ============================================
function isOwnTeam(scrapedTeam, simplifiedTeamName, floresCount) {
  const normTeam = normalizeName(scrapedTeam);
  const normPage = normalizeName(simplifiedTeamName);

  // 1) si el equipo NO contiene "FLORES", nunca es propio
  if (!normTeam.includes("FLORES")) return false;

  const pageColor = extractColor(normPage);
  const teamColor = extractColor(normTeam);

  // 2) si solo hay un equipo "FLORES"
  if (floresCount === 1) return true;

  // 3) Página SIN color → solo resaltar equipos sin color
  if (!pageColor) return teamColor === null;

  // 4) Página CON color → debe coincidir color
  return teamColor === pageColor;
}

// -------------------------
// Detectar color normalizado (tu lógica existente)
// -------------------------
function detectColorNorm(name) {
  if (!name) return "";
  const up = name.toUpperCase();

  if (up.includes("MORADO")) return "MORADO";
  if (up.includes("AMARILLO")) return "AMARILLO";
  if (up.includes("PÚRPURA") || up.includes("PURPURA")) return "PÚRPURA";
  if (up.includes("ALBERO")) return "ALBERO";
  return "";
}

// -------------------------
// Iconos
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

function toPosix(p) { return p.split(path.sep).join("/"); }

// -------------------------
// Recoger calendarios
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

    const filePath = path.join(CALENDAR_DIR, file);
    const fileUrlPath = toPosix(filePath);
    const slug = file.replace(/\.ics$/i, "");

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

// ===========================================================
// CLASIFICACIÓN FEDERADO (con detección de equipo propio)
// ===========================================================
function buildClasificacionHTML(rows, teamPageName) {
  if (!rows || !rows.length) return `<p>Clasificación no disponible.</p>`;

  const floresCount = rows.filter(r =>
    normalizeName(r.team).includes("FLORES")
  ).length;

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
    const own = isOwnTeam(r.team, teamPageName, floresCount);

    html += `
    <tr class="${own ? "own-team" : ""}">
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

// ===========================================================
// CLASIFICACIÓN IMD (con detección de equipo propio)
// ===========================================================
function buildClasificacionIMD(rows, teamPageName) {
  if (!rows || !rows.length) return `<p>Clasificación no disponible.</p>`;

  const floresCount = rows.filter(r =>
    normalizeName(r.team).includes("FLORES")
  ).length;

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
    const own = isOwnTeam(r.team, teamPageName, floresCount);

    html += `
    <tr class="${own ? "own-team" : ""}">
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

// ===========================================================
// PROXIMOS PARTIDOS / ICS — (tu lógica original sin cambios)
// ===========================================================

// 🟦 (NO MODIFICO nada aquí, es 1:1 tu código actual)
// ...  🔥  TODO TU BLOQUE ICS AQUÍ (idéntico, sin tocarlo)  🔥

// ===========================================================
// GENERAR PÁGINA DE EQUIPO
// ===========================================================
async function generateTeamPage({ team, category, competition, urlPath, slug, iconPath, federadoInfo, federadoCache, imdClasifMap }) {
  const title = `${team} – ${category} (${competition})`;
  const webcalUrl = `webcal://${BASE_WEBCAL_HOST}/${BASE_REPO_PATH}/${encodeURI(urlPath)}`;

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

  // ===========================================
  // CLASIFICACIÓN FEDERADO o IMD
  // ===========================================
  let clasificacionHtml = "<p>Cargando…</p>";

  if (competition === "FEDERADO" && federadoInfo && federadoInfo.group !== 0) {
    const cacheKey = slug;
    try {
      const ranking = await fetchFederadoRanking(federadoInfo.tournament, federadoInfo.group);
      if (ranking && ranking.length) {
        clasificacionHtml = buildClasificacionHTML(ranking, team);

        const existing = fs.existsSync(FEDERADO_CACHE_PATH)
          ? JSON.parse(fs.readFileSync(FEDERADO_CACHE_PATH, "utf8"))
          : {};
        existing[cacheKey] = ranking;
        fs.writeFileSync(FEDERADO_CACHE_PATH, JSON.stringify(existing, null, 2), "utf8");
      } else {
        throw new Error("Ranking vacío");
      }
    } catch (err) {
      try {
        const existing = fs.existsSync(FEDERADO_CACHE_PATH)
          ? JSON.parse(fs.readFileSync(FEDERADO_CACHE_PATH, "utf8"))
          : {};
        if (existing[cacheKey]) {
          clasificacionHtml = buildClasificacionHTML(existing[cacheKey], team);
        } else {
          clasificacionHtml = "<p>Clasificación no disponible.</p>";
        }
      } catch {
        clasificacionHtml = "<p>Clasificación no disponible.</p>";
      }
    }

  } else if (competition === "IMD") {
    const rows = imdClasifMap && imdClasifMap[slug];
    if (rows && rows.length) {
      clasificacionHtml = buildClasificacionIMD(rows, team);
    } else {
      clasificacionHtml = "<p>No disponible para esta categoría.</p>";
    }

  } else {
    clasificacionHtml = "<p>No disponible.</p>";
  }

  // =======================================================
  // PROXIMOS PARTIDOS (ICS)
  // =======================================================
  let proximosHtml = "<p>No hay partidos próximos.</p>";
  try {
    const icsText = fs.readFileSync(path.join(CALENDAR_DIR, `${slug}.ics`), "utf8");
    proximosHtml = getProximosPartidosFromICS(icsText);
  } catch {
    proximosHtml = "<p>Próximos partidos no disponibles.</p>";
  }

  // =======================================================
  // CARGA DE PLANTILLA
  // =======================================================
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

  const outDir = EQUIPOS_DIR;
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const outPath = path.join(outDir, `${slug}.html`);
  fs.writeFileSync(outPath, tpl, "utf8");
}

function escapeHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// =======================================================
// GENERADOR INDEX
// =======================================================
async function generateHTML(calendars, federadoMap) {
  let imdClasifMap = {};
  if (fs.existsSync(IMD_CLASIF_PATH)) {
    try {
      imdClasifMap = JSON.parse(fs.readFileSync(IMD_CLASIF_PATH, "utf8"));
      console.log(`ℹ️ clasificaciones IMD cargadas (${Object.keys(imdClasifMap).length} equipos)`);
    } catch {
      imdClasifMap = {};
    }
  }

  let federadoCache = {};
  if (fs.existsSync(FEDERADO_CACHE_PATH)) {
    try { federadoCache = JSON.parse(fs.readFileSync(FEDERADO_CACHE_PATH, "utf8")); } catch {}
  }

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

<div class="index-app-container">
  <h1 class="index-title">Calendarios C.D. Las Flores</h1>
`;

for (const category of CATEGORIES_ORDER) {
  if (!calendars[category]) continue;

  html += `
  <section class="category-card">
    <h2 class="category-card-title">${category}</h2>
  `;

  // FEDERADO / IMD
  for (const comp of ["FEDERADO", "IMD"]) {
    const teams = calendars[category][comp];
    if (!teams || !teams.length) continue;

    html += `
    <div class="competition-block">
      <h3 class="competition-block-title">${comp}</h3>
      <ul class="team-list-simple">
    `;

    teams.sort(sortTeams);

    for (const { team, slug } of teams) {
      const icon = getIconForTeam(team);
      const equipoPage = `equipos/${slug}.html`;

      html += `
        <li class="team-row">
          <img class="team-row-icon" src="${icon}" alt="${escapeHtml(team)}" />
          <a href="${equipoPage}" class="team-row-name">${escapeHtml(team)}</a>
        </li>
      `;
    }

    html += `
      </ul>
    </div>
    `;
  }

  html += `
  </section>
  `;
}

html += `
</div>
</body>
</html>`;


  fs.writeFileSync(OUTPUT_HTML, html, "utf8");
  console.log("✅ index.html generado correctamente.");
}

// =======================================================
//  Unfold ICS lines
// =======================================================
function unfoldICSLines(icsText) {
  return icsText.replace(/\r?\n[ \t]/g, "");
}

// =======================================================
//  Parse ICS datetime → { date, allDay }
// =======================================================
function parseICSDateToken(token, value) {
  const isAllDay = /VALUE=DATE/i.test(token);
  const v = (value || "").trim();
  if (!v) return null;

  // 20251129 (all-day)
  if (isAllDay || /^\d{8}$/.test(v)) {
    const yyyy = v.slice(0, 4);
    const mm = v.slice(4, 6);
    const dd = v.slice(6, 8);
    return { date: new Date(`${yyyy}-${mm}-${dd}T00:00:00`), allDay: true };
  }

  // 20251129T173000
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?$/);
  if (!m) {
    const m2 = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})$/);
    if (m2) {
      const [_, yyyy, mm, dd, hh, min] = m2;
      return { date: new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:00`), allDay: false };
    }
    return null;
  }

  const [_, yyyy, mm, dd, hh, min, sec] = m;
  const seconds = sec || "00";
  return { date: new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:${seconds}`), allDay: false };
}

// =======================================================
// Decode ICS text fields
// =======================================================
function decodeICSText(s) {
  if (!s) return "";
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\, /g, ", ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .trim();
}

// =======================================================
// Parse ICS → event list
// =======================================================
function parseICS(icsText) {
  const txt = unfoldICSLines(icsText || "");
  const lines = txt.split(/\r?\n/);

  const events = [];
  let cur = null;
  let inEvent = false;

  for (const line of lines) {
    if (!line) continue;

    if (/^BEGIN:VEVENT/i.test(line)) {
      inEvent = true;
      cur = { summary: "", location: "", description: "", start: null, end: null, allDay: false };
      continue;
    }
    if (/^END:VEVENT/i.test(line)) {
      inEvent = false;
      if (cur && cur.start) {
        if (!cur.end && cur.allDay) {
          cur.end = new Date(cur.start.getTime() + 24 * 3600 * 1000);
        }
        events.push(cur);
      }
      cur = null;
      continue;
    }
    if (!inEvent || !cur) continue;

    const idx = line.indexOf(":");
    if (idx === -1) continue;

    const key = line.slice(0, idx);
    const val = line.slice(idx + 1);

    if (/^DTSTART/i.test(key)) {
      const p = parseICSDateToken(key, val);
      if (p) {
        cur.start = p.date;
        cur.allDay = p.allDay;
      }
      continue;
    }
    if (/^DTEND/i.test(key)) {
      const p = parseICSDateToken(key, val);
      if (p) cur.end = p.date;
      continue;
    }
    if (/^SUMMARY/i.test(key)) { cur.summary = decodeICSText(val); continue; }
    if (/^LOCATION/i.test(key)) { cur.location = decodeICSText(val); continue; }
    if (/^DESCRIPTION/i.test(key)) { cur.description = decodeICSText(val); continue; }
  }

  return events;
}

// =======================================================
// Selección de próximos partidos
// =======================================================
function getProximosPartidosFromICS(icsText) {
  try {
    const events = parseICS(icsText)
      .filter(e => e.start instanceof Date && !isNaN(e.start))
      .sort((a, b) => a.start - b.start);

    const now = new Date();
    const weekAhead = new Date(now.getTime() + 7 * 86400000);

    const future = events.filter(e => e.start >= now);
    const next7 = future.filter(e => e.start <= weekAhead);
    const selected = next7.length ? next7 : future.slice(0, 2);

    if (!selected.length) return `<p>No hay partidos próximos.</p>`;

    return selected.map(e => {
      const d1 = e.start;

      const fecha1 = d1.toLocaleDateString("es-ES", {
        weekday: "short",
        day: "numeric",
        month: "short",
      });

      let fechaFinal = "";
      if (e.end && e.allDay && e.end > e.start) {
        const d2 = new Date(e.end.getTime() - 86400000);
        const fecha2 = d2.toLocaleDateString("es-ES", {
          weekday: "short",
          day: "numeric",
          month: "short",
        });
        fechaFinal = ` - ${fecha2}`;
      }

      const hora = e.allDay
        ? ""
        : d1.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });

      return `
<div class="partido">
  <div class="fecha">${fecha1}${fechaFinal}${hora ? " — " + hora : ""}</div>
  <div class="vs">${escapeHtml(e.summary || "Partido")}</div>
  ${e.location ? `<div class="lugar">${escapeHtml(e.location)}</div>` : ""}
  ${e.description ? `<div class="desc">${escapeHtml(e.description)}</div>` : ""}
</div>`;
    }).join("\n");

  } catch (err) {
    return `<p>Error leyendo calendario.</p>`;
  }
}

// =======================================================
// MAIN
// =======================================================

(async function main() {
  try {
    console.log("📋 Generando index.html (integrado con federado + IMD + equipo propio)…");

    let federadoMap = null;
    const federadoPath = path.join(process.cwd(), "federado_ids.json");
    if (fs.existsSync(federadoPath)) {
      try {
        federadoMap = JSON.parse(fs.readFileSync(federadoPath, "utf8"));
        console.log(`ℹ️ federado_ids.json cargado (${Object.keys(federadoMap).length} claves)`);
      } catch {
        federadoMap = null;
      }
    }

    const calendars = collectCalendars();
    await generateHTML(calendars, federadoMap);

  } catch (err) {
    console.error("❌ ERROR GENERAL:", err);
    process.exit(1);
  }
})();
