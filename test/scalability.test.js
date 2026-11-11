'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'scalability-test-secret-12345';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.MONGODB_URI = '';

const fakeDb = {
  connect: async () => {},
  col: () => ({
    findOne: async () => null,
    find: () => ({
      sort: () => ({ toArray: async () => [], limit: () => ({ toArray: async () => [] }) }),
      toArray: async () => [],
      limit: () => ({ toArray: async () => [] })
    }),
    countDocuments: async () => 0,
    updateOne: async () => ({ modifiedCount: 0 }),
    updateMany: async () => ({ modifiedCount: 0 }),
    deleteMany: async () => ({ deletedCount: 0 }),
    insertOne: async () => ({ insertedId: 'fake-id' }),
    aggregate: () => ({ toArray: async () => [] }),
    distinct: async () => [],
    indexes: async () => [],
    createIndex: async () => 'fake-index'
  }),
  isHealthy: () => true,
  reconnect: async () => true,
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
const { parsePagination, paginateQuery } = require('../lib/pagination');
const { encryptBuffer, decryptBuffer } = require('../lib/crypto');
const { generateTOTP, verifyTOTP } = require('../lib/totp');

async function withServer(fn) {
  const srv = app.listen(0);
  await new Promise((resolve) => srv.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${srv.address().port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => {
      srv.close(resolve);
      if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    });
  }
}

test('escalabilidad: parsePagination y paginateQuery acotan memoria y límites extremos', async () => {
  // 1. Límites extremos de paginación
  const reqExtremo = { query: { page: '999999999', limit: '500000' } };
  const pag = parsePagination(reqExtremo, { maxLimit: 100, maxPage: 5000 });
  assert.equal(pag.page, 5000, 'Debe acotar a maxPage');
  assert.equal(pag.limit, 100, 'Debe acotar a maxLimit');
  assert.equal(pag.skip, (5000 - 1) * 100);

  // 2. Entradas inválidas caen a defaults seguros
  const reqInvalido = { query: { page: '-10', limit: 'abc' } };
  const pagSafe = parsePagination(reqInvalido, { defaultLimit: 25 });
  assert.equal(pagSafe.page, 1);
  assert.equal(pagSafe.limit, 25);
  assert.equal(pagSafe.skip, 0);

  // 3. Simulación de consulta sobre 50.000 registros
  const mockCollection = {
    countDocuments: async () => 50000,
    find: () => ({
      sort: () => ({
        skip: () => ({
          limit: () => ({
            toArray: async () => new Array(50).fill({ id: 'item' })
          })
        })
      })
    })
  };

  const inicio = Date.now();
  const resultado = await paginateQuery(mockCollection, {}, { _id: -1 }, { page: 500, limit: 50, skip: 24950 });
  const duracion = Date.now() - inicio;

  assert.equal(resultado.total, 50000);
  assert.equal(resultado.pages, 1000);
  assert.equal(resultado.page, 500);
  assert.equal(resultado.limit, 50);
  assert.equal(resultado.hasMore, true);
  assert.equal(resultado.items.length, 50);
  assert.ok(duracion < 100, 'El cálculo de metadatos paginados debe ser sub-100ms');
});

test('escalabilidad: 100 operaciones concurrentes AES-256-GCM sin fugas ni bloqueo', async () => {
  const payloadBase = Buffer.from('Datos sensibles de prueba para escalabilidad de cifrado: ' + 'X'.repeat(4096));
  const total = 100;

  const inicio = Date.now();
  const promesas = Array.from({ length: total }, async (_, i) => {
    const data = Buffer.concat([payloadBase, Buffer.from(`_iter_${i}`)]);
    const encrypted = encryptBuffer(data);
    const decrypted = decryptBuffer(encrypted);
    assert.deepEqual(decrypted, data, `La iteración ${i} debe descifrarse intacta`);
  });

  await Promise.all(promesas);
  const duracion = Date.now() - inicio;

  assert.ok(duracion < 800, `100 cifrados y descifrados concurrentes deben tomar menos de 800ms (tomó ${duracion}ms)`);
});

test('escalabilidad: rechazo inmediato HTTP 413 ante payloads que exceden el límite de 500KB', async () => {
  await withServer(async (baseUrl) => {
    // Generar cuerpo de ~600KB que exceda el límite de express.json ({ limit: '500kb' })
    const payloadGigante = {
      username: 'usuario@test.local',
      password: 'ClaveSegura123!',
      relleno: 'A'.repeat(600 * 1024)
    };

    const res = await fetch(baseUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify(payloadGigante)
    });

    assert.equal(res.status, 413, 'Debe devolver HTTP 413 Payload Too Large');
  });
});

test('escalabilidad: alta concurrencia de emisión y verificación TOTP RFC 6238', () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  const total = 200;

  const inicio = Date.now();
  for (let i = 0; i < total; i++) {
    const code = generateTOTP(secret);
    assert.equal(typeof code, 'string');
    assert.equal(code.length, 6);
    assert.equal(verifyTOTP(secret, code), true, 'El código generado debe ser válido');
  }
  const duracion = Date.now() - inicio;

  assert.ok(duracion < 300, `200 generaciones y verificaciones TOTP deben tomar menos de 300ms (tomó ${duracion}ms)`);
});
