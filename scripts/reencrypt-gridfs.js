'use strict';

// Re-cifra en reposo los archivos de GridFS que aún no están cifrados.
// Uso: node scripts/reencrypt-gridfs.js
//
// ADVERTENCIA: modifica datos en la base. Antes de correrlo haga una copia de
// seguridad (scripts/backup.ps1). Es un one-off para migrar el legado que quedó
// en claro antes de la política de cifrado total (Ley 1581/2012).
//
// Requiere DOC_ENC_KEY configurada con el MISMO valor que usa producción. El
// script se niega a correr sin ella para no cifrar con una clave distinta
// (fallback de JWT_SECRET) que luego no podría descifrar el servidor.

require('dotenv').config();

const { GridFSBucket } = require('mongodb');
const dbmod = require('../db');
const { encryptBuffer } = require('../lib/crypto');

const BUCKET_NAME = 'documentos';
const BATCH = 25;

(async () => {
  const encKey = (process.env.DOC_ENC_KEY || '').trim();
  if (!encKey) {
    console.error('[RE-ENC] DOC_ENC_KEY no está definida. Abortando: se debe usar la misma clave cifrada de producción.');
    process.exit(1);
  }
  if (Buffer.from(encKey, 'base64').length !== 32) {
    console.error('[RE-ENC] DOC_ENC_KEY no es base64 de 32 bytes. Abortando.');
    process.exit(1);
  }

  try {
    const db = await dbmod.connect();
    const bucket = new GridFSBucket(db, { bucketName: BUCKET_NAME });

    const files = await bucket.find({ 'metadata.encrypted': { $ne: true } }).toArray();
    console.log(`[RE-ENC] ${files.length} archivo(s) sin cifrar en GridFS.`);

    let ok = 0;
    let fail = 0;
    for (const f of files) {
      try {
        const chunks = [];
        for await (const c of bucket.openDownloadStream(f._id)) chunks.push(c);
        const enc = encryptBuffer(Buffer.concat(chunks));
        const meta = { ...(f.metadata || {}) };
        meta.encrypted = true;
        await bucket.delete(f._id);
        await new Promise((resolve, reject) => {
          const up = bucket.openUploadStream(f.filename, { metadata: meta, contentType: f.contentType });
          up.on('finish', resolve);
          up.on('error', reject);
          up.end(enc);
        });
        ok++;
        console.log(`[RE-ENC] OK ${f.filename} (${Buffer.concat(chunks).length} B -> ${enc.length} B cifrados)`);
        if (ok % BATCH === 0) console.log(`[RE-ENC] progreso: ${ok}/${files.length}`);
      } catch (e) {
        fail++;
        console.error(`[RE-ENC] FALLO ${f.filename}: ${e.message}`);
      }
    }
    console.log(`[RE-ENC] Terminado. Re-cifrados: ${ok}, fallos: ${fail}.`);
    await dbmod.closeDb();
  } catch (e) {
    console.error('[RE-ENC] Error general:', e.message);
    process.exit(1);
  }
})();