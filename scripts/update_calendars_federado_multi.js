// scripts/update_calendars_federado_multi.js
// Scraper federado multi (FAVOLEY) → genera 1 ICS por cada equipo "LAS FLORES"
// en cada grupo de cada torneo femenino Sevilla (temporada 2025/26).

const fs = require("fs");
const path = require("path");
const os = require("os");
const { Builder, By, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const { parseFederadoHTML } = require("./parse_fed_html");
const { normalizeTeamDisplay, normalizeTeamSlug } = require("./team_name_utils");

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
  const m4 = (s || "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m4) {
    const [, dd, MM, yyyy] = m4;
    return { yyyy, MM, dd };
  }
  const m2 = (s || "").match(/(\d{2})\/(\d{2})\/(\d{2})/);
  if (m2) {
    const [, dd, MM, yy] = m2;
    return { yyyy: `20${yy}`, MM, dd };
  }
  return null;
}
function parseTimeHHMM(s) {
  const m = (s || "").match(/(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, HH, mm] = m;
  return { HH, mm };
}
function addDaysToDateParts({ yyyy, MM, dd }, days) {
  const d = new Date(Date.UTC(parseInt(yyyy,10), parseInt(MM,10)-1, parseInt(dd,10)));
  d.setUTCDate(d.getUTCDate() + days);
  return { yyyy: String(d.getUTCFullYear()), MM: String(d.getUTCMonth()+1).padStart(2,"0"), dd: String(d.getUTCDate()).padStart(2,"0") };
}
function fmtICSDateYYYYMMDD_fromParts(yyyy, MM, dd) { return `${yyyy}${MM}${dd}`; }
function escapeICSText(s) { return String(s||"").replace(/\n/g,"\\n").replace(/,/g,'\\,').replace(/;/g,'\\;'); }

function fmtICSDateTimeTZIDFromInstant(ms) {
  const dt = new Date(ms);
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
  const g = t => parts.find(p=>p.type===t).value;
  return `${g('year')}${g('month')}${g('day')}T${g('hour')}${g('minute')}${g('second')}`;
}

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
LOCATION:${escapeICSText(evt.location||"")}
DTSTART;TZID=${ICS_TZID}:${dtStr}
DESCRIPTION:${escapeICSText(evt.description||"")}
END:VEVENT
`;
    } else {
      const dtStart = fmtICSDateYYYYMMDD_fromParts(evt.startDateParts.yyyy, evt.startDateParts.MM, evt.startDateParts.dd);
      const dtEndParts = addDaysToDateParts(evt.endDateParts,1);
      const dtEnd = fmtICSDateYYYYMMDD_fromParts(dtEndParts.yyyy, dtEndParts.MM, dtEndParts.dd);
      ics += `BEGIN:VEVENT
SUMMARY:${escapeICSText(evt.summary)}
LOCATION:${escapeICSText(evt.location||"")}
DTSTART;VALUE=DATE:${dtStart}
DTEND;VALUE=DATE:${dtEnd}
DESCRIPTION:${escapeICSText(evt.description||"")}
END:VEVENT
`;
    }
  }
  ics += `END:VCALENDAR\n`;
  fs.writeFileSync(path.join(OUTPUT_DIR, filename), ics);
  log(`✅ ICS escrito: ${filename} (${events.length} eventos)`);
}

async function discoverTournamentIds(driver) {
  log(`🌐 Página base: ${BASE_LIST_URL}`);
  await driver.get(BASE_LIST_URL);
  await driver.sleep(1500);
  const html = await driver.getPageSource();
  fs.writeFileSync(path.join(DEBUG_DIR, `fed_list_raw_${RUN_STAMP}.html`), html);
  // ⚠️ Bloque duplicado eliminado — esta sección se duplicaba y además contenía `await` fuera de funciones async.
}

async function discoverGroupIds(driver, tournamentId) {
  const url = `https://favoley.es/es/tournament/${tournamentId}`;
  log(`➡️ Abriendo torneo: ${url}`);
  await driver.get(url);
  await driver.sleep(1200);

  const opts = await driver.findElements(By.css("select[name='group'] option"));
  if (opts.length) return Promise.all(opts.map(o=>o.getAttribute("value")));

  const inline = await driver.findElements(By.css("#custom-domain-calendar-widget table"));
  if (inline.length) return ["__INLINE__"];

  return [];
}

