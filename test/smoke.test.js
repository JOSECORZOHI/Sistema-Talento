'use strict';

// Smoke test HTTP opcional: verifica que una instancia del servidor en marcha
// responde en /api/health y /api (404 para rutas desconocidas).
// Se ejecuta solo si SMOKE_BASE_URL está definida (ej: el entorno donde está
// corriendo el server). Si no, se omite (skip) para no depender de una BD/red.
//
// Los reintentos solo cubren errores TRANSITORIOS (red / HTTP 5xx, p. ej. un
// reinicio de Railway durante el despliegue). Un fallo de aserción (regresión
// real, como 200 donde se espera 404) falla de inmediato.

const test = require('node:test');
const assert = require('node:assert/strict');

const base = process.env.SMOKE_BASE_URL;
const MAX_ATTEMPTS = 5;
const RETRY_MS = 8000;

async function fetchWithRetry(path, options) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(base + path, options);
      if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
        lastErr = new Error(`HTTP ${res.status} (transitorio)`);
        await new Promise(r => setTimeout(r, RETRY_MS));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt === MAX_ATTEMPTS) break;
      await new Promise(r => setTimeout(r, RETRY_MS));
    }
  }
  throw lastErr;
}

async function getJson(path) {
  const res = await fetchWithRetry(path, { method: 'GET' });
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
  const res = await fetchWithRetry('/', { method: 'GET' });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('<!DOCTYPE'));
});

// --- Smoke AUTOMÁTICO del arranque real ---------------------------------------
// Levanta la app Express en un puerto efímero SIN conectar MongoDB (el guard
// `require.main === module` evita app.listen/connect al importar, y se vacía
// MONGODB_URI). Verifica que el servidor arranca y sirve rutas que no dependen
// de la BD. No requiere red externa ni base de datos.
test('smoke in-process: la app arranca y responde (index, validación y 404 API)', async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke-test-secret';
  process.env.NODE_ENV = 'test';
  process.env.OCR_WARMUP = '0';
  process.env.MONGODB_URI = ''; // evita que el arranque intente conectar a Mongo

  const { app } = require('../server');
  const { closeDb } = require('../db');
  const srv = app.listen(0);
  await new Promise((resolve) => srv.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${srv.address().port}`;
  try {
    // El index se sirve sin BD (no está bajo /api).
    const index = await fetch(baseUrl + '/');
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.ok(html.includes('<!DOCTYPE'));

    // /api/auth/login y su validación de campos no requieren BD.
    const loginBad = await fetch(baseUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(loginBad.status, 400);
    const loginBody = await loginBad.json();
    assert.ok(loginBody && loginBody.error);

    // Ruta API desconocida (bypass de BD) → 404 JSON y nunca 500.
    const missing = await fetch(baseUrl + '/api/auth/login');
    assert.equal(missing.status, 404);
    const missingBody = await missing.json();
    assert.ok(missingBody && missingBody.error);
  } finally {
    await new Promise((resolve) => {
      srv.close(resolve);
      // Cierra conexiones keep-alive para que close() no espere indefinidamente.
      if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    });
    await closeDb().catch(() => {});
  }
});