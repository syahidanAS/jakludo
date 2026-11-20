'use strict';

const db = require('../db');
const items = require('../items');
const store = require('../game/store');
const inventory = require('../game/inventory');
const quizEngine = require('../quiz/engine');
const economy = require('../economy/store');
const { requireAdmin, adminMutationLimiter, asyncRoute, recordAdminAudit } = require('./middleware');
const { findActiveRoomForUser } = require('./rooms');
const { buildUnifiedOrders } = require('./finance');

function computeUsersSummary(usersList = db.listAllUsers()) {
  let adminCount = 0;
  let playerCount = 0;
  let googleCount = 0;
  let totalCoins = 0;
  let totalDiamonds = 0;

  for (const u of usersList) {
    if (u.isAdmin || u.role === 'admin') adminCount++;
    else playerCount++;
    if (u.googleLinked || u.authType === 'google') googleCount++;
    totalCoins += Number(u.points || 0);
    totalDiamonds += Number(u.diamonds || 0);
  }

  return {
    totalUsers: usersList.length,
    adminCount,
    playerCount,
    googleCount,
    totalCoins,
    totalDiamonds
  };
}

function syncUserInventoryToLiveGames(userId) {
  const owned = db.getUserItems(userId);
  for (const r of store.rooms.values()) {
    const p = (r.players || []).find(pl => pl.userId === userId);
    if (p) {
      inventory.loadOwned(p, owned);
      store.emitRoom(r);
    }
  }
  quizEngine.syncUserInventory(userId);
}

function syncUserNameToLiveGames(userId, nextName) {
  if (!nextName) return;
  for (const r of store.rooms.values()) {
    const p = (r.players || []).find(pl => pl.userId === userId);
    if (p && p.name !== nextName) {
      p.name = nextName;
      store.emitRoom(r);
    }
  }
}

