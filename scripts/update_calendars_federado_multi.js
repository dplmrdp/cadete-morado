// scripts/update_calendars_federado_multi.js
// Scraper federado multi (FAVOLEY) → genera 1 ICS por cada equipo "LAS FLORES"
// en cada grupo de cada torneo femenino Sevilla (temporada 2025/26).

const fs = require("fs");
const path = require("path");
const os = require("os");
const { parseFederadoHTML } = require("./parse_fed_html");
const { By, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const { setupDriver } = require("./setupDriver");

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
// Helpers de formato ICS y fechas en TZ Europe/Madrid
// -------------------------
function pad(n) { return String(n).padStart(2, "0"); }

// formatea un instante (millis UTC) a YYYYMMDDTHHMMSS en TZ Europe/Madrid
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

// añade días a un objeto {yyyy,MM,dd} devolviendo mismo formato (UTC-safe)
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
// Normalizar team for filename
// -------------------------
function normalizeTeamForFilename(raw) {
  if (!raw) return "equipo";
  let n = normalize(raw).toLowerCase();
  n = n.replace(/\d+/g, " ");
  try {
    n = n.replace(/[^\p{L}0-9]+/gu, " ");
  } catch (e) {
    n = n.replace(/[^a-z0-9áéíóúüñÁÉÍÓÚÜÑ]+/gi, " ");
  }
  n = n.replace(/\s+/g, " ").trim();
  if (n.includes("las flores") || n.includes("c d las flores") || n.includes("cd las flores") || n.includes("c.d. las flores")) {
    if (n.includes("morado"))   return "las_flores_morado";
    if (n.includes("amarillo")) return "las_flores_amarillo";
    if (n.includes("albero"))   return "las_flores_albero";
    if (n.includes("purpura") || n.includes("púrpura")) return "las_flores_purpura";
    return "las_flores";
  }
  const out = n.replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  return out || "equipo";
}

// -------------------------
// Extraer rango jornada desde HTML
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
// writeICS: ahora soporta:
// - eventos timed con formato DTSTART;TZID=Europe/Madrid:YYYYMMDDTHHMMSS (sin Z)
//   usando instant UTC -> Intl -> componentes Madrid
// - eventos allday con DTEND = end+1
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
      // evt.startKey es millis UTC del instante (construido a partir de partes)
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
  log(`📄 Snapshot lista guardado en: ${listSnap}`);

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
      log(`📌 Grupos detectados: ${groups.map(g => `→ ${g}`).join(" | ")}`);
      return groups;
    }
  }

  const inlineRows = await driver.findElements(By.css("#custom-domain-calendar-widget table.tablestyle-e1d9 tbody tr"));
  if (inlineRows.length > 0) {
    log("📌 Calendario inline detectado (sin grupos).");
    return ["__INLINE__"];
  }

  log(`⚠️ No se encontraron grupos ni calendario inline en torneo ${tournamentId}`);
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
  log(`🧩 Snapshot inline guardado: ${fname}`);

  const jornadaRange = extractJornadaRangeFromHTML(pageHTML);
  if (jornadaRange) {
    log(`📆 Jornada rango detectado: ${jornadaRange.start.dd}/${jornadaRange.start.MM}/${jornadaRange.start.yyyy} – ${jornadaRange.end.dd}/${jornadaRange.end.MM}/${jornadaRange.end.yyyy}`);
  }

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

  if (!matches.length) {
    log("⚠️ No se detectaron filas en el calendario inline. Revisa el snapshot.");
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
      // startKey: instante UTC correspondiente a la fecha+hora (interpretable)
      const startKey = Date.UTC(parseInt(dParts.yyyy,10), parseInt(dParts.MM,10)-1, parseInt(dParts.dd,10), parseInt(tParts.HH,10), parseInt(tParts.mm,10), 0);
      const summary = `${m.local} vs ${m.visitante} (Federado)`;
      const description = "";
      const evt = { type: "timed", startKey, summary, location: m.lugar, description };
      if (!teams.has(teamName)) teams.set(teamName, []);
      teams.get(teamName).push(evt);
      continue;
    }

    if (jornadaRange) {
      const summary = `${m.local} vs ${m.visitante} (Jornada)`;
      const description = "";
      const evt = {
        type: "allday",
        startDateParts: jornadaRange.start,
        endDateParts: jornadaRange.end,
        summary,
        location: m.lugar || "",
        description
      };
      if (!teams.has(teamName)) teams.set(teamName, []);
      teams.get(teamName).push(evt);
      continue;
    }

    if (dParts) {
      const summary = `${m.local} vs ${m.visitante} (Jornada)`;
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
      // allday first, then by startKey
      if (a.type === "allday" && b.type !== "allday") return -1;
      if (b.type === "allday" && a.type !== "allday") return 1;
      if (a.type === "timed" && b.type === "timed") return a.startKey - b.startKey;
      return 0;
    });

    const teamSlug = normalizeTeamForFilename(teamName);
    const catSlug = slug(meta.category || "general");
    const fnameOut = `federado_${catSlug}_${teamSlug}.ics`;

    writeICS(fnameOut, events);
    outFiles.push(fnameOut);
  }

  log(`📦 Generados ${outFiles.length} calendarios inline para torneo=${meta.tournamentId}`);
  if (outFiles.length) log(`↪ ${outFiles.join(", ")}`);
}

// -------------------------
// parseFederadoCalendarPage
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

  try {
    parseFederadoHTML(pageHTML, meta);
  } catch (err) {
    log(`⚠️ Error al parsear calendario t=${meta.tournamentId} g=${meta.groupId}: ${err}`);
  }

  const jornadaRange = extractJornadaRangeFromHTML(pageHTML);
  if (jornadaRange) {
    log(`📆 Jornada rango detectado: ${jornadaRange.start.dd}/${jornadaRange.start.MM}/${jornadaRange.start.yyyy} – ${jornadaRange.end.dd}/${jornadaRange.end.MM}/${jornadaRange.end.yyyy}`);
  }

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
      const summary = `${m.local} vs ${m.visitante} (Federado)`;
      const description = m.resultado && m.resultado !== "-" ? `Resultado: ${m.resultado}` : "";
      const evt = { type: "timed", startKey, summary, location: m.lugar || "", description };
      for (const teamName of involved) {
        if (!teams.has(teamName)) teams.set(teamName, []);
        teams.get(teamName).push(evt);
      }
      continue;
    }

    if (jornadaRange) {
      const summary = `${m.local} vs ${m.visitante} (Jornada)`;
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
      const summary = `${m.local} vs ${m.visitante} (Jornada)`;
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

    const teamSlug = normalizeTeamForFilename(teamName);
    const catSlug = slug(meta.category || "general");
    const fname = `federado_${catSlug}_${teamSlug}.ics`;

    writeICS(fname, events);
    outFiles.push(fname);
  }

  log(`📦 Generados ${outFiles.length} calendarios en t=${meta.tournamentId} g=${meta.groupId}`);
  if (outFiles.length) log(`↪ ${outFiles.join(", ")}`);
}

// --- MAIN ---
(async () => {
  log("🏐 Iniciando scraping FEDERADO multi-equipos LAS FLORES…");

  let driver;
  try {
    driver = await setupDriver();
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
