'use strict';

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { col } = require('../db');
const { authMiddleware, requirePermission, createLimiter } = require('../middlewares');
const { replaceManyText } = require('../lib/logScrub');

function createEmployeesRouter(deps) {
  const router = express.Router();
  const {
    getClientIp,
    generateTempPassword,
    isAllowedInstitutionalEmail,
    normalizeEmail,
    ALLOWED_EMAIL_DOMAIN,
    getAppBaseUrl,
    sendEmail,
    renderCredentialsEmail,
    addAuditLog,
    addSecurityLog,
    deleteDocAndPhysicalFile
  } = deps;

  // GET /api/employees
  router.get('/', authMiddleware, requirePermission('employees.read'), async (req, res) => {
    const projection = { password: 0, passwordHistory: 0, gmailRefreshToken: 0 };
    res.json(await col('employees').find({}, { projection }).limit(2000).toArray());
  });

  // POST /api/employees
  router.post('/', authMiddleware, requirePermission('employees.create'), createLimiter, async (req, res) => {
    const ip = getClientIp(req);
    let { id, name, department, position, email, consent } = req.body;
    if (!department || !email) {
      return res.status(400).json({ error: 'La dependencia y el correo electrónico son obligatorios.' });
    }
    if (consent !== true) {
      return res.status(400).json({ error: 'Debe confirmar que el titular autoriza el tratamiento de sus datos personales conforme a la Política de Privacidad.' });
    }
    if (!id) id = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '') + crypto.randomInt(0, 1000).toString().padStart(3, '0');
    if (!name) name = id.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._-]/g, ' ').replace(/\b\w/g, l => l.toUpperCase()).trim();
    if (!position) position = 'Funcionario';
    if (!isAllowedInstitutionalEmail(email)) {
      const hint = ALLOWED_EMAIL_DOMAIN ? ` (@${ALLOWED_EMAIL_DOMAIN})` : '';
      return res.status(400).json({ error: `El correo del funcionario no es válido${hint}.` });
    }
    if (await col('employees').findOne({ id })) {
      return res.status(400).json({ error: 'Ya existe un empleado con esta identificación (Cédula).' });
    }
    if (await col('employees').findOne({ email: normalizeEmail(email) })) {
      return res.status(400).json({ error: 'Ya existe un empleado con este correo electrónico.' });
    }
    if (await col('users').findOne({ email: normalizeEmail(email) })) {
      return res.status(400).json({ error: 'El correo electrónico ya pertenece a una cuenta de administrador.' });
    }

    const tempPassword = generateTempPassword();
    const tempHash = await bcrypt.hash(tempPassword, 12);

    const newEmployee = {
      id, name, department, position,
      email: normalizeEmail(email),
      status: 'pendiente',
      active: false,
      mustChangePassword: true,
      password: tempHash,
      registeredAt: new Date().toISOString(),
      registeredBy: 'Administrador',
      failedAttempts: 0,
      lockedUntil: null,
      dataConsent: {
        granted: true,
        grantedAt: new Date().toISOString(),
        grantedByAccount: 'Administrador',
        grantedByIp: ip,
        version: 'v1'
      }
    };
    try {
      await col('employees').insertOne(newEmployee);
    } catch (insertErr) {
      if (insertErr.code === 11000) {
        return res.status(400).json({ error: 'Ya existe un empleado con esta identificación o correo electrónico.' });
      }
      throw insertErr;
    }

    await addAuditLog('Crear Empleado', `Se registró al funcionario ${name} con C.C. ${id}. Contraseña temporal generada y enviada por correo.`, 'Administrador', ip);

    const baseUrl = getAppBaseUrl(req);
    const logoUrl = baseUrl ? `${baseUrl}/Escudo_Valledupar.png` : 'Escudo_Valledupar.png';
    const loginUrl = baseUrl || '#';
    const emailSent = await sendEmail({
      to: normalizeEmail(email),
      subject: 'Credenciales de acceso — Sistema de Talento Humano',
      html: renderCredentialsEmail({ name, email: normalizeEmail(email), tempPassword, logoUrl, loginUrl }),
      text: `Hola ${name},\n\nSe creó su cuenta en el Sistema de Gestión Documental de la Alcaldía de Valledupar.\n\nCorreo: ${normalizeEmail(email)}\nContraseña temporal: ${tempPassword}\n\nDebe cambiar esta contraseña en su primer inicio de sesión.\nInicie sesión en: ${loginUrl}\n\nSi no solicitó esta cuenta, ignore este correo.`
    });

    res.status(201).json({
      ...newEmployee,
      password: undefined,
      ...(emailSent
        ? { emailSent: true, message: 'Empleado creado. Se enviaron las credenciales de acceso al correo del funcionario.' }
        : {
            emailSent: false,
            message: 'Empleado creado, pero no se pudo enviar el correo.',
            ...(process.env.ALLOW_TEMP_PASSWORD_RESPONSE === 'true' ? { tempPassword } : {})
          })
    });
  });

  // PUT /api/employees/profile (debe ir antes de /:id para no ser interpretado como ID)
  router.put('/profile', authMiddleware, async (req, res) => {
    try {
      const { name } = req.body;
      if (!name || !name.trim()) return res.status(400).json({ error: 'El nombre es obligatorio.' });
      const trimmed = name.trim();
      if (trimmed.length < 3 || trimmed.length > 100) return res.status(400).json({ error: 'El nombre debe tener entre 3 y 100 caracteres.' });

      const employee = await col('employees').findOne({ email: req.user.email });
      if (!employee) return res.status(404).json({ error: 'Funcionario no encontrado.' });

      await col('employees').updateOne({ _id: employee._id }, { $set: { name: trimmed } });
      await addAuditLog('Actualizar Nombre', `El funcionario ${employee.name} actualizó su nombre a "${trimmed}".`, employee.email, getClientIp(req));
      res.json({ message: 'Nombre actualizado exitosamente.', name: trimmed });
    } catch (error) {
      console.error('[PROFILE] Error:', error);
      res.status(500).json({ error: 'Error al actualizar el nombre.' });
    }
  });

  // DELETE /api/employees/:id
  router.delete('/:id', authMiddleware, requirePermission('employees.delete'), async (req, res) => {
    try {
      const ip = getClientIp(req);
      const { id } = req.params;
      const employee = await col('employees').findOne({ id });
      if (!employee) return res.status(404).json({ error: 'Funcionario no encontrado.' });

      const empEmail = employee.email;
      const empName = employee.name;

      const empDocs = await col('documents').find({ employeeId: id }).toArray();
      for (const doc of empDocs) {
        await deleteDocAndPhysicalFile(doc.id, doc.filename);
      }

      await col('deletionRequests').deleteMany({ email: empEmail });
      await col('deletionRequests').deleteMany({ employeeId: id });
      await col('emailsInbox').deleteMany({ suggestedEmployeeId: id });

      await col('employees').deleteOne({ id });
      await col('loginAttempts').deleteMany({ identifier: empEmail });
      await col('activationTokens').deleteMany({ email: empEmail });
      await col('passwordResetTokens').deleteMany({ email: empEmail });

      const scrub = '[Dato eliminado por supresión]';
      await col('auditLogs').updateMany(
        { $or: [{ actor: empEmail }, { actor: empName }, { actor: id }] },
        { $set: { actor: scrub, actorDeleted: true } }
      );
      await col('securityLogs').updateMany(
        { $or: [{ actor: empEmail }, { actor: empName }, { actor: id }, { user: empEmail }] },
        { $set: { actor: scrub, user: scrub, actorDeleted: true } }
      );

      if (typeof replaceManyText === 'function') {
        await replaceManyText(col('auditLogs'), [empName, id, empEmail], scrub);
        await replaceManyText(col('securityLogs'), [empName, id, empEmail], scrub);
      }

      await addAuditLog(
        'Eliminar Empleado',
        'Se eliminó permanentemente al funcionario y todos sus datos personales, documentos y registros asociados conforme a la Ley 1581 de 2012 (derecho de supresión). Titular: [SUPRIMIDO].',
        req.user.name,
        ip
      );
      await addSecurityLog(
        'Empleado Eliminado',
        `Funcionario eliminado permanentemente con supresión total de sus datos personales por ${req.user.name}. Titular: [SUPRIMIDO].`,
        ip
      );
      res.json({ message: 'Funcionario eliminado permanentemente. Sus datos personales, documentos y registros asociados fueron suprimidos conforme a la Ley 1581 de 2012.' });
    } catch (error) {
      console.error('[DELETE-EMPLOYEE] Error:', error);
      res.status(500).json({ error: 'Error al eliminar el funcionario.' });
    }
  });

  // PATCH /api/employees/:id/toggle-active
  router.patch('/:id/toggle-active', authMiddleware, requirePermission('employees.suspend'), async (req, res) => {
    try {
      const ip = getClientIp(req);
      const { id } = req.params;
      const employee = await col('employees').findOne({ id });
      if (!employee) return res.status(404).json({ error: 'Funcionario no encontrado.' });

      const newActive = !employee.active;
      const wasPending = employee.status === 'pendiente';
      const newStatus = wasPending && newActive ? 'activa' : (wasPending && !newActive ? 'inactiva' : (newActive ? 'activa' : 'inactiva'));
      await col('employees').updateOne({ id }, { $set: { active: newActive, status: newStatus } });
      await col('employees').updateOne({ id }, { $inc: { jwtVersion: 1 } });
      if (!newActive) {
        await col('activationTokens').deleteMany({ email: employee.email });
        await col('passwordResetTokens').deleteMany({ email: employee.email });
      }

      const statusText = wasPending ? 'pendiente de activación' : (newActive ? 'activado' : 'desactivado');
      const statusEmoji = newActive ? '✓' : '✕';
      await addAuditLog(`${statusEmoji} ${newActive ? 'Reactivar' : 'Desactivar'} Empleado`, `El funcionario ${employee.name} (C.C. ${id}) fue ${statusText}.`, req.user.name, ip);
      res.json({ message: `Funcionario "${employee.name}" ${statusText} exitosamente.`, active: newActive, status: newStatus });
    } catch (error) {
      console.error('[TOGGLE-ACTIVE] Error:', error);
      res.status(500).json({ error: 'Error al cambiar estado del funcionario.' });
    }
  });

  return router;
}

module.exports = { createEmployeesRouter };
