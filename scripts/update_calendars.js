/**
 * ACTUALIZACIÓN AUTOMÁTICA CALENDARIOS
 * FLORES MORADO (Federado + IMD)
 */

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const TEAM_NAME = "C.D. LAS FLORES SEVILLA MORADO"; // identificación exacta ✅
const OUTPUT_DIR = "calendarios";

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// --- Helpers ---
function normalize(name) {
  return name.toUpperCase().replace(/\s+/g, " ").trim();
}

function toDate(day, month, year) {
  year = year < 100 ? 2000 + year : year;
  return new Date(year, month - 1, day);
}

function writeICS(filename, events, prodid) {
  let ics = `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:${prodid}\n`;
  for (const ev of events) {
    if (ev.type === "timed") {
      const dt = ev.date;
      const start = dt.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z/, "Z");
      const end = new Date(dt.getTime() + 7200000) // +2h
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d+Z/, "Z");
      ics += `BEGIN:VEVENT\nDTSTART:${start}\nDTEND:${end}\nSUMMARY:${ev.summary}\nLOCATION:${ev.location}\nEND:VEVENT\n`;
    } else if (ev.type === "weekend") {
      const start = ev.start.toISOString().slice(0, 10).replace(/-/g, "");
      const end = new Date(ev.end.getTime() + 86400000)
        .toISOString()
        .slice(0, 10)
        .replace(/-/g, "");
      ics += `BEGIN:VEVENT\nDTSTART;VALUE=DATE:${start}\nDTEND;VALUE=DATE:${end}\nSUMMARY:${ev.summary}\nLOCATION:${ev.location}\nEND:VEVENT\n`;
    }
  }
  ics += "END:VCALENDAR";
  fs.writeFileSync(path.join(OUTPUT_DIR, filename), ics);
}

// --- MAIN ---
(async () => {
  const browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();

  // ---------- FAVOLEY ----------
  await page.goto("https://favoley.es/es/tournament/1321417/calendar/3652130/all", {
    waitUntil: "networkidle2",
  });
  await page.waitForTimeout(1500);

  const fedText = await page.evaluate(() => document.body.innerText);
  const fedEvents = [];

  fedText.split("\n").forEach((line) => {
    if (normalize(line).includes(normalize(TEAM_NAME))) {
      const dateRange = line.match(/(\d{1,2}\/\d{1,2}\/\d{2,4}).*(\d{1,2}\/\d{1,2}\/\d{2,4})/);
      const vsMatch = line.match(/(.+?)\s*(?:-|vs|VS|V|–)\s*(.+)/i);

      if (dateRange && vsMatch) {
        const start = toDate(...dateRange[1].split("/").map(Number));
        const end = toDate(...dateRange[2].split("/").map(Number));

        const home = vsMatch[1].trim();
        const away = vsMatch[2].trim();

        if ([normalize(home), normalize(away)].includes(normalize(TEAM_NAME))) {
          fedEvents.push({
            type: "weekend",
            start,
            end,
            summary: `${home} vs ${away}`.replace(normalize(TEAM_NAME), "FLORES MORADO"),
            location: "Por confirmar",
          });
        }
      }
    }
  });

  // ---------- IMD ----------
  await page.goto("https://imd.sevilla.org/app/jjddmm_resultados/", { waitUntil: "networkidle2" });
  await page.waitForTimeout(1500);

  const imdText = await page.evaluate(() => document.body.innerText);
  const imdEvents = [];

  const pattern = /(\d{1,2}\/\d{1,2}\/\d{4}).*?(\d{1,2}:\d{2}).*?(.+?)\s+-\s+(.+?)\s+(COLEGIO|CD|C\.D\.)/gi;
  let match;
  while ((match = pattern.exec(imdText))) {
    const [_, d, t, home, away] = match;
    if ([normalize(home), normalize(away)].includes(normalize(TEAM_NAME))) {
      const [day, month, year] = d.split("/").map(Number);
      const [h, m] = t.split(":").map(Number);
      imdEvents.push({
        type: "timed",
        date: new Date(year, month - 1, day, h, m),
        summary: `${home} vs ${away}`.replace(normalize(TEAM_NAME), "FLORES MORADO"),
        location: "Por confirmar",
      });
    }
  }

  await browser.close();

  writeICS("federado.ics", fedEvents, "-//FLORES MORADO//FEDERADO//ES");
  writeICS("imd.ics", imdEvents, "-//FLORES MORADO//IMD//ES");

  console.log("✅ Calendarios actualizados.");
})();
