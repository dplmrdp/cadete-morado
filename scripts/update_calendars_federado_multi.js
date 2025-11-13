// scripts/update_calendars_federado_multi.js
// Scraper federado multi (FAVOLE) → genera 1 ICS por cada equipo "LAS FLORES"
// en cada grupo de cada torneo femenino Sevilla (temporada 2025/26).

const fs = require("fs");
const path = require("path");
const os = require("os");
const { parseFederadoHTML } = require("./parse_fed_html");
const { Builder, By, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

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
  // Esto produce un Date en la zona horaria del servidor; lo importante es que las
  // componentes reflejen la hora correcta para Europe/Madrid.
  const isoLocal = `${out.y}-${out.m}-${out.d}T${out.H}:${out.M}:00`;
  return new Date(isoLocal);
}

// -------------------------
// ICS format helpers
// -------------------------
function pad(n) { return String(n).padStart(2, "0"); }
function fmtICSDateTimeTZID(dt) {
  return `${dt.getFullYear()}${pad(dt.getMonth()+1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}${pad(dt.getSeconds())}`;
}
function fmtICSDateYYYYMMDD_fromParts(yyyy, MM, dd) {
  return `${yyyy}${MM}${dd}`;
}
function addDaysToDateParts({ yyyy, MM, dd }, days) {
  const d = new Date(Date.UTC(parseInt(yyyy,10), parseInt(MM,10)-1, parseInt(dd,10)));
  d.setUTCDate(d.getUTCDate() + days);
  const Y = d.getUTCFullYear();
  const M = String(d.getUTCMonth()+1).padStart(2,"0");
  const D = String(d.getUTCDate()).padStart(2,"0");
  return { yyyy: String(Y), MM: M, dd: D };
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
      ics += `BEGIN:VEVENT
SUMMARY:${escapeICSText(evt.summary)}
LOCATION:${escapeICSText(evt.location || "")}
DTSTART;TZID=${ICS_TZID}:${fmtICSDateTimeTZID(evt.start)}
DESCRIPTION:${escapeICSText(evt.description || "")}
END:VEVENT
`;
    } else if (evt.type === "allday") {
      // evt.startDateParts and evt.endDateParts expected: {yyyy,MM,dd}
      const dtStart = fmtICSDateYYYYMMDD_fromParts(evt.startDateParts.yyyy, evt.startDateParts.MM, evt.startDateParts.dd);
      const endPlusOne = addDaysToDateParts(evt.endDateParts, 1); // DTEND is exclusive: end + 1
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

function escapeICSText(s) {
  if (!s) return "";
  return String(s).replace(/\r\n/g, '\\n').replace(/\n/g, '\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');
}

// -------------------------
// NUEVA FUNCIÓN: normalizar equipo para filename
// -------------------------
// Devuelve un slug con guiones bajos (ej: las_flores_morado o otra_equipo)
function normalizeTeamForFilename(raw) {
  if (!raw) return "equipo";

  // 1) normalizar texto y quitar tildes
  let n = normalize(raw).toLowerCase();

  // 2) quitar IDs numéricos (ej: 1321295) que a veces incluye FAVoley
  n = n.replace(/\d+/g, " ");

  // 3) reemplazar símbolos no alfanum por espacio
  n = n.replace(/[^\p{L}0-9]+/gu, " ");

  // 4) colapsar espacios
  n = n.replace(/\s+/g, " ").trim();

  // 5) unificar formas de "las flores"
  if (n.includes("las flores") || n.includes("c d las flores") || n.includes("cd las flores") || n.includes("c.d. las flores") || n.includes("c d las flores")) {
    // detectar color si existe
    if (n.includes("morado"))   return "las_flores_morado";
    if (n.includes("amarillo")) return "las_flores_amarillo";
    if (n.includes("albero"))   return "las_flores_albero";
    if (n.includes("purpura") || n.includes("púrpura")) return "las_flores_purpura";
    return "las_flores";
  }

  // 6) fallback: convertir a guiones bajos y quitar caracteres sobrantes
  const out = n.replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  return out || "equipo";
}

// -------------------------
// Extraer rango de jornada desde HTML (ejemplo):
// <h2>Jornada 5 <span class="text-light-gray">21/11/25 – 23/11/25</span></h2>
// Devuelve { start: {yyyy,MM,dd}, end: {yyyy,MM,dd} }
// -------------------------
function extractJornadaRangeFromHTML(html) {
  if (!html) return null;
  // Buscar patrón dd/mm/yy(yy) – dd/mm/yy(yy)
  const m = html.match(/Jornada\s*\d+\s*<[^>]*>\s*([\d]{2}\/[\d]{2}\/[\d]{2,4})\s*(?:&nbsp;|&nbsp;|&mdash;|–|—|-)\s*([\d]{2}\/[\d]{2}\/[\d]{2,4})/i)
    || html.match(/<h2[^>]*>[^<]*<span[^>]*>\s*([\d]{2}\/[\d]{2}\/[\d]{2,4})\s*(?:&nbsp;|&nbsp;|&mdash;|–|—|-)\s*([\d]{2}\/[\d]{2}\/[\d]{2,4})\s*<\/span>/i);

  if (!m) {
    // intentar una variante más simple: buscar cualquier dd/mm/yy – dd/mm/yy en el html cerca de "Jornada"
    const m2 = html.match(/([\d]{2}\/[\d]{2}\/[\d]{2,4})\s*(?:&nbsp;|&nbsp;|&mdash;|–|—|-)\s*([\d]{2}\/[\d]{2}\/[\d]{2,4})/);
    if (!m2) return null;
    return {
      start: parseDateDDMMYYYY(m2[1]),
      end: parseDateDDMMYYYY(m2[2])
    };
  }

  const start = parseDateDDMMYYYY(m[1]);
  const end = parseDateDDMMYYYY(m[2]);
  if (!start || !end) return null;
  return { start, end };
}

// --- 1) Lista de torneos (tabla server-side) ---
async function discoverTournamentIds(driver) {
  log(`🌐 Página base: ${BASE_LIST_URL}`);
  await driver.get(BASE_LIST_URL);

  // Snapshot para depurar si algo cambia
  const html0 = await driver.getPageSource();
  const listSnap = path.join(DEBUG_DIR, `fed_list_debug_${RUN_STAMP}.html`);
  fs.writeFileSync(listSnap, html0);
  log(`📄 Snapshot lista guardado en: ${listSnap}`);

  // Espera a que exista la tabla
  await driver.wait(until.elementLocated(By.css("table.tabletype-public tbody")), 15000).catch(() => {});

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
    } catch {
      // fila no válida
    }
  }

  log(`🔎 Torneos detectados: ${tournaments.length}`);
  return tournaments;
}

