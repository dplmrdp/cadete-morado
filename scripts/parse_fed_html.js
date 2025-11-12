const fs = require("fs");

const TEAM_NEEDLE = "C.D. LAS FLORES SEVILLA";

function normalize(s) {
  return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}
function normLower(s) {
  return normalize(s).toLowerCase();
function parseDateTime(text) {
  if (!text) return null;

  // 1️⃣ formato dd/mm/yyyy hh:mm
  let m = text.match(/(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})/);
  if (m) {
    const [_, dd, MM, yyyy, HH, mm] = m;
    return new Date(`${yyyy}-${MM}-${dd}T${HH}:${mm}:00+01:00`);
  }

  // 2️⃣ formato ISO dentro de data-sort="2025-10-18 08:00:00"
  m = text.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    const [_, yyyy, MM, dd, HH, mm, ss] = m;
    return new Date(`${yyyy}-${MM}-${dd}T${HH}:${mm}:${ss}+01:00`);
  }

  // 3️⃣ fallback: solo dd/mm/yyyy
  m = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) {
    const [_, dd, MM, yyyy] = m;
    return new Date(`${yyyy}-${MM}-${dd}T00:00:00+01:00`);
  }

  return null;
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
function writeICS(team, events) {
  const filename = `calendarios/federado_${team.replace(/\s+/g, "_").toLowerCase()}.ics`;
  let ics = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:PUBLISH
PRODID:-//Las Flores//Calendarios Federado//ES
`;
  for (const evt of events) {
    ics += `BEGIN:VEVENT
SUMMARY:${evt.summary}
LOCATION:${evt.location}
DTSTART:${fmtICSDateTime(evt.start)}
END:VEVENT
`;
  }
  ics += "END:VCALENDAR\n";
  fs.mkdirSync("calendarios", { recursive: true });
  fs.writeFileSync(filename, ics);
  console.log(`✅ ${filename} (${events.length} eventos)`);
}

function parseFederadoHTML(html, meta) {
  const eventsByTeam = new Map();
  const jornadas = html.split(/<h2[^>]*>[^<]*Jornada/i).slice(1);

  for (const jornada of jornadas) {
    const tableMatch = jornada.match(/<table[\s\S]*?<\/table>/);
    if (!tableMatch) continue;
    const rows = tableMatch[0].split(/<tr[^>]*>/).slice(1);

    for (const row of rows) {
      const equipoTd = row.match(/<td class="colstyle-equipo">([\s\S]*?)<\/td>/);
      if (!equipoTd) continue;

      const equipos = [...equipoTd[1].matchAll(/<span class="ellipsis"[^>]*>(.*?)<\/span>/g)].map((m) => normalize(m[1]));
      if (equipos.length < 2) continue;
      const [teamA, teamB] = equipos;

      const fechaTd = row.match(/<td class="colstyle-fecha">([\s\S]*?)<\/td>/);
      if (!fechaTd) continue;
      const date = parseDateTime(fechaTd[1]);
      const lugarM = fechaTd[1].match(/<span class="ellipsis"[^>]*>(.*?)<\/span>/);
      const lugar = lugarM ? normalize(lugarM[1]) : "Por confirmar";

      const localN = normLower(teamA);
      const visitN = normLower(teamB);
      const involve = localN.includes(normLower(TEAM_NEEDLE)) || visitN.includes(normLower(TEAM_NEEDLE));
      if (!involve) continue;

      const equiposInvolucrados = [];
      if (localN.includes(normLower(TEAM_NEEDLE))) equiposInvolucrados.push(teamA);
      if (visitN.includes(normLower(TEAM_NEEDLE))) equiposInvolucrados.push(teamB);

      const evt = { summary: `${teamA} vs ${teamB}`, location: lugar, start: date };
      for (const t of equiposInvolucrados) {
        if (!eventsByTeam.has(t)) eventsByTeam.set(t, []);
        eventsByTeam.get(t).push(evt);
      }
    }
  }

  for (const [team, evs] of eventsByTeam.entries()) {
    evs.sort((a, b) => a.start - b.start);
    writeICS(team, evs);
  }
  console.log(`📦 Generados ${eventsByTeam.size} calendarios para t=${meta.tournamentId} g=${meta.groupId}`);
}

module.exports = { parseFederadoHTML };
