'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { renderResetPasswordEmail } = require('../lib/emailTemplates');
const { generateTempPassword } = require('../db');

test('renderResetPasswordEmail genera HTML con enlace y nombre', () => {
  const html = renderResetPasswordEmail({ name: 'Juan Perez', resetUrl: 'https://sistema/forgot.html?token=abc', logoUrl: 'logo.png' });
  assert.match(html, /Hola <strong>Juan Perez<\/strong>/);
  assert.match(html, /https:\/\/sistema\/forgot\.html\?token=abc/);
  assert.match(html, /Restablecer mi contraseña/);
});

test('renderResetPasswordEmail escapa entrada maliciosa', () => {
  const html = renderResetPasswordEmail({ name: '<script>x</script>', resetUrl: null, logoUrl: '' });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('generateTempPassword crea 16 caracteres con al menos mayúscula, minúscula, número y símbolo', () => {
  const password = generateTempPassword();
  assert.equal(password.length, 16);
  assert.match(password, /[A-Z]/);
  assert.match(password, /[a-z]/);
  assert.match(password, /[0-9]/);
  assert.match(password, /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/);
});