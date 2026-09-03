'use strict';

// Tests de unidad de anonimización de logs (lib/logScrub.js, Ley 1581/2012).

const test = require('node:test');
const assert = require('node:assert/strict');

const { scrubText, replaceManyText, SCRUB_PATTERN } = require('../lib/logScrub');

test('scrubText reemplaza valores personales por [ELIMINADO]', () => {
  const out = scrubText('Empleado 1090-000123 con correo juan@valledupar.gov.co',
    ['1090-000123', 'juan@valledupar.gov.co']);
  assert.ok(out.includes(SCRUB_PATTERN));
  assert.ok(!out.includes('1090-000123'));
  assert.ok(!out.includes('juan@valledupar.gov.co'));
});

test('scrubText tolera mayúsculas/minúsculas al buscar coincidencias', () => {
  const out = scrubText('Usuario JOSE PEREZ activo', ['jose perez']);
  assert.ok(out.includes(SCRUB_PATTERN));
  assert.ok(!out.includes('JOSE PEREZ'));
});

test('scrubText no altera texto sin valores personales', () => {
  const text = 'Evento normal sin datos';
  assert.equal(scrubText(text, ['inexistente']), text);
});

test('replaceManyText actualiza solo documentos con datos personales por lotes', async () => {
  const docs = [
    { _id: '1', details: 'Contrató a Jose Perez', action: 'crear' },
    { _id: '2', details: 'Evento sin datos', action: 'leer' }
  ];
  const collection = {
    find: () => ({ limit() { return this; }, toArray: async () => docs.splice(0, 2) }),
    updateOne: async () => {}
  };
  const updated = await replaceManyText(collection, ['Jose Perez']);
  assert.equal(updated, 1);
});

test('replaceManyText devuelve 0 con entradas vacías', async () => {
  assert.equal(await replaceManyText({}, []), 0);
  assert.equal(await replaceManyText(undefined, ['x']), 0);
});