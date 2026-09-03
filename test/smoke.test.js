'use strict';

// Smoke test HTTP opcional: verifica que una instancia del servidor en marcha
// responde en /api/health y /api (404 para rutas desconocidas).
// Se ejecuta solo si SMOKE_BASE_URL está definida (ej: el entorno donde está
// corriendo el server). Si no, se omite (skip) para no depender de una BD/red.

const test = require('node:test');
const assert = require('node:assert/strict');

const base = process.env.SMOKE_BASE_URL;

async function getJson(path) {
  const res = await fetch(base + path, { method: 'GET' });
  const text = await res.text();
  return { status: res.status, body: text ? safeParse(text) : null };
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

test('smoke: /api/health responde ok', { skip: !base }, async () => {
  const { status, body } = await getJson('/api/health');
  assert.equal(status, 200);
  assert.equal(body && body.status, 'ok');
});

test('smoke: /api sin ruta devuelve JSON y no 500', { skip: !base }, async () => {
  const { status } = await getJson('/api/no-existe-xyz');
  assert.equal(status, 404);
});

test('smoke: / devuelve el documento HTML del index', { skip: !base }, async () => {
  const res = await fetch(base + '/', { method: 'GET' });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('<!DOCTYPE'));
});