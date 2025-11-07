// scripts/update_calendars_imd_selenium.js
// Genera calendarios IMD (Cadete Femenino Morado) en calendarios/imd_cadete_morado.ics
// Requiere: selenium-webdriver, Chrome/Chromedriver presentes (Actions ya los instala)

const fs = require("fs");
const path = require("path");
const os = require("os");
const { Builder, By, Key, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

// ----------------------------
// Config general
// ----------------------------
const IMD_URL = "https://imd.sevilla.org/app/jjddmm_resultados/";
const TEAM_NAME_NEEDLE = "las flores"; // texto a buscar en input
const TEAM_EXACT = "CD LAS FLORES SEVILLA MORADO";
const TEAM_CATEGORY = "CADETE FEMENINO";

const OUTPUT_DIR = path.join("calendarios");
const DEBUG_DIR = path.join(OUTPUT_DIR, "debug");
const LOG_DIR = path.join(OUTPUT_DIR, "logs");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(DEBUG_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = path.join(LOG_DIR, `imd_${RUN_STAMP}.log`);

// ----------------------------
// Logger
// ----------------------------
function log(line) {
  const msg = typeof line === "string" ? line : JSON.stringify(line);
  console.log(msg);
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) {}
}

function onError(err, context = "UNSPECIFIED") {
  log(`❌ ERROR (${context}): ${err && err.stack ? err.stack : err}`);
}

// ----------------------------
// Utils de texto / fechas
// ----------------------------
function normalize(s) {
  return (s || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function parseDateDDMMYYYY(s) {
  const m = (s || "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const [_, dd, MM, yyyy] = m;
  return { yyyy, MM, dd };
}
function parseTimeHHMM(s) {
  const m = (s || "").match(/(\d{2}):(\d{2})/);
  if (!m) return null;
  const [_, HH, mm] = m;
  return { HH, mm };
}

// IMD (nov–mar) está en CET (UTC+01); los ejemplos que nos pasaste están en meses de invierno.
// Si faltase la hora, creamos all-day (00:00 local con VALUE=DATE).
const TZ_OFFSET = "+01:00";

function toDateWithOffset({ yyyy, MM, dd }, timeOrNull) {
  if (!timeOrNull) {
    // all-day (lo trataremos como VALUE=DATE)
    return { kind: "date", date: new Date(`${yyyy}-${MM}-${dd}T00:00:00${TZ_OFFSET}`) };
  }
  const { HH, mm } = timeOrNull;
  return { kind: "datetime", date: new Date(`${yyyy}-${MM}-${dd}T${HH}:${mm}:00${TZ_OFFSET}`) };
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

// ----------------------------
// ICS helpers (igual filosofía que federado)
// ----------------------------
function fmtICSDateTime(dt) {
  // UTC en formato ICS
  return dt.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}
function fmtICSDate(d) {
  // YYYYMMDD (UTC)
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
PRODID:-//Las Flores//Calendario IMD Cadete Morado//ES
`;

  for (const evt of events) {
    if (evt.type === "timed") {
      ics += `BEGIN:VEVENT
SUMMARY:${evt.summary}
LOCATION:${evt.location}
DTSTART:${fmtICSDateTime(evt.start)}
DESCRIPTION:${evt.description || ""}
END:VEVENT
`;
    } else if (evt.type === "allday") {
      // Para all-day: DTSTART;VALUE=DATE y DTEND no-inclusivo (día+1)
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
  const outPath = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(outPath, ics);
  log(`✅ ICS escrito: ${outPath} (${events.length} eventos)`);
}

// ----------------------------
// Parsing de tablas de jornadas
// Estructura por fila: [Fecha, Hora, Local, Visitante, Resultado, Lugar, Obs Encuentro, Obs Resultado]
// ----------------------------
function extractTextFromCell(cellEl) {
  return cellEl.getText().then((t) => (t || "").replace(/\u00A0/g, " ").trim());
}

async function parseAllJornadaTables(driver) {
  const allEvents = [];

  // Las tablas de jornadas viven dentro de #tab1; comparten class="tt".
  const container = await driver.findElement(By.id("tab1"));
  const tables = await container.findElements(By.css("table.tt"));

  log(`📑 Encontradas ${tables.length} tablas .tt en #tab1`);
  let jornadaIdx = 0;

  for (const table of tables) {
    jornadaIdx += 1;
    // Detectar si es tabla de "Jornada Nº. X": primera fila tiene colspan y el texto incluye "Jornada Nº."
    const headerCells = await table.findElements(By.css("tbody > tr:first-child td"));
    if (!headerCells.length) continue;

    const headerText = (await headerCells[0].getText()).trim();
    const isJornadaTable = /Jornada\s+N[ºo]\./i.test(headerText);
    if (!isJornadaTable) {
      continue; // saltar tablas que no son de jornada (p. ej., "Equipo Seleccionado")
    }

    // Filas de datos: saltar la fila de cabecera (la que tiene los títulos de columnas)
    const rows = await table.findElements(By.css("tbody > tr"));
    if (rows.length <= 2) continue; // 1 header + 1 títulos => sin datos

    // La segunda fila suele ser cabecera de columnas; empezamos en i=2
    for (let i = 2; i < rows.length; i++) {
      const cols = await rows[i].findElements(By.css("td"));
      if (cols.length < 8) continue;

      const [fechaEl, horaEl, localEl, visitanteEl, resultEl, lugarEl, obsEncuentroEl, obsResultadoEl] = cols;

      const [fecha, hora, local, visitante, resultado, lugar, obsEncuentro, obsResultado] = await Promise.all([
        extractTextFromCell(fechaEl),
        extractTextFromCell(horaEl),
        extractTextFromCell(localEl),
        extractTextFromCell(visitanteEl),
        extractTextFromCell(resultEl),
        extractTextFromCell(lugarEl),
        extractTextFromCell(obsEncuentroEl),
        extractTextFromCell(obsResultadoEl),
      ]);

      // Filtrado por equipo, usando el color de fondo como pista adicional cuando sea posible:
      // - Nuestro equipo aparece con fondo distinto (en tus ejemplos, un azul/gris: #bfd0d9).
      // - Pero no dependemos solo del color; validamos por texto exacto del equipo y categoría ya seleccionada.
      const localN = normalize(local);
      const visitN = normalize(visitante);
      const teamN = normalize(TEAM_EXACT);

      const involvesTeam = localN === teamN || visitN === teamN;
      if (!involvesTeam) continue;

      // Parse fecha / hora
      const d = parseDateDDMMYYYY(fecha);
      const t = parseTimeHHMM(hora);
      if (!d) {
        log(`⚠️ Fila ignorada por fecha inválida: "${fecha}"`);
        continue;
      }
      const when = toDateWithOffset(d, t);

      // Título y ubicación
      const home = localN === teamN;
      const rival = home ? visitante : local;
      const summary = `${TEAM_EXACT} vs ${rival} (IMD)${home ? "" : ""}`;
      const descriptionParts = [];
      if (resultado && resultado !== "-") descriptionParts.push(`Resultado: ${resultado}`);
      if (obsEncuentro && obsEncuentro !== "-") descriptionParts.push(`Obs. Encuentro: ${obsEncuentro}`);
      if (obsResultado && obsResultado !== "-") descriptionParts.push(`Obs. Resultado: ${obsResultado}`);
      const description = descriptionParts.join(" | ");

      if (when.kind === "datetime") {
        allEvents.push({
          type: "timed",
          summary,
          location: lugar || "Por confirmar",
          start: when.date,
          description,
        });
      } else {
        // all-day: crear rango de 1 día
        allEvents.push({
          type: "allday",
          summary,
          location: lugar || "Por confirmar",
          start: when.date,
          end: addDays(when.date, 1),
          description,
        });
      }
    }
  }

  return allEvents;
}

// ----------------------------
// Búsqueda del equipo y carga de calendario
// ----------------------------
async function findTeamGuidFromResultsHTML(pageHTML) {
  // Buscamos filas que contengan: nombre "CD LAS FLORES SEVILLA MORADO" y categoría "CADETE FEMENINO"
  // Con onclick="datosequipo('GUID')"
  // Toleramos espacios/nbsp y acentos.
  const reRow =
    /<tr>[\s\S]*?onclick="datosequipo\('([A-F0-9-]+)'\)"[\s\S]*?>\s*CD\s+LAS\s+FLORES\s+SEVILLA\s+MORADO\s*<\/a>[\s\S]*?<\/td>[\s\S]*?onclick="datosequipo\('[^']+'\)"[\s\S]*?>\s*VOLEIBOL[\s\S]*?<\/td>[\s\S]*?onclick="datosequipo\('[^']+'\)"[\s\S]*?>\s*CADETE\s+FEMENINO/gi;

  const m = reRow.exec(pageHTML);
  if (m && m[1]) return m[1];

  // Alternativa: capturar varias y luego filtrar
  const all = [...pageHTML.matchAll(/onclick="datosequipo\('([A-F0-9-]+)'\)".*?<\/a>/gi)].map((x) => x[1]);
  return all.length ? all[0] : null;
}

// ----------------------------
// Main
// ----------------------------
(async () => {
  log("Cargando calendario IMD (Cadete Femenino Morado)…");

  // Chrome headless con user-data-dir único (evita "already in use")
  const tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-imd-"));
  const options = new chrome.Options()
    .addArguments("--headless=new")
    .addArguments("--disable-gpu")
    .addArguments("--no-sandbox")
    .addArguments("--disable-dev-shm-usage")
    .addArguments(`--user-data-dir=${tmpUserDir}`);

  const builder = new Builder().forBrowser("chrome").setChromeOptions(options);
  let driver;

  try {
    driver = await builder.build();
    log("✅ Chrome iniciado");

    await driver.get(IMD_URL);
    log(`🌐 Página abierta: ${IMD_URL}`);

    // Buscar input de equipo
    const input = await driver.wait(until.elementLocated(By.id("busqueda")), 15000);
    await driver.wait(until.elementIsVisible(input), 5000);
    log("🔎 Input #busqueda localizado");

    // Escribir y lanzar búsqueda (Enter)
    await input.clear();
    await input.sendKeys(TEAM_NAME_NEEDLE, Key.ENTER);
    log(`⌨️  Texto '${TEAM_NAME_NEEDLE}' introducido + Enter`);

    // Esperar a que aparezca la tabla de resultados (class tt) bajo #tab1
    const tab1 = await driver.wait(until.elementLocated(By.id("tab1")), 15000);
    await driver.wait(until.elementIsVisible(tab1), 5000);

    // Espera a que una fila del tipo resultados de equipos exista (el título "Nº.Equipos: ...")
    await driver.wait(
      until.elementLocated(By.xpath("//table[contains(@class,'tt')]//td[contains(.,'Nº.Equipos')]")),
      20000
    );

    const resultsTable = await tab1.findElement(By.css("table.tt"));
    // Contar filas
    const rows = await resultsTable.findElements(By.css("tbody > tr"));
    log(`📋 Tabla de equipos detectada con ${rows.length} filas (incluye cabeceras).`);

   // --- 🔍 Buscar el equipo "CD LAS FLORES SEVILLA MORADO (Cadete Femenino)" ---
let equipoId = null;
let filasTexto = [];

for (const row of await resultsTable.findElements(By.css("tr"))) {
  const celdas = await row.findElements(By.css("td"));
  if (celdas.length < 3) continue; // omitir cabecera u otras filas

  const nombre = (await celdas[0].getText()).trim().toUpperCase();
  const categoria = (await celdas[2].getText()).trim().toUpperCase();
  filasTexto.push(`${nombre} | ${categoria}`);

  // 🟢 Coincidencia estricta: solo "CD LAS FLORES SEVILLA MORADO" en "CADETE FEMENINO"
  if (
    nombre.includes("CD LAS FLORES SEVILLA MORADO") &&
    categoria.includes("CADETE FEMENINO")
  ) {
    const enlace = await celdas[0].findElement(By.css("a"));
   const onclick = await enlace.getAttribute("onclick");
if (onclick) {
  const match = onclick.match(/datosequipo\('(.+?)'\)/);
  if (match) equipoId = match[1];
}
    log(`✅ Fila encontrada: ${nombre} (${categoria})`);
    break;
  }
}

// --- 📋 Si no encuentra el equipo, muestra información de depuración ---
if (!equipoId) {
  log(`⚠️ No se encontró el equipo "CD LAS FLORES SEVILLA MORADO" (CADETE FEMENINO).`);
  log("Filas analizadas:");
  for (const linea of filasTexto) log(" • " + linea);

  // Guardar copia HTML de la tabla para depurar
  const tablaHtml = await resultsTable.getAttribute("outerHTML");
  await fs.promises.writeFile(path.join(DEBUG_DIR, "listado_equipos.html"), tablaHtml);
  throw new Error("Equipo no encontrado en la tabla de IMD");
}

log(`✅ GUID del equipo seleccionado: ${equipoId}`);

// --- Ejecutar datosequipo() para cargar el calendario ---
await driver.executeScript(`datosequipo("${equipoId}")`);
log("▶️ Ejecutando datosequipo() directamente...");

    // Esperar a que aparezca el selector de jornadas
    const selJor = await driver.wait(until.elementLocated(By.id("seljor")), 15000);
    await driver.wait(until.elementIsVisible(selJor), 10000);
    log("📅 Desplegable de jornadas localizado");

    // Seleccionar "Todas"
    await selJor.sendKeys("Todas");
    log("📊 Seleccionada opción 'Todas'");

    // Esperamos a que carguen todas las tablas de jornadas (múltiples tables.tt con encabezado "Jornada Nº.")
    await driver.wait(async () => {
      const t1 = await driver.findElement(By.id("tab1"));
      const tables = await t1.findElements(By.css("table.tt"));
      let countJ = 0;
      for (const tb of tables) {
        const headerCells = await tb.findElements(By.css("tbody > tr:first-child td"));
        if (!headerCells.length) continue;
        const hText = (await headerCells[0].getText()).trim();
        if (/Jornada\s+N[ºo]\./i.test(hText)) countJ++;
      }
      // Con los datos que nos has pasado, deberían ser varias (hasta 14)
      return countJ >= 1;
    }, 20000);

    // Snapshot de depuración
    const pageHTML = await driver.getPageSource();
    fs.writeFileSync(path.join(DEBUG_DIR, `imd_calendar_${RUN_STAMP}.html`), pageHTML);
    const screenshot = await driver.takeScreenshot();
    fs.writeFileSync(path.join(DEBUG_DIR, `imd_calendar_${RUN_STAMP}.png`), screenshot, "base64");
    log(`🧩 Snapshots guardados en ${DEBUG_DIR}`);

    // Parseo de todas las jornadas
    const events = await parseAllJornadaTables(driver);
    log(`📦 Total partidos detectados (involucran '${TEAM_EXACT}'): ${events.length}`);

    if (!events.length) {
      log("⚠️ No se han detectado partidos. Revisa el HTML snapshot para ajustar selectores.");
      return;
    }

    // Escritura ICS
    writeICS("imd_cadete_morado.ics", events);
    log("✅ Proceso IMD completado con éxito.");

  } catch (err) {
    onError(err, "MAIN");
  } finally {
    // Cerrar driver y limpiar temporal
    try {
      if (driver) await driver.quit();
      log("🧹 Chrome cerrado");
    } catch (_) {}
  }
})();
