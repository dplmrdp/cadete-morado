// scripts/update_calendars_imd_multi.js
// Genera .ics para cada equipo desde la web IMD (solo calendarios - no clasificaciones)

const fs = require("fs");
const path = require("path");
const os = require("os");
const { Builder, By, Key, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const { execSync } = require("child_process");

const IMD_URL = "https://imd.sevilla.org/app/jjddmm_resultados/";
const SEARCH_TERM = "las flores";
const OUTPUT_DIR = path.join("calendarios");
const DEBUG_DIR = path.join(OUTPUT_DIR, "debug");
const LOG_DIR = path.join(OUTPUT_DIR, "logs");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(DEBUG_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = path.join(LOG_DIR, `imd_calendars_${RUN_STAMP}.log`);
const ICS_TZID = "Europe/Madrid";

function log(msg) {
  console.log(msg);
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}
function safeNameForFile(category, teamName) {
  return `${category}_${teamName}`.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}
function pad(n){return String(n).padStart(2,"0");}
function fmtICSDateTimeTZID(dt){
  return `${dt.getFullYear()}${pad(dt.getMonth()+1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;
}
function fmtICSDate(d){
  const Y = d.getUTCFullYear(); const M = String(d.getUTCMonth()+1).padStart(2,"0"); const D = String(d.getUTCDate()).padStart(2,"0");
  return `${Y}${M}${D}`;
}
function writeICS(teamName, category, events){
  const safeName = safeNameForFile(category, teamName);
  const filename = `imd_${safeName}.ics`;
  let ics = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:PUBLISH
PRODID:-//Las Flores//Calendarios IMD//ES
`;
  for(const evt of events){
    if(evt.type === "timed"){
      ics += `BEGIN:VEVENT
SUMMARY:${evt.summary}
LOCATION:${evt.location}
DTSTART;TZID=${ICS_TZID}:${fmtICSDateTimeTZID(evt.start)}
DESCRIPTION:${evt.description || ""}
END:VEVENT
`;
    } else {
      ics += `BEGIN:VEVENT
SUMMARY:${evt.summary}
LOCATION:${evt.location}
DTSTART;VALUE=DATE:${fmtICSDate(evt.start)}
DTEND;VALUE=DATE:${fmtICSDate(evt.end)}
DESCRIPTION:${evt.description || ""}
END:VEVENT
`;
    }
  }
  ics += "END:VCALENDAR\n";
  fs.writeFileSync(path.join(OUTPUT_DIR, filename), ics);
  log(`✅ ${filename} (${events.length} eventos)`);
}

async function parseTeamCalendar(driver, teamName){
  const TEAM_EXACT = teamName.trim().toUpperCase();
  const allEvents = [];
  const container = await driver.findElement(By.id("tab1"));
  const tables = await container.findElements(By.css("table.tt"));
  log(`📑 ${tables.length} tablas detectadas para ${teamName}`);
  for(const table of tables){
    let rows = [];
    try { rows = await table.findElements(By.css("tbody > tr")); } catch(e){}
    if(rows.length <= 2) continue;
    for(let i = 2; i < rows.length; i++){
      try {
        const cols = await rows[i].findElements(By.css("td"));
        if(cols.length < 5) continue;
        const vals = await Promise.all(cols.map(c => c.getText().then(t => t.trim())));
        const [fecha, hora, local, visitante, resultado, lugar, obsEncuentro, obsResultado] = vals.concat(new Array(8).fill(""));
        const involves = (local && local.toUpperCase().includes(TEAM_EXACT)) || (visitante && visitante.toUpperCase().includes(TEAM_EXACT));
        if(!involves) continue;
        const match = (fecha || "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
        if(!match) continue;
        const [_, dd, MM, yyyy] = match;
        const time = (hora || "").match(/(\d{2}):(\d{2})/);
        const start = new Date(`${yyyy}-${MM}-${dd}T${time ? time[0] : "00:00"}:00`);
        const summary = `${local} vs ${visitante} (IMD)`;
        const descriptionParts = [];
        if(resultado && resultado !== "-") descriptionParts.push(`Resultado: ${resultado}`);
        if(obsEncuentro && obsEncuentro !== "-") descriptionParts.push(`Obs. Encuentro: ${obsEncuentro}`);
        if(obsResultado && obsResultado !== "-") descriptionParts.push(`Obs. Resultado: ${obsResultado}`);
        const description = descriptionParts.join(" | ");
        allEvents.push({
          type: time ? "timed" : "allday",
          summary,
          location: lugar || "Por confirmar",
          start,
          end: time ? null : new Date(start.getTime() + 86400000),
          description
        });
      } catch(e){}
    }
  }
  return allEvents;
}

(async () => {
  log("🌼 Iniciando generación de calendarios IMD (solo ICS)...");
  const tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-imd-"));
  const options = new chrome.Options()
    .addArguments("--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${tmpUserDir}`)
    .addArguments("--lang=es-ES", "--window-size=1280,1024")
    .addArguments("--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36");
  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();

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
      log(`\n➡️ Procesando ${nombre} (${categoria})...`);
      try {
        await driver.executeScript(`datosequipo("${id}")`);
        log("   ✔ datosequipo ejecutado");
        try {
          await driver.wait(until.elementLocated(By.css("#tab1 table.tt, #tab1 .tt")), 9000);
          log("   ✔ Calendario / tabla detectada en #tab1");
        } catch(e){
          log(`   ❌ Timeout esperando calendario para ${nombre}: ${e && e.message}`);
          try { fs.writeFileSync(path.join(DEBUG_DIR, `imd_error_after_datosequipo_${slug}.html`), await driver.getPageSource(), "utf8"); } catch {}
          continue;
        }
        try { fs.writeFileSync(path.join(DEBUG_DIR, `imd_after_datosequipo_${slug}.html`), await driver.getPageSource(), "utf8"); } catch(e){}
        const events = await parseTeamCalendar(driver, nombre);
        writeICS(nombre, categoria, events);
        log(`   ✔ ${nombre} (${categoria}): ${events.length} partidos capturados`);
      } catch(e){
        log(`❌ ERROR procesando ${nombre}: ${e && e.message ? e.message : e}`);
        continue;
      }
    }
    log("\n🧱 Generando index.html automáticamente...");
    try { execSync("node scripts/generate_index_html.js", { stdio: "inherit" }); log("✅ index.html actualizado correctamente."); } catch(e) { log("❌ Error generando index.html: "+(e&&e.message?e.message:e)); }
    log("💚 IMD (calendarios) completado");
  } catch (err) {
    log("❌ ERROR GENERAL: " + (err && err.stack ? err.stack : err));
  } finally {
    try { await driver.quit(); } catch(e){}
    log("🧹 Chrome cerrado");
  }
})();