// --- 2) Grupos (select) o inline (sin grupos) ---
async function discoverGroupIds(driver, tournamentId) {
  const url = `https://favoley.es/es/tournament/${tournamentId}`;
  log(`➡️ Abriendo torneo (solo DOM): ${url}`);
  await driver.get(url);

  // ¿Existe el select de grupos?
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
      return groups; // array de IDs (string)
    }
  }

  // ¿Calendario inline (caso JUNIOR)?
  const inlineRows = await driver.findElements(By.css("#custom-domain-calendar-widget table.tablestyle-e1d9 tbody tr"));
  if (inlineRows.length > 0) {
    log("📌 Calendario inline detectado (sin grupos).");
    return ["__INLINE__"];
  }

  // Snapshot de ayuda si no hay nada
  log(`⚠️ No se encontraron grupos ni calendario inline en torneo ${tournamentId}`);
  try {
    const html = await driver.getPageSource();
    fs.writeFileSync(path.join(DEBUG_DIR, `fed_groups_empty_${tournamentId}.html`), html);
  } catch {}
  return [];
}

// --- 3A) Parser calendario inline (sin grupos) ---
async function parseFederadoInlineCalendar(driver, meta) {
  const pageHTML = await driver.getPageSource();
  const fname = `fed_inline_${meta.tournamentId}.html`;
  fs.writeFileSync(path.join(DEBUG_DIR, fname), pageHTML);
  log(`🧩 Snapshot inline guardado: ${fname}`);

  // Extraer rango de jornada del header (si existe)
  const jornadaRange = extractJornadaRangeFromHTML(pageHTML); // {start, end} with parts
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

      // If there's a specific date in the cell we capture it, otherwise leave blank
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

    // Si el row trae fecha explícita, úsala; si no trae hora -> usaremos jornadaRange para allday
    const dParts = m.fecha ? parseDateDDMMYYYY(m.fecha) : null;
    const tParts = m.hora ? parseTimeHHMM(m.hora) : null;

    if (tParts && dParts) {
      const start = toLocalDate(dParts, tParts);
      const summary = `${m.local} vs ${m.visitante} (Federado)`;
      const description = "";
      const evt = { type: "timed", start, summary, location: m.lugar, description };
      if (!teams.has(teamName)) teams.set(teamName, []);
      teams.get(teamName).push(evt);
      continue;
    }

    // Si no tiene hora: crear evento ALLDAY que cubra la jornadaRange (si existe)
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

    // Fallback: if no jornada range and no time but a date exists, create single-day all-day
    if (dParts) {
      const summary = `${m.local} vs ${m.visitante} (Jornada)`;
      const description = "";
      const evt = {
        type: "allday",
        startDateParts: dParts,
        endDateParts: dParts,
        summary,
        location: m.lugar || "",
        description
      };
      if (!teams.has(teamName)) teams.set(teamName, []);
      teams.get(teamName).push(evt);
    }
  }

  const outFiles = [];
  for (const [teamName, events] of teams.entries()) {
    // ordenar: timed por start, allday quedan al principio (no crítico)
    events.sort((a, b) => {
      if (a.type === "allday" && b.type !== "allday") return -1;
      if (b.type === "allday" && a.type !== "allday") return 1;
      if (a.type === "timed" && b.type === "timed") return a.start - b.start;
      return 0;
    });

    const teamSlug = normalizeTeamForFilename(teamName); // ej: las_flores_morado
    const catSlug = slug(meta.category || "general");    // ej: infantil -> infantil
    const fnameOut = `federado_${catSlug}_${teamSlug}.ics`;

    writeICS(fnameOut, events);
    outFiles.push(fnameOut);
  }

  log(`📦 Generados ${outFiles.length} calendarios inline para torneo=${meta.tournamentId}`);
  if (outFiles.length) log(`↪ ${outFiles.join(", ")}`);
}

