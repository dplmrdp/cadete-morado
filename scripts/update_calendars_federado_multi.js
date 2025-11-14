// scripts/update_calendars_federado_multi.js
// Scraper federado multi (FAVOLEY) → genera 1 ICS por cada equipo "LAS FLORES"
// en cada grupo de cada torneo femenino Sevilla (temporada 2025/26).

const fs = require("fs");
const path = require("path");
const os = require("os");
const { parseFederadoHTML } = require("./parse_fed_html");
const { Builder, By, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

// Importar utilidades de nombres (reglas EVB / color / limpieza)
const { normalizeTeamDisplay, normalizeTeamSlug } = require("./team_name_utils");

// --- Config ---
const BASE_LIST_URL = "https://favoley.es/es/tournaments?season=8565&category=&sex=2&sport=&tournament_status=&delegation=1630";
const OUTPUT_DIR = path.join("calendarios");
const DEBUG_DIR = path.join(OUTPUT_DIR, "debug");
const LOG_DIR = path.join(OUTPUT_DIR, "logs");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(DEBUG_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = path.join(LOG_DIR, `federado_${RUN_STAMP}.log`);

const TEAM_NEEDLE = "las flores";
const ICS_TZID = "Europe/Madrid";

// --- Utils ---
function log(line) {
  const msg = typeof line === "string" ? line : JSON.stringify(line);
  console.log(msg);
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}
function onError(err, ctx = "UNSPECIFIED") {
  log(`❌ ERROR (${ctx}): ${err && err.stack ? err.stack : err}`);
}
function normalize(s) {
  return (s || "").toString().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function normLower(s) { return normalize(s).toLowerCase(); }
function slug(s) {
  return normalize(s).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"");
}
function parseDateDDMMYYYY(s) {
  // Accept dd/mm/yy or dd/mm/yyyy
  const m4 = (s || "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m4) {
    const [, dd, MM, yyyy] = m4;
    return { yyyy, MM, dd };
  }
  const m2 = (s || "").match(/(\d{2})\/(\d{2})\/(\d{2})/);
  if (m2) {
    const [, dd, MM, yy] = m2;
    const yyyy = `20${yy}`;
    return { yyyy, MM, dd };
  }
  return null;
}
function parseTimeHHMM(s) {
  const m = (s || "").match(/(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, HH, mm] = m;
  return { HH, mm };
}

// -------------------------
// toLocalDate: crea un Date representando la hora local en Europe/Madrid
// tomando la fecha (yyyy,MM,dd) y la hora (HH,mm).
// Esto evita poner offsets fijos y respeta DST.
// -------------------------
function toLocalDate({ yyyy, MM, dd }, timeOrNull) {
  const h = timeOrNull ? parseInt(timeOrNull.HH, 10) : 0;
  const m = timeOrNull ? parseInt(timeOrNull.mm, 10) : 0;

  // 1) Crear un Date UTC con los componentes pedidos (como si fueran UTC)
  const dtUtc = new Date(Date.UTC(parseInt(yyyy,10), parseInt(MM,10)-1, parseInt(dd,10), h, m, 0));

  // 2) Usar Intl para formatear esa fecha en Europe/Madrid y obtener componentes locales
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  const parts = formatter.formatToParts(dtUtc);
  const out = {};
  for (const p of parts) {
    if (p.type === "year") out.y = p.value;
    if (p.type === "month") out.m = p.value;
    if (p.type === "day") out.d = p.value;
    if (p.type === "hour") out.H = p.value;
    if (p.type === "minute") out.M = p.value;
  }

  // 3) Construir una fecha ISO local (no con zona) y crear Date a partir de ella
  const isoLocal = `${out.y}-${out.m}-${out.d}T${out.H}:${out.M}:00`;
  return new Date(isoLocal);
}

// -------------------------
// ICS format helpers
// -------------------------
function pad(n) { return String(n).padStart(2, "0"); }

function fmtICSDateTimeTZIDFromInstant(instantMillis) {
  const dt = new Date(instantMillis);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: ICS_TZID,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(dt);

  const y = parts.find(p => p.type === "year").value;
  const mo = parts.find(p => p.type === "month").value;
  const d = parts.find(p => p.type === "day").value;
  const H = parts.find(p => p.type === "hour").value;
  const M = parts.find(p => p.type === "minute").value;
  const S = parts.find(p => p.type === "second").value;

  return `${y}${mo}${d}T${H}${M}${S}`;
}

function addDaysToDateParts({ yyyy, MM, dd }, days) {
  const d = new Date(Date.UTC(parseInt(yyyy,10), parseInt(MM,10)-1, parseInt(dd,10)));
  d.setUTCDate(d.getUTCDate() + days);
  const Y = d.getUTCFullYear();
  const M = String(d.getUTCMonth()+1).padStart(2,"0");
  const D = String(d.getUTCDate()).padStart(2,"0");
  return { yyyy: String(Y), MM: M, dd: D };
}
function fmtICSDateYYYYMMDD_fromParts(yyyy, MM, dd) {
  return `${yyyy}${MM}${dd}`;
}

function escapeICSText(s) {
  if (!s) return "";
  return String(s).replace(/\r\n/g, '\\n').replace(/\n/g, '\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');
}

// -------------------------
// writeICS: ahora soporta timed y allday
// -------------------------
function writeICS(filename, events) {
  let ics = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:PUBLISH
PRODID:-//Las Flores//Calendarios Federado//ES
`;
  for (const evt of events) {
    if (evt.type === "timed") {
      const dtStr = fmtICSDateTimeTZIDFromInstant(evt.startKey);
      ics += `BEGIN:VEVENT
SUMMARY:${escapeICSText(evt.summary)}
LOCATION:${escapeICSText(evt.location || "")}
DTSTART;TZID=${ICS_TZID}:${dtStr}
DESCRIPTION:${escapeICSText(evt.description || "")}
END:VEVENT
`;
    } else if (evt.type === "allday") {
      const dtStart = fmtICSDateYYYYMMDD_fromParts(evt.startDateParts.yyyy, evt.startDateParts.MM, evt.startDateParts.dd);
      const endPlusOne = addDaysToDateParts(evt.endDateParts, 1);
      const dtEnd = fmtICSDateYYYYMMDD_fromParts(endPlusOne.yyyy, endPlusOne.MM, endPlusOne.dd);
      ics += `BEGIN:VEVENT
SUMMARY:${escapeICSText(evt.summary)}
LOCATION:${escapeICSText(evt.location || "")}
DTSTART;VALUE=DATE:${dtStart}
DTEND;VALUE=DATE:${dtEnd}
DESCRIPTION:${escapeICSText(evt.description || "")}
END:VEVENT
`;
    }
  }
  ics += "END:VCALENDAR\n";
  const out = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(out, ics);
  log(`✅ ICS escrito: ${out} (${events.length} eventos)`);
}

// -------------------------
// discoverTournamentIds
// -------------------------
async function discoverTournamentIds(driver) {
  log(`🌐 Página base: ${BASE_LIST_URL}`);
  await driver.get(BASE_LIST_URL);
  const html0 = await driver.getPageSource();
  const listSnap = path.join(DEBUG_DIR, `fed_list_debug_${RUN_STAMP}.html`);
  fs.writeFileSync(listSnap, html0);

  try {
    await driver.wait(until.elementLocated(By.css("table.tabletype-public tbody")), 15000);
  } catch (e) {}

  let trs = [];
  try {
    trs = await driver.findElements(By.css("table.tabletype-public tbody tr"));
  } catch {}

  if (!trs || !trs.length) {
    log("⚠️ No se localizaron filas de la tabla de torneos");
  }

  const tournaments = [];
  for (const tr of trs) {
    try {
      const a = await tr.findElement(By.css('td.colstyle-estado a[href*="/tournament/"]'));
      const href = await a.getAttribute("href");
      const m = href && href.match(/\/tournament\/(\d+)\//);
      if (!m) continue;
      const id = m[1];

      const nameTd = await tr.findElement(By.css("td.colstyle-nombre"));
      const catTd  = await tr.findElement(By.css("td.colstyle-categoria"));
      const label = (await nameTd.getText()).trim() || `Torneo ${id}`;
      const category = (await catTd.getText()).trim() || "";

      tournaments.push({ id, label, category });
    } catch {}
  }

  log(`🔎 Torneos detectados: ${tournaments.length}`);
  return tournaments;
}

// -------------------------
// discoverGroupIds
// -------------------------
async function discoverGroupIds(driver, tournamentId) {
  const url = `https://favoley.es/es/tournament/${tournamentId}`;
  log(`➡️ Abriendo torneo (solo DOM): ${url}`);
  await driver.get(url);
  try {
    await driver.wait(until.elementLocated(By.css("select[name='group'], #custom-domain-calendar-widget, .table")), 12000);
  } catch (e) {}

  const selectNodes = await driver.findElements(By.css("select[name='group']"));
  if (selectNodes.length) {
    const selectEl = selectNodes[0];
    const options = await selectEl.findElements(By.css("option"));
    const groups = [];
    for (const opt of options) {
      const value = await opt.getAttribute("value");
      if (value) groups.push(value);
    }
    if (groups.length) {
      return groups;
    }
  }

  const inlineRows = await driver.findElements(By.css("#custom-domain-calendar-widget table.tablestyle-e1d9 tbody tr"));
  if (inlineRows.length > 0) {
    return ["__INLINE__"];
  }

  try {
    const html = await driver.getPageSource();
    fs.writeFileSync(path.join(DEBUG_DIR, `fed_groups_empty_${tournamentId}.html`), html);
  } catch {}
  return [];
}

// -------------------------
// parseFederadoInlineCalendar
// -------------------------
async function parseFederadoInlineCalendar(driver, meta) {
  const pageHTML = await driver.getPageSource();
  const fname = `fed_inline_${meta.tournamentId}.html`;
  fs.writeFileSync(path.join(DEBUG_DIR, fname), pageHTML);

  const jornadaRange = extractJornadaRangeFromHTML(pageHTML);

  const rows = await driver.findElements(By.css("#custom-domain-calendar-widget table.tablestyle-e1d9 tbody tr"));
  const matches = [];

  for (const r of rows) {
    try {
      const eqTd = await r.findElement(By.css("td.colstyle-equipo"));
      const equipos = await eqTd.findElements(By.css(".ellipsis"));
      if (equipos.length < 2) continue;

      const local = (await equipos[0].getText()).trim();
      const visitante = (await equipos[1].getText()).trim();

      const fechaTd = await r.findElement(By.css("td.colstyle-fecha span"));
      const fechaTexto = (await fechaTd.getText()).trim();

      const mFecha = fechaTexto.match(/(\d{2}\/\d{2}\/\d{2,4})/);
      const mHora  = fechaTexto.match(/(\d{2}):(\d{2})/);

      const fecha = mFecha ? mFecha[1] : "";
      const hora = mHora ? `${mHora[1]}:${mHora[2]}` : "";

      let lugar = "";
      try {
        const lugarSpan = await fechaTd.findElement(By.css(".ellipsis"));
        lugar = (await lugarSpan.getText()).trim();
      } catch {}

      matches.push({ fecha, hora, local, visitante, lugar, resultado: "" });
    } catch {}
  }

  const teams = new Map();

  for (const m of matches) {
    const localN = normLower(m.local);
    const visitN = normLower(m.visitante);
    if (!localN.includes(TEAM_NEEDLE) && !visitN.includes(TEAM_NEEDLE)) continue;

    const teamName = localN.includes(TEAM_NEEDLE) ? m.local : m.visitante;

    const dParts = m.fecha ? parseDateDDMMYYYY(m.fecha) : null;
    const tParts = m.hora ? parseTimeHHMM(m.hora) : null;

    if (tParts && dParts) {
      const startKey = Date.UTC(parseInt(dParts.yyyy,10), parseInt(dParts.MM,10)-1, parseInt(dParts.dd,10), parseInt(tParts.HH,10), parseInt(tParts.mm,10), 0);
      const displayLocal = normalizeTeamDisplay(m.local);
      const displayVisit = normalizeTeamDisplay(m.visitante);
      const summary = `${displayLocal} vs ${displayVisit} (Federado)`;
      const evt = { type: "timed", startKey, summary, location: m.lugar, description: "" };
      if (!teams.has(teamName)) teams.set(teamName, []);
      teams.get(teamName).push(evt);
      continue;
    }

    if (jornadaRange) {
      const displayLocal = normalizeTeamDisplay(m.local);
      const displayVisit = normalizeTeamDisplay(m.visitante);
      const summary = `${displayLocal} vs ${displayVisit} (Jornada)`;
      const evt = {
        type: "allday",
        startDateParts: jornadaRange.start,
        endDateParts: jornadaRange.end,
        summary,
        location: m.lugar || "",
        description: ""
      };
      if (!teams.has(teamName)) teams.set(teamName, []);
      teams.get(teamName).push(evt);
      continue;
    }

    if (dParts) {
      const displayLocal = normalizeTeamDisplay(m.local);
      const displayVisit = normalizeTeamDisplay(m.visitante);
      const summary = `${displayLocal} vs ${displayVisit} (Jornada)`;
      const evt = {
        type: "allday",
        startDateParts: dParts,
        endDateParts: dParts,
        summary,
        location: m.lugar || "",
        description: ""
      };
      if (!teams.has(teamName)) teams.set(teamName, []);
      teams.get(teamName).push(evt);
    }
  }

  const outFiles = [];
  for (const [teamName, events] of teams.entries()) {
    events.sort((a, b) => {
      if (a.type === "allday" && b.type !== "allday") return -1;
      if (b.type === "allday" && a.type !== "allday") return 1;
      if (a.type === "timed" && b.type === "timed") return a.startKey - b.startKey;
      return 0;
    });

    const teamSlug = normalizeTeamSlug(teamName);
    const catSlug = slug(meta.category || "general");
    const fnameOut = `federado_${catSlug}_${teamSlug}.ics`;

    writeICS(fnameOut, events);
    outFiles.push(fnameOut);
  }

  log(`📦 Generados ${outFiles.length} calendarios inline para torneo=${meta.tournamentId}`);
  if (outFiles.length) log(`↪ ${outFiles.join(", ")}`);
}
