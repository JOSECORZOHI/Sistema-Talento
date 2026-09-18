'use strict';
const { z } = require('zod');

// Middleware de validación de cuerpos JSON. Devuelve 400 con el primer mensaje de
// error de zod y deja en req.body únicamente los campos ya validados.
function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body || {});
    if (!result.success) {
      const first = result.error.issues[0];
      return res.status(400).json({ error: first ? first.message : 'Datos inválidos.' });
    }
    req.body = result.data;
    return next();
  };
}

module.exports = { z, validateBody };