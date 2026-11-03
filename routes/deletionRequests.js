'use strict';

const express = require('express');
const { col } = require('../db');
const { authMiddleware, requirePermission } = require('../middlewares');

function createDeletionRequestsRouter({ generateId, addAuditLog, getClientIp, deleteDocAndPhysicalFile }) {
  const router = express.Router();

  // POST /api/deletion-requests
  router.post('/', authMiddleware, requirePermission('deletion.create'), async (req, res) => {
    try {
      const { documentId, reason } = req.body;
      if (!documentId) return res.status(400).json({ error: 'Falta el ID del documento.' });

      const doc = await col('documents').findOne({ id: documentId });
      if (!doc) return res.status(404).json({ error: 'Documento no encontrado.' });

      const employee = await col('employees').findOne({ id: doc.employeeId });
      const employeeName = employee ? employee.name : doc.employeeName || 'Desconocido';

      if (req.user.role === 'funcionario' && req.user.employeeId !== doc.employeeId) {
        return res.status(403).json({ error: 'No tiene permiso para solicitar la eliminación de este documento.' });
      }

      const existing = await col('deletionRequests').findOne({ documentId, status: 'Pendiente' });
      if (existing) {
        return res.status(400).json({ error: 'Ya existe una solicitud pendiente para este documento.' });
      }

      const request = {
        id: generateId('delreq'),
        documentId,
        documentFilename: doc.filename,
        employeeId: doc.employeeId,
        employeeName,
        documentType: doc.documentTypeId,
        categoryId: doc.categoryId,
        reason: reason || '',
        requestedBy: req.user.name || req.user.email,
        requestedByRole: req.user.role,
        status: 'Pendiente',
        createdAt: new Date().toISOString()
      };

      await col('deletionRequests').insertOne(request);
      await addAuditLog(
        'Solicitud de Eliminación',
        `${request.requestedBy} solicitó eliminar el documento '${doc.filename}' de ${employeeName}. Motivo: ${request.reason || 'No especificado'}.`,
        req.user.name || req.user.email,
        getClientIp(req)
      );
      res.status(201).json(request);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Error al crear solicitud.' });
    }
  });

  // GET /api/deletion-requests
  router.get('/', authMiddleware, requirePermission('deletion.review'), async (req, res) => {
    try {
      const staleLimit = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      await col('deletionRequests').updateMany(
        { status: 'Procesando', processedAt: { $lt: staleLimit } },
        { $set: { status: 'Pendiente', processedBy: null, processedAt: null } }
      ).catch(() => {});
      const requests = await col('deletionRequests').find().sort({ createdAt: -1 }).limit(200).toArray();
      res.json(requests);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Error al obtener solicitudes.' });
    }
  });

  // PATCH /api/deletion-requests/:id/approve
  router.patch('/:id/approve', authMiddleware, requirePermission('deletion.review'), async (req, res) => {
    try {
      const request = await col('deletionRequests').findOneAndUpdate(
        { id: req.params.id, status: 'Pendiente' },
        { $set: { status: 'Procesando', processedBy: req.user.name || req.user.email, processedAt: new Date().toISOString() } },
        { returnDocument: 'before' }
      );
      if (!request) {
        const exists = await col('deletionRequests').findOne({ id: req.params.id });
        if (!exists) return res.status(404).json({ error: 'Solicitud no encontrada.' });
        return res.status(400).json({ error: 'Esta solicitud ya fue procesada.' });
      }

      const doc = await col('documents').findOne({ id: request.documentId });
      if (doc) {
        try {
          await deleteDocAndPhysicalFile(doc.id, doc.filename);
        } catch (delError) {
          const stillThere = await col('documents').findOne({ id: request.documentId });
          if (stillThere) {
            await col('deletionRequests').updateOne(
              { id: request.id, status: 'Procesando' },
              { $set: { status: 'Pendiente', processedBy: null, processedAt: null } }
            );
            throw delError;
          }
          console.warn('[DEL] Documento eliminado, pero falló la limpieza del archivo:', delError.message);
        }
      }

      const approved = await col('deletionRequests').updateOne(
        { id: request.id, status: 'Procesando' },
        { $set: { status: 'Aprobada' } }
      );
      if (!approved || approved.modifiedCount === 0) {
        console.warn(`[DEL] La solicitud '${request.id}' no pudo marcarse como Aprobada (¿cambio concurrente?).`);
      }

      await addAuditLog(
        'Eliminación Aprobada',
        `El administrador ${req.user.name} aprobó la eliminación del documento '${request.documentFilename}' de ${request.employeeName}.`,
        req.user.name || req.user.email,
        getClientIp(req)
      );
      res.json({ message: 'Solicitud aprobada. Documento eliminado.' });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Error al procesar solicitud.' });
    }
  });

  // PATCH /api/deletion-requests/:id/reject
  router.patch('/:id/reject', authMiddleware, requirePermission('deletion.review'), async (req, res) => {
    try {
      const request = await col('deletionRequests').findOneAndUpdate(
        { id: req.params.id, status: 'Pendiente' },
        { $set: { status: 'Rechazada', processedBy: req.user.name || req.user.email, processedAt: new Date().toISOString() } },
        { returnDocument: 'before' }
      );
      if (!request) {
        const exists = await col('deletionRequests').findOne({ id: req.params.id });
        if (!exists) return res.status(404).json({ error: 'Solicitud no encontrada.' });
        return res.status(400).json({ error: 'Esta solicitud ya fue procesada.' });
      }

      await addAuditLog(
        'Eliminación Rechazada',
        `El administrador ${req.user.name} rechazó la eliminación del documento '${request.documentFilename}' de ${request.employeeName}.`,
        req.user.name || req.user.email,
        getClientIp(req)
      );
      res.json({ message: 'Solicitud rechazada.' });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Error al procesar solicitud.' });
    }
  });

  return router;
}

module.exports = { createDeletionRequestsRouter };
