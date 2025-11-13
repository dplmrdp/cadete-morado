const { Builder } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const { By, until } = require("selenium-webdriver");

async function setupDriver() {
  const options = new chrome.Options();

  //
  // --- ⚙️ Flags para evitar detección headless ---
  //
  options.addArguments("--headless=new");
  options.addArguments("--disable-blink-features=AutomationControlled");
  options.addArguments("--disable-infobars");
  options.addArguments("--no-sandbox");
  options.addArguments("--disable-gpu");
  options.addArguments("--disable-dev-shm-usage");
  options.addArguments("--disable-web-security");
  options.addArguments("--disable-site-isolation-trials");
  options.addArguments("--disable-features=IsolateOrigins,site-per-process");

  //
  // --- 🌍 User-Agent real ---
  //
  options.addArguments(
    "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );

  //
  // --- 🇪🇸 Idioma español obligatorio ---
  //
  options.addArguments("--lang=es-ES,es");
  options.addArguments("Accept-Language=es-ES,es;q=0.9");

  //
  // --- 📏 Tamaño de ventana real ---
  //
  options.addArguments("--window-size=1920,1080");

  const driver = await new Builder()
    .forBrowser("chrome")
    .setChromeOptions(options)
    .build();

  //
  // --- 🥷 Ocultar navigator.webdriver ---
  //
  try {
    await driver.executeScript(`
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    `);
  } catch (e) {
    console.warn("⚠️ No se pudo ocultar navigator.webdriver:", e);
  }

  return driver;
}

module.exports = { setupDriver };
