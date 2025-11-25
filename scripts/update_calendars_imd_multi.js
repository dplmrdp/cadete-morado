// scripts/update_calendars_imd_multi.js
// Genera .ics para cada equipo LAS FLORES / EVB LAS FLORES desde la web IMD
// Solo calendarios: NO toca clasificaciones.
//
// Flujo:
//  - abrir IMD
//  - buscar "las flores"
//  - por cada equipo encontrado:
//      - ejecutar datosequipo(id)
//      - esperar selector seljor y elegir "Todas"
//      - esperar que aparezcan las tablas en #tab1
//      - parsear todas las tablas (una por jornada) y generar .ics
//
// Dependencias: selenium-webdriver, chrome-driver en entorno.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { Builder, By, Key, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

const IMD_URL = "https://imd.sevilla.org/app/jjddmm_resultados/";
const SEARCH_TERM = "las flores";
const OUTPUT_DIR = path.join("calendarios");
const DEBUG_DIR = path.join(OUTPUT_DIR, "debug");
const LOG_DIR = path.join(OUTPUT_DIR, "logs");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(DEBUG_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = path.join(LOG_DIR, `imd_calendars_${RUN_STAMP}.log`);
const ICS_TZID = "Europe/Madrid";

function log(msg) {
  console.log(msg);
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

function safeFileName(category, teamName) {
  return `${category}_${teamName}`.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function pad(n){ return String(n).padStart(2,"0"); }
function fmtICSDateTimeTZID(dt){
  return `${dt.getFullYear()}${pad(dt.getMonth()+1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;
}
function fmtICSDate(d){
  const Y = d.getUTCFullYear(); const M = String(d.getUTCMonth()+1).padStart(2,"0"); const D = String(d.getUTCDate()).padStart(2,"0");
  return `${Y}${M}${D}`;
}

function writeICS(teamName, category, events){
  const safeName = safeFileName(category, teamName);
  const filename = `imd_${safeName}.ics`;
  let ics = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:PUBLISH
PRODID:-//Las Flores//Calendarios IMD//ES
`;
  for(const evt of events){
    if(evt.type === "timed"){
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

async function parseTeamCalendar(driver, teamName) {
  const TEAM_EXACT = teamName.trim().toUpperCase();
  const allEvents = [];

  // #tab1 contiene las tablas de jornadas cuando seljor = "Todas"
  const container = await driver.findElement(By.id("tab1"));
  const tables = await container.findElements(By.css("table.tt"));
  log(`📑 ${tables.length} tablas detectadas para ${teamName}`);

  for (const table of tables) {
    let rows = [];
    try { rows = await table.findElements(By.css("tbody > tr")); } catch (e) { rows = []; }
    if (rows.length <= 1) continue;

    // En las tablas IMD las dos primeras filas suelen ser cabeceras; el código anterior saltaba 2
    // pero algunas tablas solo tienen la cabecera en la primera fila; intentamos procesar robustamente.
    for (let i = 0; i < rows.length; i++) {
      try {
        const cols = await rows[i].findElements(By.css("td"));
        if (cols.length < 4) continue;

        const vals = await Promise.all(cols.map(c => c.getText().then(t => t.trim())));
        // Campos esperados: fecha, hora, local, visitante, resultado?, lugar?, obsEncuentro?, obsResultado?
        const [fecha, hora, local, visitante, resultado, lugar, obsEncuentro, obsResultado] = vals.concat(new Array(8).fill(""));

        const involves = (local && local.toUpperCase().includes(TEAM_EXACT)) || (visitante && visitante.toUpperCase().includes(TEAM_EXACT));
        if (!involves) continue;

        const match = (fecha || "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
        if (!match) continue;
        const [_, dd, MM, yyyy] = match;
        const time = (hora || "").match(/(\d{2}):(\d{2})/);

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
          description
        });
      } catch(e){}
    }
  }

  // Orden razonable: allday primero (por fecha) luego timed por fecha y hora
  allEvents.sort((a,b) => {
    if (a.allDay && !b.allDay) return -1;
    if (b.allDay && !a.allDay) return 1;
    return a.start - b.start;
  });

  return allEvents;
}

(async () => {
  log("🌼 Iniciando generación de calendarios IMD (solo ICS)...");
  const options = new chrome.Options()
    .addArguments("--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage")
    .addArguments("--lang=es-ES", "--window-size=1280,1024");

  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();

  try {
    await driver.get(IMD_URL);
    log(`🌐 Página abierta: ${IMD_URL}`);

    // Buscar
    const input = await driver.wait(until.elementLocated(By.id("busqueda")), 15000);
    await driver.wait(until.elementIsVisible(input), 5000);
    await input.clear();
    await input.sendKeys(SEARCH_TERM, Key.ENTER);
    log(`🔎 Buscando '${SEARCH_TERM}'...`);
    await driver.sleep(1200);

    // Esperar resultado de equipos
    await driver.wait(until.elementLocated(By.xpath("//table[contains(@class,'tt')]//td[contains(.,'Nº.Equipos') or contains(.,'Nº.Equipos')]")), 10000);
    const tab1 = await driver.findElement(By.id("tab1"));
    const table = await tab1.findElement(By.css("table.tt"));
    const rows = await table.findElements(By.css("tbody > tr"));
    log(`📋 ${rows.length} filas encontradas en tabla de equipos.`);

    const equipos = [];
    for (const row of rows) {
      try {
        const cols = await row.findElements(By.css("td"));
        if (cols.length < 3) continue;
        const nombre = (await cols[0].getText()).trim();
        const categoria = (await cols[2].getText()).trim();
        const rowHtml = await row.getAttribute("outerHTML");
        const match = rowHtml.match(/datosequipo\('([A-F0-9-]+)'\)/i);
        if (match && nombre.toUpperCase().includes("LAS FLORES")) {
          equipos.push({ id: match[1], nombre, categoria });
        }
      } catch(e){}
    }

    log(`🌸 ${equipos.length} equipos LAS FLORES detectados.`);

    for (const { id, nombre, categoria } of equipos) {
      const slug = safeFileName(categoria, nombre);
      log(`\n➡️ Procesando ${nombre} (${categoria})...`);

      try {
        await driver.executeScript(`datosequipo("${id}")`);
        log("   ✔ datosequipo ejecutado");

        // Esperar el select seljor y seleccionar "Todas"
        try {
          const selJor = await driver.wait(until.elementLocated(By.id("seljor")), 10000);
          await driver.wait(until.elementIsVisible(selJor), 5000);
          // seleccionar "Todas" utilizando script (más fiable)
          await driver.executeScript(`(function(){ const s=document.getElementById('seljor'); if(s){ s.value='Todas'; if(typeof cambiojor==='function') cambiojor(); }})()`); 
          log("   ✔ Selector seljor OK (Todas seleccionada)");
        } catch (e) {
          log("   ⚠ selector seljor no encontrado/visible: " + (e && e.message ? e.message : e));
          // continuar: puede que la tabla aparezca por defecto
        }

        // Esperar que las tablas de jornadas aparezcan en #tab1
        try {
          await driver.wait(until.elementLocated(By.css("#tab1 table.tt, #tab1 .tt")), 9000);
          log("   ✔ Calendario / tabla detectada en #tab1");
        } catch (e) {
          log(`   ❌ Timeout esperando calendario para ${nombre}: ${e && e.message}`);
          try { fs.writeFileSync(path.join(DEBUG_DIR, `imd_error_after_datosequipo_${slug}.html`), await driver.getPageSource(), "utf8"); } catch {}
          continue;
        }

        // Guardar snapshot por diagnóstico
        try { fs.writeFileSync(path.join(DEBUG_DIR, `imd_after_datosequipo_${slug}.html`), await driver.getPageSource(), "utf8"); } catch(e){}

        const events = await parseTeamCalendar(driver, nombre);
        writeICS(nombre, categoria, events);
        log(`   ✔ ${nombre} (${categoria}): ${events.length} partidos capturados`);
      } catch (e) {
        log(`❌ ERROR procesando ${nombre}: ${e && e.message ? e.message : e}`);
        try { fs.writeFileSync(path.join(DEBUG_DIR, `imd_error_${safeFileName(categoria,nombre)}.html`), await driver.getPageSource(), "utf8"); } catch(e){}
        continue;
      }
    }

    log("\n🧱 Generación de calendarios IMD finalizada correctamente.");

  } catch (err) {
    log("❌ ERROR GENERAL: " + (err && err.stack ? err.stack : err));
  } finally {
    try { await driver.quit(); } catch(e){}
    log("🧹 Chrome cerrado");
  }
})();
