// scripts/generate_index_html.js
// Generador de index + páginas /equipos/
// Lee calendarios/*.ics, genera index.html y equipos/<slug>.html
// Ahora además integra federado_ids.json y clasificaciones IMD.

const { fetchFederadoRanking } = require("./fetch_federado_ranking");
const fs = require("fs");
const path = require("path");
const { normalizeTeamDisplay } = require("./team_name_utils");

// -------------------------
// Constantes
// -------------------------
const OUTPUT_HTML = "index.html";
const CALENDAR_DIR = "calendarios";
const EQUIPOS_DIR = "equipos";
const TEMPLATE_DIR = "templates";
const BASE_WEBCAL_HOST = "dplmrdp.github.io";
const BASE_REPO_PATH = "lasflores";

// Orden de categorías en el HTML
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
// Categoría desde nombre fichero
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
// Ordenar equipos
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

function toPosix(p) {
  return p.split(path.sep).join("/");
}

// -------------------------
// Recopilar calendarios .ics
// -------------------------
function collectCalendars() {
  if (!fs.existsSync(CALENDAR_DIR)) return {};
  const allFiles = fs.readdirSync(CALENDAR_DIR).filter(f => f.toLowerCase().endsWith(".ics"));
  const data = {};
  for (const file of allFiles) {
    const competition = file.toLowerCase().startsWith("_") ? "" : "IMD";
    const category = detectCategoryFromFilename(file);
    const clean = file
      .replace(/^_/, "")
      .replace(/^imd_/, "")
      .replace(/\.ics$/i, "")
      .replace(/_/g, " ")
      .toUpperCase();
    const rawName = clean.replace(category.toUpperCase(), "").trim();
    const pretty = normalizeTeamDisplay(rawName);
    const filePath = path.join(CALENDAR_DIR, file);
    const fileUrlPath = toPosix(filePath);
    const slug = file.replace(/\.ics$/i, "");

    if (!data[category]) data[category] = { : [], IMD: [] };

    data[category][competition].push({
      team: pretty,
      path: filePath,
      urlPath: fileUrlPath,
      filename: file,
      slug,
    });
  }
  return data;
}

