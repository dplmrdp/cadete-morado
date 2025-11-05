const fs = require("fs");
const https = require("https");

const TEAM_NAME_FED = "C.D. LAS FLORES SEVILLA MORADO";
const FED_URL = "https://favoley.es/es/tournament/1321417/calendar/3652130/all";

// --------- utilidades básicas ---------
function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

function normalize(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

function parseDateTime(text) {
  const match = text.match(/(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})/);
  if (!match) return null;
  const [_, d, M, Y, h, min] = match; // cambiamos 'm' por 'min' para evitar conflicto
  return new Date(`${Y}-${M}-${d}T${h}:${min}:00+01:00`);
}

function parseDdmmyy(ddmmyy) {
  // dd/mm/yy -> Date (a las 00:00 local)
  const m = (ddmmyy || "").match(/(\d{2})\/(\d{2})\/(\d{2})/);
  if (!m) return null;
  const [_, d, M, yy] = m;
  const Y = Number(yy) >= 70 ? `19${yy}` : `20${yy}`;
  return new Date(`${Y}-${M}-${d}T00:00:00+01:00`);
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function fmtICSDateTime(dt) {
  // UTC en formato ICS
  return dt.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function fmtICSDate(d) {
  // YYYYMMDD
  const Y = d.getUTCFullYear();
  const M = String(d.getUTCMonth() + 1).padStart(2, "0");
  const D = String(d.getUTCDate()).padStart(2, "0");
  return `${Y}${M}${D`;
}

function writeICS(filename, events) {
  let ics = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:PUBLISH
PRODID:-//Flores Morado//Calendario Federado//ES
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
      // En iCalendar, DTEND es no-inclusivo → ponemos lunes para cubrir vie-dom completos
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

// --------- parser específico del HTML de FAVoley ---------
//
// Estructura que nos diste:
// <h2 ...>Jornada N <span ...>(dd/mm/yy&nbsp;&ndash;&nbsp;dd/mm/yy)</span></h2>
// ... <table> ... <tr> con:
//   <td class="colstyle-equipo"> ... <span class="ellipsis" title="Equipo A"> ... </span> <span class="ellipsis" title="Equipo B"> ... </span>
//   <td class="colstyle-fecha"><span ...>Sáb, 18/10/2025 10:00 GMT+1 <span class="ellipsis" title="LUGAR">LUGAR</span></span>
// En jornadas sin hora: el <td class="colstyle-fecha"> está vacío o con data-sort 9999-99-99 ...

async function loadFederado() {
  console.log("Cargando calendario Federado (todas las jornadas)...");
  const html = await fetchHtml(FED_URL);

  // Separar por secciones de jornada usando <h2 ...>Jornada ...
  const sections = html.split(/<h2[^>]*>[^<]*Jornada/).slice(1); // descartamos lo anterior a la 1ª jornada

  const events = [];

  for (const sec of sections) {
    // Rango de la jornada (para eventos sin hora)
    // Busca "(dd/mm/yy&nbsp;&ndash;&nbsp;dd/mm/yy)"
    const range = sec.match(/\((\d{2}\/\d{2}\/\d{2})[^)]*?(\d{2}\/\d{2}\/\d{2})\)/);
    let weekendStart = null, weekendEnd = null;
    if (range) {
      const start = parseDdmmyy(range[1]); // viernes
      const end = parseDdmmyy(range[2]);   // domingo
      if (start && end) {
        // Para iCal all-day, DTEND es no inclusivo: sumamos 1 día a domingo → lunes
        weekendStart = start;
        weekendEnd = addDays(end, 1);
      }
    }

    // Extraer la primera <table ...> ... </table> dentro de esta jornada
    const tableMatch = sec.match(/<table[\s\S]*?<\/table>/);
    if (!tableMatch) continue;
    const tableHtml = tableMatch[0];

    // Partir por filas
    const rows = tableHtml.split(/<tr[^>]*>/).slice(1);

    for (const row of rows) {
      // Equipos: títulos dentro de colstyle-equipo
      const equipoTdMatch = row.match(/<td class="colstyle-equipo">([\s\S]*?)<\/td>/);
      if (!equipoTdMatch) continue;
      const equipoTd = equipoTdMatch[1];

      const teams = [...equipoTd.matchAll(/<span class="ellipsis" title="([^"]+)">/g)].map(m => m[1].trim());
      if (teams.length < 2) continue;

      const [teamA, teamB] = teams;
      const isMorado = normalize(teamA) === normalize(TEAM_NAME_FED) || normalize(teamB) === normalize(TEAM_NAME_FED);
      if (!isMorado) continue;

      // Fecha / lugar: dentro de colstyle-fecha
      const fechaTdMatch = row.match(/<td class="colstyle-fecha">([\s\S]*?)<\/td>/);
      const fechaTd = fechaTdMatch ? fechaTdMatch[1] : "";

      const date = parseDateTime(fechaTd);
      const lugarMatch = fechaTd.match(/<span class="ellipsis" title="([^"]+)">/);
      const lugar = (lugarMatch ? lugarMatch[1] : "Por confirmar").trim();

      // Construir evento
      const summary = `${teamA} vs ${teamB} (FEDERADO)`;

      if (date) {
        events.push({
          type: "timed",
          summary,
          location: lugar,
          start: date
        });
      } else if (weekendStart && weekendEnd) {
        events.push({
          type: "allday",
          summary,
          location: lugar,
          start: weekendStart,
          end: weekendEnd
        });
      } else {
        // Si no tenemos rango (muy raro), lo ignoramos para evitar basura
        continue;
      }
    }
  }

  console.log(`→ ${events.length} partidos encontrados del ${TEAM_NAME_FED}`);
  return events;
}

// --------- main ---------
(async () => {
  try {
    const fed = await loadFederado();

    if (!fed.length) {
      console.warn("⚠️ No se encontraron partidos del equipo en Federado.");
    } else {
      writeICS("federado.ics", fed);
      console.log(`✅ Calendario federado actualizado con ${fed.length} partidos.`);
    }

    // Si quieres, aquí integraríamos también IMD y la fusión en un único .ics

  } catch (err) {
    console.error("ERROR:", err);
    process.exit(1);
  }
})();
