'use strict';

// Tests de unidad del analizador local de documentos (documentAnalyzer.js).
// Solo cubren la lógica pura (clasificación, fechas, funcionario y extracción de
// texto de archivos ligeros). No invocan OCR ni descargan modelos.

const test = require('node:test');
const assert = require('node:assert/strict');

const analyzer = require('../documentAnalyzer');

test('classifyType detecta el tipo por palabras clave y cae en "otro"', () => {
  assert.equal(analyzer.classifyType('esto es una hoja de vida con experiencia laboral'), 'hoja-vida');
  assert.equal(analyzer.classifyType('contrato de trabajo entre las partes'), 'contrato');
  assert.equal(analyzer.classifyType('incapacidad medica por tres dias'), 'incapacidad');
  assert.equal(analyzer.classifyType('evaluacion de desempeno anual'), 'evaluacion');
  assert.equal(analyzer.classifyType('certificado laboral expedido por la entidad'), 'certificado');
  assert.equal(analyzer.classifyType('texto sin palabras clave reconocibles'), 'otro');
});

test('classifyCategory detecta la categoría y usa "vinculacion" por defecto', () => {
  assert.equal(analyzer.classifyCategory('cedula de ciudadania numero 123'), 'identificacion');
  assert.equal(analyzer.classifyCategory('certificado laboral del cargo'), 'vinculacion');
  assert.equal(analyzer.classifyCategory('titulo profesional otorgado por la universidad'), 'formacion');
  assert.equal(analyzer.classifyCategory('incapacidad y licencia por enfermedad'), 'novedades');
  assert.equal(analyzer.classifyCategory('evaluacion de desempeno del empleado'), 'desempeno');
  assert.equal(analyzer.classifyCategory('aportes a seguridad social y eps'), 'seguridad-social');
  assert.equal(analyzer.classifyCategory('contenido generico sin categoria'), 'vinculacion');
});

test('extractIssueDate reconoce los formatos soportados y rechaza fechas inválidas', () => {
  assert.equal(analyzer.extractIssueDate('Expedido el 15 de septiembre de 2026'), '2026-09-15');
  assert.equal(analyzer.extractIssueDate('Fecha: 2026-09-15'), '2026-09-15');
  assert.equal(analyzer.extractIssueDate('Fecha 15/09/2026 registrada'), '2026-09-15');
  assert.equal(analyzer.extractIssueDate('Fecha 15-09-2026 registrada'), '2026-09-15');
  assert.equal(analyzer.extractIssueDate('documento sin fecha visible'), null);
  assert.equal(analyzer.extractIssueDate('fecha invalida 32/13/2026'), null);
});

test('extractEmployee encuentra por nombre (con tildes/mayúsculas) o cédula', () => {
  const employees = [{ id: 'e1', name: 'Juan', lastName: 'Pérez', identification: '1090' }];
  assert.equal(analyzer.extractEmployee('Certificado de JUAN PEREZ', employees), 'e1');
  assert.equal(analyzer.extractEmployee('CC 1090 emitida en Valledupar', employees), 'e1');
  assert.equal(analyzer.extractEmployee('otra persona distinta', employees), null);
  assert.equal(analyzer.extractEmployee('Juan Perez', []), null);
  assert.equal(analyzer.extractEmployee('', employees), null);
});

test('parseTextContent conserva texto imprimible y colapsa espacios', () => {
  const out = analyzer.parseTextContent(Buffer.from('Hola\u0000\u0007  Mundo\n'));
  assert.equal(out, 'Hola Mundo');
});

test('extractText devuelve null para extensiones no soportadas', async () => {
  assert.equal(await analyzer.extractText(Buffer.from('x'), 'archivo.xyz'), null);
});

test('analyzeFile sobre un .txt sugiere tipo, categoría, fecha y funcionario', async () => {
  const employees = [{ id: 'e1', name: 'Juan', lastName: 'Pérez', identification: '1090' }];
  const buffer = Buffer.from(
    'Certificado laboral de Juan Perez. Expedido el 15 de septiembre de 2026. Cedula 1090.',
    'utf8'
  );
  const result = await analyzer.analyzeFile(buffer, 'doc.txt', { employees });
  assert.ok(result);
  assert.equal(result.ocrUsed, false);
  assert.ok(result.textLength > 0);
  assert.equal(result.suggestions.documentTypeId, 'certificado');
  assert.equal(result.suggestions.categoryId, 'vinculacion');
  assert.equal(result.suggestions.issueDate, '2026-09-15');
  assert.equal(result.suggestions.employeeId, 'e1');
  assert.ok(result.suggestions.description.includes('Certificado'));
});

test('analyzeFile devuelve null cuando no hay texto extraíble', async () => {
  assert.equal(await analyzer.analyzeFile(Buffer.from('   '), 'vacio.txt'), null);
});
