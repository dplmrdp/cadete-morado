// scripts/update_calendars_imd_selenium.js
// Versión adaptada: el cuadro de búsqueda autocompleta muestra los equipos directamente

const fs = require("fs");
const { Builder, By, until, Key } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

const IMD_URL = "https://imd.sevilla.org/app/jjddmm_resultados/";
const TEAM_KEY = "morado";
const CAT_KEY = "cadete femenino";

function normalize(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

function fmtICSDateTime(dt) {
  return dt.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}
function fmtICSDate(d) {
  const Y = d.getUTCFullYear();
  const M = String(d.getUTCMonth() + 1).padStart(2, "0");
  const D = String(d.getUTCDate()).padStart(2, "0");
  return `${Y}${M}${D}`;
}
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function parseDateTime(text) {
  const m = (text || "").match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [_, d, M, Y, h, min] = m;
  return new Date(`${Y}-${M}-${d}T${h}:${min}:00+01:00`);
}
function parseDdmmyy(s) {
  const m = (s || "").match(/(\d{2})\/(\d{2})\/(\d{2})/);
  if (!m) return null;
  const [_, d, M, yy] = m;
  const Y = Number(yy) >= 70 ? `19${yy}` : `20${yy}`;
  return new Date(`${Y}-${M}-${d}T00:00:00+01:00`);
}

function writeICS(filename, events) {
  let ics = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:PUBLISH
PRODID:-//Las Flores Morado//Calendario IMD//ES
`;

  for (const evt of events) {
    if (evt.type === "timed") {
      ics += `BEGIN:VEVENT
SUMMARY:${evt.summary}
LOCATION:${evt.location}
DTSTART:${fmtICSDateTime(evt.start)}
END:VEVENT
`;
    } else {
      ics += `BEGIN:VEVENT
SUMMARY:${evt.summary}
LOCATION:${evt.location}
DTSTART;VALUE=DATE:${fmtICSDate(evt.start)}
DTEND;VALUE=DATE:${fmtICSDate(evt.end)}
END:VEVENT
`;
    }
  }

  ics += "END:VCALENDAR\n";
  fs.mkdirSync("calendarios", { recursive: true });
  fs.writeFileSync(`calendarios/${filename}`, ics);
}

async function loadIMD() {
  console.log("Cargando calendario IMD (autocompletado de equipos)...");
  const options = new chrome.Options()
    .addArguments("--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage");
  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();

  try {
    await driver.get(IMD_URL);

    // 1️⃣ Buscar “las flores”
    const search = await driver.wait(until.elementLocated(By.id("busqueda")), 10000);
    await search.clear();
    await search.sendKeys("las flores");
    await driver.sleep(2000);

    // 2️⃣ Esperar cuadro de resultados (sugerencias)
    const suggestions = await driver.wait(
      until.elementsLocated(By.css(".ui-menu-item, .autocomplete-suggestion, li, div.suggestion")),
      10000
    );

    let found = null;
    for (const sug of suggestions) {
      const text = normalize(await sug.getText());
      if (text.includes("flores") && text.includes(TEAM_KEY) && text.includes(CAT_KEY)) {
        found = sug;
        break;
      }
    }

    if (!found) {
      console.warn("⚠️ No se encontró el equipo Cadete Femenino Morado en las sugerencias.");
      await driver.quit();
      return [];
    }

    await found.click();
    await driver.sleep(3000);

    // 3️⃣ Seleccionar “Todas” en el desplegable de jornadas
    const sel = await driver.wait(until.elementLocated(By.id("seljor")), 15000);
    await driver.executeScript(`
      const s = document.querySelector('#seljor');
      if (s) {
        for (let i=0;i<s.options.length;i++) {
          if (s.options[i].textContent.toLowerCase().includes('todas')) {
            s.selectedIndex = i;
            s.dispatchEvent(new Event('change', {bubbles:true}));
          }
        }
      }
    `);
    await driver.sleep(2000);

    // 4️⃣ Extraer las jornadas y partidos
    const html = await driver.getPageSource();
    const sections = html.split(/<h2[^>]*>[^<]*Jornada/).slice(1);
    const events = [];

    for (const sec of sections) {
      const range = sec.match(/\((\d{2}\/\d{2}\/\d{2})[^)]*?(\d{2}\/\d{2}\/\d{2})\)/);
      let weekendStart = null, weekendEnd = null;
      if (range) {
        weekendStart = parseDdmmyy(range[1]);
        weekendEnd = addDays(parseDdmmyy(range[2]), 1);
      }

      const tableMatch = sec.match(/<table[\s\S]*?<\/table>/);
      if (!tableMatch) continue;
      const rows = tableMatch[0].split(/<tr[^>]*>/).slice(1);

      for (const row of rows) {
        const cols = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(
          (m) => m[1].replace(/<[^>]+>/g, " ").trim()
        );
        if (cols.length < 5) continue;

        const [fecha, hora, local, visitante, lugar] = cols;
        if (!normalize(local + visitante).includes("flores")) continue;
        if (!normalize(local + visitante).includes("morado")) continue;

        const lugarTxt = lugar || "Por confirmar";
        const fechaTxt = `${fecha} ${hora}`.trim();
        const dt = parseDateTime(fechaTxt);
        const summary = `${local} vs ${visitante}`;

        if (dt) {
          events.push({ type: "timed", summary, location: lugarTxt, start: dt });
        } else if (weekendStart && weekendEnd) {
          events.push({
            type: "allday",
            summary,
            location: lugarTxt,
            start: weekendStart,
            end: weekendEnd,
          });
        }
      }
    }

    console.log(`→ ${events.length} partidos encontrados en IMD.`);
    return events;
  } catch (e) {
    console.error("❌ Error en scraping IMD:", e.message);
    return [];
  } finally {
    await driver.quit();
  }
}

// MAIN
(async () => {
  const imd = await loadIMD();
  if (imd.length) {
    writeICS("imd.ics", imd);
    console.log(`✅ Calendario IMD actualizado con ${imd.length} partidos.`);
  } else {
    console.warn("⚠️ No se encontraron partidos IMD.");
  }
})();
