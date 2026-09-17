'use strict';

// Prueba del health check: cuando la BD no responde debe devolver 503 para que
// Railway y el monitoreo externo detecten la degradación. El endpoint también
// evita la espera de reconexión del middleware (bypass de /health).
// La capa de base de datos se sustituye por un doble en require.cache.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'health-test-secret';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.MONGODB_URI = '';

const fakeDb = {
  connect: async () => {},
  col: () => { throw new Error('Database not connected'); },
  isHealthy: async () => false,
  reconnect: async () => false,
  closeDb: async () => {},
  storeFileBuffer: async () => ({}),
  readFileStream: () => null,
  readFileBuffer: async () => Buffer.alloc(0),
  deleteFileByName: async () => {},
  listFilesBySource: async () => [],
  markFileRegistered: async () => {},
  generateTempPassword: () => 'Temporal123!'
};

const dbPath = require.resolve('../db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb, children: [], paths: [] };

const { app } = require('../server');

test('health devuelve 503 y estado degradado cuando la BD no responde', async () => {
  const srv = app.listen(0);
  await new Promise((resolve) => srv.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${srv.address().port}`;
  try {
    const res = await fetch(baseUrl + '/api/health');
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.status, 'degraded');
    assert.equal(body.db, 'disconnected');
  } finally {
    await new Promise((resolve) => {
      srv.close(resolve);
      if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    });
  }
});
