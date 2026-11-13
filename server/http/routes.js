// REST API: autentikasi, leaderboard, room aktif, dan toko item.
const express = require('express');
const db = require('../db');
const items = require('../items');
const inventory = require('../game/inventory');
const store = require('../game/store');
const { createLimiter } = require('../lib/limiter');
const { verifyGoogleIdToken, exchangeGoogleAuthCode } = require('../lib/googleAuth');
const { loadDotEnv } = require('../migrate');
const { registerSocialRoutes } = require('../social/routes');
const { registerQuizRoutes } = require('../quiz/routes');
const quizEngine = require('../quiz/engine');
const social = require('../social/store');
const doku = require('../lib/doku');
const midtrans = require('../lib/midtrans');

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

  api.get('/auth/google/config', (req, res) => {
    loadDotEnv(true);
    const clientId = process.env.GOOGLE_CLIENT_ID || '';
    res.json({
      success: true,
      enabled: Boolean(clientId),
      clientId
    });
  });

  api.post('/auth/google', asyncRoute(async (req, res) => {
    loadDotEnv(true);
    const { credential, code, redirectUri, testUser } = req.body || {};

    let googleProfile;
    if (testUser && process.env.NODE_ENV === 'test') {
      googleProfile = testUser;
    } else if (code) {
      const verified = await exchangeGoogleAuthCode(code, redirectUri);
      if (verified.error) {
        return res.status(401).json({ success: false, error: verified.error });
      }
      googleProfile = verified;
    } else {
      if (!credential || typeof credential !== 'string') {
        return res.status(400).json({ success: false, error: 'Kredensial token atau kode Google wajib disertakan.' });
      }
      const verified = await verifyGoogleIdToken(credential);
      if (verified.error) {
        return res.status(401).json({ success: false, error: verified.error });
      }
      googleProfile = verified;
    }

    const result = await db.loginOrRegisterGoogleUser({
      googleId: googleProfile.googleId,
      email: googleProfile.email,
      name: googleProfile.name,
      avatar: googleProfile.picture
    });

    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }

    res.json({
      success: true,
      user: withKing(result.user),
      token: result.token,
      isNewUser: Boolean(result.isNewUser)
    });
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

  const handleUpdateProfile = asyncRoute(async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const { name, username, email, currentPassword, newPassword } = req.body || {};
    const result = await db.updateUserProfile(user.id, { name, username, email, currentPassword, newPassword });
    if (result.error) return res.status(400).json({ success: false, error: result.error });

    if (result.user?.name) {
      for (const room of store.rooms.values()) {
        const player = room.players.find(p => p.userId === user.id);
        if (player) player.name = result.user.name;
      }
    }

    res.json({ success: true, user: withKing(result.user) });
  });

  api.put('/auth/profile', handleUpdateProfile);
  api.patch('/auth/profile', handleUpdateProfile);
  api.post('/auth/profile', handleUpdateProfile);

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

  api.get('/leaderboard', asyncRoute(async (req, res) => {
    const groupId = typeof req.query.groupId === 'string' && req.query.groupId.trim()
      ? req.query.groupId.trim()
      : null;

    if (groupId) {
      const user = requireUser(req, res);
      if (!user) return;
      const result = await social.getGroupLeaderboard(groupId, user.id);
      if (result.error) return res.status(result.status || 400).json({ success: false, error: result.error });
      return res.json({ success: true, groupId, leaderboard: result.leaderboard, ludoKing: null });
    }

    const leaderboard = await db.queryGlobalLeaderboard();
    const ludoKing = leaderboard[0] && leaderboard[0].isLudoKing ? leaderboard[0] : null;
    res.json({ success: true, leaderboard, ludoKing });
  }));

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
    quizEngine.syncUserInventory(user.id);

    res.json({
      success: true,
      message: `Berhasil membeli ${item.name}!`,
      item: items.catalog().find(i => i.id === item.id),
      user: withKing(result.user)
    });
  });

  // ==========================================
  // TOPUP DIAMONDS (MIDTRANS SNAP POPUP)
  // ==========================================

  api.get('/topup/config', (req, res) => {
    const config = midtrans.getMidtransConfig();
    res.json({
      success: true,
      gateway: 'midtrans_snap',
      packages: Object.values(midtrans.DIAMOND_PACKAGES),
      snapJsUrl: config.snapJsUrl,
      clientKey: config.clientKey,
      isProduction: config.isProduction,
      isConfigured: config.isConfigured
    });
  });

  // Buat transaksi pembayaran Midtrans Snap
  api.post(['/topup/create', '/topup/charge'], asyncRoute(async (req, res) => {
    const user = requireUser(req, res, 'Silakan login terlebih dahulu untuk melakukan topup diamonds.');
    if (!user) return;

    const { packageId } = req.body || {};
    const pkg = midtrans.DIAMOND_PACKAGES[packageId];
    if (!pkg) {
      return res.status(400).json({ success: false, error: 'Paket diamond tidak valid.' });
    }

    const orderId = `TOPUP-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

    try {
      const snapRes = await midtrans.createSnapTransaction({
        orderId,
        pkg,
        user
      });

      await db.createTopupOrder({
        orderId,
        userId: user.id,
        packageId: pkg.id,
        diamonds: pkg.diamonds,
        grossAmount: pkg.price,
        paymentType: 'midtrans_snap',
        paymentDetails: snapRes
      });

      res.json({
        success: true,
        orderId,
        package: pkg,
        snapToken: snapRes.token || snapRes.snapToken,
        token: snapRes.token || snapRes.snapToken,
        redirectUrl: snapRes.redirectUrl,
        clientKey: snapRes.clientKey,
        snapJsUrl: snapRes.snapJsUrl,
        payment: snapRes,
        isSimulation: snapRes.isSimulation || false
      });
    } catch (err) {
      console.error('[TOPUP SNAP ERROR]', err.message);
      res.status(500).json({ success: false, error: err.message || 'Gagal memproses pembayaran Midtrans Snap.' });
    }
  }));

  // Ambil detail pembayaran order yang sedang aktif
  api.get('/topup/order/:orderId', asyncRoute(async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;

    const order = await db.getTopupOrder(req.params.orderId);
    if (!order || order.userId !== user.id) {
      return res.status(404).json({ success: false, error: 'Order tidak ditemukan.' });
    }
    res.json({ success: true, order });
  }));

  // Webhook notifikasi Doku & Midtrans
  api.post('/topup/notification', asyncRoute(async (req, res) => {
    const notif = req.body || {};
    const orderId = notif.order?.invoice_number || notif.invoice_number || notif.order_id;

    if (!orderId) {
      return res.status(400).json({ status: 'ERROR', message: 'order_id or invoice_number missing' });
    }

    // 1. Cek apakah notifikasi berasal dari Doku (Jokul)
    const isDoku = Boolean(notif.service || notif.channel || notif.order?.invoice_number || req.headers['client-id']);
    if (isDoku) {
      const dokuConfig = doku.getDokuConfig();
      if (dokuConfig.secretKey) {
        const isValid = doku.verifyDokuSignature({
          headers: req.headers,
          body: notif,
          rawBody: JSON.stringify(notif)
        });
        if (!isValid && req.headers['signature']) {
          console.warn('[DOKU NOTIFICATION] Invalid signature for order', orderId);
          return res.status(403).json({ status: 'ERROR', message: 'Invalid Doku signature' });
        }
      }

      const isDokuSuccess =
        notif.transaction?.status === 'SUCCESS' ||
        notif.transaction_status === 'SUCCESS' ||
        notif.status === 'SUCCESS';

      if (isDokuSuccess) {
        const paymentType = notif.channel?.id || notif.payment_type || 'doku';
        await db.completeTopupOrder(orderId, paymentType);
      }

      return res.json({ status: 'OK' });
    }

    // 2. Fallback untuk Midtrans notification
    const statusCode = notif.status_code;
    const grossAmount = notif.gross_amount;
    const signatureKey = notif.signature_key;
    const transactionStatus = notif.transaction_status;
    const fraudStatus = notif.fraud_status;
    const paymentType = notif.payment_type;

    const midtransConfig = midtrans.getMidtransConfig();
    if (midtransConfig.serverKey && !midtrans.verifySignature({ orderId, statusCode, grossAmount, signatureKey })) {
      console.warn('[MIDTRANS NOTIFICATION] Invalid signature for order', orderId);
      return res.status(403).json({ status: 'ERROR', message: 'Invalid signature' });
    }

    const isSuccess =
      transactionStatus === 'settlement' ||
      (transactionStatus === 'capture' && fraudStatus === 'accept');

    if (isSuccess) {
      await db.completeTopupOrder(orderId, paymentType || 'midtrans');
    }

    res.json({ status: 'OK' });
  }));

  // Verifikasi status order oleh client (polling berkala selama pembayaran aktif)
  api.post('/topup/verify', asyncRoute(async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;

    const { orderId } = req.body || {};
    if (!orderId) {
      return res.status(400).json({ success: false, error: 'Order ID wajib diisi.' });
    }

    const order = await db.getTopupOrder(orderId);
    if (!order || order.userId !== user.id) {
      return res.status(404).json({ success: false, error: 'Order topup tidak ditemukan.' });
    }

    if (order.status === 'success') {
      const freshUser = db.sanitizeUser(db.getUserById(user.id));
      return res.json({ success: true, status: 'success', user: withKing(freshUser), diamonds: order.diamonds });
    }

    // Coba polling status ke Doku Status API / Midtrans Status API secara realtime
    try {
      const dokuStatus = await doku.checkDokuStatus(orderId);
      if (dokuStatus) {
        const isDokuSuccess =
          dokuStatus.transaction?.status === 'SUCCESS' ||
          dokuStatus.order?.status === 'SUCCESS' ||
          dokuStatus.status === 'SUCCESS';

        if (isDokuSuccess) {
          const completed = await db.completeTopupOrder(orderId, 'doku');
          return res.json({
            success: true,
            status: 'success',
            user: withKing(completed.user),
            diamonds: order.diamonds
          });
        }
      }

      const midtransStatus = await midtrans.checkMidtransStatus(orderId);
      if (midtransStatus) {
        const isSuccess =
          midtransStatus.transaction_status === 'settlement' ||
          (midtransStatus.transaction_status === 'capture' && midtransStatus.fraud_status === 'accept');

        if (isSuccess) {
          const completed = await db.completeTopupOrder(orderId, midtransStatus.payment_type || 'midtrans');
          return res.json({
            success: true,
            status: 'success',
            user: withKing(completed.user),
            diamonds: order.diamonds
          });
        }
      }
    } catch (err) {
      console.warn('[TOPUP VERIFY STATUS CHECK ERROR]', err.message);
    }

    res.json({ success: true, status: order.status, message: 'Transaksi masih menunggu pembayaran.' });
  }));

  // Simulasi pembayaran (HANYA aktif pada mode pengujian internal NODE_ENV === 'test')
  api.post('/topup/simulate', asyncRoute(async (req, res) => {
    if (process.env.NODE_ENV !== 'test') {
      return res.status(403).json({ success: false, error: 'Simulasi pembayaran dinonaktifkan di environment ini.' });
    }

    const user = requireUser(req, res);
    if (!user) return;

    const { orderId } = req.body || {};
    if (!orderId) {
      return res.status(400).json({ success: false, error: 'Order ID wajib diisi.' });
    }

    const order = await db.getTopupOrder(orderId);
    if (!order || order.userId !== user.id) {
      return res.status(404).json({ success: false, error: 'Order topup tidak ditemukan.' });
    }

    const result = await db.completeTopupOrder(orderId, 'simulated');
    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }

    res.json({
      success: true,
      message: `Topup berhasil! +${order.diamonds} Diamonds telah ditambahkan ke akunmu.`,
      order: result.order,
      diamondsAwarded: order.diamonds,
      user: withKing(result.user)
    });
  }));

  registerSocialRoutes(api);
  registerQuizRoutes(api);

  api.use((req, res) => res.status(404).json({ success: false, error: 'Endpoint tidak ditemukan.' }));

  return api;
}

module.exports = { createApiRouter };
