'use strict';

const db = require('../db');
const economy = require('../economy/store');
const paymentGateway = require('../lib/paymentGateway');
const { requireAdmin, adminMutationLimiter, asyncRoute, recordAdminAudit, csvEscape } = require('./middleware');

const COIN_STATUS_MAP = {
  success: 'PAID',
  paid: 'PAID',
  pending: 'PENDING',
  cancelled: 'CANCELLED',
  canceled: 'CANCELLED',
  failed: 'FAILED',
  expired: 'EXPIRED'
};

function toWibDateKey(isoOrMs) {
  const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function buildUnifiedOrders() {
  const diamondOrders = economy.listAllPaymentOrders().map(o => {
    const u = db.findUserById(o.userId);
    const totalDiamonds = Number(o.totalDiamonds || Number(o.diamonds || 0) + Number(o.bonusDiamonds || 0));
    return {
      kind: 'diamond',
      id: o.id,
      orderId: o.id,
      userId: o.userId,
      username: u?.username || o.userId,
      playerName: u?.name || u?.username || o.userId,
      packageId: o.packageId,
      packageName: o.packageName || `${totalDiamonds} Diamonds`,
      rewardLabel: `${totalDiamonds.toLocaleString('id-ID')} Diamonds`,
      rewardAmount: totalDiamonds,
      amountIdr: Number(o.amountIdr || 0),
      gateway: String(o.gateway || 'midtrans').toLowerCase(),
      paymentMethod: o.paymentMethod || '',
      paymentMethodName: o.paymentMethodName || o.paymentMethod || '-',
      paymentCategory: o.paymentCategory || null,
      bank: o.bank || null,
      vaNumber: o.vaNumber || null,
      qrString: o.qrString || null,
      qrCodeUrl: o.qrCodeUrl || null,
      deeplinkUrl: o.deeplinkUrl || null,
      paymentUrl: o.paymentUrl || null,
      gatewayReference: o.gatewayReference || null,
      status: String(o.status || 'PENDING').toUpperCase(),
      failureReason: o.failureReason || null,
      creditedAt: o.creditedAt || null,
      expiresAt: o.expiresAt || null,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt
    };
  });

  const coinOrders = db.listAllTopupOrders().map(o => {
    const rawStatus = String(o.status || 'pending').toLowerCase();
    const status = COIN_STATUS_MAP[rawStatus] || rawStatus.toUpperCase();
    const coins = Number(o.coins || o.diamonds || 0);
    return {
      kind: 'coin',
      id: o.orderId,
      orderId: o.orderId,
      userId: o.userId,
      username: o.username || o.userId,
      playerName: o.playerName || o.username || o.userId,
      packageId: o.packageId,
      packageName: o.packageName || `${coins.toLocaleString('id-ID')} Coins`,
      rewardLabel: `${coins.toLocaleString('id-ID')} Coins`,
      rewardAmount: coins,
      amountIdr: Number(o.amountIdr || o.grossAmount || 0),
      gateway: String(o.gateway || 'midtrans').toLowerCase(),
      paymentMethod: o.paymentMethod || '',
      paymentMethodName: o.paymentMethodName || o.paymentMethod || '-',
      paymentCategory: o.paymentCategory || null,
      bank: o.bank || null,
      vaNumber: o.vaNumber || null,
      qrString: o.qrString || null,
      qrCodeUrl: o.qrCodeUrl || null,
      deeplinkUrl: o.deeplinkUrl || null,
      paymentUrl: o.paymentUrl || null,
      gatewayReference: o.reference || null,
      status,
      failureReason: o.failureReason || null,
      creditedAt: status === 'PAID' ? o.updatedAt : null,
      expiresAt: null,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt
    };
  });

  return [...diamondOrders, ...coinOrders].sort(
    (a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)
  );
}

function computeFinanceSummary(orders = buildUnifiedOrders()) {
  const now = Date.now();
  const todayKey = toWibDateKey(now);
  const monthPrefix = todayKey.slice(0, 7);

  let totalRevenueIdr = 0;
  let todayRevenueIdr = 0;
  let monthRevenueIdr = 0;
  let paidOrdersCount = 0;
  let pendingOrdersCount = 0;
  let failedOrCancelledCount = 0;
  let diamondOrdersRevenueIdr = 0;
  let coinOrdersRevenueIdr = 0;
  const revenueByGateway = {};
  const revenueByMethod = {};

  // Siapkan 7 hari terakhir (WIB)
  const dailyMap = new Map();
  for (let i = 6; i >= 0; i--) {
    const key = toWibDateKey(now - i * 24 * 60 * 60 * 1000);
    dailyMap.set(key, {
      date: key,
      label: key.slice(5), // MM-DD
      revenueIdr: 0,
      ordersCount: 0
    });
  }

  for (const o of orders) {
    if (o.status === 'PAID') {
      const amt = Number(o.amountIdr || 0);
      totalRevenueIdr += amt;
      paidOrdersCount++;
      if (o.kind === 'diamond') diamondOrdersRevenueIdr += amt;
      else coinOrdersRevenueIdr += amt;

      const dayKey = toWibDateKey(o.creditedAt || o.createdAt);
      if (dayKey === todayKey) todayRevenueIdr += amt;
      if (dayKey.startsWith(monthPrefix)) monthRevenueIdr += amt;

      if (dailyMap.has(dayKey)) {
        const bucket = dailyMap.get(dayKey);
        bucket.revenueIdr += amt;
        bucket.ordersCount++;
      }

      const gw = o.gateway || 'other';
      revenueByGateway[gw] = (revenueByGateway[gw] || 0) + amt;

      const method = o.paymentMethodName || o.paymentMethod || 'Lainnya';
      revenueByMethod[method] = (revenueByMethod[method] || 0) + amt;
    } else if (o.status === 'PENDING') {
      pendingOrdersCount++;
    } else {
      failedOrCancelledCount++;
    }
  }

  const users = db.listAllUsers();
  const totalCoinsCirculating = users.reduce((sum, u) => sum + Number(u.points || 0), 0);
  const econOverview = economy.getAdminOverview({ limit: 1 });
  const allTxs = economy.listAllDiamondTransactions();
  const totalRefundsCount = allTxs.filter(tx => tx.txType === 'REFUND').length;

  return {
    totalRevenueIdr,
    todayRevenueIdr,
    monthRevenueIdr,
    paidOrdersCount,
    pendingOrdersCount,
    failedOrCancelledCount,
    totalOrdersCount: orders.length,
    diamondOrdersRevenueIdr,
    coinOrdersRevenueIdr,
    totalDiamondsCirculating: Number(econOverview.summary?.totalDiamondsCirculating || 0),
    totalCoinsCirculating,
    totalRefundsCount,
    totalTransactionsCount: allTxs.length,
    revenueByGateway,
    revenueByMethod,
    recentDailyRevenue: Array.from(dailyMap.values()),
    activeGateway: paymentGateway.getActiveGatewayName()
  };
}

function filterOrders(orders, query = {}) {
  const q = String(query.q || '').trim().toLowerCase();
  const kind = String(query.kind || 'all').trim().toLowerCase();
  const status = String(query.status || 'all').trim().toUpperCase();
  const gateway = String(query.gateway || 'all').trim().toLowerCase();
  const dateFrom = String(query.dateFrom || '').trim();
  const dateTo = String(query.dateTo || '').trim();

  return orders.filter(o => {
    if (kind !== 'all' && o.kind !== kind) return false;
    if (status !== 'ALL' && o.status !== status) return false;
    if (gateway !== 'all' && o.gateway !== gateway) return false;

    const wibDay = toWibDateKey(o.createdAt);
    if (dateFrom && wibDay && wibDay < dateFrom) return false;
    if (dateTo && wibDay && wibDay > dateTo) return false;

    if (q) {
      const hit =
        String(o.orderId || '').toLowerCase().includes(q) ||
        String(o.username || '').toLowerCase().includes(q) ||
        String(o.playerName || '').toLowerCase().includes(q) ||
        String(o.packageName || '').toLowerCase().includes(q) ||
        String(o.paymentMethodName || '').toLowerCase().includes(q) ||
        String(o.gatewayReference || '').toLowerCase().includes(q);
      if (!hit) return false;
    }
    return true;
  });
}

function registerAdminFinanceRoutes(router) {
  router.get('/admin/finance/summary', asyncRoute(async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    res.json({
      success: true,
      summary: computeFinanceSummary()
    });
  }));

  router.get('/admin/finance/orders', asyncRoute(async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const filtered = filterOrders(buildUnifiedOrders(), req.query);
    const filteredRevenueIdr = filtered
      .filter(o => o.status === 'PAID')
      .reduce((acc, o) => acc + Number(o.amountIdr || 0), 0);

    const pageSize = Math.min(100, Math.max(1, Number(req.query?.pageSize) || 20));
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(totalPages, Math.max(1, Number(req.query?.page) || 1));
    const start = (page - 1) * pageSize;
    const items = filtered.slice(start, start + pageSize);

    res.json({
      success: true,
      items,
      total,
      page,
      pageSize,
      totalPages,
      filteredRevenueIdr
    });
  }));

  router.get('/admin/finance/orders/export', asyncRoute(async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const filtered = filterOrders(buildUnifiedOrders(), req.query);
    const headers = [
      'Order ID',
      'Jenis',
      'Username',
      'Nama Pemain',
      'Paket',
      'Jumlah Item',
      'Nominal IDR',
      'Gateway',
      'Metode Pembayaran',
      'Status',
      'Referensi Gateway',
      'Tanggal Dibuat',
      'Tanggal Lunas'
    ];

    const lines = [headers.map(csvEscape).join(',')];
    for (const o of filtered) {
      lines.push(
        [
          o.orderId,
          o.kind === 'diamond' ? 'Diamonds' : 'Coins',
          o.username,
          o.playerName,
          o.packageName,
          o.rewardLabel,
          o.amountIdr,
          o.gateway,
          o.paymentMethodName,
          o.status,
          o.gatewayReference || '',
          o.createdAt || '',
          o.creditedAt || ''
        ]
          .map(csvEscape)
          .join(',')
      );
    }

    const today = toWibDateKey(Date.now()) || 'export';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="playgo-transactions-${today}.csv"`);
    res.send('\uFEFF' + lines.join('\r\n'));
  }));

  router.get('/admin/finance/orders/:kind/:orderId', asyncRoute(async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const kind = String(req.params.kind || '').trim().toLowerCase();
    const orderId = String(req.params.orderId || '').trim();
    const order = buildUnifiedOrders().find(o => o.kind === kind && o.orderId === orderId);
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order transaksi tidak ditemukan.' });
    }

    const callbackLogs = economy
      .listCallbackLogs()
      .filter(log => log.orderId === orderId)
      .slice(0, 30);

    res.json({ success: true, order, callbackLogs });
  }));

  router.post('/admin/finance/orders/:kind/:orderId/verify', adminMutationLimiter, asyncRoute(async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const kind = String(req.params.kind || '').trim().toLowerCase();
    const orderId = String(req.params.orderId || '').trim();

    if (kind === 'diamond') {
      const result = await economy.getAndVerifyOrderStatus({ orderId, requesterUser: admin });
      recordAdminAudit({
        adminUser: admin,
        action: 'ORDER_VERIFY_GATEWAY',
        targetType: 'order:diamond',
        targetId: orderId,
        summary: `Cek status gateway order ${orderId} -> ${result.order?.status}`
      });
      const updated = buildUnifiedOrders().find(o => o.kind === 'diamond' && o.orderId === orderId);
      return res.json({
        success: true,
        order: updated || result.order,
        verifiedWithGateway: Boolean(result.verifiedWithGateway)
      });
    }

    if (kind === 'coin') {
      const rawOrder = await db.getTopupOrder(orderId);
      if (!rawOrder) return res.status(404).json({ success: false, error: 'Order topup Coin tidak ditemukan.' });
      let verifiedWithGateway = false;

      if (rawOrder.status === 'pending') {
        const gwName = rawOrder.paymentDetails?.gateway || paymentGateway.getActiveGatewayName();
        const gwStatus = await paymentGateway.checkStatus(orderId, gwName);
        if (
          gwStatus &&
          (gwStatus.statusCode === '00' || gwStatus.status === '00' || gwStatus.resultCode === '00')
        ) {
          if (gwStatus.amount !== undefined && gwStatus.amount !== null && String(gwStatus.amount).trim() !== '') {
            const gwAmount = Number(gwStatus.amount);
            if (!Number.isFinite(gwAmount) || gwAmount <= 0 || gwAmount !== Number(rawOrder.grossAmount)) {
              return res.status(400).json({ success: false, error: 'Nominal di gateway tidak sesuai dengan nilai order.' });
            }
          }
          await db.completeTopupOrder(orderId, gwName);
          verifiedWithGateway = true;
        }
      }

      const updated = buildUnifiedOrders().find(o => o.kind === 'coin' && o.orderId === orderId);
      recordAdminAudit({
        adminUser: admin,
        action: 'ORDER_VERIFY_GATEWAY',
        targetType: 'order:coin',
        targetId: orderId,
        summary: `Cek status gateway order coin ${orderId} -> ${updated?.status}`
      });
      return res.json({ success: true, order: updated, verifiedWithGateway });
    }

    return res.status(400).json({ success: false, error: 'Jenis order harus diamond atau coin.' });
  }));

  router.post('/admin/finance/orders/:kind/:orderId/approve', adminMutationLimiter, asyncRoute(async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const kind = String(req.params.kind || '').trim().toLowerCase();
    const orderId = String(req.params.orderId || '').trim();
    const reason = String(req.body?.reason || '').trim();
    if (!reason) {
      return res.status(400).json({ success: false, error: 'Alasan approval manual wajib diisi untuk catatan audit.' });
    }

    if (kind === 'diamond') {
      const result = await economy.adminApproveOrder({ orderId, reason, adminUser: admin });
      const updated = buildUnifiedOrders().find(o => o.kind === 'diamond' && o.orderId === orderId);
      recordAdminAudit({
        adminUser: admin,
        action: 'ORDER_MANUAL_APPROVE',
        targetType: 'order:diamond',
        targetId: orderId,
        summary: `Menyetujui manual order ${orderId} (${reason})`,
        meta: { alreadyCredited: Boolean(result.alreadyCredited), reason }
      });
      return res.json({
        success: true,
        alreadyCredited: Boolean(result.alreadyCredited),
        order: updated || result.order,
        wallet: result.wallet
      });
    }

    if (kind === 'coin') {
      const rawOrder = await db.getTopupOrder(orderId);
      if (!rawOrder) return res.status(404).json({ success: false, error: 'Order topup Coin tidak ditemukan.' });
      if (rawOrder.status !== 'pending' && rawOrder.status !== 'success') {
        return res.status(400).json({ success: false, error: `Order berstatus ${rawOrder.status} tidak dapat disetujui manual.` });
      }
      const completed = await db.completeTopupOrder(orderId, `admin_manual:${admin.username}`);
      if (completed.error) {
        return res.status(400).json({ success: false, error: completed.error });
      }
      const updated = buildUnifiedOrders().find(o => o.kind === 'coin' && o.orderId === orderId);
      recordAdminAudit({
        adminUser: admin,
        action: 'ORDER_MANUAL_APPROVE',
        targetType: 'order:coin',
        targetId: orderId,
        summary: `Menyetujui manual order coin ${orderId} (${reason})`,
        meta: { alreadyCredited: Boolean(completed.alreadyCompleted), reason }
      });
      return res.json({
        success: true,
        alreadyCredited: Boolean(completed.alreadyCompleted),
        order: updated
      });
    }

    return res.status(400).json({ success: false, error: 'Jenis order harus diamond atau coin.' });
  }));

  router.post('/admin/finance/orders/:kind/:orderId/cancel', adminMutationLimiter, asyncRoute(async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const kind = String(req.params.kind || '').trim().toLowerCase();
    const orderId = String(req.params.orderId || '').trim();
    const reason = String(req.body?.reason || '').trim();
    if (!reason) {
      return res.status(400).json({ success: false, error: 'Alasan pembatalan wajib diisi untuk catatan audit.' });
    }

    if (kind === 'diamond') {
      await economy.adminCancelOrder({ orderId, reason, adminUser: admin });
      const updated = buildUnifiedOrders().find(o => o.kind === 'diamond' && o.orderId === orderId);
      recordAdminAudit({
        adminUser: admin,
        action: 'ORDER_CANCEL',
        targetType: 'order:diamond',
        targetId: orderId,
        summary: `Membatalkan order ${orderId} (${reason})`
      });
      return res.json({ success: true, order: updated });
    }

    if (kind === 'coin') {
      const resCancel = await db.adminCancelTopupOrder(orderId, reason);
      if (resCancel.error) {
        return res.status(resCancel.status || 400).json({ success: false, error: resCancel.error });
      }
      const updated = buildUnifiedOrders().find(o => o.kind === 'coin' && o.orderId === orderId);
      recordAdminAudit({
        adminUser: admin,
        action: 'ORDER_CANCEL',
        targetType: 'order:coin',
        targetId: orderId,
        summary: `Membatalkan order coin ${orderId} (${reason})`
      });
      return res.json({ success: true, order: updated });
    }

    return res.status(400).json({ success: false, error: 'Jenis order harus diamond atau coin.' });
  }));

  router.get('/admin/finance/ledger', asyncRoute(async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const q = String(req.query?.q || '').trim().toLowerCase();
    const txType = String(req.query?.txType || 'all').trim().toUpperCase();

    const enriched = economy
      .listAllDiamondTransactions()
      .map(tx => {
        const u = db.findUserById(tx.userId);
        return {
          ...tx,
          username: u?.username || tx.userId,
          playerName: u?.name || u?.username || tx.userId
        };
      })
      .filter(tx => {
        if (txType !== 'ALL' && tx.txType !== txType) return false;
        if (q) {
          const hit =
            String(tx.id || '').toLowerCase().includes(q) ||
            String(tx.username || '').toLowerCase().includes(q) ||
            String(tx.playerName || '').toLowerCase().includes(q) ||
            String(tx.description || '').toLowerCase().includes(q) ||
            String(tx.referenceId || '').toLowerCase().includes(q);
          if (!hit) return false;
        }
        return true;
      });

    const pageSize = Math.min(100, Math.max(1, Number(req.query?.pageSize) || 25));
    const total = enriched.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(totalPages, Math.max(1, Number(req.query?.page) || 1));
    const start = (page - 1) * pageSize;

    res.json({
      success: true,
      items: enriched.slice(start, start + pageSize),
      total,
      page,
      pageSize,
      totalPages
    });
  }));

  router.get('/admin/finance/callbacks', asyncRoute(async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const q = String(req.query?.q || '').trim().toLowerCase();
    const validOnly = String(req.query?.validOnly || 'all').trim().toLowerCase();
    const limit = Math.min(200, Math.max(1, Number(req.query?.limit) || 80));

    const logs = economy
      .listCallbackLogs()
      .filter(log => {
        if (validOnly === 'valid' && !log.signatureValid) return false;
        if (validOnly === 'invalid' && log.signatureValid) return false;
        if (q) {
          const hit =
            String(log.orderId || '').toLowerCase().includes(q) ||
            String(log.gateway || '').toLowerCase().includes(q) ||
            String(log.processingStatus || '').toLowerCase().includes(q) ||
            String(log.notes || '').toLowerCase().includes(q);
          if (!hit) return false;
        }
        return true;
      })
      .slice(0, limit);

    res.json({ success: true, logs });
  }));

  router.post('/admin/finance/adjust', adminMutationLimiter, asyncRoute(async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const {
      targetUser: rawTarget,
      userId: bodyUserId,
      username: bodyUsername,
      currency = 'diamonds',
      mode = 'delta',
      amount,
      txType = 'ADMIN_ADJUSTMENT',
      reason
    } = req.body || {};

    const lookupKey = String(rawTarget || bodyUserId || bodyUsername || '').trim().replace(/^@/, '');
    if (!lookupKey) {
      return res.status(400).json({ success: false, error: 'Target user (ID atau username) wajib diisi.' });
    }
    const target = db.findUserById(lookupKey) || db.findUserByUsername(lookupKey);
    if (!target) {
      return res.status(404).json({ success: false, error: `Pengguna "${lookupKey}" tidak ditemukan.` });
    }

    const cleanReason = String(reason || '').trim();
    if (!cleanReason) {
      return res.status(400).json({ success: false, error: 'Alasan penyesuaian wajib diisi untuk audit.' });
    }

    const cur = String(currency || 'diamonds').toLowerCase();

    if (cur === 'diamonds') {
      const result = await economy.adminAdjustDiamonds({
        targetUserId: target.id,
        amount: Number(amount),
        reason: cleanReason,
        txType: txType === 'REFUND' ? 'REFUND' : 'ADMIN_ADJUSTMENT',
        adminUser: admin
      });
      recordAdminAudit({
        adminUser: admin,
        action: 'FINANCE_ADJUST_DIAMONDS',
        targetType: 'user',
        targetId: target.id,
        summary: `Penyesuaian ${Number(amount) > 0 ? `+${amount}` : amount} Diamonds untuk @${target.username} (${cleanReason})`
      });
      return res.json({
        success: true,
        currency: 'diamonds',
        transaction: result.transaction,
        wallet: result.wallet,
        user: db.sanitizeUser(db.findUserById(target.id))
      });
    }

    if (cur === 'coins') {
      const parsedAmt = Number(amount);
      if (!Number.isInteger(parsedAmt)) {
        return res.status(400).json({ success: false, error: 'Jumlah Coins harus bilangan bulat.' });
      }
      if (mode === 'set') {
        if (parsedAmt < 0 || parsedAmt > 100000000) {
          return res.status(400).json({ success: false, error: 'Nilai Coins harus antara 0 dan 100.000.000.' });
        }
        const prevCoins = db.getUserPoints(target.id);
        await db.setUserPoints(target.id, parsedAmt);
        recordAdminAudit({
          adminUser: admin,
          action: 'FINANCE_SET_COINS',
          targetType: 'user',
          targetId: target.id,
          summary: `Atur Coins @${target.username}: ${prevCoins} -> ${parsedAmt} (${cleanReason})`
        });
        return res.json({
          success: true,
          currency: 'coins',
          previousCoins: prevCoins,
          currentCoins: parsedAmt,
          user: db.sanitizeUser(db.findUserById(target.id))
        });
      }

      const adjRes = await db.adjustUserPoints(target.id, parsedAmt);
      if (adjRes.error) {
        return res.status(adjRes.status || 400).json({ success: false, error: adjRes.error });
      }
      recordAdminAudit({
        adminUser: admin,
        action: 'FINANCE_ADJUST_COINS',
        targetType: 'user',
        targetId: target.id,
        summary: `Penyesuaian ${parsedAmt > 0 ? `+${parsedAmt}` : parsedAmt} Coins @${target.username}: ${adjRes.previous} -> ${adjRes.current} (${cleanReason})`
      });
      return res.json({
        success: true,
        currency: 'coins',
        previousCoins: adjRes.previous,
        currentCoins: adjRes.current,
        user: adjRes.user
      });
    }

    return res.status(400).json({ success: false, error: 'Mata uang harus diamonds atau coins.' });
  }));
}

module.exports = {
  buildUnifiedOrders,
  computeFinanceSummary,
  registerAdminFinanceRoutes
};
