// scripts/update_calendars_federado_multi.js
// Scraper federado multi-categoría/grupo/equipo (FAVOLE).
// Genera un ICS por cada equipo "LAS FLORES" detectado en cada grupo de cada torneo.
// Requisitos: selenium-webdriver, Chrome/chromedriver (los instala GH Actions)

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
const TEAM_NEEDLE = "las flores"; // filtro por club
const CATEGORIES_ORDER = ["ALEVIN","BENJAMIN","INFANTIL","CADETE","JUVENIL","SENIOR"]; // por si lo necesitas después

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

// Fecha/hora local Europe/Madrid (no Z)
function toLocalDate({yyyy,MM,dd}, timeOrNull){
  const d = new Date(`${yyyy}-${MM}-${dd}T${timeOrNull ? `${timeOrNull.HH}:${timeOrNull.mm}` : "00:00"}:00`);
  return d;
}
function fmtICSDateTimeTZID(dt) {
  const pad = n => String(n).padStart(2,"0");
  return `${dt.getFullYear()}${pad(dt.getMonth()+1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}${pad(dt.getSeconds())}`;
}
function fmtICSDateUTC(d){
  // all-day (VALUE=DATE) usa YYYYMMDD en UTC
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
    } else { // allday
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

// ---- Parsing de una página de calendario (…/tournament/{id}/calendar/{group_id}/all) ----
// Estructura típica: tabla/listado por jornadas con columnas: Fecha | Hora | Local | Visitante | ... (varía ligeramente).
async function parseFederadoCalendarPage(driver, meta){
  const pageHTML = await driver.getPageSource();
  const fname = `fed_${meta.tournamentId}_${meta.groupId}.html`;
  fs.writeFileSync(path.join(DEBUG_DIR, fname), pageHTML);
  log(`🧩 Snapshot guardado: ${fname}`);

  // Estrategia robusta:
  // - Buscar todas las filas que contengan equipos (2 celdas consecutivas tipo nombres).
  // - Extraer fecha (dd/mm/aaaa) y hora (hh:mm).
  // - Filtrar por equipos que contengan "LAS FLORES".
  // ⚠️ Cada instalación de FAVOLE puede variar; dejamos logs si no se detectan partidos.

  // Intento 1: tabla con filas <tr>
  let rows = [];
  try {
    rows = await driver.findElements(By.css("table tbody tr"));
  } catch(_) {}

  // Si no encontramos tabla clásica, intentamos divs con filas
  if(rows.length === 0){
    rows = await driver.findElements(By.css("tr, .table-row, .row"));
  }

  const matches = []; // cada item: {fecha, hora, local, visitante, lugar?, resultado?}
  for(const r of rows){
    try{
      const txt = await r.getText();
      const line = normalize(txt);
      // Buscamos fecha
      const mDate = line.match(/(\d{2}\/\d{2}\/\d{4})/);
      if(!mDate) continue;

      // Intentamos desglosar con celdas
      const tds = await r.findElements(By.css("td"));
      let fecha="", hora="", local="", visitante="", lugar="", resultado="";

      if(tds.length >= 4){
        fecha = (await tds[0].getText()).trim();
        const hh = (await tds[1].getText()).trim();
        // A veces en la misma celda: "11:30"
        hora = hh.match(/\d{2}:\d{2}/) ? hh : (line.match(/(\d{2}:\d{2})/)?.[1] || "");
        // En algunos casos local y visitante están en 2 y 3
        local = (await tds[2].getText()).trim();
        visitante = (await tds[3].getText()).trim();
        if(tds[4]) resultado = (await tds[4].getText()).trim();
        if(tds[5]) lugar = (await tds[5].getText()).trim();
      } else {
        // fallback por texto
        fecha = mDate[1];
        hora = (line.match(/(\d{2}:\d{2})/)?.[1] || "");
        // heurística: extraer local/visitante por " X vs Y " o por posiciones conocidas
        const mVS = line.match(/([^]+?)\s+vs\s+([^]+?)\s/iu);
        if(mVS){
          local = mVS[1].trim();
          visitante = mVS[2].trim();
        } else {
          // último recurso: intentar cortar por muchos espacios
          const parts = line.split(/\s{2,}/);
          local = parts[2] || "";
          visitante = parts[3] || "";
        }
      }

      if(!fecha || !local || !visitante) continue;
      matches.push({fecha, hora, local, visitante, lugar, resultado});
    }catch(e){
      // fila rara, seguimos
    }
  }

  if(matches.length === 0){
    log(`⚠️ No se detectaron filas de partidos en torneo=${meta.tournamentId} grupo=${meta.groupId}. Revisa snapshot.`);
  }

  // Agrupar por cada equipo LAS FLORES (exacto por texto tal cual aparece)
  const teams = new Map(); // key: teamName, value: array de eventos
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
      // construir evento
      const d = parseDateDDMMYYYY(m.fecha);
      if(!d){ log(`⚠️ Fecha inválida: ${m.fecha}`); continue; }
      const t = parseTimeHHMM(m.hora); // puede ser null (all-day)
      const start = toLocalDate(d, t);

      const summary = `${m.local} vs ${m.visitante} (Federado)`;
      const descParts = [];
      if(m.resultado && m.resultado !== "-") descParts.push(`Resultado: ${m.resultado}`);
      const description = descParts.join(" | ");

      const evt = t ? { type:"timed", start, summary, location: m.lugar || "", description }
                    : { type:"allday", start, end: new Date(start.getTime()+24*3600*1000), summary, location: m.lugar || "", description };

      if(!teams.has(teamName)) teams.set(teamName, []);
      teams.get(teamName).push(evt);
    }
  }

  // Escribir un ICS por equipo LAS FLORES
  const outFiles = [];
  for(const [teamName, events] of teams.entries()){
    // nombre archivo: federado_{slug(team)}_{slug(categoria)}_{groupId}.ics
    const fname = `federado_${slug(teamName)}_${slug(meta.category)}_${meta.groupId}.ics`;
    // Ordenar por fecha
    events.sort((a,b)=>a.start - b.start);
    writeICS(fname, events);
    outFiles.push(fname);
  }

  log(`📦 Generados ${outFiles.length} calendarios para torneo=${meta.tournamentId} grupo=${meta.groupId}`);
  if(outFiles.length){
    log(`↪ ${outFiles.join(", ")}`);
  }
}

