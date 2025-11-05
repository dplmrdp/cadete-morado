const fs = require("fs");
const https = require("https");

// Cargador HTML mínimo (sin cheerio)
function extractText(html, regex) {
  const matches = [];
  let m;
  while ((m = regex.exec(html)) !== null) matches.push(m[1]);
  return matches;
}

const TEAM_NAME_FED = "C.D. LAS FLORES SEVILLA MORADO";
const FED_URL = "https://favoley.es/es/tournament/1321417/calendar/3652130/all";

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

(async () => {
  console.log("Cargando calendario Federado desde HTML...");
  const html = await fetchHtml(FED_URL);

  // Filtramos solo partidos del equipo
  const rows = html.split("<tr");
  const eventos = [];

  for (const row of rows) {
    if (!row.includes(TEAM_NAME_FED)) continue;

    const equipos = extractText(row, /data-original-title="([^"]+)"/g);
    const fechaTxt = (row.match(/(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2})/) || [])[1];
    const lugar = (row.match(/data-original-title="([^"]+)"[^>]*><\/span>\s*<\/span>\s*<\/td>/) || [])[1] || "Por confirmar";

    if (fechaTxt) {
      const [d, m, y, h, min] = fechaTxt.match(/\d+/g);
      const date = new Date(`${y}-${m}-${d}T${h}:${min}:00+01:00`);
      eventos.push({
        summary: `${equipos.join(" vs ")} (FEDERADO)`,
        date,
        location: lugar,
      });
    }
  }

  // Crear ICS
  let ics = `BEGIN:VCALENDAR\nVERSION:2.0\nCALSCALE:GREGORIAN\nMETHOD:PUBLISH\n`;
  for (const evt of eventos) {
    const dt = evt.date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    ics += `BEGIN:VEVENT\nDTSTART:${dt}\nSUMMARY:${evt.summary}\nLOCATION:${evt.location}\nEND:VEVENT\n`;
  }
  ics += "END:VCALENDAR\n";
  fs.mkdirSync("calendarios", { recursive: true });
  fs.writeFileSync("calendarios/federado.ics", ics);

  console.log(`✅ ${eventos.length} partidos del ${TEAM_NAME_FED}`);
})();
