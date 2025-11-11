// scripts/update_calendars_federado_multi.js
// Scraper federado multi-categoría/grupo/equipo (FAVOLE).
// Genera un ICS por cada equipo "LAS FLORES" detectado en cada grupo de cada torneo.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { Builder, By, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

const BASE_LIST_URL =
  "https://favoley.es/es/tournaments?season=8565&category=&sex=2&sport=&tournament_status=&delegation=1630";

const OUTPUT_DIR = path.join("calendarios");
const DEBUG_DIR = path.join(OUTPUT_DIR, "debug");
const LOG_DIR = path.join(OUTPUT_DIR, "logs");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(DEBUG_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = path.join(LOG_DIR, `federado_${RUN_STAMP}.log`);

function log(line) {
  const msg = typeof line === "string" ? line : JSON.stringify(line);
  console.log(msg);
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) {}
}

function onError(err, ctx = "UNSPECIFIED") {
  log(`❌ ERROR (${ctx}): ${err && err.stack ? err.stack : err}`);
}

const ICS_TZID = "Europe/Madrid";
const TEAM_NEEDLE = "las flores"; // filtro por club

function normalize(s) {
  return (s || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function normLower(s) {
  return normalize(s).toLowerCase();
}
function slug(s) {
  return normalize(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

// Fecha/hora local Europe/Madrid (sin Z)
function toLocalDate({ yyyy, MM, dd }, timeOrNull) {
  const d = new Date(
    `${yyyy}-${MM}-${dd}T${timeOrNull ? `${timeOrNull.HH}:${timeOrNull.mm}` : "00:00"}:00`
  );
  return d;
}

function fmtICSDateTimeTZID(dt) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(
    dt.getDate()
  )}T${pad(dt.getHours())}${pad(dt.getMinutes())}${pad(dt.getSeconds())}`;
}
function fmtICSDateUTC(d) {
  const Y = d.getUTCFullYear(),
    M = String(d.getUTCMonth() + 1).padStart(2, "0"),
    D = String(d.getUTCDate()).padStart(2, "0");
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

// ------------------------------------------------------------
// PARSEAR UNA PÁGINA DE CALENDARIO (…/tournament/{id}/calendar/{groupId}/all)
// ------------------------------------------------------------
async function parseFederadoCalendarPage(driver, meta) {
  const pageHTML = await driver.getPageSource();
  const fname = `fed_${meta.tournamentId}_${meta.groupId}.html`;
  fs.writeFileSync(path.join(DEBUG_DIR, fname), pageHTML);
  log(`🧩 Snapshot guardado: ${fname}`);

  let rows = [];
  try {
    rows = await driver.findElements(By.css("table tbody tr"));
  } catch (_) {}

  if (rows.length === 0) {
    rows = await driver.findElements(By.css("tr, .table-row, .row"));
  }

  const matches = [];
  for (const r of rows) {
    try {
      const txt = await r.getText();
      const line = normalize(txt);
      const mDate = line.match(/(\d{2}\/\d{2}\/\d{4})/);
      if (!mDate) continue;

      const tds = await r.findElements(By.css("td"));
      let fecha = "",
        hora = "",
        local = "",
        visitante = "",
        lugar = "",
        resultado = "";

      if (tds.length >= 4) {
        fecha = (await tds[0].getText()).trim();
        const rawHora = (await tds[1].getText()).trim();
        hora = (rawHora.match(/\d{2}:\d{2}/) || [null])[0] || "";
        local = (await tds[2].getText()).trim();
        visitante = (await tds[3].getText()).trim();
        if (tds[4]) resultado = (await tds[4].getText()).trim();
        if (tds[5]) lugar = (await tds[5].getText()).trim();
      }

      if (!fecha || !local || !visitante) continue;

      matches.push({ fecha, hora, local, visitante, lugar, resultado });
    } catch (_) {}
  }

  const teams = new Map();

  for (const m of matches) {
    const localN = normLower(m.local);
    const visitN = normLower(m.visitante);

    if (!localN.includes(TEAM_NEEDLE) && !visitN.includes(TEAM_NEEDLE)) continue;

    // Si hay dos equipos LAS FLORES en el partido, se generará evento para cada uno (bueno)
    const candidates = [];
    if (localN.includes(TEAM_NEEDLE)) candidates.push(m.local);
    if (visitN.includes(TEAM_NEEDLE)) candidates.push(m.visitante);

    const d = parseDateDDMMYYYY(m.fecha);
    if (!d) continue;

    const t = parseTimeHHMM(m.hora);
    const start = toLocalDate(d, t);

    const summary = `${m.local} vs ${m.visitante} (Federado)`;
    const description = m.resultado && m.resultado !== "-" ? `Resultado: ${m.resultado}` : "";

    const evt =
      t != null
        ? { type: "timed", start, summary, location: m.lugar || "", description }
        : {
            type: "allday",
            start,
            end: new Date(start.getTime() + 86400000),
            summary,
            location: m.lugar || "",
            description,
          };

    for (const teamName of candidates) {
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

  log(
    `📦 Generados ${outFiles.length} calendarios para torneo=${meta.tournamentId} grupo=${meta.groupId}`
  );
}

// ------------------------------------------------------------
// ✔✔✔ discoverTournamentIds — versión robusta
// ------------------------------------------------------------
async function discoverTournamentIds(driver) {
  await driver.get(BASE_LIST_URL);
  log(`🌐 Página base: ${BASE_LIST_URL}`);

  // Guardar snapshot siempre
  try {
    const html0 = await driver.getPageSource();
    const debugPath = path.join(DEBUG_DIR, `fed_list_debug_${RUN_STAMP}.html`);
    fs.writeFileSync(debugPath, html0);
    log(`📄 Snapshot HTML lista de torneos guardado en: ${debugPath}`);
  } catch (_) {}

  // Esperar a que aparezcan enlaces o tabla
  try {
    await driver.wait(
      until.elementLocated(By.css("a[href*='/es/tournament/'], table")),
      20000
    );
  } catch (_) {}

  const html = await driver.getPageSource();
  const tournaments = [];

  // Buscar IDs vía HTML (siempre funciona)
  const idMatches = [...html.matchAll(/\/es\/tournament\/(\d+)\/summary/g)];
  const ids = [...new Set(idMatches.map(m => m[1]))];

  for (const id of ids) {
    // Extraer <tr> completo
    const trRegex = new RegExp(
      `<tr[\\s\\S]*?href="[^"]*/es/tournament/${id}/summary"[\\s\\S]*?<\\/tr>`,
      "i"
    );
    const trMatch = html.match(trRegex);
    const tr = trMatch ? trMatch[0] : "";

    // Nombre
    let label = "";
    const nameMatch = tr.match(
      /<td[^>]*class="[^"]*colstyle-nombre[^"]*"[^>]*>([\s\S]*?)<\/td>/i
    );
    if (nameMatch) {
      label = normalize(nameMatch[1].replace(/<[^>]+>/g, " "));
    }

    // Categoría
    let category = "";
    const catMatch = tr.match(
      /<td[^>]*class="[^"]*colstyle-categoria[^"]*"[^>]*>([\s\S]*?)<\/td>/i
    );
    if (catMatch) {
      category = normalize(catMatch[1].replace(/<[^>]+>/g, " "));
    }

    tournaments.push({
      id,
      label: label || `Torneo ${id}`,
      category: (category.toUpperCase() || "SIN-CATEGORIA").replace("JUNIOR", "JUVENIL"),
    });
  }

  log(`🔎 Torneos detectados: ${tournaments.length}`);
  return tournaments;
}

