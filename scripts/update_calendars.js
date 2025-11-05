const fs = require("fs");
const cheerio = require("cheerio");
const https = require("https");

const fetch = (url) =>
  new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ text: () => Promise.resolve(data) }));
    }).on("error", reject);
  });


const TEAM_NAME_FED = "C.D. LAS FLORES SEVILLA MORADO";
const FED_URL = "https://favoley.es/es/tournament/1321417/calendar/3652130/all";

function normalize(str) {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function parseDate(text) {
  // Ejemplo: "Sáb, 18/10/2025 10:00 GMT+1"
  const match = text.match(/(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})/);
  if (!match) return null;
  const [_, d, m, y, h, min] = match;
  return new Date(`${y}-${m}-${d}T${h}:${min}:00+01:00`);
}

function writeICS(filename, events) {
  let ics = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:PUBLISH
`;
  for (const evt of events) {
    if (evt.start && evt.end) {
      const start = evt.start.toISOString().split("T")[0].replace(/-/g, "");
      const end = evt.end.toISOString().split("T")[0].replace(/-/g, "");
      ics += `BEGIN:VEVENT
DTSTART;VALUE=DATE:${start}
DTEND;VALUE=DATE:${end}
SUMMARY:${evt.summary}
LOCATION:${evt.location}
END:VEVENT
`;
    } else {
      const dt = evt.date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
      ics += `BEGIN:VEVENT
DTSTART:${dt}
SUMMARY:${evt.summary}
LOCATION:${evt.location}
END:VEVENT
`;
    }
  }
  ics += "END:VCALENDAR";
  fs.writeFileSync(filename, ics);
}

async function loadFederado() {
  console.log("Cargando calendario Federado desde HTML...");
  const res = await fetch(FED_URL);
  const html = await res.text();
  const $ = cheerio.load(html);

  const events = [];

  $("tr").each((_, tr) => {
    const equipos = $(tr).find(".colstyle-equipo span.ellipsis").map((i, el) => $(el).text().trim()).get();
    if (!equipos.some(e => normalize(e) === normalize(TEAM_NAME_FED))) return;

    const fechaTxt = $(tr).find(".colstyle-fecha span").first().text().trim();
    const lugar = $(tr).find(".colstyle-fecha .ellipsis").attr("data-original-title") || "Por confirmar";
    const date = parseDate(fechaTxt);

    if (date) {
      events.push({
        date,
        summary: `${equipos[0]} vs ${equipos[1]} (FEDERADO)`,
        location: lugar
      });
    } else {
      // Sin fecha/hora exacta → evento de fin de semana
      const base = new Date();
      const start = new Date(base);
      start.setDate(start.getDate() - ((start.getDay() + 1) % 7)); // viernes
      const end = new Date(start);
      end.setDate(end.getDate() + 2);
      events.push({
        start,
        end,
        summary: `${equipos[0]} vs ${equipos[1]} (FEDERADO)`,
        location: lugar
      });
    }
  });

  console.log(`→ ${events.length} partidos encontrados del ${TEAM_NAME_FED}`);
  return events;
}

// ---- Aquí reutilizas tu función existente loadIMD() ----
// (si ya está en otro archivo, impórtala; si no, podemos integrarla igual)
async function loadIMD() {
  // De momento omitimos para no duplicar
  return [];
}

async function main() {
  const fed = await loadFederado();
  writeICS("calendarios/federado.ics", fed);

  const imd = await loadIMD();
  writeICS("calendarios/imd.ics", imd);

  console.log("✅ Calendarios actualizados");
}

main().catch(err => {
  console.error("ERROR:", err);
  process.exit(1);
});
