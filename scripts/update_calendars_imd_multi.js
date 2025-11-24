// scripts/update_calendars_imd_multi.js
// Genera calendarios IMD + clasificaciones IMD con debug paso a paso

const fs = require("fs");
const path = require("path");
const os = require("os");
const { Builder, By, Key, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const { execSync } = require("child_process");

const IMD_URL = "https://imd.sevilla.org/app/jjddmm_resultados/";
const SEARCH_TERM = "las flores";
const OUTPUT_DIR = path.join("calendarios");
const DEBUG_DIR = path.join(OUTPUT_DIR, "debug");
const LOG_DIR = path.join(OUTPUT_DIR, "logs");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(DEBUG_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = path.join(LOG_DIR, `imd_multi_${RUN_STAMP}.log`);
const ICS_TZID = "Europe/Madrid";

function log(msg) {
  console.log(msg);
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
}

function normalize(s) {
  return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}

// --------------------------------------------------------
// ----------- ICS HELPERS -------------------------------
// --------------------------------------------------------

function fmtICSDateTimeTZID(dt) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;
}

function fmtICSDate(d) {
  const Y = d.getUTCFullYear();
  const M = String(d.getUTCMonth() + 1).padStart(2, "0");
  const D = String(d.getUTCDate()).padStart(2, "0");
  return `${Y}${M}${D}`;
}

function writeICS(teamName, category, events) {
  const safeName = `${category}_${teamName}`.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const filename = `imd_${safeName}.ics`;

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

// --------------------------------------------------------
// ----------- EXTRACCIÓN CALENDARIO ----------------------
// --------------------------------------------------------

async function parseTeamCalendar(driver, teamName) {
  const TEAM_EXACT = teamName.trim().toUpperCase();
  const allEvents = [];

  const container = await driver.findElement(By.id("tab1"));
  const tables = await container.findElements(By.css("table.tt"));
  log(`📑 ${tables.length} tablas detectadas para ${teamName}`);

  for (const table of tables) {
    const rows = await table.findElements(By.css("tbody > tr"));
    if (rows.length <= 2) continue;

    for (let i = 2; i < rows.length; i++) {
      const cols = await rows[i].findElements(By.css("td"));
      if (cols.length < 8) continue;

      const vals = await Promise.all(cols.map((c) => c.getText().then((t) => t.trim())));
      const [fecha, hora, local, visitante, resultado, lugar, obsEncuentro, obsResultado] = vals;

      const involves = local.toUpperCase().includes(TEAM_EXACT) || visitante.toUpperCase().includes(TEAM_EXACT);
      if (!involves) continue;

      const match = fecha.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      if (!match) continue;
      const [_, dd, MM, yyyy] = match;

      const time = hora.match(/(\d{2}):(\d{2})/);
      const start = new Date(`${yyyy}-${MM}-${dd}T${time ? time[0] : "00:00"}:00`);

      const summary = `${local} vs ${visitante} (IMD)`;
      const descriptionParts = [];

      if (resultado && resultado !== "-") descriptionParts.push(`Resultado: ${resultado}`);
      if (obsEncuentro && obsEncuentro !== "-") descriptionParts.push(`Obs. Encuentro: ${obsEncuentro}`);
      if (obsResultado && obsResultado !== "-") descriptionParts.push(`Obs. Resultado: ${obsResultado}`);

      const description = descriptionParts.join(" | ");

      allEvents.push({
        type: time ? "timed" : "allday",
        summary,
        location: lugar || "Por confirmar",
        start,
        end: time ? null : new Date(start.getTime() + 86400000),
        description,
      });
    }
  }

  return allEvents;
}

// --------------------------------------------------------
// ----------- PARSE CLASIFICACIÓN IMD --------------------
// --------------------------------------------------------

async function parseIMDClasificacion(driver) {
  log("      ↪ Buscando tabla de clasificación…");

  const table = await driver.wait(
    until.elementLocated(By.css("#tab1 table.tt tbody")),
    8000
  );

  const rows = await table.findElements(By.css("tr"));
  if (!rows.length) return [];

  const out = [];

  for (let i = 1; i < rows.length; i++) {
    const cols = await rows[i].findElements(By.css("td"));
    if (cols.length < 11) continue;

    const vals = await Promise.all(cols.map((c) => c.getText().then((t) => t.trim())));

    const [
      equipo,
      pj,
      pg,
      pe,
      pp,
      pnp,
      jf,
      jc,
      tf,
      tc,
      puntos
    ] = vals;

    out.push({
      team: equipo.replace(/^\d+\s*-\s*/, ""),
      pj, pg, pe, pp, pnp, jf, jc, tf, tc, puntos
    });
  }

  log(`      ✔ Tabla IMD: ${out.length} filas`);

  return out;
}

// --------------------------------------------------------
// ----------- MAIN SCRIPT IMD ----------------------------
// --------------------------------------------------------

(async () => {
  log("🌼 Iniciando generación de calendarios IMD para equipos LAS FLORES...");

  const tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-imd-"));
  const options = new chrome.Options()
    .addArguments("--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${tmpUserDir}`);

  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();

  try {
    await driver.get(IMD_URL);
    log(`🌐 Página abierta: ${IMD_URL}`);

    const input = await driver.wait(until.elementLocated(By.id("busqueda")), 15000);
    await driver.wait(until.elementIsVisible(input), 5000);

    await input.clear();
    await input.sendKeys(SEARCH_TERM, Key.ENTER);
    log(`🔎 Buscando '${SEARCH_TERM}'...`);
    await driver.sleep(1500);

    await driver.wait(
      until.elementLocated(By.xpath("//table[contains(@class,'tt')]//td[contains(.,'Nº.Equipos')]")),
      20000
    );

    const tab1 = await driver.findElement(By.id("tab1"));
    const table = await tab1.findElement(By.css("table.tt"));
    const rows = await table.findElements(By.css("tbody > tr"));
    log(`📋 ${rows.length} filas encontradas en tabla de equipos.`);

    const equipos = [];

    for (const row of rows) {
      const cols = await row.findElements(By.css("td"));
      if (cols.length < 3) continue;

      const nombre = (await cols[0].getText()).trim().toUpperCase();
      const categoria = (await cols[2].getText()).trim().toUpperCase();
      if (nombre.includes("LAS FLORES")) {
        const html = await row.getAttribute("outerHTML");
        const match = html.match(/datosequipo\('([A-F0-9-]+)'\)/i);
        if (match) equipos.push({ id: match[1], nombre, categoria });
      }
    }

    log(`🌸 ${equipos.length} equipos LAS FLORES detectados.`);

    // ==========================================================
    // ================ BUCLE PRINCIPAL CON DEBUG ===============
    // ==========================================================

    for (const { id, nombre, categoria } of equipos) {
      log(`\n➡️ Procesando ${nombre} (${categoria})...`);

      try {
        // -------------------------------
        // 1) Ejecutar datosequipo
        // -------------------------------
        await driver.executeScript(`datosequipo("${id}")`);
        await driver.sleep(1000);
        log("   ✔ datosequipo ejecutado");

        fs.writeFileSync(
          path.join(DEBUG_DIR, `imd_after_datosequipo_${nombre.replace(/[^a-z0-9]+/gi, "_")}.html`),
          await driver.getPageSource()
        );

        // -------------------------------
        // 2) Seleccionar jornadas
        // -------------------------------
        const selJor = await driver.wait(until.elementLocated(By.id("seljor")), 8000);
        await driver.wait(until.elementIsVisible(selJor), 8000);
        await selJor.sendKeys("Todas");
        await driver.sleep(1000);

        log("   ✔ Selector seljor OK");

        fs.writeFileSync(
          path.join(DEBUG_DIR, `imd_after_seljor_${nombre.replace(/[^a-z0-9]+/gi, "_")}.html`),
          await driver.getPageSource()
        );

        // -------------------------------
        // 3) Parsear calendario
        // -------------------------------
        const events = await parseTeamCalendar(driver, nombre);
        writeICS(nombre, categoria, events);
        log(`   ✔ ${events.length} partidos capturados`);

        // -------------------------------
        // 4) CLASIFICACIÓN IMD
        // -------------------------------
        log("   ➕ Iniciando lectura de clasificación IMD…");

        const tabClasif = await driver.findElement(By.id("tab_opc2"));
        await tabClasif.click();
        await driver.sleep(1200);

        log("   ✔ Tab clasificaciones pulsado");

        fs.writeFileSync(
          path.join(DEBUG_DIR, `imd_after_tab_${nombre.replace(/[^a-z0-9]+/gi, "_")}.html`),
          await driver.getPageSource()
        );

        const selProv = await driver.wait(until.elementLocated(By.id("selprov")), 8000);
        await driver.wait(until.elementIsVisible(selProv), 8000);
        await selProv.sendKeys("1");
        await driver.sleep(1500);

        log("   ✔ selprov cambiado a PROVISIONALES");

        fs.writeFileSync(
          path.join(DEBUG_DIR, `imd_after_selprov_${nombre.replace(/[^a-z0-9]+/gi, "_")}.html`),
          await driver.getPageSource()
        );

        // -------------------------------
        // 5) Leer tabla
        // -------------------------------
        const clasif = await parseIMDClasificacion(driver);

        const key = `IMD_${categoria}_${nombre}`.toLowerCase().replace(/[^a-z0-9]+/g, "_");
        const clasifPath = path.join(OUTPUT_DIR, "imd_clasificaciones.json");

        let existing = {};
        if (fs.existsSync(clasifPath)) {
          try { existing = JSON.parse(fs.readFileSync(clasifPath, "utf8")); }
          catch {}
        }

        if (clasif && clasif.length > 0) {
          existing[key] = clasif;
          log(`   ✔ Clasificación nueva (${clasif.length} filas)`);
        } else {
          log("   ⚠ No se obtuvo clasificación nueva, usando la guardada si existe.");
        }

        fs.writeFileSync(clasifPath, JSON.stringify(existing, null, 2));
        log(`   ✔ Clasificación guardada: key=${key}`);

        fs.writeFileSync(
          path.join(DEBUG_DIR, `imd_final_${nombre.replace(/[^a-z0-9]+/gi, "_")}.html`),
          await driver.getPageSource()
        );

      } catch (err) {
        log(`❌ ERROR PROCESANDO ${nombre}: ${err.message}`);

        fs.writeFileSync(
          path.join(DEBUG_DIR, `imd_error_${nombre.replace(/[^a-z0-9]+/gi, "_")}.html`),
          await driver.getPageSource()
        );

        log("   ⚠ Snapshot imd_error guardado");
        continue;
      }
    }

    // -------------------------------
    // Generar index
    // -------------------------------
    log("\n🧱 Generando index.html...");
    execSync("node scripts/generate_index_html.js", { stdio: "inherit" });

    log("💚 IMD COMPLETADO");

  } catch (err) {
    log(`❌ ERROR GENERAL: ${err}`);
  } finally {
    await driver.quit();
    log("🧹 Chrome cerrado");
  }
})();
