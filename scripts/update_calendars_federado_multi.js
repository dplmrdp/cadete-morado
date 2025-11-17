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

async function discoverTournamentIds(driver) {
  log(`🌐 Página base: ${BASE_LIST_URL}`);
  await driver.get(BASE_LIST_URL);

  await driver.sleep(2000);

  const html = await driver.getPageSource();
  const snap = path.join(DEBUG_DIR, `fed_list_raw_${RUN_STAMP}.html`);
  fs.writeFileSync(snap, html);
  log(`🧪 RAW guardado: ${snap}`);

  const tournaments = [];
  const regex = /\/tournament\/(\d+)\//g;
  const lines = html.split("\n");

  for (const line of lines) {
    let m;
    while ((m = regex.exec(line)) !== null) {
      const id = m[1];

      let label = `Torneo ${id}`;
      const matchName = line.match(/>([^<]+)</);
      if (matchName) label = matchName[1].trim();

      tournaments.push({ id, label, category: "" });
    }
  }

  log(`🔎 Torneos detectados (RAW): ${tournaments.length}`);
  return tournaments;
}




  const tournaments = [];
  for (const tr of trs) {
    try {
      const a = await tr.findElement(By.css('td.colstyle-estado a[href*="/tournament/"]'));
      const href = await a.getAttribute("href");
      const m = href && href.match(/\/tournament\/(\d+)\//);
      if (!m) continue;

      const id = m[1];
      let label = "";
      let category = "";
      try { label = (await tr.findElement(By.css("td.colstyle-nombre")).getText()).trim(); } catch {}
      try { category = (await tr.findElement(By.css("td.colstyle-categoria")).getText()).trim(); } catch {}

      tournaments.push({ id, label: label || `Torneo ${id}`, category: category || "" });
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
// -------------------------
// extractJornadaRangeFromHTML
// -------------------------
function extractJornadaRangeFromHTML(html) {
  if (!html) return null;
  const h = (html || "").replace(/\n/g, " ");
  let m = h.match(/Jornada\s*\d+\s*<[^>]*>\s*\(?\s*([\d]{2}\/[\d]{2}\/[\d]{2,4})\s*(?:&nbsp;|&ndash;|&mdash;|–|—|-)\s*([\d]{2}\/[\d]{2}\/[\d]{2,4})\s*\)?/i);
  if (!m) {
    m = h.match(/Jornada\s*\d+[^<]*?\(?\s*([\d]{2}\/[\d]{2}\/[\d]{2,4})\s*(?:&nbsp;|&ndash;|&mdash;|–|—|-)\s*([\d]{2}\/[\d]{2}\/[\d]{2,4})\s*\)?/i);
  }
  if (!m) {
    const idx = h.search(/Jornada/i);
    if (idx !== -1) {
      const snippet = h.slice(idx, idx + 200);
      const m2 = snippet.match(/([\d]{2}\/[\d]{2}\/[\d]{2,4})\s*(?:&nbsp;|&ndash;|&mdash;|–|—|-)\s*([\d]{2}\/[\d]{2}\/[\d]{2,4})/);
      if (m2) m = m2;
    }
  }
  if (!m) return null;
  const start = parseDateDDMMYYYY(m[1]);
  const end = parseDateDDMMYYYY(m[2]);
  if (!start || !end) return null;
  return { start, end };
}

// -------------------------
// parseFederadoCalendarPage (grupos -> calendar/<group>/all)
// -------------------------
async function parseFederadoCalendarPage(driver, meta) {
  const url = `https://favoley.es/es/tournament/${meta.tournamentId}/calendar/${meta.groupId}/all`;
  log(`➡️ Abriendo calendario: ${url}`);
  await driver.get(url);

  try {
    await driver.wait(until.elementLocated(By.css("table, .table, tbody, .row")), 15000);
  } catch (e) {}

  const pageHTML = await driver.getPageSource();
  const snapName = `fed_${meta.tournamentId}_${meta.groupId}.html`;
  fs.writeFileSync(path.join(DEBUG_DIR, snapName), pageHTML);
  log(`🧩 Snapshot guardado: ${snapName}`);

  // Intentar parser específico si existe
  try {
    parseFederadoHTML(pageHTML, meta);
  } catch (err) {
    log(`⚠️ Error al parsear con parseFederadoHTML t=${meta.tournamentId} g=${meta.groupId}: ${err}`);
  }

  const jornadaRange = extractJornadaRangeFromHTML(pageHTML);
  if (jornadaRange) {
    log(`📆 Jornada rango detectado: ${jornadaRange.start.dd}/${jornadaRange.start.MM}/${jornadaRange.start.yyyy} – ${jornadaRange.end.dd}/${jornadaRange.end.MM}/${jornadaRange.end.yyyy}`);
  }

  // Extraer filas (varios planes: tabla clásica, filas genéricas, fallback texto)
  let rows = [];
  try { rows = await driver.findElements(By.css("table tbody tr")); } catch {}
  if (!rows.length) {
    try { rows = await driver.findElements(By.css("tr, .table-row")); } catch {}
  }

  const matches = [];

  if (rows.length) {
    for (const r of rows) {
      try {
        const tds = await r.findElements(By.css("td"));
        if (tds.length >= 4) {
          const fecha = (await tds[0].getText()).trim();
          const horaRaw = (await tds[1].getText()).trim();
          const hora = (horaRaw.match(/\d{2}:\d{2}/) || [])[0] || "";
          const local = (await tds[2].getText()).trim();
          const visitante = (await tds[3].getText()).trim();
          const resultado = tds[4] ? (await tds[4].getText()).trim() : "";
          const lugar = tds[5] ? (await tds[5].getText()).trim() : "";

          if (fecha && local && visitante) {
            matches.push({ fecha, hora, local, visitante, lugar, resultado });
          } else if (local && visitante) {
            matches.push({ fecha: "", hora: "", local, visitante, lugar, resultado });
          }
        }
      } catch {}
    }
  }

  // fallback por texto
  if (!matches.length) {
    const text = normalize(pageHTML);
    const dateRegex = /(\d{2}\/\d{2}\/\d{2,4})/g;
    let m;
    while ((m = dateRegex.exec(text)) !== null) {
      const fecha = m[1];
      const start = Math.max(0, m.index - 200);
      const end   = Math.min(text.length, m.index + 200);
      const chunk = text.slice(start, end);

      const horaM = chunk.match(/(\d{2}):(\d{2})/);
      const hora = horaM ? `${horaM[1]}:${horaM[2]}` : "";

      let local = "", visitante = "";
      const vsM = chunk.match(/([A-Z0-9\.\-\sÁÉÍÓÚÜÑ/]+?)\s+(?:VS|vs|-\s|—\s|–\s)\s+([A-Z0-9\.\-\sÁÉÍÓÚÜÑ/]+?)(?:\s|$)/);
      if (vsM) {
        local = normalize(vsM[1]);
        visitante = normalize(vsM[2]);
      }

      if (fecha && local && visitante) {
        matches.push({ fecha, hora, local, visitante, lugar: "", resultado: "" });
      }
    }
  }

  if (!matches.length) {
    log(`⚠️ t=${meta.tournamentId} g=${meta.groupId}: sin filas detectadas; revisa snapshot.`);
  }

  // Agrupar por equipo LAS FLORES (raw name key)
  const teams = new Map();
  for (const m of matches) {
    const localN = normLower(m.local);
    const visitN = normLower(m.visitante);
    if (!localN.includes(TEAM_NEEDLE) && !visitN.includes(TEAM_NEEDLE)) continue;

    const involved = [];
    if (localN.includes(TEAM_NEEDLE)) involved.push(m.local);
    if (visitN.includes(TEAM_NEEDLE)) involved.push(m.visitante);

    const dParts = m.fecha ? parseDateDDMMYYYY(m.fecha) : null;
    const tParts = m.hora ? parseTimeHHMM(m.hora) : null;

    if (tParts && dParts) {
      const startKey = Date.UTC(parseInt(dParts.yyyy,10), parseInt(dParts.MM,10)-1, parseInt(dParts.dd,10), parseInt(tParts.HH,10), parseInt(tParts.mm,10), 0);
      const displayLocal = normalizeTeamDisplay(m.local);
      const displayVisit = normalizeTeamDisplay(m.visitante);
      const summary = `${displayLocal} vs ${displayVisit} (Federado)`;
      const description = m.resultado && m.resultado !== "-" ? `Resultado: ${m.resultado}` : "";
      const evt = { type: "timed", startKey, summary, location: m.lugar || "", description };
      for (const teamName of involved) {
        if (!teams.has(teamName)) teams.set(teamName, []);
        teams.get(teamName).push(evt);
      }
      continue;
    }

    if (jornadaRange) {
      const displayLocal = normalizeTeamDisplay(m.local);
      const displayVisit = normalizeTeamDisplay(m.visitante);
      const summary = `${displayLocal} vs ${displayVisit} (Jornada)`;
      const description = m.resultado && m.resultado !== "-" ? `Resultado: ${m.resultado}` : "";
      const evt = {
        type: "allday",
        startDateParts: jornadaRange.start,
        endDateParts: jornadaRange.end,
        summary,
        location: m.lugar || "",
        description
      };
      for (const teamName of involved) {
        if (!teams.has(teamName)) teams.set(teamName, []);
        teams.get(teamName).push(evt);
      }
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
        description: m.resultado && m.resultado !== "-" ? `Resultado: ${m.resultado}` : ""
      };
      for (const teamName of involved) {
        if (!teams.has(teamName)) teams.set(teamName, []);
        teams.get(teamName).push(evt);
      }
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
    const fname = `federado_${catSlug}_${teamSlug}.ics`;

    writeICS(fname, events);
    outFiles.push(fname);
  }

  log(`📦 Generados ${outFiles.length} calendarios en t=${meta.tournamentId} g=${meta.groupId}`);
  if (outFiles.length) log(`↪ ${outFiles.join(", ")}`);
}

// -------------------------
// MAIN
// -------------------------
(async () => {
  log("🏐 Iniciando scraping FEDERADO multi-equipos LAS FLORES…");

  const tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), "-fed-"));
  const options = new chrome.Options()
    .addArguments("--headless=new")
    .addArguments("--disable-gpu")
    .addArguments("--no-sandbox")
    .addArguments("--disable-dev-shm-usage")
    .addArguments("--lang=es-ES")
    .addArguments("--window-size=1280,1024")
    .addArguments("--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36")
    .addArguments(`--user-data-dir=${tmpUserDir}`);

  let driver;
  try {
    driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();
    log("🚗 Chrome iniciado");

    const tournaments = await discoverTournamentIds(driver);
    if (!tournaments.length) {
      log("⚠️ No hay torneos: revisa el snapshot de la lista y la URL de filtros.");
    }

    for (const t of tournaments) {
      const category = (normalize(t.category) || normalize(t.label)).toUpperCase();
      log(`\n======= 🏷 Torneo ${t.id} :: ${t.label} (cat: ${category}) =======`);

      let groups = [];
      try {
        groups = await discoverGroupIds(driver, t.id);
      } catch (e) {
        onError(e, `discoverGroupIds t=${t.id}`);
        continue;
      }

      log(`🔹 Grupos detectados: ${groups.length}${groups.length ? " → ["+groups.join(", ")+"]" : ""}`);

      for (const g of groups) {
        if (g === "__INLINE__") {
          try {
            await parseFederadoInlineCalendar(driver, {
              tournamentId: t.id,
              groupId: "inline",
              category
            });
          } catch (e) {
            onError(e, `parse inline calendar t=${t.id}`);
          }
          continue;
        }

        try {
          await parseFederadoCalendarPage(driver, {
            tournamentId: t.id,
            groupId: g,
            category
          });
        } catch (e) {
          onError(e, `parse calendar t=${t.id} g=${g}`);
        }

        await driver.sleep(400);
      }
    }

    log("\n✅ Scraping federado multi-equipos completado.");
  } catch (err) {
    onError(err, "MAIN");
  } finally {
    try { if (driver) await driver.quit(); } catch {}
    log("🧹 Chrome cerrado");
  }
})();

