// scripts/update_calendars_imd_multi.js
// GENERADOR DE CALENDARIOS IMD (solo .ics) – versión final optimizada
// NO obtiene clasificaciones IMD (eso lo hace update_clasificaciones_imd.js)

const fs = require("fs");
const path = require("path");
const os = require("os");
const { Builder, By, Key, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const { execSync } = require("child_process");

const IMD_URL = "https://imd.sevilla.org/app/jjddmm_resultados/";
const SEARCH_TERM = "las flores";

const OUTPUT_DIR = "calendarios";
const DEBUG_DIR = path.join(OUTPUT_DIR, "debug");
const LOG_DIR = path.join(OUTPUT_DIR, "logs");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(DEBUG_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = path.join(LOG_DIR, `imd_calendars_${RUN_STAMP}.log`);

function log(msg) {
  console.log(msg);
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

// ---------- Helpers ----------
function safeNameForFile(category, teamName) {
  return `${category}_${teamName}`.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function pad(n) {
  return String(n).padStart(2, "0");
}

const ICS_TZID = "Europe/Madrid";

function fmtICSDateTimeTZID(dt) {
  return `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(
    dt.getDate()
  )}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;
}

function fmtICSDate(d) {
  const Y = d.getUTCFullYear();
  const M = pad(d.getUTCMonth() + 1);
  const D = pad(d.getUTCDate());
  return `${Y}${M}${D}`;
}

function writeICS(teamName, category, events) {
  const safe = safeNameForFile(category, teamName);
  const filename = `imd_${safe}.ics`;
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
DTSTART;TZID=${ICS_TZID}:${fmtICSDateTimeTZID(evt.start)}
DESCRIPTION:${evt.description || ""}
END:VEVENT
`;
    } else {
      ics += `BEGIN:VEVENT
SUMMARY:${evt.summary}
LOCATION:${evt.location}
DTSTART;VALUE=DATE:${fmtICSDate(evt.start)}
DTEND;VALUE=DATE:${fmtICSDate(evt.end)}
DESCRIPTION:${evt.description || ""}
END:VEVENT
`;
    }
  }

  ics += "END:VCALENDAR\n";
  fs.writeFileSync(path.join(OUTPUT_DIR, filename), ics);
  log(`✅ ${filename} (${events.length} eventos)`);
}

// ---------- Parse calendario ----------
async function parseTeamCalendar(driver, teamName) {
  const TEAM_EXACT = teamName.trim().toUpperCase();
  const events = [];

  const container = await driver.findElement(By.id("tab1"));
  const tables = await container.findElements(By.css("table.tt"));
  log(`📑 ${tables.length} tablas detectadas para ${teamName}`);

  for (const table of tables) {
    let rows = [];
    try {
      rows = await table.findElements(By.css("tbody > tr"));
    } catch {}
    if (rows.length <= 2) continue;

    for (let i = 2; i < rows.length; i++) {
      const cols = await rows[i].findElements(By.css("td"));
      if (cols.length < 5) continue;

      const vals = await Promise.all(
        cols.map(c => c.getText().then(t => t.trim()))
      );

      const [
        fecha,
        hora,
        local,
        visitante,
        resultado,
        lugar,
        obsEncuentro,
        obsResultado,
      ] = vals.concat(new Array(8).fill(""));

      const involves =
        (local || "").toUpperCase().includes(TEAM_EXACT) ||
        (visitante || "").toUpperCase().includes(TEAM_EXACT);

      if (!involves) continue;

      const m = (fecha || "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
      if (!m) continue;
      const [_, dd, MM, yyyy] = m;

      const time = (hora || "").match(/(\d{2}):(\d{2})/);
      const start = new Date(
        `${yyyy}-${MM}-${dd}T${time ? time[0] : "00:00"}:00`
      );

      const summary = `${local} vs ${visitante} (IMD)`;
      const descParts = [];
      if (resultado && resultado !== "-") descParts.push(`Resultado: ${resultado}`);
      if (obsEncuentro && obsEncuentro !== "-")
        descParts.push(`Obs. Encuentro: ${obsEncuentro}`);
      if (obsResultado && obsResultado !== "-")
        descParts.push(`Obs. Resultado: ${obsResultado}`);

      events.push({
        type: time ? "timed" : "allday",
        summary,
        location: lugar || "Por confirmar",
        start,
        end: time ? null : new Date(start.getTime() + 86400000),
        description: descParts.join(" | "),
      });
    }
  }

  return events;
}

// ---------- MAIN ----------
(async () => {
  log("🌼 Iniciando generación de calendarios IMD (solo ICS)...");

  const tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-imd-"));

  const options = new chrome.Options()
    .addArguments("--headless=new")
    .addArguments("--disable-gpu")
    .addArguments("--no-sandbox")
    .addArguments("--disable-dev-shm-usage")
    .addArguments(`--user-data-dir=${tmpUserDir}`)
    .addArguments("--lang=es-ES")
    .addArguments("--window-size=1400,1200")
    .addArguments(
      "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
    );

  const driver = await new Builder()
    .forBrowser("chrome")
    .setChromeOptions(options)
    .build();

  try {
    await driver.get(IMD_URL);
    log(`🌐 Página abierta: ${IMD_URL}`);

    const input = await driver.wait(
      until.elementLocated(By.id("busqueda")),
      15000
    );
    await driver.wait(until.elementIsVisible(input), 5000);
    await input.clear();
    await input.sendKeys(SEARCH_TERM, Key.ENTER);
    log(`🔎 Buscando '${SEARCH_TERM}'...`);
    await driver.sleep(1400);

    await driver.wait(
      until.elementLocated(
        By.xpath(
          "//table[contains(@class,'tt')]//td[contains(.,'Nº') or contains(.,'Equipos')]"
        )
      ),
      20000
    );

    const tab1 = await driver.findElement(By.id("tab1"));
    const table = await tab1.findElement(By.css("table.tt"));
    const rows = await table.findElements(By.css("tbody > tr"));
    log(`📋 ${rows.length} filas encontradas en tabla de equipos.`);

    // ---- recopilar equipos LAS FLORES ----
    const equipos = [];
    for (const row of rows) {
      try {
        const cols = await row.findElements(By.css("td"));
        if (cols.length < 3) continue;

        const nombre = (await cols[0].getText()).trim().toUpperCase();
        const categoria = (await cols[2].getText()).trim().toUpperCase();

        if (nombre.includes("LAS FLORES")) {
          const html = await row.getAttribute("outerHTML");
          const m = html.match(/datosequipo\('([A-F0-9-]+)'\)/i);
          if (m) equipos.push({ id: m[1], nombre, categoria });
        }
      } catch {}
    }

    log(`🌸 ${equipos.length} equipos LAS FLORES detectados.`);

    // ---- procesar cada equipo ----
    for (const { id, nombre, categoria } of equipos) {
      const slug = safeNameForFile(categoria, nombre);

      log(`\n➡️ Procesando ${nombre} (${categoria})...`);

      try {
        await driver.executeScript(`datosequipo("${id}")`);
        log("   ✔ datosequipo ejecutado");

        // esperar a que aparezca alguna tabla tt dentro de #tab1
        try {
          await driver.wait(
            until.elementLocated(By.css("#tab1 table.tt")),
            10000
          );
          log("   ✔ Tabla calendario detectada");
        } catch (e) {
          log(
            `   ❌ No apareció tabla de calendario para ${nombre}: ${
              e.message || e
            }`
          );
          const snap = path.join(
            DEBUG_DIR,
            `imd_error_after_datosequipo_${slug}.html`
          );
          fs.writeFileSync(snap, await driver.getPageSource(), "utf8");
          continue;
        }

        // snapshot
        const snapOK = path.join(
          DEBUG_DIR,
          `imd_after_datosequipo_${slug}.html`
        );
        fs.writeFileSync(snapOK, await driver.getPageSource(), "utf8");
        log(`   ✔ Snapshot guardado: ${path.basename(snapOK)}`);

        // parsear calendario
        const events = await parseTeamCalendar(driver, nombre);
        writeICS(nombre, categoria, events);

        log(
          `   ✔ ${nombre} (${categoria}): ${events.length} partidos capturados`
        );
      } catch (err) {
        log(
          `❌ ERROR procesando ${nombre}: ${
            err && err.message ? err.message : err
          }`
        );
      }
    }

    // ---- generar index.html ----
    log("\n🧱 Generando index.html automáticamente...");
    try {
      execSync("node scripts/generate_index_html.js", { stdio: "inherit" });
      log("✨ index.html actualizado correctamente.");
    } catch (err) {
      log(`❌ Error generando index.html: ${err.message || err}`);
    }

    log("💚 IMD (calendarios) COMPLETADO");

  } catch (err) {
    log("❌ ERROR GENERAL: " + (err.stack || err));
  } finally {
    try {
      await driver.quit();
    } catch {}
    log("🧹 Chrome cerrado");
  }
})();
