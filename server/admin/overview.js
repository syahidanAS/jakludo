'use strict';

const db = require('../db');
const { requireAdmin, asyncRoute, getRecentAuditLogs } = require('./middleware');
const { collectAllActiveRooms, summarizeActiveRooms } = require('./rooms');
const { buildUnifiedOrders, computeFinanceSummary } = require('./finance');
const { computeUsersSummary } = require('./users');

function registerAdminOverviewRoutes(router) {
  router.get('/admin/overview', asyncRoute(async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const roomsList = collectAllActiveRooms();
    const roomsSummary = summarizeActiveRooms(roomsList);
    const ordersList = buildUnifiedOrders();
    const financeSummary = computeFinanceSummary(ordersList);
    const usersSummary = computeUsersSummary();

    res.json({
      success: true,
      usersSummary,
      roomsSummary,
      financeSummary,
      recentOrders: ordersList.slice(0, 8),
      recentRooms: roomsList.slice(0, 6),
      recentAuditLogs: getRecentAuditLogs(15),
      serverHealth: {
        uptimeSec: roomsSummary.serverUptimeSec,
        memoryRssMb: roomsSummary.memoryRssMb,
        dbEngine: db.getStatus().engine,
        activeGateway: financeSummary.activeGateway,
        nodeVersion: process.version,
        timestamp: new Date().toISOString()
      }
    });
  }));

  router.get('/admin/audit', asyncRoute(async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const limit = Math.min(200, Math.max(1, Number(req.query?.limit) || 50));
    res.json({
      success: true,
      logs: getRecentAuditLogs(limit)
    });
  }));
}

module.exports = { registerAdminOverviewRoutes };
