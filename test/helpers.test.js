'use strict';

// Tests de unidad de helpers (lib/helpers.js) — saneado HTML/XSS y mail.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  escapeHtml,
  normalizeEmail,
  parseEmailFromHeader,
  parseToEmailHeader,
  getHeader,
  validatePasswordStrength
} = require('../lib/helpers');

test('escapeHtml neutraliza HTML/scripts (anti-XSS)', () => {
  const out = escapeHtml('<script>alert("x")</script>');
  assert.equal(out, '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  assert.ok(!out.includes('<'));
  assert.ok(!out.includes('">'));
});

test('escapeHtml trata null/undefined como cadena vacía', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('normalizeEmail recorta y pasa a minúsculas', () => {
  assert.equal(normalizeEmail('  USer@DOMINIO.co '), 'user@dominio.co');
});

test('parseEmailFromHeader extrae nombre y correo', () => {
  const r = parseEmailFromHeader('"Juan Perez" <juan@valledupar.gov.co>');
  assert.equal(r.senderName, 'Juan Perez');
  assert.equal(r.senderEmail, 'juan@valledupar.gov.co');
});

test('parseEmailFromHeader devuelve remitente por defecto sin cabecera', () => {
  const r = parseEmailFromHeader('');
  assert.equal(r.senderName, 'Remitente desconocido');
  assert.equal(r.senderEmail, '');
});

test('parseToEmailHeader extrae el correo del encabezado To', () => {
  assert.equal(parseToEmailHeader('Administrador <admin@valledupar.gov.co>'), 'admin@valledupar.gov.co');
  assert.equal(parseToEmailHeader('admin@valledupar.gov.co'), 'admin@valledupar.gov.co');
  assert.equal(parseToEmailHeader(''), '');
});

test('getHeader busca por nombre insensible a mayúsculas', () => {
  const headers = [{ name: 'Subject', value: 'Hola' }];
  assert.equal(getHeader(headers, 'SUBJECT'), 'Hola');
  assert.equal(getHeader(headers, 'To'), '');
});

test('validatePasswordStrength rechaza contraseñas débiles y acepta fuertes', () => {
  assert.equal(validatePasswordStrength('corta').valid, false);
  assert.equal(validatePasswordStrength('todo-minusc-1!').valid, false);
  assert.equal(validatePasswordStrength('Fuerte-Clave-2024!$').valid, true);
});