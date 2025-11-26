// scripts/update_clasificaciones_imd.js
// Extrae las clasificaciones por equipo desde IMD Sevilla y guarda imd_clasificaciones.json
// Comportamiento:
//  - Buscar "las flores"
//  - Para cada fila que contenga "LAS FLORES":
//      - ejecutar datosequipo(id) si está disponible
//      - pulsar pestaña "Consulta de Clasificaciones" (id tab_opc2)
//      - seleccionar selprov -> value "1" (Resultados PROVISIONALES)
//      - esperar la tabla .tt y parsear filas (guardando Puntos, PJ, PG, PP, SG, SP)
//      - guardar en imd_clasificaciones.json con clave imd_<categoria>_<teamslug>

const fs = require("fs");
const path = require("path");
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

function safeKey2(category, teamName) {
  const a = (category || "").toString().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  const b = (teamName || "").toString().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  return `imd_${a}_${b}`.replace(/_+/g, "_");
}

function normalizeText(s) {
  return (s||"").toString().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\u00A0/g," ").trim();
}

function parseIntSafe(v) {
  if (v === null || v === undefined) return null;
  const n = parseInt((v||"").toString().trim().replace(/\D/g,''), 10);
  return isNaN(n) ? null : n;
}

// util: safe file name for debug snapshots
function safeFileName(s) {
  return (s||"").toLowerCase().replace(/\s+/g,"_").replace(/[^a-z0-9_.-]/g,"").slice(0,120);
}

