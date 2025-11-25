// scripts/update_clasificaciones_imd.js
// Extrae las clasificaciones por equipo desde IMD Sevilla y guarda imd_clasificaciones.json
// Comportamiento:
//  - Buscar "las flores"
//  - Para cada fila que contenga "LAS FLORES":
//      - ejecutar datosequipo(id)
//      - pulsar pestaña "Consulta de Clasificaciones" (id tab_opc2)
//      - seleccionar selprov -> value "1" (Resultados PROVISIONALES)
//      - esperar la tabla .tt y parsear filas
//      - guardar en imd_clasificaciones.json con clave imd_<categoria>_<teamslug>

const fs = require("fs");
const path = require("path");
const os = require("os");
const { Builder, By, Key, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

const OUTPUT_DIR = path.join("calendarios");
const DEBUG_DIR = path.join(OUTPUT_DIR, "debug");
const LOG_DIR = path.join(OUTPUT_DIR, "logs");
const OUT_JSON = path.join(OUTPUT_DIR, "imd_clasificaciones.json");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(DEBUG_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = path.join(LOG_DIR, `imd_clasif_${RUN_STAMP}.log`);
const IMD_URL = "https://imd.sevilla.org/app/jjddmm_resultados/";
const SEARCH_TERM = "las flores";

function log(msg) {
  console.log(msg);
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch (e) {}
}

function safeKey(category, teamName) {
  return `imd_${(category || "").toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "")}_${(teamName || "").toLowerCase().replace(/\s+/g, "_').replace(/[^a-z0-9_]/g, "")}`.replace(/_+/g, "_");
}

// fallback safeKey (more robust)
function safeKey2(category, teamName) {
  const a = (category || "").toString().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  const b = (teamName || "").toString().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  return `imd_${a}_${b}`.replace(/_+/g, "_");
}

function normalizeText(s) {
  return (s||"").toString().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\u00A0/g," ").trim();
}

function parseIntSafe(v) {
  const n = parseInt((v||"").toString().trim().replace(/\D/g,''), 10);
  return isNaN(n) ? null : n;
}

(async function main(){
  log("🌼 Iniciando extracción de CLASIFICACIONES IMD para equipos LAS FLORES...");

  const options = new chrome.Options()
    .addArguments("--headless=new")
    .addArguments("--no-sandbox")
    .addArguments("--disable-dev-shm-usage")
    .addArguments("--lang=es-ES");

  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();

  const clasifMap = {}; // collect results here

  try {
    await driver.get(IMD_URL);
    log(`🌐 Página abierta: ${IMD_URL}`);

    // buscar input y lanzar búsqueda
    const input = await driver.wait(until.elementLocated(By.id("busqueda")), 15000);
    await driver.wait(until.elementIsVisible(input), 5000);
    await input.clear();
    await input.sendKeys(SEARCH_TERM, Key.ENTER);
    log(`🔎 Buscando '${SEARCH_TERM}'...`);
    await driver.sleep(1200);

    // esperar la tabla de resultados y recoger filas
    await driver.wait(until.elementLocated(By.xpath("//table[contains(@class,'tt')] | //table[@id='resultado_equipos'] | //table[contains(@id,'resultado')]")), 10000)
      .catch(()=>{ /* no fatal */ });

    // localizar filas de equipos (usa #resultado_equipos si existe, si no buscar tables con class tt en el panel de resultados)
    let rows = [];
    try {
      const resultTable = await driver.findElement(By.css("#resultado_equipos"));
      rows = await resultTable.findElements(By.css("tbody > tr"));
    } catch (e) {
      // fallback: buscar cualquier tabla con filas en el contenedor principal
      try {
        const someTables = await driver.findElements(By.css("#tab1 table.tt, .tab-content table.tt, table.tt"));
        if (someTables && someTables.length) {
          // la primera tabla de equipos suele estar en #tab1 - tomamos sus filas
          rows = await someTables[0].findElements(By.css("tbody > tr"));
        }
      } catch(e2) {
        // nada
      }
    }

    log(`📋 ${rows.length} filas encontradas en tabla de equipos (heurística).`);

    // extraer equipos que contengan LAS FLORES
    const equipos = [];
    for (const r of rows) {
      try {
        const tds = await r.findElements(By.css("td"));
        if (!tds || tds.length < 1) continue;
        const name = (await tds[0].getText()).trim();
        const category = tds.length >= 3 ? (await tds[2].getText()).trim() : "";
        if ((name || "").toUpperCase().includes("LAS FLORES")) {
          // intentar extraer id datosequipo('...') desde outerHTML si está
          let id = null;
          try {
            const html = await r.getAttribute("outerHTML");
            const m = html && html.match(/datosequipo\('([A-F0-9-]+)'\)/i);
            if (m) id = m[1];
          } catch(e){}
          equipos.push({ name, category, id });
        }
      } catch(e){}
    }

    log(`🌸 ${equipos.length} equipos LAS FLORES detectados.`);

    for (const team of equipos) {
      const teamLabel = `${team.name} (${team.category})`;
      log(`\n➡️ Procesando ${teamLabel}...`);
      try {
        // si hay id, ejecutar datosequipo(id); si no, escribir el nombre en búsqueda y pulsar
        if (team.id) {
          await driver.executeScript(`datosequipo("${team.id}")`);
          log("   ✔ datosequipo ejecutado");
        } else {
          // fallback: buscar por nombre
          const searchInput = await driver.findElement(By.id("busqueda"));
          await searchInput.clear();
          await searchInput.sendKeys(team.name);
          // click al botón de búsqueda (si existe)
          try {
            const btn = await driver.findElement(By.css("button"));
            await btn.click();
          } catch(e){}
          await driver.sleep(800);
        }

        // Esperar que se muestre el tab1 contenido (el DOM cambia)
        try {
          await driver.wait(until.elementLocated(By.id("tab1")), 8000);
        } catch(e){ /* no fatal */ }

        // PESTAÑA: pulsar "Consulta de Clasificaciones" -> id tab_opc2 (puede estar siempre)
        try {
          const tabClas = await driver.findElement(By.id("tab_opc2"));
          await tabClas.click();
          log("   ✔ Tab 'Consulta de Clasificaciones' pulsado");
        } catch(e) {
          // Si no existe id, intentar pulsar por texto
          try {
            const tabs = await driver.findElements(By.css("ul.ui-tabs-nav li a"));
            for (const a of tabs) {
              const txt = await a.getText();
              if (txt && txt.toLowerCase().includes("clasific")) {
                await a.click();
                log("   ✔ Tab 'Consulta de Clasificaciones' pulsado (fallback)");
                break;
              }
            }
          } catch(e2) {
            log("   ⚠ No pude pulsar la pestaña de clasificaciones: " + (e2 && e2.message ? e2.message : e2));
          }
        }

        await driver.sleep(300); // dejar que el DOM reprocesa la pestaña

        // Cambiar select selprov a value "1" (Resultados PROVISIONALES)
        try {
          const selprov = await driver.findElement(By.id("selprov"));
          // set value via JS to ensure onchange triggers
          await driver.executeScript("arguments[0].value = arguments[1]; arguments[0].dispatchEvent(new Event('change'));", selprov, "1");
          log("   ✔ selprov cambiado a PROVISIONALES (value=1)");
        } catch (e) {
          log("   ⚠ selprov no encontrado o no se pudo cambiar: " + (e && e.message ? e.message : e));
        }

        // esperar la tabla de clasificación dentro del panel (buscamos la primera table.tt que contenga muchos td)
        let clasTable = null;
        try {
          // esperar hasta una tabla .tt dentro del #tab1 o contenedor de clasificaciones
          clasTable = await driver.wait(
            until.elementLocated(By.css("#tab1 table.tt, #tab1 .tt, .tab-content table.tt, table.tt")),
            6000
          );
        } catch(e) {
          // si no aparece, lo intentamos una vez más con menor selector
          try {
            const alt = await driver.findElements(By.css("table.tt"));
            if (alt && alt.length) clasTable = alt[0];
          } catch(_) { /* ignore */ }
        }

        if (!clasTable) {
          log("   ↪ Tabla de clasificaciones NO encontrada para este equipo (se usará guardada si existe).");
          // guardar snapshot
          try { fs.writeFileSync(path.join(DEBUG_DIR, `imd_clasif_no_table_${safeFileName(team.name)}.html`), await driver.getPageSource(), "utf8"); } catch(e){}
          continue;
        }

        // Tenemos la tabla, tomar filas del tbody (salta encabezados)
        let rowsClas = [];
        try {
          rowsClas = await clasTable.findElements(By.css("tbody > tr"));
        } catch(e){ rowsClas = []; }

        // Some IMD pages show a first header row and then a header row with column names - we skip header rows
        const parsedRows = [];

        for (const r of rowsClas) {
          try {
            // get the tds text
            const tds = await r.findElements(By.css("td"));
            if (!tds || tds.length < 2) continue;

            // first column is team name; last column is points; columns in between are PJ PG PE PP PNP JF JC TF TC (approx)
            // We will read text of all tds and map by index.
            const texts = [];
            for (const td of tds) {
              const t = (await td.getText()).trim();
              texts.push(t);
            }

            // detect header row: often contains 'Equipo' or 'PJ' etc.
            const first = (texts[0] || "").toLowerCase();
            if (first.includes("equipo") || first.includes("result") || first.includes("resultados")) {
              continue; // skip header
            }

            // Some rows include numbering "1 - TEAM NAME" or similar -> remove leading "N - "
            let teamText = texts[0].replace(/^\s*\d+\s*-\s*/,"").trim();

            // Normalize multiple spaces
            teamText = normalizeText(teamText);

            // Determine numeric columns robustly: find last numeric cell (points)
            // We'll try to map from the right:
            const len = texts.length;
            const ptsRaw = texts[len-1] || "";
            const tcRaw = texts[len-2] || "";
            const tfRaw = texts[len-3] || "";
            const jcRaw = texts[len-4] || "";
            const jfRaw = texts[len-5] || "";
            // earlier: PNP / PP / PE / PG / PJ might occupy earlier indexes depending on table layout
            // we'll attempt to map middle numbers from left to right after team column.
            // Collect all numeric-looking cells (in order)
            const numeric = texts.slice(1).map(s => s.replace(/\s+/g," ").trim());

            // Extract key stats tolerant
            const pj = parseIntSafe(numeric[0]);
            const pg = parseIntSafe(numeric[1]);
            const pe = parseIntSafe(numeric[2]);
            const pp = parseIntSafe(numeric[3]);
            const pnp = parseIntSafe(numeric[4]);
            const jf = parseIntSafe(numeric[5]);
            const jc = parseIntSafe(numeric[6]);
            const tf = parseIntSafe(numeric[7]);
            const tc = parseIntSafe(numeric[8]);
            const puntos = parseIntSafe(numeric[numeric.length-1]);

            parsedRows.push({
              team: teamText,
              pj: pj,
              pg: pg,
              pe: pe,
              pp: pp,
              pnp: pnp,
              jf: jf,
              jc: jc,
              tf: tf,
              tc: tc,
              puntos: puntos
            });

          } catch(e){
            // ignore row parse errors
          }
        } // end for rows

        // Save into map under a canonical key using category + team
        const key = safeKey2(team.category, team.name);
        if (parsedRows.length) {
          clasifMap[key] = parsedRows;
          log(`   ✔ Tabla IMD: ${parsedRows.length} filas (guardadas bajo clave=${key})`);
        } else {
          log("   ↪ Tabla IMD encontrada pero no se parsearon filas (0). Saving snapshot.");
          try { fs.writeFileSync(path.join(DEBUG_DIR, `imd_clasif_emptyrows_${safeFileName(team.name)}.html`), await driver.getPageSource(), "utf8"); } catch(e){}
        }

        // small sleep be polite
        await driver.sleep(300);

      } catch (errTeam) {
        log(`   ❌ ERROR PROCESANDO ${teamLabel}: ${errTeam && errTeam.message ? errTeam.message : errTeam}`);
        try { fs.writeFileSync(path.join(DEBUG_DIR, `imd_clasif_error_${safeFileName(team.name)}.html`), await driver.getPageSource(), "utf8"); } catch(e){}
        continue;
      }
    } // end for equipos

    // write JSON (merge with existing if present)
    let existing = {};
    if (fs.existsSync(OUT_JSON)) {
      try { existing = JSON.parse(fs.readFileSync(OUT_JSON, "utf8")); } catch(e){ existing = {}; }
    }
    const merged = { ...existing, ...clasifMap };
    fs.writeFileSync(OUT_JSON, JSON.stringify(merged, null, 2), "utf8");
    log(`✅ Clasificaciones IMD guardadas en ${OUT_JSON} (${Object.keys(clasifMap).length} equipos nuevos)`);

  } catch (err) {
    log("❌ ERROR GENERAL: " + (err && err.stack ? err.stack : err));
  } finally {
    try { await driver.quit(); } catch(e){}
    log("🧹 Chrome cerrado");
  }

})();

// util: safe file name for debug snapshots
function safeFileName(s) {
  return (s||"").toLowerCase().replace(/\s+/g,"_").replace(/[^a-z0-9_.-]/g,"").slice(0,120);
}
