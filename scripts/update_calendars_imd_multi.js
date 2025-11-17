// scripts/update_calendars_imd_multi.js
// Scraper IMD multi-equipos → genera 1 ICS por cada equipo LAS FLORES y EVB LAS FLORES.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { Builder, By, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

// Normalización avanzada (EVB / color / limpieza)
const { normalizeTeamDisplay, normalizeTeamSlug } = require("./team_name_utils");

const OUTPUT_DIR = path.join("calendarios");
const DEBUG_DIR = path.join(OUTPUT_DIR, "debug");
const LOG_DIR = path.join(OUTPUT_DIR, "logs");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(DEBUG_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = path.join(LOG_DIR, `imd_${RUN_STAMP}.log`);

const TEAM_NEEDLE = "las flores";

// ---------------------------
// Utils
// ---------------------------
function log(msg) {
  console.log(msg);
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

function normalize(s) {
  return (s || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDate(s) {
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return { dd: m[1], MM: m[2], yyyy: m[3] };
}

function parseTime(s) {
  const m = s.match(/(\d{2}):(\d{2})/);
  if (!m) return null;
  return { HH: m[1], mm: m[2] };
}

function fmtICSDateTime(dParts, tParts) {
  return `${dParts.yyyy}${dParts.MM}${dParts.dd}T${tParts.HH}${tParts.mm}00`;
}

function fmtDate(d) {
  return `${d.yyyy}${d.MM}${d.dd}`;
}

function isLasFloresTeam(name) {
  return (name || "").toUpperCase().includes("LAS FLORES");
}

// ---------------------------
// writeICS
// ---------------------------
function writeICS(fileName, events) {
  let ics = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:PUBLISH
PRODID:-//Las Flores//Calendarios IMD//ES
`;

  for (const evt of events) {
    if (evt.type === "timed") {
      ics += `BEGIN:VEVENT
SUMMARY:${evt.summary}
LOCATION:${evt.location}
DTSTART:${evt.start}
DESCRIPTION:${evt.description}
END:VEVENT
`;
    } else {
      ics += `BEGIN:VEVENT
SUMMARY:${evt.summary}
LOCATION:${evt.location}
DTSTART;VALUE=DATE:${evt.start}
DTEND;VALUE=DATE:${evt.end}
DESCRIPTION:${evt.description}
END:VEVENT
`;
    }
  }

  ics += `END:VCALENDAR\n`;

  fs.writeFileSync(path.join(OUTPUT_DIR, fileName), ics);
  log(`✅ ${fileName} (${events.length} eventos)`);
}

// ---------------------------
// MAIN
// ---------------------------
(async () => {
  log("🌼 Iniciando generación de calendarios IMD para equipos LAS FLORES...");

  const options = new chrome.Options()
    .addArguments("--headless=new")
    .addArguments("--disable-gpu")
    .addArguments("--no-sandbox")
    .addArguments("--disable-dev-shm-usage")
    .addArguments("--lang=es-ES");

  let driver = null;

  try {
    driver = await new Builder()
      .forBrowser("chrome")
      .setChromeOptions(options)
      .build();

    await driver.get("https://imd.sevilla.org/app/jjddmm_resultados/");
    log("🌐 Página abierta: https://imd.sevilla.org/app/jjddmm_resultados/");

    // -------------------------------
    // Buscar equipos LAS FLORES
    // -------------------------------
    const searchInput = await driver.findElement(By.css("#busqueda"));
    await searchInput.sendKeys("flores");
    await driver.findElement(By.css("button")).click();

    await driver.wait(until.elementLocated(By.css("#resultado_equipos tbody tr")), 10000);

    const rows = await driver.findElements(By.css("#resultado_equipos tbody tr"));
    log(`📋 ${rows.length} filas encontradas en tabla de equipos.`);

    const teamsFound = [];

    for (const r of rows) {
      try {
        const tds = await r.findElements(By.css("td"));
        if (tds.length < 3) continue;

        const name = (await tds[0].getText()).trim();
        const category = (await tds[2].getText()).trim();

        if (name.toUpperCase().includes("LAS FLORES")) {
          teamsFound.push({ name, category });
        }
      } catch {}
    }

    log(`🌸 ${teamsFound.length} equipos LAS FLORES detectados.`);

    // -------------------------------
    // Procesar cada equipo
    // -------------------------------
    for (const team of teamsFound) {
      log(`\n➡️ Procesando ${team.name} (${team.category})...`);

      await driver.findElement(By.css("#busqueda")).clear();
      await driver.findElement(By.css("#busqueda")).sendKeys(team.name);
      await driver.findElement(By.css("button")).click();

      await driver.wait(until.elementLocated(By.css(".tab-content table")), 10000);

      const tables = await driver.findElements(By.css(".tab-content table"));
      log(`📑 ${tables.length} tablas detectadas para ${team.name}`);

      const events = [];

      for (const table of tables) {
        const trs = await table.findElements(By.css("tbody tr"));

        for (const tr of trs) {
          try {
            const tds = await tr.findElements(By.css("td"));
            if (tds.length < 4) continue;

            const fechaRaw = await tds[0].getText();
            const horaRaw = await tds[1].getText();
            const local = (await tds[2].getText()).trim();
            const visitante = (await tds[3].getText()).trim();

            const fecha = fechaRaw.trim();
            const hora = horaRaw.trim();

            const dParts = parseDate(fecha);
            const tParts = parseTime(hora);

            // MOSTRAR EQUIPOS → aplicar normalización SOLO si es del club
            const displayLocal = isLasFloresTeam(local)
              ? normalizeTeamDisplay(local)
              : local;

            const displayVisit = isLasFloresTeam(visitante)
              ? normalizeTeamDisplay(visitante)
              : visitante;

            const summary = `${displayLocal} vs ${displayVisit} (IMD)`;

            if (dParts && tParts) {
              events.push({
                type: "timed",
                summary,
                location: "",
                description: "",
                start: fmtICSDateTime(dParts, tParts)
              });
            } else if (dParts) {
              const start = fmtDate(dParts);
              const end = start;
              events.push({
                type: "allday",
                summary,
                location: "",
                description: "",
                start,
                end
              });
            }
          } catch {}
        }
      }

      // -------------------------------
      // Ordenar eventos
      // -------------------------------
      events.sort((a, b) => {
        if (a.type === "allday" && b.type !== "allday") return -1;
        if (b.type === "allday" && a.type !== "allday") return 1;
        return a.start.localeCompare(b.start);
      });

      const teamSlug = normalizeTeamSlug(team.name);
      const catSlug = team.category
        .toLowerCase()
        .replace(/\s+/g, "_")
        .replace(/[^\w_]/g, "");

      const filename = `imd_${catSlug}_${teamSlug}.ics`;

      writeICS(filename, events);

      log(`✅ ${team.name} (${team.category}): ${events.length} partidos.`);
    }

    // -------------------------------
    // FIN
    // -------------------------------
    log("🧱 Calendarios IMD generados correctamente.");

  } catch (err) {
    log("❌ ERROR IMD:");
    log(err);
  } finally {
    if (driver) {
      try { await driver.quit(); } catch {}
    }
    log("🧹 Chrome cerrado");
  }
})();