// -------------------------
// Helpers HTML: Clasificación 
// -------------------------
function buildClasificacionHTML(rows) {
  if (!rows || !rows.length) return `<p>Clasificación no disponible.</p>`;

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
      <td>${escapeHtml(r.team)}</td>
      <td>${r.pts}</td>
      <td>${r.pj}</td>
      <td>${r.pg}</td>
      <td>${r.pp}</td>
      <td>${r.sg}</td>
      <td>${r.sp}</td>
    </tr>`;
  }

  html += `</tbody></table>`;
  return html;
}

// -------------------------
// Helpers HTML: Clasificación IMD
// -------------------------
function buildClasificacionIMD(rows) {
  if (!rows || !rows.length) return `<p>Clasificación no disponible.</p>`;

  let html = `
<table class="clasificacion">
  <thead>
    <tr>
      <th>#</th><th>Equipo</th><th>PJ</th><th>PG</th><th>PE</th><th>PP</th>
      <th>PNP</th><th>JF</th><th>JC</th><th>TF</th><th>TC</th><th>Puntos</th>
    </tr>
  </thead>
  <tbody>
`;

  for (const r of rows) {
    html += `
    <tr>
      <td>${r.puesto || ""}</td>
      <td>${escapeHtml(r.equipo)}</td>
      <td>${r.pj}</td>
      <td>${r.pg}</td>
      <td>${r.pe}</td>
      <td>${r.pp}</td>
      <td>${r.pnp}</td>
      <td>${r.jf}</td>
      <td>${r.jc}</td>
      <td>${r.tf}</td>
      <td>${r.tc}</td>
      <td>${r.puntos}</td>
    </tr>`;
  }

  html += `</tbody></table>`;
  return html;
}

// -------------------------
// ICS parsing & Próximos partidos
// -------------------------
function unfoldICSLines(icsText) {
  return icsText.replace(/\r?\n[ \t]/g, "");
}

function parseICSDateToken(token, value) {
  const isAllDay = /VALUE=DATE/i.test(token);
  const v = (value || "").trim();
  if (!v) return null;

  if (isAllDay || /^\d{8}$/.test(v)) {
    const yyyy = v.slice(0, 4);
    const mm = v.slice(4, 6);
    const dd = v.slice(6, 8);
    return { date: new Date(`${yyyy}-${mm}-${dd}T00:00:00`), allDay: true };
  }

  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?$/);
  if (m) {
    const [_, yyyy, mm, dd, hh, min, sec] = m;
    return { date: new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:${sec || "00"}`), allDay: false };
  }

  const m2 = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})$/);
  if (m2) {
    const [_, yyyy, mm, dd, hh, min] = m2;
    return { date: new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:00`), allDay: false };
  }

  return null;
}

function decodeICSText(s) {
  if (!s) return "";
  return s.replace(/\\n/g, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").trim();
}

function parseICS(icsText) {
  const txt = unfoldICSLines(icsText || "");
  const lines = txt.split(/\r?\n/);

  const events = [];
  let inEvent = false;
  let cur = null;

  for (const line of lines) {
    if (/^BEGIN:VEVENT/i.test(line)) {
      inEvent = true;
      cur = { summary: "", location: "", description: "", start: null, end: null, allDay: false };
      continue;
    }
    if (/^END:VEVENT/i.test(line)) {
      inEvent = false;
      if (cur && cur.start) {
        if (!cur.end && cur.allDay) cur.end = new Date(cur.start.getTime() + 24 * 3600 * 1000);
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
      const r = parseICSDateToken(key, val);
      if (r) { cur.start = r.date; cur.allDay = r.allDay; }
      continue;
    }
    if (/^DTEND/i.test(key)) {
      const r = parseICSDateToken(key, val);
      if (r) cur.end = r.date;
      continue;
    }
    if (/^SUMMARY/i.test(key)) {
      cur.summary = decodeICSText(val);
      continue;
    }
    if (/^LOCATION/i.test(key)) {
      cur.location = decodeICSText(val);
      continue;
    }
    if (/^DESCRIPTION/i.test(key)) {
      cur.description = decodeICSText(val);
      continue;
    }
  }

  return events;
}

function getProximosPartidosFromICS(icsText) {
  try {
    const events = parseICS(icsText)
      .filter(e => e.start instanceof Date && !isNaN(e.start.getTime()))
      .sort((a, b) => a.start - b.start);

    const now = new Date();
    const weekAhead = new Date(now.getTime() + 7 * 24 * 3600 * 1000);

    const future = events.filter(e => e.start >= now);
    let selected = future.filter(e => e.start <= weekAhead);

    if (!selected.length) selected = future.slice(0, 2);
    if (!selected.length) return "<p>No hay partidos próximos.</p>";

    return selected.map(e => {
      const d0 = e.start;
      const d1 = e.end;

      let fechaTxt = "";
      if (e.allDay && d1 && d1 > d0) {
        // Ej: "vie 28 - dom 30 nov"
        const f0 = d0.toLocaleDateString("es-ES", { weekday: "short", day: "numeric", month: "short" });
        const f1 = d1.toLocaleDateString("es-ES", { weekday: "short", day: "numeric", month: "short" });
        fechaTxt = `${f0} — ${f1}`;
      } else {
        const f0 = d0.toLocaleDateString("es-ES", { weekday: "short", day: "numeric", month: "short" });
        const h0 = e.allDay ? "" : d0.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
        fechaTxt = h0 ? `${f0} — ${h0}` : f0;
      }

      return `
<div class="partido">
  <div class="fecha">${escapeHtml(fechaTxt)}</div>
  <div class="vs">${escapeHtml(e.summary || "Partido")}</div>
  ${e.location ? `<div class="lugar">${escapeHtml(e.location)}</div>` : ""}
  ${e.description ? `<div class="desc">${escapeHtml(e.description)}</div>` : ""}
</div>`;
    }).join("\n");

  } catch (err) {
    return `<p>Error leyendo calendario: ${escapeHtml(String(err))}</p>`;
  }
}

// -------------------------
function escapeHtml(s) {
  return (s || "").replace(/&/g, "&amp;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// -------------------------
// Página individual
// -------------------------
async function generateTeamPage({
  team, category, competition, urlPath, slug,
  iconPath, Info, imdClasifMap
}) {
  const title = `${team} – ${category} (${competition})`;
  const webcalUrl = `webcal://${BASE_WEBCAL_HOST}/${BASE_REPO_PATH}/${encodeURI(urlPath)}`;

  // URLs oficiales federación
  let rankingUrl = "";
  let calendarOfficialUrl = "";
  if (competition === "" && Info) {
    const { tournament, group } = Info;
    if (group && Number(group) !== 0) {
      rankingUrl = `https://favoley.es/es/tournament/${tournament}/ranking/${group}`;
      calendarOfficialUrl = `https://favoley.es/es/tournament/${tournament}/calendar/${group}/all`;
    } else {
      calendarOfficialUrl = `https://favoley.es/es/tournament/${tournament}/calendar/`;
    }
  }

  // ------------- Clasificación -------------
  let clasificacionHtml = "<p>Cargando…</p>";

  if (competition === "" && Info) {
    try {
      const ranking = await fetchRanking(Info.tournament, Info.group);
      if (ranking) clasificacionHtml = buildClasificacionHTML(ranking);
    } catch (err) {
      clasificacionHtml = "<p>Error cargando clasificación federada.</p>";
    }

  } else if (competition === "IMD") {
    const key = `imd_${category}_${team}`.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const rows = imdClasifMap && imdClasifMap[key];
    clasificacionHtml = rows ? buildClasificacionIMD(rows) : "<p>No disponible para esta categoría.</p>";

  } else {
    clasificacionHtml = "<p>No disponible.</p>";
  }

  // ------------- Próximos partidos -------------
  const icsText = fs.readFileSync(path.join(CALENDAR_DIR, `${slug}.ics`), "utf8");
  const proximosHtml = getProximosPartidosFromICS(icsText);

  // ------------- Plantilla equipo.html -------------
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

  if (!fs.existsSync(EQUIPOS_DIR))
    fs.mkdirSync(EQUIPOS_DIR, { recursive: true });

  fs.writeFileSync(path.join(EQUIPOS_DIR, `${slug}.html`), tpl, "utf8");
}

// -------------------------
// Generar HTML principal
// -------------------------
async function generateHTML(calendars, Map, imdClasifMap) {
  if (!fs.existsSync(EQUIPOS_DIR))
    fs.mkdirSync(EQUIPOS_DIR, { recursive: true });

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

    for (const comp of ["", "IMD"]) {
      const teams = calendars[category][comp];
      if (!teams || !teams.length) continue;

      html += `<div class="competition"><h3 class="competition-title">${comp}</h3><ul class="team-list">`;

      teams.sort(sortTeams);

      for (const t of teams) {
        const icon = getIconForTeam(t.team);
        const key = t.slug;
        const Info = Map ? Map[key] : null;

        await generateTeamPage({
          team: t.team,
          category,
          competition: comp,
          urlPath: t.urlPath,
          slug: t.slug,
          iconPath: icon,
          Info,
          imdClasifMap
        });

        html += `
<li class="team-item">
  <img class="team-icon" src="${icon}" alt="${escapeHtml(t.team)}" />
  <a class="team-link" href="equipos/${t.slug}.html">${escapeHtml(t.team)}</a>
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
// MAIN
// -------------------------
(async function main() {
  try {
    console.log("📋 Generando index.html con clasificaciones ( + IMD)...");

    // federado_ids.json
    let federadoMap = null;
    const federadoPath = path.join(process.cwd(), "federado_ids.json");
    if (fs.existsSync(federadoPath)) {
      try {
        federadoMap = JSON.parse(fs.readFileSync(federadoPath, "utf8"));
        console.log(`ℹ️ federado_ids.json cargado (${Object.keys(federadoMap).length} claves)`);
      } catch (e) {
        console.warn("⚠️ Error leyendo federado_ids.json:", e.message);
      }
    }

   // --- cargar clasificaciones IMD si existen ---
let imdClasifMap = {};
const imdClasifPath = path.join(process.cwd(), "calendarios", "imd_clasificaciones.json");
if (fs.existsSync(imdClasifPath)) {
  try {
    imdClasifMap = JSON.parse(fs.readFileSync(imdClasifPath, "utf8"));
    console.log(`ℹ️ imd_clasificaciones.json cargado (${Object.keys(imdClasifMap).length} claves)`);
  } catch (e) {
    console.warn("⚠️ No se pudo parsear imd_clasificaciones.json:", e.message);
    imdClasifMap = {};
  }
} else {
  console.log("ℹ️ imd_clasificaciones.json no encontrado — páginas IMD no mostrarán clasificaciones guardadas.");
}


  // antes:
// await generateHTML(calendars, federadoMap);

// ahora:
await generateHTML(calendars, federadoMap, imdClasifMap);


  } catch (err) {
    console.error("❌ ERROR GENERAL:", err);
    process.exit(1);
  }
})();