(async function main(){
  log("🌼 Iniciando extracción de CLASIFICACIONES IMD para equipos LAS FLORES...");

  const options = new chrome.Options()
    .addArguments("--headless=new")
    .addArguments("--no-sandbox")
    .addArguments("--disable-dev-shm-usage")
    .addArguments("--lang=es-ES");

  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();
  const clasifMap = {}; // results

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

    // localizar filas de la tabla de resultados (equipos)
    let equipos = [];

    try {
      // prefer #resultado_equipos
      const resultTable = await driver.findElement(By.css("#resultado_equipos")).catch(() => null);
      let rows = [];
      if (resultTable) {
        rows = await resultTable.findElements(By.css("tbody > tr"));
      } else {
        // fallback: buscar cualquier tabla con class tt en resultados
        const someTables = await driver.findElements(By.css("#tab1 table.tt, .tab-content table.tt, table.tt"));
        if (someTables && someTables.length) {
          rows = await someTables[0].findElements(By.css("tbody > tr"));
        } else {
          // otro fallback: buscar filas en el contenedor principal
          rows = await driver.findElements(By.css("#resultado_equipos tbody tr, .resultado_equipos tbody tr, table#resultado_equipos tbody tr")).catch(()=>[]);
        }
      }

      log(`📋 Filas potenciales encontradas en resultados: ${rows.length}`);

      for (const r of rows) {
        try {
          const text = (await r.getText()).toLowerCase();
          if (!text.includes("las flores")) continue;

          // intentar extraer id desde onclick o enlace
          let id = null;
          try {
            // buscar cualquier elemento que contenga datosequipo('ID') en atributo onclick
            const elWithOnclick = await r.findElement(By.xpath(".//*[contains(@onclick,'datosequipo')]")).catch(() => null);
            if (elWithOnclick) {
              const onclick = await elWithOnclick.getAttribute("onclick");
              const m = onclick && onclick.match(/datosequipo\(['"]?([^'")]+)['"]?\)/i);
              if (m) id = m[1];
            }
          } catch(e){}

          // intentar extraer nombre y categoría desde las columnas (si tabla con tds)
          let name = null;
          let category = null;
          try {
            const tds = await r.findElements(By.css("td"));
            if (tds && tds.length) {
              const rawName = await tds[0].getText();
              name = normalizeText(rawName.replace(/^\d+\s*-\s*/,""));
              // categoría no siempre está, intentamos extraerla de una columna (por ejemplo 2da o data)
              // Si no, la dejaremos vacía y la key seguirá funcionando.
              // En algunas tablas hay una columna de categoría: si detectamos texto como "CADETE", "JUVENIL" etc. lo usamos.
              const catGuess = (tds.length > 1) ? normalizeText(await tds[1].getText()) : "";
              if (catGuess && /benjam|alev|infantil|cadet|juvenil|junior|senior|cadete|juvenil/i.test(catGuess)) {
                category = catGuess;
              }
            } else {
              // si no hay tds, usar el texto completo y extraer parte
              const rowText = normalizeText(await r.getText());
              const parts = rowText.split("\n");
              name = normalizeText(parts[0].replace(/^\d+\s*-\s*/,""));
            }
          } catch(e){ /* ignore */ }

          if (!name) {
            // fallback a texto plano de la fila
            name = normalizeText(await r.getText());
          }

          equipos.push({
            id: id,
            name: name,
            category: category || ""
          });
        } catch(e){
          // fila problematica -> ignorar
        }
      } // end for rows

    } catch (errList) {
      log("⚠ Error localizando filas de equipos: " + (errList && errList.message ? errList.message : errList));
    }

    log(`🌸 ${equipos.length} equipos LAS FLORES detectados.`);

    // Si no detectamos equipos automáticamente, intentar alternativa: click primer resultado y ver si en el panel hay enlaces con LAS FLORES
    if (equipos.length === 0) {
      try {
        // buscar enlaces o elementos que contengan "LAS FLORES" en la página
        const possible = await driver.findElements(By.xpath("//*[contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'las flores')]"));
        for (const el of possible) {
          try {
            const txt = normalizeText(await el.getText());
            if (!txt || equipos.find(e => e.name === txt)) continue;
            // intentar id
            let id = null;
            const onclick = await el.getAttribute("onclick");
            if (onclick) {
              const m = onclick.match(/datosequipo\(['"]?([^'")]+)['"]?\)/i);
              if (m) id = m[1];
            }
            equipos.push({ id, name: txt, category: "" });
          } catch(e){}
        }
      } catch(e){}
      log(`📎 Fallback búsqueda directa por texto encontró ${equipos.length} elementos.`);
    }

    // Si aún no hay equipos, abortamos con log
    if (equipos.length === 0) {
      log("❌ No se han detectado equipos LAS FLORES. Revisa el selector o la estructura de la página.");
      // guardar snapshot
      try { fs.writeFileSync(path.join(DEBUG_DIR, `imd_clasif_no_equipos_${RUN_STAMP}.html`), await driver.getPageSource(), "utf8"); } catch(e){}
      // salir pero mantener driver quit en finally
    }

    // Procesar cada equipo
    for (const team of equipos) {
      const teamLabel = `${team.name} (${team.category})`;
      log(`\n➡️ Procesando ${teamLabel}...`);
      try {
        // activar el equipo (datosequipo) si tenemos id
        if (team.id) {
          try {
            await driver.executeScript(`if(typeof datosequipo === 'function'){ datosequipo("${team.id}"); }`);
            log("   ✔ datosequipo ejecutado");
          } catch(e){
            log("   ⚠ no pude ejecutar datosequipo via executeScript: " + (e && e.message ? e.message : e));
          }
        } else {
          // fallback: buscar por nombre en el input y pulsar
          try {
            const searchInput = await driver.findElement(By.id("busqueda"));
            await searchInput.clear();
            await searchInput.sendKeys(team.name, Key.ENTER);
            await driver.sleep(900);
          } catch(e){ /* ignore */ }
        }

        // esperar que el panel con tabs esté disponible
        try {
          await driver.wait(until.elementLocated(By.id("tab1")), 8000);
        } catch(e){ /* no fatal */ }

        // PESTAÑA: pulsar "Consulta de Clasificaciones" -> id tab_opc2 (fallback por texto)
        try {
          const tabClas = await driver.findElement(By.id("tab_opc2")).catch(() => null);
          if (tabClas) {
            await tabClas.click();
            log("   ✔ Tab 'Consulta de Clasificaciones' pulsado (id=tab_opc2)");
          } else {
            // fallback: buscar link en tabs
            const tabs = await driver.findElements(By.css("ul.ui-tabs-nav li a"));
            let clicked = false;
            for (const a of tabs) {
              const txt = (await a.getText() || "").toLowerCase();
              if (txt.includes("clasific")) {
                await a.click();
                clicked = true;
                log("   ✔ Tab 'Consulta de Clasificaciones' pulsado (fallback por texto)");
                break;
              }
            }
            if (!clicked) {
              log("   ⚠ No encontré la pestaña de clasificaciones (id ni texto). Continuo intentando leer tabla.");
            }
          }
        } catch(e) {
          log("   ⚠ Error pulsando pestaña clasificaciones: " + (e && e.message ? e.message : e));
        }

        await driver.sleep(300);

        // Cambiar select selprov a value "1" (Resultados PROVISIONALES) si existe
        try {
          const selprov = await driver.findElement(By.id("selprov")).catch(() => null);
          if (selprov) {
            await driver.executeScript("arguments[0].value = arguments[1]; arguments[0].dispatchEvent(new Event('change'));", selprov, "1");
            log("   ✔ selprov cambiado a PROVISIONALES (value=1)");
            await driver.sleep(300);
          }
        } catch(e){
          log("   ⚠ selprov no pudo cambiarse: " + (e && e.message ? e.message : e));
        }

        // buscar la tabla .tt dentro del panel
        let clasTable = null;
        try {
          clasTable = await driver.wait(
            until.elementLocated(By.css("#tab1 table.tt, #tab1 .tt, .tab-content table.tt, table.tt")),
            7000
          );
        } catch(e) {
          // fallback: buscar cualquier table.tt en la página
          const alt = await driver.findElements(By.css("table.tt"));
          if (alt && alt.length) clasTable = alt[0];
        }

        if (!clasTable) {
          log("   ↪ Tabla de clasificaciones NO encontrada para este equipo.");
          try { fs.writeFileSync(path.join(DEBUG_DIR, `imd_clasif_no_table_${safeFileName(team.name)}_${RUN_STAMP}.html`), await driver.getPageSource(), "utf8"); } catch(e){}
          continue;
        }

        // Ahora parseamos la tabla de forma robusta:
        // - localizar la fila de encabezado (que contiene "Equipo" y "PJ" etc)
        // - construir índice de columnas dinámicamente
        let headerRow = null;
        try {
          const possibleRows = await clasTable.findElements(By.css("tbody > tr"));
          for (const r of possibleRows) {
            const txt = (await r.getText() || "").toLowerCase();
            if (txt.includes("equipo") && txt.includes("pj")) {
              headerRow = r;
              break;
            }
          }
          // si no la encontramos en tbody, intentar thead o la primera tr
          if (!headerRow) {
            try {
              const thead = await clasTable.findElement(By.css("thead")).catch(()=>null);
              if (thead) {
                const ths = await thead.findElements(By.css("tr"));
                if (ths && ths.length) headerRow = ths[0];
              }
            } catch(e){}
          }
          if (!headerRow) {
            // fallback: la primera fila visible
            const allRows = await clasTable.findElements(By.css("tr"));
            if (allRows && allRows.length) headerRow = allRows[0];
          }
        } catch(e){
          headerRow = null;
        }

        // construir mapa índice de columnas
        const colIndex = {};
        if (headerRow) {
          try {
            const headerTds = await headerRow.findElements(By.css("td, th"));
            for (let i = 0; i < headerTds.length; i++) {
              const txt = normalizeText(await headerTds[i].getText()).toLowerCase();
              if (!txt) continue;
              if (txt.includes("equipo")) colIndex.equipo = i;
              if (txt === "pj" || txt.includes("pj")) colIndex.pj = i;
              if (txt === "pg" || txt.includes("pg")) colIndex.pg = i;
              if (txt === "pp" || txt.includes("pp")) colIndex.pp = i;
              if (txt === "pe" || txt.includes("pe")) colIndex.pe = i;
              if (txt.includes("tf") || txt.includes("f") || txt.includes("tantos a favor") || txt.includes("sf") || txt.includes("sg")) colIndex.tf = i;
              if (txt.includes("tc") || txt.includes("c") || txt.includes("tantos en contra") || txt.includes("sc") || txt.includes("sp")) colIndex.tc = i;
              if (txt.includes("puntos") || txt === "puntos") colIndex.puntos = i;
              // otras columnas pueden detectarse si es necesario
            }
          } catch(e){}
        }

        // si no detectamos índices suficientes, intentaremos parse heurístico por posición
        // asumimos: [Equipo, PJ, PG, PE, PP, PNP, JF, JC, TF, TC, Puntos] (ejemplo dado)
        if (!colIndex.equipo || !colIndex.puntos) {
          // build default mapping
          colIndex.equipo = 0;
          colIndex.pj = 1;
          colIndex.pg = 2;
          colIndex.pe = 3;
          colIndex.pp = 4;
          // skip pnp
          colIndex.jf = 6;
          colIndex.jc = 7;
          colIndex.tf = 8;
          colIndex.tc = 9;
          colIndex.puntos = 10;
        }

        // recopilar todas las filas reales (saltando filas de encabezado o subtítulos)
        const allRows = await clasTable.findElements(By.css("tbody > tr"));
        const parsedRows = [];

        for (const r of allRows) {
          try {
            const tds = await r.findElements(By.css("td"));
            if (!tds || tds.length === 0) continue;

            // obtener textos
            const texts = [];
            for (const td of tds) {
              texts.push(normalizeText(await td.getText()));
            }

            // saltar filas que contienen "Resultados Provisionales" u otros subtítulos
            const joined = texts.join(" ").toLowerCase();
            if (!joined || joined.includes("resultados provisionales") || joined.includes("provisionales")) continue;
            // saltar filas que parecen encabezado
            if (joined.includes("equipo") && joined.includes("pj")) continue;

            // extraer según índices detectados (si el índice excede, fallback por posición relativa)
            const equipoText = texts[colIndex.equipo] ? texts[colIndex.equipo].replace(/^\d+\s*-\s*/, "").trim() : texts[0].replace(/^\d+\s*-\s*/,"").trim();
            const pj = parseIntSafe(texts[colIndex.pj] || texts[1]);
            const pg = parseIntSafe(texts[colIndex.pg] || texts[2]);
            const pp = parseIntSafe(texts[colIndex.pp] || texts[4] || texts[3]);
            // SG / SP: usar tf / tc indices (pueden ser puntos a favor/en contra o sets)
            const sg = parseIntSafe(texts[colIndex.tf] || texts[texts.length-3] || texts[8]);
            const sp = parseIntSafe(texts[colIndex.tc] || texts[texts.length-2] || texts[9]);
            const puntos = parseIntSafe(texts[colIndex.puntos] || texts[texts.length-1]);

            // push with normalized fields requested: puntos, pj, pg, pp, sg, sp
            parsedRows.push({
              equipo: normalizeText(equipoText),
              puntos: puntos,
              pj: pj,
              pg: pg,
              pp: pp,
              sg: sg,
              sp: sp
            });

          } catch(e){
            // ignore row parse errors
          }
        } // end for rows

        // save under key
        const key = safeKey2(team.category || "", team.name);
        if (parsedRows.length) {
          clasifMap[key] = parsedRows;
          log(`   ✔ Tabla IMD parseada: ${parsedRows.length} filas (guardadas bajo clave=${key})`);
        } else {
          log("   ↪ Tabla IMD encontrada pero no se parsearon filas (0). Saving snapshot.");
          try { fs.writeFileSync(path.join(DEBUG_DIR, `imd_clasif_emptyrows_${safeFileName(team.name)}_${RUN_STAMP}.html`), await driver.getPageSource(), "utf8"); } catch(e){}
        }

        await driver.sleep(300);

      } catch (errTeam) {
        log(`   ❌ ERROR PROCESANDO ${teamLabel}: ${errTeam && errTeam.message ? errTeam.message : errTeam}`);
        try { fs.writeFileSync(path.join(DEBUG_DIR, `imd_clasif_error_${safeFileName(team.name)}_${RUN_STAMP}.html`), await driver.getPageSource(), "utf8"); } catch(e){}
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
