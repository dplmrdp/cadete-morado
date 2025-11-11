// scripts/update_calendars_federado_multi.js
// Scraper federado multi (FAVOLE) → genera 1 ICS por cada equipo "LAS FLORES"
// en cada grupo de cada torneo femenino Sevilla (temporada 2025/26).

const fs = require("fs");
const path = require("path");
const os = require("os");
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
  const m = (s || "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const [, dd, MM, yyyy] = m;
  return { yyyy, MM, dd };
}
function parseTimeHHMM(s) {
  const m = (s || "").match(/(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, HH, mm] = m;
  return { HH, mm };
}
function toLocalDate({ yyyy, MM, dd }, timeOrNull) {
  const h = timeOrNull ? `${timeOrNull.HH}:${timeOrNull.mm}` : "00:00";
  return new Date(`${yyyy}-${MM}-${dd}T${h}:00`);
}
function fmtICSDateTimeTZID(dt) {
  const pad = n => String(n).padStart(2, "0");
  return `${dt.getFullYear()}${pad(dt.getMonth()+1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}${pad(dt.getSeconds())}`;
}
function fmtICSDateUTC(d) {
  const Y = d.getUTCFullYear(), M = String(d.getUTCMonth()+1).padStart(2,"0"), D = String(d.getUTCDate()).padStart(2,"0");
  return `${Y}${M}${D}`;
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
SUMMARY:${evt.summary}
LOCATION:${evt.location || ""}
DTSTART;TZID=${ICS_TZID}:${fmtICSDateTimeTZID(evt.start)}
DESCRIPTION:${evt.description || ""}
END:VEVENT
`;
    } else {
      ics += `BEGIN:VEVENT
SUMMARY:${evt.summary}
LOCATION:${evt.location || ""}
DTSTART;VALUE=DATE:${fmtICSDateUTC(evt.start)}
DTEND;VALUE=DATE:${fmtICSDateUTC(evt.end)}
DESCRIPTION:${evt.description || ""}
END:VEVENT
`;
    }
  }
  ics += "END:VCALENDAR\n";
  const out = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(out, ics);
  log(`✅ ICS escrito: ${out} (${events.length} eventos)`);
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

      const mFecha = fechaTexto.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      const mHora  = fechaTexto.match(/(\d{2}):(\d{2})/);

      if (!mFecha) continue;
      const fecha = `${mFecha[1]}/${mFecha[2]}/${mFecha[3]}`;
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
    const d = parseDateDDMMYYYY(m.fecha);
    if (!d) continue;

    const t = parseTimeHHMM(m.hora);
    const start = toLocalDate(d, t);

    const summary = `${m.local} vs ${m.visitante} (Federado)`;
    const description = "";

    const evt = t
      ? { type: "timed", start, summary, location: m.lugar, description }
      : { type: "allday", start, end: new Date(start.getTime()+86400000), summary, location: m.lugar, description };

    if (!teams.has(teamName)) teams.set(teamName, []);
    teams.get(teamName).push(evt);
  }

  const outFiles = [];
  for (const [teamName, events] of teams.entries()) {
    events.sort((a, b) => a.start - b.start);
    const fnameOut = `federado_${slug(teamName)}_${slug(meta.category)}_${meta.tournamentId}.ics`;
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
          }
        }
      } catch {}
    }
  }

  // Plan C: fallback por texto bruto del snapshot (si no hubo matches)
  if (!matches.length) {
    const text = normalize(pageHTML);
    // Heurística: detectar bloques con fecha y " vs " o " - "
    const dateRegex = /(\d{2}\/\d{2}\/\d{4})/g;
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

    const d = parseDateDDMMYYYY(m.fecha);
    if (!d) { log(`⚠️ Fecha inválida: ${m.fecha}`); continue; }
    const t = parseTimeHHMM(m.hora);
    const start = toLocalDate(d, t);

    const summary = `${m.local} vs ${m.visitante} (Federado)`;
    const description = m.resultado && m.resultado !== "-" ? `Resultado: ${m.resultado}` : "";

    const evt = t
      ? { type: "timed", start, summary, location: m.lugar || "", description }
      : { type: "allday", start, end: new Date(start.getTime()+86400000), summary, location: m.lugar || "", description };

    for (const teamName of involved) {
      if (!teams.has(teamName)) teams.set(teamName, []);
      teams.get(teamName).push(evt);
    }
  }

  const outFiles = [];
  for (const [teamName, events] of teams.entries()) {
    events.sort((a, b) => a.start - b.start);
    const fname = `federado_${slug(teamName)}_${slug(meta.category)}_${meta.groupId}.ics`;
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

  let driver;
  try {
    driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();

    // 1) Torneos
    const tournaments = await discoverTournamentIds(driver);
    if (!tournaments.length) {
      log("⚠️ No hay torneos: revisa el snapshot de la lista y la URL de filtros.");
    }

    // 2) Por torneo → grupos → calendario
    for (const t of tournaments) {
      const category = (normalize(t.category) || normalize(t.label)).toUpperCase();
      log(`\n======= 🏷 Torneo ${t.id} :: ${t.label} (cat: ${category}) =======`);

      let groups = [];
      try {
        groups = await discoverGroupIds(driver, t.id); // ["__INLINE__"] o ["3652...", ...]
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

        // pausa corta entre grupos para no estresar el server
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
