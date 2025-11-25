// scripts/update_clasificaciones_imd.js
// Extrae clasificaciones IMD (Resultados PROVISIONALES) por equipo LAS FLORES
// GUARDA: calendarios/imd_clasificaciones.json
//
// Flujo:
//  - abrir IMD
//  - buscar "las flores"
//  - por cada equipo encontrado:
//      - ejecutar datosequipo(id)
//      - pulsar pestaña "Consulta de Clasificaciones" (id=tab_opc2)
//      - seleccionar selprov = "1" (Resultados PROVISIONALES) y ejecutar cambioprov()
//      - esperar tabla .tt de clasificaciones y parsearla
//  - guardar json con clave por equipo: imd_<categoria>_<nombre>

const fs = require("fs");
const path = require("path");
const { Builder, By, Key, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

const IMD_URL = "https://imd.sevilla.org/app/jjddmm_resultados/";
const SEARCH_TERM = "las flores";
const OUTPUT_DIR = path.join("calendarios");
const DEBUG_DIR = path.join(OUTPUT_DIR, "debug");
const LOG_DIR = path.join(OUTPUT_DIR, "logs");
const CLASIF_FILE = path.join(OUTPUT_DIR, "imd_clasificaciones.json");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(DEBUG_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = path.join(LOG_DIR, `imd_clasif_${RUN_STAMP}.log`);

function log(msg) {
  console.log(msg);
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

function safeKey(category, teamName) {
  return `imd_${category}_${teamName}`.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function parseClasifTableHtml(tableHtml) {
  // tableHtml: html string of <table class="tt"> ... we parse with simple regex/DOM-like
  // Implementation: use a lightweight approach: extract rows<tr>..</tr> and then cells <td>
  // Return: array of rows where first column is team display name and last column is points
  const rows = [];
  // remove newlines to simplify regex
  const compact = tableHtml.replace(/\r?\n/g, " ");
  const trRe = /<tr\b[^>]*?>(.*?)<\/tr>/gi;
  let trMatch;
  while ((trMatch = trRe.exec(compact)) !== null) {
    const trHtml = trMatch[1];
    // find all <td ...>...</td>
    const tdRe = /<td\b[^>]*?>(.*?)<\/td>/gi;
    const cells = [];
    let tdMatch;
    while ((tdMatch = tdRe.exec(trHtml)) !== null) {
      // strip tags inside cell, keep innerText approximate
      const inner = tdMatch[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
      cells.push(inner);
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

(async () => {
  log("🌼 Iniciando obtención de clasificaciones IMD (solo clasificaciones)...");

  const options = new chrome.Options()
    .addArguments("--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage")
    .addArguments("--lang=es-ES", "--window-size=1280,1024");

  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();

  try {
    await driver.get(IMD_URL);
    log(`🌐 Página abierta: ${IMD_URL}`);

    // Buscar equipos
    const input = await driver.wait(until.elementLocated(By.id("busqueda")), 15000);
    await driver.wait(until.elementIsVisible(input), 5000);
    await input.clear();
    await input.sendKeys(SEARCH_TERM, Key.ENTER);
    log(`🔎 Buscando '${SEARCH_TERM}'...`);
    await driver.sleep(1200);

    // Esperar lista
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
        const html = await row.getAttribute("outerHTML");
        const match = html.match(/datosequipo\('([A-F0-9-]+)'\)/i);
        if (match && nombre.toUpperCase().includes("LAS FLORES")) {
          equipos.push({ id: match[1], nombre, categoria });
        }
      } catch(e){}
    }

    log(`🌸 ${equipos.length} equipos LAS FLORES detectados.`);

    // Cargar clasificaciones previas si existen (para fallback)
    let clasifData = {};
    if (fs.existsSync(CLASIF_FILE)) {
      try { clasifData = JSON.parse(fs.readFileSync(CLASIF_FILE, "utf8")); } catch(e){ clasifData = {}; }
    }

    for (const { id, nombre, categoria } of equipos) {
      const key = safeKey(categoria, nombre);
      log(`\n➡️ Procesando clasificación para ${nombre} (${categoria})...`);

      try {
        // Abrir datos del equipo
        await driver.executeScript(`datosequipo("${id}")`);
        log("   ✔ datosequipo ejecutado");

        // Pulsar la pestaña "Consulta de Clasificaciones" (id=tab_opc2)
        try {
          const tabClas = await driver.findElement(By.id("tab_opc2"));
          await driver.executeScript("arguments[0].click();", tabClas);
          log("   ✔ Tab 'Consulta de Clasificaciones' pulsado");
        } catch(e) {
          log("   ⚠ No se pudo pulsar tab_opc2: " + (e && e.message ? e.message : e));
        }

        // Esperar select selprov y seleccionar '1' (Resultados PROVISIONALES)
        try {
          await driver.wait(until.elementLocated(By.id("selprov")), 8000);
          await driver.executeScript(`(function(){ const s=document.getElementById('selprov'); if(s){ s.value='1'; if(typeof cambioprov==='function') cambioprov(); }})()`);
          log("   ✔ selprov cambiado a PROVISIONALES");
        } catch (e) {
          log("   ⚠ selprov no encontrado/visible: " + (e && e.message ? e.message : e));
        }

        // Esperar que la tabla de clasificaciones aparezca dentro de #tab1
        let clasifTableHtml = null;
        try {
          // Esperamos que haya una tabla .tt dentro del contenedor (puede tener cabeceras)
          await driver.wait(until.elementLocated(By.css("#tab1 table.tt")), 8000);
          const tableElem = await driver.findElement(By.css("#tab1 table.tt"));
          clasifTableHtml = await tableElem.getAttribute("outerHTML");
          log("      ↪ Tabla de clasificación detectada (capturada HTML).");
        } catch (e) {
          log("      ⚠ No se detectó tabla de clasificación en #tab1: " + (e && e.message ? e.message : e));
        }

        // Guardar snapshot siempre
        const slug = safeKey(categoria, nombre);
        try { fs.writeFileSync(path.join(DEBUG_DIR, `imd_clasif_after_datosequipo_${slug}.html`), await driver.getPageSource(), "utf8"); } catch(e){}

        // Parsear la tabla si existe
        if (clasifTableHtml) {
          const rows = parseClasifTableHtml(clasifTableHtml);
          // Filtrar filas útiles: las que contengan nombre de equipos y puntos (última columna)
          const parsed = [];
          for (const r of rows) {
            // heurística: fila con al menos 2 columnas y la última parece un número (puntos)
            if (r.length >= 2) {
              const last = r[r.length - 1].trim();
              const maybePts = last.replace(/\s+/g, "");
              if (maybePts === "" || isNaN(Number(maybePts))) {
                // no es fila de datos (cabecera)
                continue;
              }
              // team name suele estar en la primera celda
              const teamName = r[0].replace(/^\d+\s*-\s*/,"").trim();
              parsed.push({
                team: teamName,
                pts: maybePts,
                raw: r
              });
            }
          }

          if (parsed.length) {
            clasifData[key] = parsed;
            fs.writeFileSync(CLASIF_FILE, JSON.stringify(clasifData, null, 2), "utf8");
            log(`   ✔ Clasificación IMD guardada: key=${key} (${parsed.length} filas)`);
            continue;
          } else {
            log("   ⚠ Tabla encontrada pero no se extrajeron filas útiles (estructura inesperada).");
          }
        }

        // Si no se obtuvo clasificación nueva, mantener la existente (fallback)
        if (clasifData[key]) {
          log("   ⚠ No se obtuvo clasificación nueva: manteniendo la existente.");
        } else {
          log("   ⚠ No hay clasificación previa para este equipo.");
        }

      } catch (err) {
        log(`❌ ERROR procesando clasificación para ${nombre}: ${err && err.message ? err.message : err}`);
        try { fs.writeFileSync(path.join(DEBUG_DIR, `imd_clasif_error_${safeKey(categoria,nombre)}.html`), await driver.getPageSource(), "utf8"); } catch(e){}
        continue;
      }
    }

    log("\n🧱 Extracción de clasificaciones IMD completada.");

  } catch (err) {
    log("❌ ERROR GENERAL (clasificaciones IMD): " + (err && err.stack ? err.stack : err));
  } finally {
    try { await driver.quit(); } catch(e){}
    log("🧹 Chrome cerrado");
  }

})();
