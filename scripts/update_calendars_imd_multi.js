// scripts/update_calendars_imd_multi.js (VERSIÓN CORREGIDA)
// Genera un calendario .ics por cada equipo del C.D. LAS FLORES desde la web del IMD Sevilla
// y al final genera automáticamente el index.html
//
// Cambios principales:
// - Esperas robustas tras datosequipo()
// - Guardado de snapshots (after_datosequipo, after_clasif, error)
// - parseIMDClasificacion() fiable que abre tab de clasificaciones y selecciona PROVISIONALES
// - Guardado de clasificaciones en calendarios/imd_clasificaciones.json (clave = safeName usado en imd_*.ics)
// - Si no hay clasificación nueva, usa la guardada si existe

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
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

function normalize(s) {
  return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}

// --------------------
// ICS Helpers
// --------------------
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

function safeNameForFile(category, teamName) {
  return `${category}_${teamName}`.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function writeICS(teamName, category, events) {
  const safeName = safeNameForFile(category, teamName);
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

// --------------------
// Scraping Helpers
// --------------------
async function parseTeamCalendar(driver, teamName) {
  const TEAM_EXACT = teamName.trim().toUpperCase();
  const allEvents = [];

  const container = await driver.findElement(By.id("tab1"));
  const tables = await container.findElements(By.css("table.tt"));
  log(`📑 ${tables.length} tablas detectadas para ${teamName}`);

  for (const table of tables) {
    let rows = [];
    try { rows = await table.findElements(By.css("tbody > tr")); } catch (e) {}
    if (rows.length <= 2) continue;

    for (let i = 2; i < rows.length; i++) {
      try {
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
      } catch (e) { /* ignore row parse errors */ }
    }
  }

  return allEvents;
}

// --------------------
// PARSE IMD CLASIFICACION
// --------------------
// Debe abrir la pestaña de clasificaciones, seleccionar PROVISIONALES (valor=1) y parsear la tabla .tt
async function parseIMDClasificacion(driver, opts = {}) {
  // opts: { slug } para nombrar snapshots
  const slug = opts.slug || `unknown_${Date.now()}`;
  try {
    log("   ➕ Iniciando lectura de clasificación IMD…");

    // 1) Pulsar pestaña clasificaciones (si existe)
    try {
      const tab2 = await driver.findElement(By.id("tab_opc2"));
      await driver.executeScript("arguments[0].click();", tab2);
      log("   ✔ Tab clasificaciones pulsado");
    } catch (e) {
      log("   ⚠ No se encontró #tab_opc2 para click: " + e.message);
      // intentar forzar con script (por si tiene otro id)
      try { await driver.executeScript("$('#tab_opc2').click()"); } catch {}
    }

    // 2) Esperar que #tab1 cargue nuevo contenido (tabla .tt o campo selprov)
    try {
      await driver.wait(until.elementLocated(By.css("#tab1 .tt, #selprov")), 8000);
    } catch (e) {
      log("   ⚠ Timeout esperando #tab1 después de abrir clasificaciones: " + (e && e.message));
      // guardar snapshot
      try {
        const html = await driver.getPageSource();
        fs.writeFileSync(path.join(DEBUG_DIR, `imd_after_clasif_${slug}.html`), html, "utf8");
        log(`   ⚠ Snapshot guardado: imd_after_clasif_${slug}.html`);
      } catch (ex) {}
      return null;
    }

    // 3) Si existe select#selprov, seleccionamos PROVISIONALES (value=1)
    try {
      const selProvElems = await driver.findElements(By.id("selprov"));
      if (selProvElems.length) {
        const selProv = selProvElems[0];
        // usar executeScript para fijar el valor y disparar cambioprov()
        await driver.executeScript("arguments[0].value = '1'; window.cambioprov && window.cambioprov();", selProv);
        log("   ✔ selprov cambiado a PROVISIONALES");
      } else {
        log("   ⚠ select#selprov no presente (usar valor por defecto).");
      }
    } catch (e) {
      log("   ⚠ Error al cambiar selprov: " + e.message);
    }

    // 4) Esperar la tabla de clasificación con filas (al menos 1 fila)
    try {
      await driver.wait(until.elementLocated(By.css("#tab1 table.tt tbody tr")), 8000);
    } catch (e) {
      log("   ↪ Buscando tabla de clasificación… (timeout)");
      // guardar snapshot para depuración
      try {
        const html = await driver.getPageSource();
        fs.writeFileSync(path.join(DEBUG_DIR, `imd_after_clasif_${slug}.html`), html, "utf8");
        log(`   ⚠ Snapshot guardado: imd_after_clasif_${slug}.html`);
      } catch (ex) {}
      return null;
    }

    // ahora parseamos las filas
    const table = await driver.findElement(By.css("#tab1 table.tt"));
    const rows = await table.findElements(By.css("tbody > tr"));
    log(`      ↪ Tabla IMD: ${rows.length} filas`);

    const result = [];
    for (let i = 0; i < rows.length; i++) {
      try {
        const row = rows[i];
        const tds = await row.findElements(By.css("td"));
        // en la tabla de IMD la primera columna es el nombre (podría tener prefijo "1 - ")
        if (tds.length < 11) continue;
        const colsText = await Promise.all(tds.map(c => c.getText().then(t => t.trim())));
        // colsText layout: [team, pj, pg, pe, pp, pnp, jf, jc, tf, tc, puntos]
        const teamRaw = colsText[0].replace(/^\d+\s*-\s*/, "").trim();
        result.push({
          team: teamRaw,
          pj: colsText[1],
          pg: colsText[2],
          pe: colsText[3],
          pp: colsText[4],
          pnp: colsText[5],
          jf: colsText[6],
          jc: colsText[7],
          tf: colsText[8],
          tc: colsText[9],
          pts: colsText[10],
        });
      } catch (e) {
        // ignorar fila problemática
      }
    }

    // guardar snapshot final con la tabla por si hace falta
    try {
      const html = await driver.getPageSource();
      fs.writeFileSync(path.join(DEBUG_DIR, `imd_after_clasif_${slug}.html`), html, "utf8");
    } catch (ex) {}

    return result;
  } catch (err) {
    log("   ❌ Error en parseIMDClasificacion: " + (err && err.message ? err.message : String(err)));
    try {
      const html = await driver.getPageSource();
      fs.writeFileSync(path.join(DEBUG_DIR, `imd_error_${slug}.html`), html, "utf8");
      log(`   ⚠ Snapshot imd_error_${slug}.html guardado`);
    } catch (ex) {}
    return null;
  }
}

// --------------------
// MAIN SCRIPT
// --------------------
(async () => {
  log("🌼 Iniciando generación de calendarios IMD para equipos LAS FLORES...");

  const tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-imd-"));
  const options = new chrome.Options()
    .addArguments("--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${tmpUserDir}`)
    .addArguments("--lang=es-ES")
    .addArguments("--window-size=1280,1024")
    .addArguments("--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36");

  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();

  try {
    await driver.get(IMD_URL);
    log(`🌐 Página abierta: ${IMD_URL}`);

    const input = await driver.wait(until.elementLocated(By.id("busqueda")), 15000);
    await driver.wait(until.elementIsVisible(input), 5000);

    await input.clear();
    await input.sendKeys(SEARCH_TERM, Key.ENTER);
    log(`🔎 Buscando '${SEARCH_TERM}'...`);
    await driver.sleep(1200);

    await driver.wait(
      until.elementLocated(By.xpath("//table[contains(@class,'tt')]//td[contains(.,'Nº.Equipos') or contains(.,'Nº.Equipos')]")),
      15000
    );
    const tab1 = await driver.findElement(By.id("tab1"));
    const table = await tab1.findElement(By.css("table.tt"));
    const rows = await table.findElements(By.css("tbody > tr"));
    log(`📋 ${rows.length} filas encontradas en tabla de equipos.`);

    const equipos = [];
    for (const row of rows) {
      try {
        const cols = await row.findElements(By.css("td"));
        if (cols.length < 3) continue;
        const nombre = (await cols[0].getText()).trim().toUpperCase();
        const categoria = (await cols[2].getText()).trim().toUpperCase();
        if (nombre.includes("LAS FLORES")) {
          const rowHtml = await row.getAttribute("outerHTML");
          const match = rowHtml.match(/datosequipo\('([A-F0-9-]+)'\)/i);
          if (match) equipos.push({ id: match[1], nombre, categoria });
        }
      } catch (e) {}
    }

    log(`🌸 ${equipos.length} equipos LAS FLORES detectados.`);

    // cargar clasificaciones ya guardadas existentes (para fallback)
    const clasifPath = path.join(OUTPUT_DIR, "imd_clasificaciones.json");
    let clasifData = {};
    if (fs.existsSync(clasifPath)) {
      try { clasifData = JSON.parse(fs.readFileSync(clasifPath, "utf8")); } catch (e) { clasifData = {}; }
    }

    for (const { id, nombre, categoria } of equipos) {
      const safeName = safeNameForFile(categoria, nombre);
      const slug = safeName; // coincidente con imd_<slug>.ics
      log(`\n➡️ Procesando ${nombre} (${categoria})...`);
      try {
        // ejecutar datosequipo (esto carga el calendario via AJAX)
        await driver.executeScript(`datosequipo("${id}")`);
        log("   ✔ datosequipo ejecutado");

        // esperar a que el calendario (o cualquier tabla) sea visible dentro de #tab1
        try {
          await driver.wait(until.elementLocated(By.css("#tab1 table.tt, #tab1 .tt")), 9000);
          log("   ✔ Calendario / tabla detectada en #tab1");
        } catch (e) {
          log(`   ❌ Timeout esperando calendario para ${nombre}: ${e && e.message}`);
          // guardar snapshot
          try {
            const snap = await driver.getPageSource();
            fs.writeFileSync(path.join(DEBUG_DIR, `imd_error_after_datosequipo_${slug}.html`), snap, "utf8");
            log(`   ⚠ Snapshot imd_error_after_datosequipo_${slug}.html guardado`);
          } catch (ex) {}
          // continuar al siguiente equipo
          throw new Error("Timeout calendario");
        }

        // guardar snapshot justo después de datosequipo (útil para depurar)
        try {
          const htmlAfter = await driver.getPageSource();
          fs.writeFileSync(path.join(DEBUG_DIR, `imd_after_datosequipo_${slug}.html`), htmlAfter, "utf8");
          log(`   ✔ Snapshot guardado: imd_after_datosequipo_${slug}.html`);
        } catch (e) {}

        // parsear calendario / eventos
        const events = await parseTeamCalendar(driver, nombre);
        writeICS(nombre, categoria, events);
        log(`   ✔ ${nombre} (${categoria}): ${events.length} partidos capturados`);

        // --- Obtener clasificación IMD para este equipo ---
        try {
          const clasif = await parseIMDClasificacion(driver, { slug });
          // si clasif === null o vacío, usar guardada
          if (!clasif || !clasif.length) {
            log("   ⚠ No se obtuvo clasificación nueva, usando la guardada si existe.");
            // si hay una previa, dejarla; sino dejar null
          } else {
            // guardar en memoria local
            clasifData[slug] = clasif;
            log(`   ✔ Clasificación IMD leída (${clasif.length} filas)`);
          }

          // escribir fichero actualizado (incluso si no cambió, para asegurar persistencia)
          try { fs.writeFileSync(clasifPath, JSON.stringify(clasifData, null, 2), "utf8"); } catch (e) { log("   ⚠ No se pudo guardar imd_clasificaciones.json: " + e.message); }

        } catch (err) {
          log(`   ⚠ Error guardando clasificación IMD para ${nombre}: ${err && err.message ? err.message : err}`);
        }

      } catch (errOuter) {
        log(`❌ ERROR PROCESANDO ${nombre}: ${errOuter && errOuter.message ? errOuter.message : errOuter}`);
        // guardar snapshot de error ya guardado más arriba en casos concretos
        continue;
      }
    }

    // 🧩 Generar automáticamente el index.html al final
    log("\n🧱 Generando index.html automáticamente...");
    try {
      execSync("node scripts/generate_index_html.js", { stdio: "inherit" });
      log("✅ index.html actualizado correctamente.");
    } catch (e) {
      log("❌ Error generando index.html: " + (e && e.message ? e.message : e));
    }

    log("💚 IMD COMPLETADO");

  } catch (err) {
    log(`❌ ERROR GENERAL: ${err && err.stack ? err.stack : err}`);
  } finally {
    try { await driver.quit(); } catch (e) {}
    log("🧹 Chrome cerrado");
  }
})();
