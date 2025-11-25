// scripts/build_site.js
// -----------------------------------------------------------
// Construcción completa del sitio Las Flores
// 1. Calendarios FEDERADO
// 2. Calendarios IMD
// 3. Clasificaciones IMD
// 4. Generación index.html + páginas de equipos
// -----------------------------------------------------------

const { execSync } = require("child_process");
const path = require("path");

function run(label, command) {
  console.log(`\n🚀 ${label}`);
  console.log(`   ↪ Ejecutando: ${command}`);
  try {
    execSync(command, { stdio: "inherit" });
    console.log(`   ✅ ${label} completado`);
  } catch (err) {
    console.error(`   ❌ ERROR en ${label}:`, err.message || err);
  }
}

console.log("===============================================");
console.log("🏗️  INICIANDO CONSTRUCCIÓN COMPLETA DEL SITIO");
console.log("===============================================");

// 1. Federado
run("Scraping FEDERADO", "node scripts/update_calendars_federado_multi.js");

// 2. IMD (solo calendarios)
run("Scraping IMD (calendarios)", "node scripts/update_calendars_imd_multi.js");

// 3. IMD (clasificaciones)
run("Scraping IMD (clasificaciones)", "node scripts/update_clasificaciones_imd.js");

// 4. Generar el index final y páginas /equipos/
run("Generar index.html (final)", "node scripts/generate_index_html.js");

console.log("\n===============================================");
console.log("🎉 SITIO COMPLETO GENERADO SINCRÓNICAMENTE 🎉");
console.log("===============================================");
