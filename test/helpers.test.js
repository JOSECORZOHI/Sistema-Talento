'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  escapeHtml, normalizeEmail, parseEmailFromHeader, parseToEmailHeader,
  getHeader, parseDateHeader, validatePasswordStrength
} = require('../lib/helpers');

test('escapeHtml escapa caracteres peligrosos', () => {
  assert.equal(escapeHtml('<script>&"\'</script>'), '&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml('texto normal'), 'texto normal');
});

test('normalizeEmail limpia espacios y mayúsculas', () => {
  assert.equal(normalizeEmail('  Jose.Corso@Example.COM '), 'jose.corso@example.com');
  assert.equal(normalizeEmail(''), '');
  assert.equal(normalizeEmail(null), '');
});

test('parseEmailFromHeader extrae nombre y correo', () => {
  assert.equal(parseEmailFromHeader('"Juan Pérez" <juan@correo.co>').senderName, 'Juan Pérez');
  assert.equal(parseEmailFromHeader('"Juan Pérez" <juan@correo.co>').senderEmail, 'juan@correo.co');
  assert.equal(parseEmailFromHeader('juan@correo.co').senderEmail, 'juan@correo.co');
  assert.equal(parseEmailFromHeader(undefined).senderName, 'Remitente desconocido');
});

test('parseToEmailHeader extrae correo destino', () => {
  assert.equal(parseToEmailHeader('Ana <ana@correo.co>'), 'ana@correo.co');
  assert.equal(parseToEmailHeader(''), '');
});

test('getHeader busca cabecera sin distinguir mayúsculas', () => {
  const headers = [{ name: 'Subject', value: 'Asunto' }, { name: 'From', value: 'Admin' }];
  assert.equal(getHeader(headers, 'SUBJECT'), 'Asunto');
  assert.equal(getHeader(headers, 'Date'), '');
});

test('parseDateHeader normaliza fechas', () => {
  assert.equal(parseDateHeader('Thu, 01 Jan 2026 00:00:00 +0000'), '2026-01-01T00:00:00.000Z');
  assert.equal(new Date(parseDateHeader('inválida')).getTime() > 0, true);
  assert.equal(new Date(parseDateHeader('')).getTime() > 0, true);
});

test('validatePasswordStrength aplica la política de contraseñas', () => {
  assert.deepEqual(validatePasswordStrength('corta'), { valid: false, error: 'La contraseña debe tener al menos 12 caracteres.' });
  assert.equal(validatePasswordStrength('sinmayusculas12!').valid, false);
  assert.match(validatePasswordStrength('sinmayusculas12!').error, /mayúscula/);
  assert.equal(validatePasswordStrength('SinSimbolos12345').valid, false);
  assert.match(validatePasswordStrength('SinSimbolos12345').error, /símbolo/);
  assert.equal(validatePasswordStrength('Fuerte2026!pass').valid, true);
});