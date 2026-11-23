// Trae la última versión del currículo de Euskara Praktika (repo julianaplanas/euskera-app).
const fs = require("fs");
const path = require("path");
const URL = "https://raw.githubusercontent.com/julianaplanas/euskera-app/main/public/lessons.js";
(async () => {
  const r = await fetch(URL);
  if (!r.ok) throw new Error("No se pudo descargar: " + r.status);
  fs.writeFileSync(path.join(__dirname, "..", "data", "lessons.js"), await r.text());
  console.log("data/lessons.js actualizado.");
})().catch(e => { console.error(e.message); process.exit(1); });