// --- 3B) Parser calendario por grupo ---
async function parseFederadoCalendarPage(driver, meta) {
  const url = `https://favoley.es/es/tournament/${meta.tournamentId}/calendar/${meta.groupId}/all`;
  log(`➡️ Abriendo calendario: ${url}`);
  await driver.get(url);

  // Espera algo tipo tabla/listado y guarda snapshot
  await driver.wait(until.elementLocated(By.css("table, .table, tbody, .row")), 15000).catch(() => {});
  const pageHTML = await driver.getPageSource();
  const snapName = `fed_${meta.tournamentId}_${meta.groupId}.html`;
  fs.writeFileSync(path.join(DEBUG_DIR, snapName), pageHTML);
  log(`🧩 Snapshot guardado: ${snapName}`);

  // Primero, intenta usar parser dedicado si existe
  try {
    parseFederadoHTML(pageHTML, meta);
  } catch (err) {
    log(`⚠️ Error al parsear calendario t=${meta.tournamentId} g=${meta.groupId}: ${err}`);
  }

  // Extraer rango de jornada del encabezado
  const jornadaRange = extractJornadaRangeFromHTML(pageHTML);
  if (jornadaRange) {
    log(`📆 Jornada rango detectado: ${jornadaRange.start.dd}/${jornadaRange.start.MM}/${jornadaRange.start.yyyy} – ${jornadaRange.end.dd}/${jornadaRange.end.MM}/${jornadaRange.end.yyyy}`);
  }

  // Plan A: tabla clásica
  let rows = [];
  try { rows = await driver.findElements(By.css("table tbody tr")); } catch {}
  if (!rows.length) {
    // Plan B: filas genéricas (ojo, puede traer ruido)
    try { rows = await driver.findElements(By.css("tr, .table-row")); } catch {}
  }

  const matches = [];

  // Parser de filas con <td>
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
            // si no hay fecha en la fila, lo añadimos igualmente y se tratará como sin hora
            matches.push({ fecha: "", hora: "", local, visitante, lugar, resultado });
          }
        }
      } catch {}
    }
  }

  // Plan C: fallback por texto bruto del snapshot (si no hubo matches)
  if (!matches.length) {
    const text = normalize(pageHTML);
    // Heurística: detectar bloques con fecha y " vs " o " - "
    const dateRegex = /(\d{2}\/\d{2}\/\d{2,4})/g;
    let m;
    while ((m = dateRegex.exec(text)) !== null) {
      const fecha = m[1];
      // ventanita de contexto
      const start = Math.max(0, m.index - 200);
      const end   = Math.min(text.length, m.index + 200);
      const chunk = text.slice(start, end);

      const horaM = chunk.match(/(\d{2}):(\d{2})/);
      const hora = horaM ? `${horaM[1]}:${horaM[2]}` : "";

      // Buscamos patrón equipo vs equipo o separadores comunes
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

  // Agrupar por equipo LAS FLORES
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
      const start = toLocalDate(dParts, tParts);
      const summary = `${m.local} vs ${m.visitante} (Federado)`;
      const description = m.resultado && m.resultado !== "-" ? `Resultado: ${m.resultado}` : "";
      const evt = { type: "timed", start, summary, location: m.lugar || "", description };
      for (const teamName of involved) {
        if (!teams.has(teamName)) teams.set(teamName, []);
        teams.get(teamName).push(evt);
      }
      continue;
    }

    // Si no tiene hora: crear evento ALLDAY que cubra la jornadaRange (si existe)
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

    // fallback: si no hay jornadaRange pero sí fecha, crear all-day single day
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
    // ordenar: timed por start, allday quedan al principio (no crítico)
    events.sort((a, b) => {
      if (a.type === "allday" && b.type !== "allday") return -1;
      if (b.type === "allday" && a.type !== "allday") return 1;
      if (a.type === "timed" && b.type === "timed") return a.start - b.start;
      return 0;
    });

    // nuevo: normalizar teamName para filename y categoría
    const teamSlug = normalizeTeamForFilename(teamName); // ej: las_flores_morado
    const catSlug = slug(meta.category || "general");    // ej: infantil -> infantil
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

  const tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-fed-"));
  const options = new chrome.Options()
    .addArguments("--headless=new")
    .addArguments("--disable-gpu")
    .addArguments("--no-sandbox")
    .addArguments("--disable-dev-shm-usage")
    .addArguments("--lang=es-ES")
    .addArguments("--window-size=1280,1024")
    .addArguments("--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36")
    .addArguments(`--user-data-dir=${tmpUserDir}`);

 const { setupDriver } = require("./setupDriver");
let driver = await setupDriver();


    log("\n✅ Scraping federado multi-equipos completado.");
  } catch (err) {
    onError(err, "MAIN");
  } finally {
    try { if (driver) await driver.quit(); } catch {}
    log("🧹 Chrome cerrado");
  }
})();
