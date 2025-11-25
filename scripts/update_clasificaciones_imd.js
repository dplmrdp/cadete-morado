// scripts/update_clasificaciones_imd.js
// Scraper de CLASIFICACIONES IMD para los equipos "LAS FLORES"
// Genera: calendarios/imd_clasificaciones.json
// Guarda snapshots en calendarios/debug/*.html y logs en calendarios/logs/

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
const OUT_JSON = path.join(OUTPUT_DIR, "imd_clasificaciones.json");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(DEBUG_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = path.join(LOG_DIR, `imd_clasif_${RUN_STAMP}.log`);

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch {}
  console.log(msg);
}
function safeKey(category, teamName) {
  return `imd_${(category + "_" + teamName).toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}
function trimTeamCell(txt) {
  if (!txt) return "";
  // remove leading "1 - " or " 1 - "
  return txt.replace(/^\s*\d+\s*[-–]\s*/, "").replace(/\s+/g, " ").trim();
}

(async () => {
  log("🔎 Iniciando obtención de CLASIFICACIONES IMD para 'LAS FLORES'...");

  const tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-imd-clasif-"));

  const options = new chrome.Options()
    .addArguments("--headless=new")
    .addArguments("--no-sandbox")
    .addArguments("--disable-dev-shm-usage")
    .addArguments(`--user-data-dir=${tmpUserDir}`)
    .addArguments("--lang=es-ES")
    .addArguments("--window-size=1400,1200")
    .addArguments("--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");

  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();

  // cargar map existente (si existe) para no perder clasifs previas
  let existing = {};
  if (fs.existsSync(OUT_JSON)) {
    try { existing = JSON.parse(fs.readFileSync(OUT_JSON, "utf8")); } catch (e) { log("⚠️ No pude parsear imd_clasificaciones.json existente, se reescribirá."); existing = {}; }
  }

  try {
    await driver.get(IMD_URL);
    log(`🌐 Página abierta: ${IMD_URL}`);

    const input = await driver.wait(until.elementLocated(By.id("busqueda")), 15000);
    await driver.wait(until.elementIsVisible(input), 5000);
    await input.clear();
    await input.sendKeys(SEARCH_TERM, Key.ENTER);
    log(`🔎 Buscando '${SEARCH_TERM}'...`);
    await driver.sleep(1200);

    // esperar la tabla principal que lista equipos
    await driver.wait(
      until.elementLocated(By.xpath("//table[contains(@class,'tt')]//td[contains(.,'Nº') or contains(.,'Equipos')]")),
      20000
    );

    const tab1 = await driver.findElement(By.id("tab1"));
    const table = await tab1.findElement(By.css("table.tt"));
    const rows = await table.findElements(By.css("tbody > tr"));
    log(`📋 ${rows.length} filas detectadas en la lista de equipos.`);

    const equipos = [];

    for (const row of rows) {
      try {
        const cols = await row.findElements(By.css("td"));
        if (!cols || cols.length < 3) continue;
        const nombre = (await cols[0].getText()).trim().toUpperCase();
        const categoria = (await cols[2].getText()).trim().toUpperCase();
        if (!nombre.includes("LAS FLORES")) continue;
        const rowHtml = await row.getAttribute("outerHTML");
        const m = rowHtml.match(/datosequipo\('([A-F0-9-]+)'\)/i);
        if (m) equipos.push({ id: m[1], nombre, categoria });
      } catch (e) { /* ignore per-row problems */ }
    }

    log(`🌸 ${equipos.length} equipos LAS FLORES detectados.`);

    for (const { id, nombre, categoria } of equipos) {
      const key = safeKey(categoria, nombre);
      log(`\n➡️ Procesando clasificación para: ${nombre} (${categoria})  key=${key}`);

      try {
        // abrir equipo
        await driver.executeScript(`datosequipo("${id}")`);
        log("   ✔ datosequipo ejecutado");

        // necesito pulsar en la pestaña "Consulta de Clasificaciones"
        // botón: <a href="#tab1" id="tab_opc2">Consulta de Clasificaciones</a>
        try {
          const tabOpc = await driver.findElement(By.id("tab_opc2"));
          await driver.executeScript("arguments[0].click();", tabOpc);
          log("   ✔ Pestaña 'Consulta de Clasificaciones' pulsada");
        } catch (e) {
          log("   ⚠️ No he encontrado #tab_opc2 para pulsar (puede ya estar activa)");
        }

        // esperar que exista el select selprov y cambiarlo a PROVISIONALES (value "1")
        try {
          const selProv = await driver.wait(until.elementLocated(By.id("selprov")), 8000);
          await driver.wait(until.elementIsVisible(selProv), 4000);
          // seleccionar por valor "1" si existe
          await driver.executeScript(`(function(s){ s.value = "1"; s.dispatchEvent(new Event('change')); })(arguments[0]);`, selProv);
          log("   ✔ selprov cambiado a PROVISIONALES (value=1)");
        } catch (e) {
          log("   ⚠️ selprov no disponible o no interactuable: " + (e.message || e));
        }

        // esperar la tabla de clasificación. La tabla es <table class="tt"> con cabecera "Resultados Provisionales"
        // Hacemos espera corta y luego snapshot para depuración
        await driver.sleep(600); // dejar que JS actualice el DOM

        // buscar la tabla que contiene "Resultados Provisionales"
        let clasifTable = null;
        try {
          // intenta localizar tabla con texto "Resultados Provisionales"
          const candidateTables = await driver.findElements(By.css("table.tt"));
          for (const t of candidateTables) {
            const html = await t.getAttribute("outerHTML");
            if (html && /Resultados\s*Provisionales/i.test(html)) {
              clasifTable = t;
              break;
            }
          }
        } catch (e) { /* ignore */ }

        // fallback: si no contiene exactamente ese texto, usar la primera tabla.tt que tenga filas
        if (!clasifTable) {
          try {
            const candidateTables = await driver.findElements(By.css("table.tt"));
            for (const t of candidateTables) {
              const rowsT = await t.findElements(By.css("tbody > tr"));
              if (rowsT && rowsT.length > 1) { clasifTable = t; break; }
            }
          } catch (e) {}
        }

        // guardar snapshot siempre (útil para debugging)
        try {
          const snapName = path.join(DEBUG_DIR, `imd_clasif_after_datosequipo_${safeKey(categoria,nombre)}.html`);
          fs.writeFileSync(snapName, await driver.getPageSource(), "utf8");
          log(`   ✔ Snapshot guardado: ${path.basename(snapName)}`);
        } catch (e) { log("   ⚠️ No se pudo guardar snapshot: " + (e.message || e)); }

        if (!clasifTable) {
          log("   ⚠️ No se detectó tabla de clasificaciones para este equipo. Manteniendo clasif previa si existe.");
          continue;
        }

        // parsear filas
        const trs = await clasifTable.findElements(By.css("tbody > tr"));
        // normalmente las primeras filas son cabecera y luego filas por equipo;
        // construiremos una lista con filas que contienen columnas numéricas.
        const rowsData = [];

        for (const tr of trs) {
          try {
            // obtener todas las celdas
            const tds = await tr.findElements(By.css("td"));
            if (!tds || tds.length < 2) continue;

            // texto de la primera celda (nombre)
            const teamText = (await tds[0].getText()).trim();
            // si la fila es cabecera (contiene "Equipo" etc) la ignoramos
            if (/Equipo/i.test(teamText) && /PJ/i.test(await tds[1].getText())) continue;

            // extraer columnas esperadas:
            // 0: Equipo
            // 1: PJ
            // 2: PG
            // 3: PE (empates) (no usamos)
            // 4: PP
            // 5: PNP (??) (no usamos)
            // 6: JF (sets favor?) (no usamos for now)
            // 7: JC (sets contra?) (no usamos)
            // 8: TF (tantos a favor)
            // 9: TC (tantos en contra)
            // 10: Puntos (última columna)
            const txts = [];
            for (let i = 0; i < tds.length; i++) {
              const v = (await tds[i].getText()).trim();
              txts.push(v);
            }

            // Guardar sólo filas con un nombre útil y un valor numérico en la última columna
            const last = txts[txts.length - 1] || "";
            const pts = last.replace(/\s+/g, "");
            if (!pts || !/^\d+$/.test(pts.replace(/\D/g, ""))) {
              // no es una fila de datos
              continue;
            }

            // Normalizar campos (si faltan columnas, rellenar con "")
            const padded = txts.concat(new Array(12).fill("")).slice(0, 12);

            const teamRaw = trimTeamCell(padded[0]);
            const pj = padded[1].replace(/\D/g, "") || "0";
            const pg = padded[2].replace(/\D/g, "") || "0";
            const pp = padded[4].replace(/\D/g, "") || "0";
            const tf = padded[8].replace(/\s+/g, "") || "";
            const tc = padded[9].replace(/\s+/g, "") || "";
            const puntos = padded[10].replace(/\D/g, "") || padded[padded.length-1].replace(/\D/g,"") || "0";

            // Mapear a formato federado: team, pts, pj, pg, pp, sg, sp
            // Decisión: sg = TF (tantos a favor), sp = TC (tantos en contra)
            const rowObj = {
              team: teamRaw,
              pts: puntos,
              pj: pj,
              pg: pg,
              pp: pp,
              sg: tf || "",
              sp: tc || ""
            };

            rowsData.push(rowObj);
          } catch (e) {
            // ignore row parse errors but log tiny note
            log("   ⚠️ fila no parseada: " + (e.message || e));
          }
        } // end for trs

        if (!rowsData.length) {
          log("   ⚠️ Tabla IMD: 0 filas (o no parseables). Manteniendo clasif previa si existe.");
          continue;
        }

        // guardar en el JSON (mergeando)
        existing[key] = rowsData;
        try {
          fs.writeFileSync(OUT_JSON, JSON.stringify(existing, null, 2), "utf8");
          log(`   ✅ Clasificación IMD guardada: key=${key} (${rowsData.length} filas)`);
        } catch (e) {
          log("   ❌ Error guardando JSON de clasificaciones: " + (e.message || e));
        }

      } catch (err) {
        log("   ❌ Error procesando equipo: " + (err && err.message ? err.message : err));
        // guardar snapshot de error
        try {
          const snapErr = path.join(DEBUG_DIR, `imd_clasif_error_${safeKey(categoria,nombre)}.html`);
          fs.writeFileSync(snapErr, await driver.getPageSource(), "utf8");
          log(`   ⚠ Snapshot error guardado: ${path.basename(snapErr)}`);
        } catch (e) {}
        continue;
      }
    } // end for equipos

    log("\n✅ Proceso clasificaciones IMD finalizado.");
  } catch (err) {
    log("❌ ERROR GENERAL: " + (err && (err.stack || err.message) ? (err.stack || err.message) : err));
  } finally {
    try { await driver.quit(); } catch {}
    log("🧹 Chrome cerrado");
  }
})();
