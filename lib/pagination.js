'use strict';

/**
 * Parsea los parámetros de paginación (`page` y `limit`) de una petición Express.
 * Siempre devuelve valores válidos: `page >= 1`, `1 <= limit <= maxLimit`.
 *
 * @param {object} req - Objeto de petición Express.
 * @param {object} [options] - Opciones de configuración.
 * @param {number} [options.defaultLimit=50] - Límite usado cuando la petición no trae `limit`.
 * @param {number} [options.maxLimit=500] - Tope máximo aceptado para `limit`.
 * @returns {{page:number, limit:number, skip:number}} Parámetros normalizados.
 */
function parsePagination(req, options = {}) {
  const defaultLimit = Number.isInteger(options.defaultLimit) ? options.defaultLimit : 50;
  const maxLimit = Number.isInteger(options.maxLimit) ? options.maxLimit : 500;
  const query = (req && req.query) || {};
  const rawPage = parseInt(query.page, 10);
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const rawLimit = parseInt(query.limit, 10);
  const requested = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : defaultLimit;
  const limit = Math.min(Math.max(requested, 1), maxLimit);
  return { page, limit, skip: (page - 1) * limit };
}

/**
 * Indica si la petición pide una respuesta paginada (objeto con `items`, `total`,
 * `page`, `pages` y `hasMore`) en lugar del arreglo plano (retrocompatible).
 *
 * @param {object} req - Objeto de petición Express.
 * @returns {boolean} `true` si la respuesta debe ser paginada.
 */
function wantsPagination(req) {
  const query = (req && req.query) || {};
  return query.page !== undefined
    || query.paginate === 'true'
    || query.paginate === '1'
    || query.paginate === true;
}

/**
 * Ejecuta una consulta paginada sobre una colección de MongoDB.
 * Calcula el total, devuelve la página solicitada y metadatos de paginación.
 *
 * @param {object} collection - Colección de MongoDB (con `countDocuments` y `find`).
 * @param {object} filter - Filtro de consulta Mongo.
 * @param {object} sort - Especificación de ordenación Mongo (p. ej. `{ date: -1 }`).
 * @param {{page:number, limit:number, skip:number}} pagination - Parámetros normalizados.
 * @returns {Promise<{items:Array, total:number, page:number, limit:number, pages:number, hasMore:boolean}>}
 */
async function paginateQuery(collection, filter, sort, pagination) {
  const total = await collection.countDocuments(filter);
  const items = await collection.find(filter)
    .sort(sort)
    .skip(pagination.skip)
    .limit(pagination.limit)
    .toArray();
  const pages = Math.ceil(total / pagination.limit) || 1;
  return {
    items,
    total,
    page: pagination.page,
    limit: pagination.limit,
    pages,
    hasMore: pagination.skip + items.length < total
  };
}

module.exports = { parsePagination, wantsPagination, paginateQuery };