function registerAdminUserRoutes(router) {
  router.get('/admin/users', asyncRoute(async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const allUsers = db.listAllUsers();
    const summary = computeUsersSummary(allUsers);

    const q = String(req.query?.q || '').trim().toLowerCase();
    const roleFilter = String(req.query?.role || 'all').trim().toLowerCase();
    const authFilter = String(req.query?.authType || 'all').trim().toLowerCase();
    const sortBy = String(req.query?.sortBy || 'createdAt').trim();
    const sortDir = String(req.query?.sortDir || 'desc').trim().toLowerCase() === 'asc' ? 1 : -1;

    let filtered = allUsers.filter(u => {
      if (roleFilter === 'admin' && !u.isAdmin) return false;
      if (roleFilter === 'player' && u.isAdmin) return false;
      if (authFilter === 'google' && !u.googleLinked && u.authType !== 'google') return false;
      if (authFilter === 'password' && u.authType !== 'password') return false;
      if (q) {
        const hit =
          String(u.id || '').toLowerCase().includes(q) ||
          String(u.username || '').toLowerCase().includes(q) ||
          String(u.name || '').toLowerCase().includes(q) ||
          String(u.email || '').toLowerCase().includes(q) ||
          String(u.referralCode || '').toLowerCase().includes(q);
        if (!hit) return false;
      }
      return true;
    });

    filtered.sort((a, b) => {
      if (sortBy === 'points' || sortBy === 'coins') {
        return (Number(a.points || 0) - Number(b.points || 0)) * sortDir;
      }
      if (sortBy === 'diamonds') {
        return (Number(a.diamonds || 0) - Number(b.diamonds || 0)) * sortDir;
      }
      if (sortBy === 'wins') {
        return (Number(a.wins || 0) - Number(b.wins || 0)) * sortDir;
      }
      if (sortBy === 'username') {
        return String(a.username || '').localeCompare(String(b.username || '')) * sortDir;
      }
      return ((Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0)) * sortDir;
    });

    const pageSize = Math.min(100, Math.max(1, Number(req.query?.pageSize) || 20));
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(totalPages, Math.max(1, Number(req.query?.page) || 1));
    const start = (page - 1) * pageSize;

    res.json({
      success: true,
      items: filtered.slice(start, start + pageSize),
      total,
      page,
      pageSize,
      totalPages,
      summary
    });
  }));

  router.get('/admin/users/:id', asyncRoute(async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const lookup = String(req.params.id || '').trim();
    const target = db.findUserById(lookup) || db.findUserByUsername(lookup.replace(/^@/, ''));
    if (!target) {
      return res.status(404).json({ success: false, error: 'Pengguna tidak ditemukan.' });
    }

    const detailed = db.listAllUsers().find(u => u.id === target.id) || db.sanitizeUser(target);
    const recentOrders = buildUnifiedOrders()
      .filter(o => o.userId === target.id)
      .slice(0, 20);
    const txHistory = economy.listUserTransactions(target.id, { limit: 20 });

    res.json({
      success: true,
      user: detailed,
      inventory: db.getUserItems(target.id),
      itemCatalog: items.catalog ? items.catalog() : [],
      referralInfo: db.getReferralInfo(target.id),
      activeRoom: findActiveRoomForUser(target.id),
      recentOrders,
      recentTransactions: txHistory.transactions || [],
      coinConversions: txHistory.conversions || [],
      wallet: economy.formatWalletResponse(target.id)
    });
  }));

  router.post('/admin/users', adminMutationLimiter, asyncRoute(async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const { username, name, password, email, role, points, coins, diamonds } = req.body || {};
    const initialCoins = points !== undefined && points !== '' && points !== null ? points : coins;
    const initialDiamonds = diamonds !== undefined && diamonds !== '' && diamonds !== null ? Number(diamonds) : 0;

    if (!Number.isInteger(initialDiamonds) || initialDiamonds < 0 || initialDiamonds > 10000000) {
      return res.status(400).json({ success: false, error: 'Saldo Diamonds awal harus bilangan bulat >= 0.' });
    }

    const created = await db.adminCreateUser({
      username,
      name,
      password,
      email,
      role,
      points: initialCoins
    });
    if (created.error) {
      return res.status(created.status || 400).json({ success: false, error: created.error });
    }

    if (initialDiamonds > 0) {
      await economy.adminAdjustDiamonds({
        targetUserId: created.user.id,
        amount: initialDiamonds,
        reason: `Saldo awal pembuatan akun oleh Admin (@${admin.username})`,
        txType: 'ADMIN_ADJUSTMENT',
        adminUser: admin
      });
    }

    const freshUser = db.listAllUsers().find(u => u.id === created.user.id) || db.sanitizeUser(db.findUserById(created.user.id));

    recordAdminAudit({
      adminUser: admin,
      action: 'USER_CREATE',
      targetType: 'user',
      targetId: freshUser.id,
      summary: `Membuat user baru @${freshUser.username} (role: ${freshUser.role}, coins: ${freshUser.points}, diamonds: ${freshUser.diamonds})`
    });

    res.status(201).json({ success: true, user: freshUser });
  }));

  router.patch('/admin/users/:id', adminMutationLimiter, asyncRoute(async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const lookup = String(req.params.id || '').trim();
    const target = db.findUserById(lookup) || db.findUserByUsername(lookup.replace(/^@/, ''));
    if (!target) {
      return res.status(404).json({ success: false, error: 'Pengguna tidak ditemukan.' });
    }

    const body = req.body || {};
    const {
      name,
      username,
      email,
      role,
      newPassword,
      points,
      coins,
      diamonds,
      diamondReason,
      items: bodyItems,
      authType
    } = body;

    if (target.id === admin.id && role !== undefined && role !== 'admin') {
      return res.status(400).json({ success: false, error: 'Tidak dapat menurunkan role akun admin Anda sendiri.' });
    }

    if (db.isUserAdmin(target) && role === 'player') {
      const adminCount = db.listAllUsers().filter(u => u.isAdmin).length;
      if (adminCount <= 1) {
        return res.status(400).json({ success: false, error: 'Minimal harus tersisa 1 akun admin aktif.' });
      }
    }

    if (diamonds !== undefined && diamonds !== '' && diamonds !== null) {
      const parsedDiamonds = Number(diamonds);
      if (!Number.isInteger(parsedDiamonds) || parsedDiamonds < 0 || parsedDiamonds > 10000000) {
        return res.status(400).json({ success: false, error: 'Diamonds harus bilangan bulat >= 0.' });
      }
    }

    const cleanQuantities = {};
    if (bodyItems && typeof bodyItems === 'object') {
      for (const [itemId, qty] of Object.entries(bodyItems)) {
        if (!items.get(itemId)) {
          return res.status(400).json({ success: false, error: `Item ${itemId} tidak dikenal.` });
        }
        const parsedQty = Number(qty);
        if (!Number.isInteger(parsedQty) || parsedQty < 0 || parsedQty > 100000) {
          return res.status(400).json({ success: false, error: `Jumlah item ${itemId} harus bilangan bulat 0..100000.` });
        }
        cleanQuantities[itemId] = parsedQty;
      }
    }

    const nextCoins = points !== undefined ? points : coins;
    const updated = await db.adminUpdateUser(target.id, {
      name,
      username,
      email,
      role,
      newPassword,
      points: nextCoins,
      authType
    });
    if (updated.error) {
      return res.status(updated.status || 400).json({ success: false, error: updated.error });
    }

    if (diamonds !== undefined && diamonds !== '' && diamonds !== null) {
      const curDiamonds = economy.getDiamondBalanceSync(target.id);
      const deltaDiamonds = Number(diamonds) - curDiamonds;
      if (deltaDiamonds !== 0) {
        await economy.adminAdjustDiamonds({
          targetUserId: target.id,
          amount: deltaDiamonds,
          reason: String(diamondReason || '').trim() || `Penyesuaian saldo via Edit User Admin CMS (@${admin.username})`,
          txType: 'ADMIN_ADJUSTMENT',
          adminUser: admin
        });
      }
    }

    if (Object.keys(cleanQuantities).length > 0) {
      await db.setUserItemQuantities(target.id, cleanQuantities);
      syncUserInventoryToLiveGames(target.id);
    }

    if (name !== undefined) {
      syncUserNameToLiveGames(target.id, updated.user.name);
    }

    const freshUser = db.listAllUsers().find(u => u.id === target.id) || db.sanitizeUser(db.findUserById(target.id));

    recordAdminAudit({
      adminUser: admin,
      action: 'USER_UPDATE',
      targetType: 'user',
      targetId: freshUser.id,
      summary: `Mengubah data @${freshUser.username} (role: ${freshUser.role}, coins: ${freshUser.points}, diamonds: ${freshUser.diamonds}${newPassword ? ', password direset' : ''})`
    });

    res.json({
      success: true,
      user: freshUser,
      inventory: db.getUserItems(target.id)
    });
  }));

  router.delete('/admin/users/:id', adminMutationLimiter, asyncRoute(async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const lookup = String(req.params.id || '').trim();
    const target = db.findUserById(lookup) || db.findUserByUsername(lookup.replace(/^@/, ''));
    if (!target) {
      return res.status(404).json({ success: false, error: 'Pengguna tidak ditemukan.' });
    }

    if (target.id === admin.id) {
      return res.status(400).json({ success: false, error: 'Tidak dapat menghapus akun admin Anda sendiri yang sedang login.' });
    }

    if (db.isUserAdmin(target)) {
      const adminCount = db.listAllUsers().filter(u => u.isAdmin).length;
      if (adminCount <= 1) {
        return res.status(400).json({ success: false, error: 'Minimal harus tersisa 1 akun admin aktif.' });
      }
    }

    const deleted = await db.adminDeleteUser(target.id);
    if (deleted.error) {
      return res.status(deleted.status || 400).json({ success: false, error: deleted.error });
    }
    economy.purgeUserInMemory(target.id);

    recordAdminAudit({
      adminUser: admin,
      action: 'USER_DELETE',
      targetType: 'user',
      targetId: target.id,
      summary: `Menghapus akun @${target.username} secara permanen`
    });

    res.json({ success: true, deletedUserId: target.id, username: target.username });
  }));

  router.post('/admin/users/:id/revoke-sessions', adminMutationLimiter, asyncRoute(async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const lookup = String(req.params.id || '').trim();
    const target = db.findUserById(lookup) || db.findUserByUsername(lookup.replace(/^@/, ''));
    if (!target) {
      return res.status(404).json({ success: false, error: 'Pengguna tidak ditemukan.' });
    }

    const result = await db.revokeUserSessions(target.id);
    recordAdminAudit({
      adminUser: admin,
      action: 'USER_REVOKE_SESSIONS',
      targetType: 'user',
      targetId: target.id,
      summary: `Mencabut ${result.revokedCount} sesi login @${target.username}`
    });

    res.json({
      success: true,
      userId: target.id,
      revokedCount: result.revokedCount
    });
  }));
}

module.exports = {
  computeUsersSummary,
  registerAdminUserRoutes
};
