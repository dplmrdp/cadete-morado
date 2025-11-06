const fs = require("fs");
const { Builder, By, until } = require("selenium-webdriver");
require("chromedriver");

const IMD_URL = "https://imd.sevilla.org/app/jjddmm_resultados/";
const TEAM_NAME = "CD LAS FLORES SEVILLA MORADO";
const TEAM_COLOR = "#bfd0d9"; // color de celda para el equipo en las tablas de jornadas

function fmtICSDateTime(dt) {
  return dt.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function writeICS(filename, events) {
  let ics = "BEGIN:VCALENDAR\n" +
            "VERSION:2.0\n" +
            "CALSCALE:GREGORIAN\n" +
            "METHOD:PUBLISH\n" +
            "PRODID:-//Las Flores Morado//Calendario IMD//ES\n";

  for (const evt of events) {
    ics += "BEGIN:VEVENT\n" +
           "SUMMARY:" + evt.summary + "\n" +
           "LOCATION:" + evt.location + "\n" +
           "DTSTART:" + fmtICSDateTime(evt.start) + "\n" +
           "END:VEVENT\n";
  }

  ics += "END:VCALENDAR\n";

  fs.mkdirSync("calendarios", { recursive: true });
  fs.writeFileSync("calendarios/" + filename, ics);
}

async function loadIMD() {
  console.log("Cargando calendario IMD (tabla de equipos)…");

  // Construye el driver de Chrome (headless por defecto en Actions)
  const driver = await new Builder().forBrowser("chrome").build();
  const events = [];

  try {
    console.log("Navegador Chrome iniciado correctamente");
    await driver.get(IMD_URL);
    console.log("Página IMD abierta: " + IMD_URL);

    // Campo de búsqueda
    const input = await driver.wait(until.elementLocated(By.id("busqueda")), 20000);
    console.log("Cuadro de búsqueda encontrado");

    // Escribe "las flores" y dispara el filtrado (normalmente se filtra sin pulsar botón)
    await input.clear();
    await input.sendKeys("las flores");
    console.log("Texto 'las flores' introducido");

    // Espera a que aparezca la tabla de equipos
    const table = await driver.wait(until.elementLocated(By.css("table.tt")), 20000);
    console.log("Tabla de equipos encontrada y cargada");

    // Filas con equipos
    const rows = await table.findElements(By.css("tbody tr"));
    console.log("Se han encontrado " + rows.length + " filas en la tabla.");

    // Busca la fila con "CD LAS FLORES SEVILLA MORADO" y "CADETE FEMENINO"
    let targetRow = null;
    for (const row of rows) {
      const text = (await row.getText()).toUpperCase();
      if (text.indexOf("LAS FLORES SEVILLA MORADO") !== -1 && text.indexOf("CADETE FEMENINO") !== -1) {
        targetRow = row;
        break;
      }
    }

    if (!targetRow) {
      console.warn("No se encontró la fila 'CD LAS FLORES SEVILLA MORADO' (Cadete Femenino).");
      return [];
    }

    console.log("Fila encontrada: " + TEAM_NAME + " (Cadete Femenino)");

    // Haz clic en el primer enlace de la fila (cualquiera lanza la función datosequipo)
    const firstLink = await targetRow.findElement(By.css("a"));
    await firstLink.click();

    // Ajusta el desplegable de jornadas a "Todas" (id="seljor")
    const sel = await driver.wait(until.elementLocated(By.id("seljor")), 20000);
    await sel.sendKeys("Todas");
    console.log("Desplegable de jornadas ajustado a 'Todas'");

    // Espera a que se carguen todas las tablas de jornadas
    await driver.wait(until.elementsLocated(By.css("table.tt")), 20000);
    const tables = await driver.findElements(By.css("table.tt"));
    console.log("Se han detectado " + tables.length + " tablas de jornada.");

    // Recorre tablas de jornadas
    for (const t of tables) {
      const tRows = await t.findElements(By.css("tbody tr"));
      if (tRows.length === 0) continue;

      // Estructura de tabla de jornada:
      // Encabezado + filas de partidos. Las filas de datos suelen ser todas (no hay un thead)
      for (let i = 1; i < tRows.length; i++) {
        const tds = await tRows[i].findElements(By.css("td"));
        if (tds.length < 6) continue;

        // Identificar filas del equipo mediante el color de fondo de alguna celda (#bfd0d9)
        let isMoradoRow = false;
        for (const td of tds) {
          const bg = await td.getAttribute("bgcolor");
          if (bg && bg.toLowerCase() === TEAM_COLOR) {
            isMoradoRow = true;
            break;
          }
        }
        if (!isMoradoRow) continue;

        const fecha = (await tds[0].getText()).trim();      // dd/mm/yyyy
        const hora = (await tds[1].getText()).trim();       // HH:MM
        const local = (await tds[2].getText()).trim();
        const visitante = (await tds[3].getText()).trim();
        const lugar = (await tds[5].getText()).trim();

        // Si el texto "LAS FLORES" aparece en ambos equipos, inspecciona el color de esas celdas
        let isOurMatch = true;
        if (local.toUpperCase().indexOf("LAS FLORES") !== -1 && visitante.toUpperCase().indexOf("LAS FLORES") !== -1) {
          const bgLocal = (await tds[2].getAttribute("bgcolor")) || "";
          const bgVisit = (await tds[3].getAttribute("bgcolor")) || "";
          const isLocalMorado = bgLocal.toLowerCase() === TEAM_COLOR;
          const isVisitMorado = bgVisit.toLowerCase() === TEAM_COLOR;
          isOurMatch = isLocalMorado || isVisitMorado;
        }
        if (!isOurMatch) continue;

        // Parsear fecha y hora -> Date local con GMT+1 (horario de invierno).
        // Si hubiera horario de verano habría que ajustar, pero IMD usa temporada de invierno.
        let start = null;
        try {
          const partsF = fecha.split("/");
          const partsH = hora.split(":");
          if (partsF.length === 3 && partsH.length === 2) {
            const d = partsF[0], m = partsF[1], y = partsF[2];
            const hh = partsH[0], mm = partsH[1];
            start = new Date(y + "-" + m + "-" + d + "T" + hh + ":" + mm + ":00+01:00");
          }
        } catch (e) {
          // Si no se puede parsear, omite el partido
          continue;
        }
        if (!start || isNaN(start.getTime())) continue;

        const summary = local + " vs " + visitante;
        events.push({
          summary: summary,
          location: lugar || "Por confirmar",
          start: start
        });
      }
    }

    console.log("Se han encontrado " + events.length + " partidos del " + TEAM_NAME);
    return events;

  } catch (e) {
    console.error("Error en scraping IMD:", e && e.message ? e.message : e);
    return [];
  } finally {
    try { await driver.quit(); } catch (_) {}
    console.log("Proceso IMD completado con " + events.length + " partidos.");
  }
}

(async () => {
  const imd = await loadIMD();
  if (imd.length > 0) {
    writeICS("imd.ics", imd);
    console.log("Calendario IMD guardado en calendarios/imd.ics");
  } else {
    console.warn("No se encontraron partidos IMD.");
  }
})();