// ------------------------------------------------------------
// ✔✔✔ discoverGroupIds — 100% DOM, usando <select name="group">
// ------------------------------------------------------------
async function discoverGroupIds(driver, tournamentId) {
  const url = `https://favoley.es/es/tournament/${tournamentId}`;
  log(`➡️ Abriendo torneo (solo DOM): ${url}`);
  await driver.get(url);

  let selectEl;
  try {
    selectEl = await driver.wait(
      until.elementLocated(By.css("select[name='group']")),
      15000
    );
  } catch (e) {
    log(`⚠️ No se encontró <select name="group"> en torneo ${tournamentId}`);
    return [];
  }

  const options = await selectEl.findElements(By.css("option"));
  const groups = [];

  for (const opt of options) {
    const value = await opt.getAttribute("value");
    const label = (await opt.getText()).trim();
    if (value) groups.push({ id: value, label });
  }

  if (!groups.length) {
    log(`⚠️ No se detectaron grupos para torneo ${tournamentId}`);
    const html = await driver.getPageSource();
    fs.writeFileSync(
      path.join(DEBUG_DIR, `fed_groups_empty_${tournamentId}.html`),
      html
    );
  } else {
    const txt = groups.map(g => `${g.label} → ${g.id}`).join(" | ");
    log(`📌 Grupos detectados: ${txt}`);
  }

  return groups;
}


// ------------------------------------------------------------
// MAIN
// ------------------------------------------------------------
(async () => {
  log("🏐 Iniciando scraping FEDERADO multi-equipos LAS FLORES…");

  const tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-fed-"));
  const options = new chrome.Options()
    .addArguments("--headless=new")
    .addArguments("--disable-gpu")
    .addArguments("--no-sandbox")
    .addArguments("--disable-dev-shm-usage")
    .addArguments(`--user-data-dir=${tmpUserDir}`);

  let driver;
  try {
    driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();

    // 1) Torneos
    const tournaments = await discoverTournamentIds(driver);

    // 2) Cada torneo → grupos
    for (const t of tournaments) {
      log(`\n======= 🏷 Torneo ${t.id} :: ${t.label} (cat: ${t.category}) =======`);

      let groups = [];
      try {
        groups = await discoverGroupIds(driver, t.id);
      } catch (e) {
        onError(e, `discoverGroupIds t=${t.id}`);
        continue;
      }

      log(`🔹 Grupos detectados: ${groups.length}`);

      if (!groups.length) continue;

      // 3) Cada grupo → calendario "all"
      for (const groupId of groups) {
        const calURL = `https://favoley.es/es/tournament/${t.id}/calendar/${groupId}/all`;
        try {
          log(`➡️ Abriendo calendario: ${calURL}`);
          await driver.get(calURL);

          // Asegurar que hay algo de tabla/listado
          await driver.wait(until.elementLocated(By.css("table, .table, .row, tbody")), 15000);

          await parseFederadoCalendarPage(driver, {
            tournamentId: t.id,
            groupId,
            category: t.category,
          });
        } catch (e) {
          onError(e, `parse calendar t=${t.id} g=${groupId}`);
          try {
            const html = await driver.getPageSource();
            fs.writeFileSync(path.join(DEBUG_DIR, `fed_err_${t.id}_${groupId}.html`), html);
          } catch (_) {}
          continue;
        }
      }
    }

    log("\n✅ Scraping federado multi-equipos completado.");
  } catch (err) {
    onError(err, "MAIN");
  } finally {
    try {
      if (driver) await driver.quit();
    } catch (_) {}
    log("🧹 Chrome cerrado");
  }
})();
