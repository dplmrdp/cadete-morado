// scripts/update_calendars.js
const fs = require("fs");
const cheerio = require("cheerio");
const https = require("https");

const URL = "https://favoley.es/es/tournament/1321417/calendar/3652130/all";
const OUTPUT = "public/calendario.csv";
const TEAM = "C.D. LAS FLORES SEVILLA MORADO";

function downloadHTML(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      })
      .on("error", (err) => reject(err));
  });
}

function parseDateRange(text) {
  const match = text.match(/\((\d{2}\/\d{2}\/\d{2})\s*–\s*(\d{2}\/\d{2}\/\d{2})\)/);
  if (!match) return { start: null, end: null };
  const [_, start, end] = match;
  const parse = (d) => {
    const [day, month, year] = d.split("/");
    return `20${year}-${month}-${day}`; // formato ISO
  };
  return { start: parse(start), end: parse(end) };
}

function extractMatches(html) {
  const $ = cheerio.load(html);
  const matches = [];

  $(".box-info.full.bottom-borderless").each((_, box) => {
    const jornadaTitle = $(box).find("h2").first().text().trim();
    const { start, end } = parseDateRange(jornadaTitle);

    $(box)
      .find("tbody tr")
      .each((_, row) => {
        const equipos = [];
        $(row)
          .find("td.colstyle-equipo span.ellipsis")
          .each((_, e) => equipos.push($(e).text().trim()));

        const fecha = $(row).find("td.colstyle-fecha span").text().trim();
        const lugar = $(row)
          .find("td.colstyle-fecha span .ellipsis")
          .attr("title") || "";

        if (!equipos.length) return;

        const local = equipos[0];
        const visitante = equipos[1] || "";

        // Solo partidos del equipo Las Flores
        if (!equipos.some((e) => e.includes(TEAM))) return;

        matches.push({
          jornada: jornadaTitle.replace(/\s*\(.*?\)/, "").trim(),
          local,
          visitante,
          fecha: fecha.replace(/\s+GMT\+\d+/, "").replace(/\s+/g, " "),
          lugar,
          start: start || "",
          end: end || "",
        });
      });
  });

  return matches;
}

function saveCSV(matches) {
  const header = "Jornada,Fecha,Equipo local,Equipo visitante,Lugar,Inicio,Fin\n";
  const lines = matches.map(
    (m) =>
      `${m.jornada},"${m.fecha}","${m.local}","${m.visitante}","${m.lugar}",${m.start},${m.end}`
  );
  fs.writeFileSync(OUTPUT, header + lines.join("\n"), "utf-8");
}

(async () => {
  console.log(`Descargando calendario desde ${URL}...`);
  const html = await downloadHTML(URL);
  const matches = extractMatches(html);

  if (matches.length === 0) {
    console.warn(`⚠️ No se encontraron partidos del equipo ${TEAM}.`);
    process.exit(0);
  }

  saveCSV(matches);
  console.log(`✅ ${matches.length} partidos encontrados del ${TEAM}`);
  console.log(`📅 Archivo actualizado: ${OUTPUT}`);
})();
