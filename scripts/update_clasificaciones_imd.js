// scripts/update_clasificaciones_imd.js
// Extrae las CLASIFICACIONES IMD completas para cada equipo LAS FLORES.
// Flujo:
//   - Buscar "las flores"
//   - Por cada equipo:
//        datosequipo(id)
//        pestaña "Consulta de Clasificaciones"
//        selprov="1" (PROVISIONALES)
//        parsear tabla IMD completa
//        guardar en imd_clasificaciones.json
//
// Columnas extraídas:
//   puntos, PJ, PG, PP, JF, JC
//
// Estructura de salida: {
//   imd_<categoria>_<equipo>: [
//      { equipo, pj, pg, pp, jf, jc, puntos }, ...
//   ]
// }

const fs = require("fs");
const path = require("path");
const { Builder, By, Key, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

const IMD_URL = "https://imd.sevilla.org/app/jjddmm_resultados/";
const SEARCH_TERM = "las flores";

const OUTPUT_DIR = path.join("calendarios");
const DEBUG_DIR = path.join(OUTPUT_DIR, "debug");
const LOG_DIR = path.join(OUTPUT_DIR, "logs");
const OUT_JSON = path.join(OUTPUT_DIR, "imd_clasificaciones.json");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(DEBUG_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = path.join(LOG_DIR, `imd_clasif_${RUN_STAMP}.log`);

function log(msg) {
  console.log(msg);
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

// Normaliza keys para JSON
function safeKey(categoria, nombre) {
  return `imd_${categoria.toLowerCase().replace(/[^a-z0-9]+/g,"_")}_${nombre.toLowerCase().replace(/[^a-z0-9]+/g,"_")}`;
}

// ---------------
// PARSER CLASIFICACIÓN IMD (tabla fija de voleibol)
// ---------------
async function parseClasificacionTablaIMD(clasTable) {
  const rows = await clasTable.findElements(By.css("tbody > tr"));
  const out = [];

  for (const r of rows) {
    const tds = await r.findElements(By.css("td"));
    if (tds.length < 11) continue;

    const cols = [];
    for (const td of tds) cols.push((await td.getText()).trim());

    // Saltar encabezado
    if (cols[0].toLowerCase().includes("equipo")) continue;
    if (cols[0].toLowerCase().includes("resultados provisionales")) continue;

    out.push({
      equipo: cols[0].replace(/^\d+\s*-\s*/, "").trim(),
      pj: parseInt(cols[1]) || 0,
      pg: parseInt(cols[2]) || 0,
      pp: parseInt(cols[4]) || 0,
      jf: parseInt(cols[6]) || 0,
      jc: parseInt(cols[7]) || 0,
      puntos: parseInt(cols[10]) || 0
    });
  }

  return out;
}

// -------------------------------------------------------------
// MAIN
// -------------------------------------------------------------
(async () => {
  log("🌼 Iniciando extracción de CLASIFICACIONES IMD...");

  const options = new chrome.Options()
    .addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage")
    .addArguments("--lang=es-ES", "--window-size=1280,1024");

  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();
  const clasifMap = {};

  try {
    await driver.get(IMD_URL);
    log(`🌐 Página IMD abierta: ${IMD_URL}`);

    // Buscar "las flores"
    const input = await driver.wait(until.elementLocated(By.id("busqueda")), 15000);
    await driver.wait(until.elementIsVisible(input), 5000);
    await input.clear();
    await input.sendKeys(SEARCH_TERM, Key.ENTER);
    log(`🔎 Buscando '${SEARCH_TERM}'...`);
    await driver.sleep(1200);

    // Localizar tabla de equipos
    await driver.wait(
      until.elementLocated(By.xpath("//table[contains(@class,'tt')]//td[contains(.,'Nº.Equipos')]")),
      10000
    );

    const tab1 = await driver.findElement(By.id("tab1"));
    const table = await tab1.findElement(By.css("table.tt"));
    const rows = await table.findElements(By.css("tbody > tr"));
    log(`📋 ${rows.length} filas analizadas`);

    // Extraer lista de equipos LAS FLORES
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

    // ------------------------------------------------------
    // PROCESAR CADA EQUIPO
    // ------------------------------------------------------
    for (const { id, nombre, categoria } of equipos) {
      const key = safeKey(categoria, nombre);
      log(`\n➡️ Procesando ${nombre} (${categoria}) - clave: ${key}`);

      try {
        // Abrir ficha del equipo
        await driver.executeScript(`datosequipo("${id}")`);
        await driver.sleep(500);
        log("✔ datosequipo ejecutado");

        // Pestaña Clasificaciones
        await driver.findElement(By.id("tab_opc2")).click();
        await driver.sleep(300);
        log("✔ Pestaña 'Consulta de Clasificaciones' abierta");

        // Cambiar a PROVISIONALES (value=1)
        try {
          const selprov = await driver.findElement(By.id("selprov"));
          await driver.executeScript(`
            arguments[0].value = '1';
            arguments[0].dispatchEvent(new Event('change', { bubbles: true }));
          `, selprov);
          await driver.sleep(600);
          log("✔ PROVISIONALES seleccionado");
        } catch(e) {
          log("⚠ No encontré selprov");
        }

        // Esperar tabla clasificación
        await driver.wait(until.elementLocated(By.css("#tab1 table.tt")), 8000);
        const clasTable = await driver.findElement(By.css("#tab1 table.tt"));
        log("✔ Tabla de clasificación cargada");

        // Parsear tabla
        const clasif = await parseClasificacionTablaIMD(clasTable);
        log(`✔ ${clasif.length} equipos extraídos`);

        clasifMap[key] = clasif;

      } catch (err) {
        log(`❌ Error procesando ${nombre}: ${err.message}`);
        try {
          const snap = await driver.getPageSource();
          fs.writeFileSync(path.join(DEBUG_DIR, `imd_clasif_error_${key}.html`), snap, "utf8");
        } catch {}
        continue;
      }
    }

    // -----------------------------------------------
    // GUARDAR JSON FINAL
    // -----------------------------------------------
    let existing = {};
    if (fs.existsSync(OUT_JSON)) {
      try { existing = JSON.parse(fs.readFileSync(OUT_JSON,"utf8")); } catch {}
    }

    const merged = { ...existing, ...clasifMap };
    fs.writeFileSync(OUT_JSON, JSON.stringify(merged, null, 2), "utf8");

    log(`\n✅ Clasificaciones IMD guardadas en ${OUT_JSON}`);
    log(`   (${Object.keys(clasifMap).length} equipos nuevos)`);

  } catch (err) {
    log("❌ ERROR GENERAL: " + err.stack);
  } finally {
    try { await driver.quit(); } catch {}
    log("🧹 Chrome cerrado");
  }
})();
