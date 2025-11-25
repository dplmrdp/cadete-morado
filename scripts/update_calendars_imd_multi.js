// scripts/update_calendars_imd_multi.js
// Genera calendarios .ics (IMD) + obtiene clasificaciones provisionales IMD por equipo.
// Basado en tu versión "B", pero reintroduce la lógica de selección de la versión anterior (seljor = "Todas")
// y añade extracción de clasificaciones IMD (Resultados PROVISIONALES).
//
// Requisitos: scripts/team_name_utils.js (normalizeTeamDisplay, normalizeTeamSlug)
// Uso: node scripts/update_calendars_imd_multi.js

const fs = require("fs");
const path = require("path");
const os = require("os");
const { Builder, By, Key, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const { execSync } = require("child_process");

const { normalizeTeamDisplay, normalizeTeamSlug } = require("./team_name_utils");

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
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch (e) {}
}

function safeKeyForClasif(category, teamName) {
  return (`imd_${category}_${teamName}`).toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function safeFilenameForICS(category, teamName) {
  const safe = `${category}_${teamName}`.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return `imd_${safe}.ics`;
}

function pad(n){ return String(n).padStart(2, "0"); }
function fmtICSDateTimeTZID(dt){
  return `${dt.getFullYear()}${pad(dt.getMonth()+1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;
}
function fmtICSDate(d){
  const Y = d.getUTCFullYear();
  const M = String(d.getUTCMonth()+1).padStart(2,"0");
  const D = String(d.getUTCDate()).padStart(2,"0");
  return `${Y}${M}${D}`;
}

function writeICS(teamName, category, events) {
  const filename = safeFilenameForICS(category, teamName);
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
LOCATION:${evt.location || ""}
DTSTART;TZID=${ICS_TZID}:${fmtICSDateTimeTZID(evt.start)}
DESCRIPTION:${evt.description || ""}
END:VEVENT
`;
    } else {
      ics += `BEGIN:VEVENT
SUMMARY:${evt.summary}
LOCATION:${evt.location || ""}
DTSTART;VALUE=DATE:${fmtICSDate(evt.start)}
DTEND;VALUE=DATE:${fmtICSDate(evt.end)}
DESCRIPTION:${evt.description || ""}
END:VEVENT
`;
    }
  }

  ics += "END:VCALENDAR\n";
  fs.writeFileSync(path.join(OUTPUT_DIR, filename), ics, "utf8");
  log(`✅ ${filename} (${events.length} eventos)`);
}

