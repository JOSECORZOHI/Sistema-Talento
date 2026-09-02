// ============================================================
//  logScrub.js — Supresión/anonimización de datos personales
//  en los logs de auditoría y de seguridad (Ley 1581/2012, art. 8 lit. f).
// ============================================================

const SCRUB_PATTERN = '[ELIMINADO]';

// Escapa caracteres especiales de regex.
function escapeRe(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Normaliza mayúsculas y tildes para hacer coincidencias tolerantes.
function normalizeMatch(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

// Reemplaza cada valor personal por SCRUB_PATTERN dentro del texto libre.
function scrubText(text, personalValues) {
  let out = String(text || '');
  for (const v of personalValues) {
    if (!v) continue;
    // Cédulas/correos pueden aparecer con guiones o puntos: se tolera ese
    // espaciado al construir el patrón (ej: "1090-000" -> "1090[.\- ]?000").
    const seg = normalizeMatch(v)
      .split(/(?=[0-9])|(?<=[0-9])/)
      .map(escapeRe)
      .join('[.\\- ]?');
    if (normalizeMatch(out).includes(normalizeMatch(v))) {
      const re = new RegExp(seg, 'gi');
      out = out.replace(re, SCRUB_PATTERN);
    }
  }
  return out;
}

// Reemplaza valores personales en el texto libre de los logs, por lotes.
async function replaceManyText(collection, personalValues, replacement = SCRUB_PATTERN) {
  if (!collection || !Array.isArray(personalValues) || personalValues.length === 0) return 0;

  const BATCH = 500;
  let totalUpdated = 0;

  while (true) {
    const batch = await collection.find({}).limit(BATCH).toArray();
    if (batch.length === 0) break;

    let batchUpdated = 0;
    for (const doc of batch) {
      const updates = {};
      if (typeof doc.details === 'string') {
        const scrubbed = scrubText(doc.details, personalValues);
        if (scrubbed !== doc.details) updates.details = scrubbed;
      }
      if (typeof doc.action === 'string') {
        const scrubbed = scrubText(doc.action, personalValues);
        if (scrubbed !== doc.action) updates.action = scrubbed;
      }
      if (Object.keys(updates).length > 0) {
        updates.scrubbed = true;
        await collection.updateOne({ _id: doc._id }, { $set: updates });
        batchUpdated++;
      }
    }
    totalUpdated += batchUpdated;
    // Si en este lote no hubo cambios es que no queda nada más (los logs nuevos
    // no los tocamos aquí) y la exploración no puede quedarse en bucle infinito.
    if (batchUpdated === 0) break;
  }

  return totalUpdated;
}

module.exports = { replaceManyText, scrubText, SCRUB_PATTERN };
