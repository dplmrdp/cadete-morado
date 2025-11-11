// scripts/update_calendars_federado_multi.js
// Scraper federado multi-categoría/grupo/equipo (FAVOLE).
// Genera un ICS por cada equipo "LAS FLORES" detectado en cada grupo de cada torneo.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { Builder, By, Key, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

const BASE_LIST_URL = "https://favoley.es/es/tournaments?season=8565&category=&sex=2&sport=&tournament_status=&delegation=1630";

const OUTPUT_DIR = path.join("calendarios");
const DEBUG_DIR = path.join(OUTPUT_DIR, "debug");
const LOG_DIR = path.join(OUTPUT_DIR, "logs");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(DEBUG_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = path.join(LOG_DIR, `federado_${RUN_STAMP}.log`);

function log(line) {
  const msg = typeof line === "string" ? line : JSON.stringify(line);
  console.log(msg);
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch (_) {}
}

function onError(err, ctx = "UNSPECIFIED") {
  log(`❌ ERROR (${ctx}): ${err && err.stack ? err.stack : err}`);
}

const ICS_TZID = "Europe/Madrid";
const TEAM_NEEDLE = "las flores";

function normalize(s) {
  return (s || "").toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}
function normLower(s){ return normalize(s).toLowerCase(); }
function slug(s){
  return normalize(s).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"");
}

