// scripts/update_clasificaciones_imd.js
// Genera/actualiza calendarios/imd_clasificaciones.json
// - Navega a IMD, busca "las flores"
// - Para cada equipo "LAS FLORES" ejecuta datosequipo(id)
// - Abre la pestaña "Consulta de Clasificaciones" (buscando el enlace por texto)
// - Selecciona "Resultados PROVISIONALES" (selprov = 1) forzando cambioprov()
// - Parsea la tabla (si aparece) y guarda resultados por clave slug
//
// Guardados:
// - calendarios/imd_clasificaciones.json  (clave = slug: imd_<categoria>_<equipo>)
// - snapshots en calendarios/debug/ para depuración
//
// Nota: diseñado para ser tolerante a fallos (mantiene clasificaciones previas).

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
const LOG_FILE = path.join(LOG_DIR, `imd_clasif_${RUN_STAMP}.log`);
const OUT_JSON = path.join(OUTPUT_DIR, "imd_clasificaciones.json");

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(msg);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (e) {}
}

function safeSlug(category, teamName) {
  return `imd_${(category || "sin_categoria")}_${teamName}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function clickTabByText(driver, textRegex, timeout = 3000) {
  // Try to locate an <a> whose textContent matches textRegex (case-insensitive)
  // Uses executeScript to be robust with nonstandard markup.
  const script = `
    const re = new RegExp(${textRegex}, "i");
    const arr = Array.from(document.querySelectorAll("a, button, li"));
    const found = arr.find(el => (el.textContent || "").trim().match(re));
    if(found) {
      // try to click via el.click(), fallback to dispatch Event
      try { found.click(); return true; } catch(e) {
        try {
          const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
          found.dispatchEvent(ev);
          return true;
        } catch(e2) { return false; }
      }
    }
    return false;
  `;
  try {
    const r = await driver.executeScript(script);
    return !!r;
  } catch (e) {
    return false;
  }
}

async function forceProvisionales(driver) {
  // Set select#selprov to '1' and call cambioprov() if present
  // Trigger change events too.
  const script = `
    try {
      const sel = document.getElementById('selprov') || document.querySelector('select[name="selprov"], select#selprov');
      if(sel) {
        sel.value = '1';
        // trigger change events
        const evt = new Event('change', { bubbles: true });
        sel.dispatchEvent(evt);
      }
      try { if (typeof cambioprov === 'function') cambioprov(); } catch(e) {}
      return true;
    } catch (e) { return false; }
  `;
  try {
    await driver.executeScript(script);
  } catch (e) {}
  // small wait for table refresh
  await driver.sleep(400);
}

async function parseClasifTableFromPage(driver) {
  // Try to find #tab1 table.tt tbody tr rows. Return array of parsed rows or null if not found.
  try {
    const tableEl = await driver.findElement(By.css("#tab1 table.tt"));
    const rows = await tableEl.findElements(By.css("tbody > tr"));
    if (!rows || rows.length === 0) return [];
    const out = [];

    for (const r of rows) {
      try {
        const tds = await r.findElements(By.css("td"));
        // Only parse rows that look like data rows (>= 10 cells or at least team + points)
        if (tds.length < 2) continue;
        const texts = [];
        for (const td of tds) {
          const txt = (await td.getText()).trim();
          texts.push(txt);
        }
        // Remove leading header/trailer rows where first cell contains header text
        const first = (texts[0] || "").toLowerCase();
        if (first.includes("equipo") || first.includes("resultados") || first.match(/^\d*\s*-\s*\w+/) === null && texts.length < 5) {
          // Could still be a data row like "1 - CD LAS FLORES..."
          // We'll accept rows where texts[0] starts with a digit + ' - ' or contains 'las flores' etc.
        }
        // Normalize: team name often in column 0 possibly prefixed with "1 - "
        let teamRaw = texts[0] || "";
        teamRaw = teamRaw.replace(/^\s*\d+\s*-\s*/,"").trim();

        // Puntos often final column
        const pts = texts.length >= 11 ? texts[10] : texts[ texts.length - 1 ];
        out.push({
          team: teamRaw,
          pj: texts[1] || "",
          pg: texts[2] || "",
          pe: texts[3] || "",
          pp: texts[4] || "",
          pnp: texts[5] || "",
          jf: texts[6] || "",
          jc: texts[7] || "",
          tf: texts[8] || "",
          tc: texts[9] || "",
          pts: pts || ""
        });
      } catch (e) {
        // ignore row parse errors
      }
    }
    return out;
  } catch (e) {
    return null;
  }
}

(async function main() {
  log("🌼 Iniciando obtención de CLASIFICACIONES IMD (PROVISIONALES)...");

  // Load existing data if present (so we can preserve when a fetch fails)
  let existing = {};
  try {
    if (fs.existsSync(OUT_JSON)) {
      existing = JSON.parse(fs.readFileSync(OUT_JSON, "utf8"));
      log(`ℹ️ Clasificaciones previas cargadas: ${Object.keys(existing).length} claves`);
    } else {
      log("ℹ️ No hay clasificaciones previas (archivo no encontrado).");
    }
  } catch (e) {
    log("⚠️ Error cargando clasificaciones previas: " + (e && e.message ? e.message : e));
    existing = {};
  }

  const tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-imd-clasif-"));
  const options = new chrome.Options()
    .addArguments("--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${tmpUserDir}`)
    .addArguments("--lang=es-ES", "--window-size=1280,1024")
    .addArguments("--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36");

  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();

  try {
    await driver.get(IMD_URL);
    log(`🌐 Página abierta: ${IMD_URL}`);

    // Wait input, type search
    const input = await driver.wait(until.elementLocated(By.id("busqueda")), 15000);
    await driver.wait(until.elementIsVisible(input), 5000);
    await input.clear();
    await input.sendKeys(SEARCH_TERM, Key.ENTER);
    log(`🔎 Buscando '${SEARCH_TERM}'...`);
    await driver.sleep(1200);

    // wait for the teams table to appear (be tolerant)
    try {
      await driver.wait(until.elementLocated(By.css("#tab1 table.tt, #tab1 .tt")), 15000);
    } catch (e) {
      log("⚠️ No se detectó tabla principal de equipos en #tab1: " + (e && e.message ? e.message : e));
    }

    // Now collect team rows (table under #tab1)
    let rows = [];
    try {
      const tab1 = await driver.findElement(By.id("tab1"));
      const table = await tab1.findElement(By.css("table.tt"));
      rows = await table.findElements(By.css("tbody > tr"));
      log(`📋 ${rows.length} filas encontradas en tabla de equipos.`);
    } catch (e) {
      log("⚠️ No se pudo leer la tabla de equipos: " + (e && e.message ? e.message : e));
    }

    // Build list of teams (id via datosequipo('ID'))
    const equipos = [];
    for (const r of rows) {
      try {
        const cols = await r.findElements(By.css("td"));
        if (cols.length < 1) continue;
        const nombre = (await cols[0].getText()).trim().toUpperCase();
        const categoria = (cols.length >= 3) ? (await cols[2].getText()).trim().toUpperCase() : "SIN_CATEGORIA";
        if (nombre.includes("LAS FLORES")) {
          const outer = await r.getAttribute("outerHTML");
          const m = outer.match(/datosequipo\('([A-F0-9-]+)'\)/i);
          if (m) equipos.push({ id: m[1], nombre, categoria });
          else {
            // in case datosequipo isn't present in HTML, it's safer to skip
            log(`   ⚠ fila equipo sin datosequipo detectada: ${nombre}`);
          }
        }
      } catch (e) {
        // ignore row errors
      }
    }

    log(`🌸 ${equipos.length} equipos LAS FLORES detectados.`);

    // Process each team
    for (const { id, nombre, categoria } of equipos) {
      const slug = safeSlug(categoria, nombre);
      log(`\n➡️ Procesando CLASIFICACIÓN para: ${nombre} (${categoria}) -> key=${slug}`);

      try {
        // execute datosequipo to load team data (this may change active tab)
        await driver.executeScript(`try { datosequipo("${id}"); } catch(e) { /* ignore */ }`);
        log("   ✔ datosequipo ejecutado");

        // short wait for DOM to update
        await driver.sleep(300);

        // Save snapshot after datosequipo for debugging
        try {
          const snapPath = path.join(DEBUG_DIR, `imd_after_datosequipo_${slug}.html`);
          fs.writeFileSync(snapPath, await driver.getPageSource(), "utf8");
          log(`   ✔ Snapshot guardado: ${path.basename(snapPath)}`);
        } catch (e) {
          log("   ⚠ No se pudo guardar snapshot tras datosequipo: " + (e && e.message ? e.message : e));
        }

        // Try to click the "Consulta de Clasificaciones" tab by searching for its link/button text.
        // We'll be permissive: match 'Clasific' (covers 'Clasificaciones', 'Clasificación'...).
        const clicked = await clickTabByText(driver, "/Clasific/i");
        if (clicked) {
          log("   ✔ Intento de abrir pestaña 'Clasificaciones' (click por texto)");
          await driver.sleep(400);
        } else {
          log("   ⚠ No se encontró un enlace de 'Clasificaciones' por texto (se intentará continuar)");
        }

        // Force "PROVISIONALES"
        await forceProvisionales(driver);
        log("   ✔ selprov cambiado a PROVISIONALES (si existía)");

        // Wait for the classification table to appear (if any)
        let clasif = null;
        try {
          await driver.wait(until.elementLocated(By.css("#tab1 table.tt tbody tr")), 5000);
          clasif = await parseClasifTableFromPage(driver);
        } catch (e) {
          // timeout: try one quick parse anyway
          log("   ⚠ Timeout esperando filas de clasificación; intento parse rápido.");
          clasif = await parseClasifTableFromPage(driver);
        }

        // If no rows found, try toggling provisional/definitive then provisional again (some pages render only after a toggle).
        if ((!clasif || clasif.length === 0)) {
          try {
            // try switching to definitive (2) then back to 1
            await driver.executeScript(`
              try {
                const sel = document.getElementById('selprov') || document.querySelector('select[name="selprov"]');
                if(sel) { sel.value = '2'; sel.dispatchEvent(new Event('change',{bubbles:true})); }
                try{ if(typeof cambioprov === 'function') cambioprov(); } catch(e){}
              } catch(e){}
            `);
            await driver.sleep(300);
            await forceProvisionales(driver);
            await driver.sleep(300);
            clasif = await parseClasifTableFromPage(driver);
          } catch (e) { /* ignore */ }
        }

        if (clasif && clasif.length) {
          // Save in-memory and write JSON
          existing[slug] = clasif;
          fs.writeFileSync(OUT_JSON, JSON.stringify(existing, null, 2), "utf8");
          log(`   ✔ Clasificación IMD guardada: key=${slug} (${clasif.length} filas)`);

          // snapshot
          try {
            fs.writeFileSync(path.join(DEBUG_DIR, `imd_after_clasif_${slug}.html`), await driver.getPageSource(), "utf8");
          } catch (e) {}
        } else {
          log("   ⚠ No se obtuvo clasificación nueva (tabla vacía o ausente). Manteniendo la previa si existía.");
          // Save snapshot for debugging
          try { fs.writeFileSync(path.join(DEBUG_DIR, `imd_after_clasif_empty_${slug}.html`), await driver.getPageSource(), "utf8"); } catch (e) {}
        }

      } catch (err) {
        log(`❌ ERROR procesando clasificación ${nombre}: ${err && err.message ? err.message : err}`);
        try { fs.writeFileSync(path.join(DEBUG_DIR, `imd_error_clasif_${slug}.html`), await driver.getPageSource(), "utf8"); } catch (e) {}
        // continue with next team
      }
    }

    log("\n✅ Proceso de clasificaciones IMD completado.");
    log(`📦 Archivo final: ${OUT_JSON} (claves: ${Object.keys(existing).length})`);

  } catch (err) {
    log("❌ ERROR GENERAL: " + (err && err.stack ? err.stack : err));
  } finally {
    try { await driver.quit(); } catch (e) {}
    log("🧹 Chrome cerrado");
  }
})();
