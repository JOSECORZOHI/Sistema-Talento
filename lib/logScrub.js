// ============================================================
//  logScrub.js — Supresión/anonimización de datos personales
//  en los logs de auditoría y de seguridad (Ley 1581/2012, art. 8 lit. f).
// ============================================================

const SCRUB_PATTERN = '[ELIMINADO]';
const { stripAccentsAndLower } = require('./helpers');

// Escapa caracteres especiales de regex.
function escapeRe(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Variantes acentuadas por letra base. Permite construir un patrón que reconozca
// el valor tanto con tildes (texto original) como sin ellas.
const ACCENT_VARIANTS = {
  a: 'aàáâãäåāăą', e: 'eèéêëēĕėęě', i: 'iìíîïĩīĭį', o: 'oòóôõöøōŏő',
  u: 'uùúûüũūŭůűų', n: 'nñńņň', c: 'cçćĉċč', y: 'yýÿŷ', s: 'sśŝşš',
  z: 'zźżž', l: 'lĺļľł', r: 'rŕŗř', t: 'tţť', d: 'dďđ', g: 'gĝğġģ'
};

// Devuelve la clase de carácter regex válida para un carácter normalizado:
// un grupo con sus variantes acentuadas si es una letra base conocida.
function accentClass(ch) {
  const cls = ACCENT_VARIANTS[ch.toLowerCase()];
  return cls ? `[${cls}]` : escapeRe(ch);
}

// Construye el regex que localiza un valor personal en el texto original,
// tolerando tildes y separadores (guiones/puntos/espacios) entre dígitos.
// Los límites \b evitan que un valor corto (p. ej. "1234") destruya subcadenas
// de otros más largos (p. ej. "51234").
function buildScrubRegex(value) {
  const seg = stripAccentsAndLower(value)
    .split(/(?=[0-9])|(?<=[0-9])/)
    .map(part => [...part].map(accentClass).join(''))
    .join('[.\\- ]?');
  return new RegExp(`\\b${seg}\\b`, 'gi');
}

// Reemplaza cada valor personal por el patrón de sustitución dentro del texto libre.
function scrubText(text, personalValues, replacement = SCRUB_PATTERN) {
  let out = String(text || '');
  for (const v of personalValues) {
    if (!v) continue;
    // Comprobación rápida (sin acentos) antes de aplicar el regex.
    if (!stripAccentsAndLower(out).includes(stripAccentsAndLower(v))) continue;
    out = out.replace(buildScrubRegex(v), replacement);
  }
  return out;
}

// Reemplaza valores personales en el texto libre de los logs, por lotes.
async function replaceManyText(collection, personalValues, replacement = SCRUB_PATTERN) {
  if (!collection || !Array.isArray(personalValues) || personalValues.length === 0) return 0;

  const BATCH = 500;
  let totalUpdated = 0;
  // Se avanza con `_id` como marca (no con skip) para no saltarse documentos si
  // se insertan nuevos registros durante el recorrido.
  let lastId = null;
  while (true) {
    const query = lastId ? { _id: { $gt: lastId } } : {};
    const batch = await collection.find(query).sort({ _id: 1 }).limit(BATCH).toArray();
    if (batch.length === 0) break;

    for (const doc of batch) {
      const updates = {};
      if (typeof doc.details === 'string') {
        const scrubbed = scrubText(doc.details, personalValues, replacement);
        if (scrubbed !== doc.details) updates.details = scrubbed;
      }
      if (typeof doc.action === 'string') {
        const scrubbed = scrubText(doc.action, personalValues, replacement);
        if (scrubbed !== doc.action) updates.action = scrubbed;
      }
      if (Object.keys(updates).length > 0) {
        updates.scrubbed = true;
        await collection.updateOne({ _id: doc._id }, { $set: updates });
        totalUpdated++;
      }
    }
    lastId = batch[batch.length - 1]._id;
    // Última ventana: no vale la pena pedir otra.
    if (batch.length < BATCH) break;
  }

  return totalUpdated;
}

module.exports = { replaceManyText, scrubText, SCRUB_PATTERN };
