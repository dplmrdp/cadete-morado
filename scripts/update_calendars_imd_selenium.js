const { Builder, By, until, Key } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const IMD_URL = "https://imd.sevilla.org/app/jjddmm_resultados/";

async function main() {
  console.log("Cargando calendario IMD (v2.2: ejecutar datosequipo)…");

  const userDataDir = "/tmp/chrome-profile-" + Date.now();
  const options = new chrome.Options()
    .addArguments("--headless=new")
    .addArguments("--no-sandbox")
    .addArguments("--disable-dev-shm-usage")
    .addArguments("--disable-gpu")
    .addArguments("--window-size=1920,1080")
    .addArguments("--user-data-dir=" + userDataDir);

  let driver;
  try {
    driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();
    console.log("✅ Navegador Chrome iniciado correctamente");

    await driver.get(IMD_URL);
    console.log("🌐 Página IMD abierta: " + IMD_URL);

    // Buscar el cuadro de búsqueda
    const input = await driver.wait(until.elementLocated(By.id("busqueda")), 20000);
    await input.clear();
    await input.sendKeys("las flores", Key.ENTER);
    console.log("⌨️  Texto 'las flores' introducido y búsqueda lanzada con Enter");

    // Esperar tabla de equipos
    const table = await driver.wait(until.elementLocated(By.css("table.tt")), 20000);
    const rows = await table.findElements(By.css("tbody tr"));
    console.log(`📋 Tabla de equipos encontrada (${rows.length} filas).`);

    // Buscar la fila del Cadete Femenino Morado y extraer su ID de datosequipo('...')
    let equipoID = null;
    for (const row of rows) {
      const html = await row.getAttribute("innerHTML");
      const text = html.toUpperCase();
      if (text.includes("LAS FLORES SEVILLA MORADO") && text.includes("CADETE FEMENINO")) {
        const match = html.match(/datosequipo\('([^']+)'\)/);
        if (match) equipoID = match[1];
        break;
      }
    }

    if (!equipoID) {
      console.log("⚠️ No se encontró el ID del equipo CD LAS FLORES SEVILLA MORADO (CADETE FEMENINO).");
      return;
    }

    console.log(`✅ ID del equipo obtenido: ${equipoID}`);
    console.log("▶️ Ejecutando datosequipo() directamente...");

    // Ejecutar el JavaScript que carga el calendario
    await driver.executeScript(`datosequipo('${equipoID}')`);

    // Esperar hasta que aparezca el desplegable de jornadas
    const sel = await driver.wait(until.elementLocated(By.id("seljor")), 20000);
    await driver.wait(until.elementIsVisible(sel), 20000);
    console.log("📅 Desplegable de jornadas detectado.");

    // Seleccionar la opción “Todas”
    const optionTodas = await sel.findElement(By.css("option[value='']"));
    await optionTodas.click();
    console.log("📊 Seleccionada la opción 'Todas las jornadas'.");

    // Esperar a que carguen todas las tablas de jornadas
    await driver.wait(until.elementsLocated(By.css("table.tt")), 20000);
    const jornadas = await driver.findElements(By.css("table.tt"));
    console.log(`✅ Se han encontrado ${jornadas.length} tablas de jornadas.`);

  } catch (err) {
    console.error("❌ Error en scraping IMD v2.2:", err.message || err);
  } finally {
    try { if (driver) await driver.quit(); } catch (_) {}
    console.log("🏁 Proceso IMD v2.2 completado.");
  }
}

main();