// ---- Descubrimiento de torneos y grupos ----
async function discoverTournamentIds(driver){
  await driver.get(BASE_LIST_URL);
  log(`🌐 Página base (lista de competiciones): ${BASE_LIST_URL}`);

  // Esperar a que aparezca el listado
  await driver.wait(until.elementLocated(By.css("table, .v-data-table, .table, .list")), 20000).catch(()=>{});
  // Capturar todos los enlaces que contengan "/es/tournament/{id}"
  const links = await driver.findElements(By.css("a[href*='/es/tournament/']"));
  const ids = new Map(); // id -> nombre visible

  for(const a of links){
    const href = (await a.getAttribute("href")) || "";
    const m = href.match(/\/es\/tournament\/(\d+)/);
    if(!m) continue;
    const tId = m[1];
    let label = (await a.getText()).trim();
    if(!label) {
      // intentar subir al padre cercano
      try { label = (await (await a.findElement(By.xpath(".."))).getText()).trim(); } catch(_){}
    }
    ids.set(tId, label || `Torneo ${tId}`);
  }

  log(`🔎 Torneos detectados: ${ids.size}`);
  if(ids.size === 0){
    const html = await driver.getPageSource();
    fs.writeFileSync(path.join(DEBUG_DIR, `fed_list_${RUN_STAMP}.html`), html);
    log("⚠️ No se detectaron torneos. Guardado snapshot fed_list_*.html");
  }
  return [...ids.entries()].map(([id,label]) => ({id, label}));
}

function extractCategoryFromLabel(label){
  const L = normalize(label).toUpperCase();
  // Tomamos el token de categoría conocido
  for(const c of ["ALEVIN","BENJAMIN","INFANTIL","CADETE","JUNIOR","JUVENIL","SENIOR"]){
    if(L.includes(c)) return c === "JUNIOR" ? "JUVENIL" : c; // normalizamos JUNIOR -> JUVENIL
  }
  return "SIN-CATEGORIA";
}

async function discoverGroupIds(driver, tournamentId){
  // Vamos a la portada del torneo y buscamos cualquier enlace a /calendar/{groupId}
  const url = `https://favoley.es/es/tournament/${tournamentId}`;
  await driver.get(url);
  await driver.wait(until.elementLocated(By.css("a[href*='/calendar/']")), 15000).catch(()=>{});
  const links = await driver.findElements(By.css("a[href*='/calendar/']"));
  const groupIds = new Set();

  for(const a of links){
    const href = (await a.getAttribute("href")) || "";
    const m = href.match(/\/calendar\/(\d+)/);
    if(m) groupIds.add(m[1]);
  }

  // Si no encontramos ninguno, intentamos botón "Ver calendario"
  if(groupIds.size === 0){
    const alt = await driver.findElements(By.xpath("//a[contains(.,'Ver calendario')]"));
    for(const a of alt){
      const href = (await a.getAttribute("href")) || "";
      const m = href.match(/\/calendar\/(\d+)/);
      if(m) groupIds.add(m[1]);
    }
  }

  return [...groupIds];
}

// ---- MAIN ----
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

    // 1) Torneos
    const tournaments = await discoverTournamentIds(driver);

    for(const t of tournaments){
      const category = extractCategoryFromLabel(t.label);
      log(`\n======= 🏷 Torneo ${t.id} :: ${t.label} (cat: ${category}) =======`);

      // 2) Grupos
      let groups = [];
      try {
        groups = await discoverGroupIds(driver, t.id);
      } catch(e){
        onError(e, `discoverGroupIds t=${t.id}`);
        continue;
      }
      log(`🔹 Grupos detectados en torneo ${t.id}: ${groups.length} -> [${groups.join(", ")}]`);

      if(groups.length === 0){
        const html = await driver.getPageSource();
        fs.writeFileSync(path.join(DEBUG_DIR, `fed_torneo_${t.id}.html`), html);
        log(`⚠️ Sin grupos detectados en torneo ${t.id}. Guardado snapshot fed_torneo_${t.id}.html`);
        continue;
      }

      // 3) Cada grupo → calendario "all"
      for(const g of groups){
        const calURL = `https://favoley.es/es/tournament/${t.id}/calendar/${g}/all`;
        try{
          log(`➡️  Abriendo calendario: ${calURL}`);
          await driver.get(calURL);
          // Asegurar que hay algo de tabla/listado
          await driver.wait(until.elementLocated(By.css("table, .table, .v-data-table, tbody, .row")), 15000);

          await parseFederadoCalendarPage(driver, {
            tournamentId: t.id,
            groupId: g,
            category
          });
        } catch(e){
          onError(e, `parse calendar t=${t.id} g=${g}`);
          // snapshot del error
          try{
            const html = await driver.getPageSource();
            fs.writeFileSync(path.join(DEBUG_DIR, `fed_err_${t.id}_${g}.html`), html);
          }catch(_){}
          continue;
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
