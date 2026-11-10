// REST API: autentikasi, leaderboard, room aktif, dan toko item.
const express = require('express');
const db = require('../db');
const items = require('../items');
const inventory = require('../game/inventory');
const store = require('../game/store');
const { createLimiter } = require('../lib/limiter');
const { registerSocialRoutes } = require('../social/routes');

const loginLimiter = createLimiter({ windowMs: 10 * 60 * 1000, max: 20 });
const registerLimiter = createLimiter({ windowMs: 60 * 60 * 1000, max: Number(process.env.REGISTER_RATE_LIMIT || 30) });

function bearerToken(req) {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
}

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const withKing = user => ({ ...user, isLudoKing: db.checkIsLudoKing(user.id) });

function requireUser(req, res, message = 'Silakan login terlebih dahulu.') {
  const user = db.getUserByToken(bearerToken(req) || String(req.body?.token || ''));
  if (!user) res.status(401).json({ success: false, error: message });
  return user;
}

function createApiRouter() {
  const api = express.Router();

  api.post('/auth/register', asyncRoute(async (req, res) => {
    if (!registerLimiter(req.ip)) {
      return res.status(429).json({ success: false, error: 'Terlalu banyak pendaftaran dari jaringan ini. Coba lagi nanti.' });
    }
    const { username, password, name } = req.body || {};
    const result = await db.registerUser({ username, password, name });
    if (result.error) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, user: withKing(result.user), token: result.token });
  }));

  api.post('/auth/login', asyncRoute(async (req, res) => {
    const { username, password } = req.body || {};
    if (!loginLimiter(`${req.ip}:${String(username || '').toLowerCase()}`)) {
      return res.status(429).json({ success: false, error: 'Terlalu banyak percobaan login. Coba lagi dalam 10 menit.' });
    }
    const result = await db.loginUser({ username, password });
    if (result.error) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, user: withKing(result.user), token: result.token });
  }));

  api.post('/auth/logout', (req, res) => {
    db.deleteSession(bearerToken(req));
    res.json({ success: true });
  });

  api.get('/auth/me', (req, res) => {
    const user = requireUser(req, res, 'Unauthorized / Sesi telah kedaluwarsa.');
    if (!user) return;
    res.json({ success: true, user: withKing(db.sanitizeUser(user)) });
  });

  // Room yang masih aktif milik user (dibuat atau diikuti), agar bisa masuk lagi dari perangkat mana pun
  api.get('/rooms/active', (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;

    const list = [];
    for (const r of store.rooms.values()) {
      if (r.winner) continue;
      const me = r.players.find(p => p.userId === user.id && !p.left && !p.isOut);
      if (!me) continue;
      list.push({
        code: r.code,
        started: r.started,
        isCreator: r.creatorUserId === user.id,
        myColor: me.color,
        players: r.players.map(p => ({ name: p.name, color: p.color, isBot: !!p.isBot, connected: !!p.isBot || !!p.connected })),
        updatedAt: r.updatedAt || 0
      });
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    res.json({ success: true, rooms: list });
  });

  api.get('/leaderboard', (req, res) => {
    const leaderboard = db.getLeaderboard();
    const ludoKing = leaderboard[0] && leaderboard[0].isLudoKing ? leaderboard[0] : null;
    res.json({ success: true, leaderboard, ludoKing });
  });

  // Katalog toko dibaca dari registry item (server/items)
  api.get('/shop/items', (req, res) => {
    res.json({ success: true, items: items.catalog() });
  });

  api.post('/shop/buy', (req, res) => {
    const user = requireUser(req, res, 'Silakan login terlebih dahulu untuk berbelanja.');
    if (!user) return;

    const item = items.get(req.body?.itemId || req.body?.itemType);
    if (!item) return res.status(400).json({ success: false, error: 'Item toko tidak valid.' });

    const result = db.purchaseItem({ userId: user.id, itemId: item.id, price: item.price });
    if (result.error) return res.status(400).json({ success: false, error: result.error });

    // Sinkronkan stok jika user sedang berada di room aktif
    for (const r of store.rooms.values()) {
      const playerInRoom = r.players.find(p => p.userId === user.id);
      if (playerInRoom) {
        inventory.loadOwned(playerInRoom, result.user.inventory);
        store.emitRoom(r);
      }
    }

    res.json({
      success: true,
      message: `Berhasil membeli ${item.name}!`,
      item: items.catalog().find(i => i.id === item.id),
      user: withKing(result.user)
    });
  });

  registerSocialRoutes(api);

  api.use((req, res) => res.status(404).json({ success: false, error: 'Endpoint tidak ditemukan.' }));

  return api;
}

module.exports = { createApiRouter };
