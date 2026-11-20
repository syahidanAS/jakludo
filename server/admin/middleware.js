'use strict';

const crypto = require('crypto');
const db = require('../db');
const { createLimiter } = require('../lib/limiter');

const MAX_AUDIT_LOGS = 200;
const auditLogs = [];

function bearerToken(req) {
  return (
    String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() ||
    String(req.query?.token || '').trim()
  );
}

function requireAdmin(req, res) {
  const token = bearerToken(req);
  const user = db.getUserByToken(token);
  if (!user) {
    res.status(401).json({ success: false, error: 'Silakan login terlebih dahulu.' });
    return null;
  }
  if (!db.isUserAdmin(user)) {
    res.status(403).json({ success: false, error: 'Akses ditolak: khusus admin.' });
    return null;
  }
  return user;
}

const allowAdminMutation = createLimiter({ windowMs: 60 * 1000, max: 120 });

function adminMutationLimiter(req, res, next) {
  if (process.env.NODE_ENV === 'test' && process.env.ENABLE_RATE_LIMIT_IN_TEST !== '1') {
    return next();
  }
  const token = bearerToken(req);
  const user = db.getUserByToken(token);
  const key = user?.id ? `admin:${user.id}` : `ip:${req.ip || 'anon'}`;
  if (!allowAdminMutation(key)) {
    return res.status(429).json({ success: false, error: 'Terlalu banyak aksi admin dalam waktu singkat. Coba lagi sebentar.' });
  }
  next();
}

const asyncRoute = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(err => {
    const status = Number(err.status) || 500;
    if (status >= 500) {
      console.error('[ADMIN API ERROR]', err);
      return res.status(500).json({ success: false, error: 'Terjadi kesalahan internal pada modul Admin CMS.' });
    }
    return res.status(status).json({ success: false, error: err.message });
  });

function recordAdminAudit({ adminUser, action, targetType, targetId = '', summary = '', meta = null }) {
  const entry = {
    id: 'adm_' + crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    adminId: adminUser?.id || null,
    adminUsername: adminUser?.username || 'system',
    action: String(action || ''),
    targetType: String(targetType || ''),
    targetId: String(targetId || ''),
    summary: String(summary || ''),
    meta: meta && typeof meta === 'object' ? meta : null
  };
  auditLogs.unshift(entry);
  if (auditLogs.length > MAX_AUDIT_LOGS) {
    auditLogs.length = MAX_AUDIT_LOGS;
  }
  console.log(`[ADMIN CMS] @${entry.adminUsername} -> ${entry.action} (${entry.targetType}:${entry.targetId}) ${entry.summary}`);
  return entry;
}

function getRecentAuditLogs(limit = 50) {
  const safeLimit = Math.min(MAX_AUDIT_LOGS, Math.max(1, Number(limit) || 50));
  return auditLogs.slice(0, safeLimit);
}

// Sanitasi sel CSV untuk mencegah CSV/Excel Formula Injection (=, +, -, @, \t, \r)
function csvEscape(value) {
  let str = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

module.exports = {
  requireAdmin,
  adminMutationLimiter,
  asyncRoute,
  recordAdminAudit,
  getRecentAuditLogs,
  csvEscape
};
