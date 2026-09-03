'use strict';

// Tests de unidad de paginación (lib/pagination.js).

const test = require('node:test');
const assert = require('node:assert/strict');

const { parsePagination, wantsPagination, paginateQuery } = require('../lib/pagination');

test('parsePagination normaliza page/limit con valores por defecto', () => {
  const pag = parsePagination({ query: {} });
  assert.deepEqual(pag, { page: 1, limit: 50, skip: 0 });
});

test('parsePagination acepta page y limit válidos', () => {
  const pag = parsePagination({ query: { page: '3', limit: '25' } });
  assert.deepEqual(pag, { page: 3, limit: 25, skip: 50 });
});

test('parsePagination corrige valores inválidos (page<=0, no numérico)', () => {
  const pag = parsePagination({ query: { page: '0', limit: 'abc' } });
  assert.equal(pag.page, 1);
  assert.equal(pag.limit, 50);
  assert.equal(pag.skip, 0);
});

test('parsePagination respeta maxLimit', () => {
  const pag = parsePagination({ query: { limit: '9999' } }, { maxLimit: 100 });
  assert.equal(pag.limit, 100);
});

test('parsePagination usa defaultLimit cuando no hay limit', () => {
  const pag = parsePagination({ query: {} }, { defaultLimit: 10 });
  assert.equal(pag.limit, 10);
});

test('wantsPagination detecta page o paginate según el query', () => {
  assert.equal(wantsPagination({ query: { page: '1' } }), true);
  assert.equal(wantsPagination({ query: { paginate: 'true' } }), true);
  assert.equal(wantsPagination({ query: { paginate: '1' } }), true);
  assert.equal(wantsPagination({ query: {} }), false);
  assert.equal(wantsPagination({ query: { limit: '10' } }), false);
});

test('paginateQuery calcula total, páginas y hasMore', async () => {
  const itemsBySkip = (skip) => (skip === 0 ? [{ id: 1 }, { id: 2 }] : []);
  const collection = {
    countDocuments: async () => 2,
    find: () => ({
      sort() { return this; },
      skip(skip) { this._skip = skip; return this; },
      limit() { return this; },
      async toArray() { return itemsBySkip(this._skip); }
    })
  };
  const res = await paginateQuery(collection, {}, { date: -1 }, { page: 1, limit: 2, skip: 0 });
  assert.equal(res.total, 2);
  assert.equal(res.pages, 1);
  assert.equal(res.hasMore, false);
});