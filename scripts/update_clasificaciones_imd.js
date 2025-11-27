// scripts/update_clasificaciones_imd.js
// Extrae clasificaciones IMD (Resultados PROVISIONALES) por equipo y guarda imd_clasificaciones.json

const fs = require("fs");
const path = require("path");
const os = require("os");
const { Builder, By, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

const OUTPUT_DIR = "calendarios";
const DEBUG_DIR = path.join(OUTPUT_DIR, "debug");
const LOG_DIR = path.join(OUTPUT_DIR, "logs");

fs.mkdirSync(DEBUG_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const RUNSTAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = path.join(LOG_DIR, `imd_clasif_${RUNSTAMP}.log`);

function log(msg) {
  console.log(msg);
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);} catch {}
}

function makeKey(cat, team) {
  return `imd_${cat}_${team}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function selectTabClasificaciones(driver) {
  const tab = await driver.findElement(By.id("tab_opc2"));
  await tab.click();
  await driver.sleep(300);
}

async function selectProvisionales(driver) {
  const sel = await driver.wait(until.elementLocated(By.id("selprov")), 10000);

  await driver.executeScript(`
    const s = arguments[0];
    s.value = "1"; // PROVISIONALES
    s.dispatchEvent(new Event('change', { bubbles: true }));
  `, sel);

  await driver.sleep(1200); // tiempo para el fetch
}


async function parseClasificacion(driver, debugName) {
  try {
    // =====================
    // 1. Esperar a la tabla
    // =====================
    const table = await driver.wait(
      until.elementLocated(
        By.xpath("//table[contains(., 'Equipo') and contains(., 'Puntos')]")
      ),
      12000
    );

    // Esperar a que aparezcan filas con nombres reales (no "Equipo")
    await driver.wait(
      until.elementLocated(
        By.xpath("//table[contains(., 'Puntos')]//tbody/tr/td[1][string-length(normalize-space()) > 1]")
      ),
      12000
    );

    const rows = await table.findElements(By.css("tbody > tr"));
    const result = [];
    const debugRows = [];

    log(`DEBUG ${debugName} -> detectadas ${rows.length} filas en <tbody>`);

    // ==========================================================
    // 2. Procesar cada fila del tbody
    // ==========================================================
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const cols = await row.findElements(By.css("td"));

      // Filtrar filas no válidas
      if (cols.length < 11) {
        log(`DEBUG ${debugName} row ${i}: ignorada por tener ${cols.length} columnas`);
        continue;
      }

      // Leer texto vía textContent y vía getText()
      const vals_textContent = await Promise.all(
        cols.map(c => c.getAttribute("textContent"))
      );
      const vals_getText = await Promise.all(cols.map(c => c.getText()));

      // Registrar debug estructurado
      const clean_textContent = vals_textContent.map(v => v ? v.trim() : "");
      const clean_getText = vals_getText.map(v => v ? v.trim() : "");

      debugRows.push({
        row_index: i,
        textContent: clean_textContent,
        getText: clean_getText
      });

      // Nombre original
      const rawName = clean_textContent[0] || clean_getText[0] || "";

      // =======================================
      // 3. Filtrar fila fantasma "Equipo"
      // =======================================
      if (rawName.toLowerCase() === "equipo") {
        log(`SKIP ${debugName} row ${i}: fila de cabecera interna 'Equipo'`);
        continue;
      }

      // Si nombre está vacío, descartar
      if (!rawName) {
        log(`SKIP ${debugName} row ${i}: nombre vacío`);
        continue;
      }

      // Limpiar nombre → quitar "1 - " o "3 - " delante
      const teamName = rawName.replace(/^\d+\s*-\s*/, "").trim();

      // =======================================
      // 4. Parsear números (robusto)
      // =======================================
      const getNum = (idx) =>
        parseInt(clean_textContent[idx]) ||
        parseInt(clean_getText[idx]) ||
        0;

      result.push({
        team: teamName,
        pts: getNum(10),
        pj: getNum(1),
        pg: getNum(2),
        pp: getNum(4),
        sg: getNum(6),   // sets ganados
        sp: getNum(7)    // sets perdidos
      });
    }

    // ===============================
    // 5. Guardar archivo de debug
    // ===============================
    try {
      const dump = {
        debugName,
        rows_count: rows.length,
        result_count: result.length,
        rows: debugRows,
        pageSourceSnippet: (await driver.getPageSource()).slice(0, 20000)
      };

      const filePath = path.join(
        DEBUG_DIR,
        `imd_clasif_debug_${debugName}.json`
      );

      fs.writeFileSync(filePath, JSON.stringify(dump, null, 2), "utf8");
      log(`DEBUG file written: ${filePath}`);
    } catch (e) {
      log(`ERROR writing debug file for ${debugName}: ${e}`);
    }

    // ===============================
    // 6. Devolver resultados reales
    // ===============================
    return result;
  } catch (err) {
    // Guardar HTML completo en caso de fallo
    try {
      const page = await driver.getPageSource();
      const filePath = path.join(
        DEBUG_DIR,
        `imd_clasif_error_${debugName}.html`
      );
      fs.writeFileSync(filePath, page, "utf8");
      log(`WROTE error HTML: ${filePath}`);
    } catch (e2) {
      log(`ERROR saving error HTML: ${e2}`);
    }

    log(`parseClasificacion exception for ${debugName}: ${err}`);
    return [];
  }
}


(async () => {
  log("🌼 Iniciando obtención de clasificaciones IMD…");

  const options = new chrome.Options()
    .addArguments("--headless=new")
    .addArguments("--no-sandbox")
    .addArguments("--disable-gpu")
    .addArguments("--disable-dev-shm-usage")
    .addArguments("--lang=es-ES");

  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();

  try {
    await driver.get("https://imd.sevilla.org/app/jjddmm_resultados/");
    log("🌐 Página abierta");

    // Buscar LAS FLORES
    const input = await driver.findElement(By.id("busqueda"));
    await input.clear();
    await input.sendKeys("las flores");
    await driver.findElement(By.css("button")).click();

    // Tabla de equipos → exactamente igual que en calendarios
    const tableEquipos = await driver.wait(
      until.elementLocated(By.css("#tab1 table.tt")),
      15000
    );

    const rowElements = await tableEquipos.findElements(By.css("tbody > tr"));

    const equipos = [];
    for (const row of rowElements) {
      const html = await row.getAttribute("outerHTML");
      const match = html.match(/datosequipo\('([A-F0-9-]+)'\)/i);
      if (!match) continue;

      const tds = await row.findElements(By.css("td"));
      if (tds.length < 3) continue;

      const name = (await tds[0].getText()).trim().toUpperCase();
      const category = (await tds[2].getText()).trim().toUpperCase();

      if (!name.includes("LAS FLORES")) continue;

      equipos.push({ id: match[1], name, category });
    }

    log(`🌸 Equipos detectados: ${equipos.length}`);

    const allClasif = {};

    // Procesar equipo por equipo
    for (const eq of equipos) {
      const { id, name, category } = eq;
      const key = makeKey(category, name);

      log(`\n➡️ Clasificación para ${name} (${category})`);

      // Ejecutar datosequipo(id)
      await driver.executeScript(`datosequipo("${id}")`);
      await driver.sleep(800);

      // Pasar a pestaña "Consulta de Clasificaciones"
      await selectTabClasificaciones(driver);

      // Seleccionar PROVISIONALES
      await selectProvisionales(driver);

      // Extraer tabla
      const rows = await parseClasificacion(driver, key);

      allClasif[key] = rows;

      log(`   ✔ Filas capturadas: ${rows.length}`);
    }

    // Guardar json
    const outPath = path.join(OUTPUT_DIR, "imd_clasificaciones.json");
    fs.writeFileSync(outPath, JSON.stringify(allClasif, null, 2), "utf8");

    log(`💾 Guardado: ${outPath}`);

  } catch (err) {
    log(`❌ ERROR GENERAL: ${err}`);
  } finally {
    try { await driver.quit(); } catch {}
    log("🧹 Chrome cerrado");
  }
})();
