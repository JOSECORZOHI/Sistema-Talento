'use strict';

/**
 * Protección contra ataques CSRF en peticiones con cookie de sesión.
 * Las cookies se envían solas; para las peticiones mutantes se exige
 * un encabezado personalizado que un formulario cross-site no puede añadir.
 * Las peticiones con Bearer quedan exentas porque no dependen de cookies.
 */
function csrfProtection(req, res, next) {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  if (req.headers && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) return next();
  const requestedWith = String((req.get && req.get('x-requested-with')) || (req.headers && req.headers['x-requested-with']) || '').toLowerCase();
  if (requestedWith === 'xmlhttprequest') return next();
  return res.status(403).json({ error: 'Solicitud no permitida (protección CSRF).' });
}

module.exports = { csrfProtection };