// --------------------
// ICS / parsing helpers (calendar events extraction)
// --------------------
async function parseTeamCalendar(driver, teamName) {
  const TEAM_EXACT = (teamName || "").trim().toUpperCase();
  const allEvents = [];

  // container tab1 contiene tablas por jornada
  const container = await driver.findElement(By.id("tab1"));
  const tables = await container.findElements(By.css("table.tt"));

  log(`📑 ${tables.length} tablas detectadas para ${teamName}`);

  for (const table of tables) {
    // cada tabla representa una jornada (o parte); filas útiles empiezan en tbody > tr
    let rows = [];
    try { rows = await table.findElements(By.css("tbody > tr")); } catch (e) {}
    if (!rows || rows.length <= 1) continue;

    // Algunas tablas tienen encabezados (1 o 2 filas). Recorremos y buscamos filas con al menos 4-8 celdas
    for (let i = 0; i < rows.length; i++) {
      try {
        const cols = await rows[i].findElements(By.css("td"));
        if (!cols || cols.length < 4) continue;

        // Leer hasta 8 columnas (compatibilidad con IMD)
        const vals = await Promise.all(cols.map(c => c.getText().then(t => t.trim())));
        // Mapear columnas según la vista típica: fecha, hora, local, visitante, resultado, lugar, obsEncuentro, obsResultado
        const [fecha = "", hora = "", local = "", visitante = "", resultado = "", lugar = "", obsEncuentro = "", obsResultado = ""] = vals.concat(new Array(8));

        const involves = (local || "").toUpperCase().includes(TEAM_EXACT) || (visitante || "").toUpperCase().includes(TEAM_EXACT);
        if (!involves) continue;

        const matchDate = (fecha || "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
        if (!matchDate) {
          // A veces la fila es un "descanso" u otra línea: aún así podemos tomar si local==team and visitante contains 'Jornada de Descanso'
          if ((local || "").toUpperCase().includes(TEAM_EXACT) && /(descanso|jornada de descanso)/i.test(visitante || "")) {
            // crear all-day placeholder para la fecha si no hay
            // no disponemos de fecha -> omitimos
            continue;
          }
          continue;
        }
        const [_, dd, MM, yyyy] = matchDate;
        const timeMatch = (hora || "").match(/(\d{2}):(\d{2})/);
        const start = new Date(`${yyyy}-${MM}-${dd}T${timeMatch ? timeMatch[0] : "00:00"}:00`);

        const summaryLocal = (local && local.toUpperCase().includes("LAS FLORES")) ? normalizeTeamDisplay(local) : local;
        const summaryVisit = (visitante && visitante.toUpperCase().includes("LAS FLORES")) ? normalizeTeamDisplay(visitante) : visitante;
        const summary = `${summaryLocal} vs ${summaryVisit} (IMD)`;

        const descriptionParts = [];
        if (resultado && resultado !== "-") descriptionParts.push(`Resultado: ${resultado}`);
        if (obsEncuentro && obsEncuentro !== "-") descriptionParts.push(`Obs. Encuentro: ${obsEncuentro}`);
        if (obsResultado && obsResultado !== "-") descriptionParts.push(`Obs. Resultado: ${obsResultado}`);
        const description = descriptionParts.join(" | ");

        allEvents.push({
          type: timeMatch ? "timed" : "allday",
          summary,
          location: lugar || "",
          start,
          end: timeMatch ? null : new Date(start.getTime() + 24 * 3600 * 1000),
          description
        });
      } catch (e) {
        // no bloquear todo por una fila malformada
      }
    }
  }

  // ordenar por fecha/hora
  allEvents.sort((a, b) => {
    if (!a.start || !b.start) return 0;
    return a.start - b.start;
  });

  return allEvents;
}

// --------------------
// Clasificación IMD (Resultados provisionales) parsing
// --------------------
async function parseIMDClasificacion(driver, teamName, category) {
  // Asumimos que estamos en la misma vista #tab1 después de datosequipo(...)
  // Pulsar la pestaña "Consulta de Clasificaciones" (id=tab_opc2)
  try {
    const tabClasif = await driver.findElement(By.id("tab_opc2"));
    await tabClasif.click();
    // dar tiempo a que la pestaña cambie
    await driver.sleep(200);
  } catch (e) {
    // si no es clickeable, intentar via script
    try { await driver.executeScript(`document.getElementById('tab_opc2') && document.getElementById('tab_opc2').click();`); } catch (ee) {}
  }

  // seleccionar resultados provisionales (selprov value="1")
  try {
    const selProv = await driver.findElement(By.id("selprov"));
    try {
      await selProv.sendKeys("1"); // debería seleccionar "Resultados PROVISIONALES"
    } catch (e) {
      // fallback: set value & trigger onchange
      await driver.executeScript("var s=document.getElementById('selprov'); if(s){ s.value='1'; if(typeof s.onchange === 'function') s.onchange(); }");
    }
    await driver.sleep(300); // esperar que se refresque la tabla
  } catch (err) {
    // no existe el select -> no hay clasificaciones en esta vista
    return null;
  }

  // buscar la tabla de clasificaciones (tabla.tt que contiene "Resultados Provisionales" o encabezado similar)
  const clasifTables = await driver.findElements(By.css("#tab1 table.tt"));
  for (const t of clasifTables) {
    try {
      const txt = (await t.getText()).toLowerCase();
      if (txt.includes("resultados provisionales") || txt.includes("resultados provisorios") || txt.includes("clasificacion") || txt.includes("puntos")) {
        // extraer filas útiles (saltar encabezados)
        const rows = await t.findElements(By.css("tbody > tr"));
        const parsed = [];
        // fila 0 suele ser encabezado conteniendo "Resultados Provisionales"
        for (let i = 1; i < rows.length; i++) {
          try {
            const tds = await rows[i].findElements(By.css("td"));
            if (!tds || tds.length < 2) continue;
            // La estructura IMD que mostraste: primera col = "1 - Team Name", última = puntos
            const colsText = await Promise.all(tds.map(td => td.getText().then(t => (t || "").trim())));
            // equipo suele estar en colsText[0], puntos en última columna
            const teamTxt = colsText[0].replace(/^\d+\s*-\s*/, "").trim();
            const puntos = colsText[colsText.length - 1].replace(/\s+/g, " ").trim();
            parsed.push({ team: teamTxt, pts: puntos, rawCols: colsText });
          } catch (e) {}
        }
        // si hemos obtenido filas, devolverlas
        if (parsed && parsed.length) return parsed;
      }
    } catch (e) {}
  }

  // fallback: si no hay tablas detectadas o no contienen texto esperado, intentar obtener *cualquier* table.tt under #tab1 and parse rows with team+points
  try {
    const anyTables = await driver.findElements(By.css("#tab1 table.tt"));
    for (const t of anyTables) {
      try {
        const rows = await t.findElements(By.css("tbody > tr"));
        const parsed = [];
        for (let i = 1; i < rows.length; i++) {
          try {
            const tds = await rows[i].findElements(By.css("td"));
            if (!tds || tds.length < 2) continue;
            const colsText = await Promise.all(tds.map(td => td.getText().then(t => (t || "").trim())));
            const teamTxt = colsText[0].replace(/^\d+\s*-\s*/, "").trim();
            const puntos = colsText[colsText.length - 1].replace(/\s+/g, " ").trim();
            parsed.push({ team: teamTxt, pts: puntos, rawCols: colsText });
          } catch (e) {}
        }
        if (parsed && parsed.length) return parsed;
      } catch (e) {}
    }
  } catch (e) {}

  // si no se ha encontrado nada
  return null;
}

// --------------------
// MAIN
// --------------------
(async () => {
  log("🌼 Iniciando generación de calendarios IMD para equipos LAS FLORES...");

  const tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-imd-"));
  const options = new chrome.Options()
    .addArguments("--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage")
    .addArguments(`--user-data-dir=${tmpUserDir}`)
    .addArguments("--lang=es-ES", "--window-size=1280,1024");

  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();

  try {
    await driver.get(IMD_URL);
    log(`🌐 Página abierta: ${IMD_URL}`);

    const input = await driver.wait(until.elementLocated(By.id("busqueda")), 15000);
    await driver.wait(until.elementIsVisible(input), 5000);

    // buscar "las flores"
    await input.clear();
    await input.sendKeys(SEARCH_TERM, Key.ENTER);
    log(`🔎 Buscando '${SEARCH_TERM}'...`);
    await driver.sleep(800);

    // esperar la tabla de resultados (resultado_equipos o tabla principal)
    await driver.wait(until.elementLocated(By.xpath("//table[contains(@class,'tt')]//td[contains(.,'Nº.Equipos') or contains(.,'Nº.Equipos')]")), 12000)
      .catch(() => {}); // continuar aún si no encuentra ese texto exacto

    // read teams table from #tab1 (la página usa #tab1 para mostrar resultados después de buscar)
    const tab1 = await driver.findElement(By.id("tab1"));
    // Buscar filas en la tabla de equiposs
    let rows = [];
    try {
      const table = await tab1.findElement(By.css("table.tt"));
      rows = await table.findElements(By.css("tbody > tr"));
    } catch (e) {
      // si falla intentar fallback al selector global
      try {
        rows = await driver.findElements(By.css("#resultado_equipos tbody tr"));
      } catch (e2) {
        rows = [];
      }
    }

    log(`📋 ${rows.length} filas encontradas en tabla de equipos.`);

    const equipos = [];
    for (const row of rows) {
      try {
        const cols = await row.findElements(By.css("td"));
        if (!cols || cols.length < 3) continue;
        const nombre = (await cols[0].getText()).trim();
        const categoria = (await cols[2].getText()).trim();

        if ((nombre || "").toLowerCase().includes("las flores")) {
          // extraer id datosequipo si existe en HTML (útil para el método datosequipo)
          const outer = await row.getAttribute("outerHTML");
          const m = outer && outer.match(/datosequipo\('([A-F0-9-]+)'\)/i);
          if (m) {
            equipos.push({ id: m[1], nombre, categoria });
          } else {
            // fallback: guardar sin id
            equipos.push({ id: null, nombre, categoria });
          }
        }
      } catch (e) {}
    }

    log(`🌸 ${equipos.length} equipos LAS FLORES detectados.`);

    // cargar clasificaciones previas si existen
    const clasifPath = path.join(OUTPUT_DIR, "imd_clasificaciones.json");
    let clasifMap = {};
    if (fs.existsSync(clasifPath)) {
      try { clasifMap = JSON.parse(fs.readFileSync(clasifPath, "utf8")); } catch (e) { clasifMap = {}; }
    }

    for (const { id, nombre, categoria } of equipos) {
      const slug = `${categoria}_${nombre}`.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      log(`\n➡️ Procesando ${nombre} (${categoria})...`);

      try {
        if (id) {
          // usar la función JS de la página para cargar el equipo (preferible)
          try {
            await driver.executeScript(`datosequipo("${id}")`);
            log("   ✔ datosequipo ejecutado");
          } catch (e) {
            // fallback: introducir el nombre en el input y hacer búsqueda
            try {
              await input.clear();
              await input.sendKeys(nombre);
              await input.sendKeys(Key.ENTER);
              log("   ✔ fallback búsqueda por nombre ejecutada");
            } catch (ee) {}
          }
        } else {
          // no tenemos id: buscar por nombre
          try {
            await input.clear();
            await input.sendKeys(nombre);
            await input.sendKeys(Key.ENTER);
            log("   ✔ búsqueda por nombre ejecutada");
          } catch (e) {}
        }

        // esperar que la tabla/calendario aparezca en #tab1
        try {
          await driver.wait(until.elementLocated(By.css("#tab1 table.tt, #tab1 .tt")), 9000);
          log("   ✔ Tabla calendario detectada");
        } catch (e) {
          // si no aparece, guardar snapshot y seguir adelante
          try { fs.writeFileSync(path.join(DEBUG_DIR, `imd_error_after_datosequipo_${slug}.html`), await driver.getPageSource(), "utf8"); } catch (ee) {}
          log(`   ❌ Timeout esperando tabla calendario para ${nombre}: ${e && e.message ? e.message : e}`);
          // continuar con siguiente equipo
          continue;
        }

        // guardar snapshot tras datosequipo (útil para debug)
        try { fs.writeFileSync(path.join(DEBUG_DIR, `imd_after_datosequipo_${slug}.html`), await driver.getPageSource(), "utf8"); } catch (e) {}

        // seleccionar "Todas" en seljor para mostrar todas las jornadas
        try {
          const selJor = await driver.findElement(By.id("seljor"));
          try {
            await selJor.sendKeys("Todas");
            log("   ✔ Selector seljor OK (sendKeys)");
          } catch (e) {
            // fallback: set value and trigger change
            await driver.executeScript("var s=document.getElementById('seljor'); if(s){ s.value='Todas'; if(typeof s.onchange==='function') s.onchange(); }");
            log("   ✔ Selector seljor OK (executeScript fallback)");
          }
          await driver.sleep(400); // esperar carga dinámica
        } catch (e) {
          log("   ⚠ seljor no encontrado o no interactivo: " + (e && e.message ? e.message : e));
        }

        // parsear calendario / generar .ics
        const events = await parseTeamCalendar(driver, nombre);
        writeICS(nombre, categoria, events);
        log(`   ✔ ${nombre} (${categoria}): ${events.length} partidos capturados`);

        // -------------------------
        // Obtener clasificación IMD para este equipo
        // -------------------------
        try {
          log("   ➕ Iniciando lectura de clasificación IMD…");
          const clasifRows = await parseIMDClasificacion(driver, nombre, categoria);
          if (clasifRows && clasifRows.length) {
            const key = safeKeyForClasif(categoria, nombre);
            clasifMap[key] = clasifRows;
            fs.writeFileSync(clasifPath, JSON.stringify(clasifMap, null, 2), "utf8");
            log(`   ✔ Clasificación IMD guardada: key=${key} (${clasifRows.length} filas)`);
            // guardar snapshot de la tabla de clasificaciones para inspección
            try { fs.writeFileSync(path.join(DEBUG_DIR, `imd_clasif_${key}.html`), await driver.getPageSource(), "utf8"); } catch (e) {}
          } else {
            log("   ⚠ No se obtuvo clasificación nueva, usando la guardada si existe.");
            // dejar la entrada existente en clasifMap si existía
          }
        } catch (err) {
          log(`   ⚠ Error leyendo/guardando clasificación IMD para ${nombre}: ${err && err.message ? err.message : err}`);
          try { fs.writeFileSync(path.join(DEBUG_DIR, `imd_clasif_error_${slug}.html`), await driver.getPageSource(), "utf8"); } catch (e) {}
        }

      } catch (err) {
        log(`❌ ERROR PROCESANDO ${nombre}: ${err && err.message ? err.message : err}`);
        try { fs.writeFileSync(path.join(DEBUG_DIR, `imd_error_${slug}.html`), await driver.getPageSource(), "utf8"); } catch (e) {}
        continue;
      }
    } // end for equipos

    // -------------------------
    // Generar index.html (como antes)
    // -------------------------
    log("\n🧱 Generando index.html automáticamente...");
    try {
      execSync("node scripts/generate_index_html.js", { stdio: "inherit" });
      log("✅ index.html actualizado correctamente.");
    } catch (e) {
      log("❌ Error generando index.html: " + (e && e.message ? e.message : e));
    }

    log("💚 IMD (calendarios + clasificaciones) COMPLETADO");

  } catch (err) {
    log(`❌ ERROR GENERAL: ${err && err.stack ? err.stack : err}`);
  } finally {
    try { await driver.quit(); } catch (e) {}
    log("🧹 Chrome cerrado");
  }
})();
