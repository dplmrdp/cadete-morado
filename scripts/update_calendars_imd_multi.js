// scripts/update_calendars_imd_multi.js
// Genera un calendario .ics por cada equipo del C.D. LAS FLORES desde la web del IMD Sevilla
// y al final genera automáticamente el index.html

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

// --------------------
// IMD: parsear clasificación del equipo mostrado actualmente en el driver (versión robusta)
// --------------------
async function parseIMDClasificacion(driver) {
  try {
    // 1) clicar la pestaña "Consulta de Clasificaciones" (si existe)
    try {
      const tabClasif = await driver.findElement(By.id("tab_opc2"));
      await tabClasif.click();
    } catch (err) {
      // no fatal: puede no existir la pestaña explícita en alguna versión
    }

    // 2) esperar el select #selprov (si existe) y forzar "Resultados PROVISIONALES"
    try {
      await driver.wait(until.elementLocated(By.id("selprov")), 7000);
      // Intentamos forzar la opción y disparar la función onchange varias veces si hace falta
      await driver.executeScript(`
        const s = document.getElementById('selprov');
        if (s) {
          try { s.value = '1'; } catch(e){}
          if (typeof cambioprov === 'function') try { cambioprov(); } catch(e) {}
        }
      `);
      // pequeña espera para que la página procese la actualización
      await driver.sleep(800);
      // por si no se actualiza, pruebo también sendKeys
      try {
        const sel = await driver.findElement(By.id("selprov"));
        await sel.sendKeys("Resultados PROVISIONALES");
        await driver.sleep(600);
      } catch (e) {}
    } catch (err) {
      // si no hay select, seguimos: la tabla puede cargarse sin él
    }

    // 3) Espera flexible por la tabla de clasificación:
    // buscamos en estos contenedores posibles: #tab2, #tab1, o cualquier table.tt
    const selectors = ["#tab2 table.tt", "#tab1 table.tt", "table.tt"];
    let tableEl = null;
    for (const sel of selectors) {
      try {
        await driver.wait(until.elementLocated(By.css(sel)), 5000);
        const cand = await driver.findElements(By.css(sel));
        if (cand && cand.length) {
          // elegir la primera que tenga >1 filas (evitar cabeceras vacías)
          for (const t of cand) {
            try {
              const rows = await t.findElements(By.css("tbody > tr"));
              if (rows && rows.length >= 2) { // >=2 porque la primera puede ser título
                tableEl = t;
                break;
              }
            } catch (e) {}
          }
          if (tableEl) break;
        }
      } catch (e) {
        // no encontrado con este selector, pruebo el siguiente
      }
    }

    // Si aun así no encontramos, esperamos un poco más buscando cualquier table.tt visible
    if (!tableEl) {
      try {
        await driver.sleep(1200);
        const allTables = await driver.findElements(By.css("table.tt"));
        for (const t of allTables) {
          try {
            const rows = await t.findElements(By.css("tbody > tr"));
            if (rows && rows.length >= 2) { tableEl = t; break; }
          } catch (e) {}
        }
      } catch (e) {}
    }

    // Si no hay tabla, guardamos snapshot para debugging y devolvemos []
    if (!tableEl) {
      try {
        const html = await driver.getPageSource();
        const snap = path.join(DEBUG_DIR, `imd_clasif_snapshot_${Date.now()}.html`);
        try { fs.writeFileSync(snap, html, "utf8"); } catch (e) {}
        log(`⚠️ parseIMDClasificacion: no se encontró table.tt — snapshot guardado: ${snap}`);
      } catch (e) {}
      return [];
    }

    // 4) parsear filas de la tabla encontrada
    const rows = await tableEl.findElements(By.css("tbody > tr"));
    const clasif = [];

    for (const row of rows) {
      try {
        const cols = await row.findElements(By.css("td"));
        if (!cols || cols.length < 2) continue;

        const vals = await Promise.all(cols.map(c => c.getText().then(t => t.trim())));

        // Normalizar primera celda: "1 - NOMBRE" o " 1 - NOMBRE"
        let puesto = "";
        let equipoRaw = vals[0] || "";
        const m = equipoRaw.match(/^\s*([0-9]+)\s*-\s*(.+)$/);
        let equipo = equipoRaw;
        if (m) { puesto = m[1]; equipo = m[2]; }
        else {
          // si la celda ya es solo el nombre (sin número), tratar de extraer nombre
          equipo = equipoRaw.replace(/^\s*-\s*/, "").trim();
        }

        // Mapeo basado en el HTML observado:
        // [0]=Equipo,1=PJ,2=PG,3=PE,4=PP,5=PNP,6=JF,7=JC,8=TF,9=TC,10=Puntos
        const pj = vals[1] || "";
        const pg = vals[2] || "";
        const pe = vals[3] || "";
        const pp = vals[4] || "";
        const pnp = vals[5] || "";
        const jf = vals[6] || "";
        const jc = vals[7] || "";
        const tf = vals[8] || "";
        const tc = vals[9] || "";
        const puntos = vals[10] || "";

        clasif.push({
          puesto,
          equipo,
          pj, pg, pe, pp, pnp, jf, jc, tf, tc, puntos
        });
      } catch (e) {
        // ignore single row parse error
      }
    }

    return clasif;

  } catch (err) {
    try { log(`⚠️ parseIMDClasificacion error general: ${err && err.message ? err.message : err}`); } catch {}
    return [];
  }
}


