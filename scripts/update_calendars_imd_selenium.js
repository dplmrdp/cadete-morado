const { Builder, By, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

const IMD_URL = "https://imd.sevilla.org/app/jjddmm_resultados/";

async function main() {
  console.log("Cargando calendario IMD (modo mínimo)…");

  // Perfil temporal único por ejecución
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
    console.log("Chrome iniciado OK");

    await driver.get(IMD_URL);
    console.log("Página abierta: " + IMD_URL);

    // Buscar el input de búsqueda
    const input = await driver.wait(until.elementLocated(By.id("busqueda")), 20000);
    console.log("Input #busqueda localizado");

    // Escribir “las flores”
    await input.clear();
    await input.sendKeys("las flores");
    console.log("Texto escrito: las flores");

    // Esperar a que aparezca la tabla de equipos
    const table = await driver.wait(until.elementLocated(By.css("table.tt")), 20000);
    console.log("Tabla de equipos localizada");

    const rows = await table.findElements(By.css("tbody tr"));
    console.log("Filas encontradas en la tabla: " + rows.length);

  } catch (err) {
    console.error("ERROR IMD v0:", err && err.message ? err.message : err);
    process.exit(1);
  } finally {
    try { if (driver) await driver.quit(); } catch (_) {}
    console.log("Cierre de Chrome completado");
  }
}

main();
