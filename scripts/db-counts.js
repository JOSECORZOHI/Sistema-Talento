'use strict';

// Manifiesto de conteos de la base de datos (solo lectura).
//
// Recorre todas las colecciones (incluye documentos.files y documentos.chunks de
// GridFS) y escribe cuántos documentos tiene cada una. Sirve como "huella" del
// backup para que verify-backup.js compruebe que la restauración quedó completa.
//
// Uso:
//   node scripts/db-counts.js                 -> imprime el JSON en pantalla
//   node scripts/db-counts.js --out counts.json

require('dotenv').config();

const fs = require('fs');
const dbmod = require('../db');

(async () => {
  const outIdx = process.argv.indexOf('--out');
  const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : null;

  let db;
  try {
    db = await dbmod.connect();
  } catch (e) {
    console.error('[COUNTS] No se pudo conectar a la base de datos:', e.message);
    process.exit(1);
  }

  try {
    const collections = await db.listCollections().toArray();
    const counts = {};
    for (const c of collections) {
      if (c.name.startsWith('system.')) continue;
      counts[c.name] = await db.collection(c.name).countDocuments();
    }

    const payload = {
      db: process.env.DATABASE_NAME || 'talento_humano',
      takenAt: new Date().toISOString(),
      counts
    };
    const json = JSON.stringify(payload, null, 2);

    if (outPath) {
      fs.writeFileSync(outPath, json, 'utf8');
      console.log(`[COUNTS] Manifiesto escrito en ${outPath} (${Object.keys(counts).length} colecciones).`);
    } else {
      console.log(json);
    }
  } finally {
    await dbmod.closeDb();
  }
})().catch((e) => {
  console.error('[COUNTS] Error inesperado:', e.message);
  process.exit(1);
});
