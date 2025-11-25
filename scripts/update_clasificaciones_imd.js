// scripts/update_clasificaciones_imd.js
// Recorre equipos IMD y guarda las clasificaciones (Resultados PROVISIONALES) en calendarios/imd_clasificaciones.json

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

function log(msg) {
  console.log(msg);
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

function safeNameForFile(category, teamName) {
  return `${category}_${teamName}`.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

async function ensureProvisionales(driver){
  // Forzar selprov = 1 (provisionales) y disparar cambioprov()
  try {
    await driver.executeScript("if(window.jQuery){ $('#selprov').val('1'); } else { if(document.getElementById('selprov')) document.getElementById('selprov').value='1'; }");
    await driver.executeScript("try{ window.cambioprov && window.cambioprov(); } catch(e){}");
    // esperar un momento a que la tabla se recargue
    await driver.sleep(600);
  } catch(e){
    log("   ⚠ No se pudo forzar PROVISIONALES: " + (e && e.message ? e.message : e));
  }
}

async function parseClasificacionesFromPage(driver){
  // busca tabla #tab1 .tt y parsea filas en formato IMD
  try {
    const table = await driver.findElement(By.css("#tab1 table.tt"));
    const rows = await table.findElements(By.css("tbody > tr"));
    const result = [];
    for(const row of rows){
      try {
        const tds = await row.findElements(By.css("td"));
        // admitir 10 o más columnas: [team, pj, pg, pe, pp, pnp, jf, jc, tf, tc, puntos]
        if(tds.length < 10) continue;
        const colsText = await Promise.all(tds.map(c => c.getText().then(t => t.trim())));
        const teamRaw = colsText[0].replace(/^\d+\s*-\s*/, "").trim();
        const ptsIndex = Math.min(10, colsText.length-1);
        result.push({
          team: teamRaw,
          pj: colsText[1] || "",
          pg: colsText[2] || "",
          pe: colsText[3] || "",
          pp: colsText[4] || "",
          pnp: colsText[5] || "",
          jf: colsText[6] || "",
          jc: colsText[7] || "",
          tf: colsText[8] || "",
          tc: colsText[9] || "",
          pts: colsText[ptsIndex] || ""
        });
      } catch(e){}
    }
    return result;
  } catch(e){
    return null;
  }
}

(async () => {
  log("🌼 Iniciando obtención de CLASIFICACIONES IMD (PROVISIONALES)...");
  const tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-imd-clasif-"));
  const options = new chrome.Options()
    .addArguments("--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${tmpUserDir}`)
    .addArguments("--lang=es-ES", "--window-size=1280,1024")
    .addArguments("--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36");
  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();

  const outPath = path.join(OUTPUT_DIR, "imd_clasificaciones.json");
  let clasifData = {};
  if(fs.existsSync(outPath)){
    try { clasifData = JSON.parse(fs.readFileSync(outPath, "utf8")); } catch(e){ clasifData = {}; }
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
    await driver.wait(until.elementLocated(By.xpath("//table[contains(@class,'tt')]//td[contains(.,'Nº.Equipos') or contains(.,'Nº.Equipos')]")), 15000);
    const tab1 = await driver.findElement(By.id("tab1"));
    const table = await tab1.findElement(By.css("table.tt"));
    const rows = await table.findElements(By.css("tbody > tr"));
    log(`📋 ${rows.length} filas encontradas en tabla de equipos.`);
    const equipos = [];
    for(const row of rows){
      try {
        const cols = await row.findElements(By.css("td"));
        if(cols.length < 3) continue;
        const nombre = (await cols[0].getText()).trim().toUpperCase();
        const categoria = (await cols[2].getText()).trim().toUpperCase();
        if(nombre.includes("LAS FLORES")){
          const rowHtml = await row.getAttribute("outerHTML");
          const match = rowHtml.match(/datosequipo\('([A-F0-9-]+)'\)/i);
          if(match) equipos.push({ id: match[1], nombre, categoria });
        }
      } catch(e){}
    }
    log(`🌸 ${equipos.length} equipos LAS FLORES detectados.`);

    for(const { id, nombre, categoria } of equipos){
      const slug = safeNameForFile(categoria, nombre);
      log(`\n➡️ Procesando CLASIFICACIÓN ${nombre} (${categoria})...`);
      try {
        // cargar datos del equipo (esto puede cambiar el tab activo)
        await driver.executeScript(`datosequipo("${id}")`);
        log("   ✔ datosequipo ejecutado");
        // esperar que #tab1 se actualice
        try {
          await driver.wait(until.elementLocated(By.css("#tab1")), 6000);
        } catch(e){ log("   ⚠ Timeout esperando #tab1 tras datosequipo"); }
        // en algunos casos ya está en clasificaciones; en otros no.
        // Intentar abrir tab de clasificaciones (si existe)
        try {
          const tab2 = await driver.findElements(By.id("tab_opc2"));
          if(tab2.length){
            await driver.executeScript("arguments[0].click();", tab2[0]);
            log("   ✔ Tab clasificaciones pulsado (o ya activo)");
            // esperar re-render
            await driver.sleep(400);
          } else {
            // intenta por selector alternativo: buscar enlace por texto
            try {
              await driver.executeScript("Array.from(document.querySelectorAll('a')).filter(a=>a.textContent && a.textContent.match(/Clasific/i))[0] && Array.from(document.querySelectorAll('a')).filter(a=>a.textContent && a.textContent.match(/Clasific/i))[0].click()");
              await driver.sleep(400);
              log("   ✔ Intento alternativo de abrir pestaña de clasificaciones realizado");
            } catch(e){}
          }
        } catch(e){ log("   ⚠ No pudo pulsar tab clasificaciones: "+(e&&e.message?e.message:e)); }

        // Forzar PROVISIONALES
        await ensureProvisionales(driver);

        // esperar tabla y parsear
        try {
          await driver.wait(until.elementLocated(By.css("#tab1 table.tt tbody tr")), 6000);
        } catch(e){
          log("   ⚠ Timeout esperando filas de clasificación (posible ausencia)");
        }

        const clasif = await parseClasificacionesFromPage(driver);
        if(clasif && clasif.length){
          clasifData[slug] = clasif;
          fs.writeFileSync(outPath, JSON.stringify(clasifData, null, 2), "utf8");
          log(`   ✔ Clasificación guardada: key=${slug} (${clasif.length} filas)`);
          // guardar snapshot
          try { fs.writeFileSync(path.join(DEBUG_DIR, `imd_after_clasif_${slug}.html`), await driver.getPageSource(), "utf8"); } catch(e){}
        } else {
          log("   ⚠ Clasificación no encontrada o vacía para este equipo. Manteniendo previa si existía.");
          try { fs.writeFileSync(path.join(DEBUG_DIR, `imd_after_clasif_${slug}.html`), await driver.getPageSource(), "utf8"); } catch(e){}
        }

      } catch(e){
        log(`❌ ERROR procesando clasificación ${nombre}: ${e && e.message ? e.message : e}`);
        try { fs.writeFileSync(path.join(DEBUG_DIR, `imd_error_clasif_${slug}.html`), await driver.getPageSource(), "utf8"); } catch(e){}
        continue;
      }
    }

    log("\n✅ Clasificaciones IMD procesadas y guardadas (si se detectaron).");

  } catch(e){
    log("❌ ERROR GENERAL: " + (e && e.stack ? e.stack : e));
  } finally {
    try { await driver.quit(); } catch(e){}
    log("🧹 Chrome cerrado");
  }
})();
