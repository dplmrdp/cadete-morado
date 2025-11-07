// scripts/update_calendars_imd_multi.js
// Genera calendarios IMD (todos los equipos de LAS FLORES)
// Requiere: selenium-webdriver, Chrome/Chromedriver

const fs = require("fs");
const path = require("path");
const os = require("os");
const { Builder, By, Key, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

// ---------------- CONFIG ----------------
const IMD_URL = "https://imd.sevilla.org/app/jjddmm_resultados/";
const SEARCH_TERM = "las flores";
const OUTPUT_DIR = path.join("calendarios");
const DEBUG_DIR = path.join(OUTPUT_DIR, "debug");
const LOG_DIR = path.join(OUTPUT_DIR, "logs");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(DEBUG_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = path.join(LOG_DIR, `imd_multi_${RUN_STAMP}.log`);

function log(msg) {
  console.log(msg);
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}
function normalize(s) {
  return (s || "").toString().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim().toLowerCase();
}
function parseDateDDMMYYYY(s) {
  const m = (s || "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? { yyyy: m[3], MM: m[2], dd: m[1] } : null;
}
function parseTimeHHMM(s) {
  const m = (s || "").match(/(\d{2}):(\d{2})/);
  return m ? { HH: m[1], mm: m[2] } : null;
}
function addDays(d, days) { const nd = new Date(d.getTime()); nd.setDate(nd.getDate() + days); return nd; }

// ---- ICS HELPERS ----
const ICS_TZID = "Europe/Madrid";
function fmtICSLocalParts(y, M, d, h, m) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${y}${pad(M)}${pad(d)}T${pad(h)}${pad(m)}00`;
}
function fmtICSDate(d) {
  const Y = d.getUTCFullYear();
  const M = String(d.getUTCMonth() + 1).padStart(2, "0");
  const D = String(d.getUTCDate()).padStart(2, "0");
  return `${Y}${M}${D}`;
}
function writeICS(filename, events) {
  let ics = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:PUBLISH
PRODID:-//Las Flores//Calendarios IMD//ES
`;
  for (const evt of events) {
    if (evt.type === "timed") {
      const { y, M, d, h, m } = evt.startLocalParts;
      ics += `BEGIN:VEVENT
SUMMARY:${evt.summary}
LOCATION:${evt.location}
DTSTART;TZID=${ICS_TZID}:${fmtICSLocalParts(y, M, d, h, m)}
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
  const out = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(out, ics);
  log(`✅ Calendario escrito: ${filename} (${events.length} eventos)`);
}

// ---- Parsear jornadas ----
async function extractTextFromCell(el) {
  return el.getText().then((t) => (t || "").replace(/\u00A0/g, " ").trim());
}
async function parseAllJornadaTables(driver, teamName) {
  const container = await driver.findElement(By.id("tab1"));
  const tables = await container.findElements(By.css("table.tt"));
  const events = [];
  for (const table of tables) {
    const rows = await table.findElements(By.css("tbody > tr"));
    if (rows.length <= 2) continue;
    for (let i = 2; i < rows.length; i++) {
      const tds = await rows[i].findElements(By.css("td"));
      if (tds.length < 8) continue;
      const [fechaEl, horaEl, localEl, visitEl, resEl, lugarEl, obsEEl, obsREl] = tds;
      const [fecha, hora, local, visit, res, lugar, obsE, obsR] = await Promise.all([
        extractTextFromCell(fechaEl),
        extractTextFromCell(horaEl),
        extractTextFromCell(localEl),
        extractTextFromCell(visitEl),
        extractTextFromCell(resEl),
        extractTextFromCell(lugarEl),
        extractTextFromCell(obsEEl),
        extractTextFromCell(obsREl),
      ]);

      const d = parseDateDDMMYYYY(fecha);
      const t = parseTimeHHMM(hora);
      if (!d) continue;

      const summary = `${local} vs ${visit} (IMD)`;
      const descParts = [];
      if (res && res !== "-") descParts.push(`Resultado: ${res}`);
      if (obsE && obsE !== "-") descParts.push(`Obs. Encuentro: ${obsE}`);
      if (obsR && obsR !== "-") descParts.push(`Obs. Resultado: ${obsR}`);
      const description = descParts.join(" | ");

      if (t) {
        events.push({
          type: "timed",
          summary,
          location: lugar || "Por confirmar",
          startLocalParts: { y: +d.yyyy, M: +d.MM, d: +d.dd, h: +t.HH, m: +t.mm },
          description,
        });
      } else {
        const start = new Date(Date.UTC(+d.yyyy, +d.MM - 1, +d.dd));
        const end = addDays(start, 1);
        events.push({ type: "allday", summary, location: lugar, start, end, description });
      }
    }
  }
  return events;
}

// ---------------- MAIN ----------------
(async () => {
  log("🌼 Iniciando generación de calendarios IMD para equipos LAS FLORES...");

  const tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-imd-"));
  const options = new chrome.Options()
    .addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${tmpUserDir}`);
  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();

  try {
    await driver.get(IMD_URL);
    log(`🌐 Página abierta: ${IMD_URL}`);

    const input = await driver.wait(until.elementLocated(By.id("busqueda")), 15000);
    await input.clear();
    await input.sendKeys(SEARCH_TERM, Key.ENTER);
    log(`🔎 Buscando '${SEARCH_TERM}'...`);

    const tab1 = await driver.wait(until.elementLocated(By.id("tab1")), 15000);
    const table = await tab1.findElement(By.css("table.tt"));
    const rows = await table.findElements(By.css("tbody > tr"));
    log(`📋 ${rows.length} filas detectadas (incluye cabeceras)`);

    // Extraer equipos LAS FLORES
    const equipos = [];
    for (const row of rows) {
      const tds = await row.findElements(By.css("td"));
      if (tds.length < 3) continue;
      const nombre = (await tds[0].getText()).trim();
      const categoria = (await tds[2].getText()).trim();
      if (!/LAS FLORES/i.test(nombre)) continue;
      const rowHtml = await row.getAttribute("outerHTML");
      const match = rowHtml.match(/datosequipo\('([A-F0-9-]+)'\)/i);
      if (match && match[1]) {
        equipos.push({ nombre, categoria, guid: match[1] });
      }
    }

    log(`🏐 Se han identificado ${equipos.length} equipos de Las Flores.`);
    if (!equipos.length) throw new Error("No se encontraron equipos LAS FLORES.");

    // Procesar cada equipo
    for (const eq of equipos) {
      log(`\n➡️ Procesando ${eq.nombre} (${eq.categoria})`);
      try {
        await driver.executeScript(`datosequipo("${eq.guid}")`);
        await driver.wait(until.elementLocated(By.id("seljor")), 10000);
        const sel = await driver.findElement(By.id("seljor"));
        await sel.sendKeys("Todas");
        await driver.sleep(2000); // espera carga
        const events = await parseAllJornadaTables(driver, eq.nombre);

        if (!events.length) {
          log(`⚠️ No hay partidos para ${eq.nombre}`);
          continue;
        }

        const safeName = `${eq.categoria}_${eq.nombre}`.replace(/\s+/g, "_").replace(/[^\w_]/g, "").toLowerCase();
        writeICS(`imd_${safeName}.ics`, events);
      } catch (err) {
        log(`❌ Error procesando ${eq.nombre}: ${err.message}`);
      }
    }

    log("✅ Todos los calendarios procesados correctamente.");
  } catch (err) {
    log(`❌ ERROR GENERAL: ${err.stack}`);
  } finally {
    await driver.quit();
    log("🧹 Chrome cerrado");
  }
})();
