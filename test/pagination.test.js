'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parsePagination, wantsPagination, paginateQuery } = require('../lib/pagination');

test('parsePagination usa valores por defecto seguros', () => {
  assert.deepEqual(parsePagination({ query: {} }, { defaultLimit: 50, maxLimit: 500 }), { page: 1, limit: 50, skip: 0 });
  assert.deepEqual(parsePagination({ query: { page: 'abc' } }, { defaultLimit: 20 }), { page: 1, limit: 20, skip: 0 });
});

test('parsePagination normaliza límites (mín 1, máx maxLimit)', () => {
  assert.deepEqual(parsePagination({ query: { page: '2', limit: '10' } }, { defaultLimit: 50, maxLimit: 500 }), { page: 2, limit: 10, skip: 10 });
  assert.equal(parsePagination({ query: { limit: '999999' } }, { maxLimit: 100 }).limit, 100);
  assert.equal(parsePagination({ query: { limit: '-5' } }).limit, 50);
});

test('wantsPagination detecta la petición de paginados', () => {
  assert.equal(wantsPagination({ query: { page: '1' } }), true);
  assert.equal(wantsPagination({ query: { paginate: 'true' } }), true);
  assert.equal(wantsPagination({ query: {} }), false);
  assert.equal(wantsPagination({}), false);
});

test('paginateQuery devuelve ítems, total y hasMore', async () => {
  const docs = [1, 2, 3, 4, 5].map(n => ({ n }));
  const fakeCollection = {
    countDocuments: async () => 5,
    find: () => ({
      sort: () => ({
        skip: () => ({
          limit: () => ({ toArray: async () => (docs.slice(0, 2)) })
        })
      })
    })
  };
  const result = await paginateQuery(fakeCollection, {}, { n: 1 }, { page: 1, limit: 2, skip: 0 });
  assert.equal(result.total, 5);
  assert.equal(result.items.length, 2);
  assert.equal(result.pages, 3);
  assert.equal(result.hasMore, true);
});