// scripts/validate_federado_ids.js
const fs = require("fs");
const path = require("path");

const CALENDAR_DIR = path.join(__dirname, "..", "calendarios");
const MAP_FILE = path.join(__dirname, "..", "federado_ids.json");

function slugToKey(filename) {
  // filename sin extensión y en mayúsculas, remover prefijos comunes
  let name = filename.replace(/\.ics$/i, "");
  name = name.replace(/^federado[_\-]/i, "");
  name = name.replace(/^imd[_\-]/i, "");
  name = name.replace(/[_\-.]+/g, " ").trim().toUpperCase();
  // opcion: tomar categoria + color si existen -> simplificado: eliminar sufijos comunes
  // convertir espacios a guiones bajos para clave
  return name.replace(/\s+/g, "_");
}

function loadMap() {
  if (!fs.existsSync(MAP_FILE)) {
    console.error(`No se encuentra ${MAP_FILE}. Crea primero federado_ids.json en la raíz del repo.`);
    process.exit(1);
  }
  const raw = fs.readFileSync(MAP_FILE, "utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error("Error parseando federado_ids.json:", e.message);
    process.exit(1);
  }
}

function main() {
  if (!fs.existsSync(CALENDAR_DIR)) {
    console.error(`No existe el directorio ${CALENDAR_DIR}. Asegúrate de que existen calendarios/*.ics (o crea algunos para prueba).`);
    process.exit(1);
  }

  const files = fs.readdirSync(CALENDAR_DIR).filter(f => f.toLowerCase().endsWith(".ics"));
  const map = loadMap();

  const missing = [];
  const suggestions = [];

  for (const f of files) {
    const key = slugToKey(f);
    const exists = Object.prototype.hasOwnProperty.call(map, key) || Object.prototype.hasOwnProperty.call(map, key.toUpperCase());
    if (!exists) missing.push({ file: f, suggestedKey: key });
    else suggestions.push({ file: f, key });
  }

  console.log("=== Ficheros analizados ===");
  console.log(`Total .ics: ${files.length}`);
  console.log("");

  if (missing.length) {
    console.log("== Ficheros SIN mapeo en federado_ids.json ==");
    missing.forEach(m => {
      console.log(`- ${m.file}    => sugerencia de clave: ${m.suggestedKey}`);
    });
    console.log("");
    console.log("Añade las entradas sugeridas (o la clave que prefieras) en federado_ids.json, por ejemplo:");
    if (missing[0]) {
      console.log(`"${missing[0].suggestedKey}": { "tournament": 1321417, "group": 3652121 }`);
    }
  } else {
    console.log("✅ Todos los ficheros .ics tienen mapeo en federado_ids.json (o no hay calendarios).");
  }
}

main();
