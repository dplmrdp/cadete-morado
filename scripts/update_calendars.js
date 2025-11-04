const fs = require("fs");
const fetch = require("node-fetch");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

const TEAM_NAME_FED = "C.D. LAS FLORES SEVILLA MORADO";
const TEAM_NAME_IMD = "CADETE MORADO"; // ya lo tenías definido antes

const FED_URL = "https://favoley.es/es/tournament/1321417/calendar/3652130/all";

// -------- Helpers --------
function normalize(str) {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function writeICS(filename, events) {
  let ics = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:PUBLISH
`;
  events.forEach(evt => {
    if (evt.type === "timed") {
      const dt = evt.date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
      ics += `BEGIN:VEVENT
DTSTART:${dt}
SUMMARY:${evt.summary}
LOCATION:${evt.location}
END:VEVENT
`;
    } else {
      const start = evt.start.toISOString().split("T")[0].replace(/-/g, "");
      const end = evt.end.toISOString().split("T")[0].replace(/-/g, "");
      ics += `BEGIN:VEVENT
DTSTART;VALUE=DATE:${start}
DTEND;VALUE=DATE:${end}
SUMMARY:${evt.summary}
LOCATION:${evt.location}
END:VEVENT
`;
    }
  });
  ics += "END:VCALENDAR";
  fs.writeFileSync(filename, ics);
}

// -------- FEDERADO via Puppeteer Stealth --------
async function loadFederado() {
  console.log("Loading Federado (Stealth)...");
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: "/usr/bin/chromium-browser",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();
  await page.goto(FED_URL, { waitUntil: "networkidle0" });

  // ⬅️ Nueva extracción de estado
  const nextData = await page.evaluate(() => window.__NEXT_DATA__);
  await browser.close();

  if (!nextData || !nextData.props || !nextData.props.pageProps) {
    throw new Error("No se pudo leer __NEXT_DATA__");
  }

  // Localizamos lista de partidos dentro del árbol
  const matches = nextData.props.pageProps?.dehydratedState?.queries
    ?.map(q => q.state?.data)
    ?.flat()
    ?.filter(x => x && typeof x === "object")
    ?.flatMap(obj => obj.matches || [])
    ?.filter(Boolean) || [];

  if (!matches.length) {
    throw new Error("No se encontraron partidos en __NEXT_DATA__");
  }

  const events = [];

  for (const m of matches) {
    const home = normalize(m.homeTeam.name);
    const away = normalize(m.awayTeam.name);
    if (![home, away].includes(normalize(TEAM_NAME_FED))) continue;

    if (m.date && m.time) {
      const dt = new Date(`${m.date}T${m.time}:00+01:00`);
      events.push({
        type: "timed",
        date: dt,
        summary: `${m.homeTeam.shortName} vs ${m.awayTeam.shortName} (FEDERADO)`,
        location: m.facility?.name ?? "Por confirmar"
      });
    } else {
      const base = new Date(m.date ?? new Date());
      const start = new Date(base);
      start.setDate(start.getDate() - ((start.getDay() + 1) % 7)); // viernes
      const end = new Date(start);
      end.setDate(end.getDate() + 2); // domingo

      events.push({
        type: "weekend",
        start,
        end,
        summary: `${m.homeTeam.shortName} vs ${m.awayTeam.shortName} (FEDERADO)`,
        location: m.facility?.name ?? "Por confirmar"
      });
    }
  }

  return events;
}


// -------- TODO: loadIMD stays exactly as already implemented --------
// (no lo toco porque ya funcionaba y no da errores)

async function main() {
  const fed = await loadFederado();
  writeICS("calendarios/federado.ics", fed);

  // tu función existente loadIMD()
  const { loadIMD } = require("./imd.js"); 
  const imd = await loadIMD();
  writeICS("calendarios/imd.ics", imd);

  console.log("✅ Calendarios actualizados");
}

main().catch(err => {
  console.error("ERROR in update script:", err);
  process.exit(1);
});