function extractJornadaRangeFromHTML(html) {
  const h = html.replace(/\n/g," ");
  let m = h.match(/(\d{2}\/\d{2}\/\d{2,4}).{0,10}(\d{2}\/\d{2}\/\d{2,4})/);
  if (!m) return null;
  return { start: parseDateDDMMYYYY(m[1]), end: parseDateDDMMYYYY(m[2]) };
}

async function parseFederadoInlineCalendar(driver, meta) {
  const pageHTML = await driver.getPageSource();
  fs.writeFileSync(path.join(DEBUG_DIR, `fed_inline_${meta.tournamentId}.html`), pageHTML);

  const jornadaRange = extractJornadaRangeFromHTML(pageHTML);
  const rows = await driver.findElements(By.css("#custom-domain-calendar-widget tbody tr"));
  const matches = [];

  for (const r of rows) {
    try {
      const equipos = await r.findElements(By.css("td.colstyle-equipo .ellipsis"));
      if (equipos.length < 2) continue;
      const local = (await equipos[0].getText()).trim();
      const visitante = (await equipos[1].getText()).trim();
      const fechaTd = await r.findElement(By.css("td.colstyle-fecha span"));
      const raw = (await fechaTd.getText()).trim();
      const mF = raw.match(/(\d{2}\/\d{2}\/\d{2,4})/);
      const mH = raw.match(/(\d{2}):(\d{2})/);
      let lugar = "";
      try { lugar = await (await fechaTd.findElement(By.css(".ellipsis"))).getText(); } catch {}

      matches.push({ fecha: mF?mF[1]:"", hora: mH?`${mH[1]}:${mH[2]}`:"", local, visitante, lugar });
    } catch {}
  }

  const teams = new Map();

  for (const m of matches) {
    const localN = normLower(m.local);
    const visitN = normLower(m.visitante);
    if (!localN.includes(TEAM_NEEDLE) && !visitN.includes(TEAM_NEEDLE)) continue;

    const teamName = localN.includes(TEAM_NEEDLE) ? m.local : m.visitante;
    const d = parseDateDDMMYYYY(m.fecha);
    const t = parseTimeHHMM(m.hora);

    const displayLocal = normalizeTeamDisplay(m.local);
    const displayVisit = normalizeTeamDisplay(m.visitante);
    const summary = `${displayLocal} vs ${displayVisit} (Federado)`;

    if (d && t) {
      const startKey = Date.UTC(parseInt(d.yyyy),parseInt(d.MM)-1,parseInt(d.dd),parseInt(t.HH),parseInt(t.mm));
      const evt = { type:"timed", startKey, summary, location:m.lugar, description:"" };
      if (!teams.has(teamName)) teams.set(teamName,[]);
      teams.get(teamName).push(evt);
      continue;
    }

    const evt = {
      type:"allday",
      startDateParts: jornadaRange?jornadaRange.start:d,
      endDateParts: jornadaRange?jornadaRange.end:d,
      summary,
      location:m.lugar,
      description:""
    };
    if (!teams.has(teamName)) teams.set(teamName,[]);
    teams.get(teamName).push(evt);
  }

  for (const [team, events] of teams.entries()) {
    events.sort((a,b)=>a.type!==b.type ? (a.type==="allday"?-1:1) : (a.startKey||0)-(b.startKey||0));
    const file = `federado_${slug(meta.category)}_${normalizeTeamSlug(team)}.ics`;
    writeICS(file, events);
  }
}

async function parseFederadoCalendarPage(driver, meta) {
  const url = `https://favoley.es/es/tournament/${meta.tournamentId}/calendar/${meta.groupId}/all`;
  log(`➡️ Abriendo calendario: ${url}`);
  await driver.get(url);
  await driver.sleep(1500);

  const html = await driver.getPageSource();
  fs.writeFileSync(path.join(DEBUG_DIR, `fed_${meta.tournamentId}_${meta.groupId}.html`), html);

  const jornadaRange = extractJornadaRangeFromHTML(html);
  const rows = await driver.findElements(By.css("table tbody tr"));
  const matches = [];

  for (const r of rows) {
    try {
      const tds = await r.findElements(By.css("td"));
      if (tds.length < 4) continue;
      const fecha = (await tds[0].getText()).trim();
      const hora = ((await tds[1].getText()).match(/\d{2}:\d{2}/)||[""])[0];
      const local = (await tds[2].getText()).trim();
      const visitante = (await tds[3].getText()).trim();
      const resultado = tds[4] ? (await tds[4].getText()).trim() : "";
      const lugar = tds[5] ? (await tds[5].getText()).trim() : "";

      matches.push({ fecha, hora, local, visitante, resultad