function parseDateDDMMYYYY(s) {
  const m = (s||"").match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const [, dd, MM, yyyy] = m;
  return { yyyy, MM, dd };
}
function parseTimeHHMM(s) {
  const m = (s||"").match(/(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, HH, mm] = m;
  return { HH, mm };
}

function toLocalDate({yyyy,MM,dd}, timeOrNull){
  const d = new Date(`${yyyy}-${MM}-${dd}T${timeOrNull ? `${timeOrNull.HH}:${timeOrNull.mm}` : "00:00"}:00`);
  return d;
}

function fmtICSDateTimeTZID(dt) {
  const pad = n => String(n).padStart(2,"0");
  return `${dt.getFullYear()}${pad(dt.getMonth()+1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}${pad(dt.getSeconds())}`;
}

function fmtICSDateUTC(d){
  const Y = d.getUTCFullYear(), M = String(d.getUTCMonth()+1).padStart(2,"0"), D = String(d.getUTCDate()).padStart(2,"0");
  return `${Y}${M}${D}`;
}

function writeICS(filename, events){
  let ics = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:PUBLISH
PRODID:-//Las Flores//Calendarios Federado//ES
`;
  for(const evt of events){
    if(evt.type === "timed"){
      ics += `BEGIN:VEVENT
SUMMARY:${evt.summary}
LOCATION:${evt.location || ""}
DTSTART;TZID=${ICS_TZID}:${fmtICSDateTimeTZID(evt.start)}
DESCRIPTION:${evt.description || ""}
END:VEVENT
`;
    } else {
      ics += `BEGIN:VEVENT
SUMMARY:${evt.summary}
LOCATION:${evt.location || ""}
DTSTART;VALUE=DATE:${fmtICSDateUTC(evt.start)}
DTEND;VALUE=DATE:${fmtICSDateUTC(evt.end)}
DESCRIPTION:${evt.description || ""}
END:VEVENT
`;
    }
  }
  ics += "END:VCALENDAR\n";

  const out = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(out, ics);
  log(`✅ ICS escrito: ${out} (${events.length} eventos)`);
}

// ------------------------------------------------------------
// EXTRAER CALENDARIO (la misma función que ya tenías)
// ------------------------------------------------------------
async function parseFederadoCalendarPage(driver, meta){
  const pageHTML = await driver.getPageSource();
  const fname = `fed_${meta.tournamentId}_${meta.groupId}.html`;
  fs.writeFileSync(path.join(DEBUG_DIR, fname), pageHTML);
  log(`🧩 Snapshot guardado: ${fname}`);

  let rows = [];
  try { rows = await driver.findElements(By.css("table tbody tr")); } catch(_){}

  if(rows.length === 0){
    rows = await driver.findElements(By.css("tr, .table-row, .row"));
  }

  const matches = [];
  for(const r of rows){
    try{
      const txt = await r.getText();
      const line = normalize(txt);
      const mDate = line.match(/(\d{2}\/\d{2}\/\d{4})/);
      if(!mDate) continue;

      const tds = await r.findElements(By.css("td"));
      let fecha="", hora="", local="", visitante="", lugar="", resultado="";

      if(tds.length >= 4){
        fecha = (await tds[0].getText()).trim();
        const hh = (await tds[1].getText()).trim();
        hora = hh.match(/\d{2}:\d{2}/) ? hh : (line.match(/(\d{2}:\d{2})/)?.[1] || "");
        local = (await tds[2].getText()).trim();
        visitante = (await tds[3].getText()).trim();
        if(tds[4]) resultado = (await tds[4].getText()).trim();
        if(tds[5]) lugar = (await tds[5].getText()).trim();
      } else {
        fecha = mDate[1];
        hora = (line.match(/(\d{2}:\d{2})/)?.[1] || "");
        const mVS = line.match(/(.+?)\s+vs\s+(.+?)(\s|$)/i);
        if(mVS){ local = mVS[1].trim(); visitante = mVS[2].trim(); }
      }

      if(!fecha || !local || !visitante) continue;
      matches.push({fecha, hora, local, visitante, lugar, resultado});
    }catch(_){}
  }

  const teams = new Map();

  for(const m of matches){
    const localN = normLower(m.local);
    const visitN = normLower(m.visitante);
    const needle = TEAM_NEEDLE;

    const involveLocal = localN.includes(needle);
    const involveVisit = visitN.includes(needle);
    if(!involveLocal && !involveVisit) continue;

    const candidates = [];
    if(involveLocal) candidates.push(m.local);
    if(involveVisit) candidates.push(m.visitante);

    for(const teamName of candidates){
      const d = parseDateDDMMYYYY(m.fecha);
      if(!d){ continue; }
      const t = parseTimeHHMM(m.hora);
      const start = toLocalDate(d, t);

      const summary = `${m.local} vs ${m.visitante} (Federado)`;
      const descParts = [];
      if(m.resultado && m.resultado !== "-") descParts.push(`Resultado: ${m.resultado}`);
      const description = descParts.join(" | ");

      const evt = t ? { type:"timed", start, summary, location: m.lugar || "", description }
                    : { type:"allday", start, end: new Date(start.getTime()+86400000), summary, location: m.lugar || "", description };

      if(!teams.has(teamName)) teams.set(teamName, []);
      teams.get(teamName).push(evt);
    }
  }

  const outFiles = [];
  for(const [teamName, events] of teams.entries()){
    events.sort((a,b)=>a.start - b.start);
    const fname = `federado_${slug(teamName)}_${slug(meta.category)}_${meta.groupId}.ics`;
    writeICS(fname, events);
    outFiles.push(fname);
  }

  log(`📦 Generados ${outFiles.length} calendarios para torneo=${meta.tournamentId} grupo=${meta.groupId}`);
}


// ------------------------------------------------------------
// *** NUEVA FUNCIÓN COMPLETA Y CORRECTA para obtener grupos ***
// ------------------------------------------------------------
async function discoverGroupIds(driver, tournamentId){
  const url = `https://favoley.es/es/tournament/${tournamentId}`;
  log(`➡️ Abriendo torneo: ${url}`);
  await driver.get(url);

  await driver.wait(until.elementLocated(By.css(".bootstrap-select")), 15000);

  const dropdownBtn = await driver.findElement(By.css(".bootstrap-select > button.dropdown-toggle"));
  await dropdownBtn.click();

  await driver.sleep(500);

  const items = await driver.findElements(By.css(".bootstrap-select .dropdown-menu.inner li"));
  const result = [];

  let index = 0;
  for(const li of items){
    try {
      const textEl = await li.findElement(By.css("span.text"));
      const label = (await textEl.getText()).trim();

      if(!label || label.startsWith("LIGA PROVINCIAL") || label === "") continue;

      await dropdownBtn.click();
      await li.click();
      await driver.sleep(500);

      const links = await driver.findElements(By.css("a[href*='/calendar/']"));
      let groupId = null;

      for(const a of links){
        const href = await a.getAttribute("href");
        const m = href.match(/\/calendar\/(\d+)/);
        if(m){
          groupId = m[1];
          break;
        }
      }

      if(groupId){
        result.push({ groupId, label });
        log(`✅ Grupo encontrado: ${label} → ${groupId}`);
      } else {
        log(`⚠️ No se pudo extraer groupId tras seleccionar "${label}"`);
      }
    } catch(e){
      // ignoramos items raros
    }
    index++;
  }

  return result;
}


// ------------------------------------------------------------
// MAIN
// ------------------------------------------------------------
(async () => {
  log("🏐 Iniciando scraping FEDERADO multi-equipos LAS FLORES…");

  const tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-fed-"));
  const options = new chrome.Options()
    .addArguments("--headless=new")
    .addArguments("--disable-gpu")
    .addArguments("--no-sandbox")
    .addArguments("--disable-dev-shm-usage")
    .addArguments(`--user-data-dir=${tmpUserDir}`);

  let driver;
  try{
    driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();

    const tournaments = await discoverTournamentIds(driver);

    for(const t of tournaments){
      const category = extractCategoryFromLabel(t.label);
      log(`\n======= 🏷 Torneo ${t.id} :: ${t.label} (cat: ${category}) =======`);

      let groups = [];
      try {
        groups = await discoverGroupIds(driver, t.id);
      } catch(e){
        onError(e, `discoverGroupIds t=${t.id}`);
        continue;
      }

      log(`🔹 Grupos detectados en torneo ${t.id}: ${groups.length}`);

      for(const g of groups){
        const calURL = `https://favoley.es/es/tournament/${t.id}/calendar/${g.groupId}/all`;
        try{
          log(`➡️  Abriendo calendario: ${calURL}`);
          await driver.get(calURL);

          await driver.wait(until.elementLocated(By.css("table, .table, .v-data-table, .row, tbody")), 15000);

          await parseFederadoCalendarPage(driver, {
            tournamentId: t.id,
            groupId: g.groupId,
            category
          });

        } catch(e){
          onError(e, `parse calendar t=${t.id} g=${g.groupId}`);
          try {
            const html = await driver.getPageSource();
            fs.writeFileSync(path.join(DEBUG_DIR, `fed_err_${t.id}_${g.groupId}.html`), html);
          } catch(_){}
        }
      }
    }

    log("\n✅ Scraping federado multi-equipos completado.");

  } catch(err){
    onError(err, "MAIN");
  } finally {
    try { if(driver) await driver.quit(); } catch(_){}
    log("🧹 Chrome cerrado");
  }
})();
