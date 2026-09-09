'use strict';

// Autenticación de dos factores por TOTP (RFC 6238 / RFC 4226).
// Implementación sin dependencias externas: HMAC-SHA1, 6 dígitos, período de 30 s.

const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = Buffer.alloc(Math.floor((clean.length * 5) / 8));
  let index = 0;
  for (const ch of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out[index++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return out.subarray(0, index);
}

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function generateSecret(byteLength = 20) {
  return base32Encode(crypto.randomBytes(byteLength));
}

function hotpCounterBuffer(counter) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  return buf;
}

function generateTokenFromCounter(secretB32, counter, digits) {
  const key = base32Decode(secretB32);
  const hmac = crypto.createHmac('sha1', key).update(hotpCounterBuffer(counter)).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  const digits10 = 10 ** digits;
  return String(bin % digits10).padStart(digits, '0');
}

function generateTOTP(secretB32, { period = 30, digits = 6, time = Date.now() } = {}) {
  const counter = Math.floor(time / 1000 / period);
  return generateTokenFromCounter(secretB32, counter, digits);
}

function verifyTOTP(secretB32, token, { period = 30, digits = 6, window = 1, time = Date.now() } = {}) {
  const clean = String(token).replace(/\s+/g, '');
  if (!/^\d+$/.test(clean) || clean.length !== digits) return false;
  const counter = Math.floor(time / 1000 / period);
  for (let i = -window; i <= window; i++) {
    if (generateTokenFromCounter(secretB32, counter + i, digits) === clean) return true;
  }
  return false;
}

function buildOtpauthURL({ issuer, account, secret, period = 30, digits = 6 }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${digits}&period=${period}`;
}

module.exports = {
  base32Encode,
  base32Decode,
  generateSecret,
  generateTOTP,
  verifyTOTP,
  buildOtpauthURL
};