// --------------------
// MAIN SCRIPT
// --------------------
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
    await driver.sleep(2000);

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
        const rowHtml = await row.getAttribute("outerHTML");
        const match = rowHtml.match(/datosequipo\('([A-F0-9-]+)'\)/i);
        if (match) equipos.push({ id: match[1], nombre, categoria });
      }
    }

    log(`🌸 ${equipos.length} equipos LAS FLORES detectados.`);

    for (const { id, nombre, categoria } of equipos) {
      log(`\n➡️ Procesando ${nombre} (${categoria})...`);
      await driver.executeScript(`datosequipo("${id}")`);

      const selJor = await driver.wait(until.elementLocated(By.id("seljor")), 15000);
      await driver.wait(until.elementIsVisible(selJor), 10000);
      await selJor.sendKeys("Todas");
      await driver.sleep(2000);

      const events = await parseTeamCalendar(driver, nombre);
      writeICS(nombre, categoria, events);
      log(`✅ ${nombre} (${categoria}): ${events.length} partidos.`);
      // --- Obtener clasificación IMD para este equipo ---
try {
  const clasif = await parseIMDClasificacion(driver);

  // construir clave única (coincidente con lo propuesto antes)
  // usamos la forma: IMD_<CATEGORIA>_<NOMBRE>, todo en minúsculas y guiones bajos
  const key = `IMD_${categoria}_${nombre}`.toLowerCase().replace(/[^a-z0-9]+/g, "_");

  const clasifPath = path.join(OUTPUT_DIR, "imd_clasificaciones.json");
  let clasifData = {};
  if (fs.existsSync(clasifPath)) {
    try { clasifData = JSON.parse(fs.readFileSync(clasifPath, "utf8")); } catch (e) { clasifData = {}; }
  }

  clasifData[key] = clasif;
  fs.writeFileSync(clasifPath, JSON.stringify(clasifData, null, 2), "utf8");
  log(`✅ Clasificación IMD guardada: key=${key} (${clasif ? clasif.length : 0} filas)`);
} catch (err) {
  log(`⚠️ Error guardando clasificación IMD para ${nombre}: ${err && err.message ? err.message : err}`);
}

    }

    // 🧩 Generar automáticamente el index.html al final
    log("\n🧱 Generando index.html automáticamente...");
    execSync("node scripts/generate_index_html.js", { stdio: "inherit" });
    log("✅ index.html actualizado correctamente.");

  } catch (err) {
    log(`❌ ERROR GENERAL: ${err}`);
  } finally {
    await driver.quit();
    log("🧹 Chrome cerrado");
  }
})();
