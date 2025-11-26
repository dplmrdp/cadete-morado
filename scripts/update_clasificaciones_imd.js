// scripts/update_clasificaciones_imd.js
// Scraper IMD: por cada equipo LAS FLORES -> obtener clasificación (Resultados PROVISIONALES)
// Guarda resultado en calendarios/imd_clasificaciones.json

const fs = require("fs");
const path = require("path");
const { Builder, By, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

const IMD_URL = "https://imd.sevilla.org/app/jjddmm_resultados/";
const SEARCH_TERM = "las flores";
const OUTPUT_DIR = path.join("calendarios");
const DEBUG_DIR = path.join(OUTPUT_DIR, "debug");
const LOG_FILE = path.join(OUTPUT_DIR, `imd_clasif_${new Date().toISOString().replace(/[:.]/g,"-")}.log`);

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(DEBUG_DIR, { recursive: true });

function log(...args) {
  console.log(...args);
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${args.join(" ")}\n`); } catch (e) {}
}
function safeKey(category, teamName) {
  return `imd_${(category||"").toLowerCase().replace(/\s+/g,"_").replace(/[^a-z0-9_]/g,"")}_${(teamName||"").toLowerCase().replace(/\s+/g,"_").replace(/[^a-z0-9_]/g,"")}`.replace(/_+/g,"_");
}
function toIntOrNull(s) {
  if (s === null || s === undefined) return null;
  const n = parseInt(String(s).replace(/[^\d\-]/g,''), 10);
  return Number.isFinite(n) ? n : null;
}

(async () => {
  log("🌼 Iniciando obtención de clasificaciones IMD (Resultados PROVISIONALES)...");

  const options = new chrome.Options()
    .addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--lang=es-ES");

  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();

  try {
    await driver.get(IMD_URL);
    log("🌐 Página abierta:", IMD_URL);

    // buscar terminos
    const input = await driver.wait(until.elementLocated(By.id("busqueda")), 15000);
    await input.clear();
    await input.sendKeys(SEARCH_TERM);
    // el sitio tiene un button genérico; pulsamos el primero visible
    const btn = await driver.findElement(By.css("button"));
    await btn.click();
    log("🔎 Buscando equipos con needle:", SEARCH_TERM);

    // esperar resultados
    await driver.wait(until.elementLocated(By.css("#resultado_equipos tbody tr")), 10000);
    const rows = await driver.findElements(By.css("#resultado_equipos tbody tr"));
    log(`📋 ${rows.length} filas en resultados de equipos.`);

    const equipos = [];
    for (const r of rows) {
      try {
        const tds = await r.findElements(By.css("td"));
        if (tds.length < 3) continue;
        const name = (await tds[0].getText()).trim();
        const category = (await tds[2].getText()).trim();
        if ((name || "").toLowerCase().includes("las flores")) {
          // recuperar el datosequipo id si existe en outerHTML
          const outer = await r.getAttribute("outerHTML");
          const m = outer.match(/datosequipo\('([A-F0-9-]+)'\)/i);
          equipos.push({ name, category, id: m ? m[1] : null });
        }
      } catch (e) { /* ignore row */ }
    }
    log(`🌸 ${equipos.length} equipos "LAS FLORES" detectados.`);

    const resultMap = {};

    for (const team of equipos) {
      log(`\n➡️ Procesando clasificación para: ${team.name} (${team.category})`);
      const slugKey = safeKey(team.category, team.name);

      try {
        // Ejecutar datosequipo para cargar info del equipo (misma acción que en calendarios)
        if (team.id) {
          await driver.executeScript(`datosequipo("${team.id}")`);
          log("   ✔ datosequipo ejecutado (id)", team.id);
        } else {
          // fallback: buscar por nombre en el input y pulsar buscar
          const searchInput = await driver.findElement(By.id("busqueda"));
          await searchInput.clear();
          await searchInput.sendKeys(team.name);
          await driver.findElement(By.css("button")).click();
          log("   ✔ busqueda por nombre ejecutada como fallback");
        }

        // Esperar que #tab1 exista y sea visible (contenedor de tabs)
        await driver.wait(until.elementLocated(By.id("tab1")), 8000);
        // Hacemos click en la pestaña "Consulta de Clasificaciones" (id tab_opc2) -> si está siempre presente, click seguro
        try {
          const tabClas = await driver.findElement(By.css("#tab_opc2"));
          await tabClas.click();
          log("   ✔ Tab 'Consulta de Clasificaciones' pulsado");
        } catch (e) {
          // si no hay click posible, intentar ejecutar script que active la pestaña
          await driver.executeScript(`var el = document.getElementById('tab_opc2'); if(el) el.click();`);
          log("   ⚠ Intentado activar tab_opc2 vía script");
        }

        // Forzar select a PROVISIONALES (value "1") y ejecutar onchange handler
        const setProvScript = `
          (function(){
            var s = document.getElementById('selprov');
            if(!s) return false;
            s.value = '1';
            if(typeof cambioprov === 'function') {
              try { cambioprov(); } catch(e) { /* ignore */ }
            }
            // return whether selprov exists
            return true;
          })();
        `;
        const ok = await driver.executeScript(setProvScript);
        if (!ok) {
          log("   ❗ selprov no encontrado en la página (no se pudo seleccionar provisionales)");
        } else {
          log("   ✔ selprov cambiado a '1' (PROVISIONALES) y cambiado invocado");
        }

        // esperar que la tabla de clasificación aparezca dentro de #tab1
        // la tabla suele tener class 'tt' y contener 'Resultados Provisionales' o 'Equipo' en thead
        await driver.wait(async () => {
          const src = await driver.getPageSource();
          return /Resultados\s+Provisionales|Equipo/i.test(src) && (await driver.findElements(By.css("#tab1 table.tt"))).length > 0;
        }, 8000).catch(() => {}); // tolerante

        // localizar la tabla de clasificacion: buscar la tabla.tt que contenga 'Resultados Provisionales' o un thead con 'Equipo'
        let tabla = null;
        const candidates = await driver.findElements(By.css("#tab1 table.tt"));
        for (const t of candidates) {
          try {
            const html = await t.getAttribute("outerHTML");
            if (/Resultados\s+Provisionales|Equipo/i.test(html) || /Puntos|PJ|PG|PP|JF|JC/i.test(html)) {
              tabla = t;
              break;
            }
          } catch (e) {}
        }
        if (!tabla) {
          // como fallback, usar el primer table.tt encontrado
          if (candidates.length > 0) tabla = candidates[0];
        }

        if (!tabla) {
          log("   ❌ No se encontró tabla de clasificación para este equipo. Guardando snapshot y continuando.");
          try { fs.writeFileSync(path.join(DEBUG_DIR, `imd_clasif_no_table_${slugKey}.html`), await driver.getPageSource(), "utf8"); } catch (e) {}
          continue;
        }

        // parse header para mapear índices dinámicamente
        const headers = await tabla.findElements(By.css("thead th"));
        const thTexts = headers.length ? await Promise.all(headers.map(h => h.getText().then(t => (t||"").trim()))) : [];
        // fallback: algunas tablas no usan thead, leer primer TR as header
        if (thTexts.length === 0) {
          const firstRowTds = await tabla.findElements(By.css("tbody tr:first-child td"));
          const maybeHeaders = await Promise.all(firstRowTds.map(c => c.getText().then(t => (t||"").trim())));
          // If first row contains words like 'Equipo' or 'PJ', consider it header and skip it later
          if (maybeHeaders.some(x => /Equipo|PJ|Puntos|PG|JF|JC/i.test(x))) {
            for (let i=0;i<maybeHeaders.length;i++) thTexts.push(maybeHeaders[i]);
          }
        }

        // derive indices
        const idxOf = (names) => {
          for (const name of names) {
            const idx = thTexts.findIndex(h => h && h.toLowerCase().includes(name.toLowerCase()));
            if (idx >= 0) return idx;
          }
          return -1;
        };

        const idxEquipo = idxOf(["Equipo", "Equipo"]);
        const idxPTS = idxOf(["Puntos","PTS"]);
        const idxPJ = idxOf(["PJ"]);
        const idxPG = idxOf(["PG"]);
        const idxPP = idxOf(["PP"]);
        // JF -> SG, JC -> SP (confirmado por ti: opción A)
        const idxJF = idxOf(["JF","JF " ,"JF"]);
        const idxJC = idxOf(["JC","JC ","JC"]);

        // if header parsing failed, try fallback positions based on common IMD layout:
        // Equipo(0), PJ(1), PG(2), PE(3), PP(4), PNP(5), JF(6), JC(7), TF(8), TC(9), Puntos(10)
        let fallbackUsed = false;
        if (idxEquipo === -1 && idxPTS === -1 && thTexts.length === 0) {
          fallbackUsed = true;
        }

        // parse tbody rows (ignore header rows if any)
        const bodyRows = await tabla.findElements(By.css("tbody > tr"));
        const parsedRows = [];

        for (const tr of bodyRows) {
          try {
            const tds = await tr.findElements(By.css("td"));
            if (tds.length === 0) continue;
            // get all cell texts
            const vals = await Promise.all(tds.map(td => td.getText().then(t => (t||"").trim())));
            // if header row, skip (contains words)
            const isHeaderRow = vals.some(v => /Equipo|PJ|Puntos|PG|JF|JC/i.test(v));
            if (isHeaderRow) continue;

            // fallback mapping when header indices unknown
            let equipoTxt = null, pts=null, pj=null, pg=null, pp=null, sg=null, sp=null;
            if (!fallbackUsed && (idxEquipo >=0 || idxPTS>=0 || idxJF>=0)) {
              if (idxEquipo>=0) equipoTxt = vals[idxEquipo] || vals[0];
              else equipoTxt = vals[0];

              pts = (idxPTS>=0)? toIntOrNull(vals[idxPTS]) : toIntOrNull(vals[vals.length-1]);
              pj = (idxPJ>=0)? toIntOrNull(vals[idxPJ]) : toIntOrNull(vals[1]);
              pg = (idxPG>=0)? toIntOrNull(vals[idxPG]) : toIntOrNull(vals[2]);
              pp = (idxPP>=0)? toIntOrNull(vals[idxPP]) : toIntOrNull(vals[4]);
              sg = (idxJF>=0)? toIntOrNull(vals[idxJF]) : toIntOrNull(vals[6]);
              sp = (idxJC>=0)? toIntOrNull(vals[idxJC]) : toIntOrNull(vals[7]);
            } else {
              // fallback fixed positions
              equipoTxt = vals[0];
              pj = toIntOrNull(vals[1]);
              pg = toIntOrNull(vals[2]);
              pp = toIntOrNull(vals[4]);
              sg = toIntOrNull(vals[6]);
              sp = toIntOrNull(vals[7]);
              pts = toIntOrNull(vals[vals.length-1]);
            }

            parsedRows.push({
              team: equipoTxt,
              puntos: pts,
              pj: pj,
              pg: pg,
              pp: pp,
              sg: sg,
              sp: sp
            });
          } catch (e) {
            // ignore row parse error
          }
        } // end for rows

        // If parsedRows is empty but page had content, save snapshot for debugging
        if (!parsedRows.length) {
          log("   ⚠ Se encontró tabla pero no se pudieron parsear filas. Guardando snapshot.");
          try { fs.writeFileSync(path.join(DEBUG_DIR, `imd_clasif_emptyrows_${slugKey}.html`), await driver.getPageSource(), "utf8"); } catch (e) {}
        } else {
          log(`   ✔ Tabla parseada: ${parsedRows.length} filas`);
        }

        resultMap[slugKey] = parsedRows;

      } catch (err) {
        log(`   ❌ Error procesando ${team.name}: ${err && err.message ? err.message : err}`);
        try { fs.writeFileSync(path.join(DEBUG_DIR, `imd_clasif_error_${slugKey}.html`), await driver.getPageSource(), "utf8"); } catch (e) {}
      }
    } // end for equipos

    // Guardar JSON
    const outPath = path.join(OUTPUT_DIR, "imd_clasificaciones.json");
    fs.writeFileSync(outPath, JSON.stringify(resultMap, null, 2), "utf8");
    log(`✅ Guardadas clasificaciones IMD en: ${outPath} (equipos: ${Object.keys(resultMap).length})`);

  } catch (err) {
    log("❌ ERROR GENERAL (clasificaciones IMD):", err && err.stack ? err.stack : err);
  } finally {
    try { await driver.quit(); } catch (e) {}
    log("🧹 Chrome cerrado (clasificaciones IMD)");
  }
})();
