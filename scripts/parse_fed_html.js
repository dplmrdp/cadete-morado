const fs = require("fs");

const TEAM_NEEDLE = "C.D. LAS FLORES SEVILLA";

function normalize(s) {
  return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

function normLower(s) {
  return normalize(s).toLowerCase();
}

// 🧩 Soporta dd/mm/yyyy hh:mm, ISO y solo fecha
function parseDateTime(text) {
  if (!text) return null;

  let m = text.match(/(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})/);
  if (m) {
    const [_, dd, MM, yyyy, HH, mm] = m;
    return new Date(`${yyyy}-${MM}-${dd}T${HH}:${mm}:00+01:00`);
  }

  m = text.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    const [_, yyyy, MM, dd, HH, mm, ss] = m;
    return new Date(`${yyyy}-${MM}-${dd}T${HH}:${mm}:${ss}+01:00`);
  }

  m = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) {
    const [_, dd, MM, yyyy] = m;
    return new Date(`${yyyy}-${MM}-${dd}T00:00:00+01:00`);
  }

  return null;
}

// 🧠 Nuevas funciones para rango de jornada
function parseDdmmyy(ddmmyy) {
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

// --- formato ICS ---
function fmtICSDateTime(dt) {
  if (!(dt instanceof Date) || isNaN(dt)) return "19700101T000000Z";
  return dt.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function fmtICSDate(d) {
  const Y = d.getUTCFullYear();
  const M = String(d.getUTCMonth() + 1).padStart(2, "0");
  const D = String(d.getUTCDate()).padStart(2, "0");
  return `${Y}${M}${D}`;
}

function writeICS(team, category, events) {
  const safeCat = category.toLowerCase().replace(/\s+/g, "_");
  const safeTeam = team.replace(/\s+/g, "_").toLowerCase();
  const filename = `calendarios/federado_${safeCat}_${safeTeam}.ics`;

  let ics = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:PUBLISH
PRODID:-//Las Flores//Calendarios Federado//ES
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
  fs.writeFileSync(filename, ics);
  console.log(`✅ ${filename} (${events.length} eventos)`);
}

function parseFederadoHTML(html, meta) {
  const eventsByTeam = new Map();
  const jornadas = html.split(/<h2[^>]*>[^<]*Jornada/i).slice(1);

  if (!jornadas.length) {
    console.log(`⚠️ No se encontraron jornadas en ${meta.tournamentId}/${meta.groupId}`);
  }

  for (const jornada of jornadas) {
    // 🟢 Detectar rango de jornada (ej: 17/10/25 – 19/10/25)
    let weekendStart = null, weekendEnd = null;
const range = jornada.match(/\((\d{2}\/\d{2}\/(?:\d{2}|\d{4}))\D+(\d{2}\/\d{2}\/(?:\d{2}|\d{4}))\)/);

if (range) {
  weekendStart = parseDdmmyy(range[1]);
  weekendEnd = parseDdmmyy(range[2]);
  // Si por alguna razón no se detecta correctamente el año, corregimos
  if (!weekendStart || isNaN(weekendStart)) weekendStart = new Date("1970-01-01");
  if (!weekendEnd || isNaN(weekendEnd)) weekendEnd = addDays(weekendStart, 2);
} else {
  console.log("⚠️ No se detectó rango de jornada en:", jornada.slice(0, 80));
}

    const tableMatch = jornada.match(/<table[\s\S]*?<\/table>/);
    if (!tableMatch) continue;
    const rows = tableMatch[0].split(/<tr[^>]*>/).slice(1);

    for (const row of rows) {
      try {
        const equipoTd = row.match(/<td class="colstyle-equipo">([\s\S]*?)<\/td>/);
        if (!equipoTd) continue;

        const equipos = [...equipoTd[1].matchAll(/<span class="ellipsis"[^>]*>(.*?)<\/span>/g)]
          .map((m) => normalize(m[1]))
          .filter((t) => t);
        if (equipos.length < 2) continue;
        const [teamA, teamB] = equipos;

        const fechaTd = row.match(/<td class="colstyle-fecha">([\s\S]*?)<\/td>/);
        const fechaHtml = fechaTd ? fechaTd[1] : "";
        const date = parseDateTime(fechaHtml);
        const lugarM = fechaHtml.match(/<span class="ellipsis"[^>]*>(.*?)<\/span>/);
        const lugar = lugarM ? normalize(lugarM[1]) : "Por confirmar";

        const localN = normLower(teamA);
        const visitN = normLower(teamB);
        const involve = localN.includes(normLower(TEAM_NEEDLE)) || visitN.includes(normLower(TEAM_NEEDLE));
        if (!involve) continue;

        const equiposInvolucrados = [];
        if (localN.includes(normLower(TEAM_NEEDLE))) equiposInvolucrados.push(teamA);
        if (visitN.includes(normLower(TEAM_NEEDLE))) equiposInvolucrados.push(teamB);

        let evt;
       if (date instanceof Date && !isNaN(date)) {
  evt = {
    type: "timed",
    start: date,
    summary: `${teamA} vs ${teamB}`,
    location: lugar,
  };
} else if (weekendStart instanceof Date && weekendEnd instanceof Date) {
  evt = {
    type: "allday",
    start: weekendStart,
    end: addDays(weekendEnd, 1),
    summary: `${teamA} vs ${teamB}`,
    location: lugar,
  };
  console.log(`📅 Sin hora: usando jornada ${fmtICSDate(weekendStart)}–${fmtICSDate(weekendEnd)} para ${teamA} vs ${teamB}`);
} else {
  console.log(`⚠️ Sin fecha ni rango válido para ${teamA} vs ${teamB}`);
  continue;
}

        for (const t of equiposInvolucrados) {
          if (!eventsByTeam.has(t)) eventsByTeam.set(t, []);
          eventsByTeam.get(t).push(evt);
        }
      } catch (err) {
        console.log("⚠️ Error procesando fila:", err);
      }
    }
  }

  for (const [team, evs] of eventsByTeam.entries()) {
  evs.sort((a, b) => a.start - b.start);
  writeICS(team, meta.category || "sin_categoria", evs);
}


  console.log(`📦 Generados ${eventsByTeam.size} calendarios para t=${meta.tournamentId} g=${meta.groupId}`);
}

module.exports = { parseFederadoHTML };
