// scripts/update_calendars.js
import * as cheerio from "cheerio";
import fs from "fs";
import fetch from "node-fetch";

const URL = "https://favoley.es/es/tournament/1321417/calendar/3652130";

// Descargar HTML del calendario
async function fetchCalendar() {
  console.log("Descargando calendario...");
  const res = await fetch(URL);
  const html = await res.text();
  return html;
}

// Convertir "Sáb, 18/10/2025 10:00 GMT+1 ..." → objeto Date
function parseDateTime(text) {
  const regex = /(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})/;
  const match = text.match(regex);
  if (!match) return null;
  const [, d, M, Y, h, m] = match;
  return new Date(`${Y}-${M}-${d}T${h}:${m}:00+01:00`);
}

async function main() {
  const html = await fetchCalendar();
  const $ = cheerio.load(html);
  const partidos = [];

  $(".box-info.full.bottom-borderless").each((_, box) => {
    // --- Extraer rango de fechas de la jornada ---
    const jornadaTitulo = $(box).find("h2").text().trim();
    let jornadaInicio = null;
    const matchFechas = jornadaTitulo.match(
      /\((\d{2})\/(\d{2})\/(\d{2})\s*–\s*(\d{2})\/(\d{2})\/(\d{2})\)/
    );
    if (matchFechas) {
      const [, d1, m1, y1] = matchFechas;
      jornadaInicio = new Date(`20${y1}-${m1}-${d1}T00:00:00+01:00`);
    }

    // --- Recorrer las filas de la tabla ---
    $(box)
      .find("tbody tr")
      .each((_, tr) => {
        const equipos = $(tr)
          .find(".colstyle-equipo .ellipsis")
          .map((_, e) => $(e).attr("title").trim())
          .get();

        if (equipos.length < 2) return;

        const fechaTexto = $(tr).find(".colstyle-fecha span").text().trim();
        const lugar = $(tr).find(".colstyle-fecha .ellipsis").attr("title") || "";
        let fecha = parseDateTime(fechaTexto);
        if (!fecha || isNaN(fecha)) fecha = jornadaInicio; // usar jornada si no hay fecha específica

        // --- Solo registrar si hay equipos de Las Flores ---
        const esLasFlores = equipos.some(e => e.includes("LAS FLORES SEVILLA"));
        if (esLasFlores) {
          partidos.push({
            equipoLocal: equipos[0],
            equipoVisitante: equipos[1],
            fecha: fecha ? fecha.toISOString().split("T")[0] : "",
            hora: fecha ? fecha.toISOString().split("T")[1].substring(0, 5) : "",
            lugar,
          });
        }
      });
  });

  if (partidos.length === 0) {
    console.warn("⚠️ No se encontraron partidos del equipo.");
    return;
  }

  console.log(`✅ ${partidos.length} partidos encontrados.`);

  // --- Crear CSV ---
  const csv = [
    "Equipo local,Equipo visitante,Fecha,Hora,Lugar",
    ...partidos.map(
      p => `${p.equipoLocal},${p.equipoVisitante},${p.fecha},${p.hora},${p.lugar}`
    ),
  ].join("\n");

  fs.writeFileSync("public/calendario.csv", csv, "utf8");
  console.log("📅 Archivo actualizado: public/calendario.csv");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
