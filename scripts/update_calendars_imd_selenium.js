// ===============================================
//  Scraper IMD Sevilla (Cadete Femenino Morado)
//  Autor: (tu nombre o alias)
//  Usa Selenium WebDriver con Chrome Headless
// ===============================================

const { Builder, By, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const fs = require("fs");
const os = require("os");
const path = require("path");

const IMD_URL = "https://imd.sevilla.org/app/jjddmm_resultados/";
const TEAM_NAME = "CD LAS FLORES SEVILLA MORADO";
const CATEGORY_NAME = "CADETE FEMENINO";

// 📁 Crear perfil temporal único para cada ejecución
const tmpDir = path.join(os.tmpdir(), `chrome-profile-${Date.now()}`);

// Configuración de Chrome en modo headless (para GitHub Actions)
const options = new chrome.Options();
options.addArguments(
  "--headless",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--window-size=1920,1080",
  `--user-data-dir=${tmpDir}` // 👈 evita conflicto de sesión
);

async function loadIMD() {
  console.log("Cargando calendario IMD (tabla de equipos)…");

  const driver = await new Builder()
    .forBrowser("chrome")
    .setChromeOptions(options)
    .build();

  console.log("✅ Navegador Chrome iniciado correctamente");

  try {
    await driver.get(IMD_URL);
    console.log("🌐 Página IMD abierta:", IMD_URL);

    await driver.wait(until.elementLocated(By.id("busqueda")), 15000);
    console.log("🔎 Cuadro de búsqueda encontrado");

    const searchBox = await driver.findElement(By.id("busqueda"));
    await searchBox.clear();
    await searchBox.sendKeys("las flores");
    console.log("⌨️  Texto 'las flores' introducido");


    // Esperar a que aparezcan resultados
    await driver.sleep(2000);

    // 3️⃣ Localizar tabla con los equipos
    const table = await driver.findElement(By.css("table.tt"));
    const rows = await table.findElements(By.css("tbody tr"));

    console.log(`🔍 Se han encontrado ${rows.length} filas en la tabla.`);

    let targetRow = null;
    for (const row of rows) {
      const text = await row.getText();
      const normalized = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

      if (normalized.includes("flores") && normalized.includes("morado") && normalized.includes("cadete femenino")) {
        targetRow = row;
        break;
      }
    }

    if (!targetRow) {
      console.warn(`⚠️ No se encontró la fila '${TEAM_NAME}' (${CATEGORY_NAME}).`);
      return [];
    }

    console.log(`✅ Fila encontrada: ${TEAM_NAME} (${CATEGORY_NAME})`);

    // 4️⃣ Hacer clic en el enlace del equipo
    const link = await targetRow.findElement(By.css("a[href^='#']"));
    await driver.executeScript("arguments[0].click();", link);

    // Esperar a que se cargue el selector de jornadas
    const sel = await driver.wait(until.elementLocated(By.id("seljor")), 15000);

    // 5️⃣ Seleccionar “Todas” en el desplegable
    await sel.findElement(By.xpath("//option[contains(., 'Todas')]")).click();
    await driver.sleep(3000);

    // 6️⃣ Extraer las filas de partidos
    const partidoRows = await driver.findElements(By.css("table.tt tbody tr"));
    console.log(`📅 ${partidoRows.length} filas encontradas en el calendario.`);

    const events = [];
    for (const r of partidoRows) {
      const cells = await r.findElements(By.css("td"));
      const data = await Promise.all(cells.map(c => c.getText()));
      if (data.length >= 5) {
        const [jornada, fecha, hora, equipoLocal, equipoVisitante, pista] = data;
        if (equipoLocal.toLowerCase().includes("flores") || equipoVisitante.toLowerCase().includes("flores")) {
          events.push({
            summary: `${equipoLocal} vs ${equipoVisitante}`,
            location: pista || "Por confirmar",
            date: fecha,
            hour: hora,
          });
        }
      }
    }

    console.log(`✅ Se han encontrado ${events.length} partidos del ${TEAM_NAME}`);
    return events;

  } catch (err) {
    console.error("❌ Error en scraping IMD:", err.message);
    return [];
  } finally {
    await driver.sleep(500); // Evita cierre brusco de Chrome
    await driver.quit();
  }
}

// Exportar función para uso externo (por ejemplo, desde update.yml)
module.exports = { loadIMD };
