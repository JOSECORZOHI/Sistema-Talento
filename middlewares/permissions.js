'use strict';

const ROLES = {
  admin: {
    permissions: [
      'employees.create', 'employees.read', 'employees.update', 'employees.delete', 'employees.suspend', 'employees.reactivate',
      'documents.create', 'documents.read', 'documents.update', 'documents.delete', 'documents.analyze',
      'audit.read', 'config.manage',
      'scanner.manage', 'scanner.read', 'scanner.refresh', 'scanner.scan',
      'email.manage',
      'deletion.create', 'deletion.review'
    ]
  },
  funcionario: {
    permissions: [
      'scanner.read', 'scanner.refresh', 'scanner.scan',
      'email.read', 'email.sync',
      'documents.analyze',
      'deletion.create'
    ]
  }
};

/**
 * Comprueba si un rol tiene un permiso específico.
 *
 * @param {string} role - 'admin' | 'funcionario'.
 * @param {string} permission - Identificador de permiso.
 * @returns {boolean} true si el rol posee el permiso.
 */
function hasPermission(role, permission) {
  return ROLES[role]?.permissions.includes(permission) || false;
}

/**
 * Middleware Express: responde 403 si el usuario autenticado no tiene el permiso.
 *
 * @param {string} permission - Permiso requerido.
 * @returns {function} Middleware de Express.
 */
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user || !hasPermission(req.user.role, permission)) {
      return res.status(403).json({ error: 'No tiene permisos para realizar esta acción.' });
    }
    next();
  };
}

/**
 * Middleware Express: responde 403 si el usuario no tiene al menos uno de los
 * permisos indicados.
 *
 * @param {...string} permissions - Permisos alternativos.
 * @returns {function} Middleware de Express.
 */
function requireAnyPermission(...permissions) {
  return (req, res, next) => {
    if (!req.user || !permissions.some(p => hasPermission(req.user.role, p))) {
      return res.status(403).json({ error: 'No tiene permisos para realizar esta acción.' });
    }
    next();
  };
}

module.exports = {
  ROLES,
  hasPermission,
  requirePermission,
  requireAnyPermission
};
