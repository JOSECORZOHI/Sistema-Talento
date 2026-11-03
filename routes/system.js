'use strict';

const express = require('express');
const fs = require('fs');
const { col } = require('../db');
const { authMiddleware, requirePermission } = require('../middlewares');

function createSystemRouter({ getAdminGmailRefreshToken, getUnregisteredFiles, SCANNER_DIR }) {
  const router = express.Router();

  // GET /api/system/status
  router.get('/status', authMiddleware, requirePermission('audit.read'), async (req, res) => {
    const startedAt = Date.now();
    let dbConnected = false;
    let dbLatencyMs = null;
    const counts = {};
    const indexes = { ok: true, missing: [] };
    try {
      const t0 = Date.now();
      const [users, employees, documents] = await Promise.all([
        col('users').countDocuments(),
        col('employees').countDocuments(),
        col('documents').countDocuments()
      ]);
      dbLatencyMs = Date.now() - t0;
      dbConnected = true;
      counts.users = users;
      counts.employees = employees;
      counts.documents = documents;

      const requiredIndexes = {
        documents: ['issueDate_-1'],
        securityLogs: ['timestamp_-1'],
        emailsInbox: ['date_-1'],
        auditLogs: ['timestamp_-1']
      };
      for (const [collectionName, wanted] of Object.entries(requiredIndexes)) {
        let names = [];
        try {
          names = (await col(collectionName).indexes()).map(i => i.name);
        } catch { indexes.ok = false; }
        for (const indexName of wanted) {
          if (!names.includes(indexName)) indexes.missing.push(`${collectionName}.${indexName}`);
        }
      }
      if (indexes.missing.length > 0) indexes.ok = false;
    } catch {
      dbConnected = false;
    }

    const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI } = process.env;
    const gmailConfigured = !!(GMAIL_CLIENT_ID && GMAIL_CLIENT_SECRET && GMAIL_REDIRECT_URI);
    const gmailAuthenticated = gmailConfigured && !!(await getAdminGmailRefreshToken());

    let securityLast24h = null;
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      securityLast24h = await col('securityLogs').countDocuments({ timestamp: { $gte: since } });
    } catch {}

    let errorsLast24h = null;
    let recentErrors = [];
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      errorsLast24h = await col('errorLogs').countDocuments({ timestamp: { $gte: since } });
      recentErrors = await col('errorLogs').find({})
        .sort({ timestamp: -1 })
        .limit(5)
        .project({ message: 1, source: 1, timestamp: 1, status: 1, path: 1 })
        .toArray();
    } catch {}

    let unregistered = 0;
    try { unregistered = (await getUnregisteredFiles()).length; } catch {}

    const pkg = require('../package.json');
    res.json({
      generatedAt: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
      version: pkg.version || null,
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      database: { connected: dbConnected, latencyMs: dbLatencyMs, counts, indexes },
      gmail: { configured: gmailConfigured, authenticated: gmailAuthenticated },
      scanner: { localFolder: fs.existsSync(SCANNER_DIR) },
      security: { last24hEvents: securityLast24h },
      errors: { last24h: errorsLast24h, recent: recentErrors },
      documents: { unregistered },
      responseTimeMs: Date.now() - startedAt
    });
  });

  return router;
}

module.exports = { createSystemRouter };
