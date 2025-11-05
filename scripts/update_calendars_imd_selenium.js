// scripts/update_calendars_imd_selenium.js
const fs = require("fs");
const { Builder, By, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

const norm = s => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").toLowerCase().trim();

function parseDateTime(text) {
  const m = text.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [_, d, M, Y, h, min] = m;
  return new Date(`${Y}-${M}-${d}T${h}:${min}:00+01:00`);
}

function parseDdmmyy(ddmmyy) {
  const m = (ddmmyy || "").match(/(\d{2})\/(\d{2})\/(\d{2})/);
  if (!m) return null;
  const [_, d, M, yy] = m;
  const Y = Number(yy) >= 70 ? `19${yy}` : `20${yy}`;
  return new Date(`${Y}-${M}-${d}T00:00:00+01:00`);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
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

function writeICS(filename, events) {
  let ics = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:PUBLISH
PRODID:-//Las Flores//Calendario IMD//ES
`;

  for (const evt of events) {
    if (evt.type === "timed") {
      ics += `BEGIN:VEVENT
SUMMARY:${evt.summary}
LOCATION:${evt.location}
DTSTART:${fmtICSDateTime(evt.start)}
END:VEVENT
`;
    } else if (evt.type === "allday") {
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
  console.log("Cargando calendario IMD (tabla de equipos)…");

  const options = new chrome.Options()
    .addArguments("--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage");
  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();

  try {
    await driver.get("https://imd.sevilla.org/app/jjddmm_resultados/");

    const search = await driver.wait(until.elementLocated(By.id("busqueda")), 15000);
    await search.clear();
    await search.sendKeys("flores");

    await driver.wait(until.elementLocated(By.css("table")), 15000);
    await driver.wait(until.elementsLocated(By.css("table tbody tr")), 15000);

    const rows = await driver.findElements(By.css("table tbody tr"));
    let clicked = false;

    const rows = await driver.findElements(By.css("table.tt tbody tr"));
    let clicked = false;

    for (const row of rows) {
      const cells = await row.findElements(By.css("td.cc"));
      if (cells.length < 3) continue;

      const teamName = norm(await cells[0].getText());
      const category = norm(await cells[2].getText());

      if (teamName.includes("flores") && teamName.includes("morado") &&
          category.includes("cadete") && category.includes("femenino")) {

        console.log(`→ Fila encontrada: ${teamName} (${category})`);
        const link = await cells[0].findElement(By.css("a[onclick^='datosequipo(']"));
        await driver.executeScript("arguments[0].click();", link);
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      console.warn("⚠️ No se encontró la fila 'CD LAS FLORES SEVILLA MORADO' (Cadete Femenino).");
      return [];
    }


    const sel = await driver.wait(until.elementLocated(By.id("seljor")), 15000);
    await driver.executeScript(`
      const s = document.querySelector('#seljor');
      if (s) {
        for (let i = 0; i < s.options.length; i++) {
          if ((s.options[i].textContent || '').toLowerCase().includes('todas')) {
            s.selectedIndex = i;
            s.dispatchEvent(new Event('change', { bubbles: true }));
            break;
          }
        }
      }
    `);
    await driver.sleep(2500);

    const html = await driver.getPageSource();
    const sections = html.split(/<h2[^>]*>[^<]*Jornada/).slice(1);
    const events = [];

    for (const sec of sections) {
      const range = sec.match(/\((\d{2}\/\d{2}\/\d{2})[^)]*?(\d{2}\/\d{2}\/\d{2})\)/);
      let start = null, end = null;
      if (range) {
        start = parseDdmmyy(range[1]);
        end = addDays(parseDdmmyy(range[2]), 1);
      }

      const tableMatch = sec.match(/<table[\s\S]*?<\/table>/i);
      if (!tableMatch) continue;

      const rowsHtml = tableMatch[0].split(/<tr[^>]*>/i).slice(1);
      for (const r of rowsHtml) {
        const cols = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(x =>
          (x[1] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
        );
        if (cols.length < 5) continue;

        const fecha = cols[0] || "";
        const hora = cols[1] || "";
        const local = cols[2] || "";
        const visitante = cols[3] || "";
        const lugar = cols[5] || cols[4] || "Por confirmar";

        const esPartidoFlores =
          (norm(local).includes("flores") || norm(visitante).includes("flores")) &&
          (norm(local).includes("morado") || norm(visitante).includes("morado"));

        if (!esPartidoFlores) continue;

        const dt = parseDateTime(`${fecha} ${hora}`);
        const summary = `${local} vs ${visitante}`;

        if (dt) {
          events.push({ type: "timed", summary, location: lugar, start: dt });
        } else if (start && end) {
          events.push({ type: "allday", summary, location: lugar, start, end });
        }
      }
    }

    console.log(`→ ${events.length} partidos encontrados en IMD.`);
    writeICS("imd.ics", events);
    console.log("✅ Calendario IMD actualizado correctamente.");
    return events;

  } catch (e) {
    console.error("❌ Error en scraping IMD:", e.message);
    return [];
  } finally {
    try { await driver.quit(); } catch {}
  }
}

// ---- ejecución principal ----
(async () => {
  const imdEvents = await loadIMD();
  if (!imdEvents.length) console.warn("⚠️ No se encontraron partidos IMD.");
})();
