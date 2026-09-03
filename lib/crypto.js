// ============================================================
//  crypto.js — Cifrado a nivel de aplicación (AES-256-GCM)
//  para documentos que contienen datos sensibles (Ley 1581/2012, art. 5-7).
//  Los datos sensibles (salud, seguridad social) se cifran en reposo (at-rest)
//  de modo que no queden en claro en GridFS.
// ============================================================

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
// Formato en disco: [16B auth tag][12B IV][ciphertext]
const OVERHEAD = TAG_LEN + IV_LEN;

let warned = false;

// Clave de cifrado de 32 bytes. Se lee de DOC_ENC_KEY (base64 de 32 bytes).
// Si no está configurada, se deriva de JWT_SECRET (fallback estable pero menos
// robusto; se recomienda configurar DOC_ENC_KEY). Nunca se usa una clave hardcodeada.
function getKey() {
  const fromEnv = process.env.DOC_ENC_KEY;
  if (fromEnv) {
    const b = Buffer.from(fromEnv, 'base64');
    if (b.length === 32) return b;
    if (b.length !== 32) {
      console.warn('[CRYPTO] DOC_ENC_KEY no tiene 32 bytes válidos; se deriva de JWT_SECRET.');
    }
  }
  if (!warned && !process.env.DOC_ENC_KEY) {
    warned = true;
    console.warn('[CRYPTO] DOC_ENC_KEY no configurada. Se cifra usando una clave derivada de JWT_SECRET. Configure DOC_ENC_KEY (32 bytes base64).');
  }
  return crypto.createHash('sha256').update(process.env.JWT_SECRET || 'dev-only-insecure-fallback-key').digest();
}

function encryptBuffer(plain) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([tag, iv, enc]);
}

function decryptBuffer(data) {
  if (!data || data.length < OVERHEAD) {
    throw new Error('Datos cifrados inválidos o incompletos.');
  }
  const key = getKey();
  const tag = data.subarray(0, TAG_LEN);
  const iv = data.subarray(TAG_LEN, TAG_LEN + IV_LEN);
  const enc = data.subarray(TAG_LEN + IV_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

function genKey() {
  return crypto.randomBytes(32).toString('base64');
}

module.exports = { encryptBuffer, decryptBuffer, genKey, getKey };
