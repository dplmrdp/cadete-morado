const cheerio = require("cheerio");
const fs = require("fs");

// Usar fetch nativo o un fallback con https (sin node-fetch ni undici)
const https = require("https");

async function fetchHTML(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, res => {
        let data = "";
        res.on("data", chunk => (data += chunk));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

async function loadFederado() {
  const url = "https://favoley.es/es/tournament/1321417/calendar/3652130/all";
  console.log(`Descargando calendario de ${url}...`);

  const html = await fetchHTML(url);
  const $ = cheerio.load(html);

  const partidos = [];

  $(".box-info.full.bottom-borderless").each((_, jornada) => {
    const jornadaTitle = $(jornada).find("h2").text().trim();
    const matchJornada = jornadaTitle.match(/\((\d{2}\/\d{2}\/\d{2}).*?(\d{2}\/\d{2}\/\d{2})\)/);
    let jornadaInicio = null;
    let jornadaFin = null;

    if (matchJornada) {
      const [_, ini, fin] = matchJornada;
      const toISO = d => {
        const [dd, mm, yy] = d.split("/");
        return `20${yy}-${mm}-${dd}`;
      };
      jornadaInicio = toISO(ini);
      jornadaFin = toISO(fin);
    }

    $(jornada)
      .find("tbody tr")
      .each((_, tr) => {
        const equipos = [];
        $(tr)
          .find(".colstyle-equipo span.ellipsis")
          .each((_, e) => equipos.push($(e).text().trim()));

        if (equipos.length === 0) return;

        const fechaRaw = $(tr).find(".colstyle-fecha span").first().text().trim();
        const lugar = $(tr).find(".colstyle-fecha span .ellipsis").attr("title") || "";

        const fechaHoraMatch = fechaRaw.match(/(\d{2}\/\d{2}\/\d{4}) (\d{2}:\d{2})/);
        const fechaPartido = fechaHoraMatch ? fechaHoraMatch[1] : "";
        const horaPartido = fechaHoraMatch ? fechaHoraMatch[2] : "";

        const resultado = $(tr)
          .find(".colstyle-parciales .vertical-result")
          .first()
          .text()
          .replace(/\s+/g, " ")
          .trim();

        if (equipos.some(e => e.includes("LAS FLORES"))) {
          partidos.push({
            jornada: jornadaTitle.split("(")[0].trim(),
            fecha: fechaPartido || `${jornadaInicio} a ${jornadaFin}`,
            hora: horaPartido || "",
            local: equipos[0],
            visitante: equipos[1],
            lugar,
            resultado,
          });
        }
      });
  });

  console.log(`✅ ${partidos.length} partidos encontrados del C.D. LAS FLORES.`);

  if (partidos.length === 0) {
    console.log("⚠️ No se encontraron partidos.");
    return;
  }

  const csv =
    "Jornada,Fecha,Hora,Local,Visitante,Lugar,Resultado\n" +
    partidos
      .map(
        p =>
          `${p.jornada},"${p.fecha}","${p.hora}","${p.local}","${p.visitante}","${p.lugar}","${
            p.resultado || "—"
          }"`
      )
      .join("\n");

  fs.writeFileSync("public/calendario.csv", csv);
  console.log("📅 Archivo actualizado: public/calendario.csv");
}

(async () => {
  try {
    await loadFederado();
  } catch (err) {
    console.error("❌ ERROR en update script:", err);
    process.exit(1);
  }
})();
