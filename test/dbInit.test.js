'use strict';

// Prueba de la inicialización de la BD con el driver 'mongodb' sustituido por un
// doble: verifica que connect() crea los índices (incluido el de la colección
// config), ejecuta las migraciones retroactivas y aplica los validadores.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'mongodb://localhost:27017/testdb';
process.env.DATABASE_NAME = 'testdb';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'db-init-test-secret';

const createdDbs = [];

function makeFakeDb() {
  const calls = { createIndex: [], updateMany: [], command: [], createCollection: [] };
  const collections = {};
  function collection(name) {
    if (!collections[name]) {
      collections[name] = {
        countDocuments: async () => (name === 'users' ? 1 : 0),
        findOne: async (filter = {}) => (name === 'users' && filter.role === 'admin')
          ? { role: 'admin', email: 'admin@test.local', password: 'hash' }
          : null,
        insertMany: async () => ({ insertedCount: 0 }),
        insertOne: async () => ({ insertedId: 'x' }),
        updateMany: async (filter, update) => {
          calls.updateMany.push({ name, filter, update });
          return { modifiedCount: 0 };
        },
        indexes: async () => [],
        createIndex: async (keys, opts) => {
          calls.createIndex.push({ name, keys, opts });
          return 'idx_' + name;
        },
        dropIndex: async () => {},
        find: () => ({ sort: () => ({ toArray: async () => [] }) }),
        aggregate: () => ({ toArray: async () => [] })
      };
    }
    return collections[name];
  }
  return {
    command: async (cmd) => { calls.command.push(cmd); return {}; },
    createCollection: async (name, opts) => {
      calls.createCollection.push({ name, opts });
      const err = new Error('NamespaceExists');
      err.code = 48;
      throw err;
    },
    collection,
    _calls: calls
  };
}

class FakeMongoClient {
  constructor(uri, opts) { this.uri = uri; this.opts = opts; this._db = makeFakeDb(); createdDbs.push(this._db); }
  on() {}
  async connect() {}
  db() { return this._db; }
  async close() {}
}
class FakeGridFSBucket { constructor() {} }

const mongodbPath = require.resolve('mongodb');
require.cache[mongodbPath] = {
  id: mongodbPath, filename: mongodbPath, loaded: true,
  exports: { MongoClient: FakeMongoClient, GridFSBucket: FakeGridFSBucket },
  children: [], paths: []
};

const db = require('../db');

test('connect() crea el índice de config, corre migraciones y aplica validadores', async () => {
  await db.connect();
  assert.equal(createdDbs.length, 1);
  const calls = createdDbs[0]._calls;

  const configIndex = calls.createIndex.find(c => c.name === 'config'
    && JSON.stringify(c.keys) === JSON.stringify({ key: 1 }));
  assert.ok(configIndex, 'debe crear el índice único {key:1} en config');
  assert.equal(configIndex.opts.unique, true);

  assert.ok(calls.updateMany.some(c => c.name === 'documents'), 'deben correr las migraciones');

  assert.ok(calls.command.some(c => c.collMod), 'deben aplicarse validadores (collMod)');
});
