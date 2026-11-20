// REST API: autentikasi, leaderboard, room aktif, dan toko item.
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const items = require('../items');
const inventory = require('../game/inventory');
const store = require('../game/store');
const { createLimiter } = require('../lib/limiter');
const { verifyGoogleIdToken, exchangeGoogleAuthCode } = require('../lib/googleAuth');
const { loadDotEnv, reloadDotEnvIfChanged } = require('../migrate');
const { registerSocialRoutes } = require('../social/routes');
const { registerQuizRoutes } = require('../quiz/routes');
const { registerChessRoutes } = require('../chess/routes');
const { registerSnakesRoutes } = require('../snakes/routes');
const { registerEconomyRoutes } = require('../economy/routes');
const { registerAdminRoutes } = require('../admin/routes');
const { recordAdminAudit } = require('../admin/middleware');
const quizEngine = require('../quiz/engine');
const social = require('../social/store');
const paymentGateway = require('../lib/paymentGateway');
const economy = require('../economy/store');
const recaptcha = require('../lib/recaptcha');

const loginLimiter = createLimiter({ windowMs: 10 * 60 * 1000, max: 20 });
const registerLimiter = createLimiter({ windowMs: 60 * 60 * 1000, max: Number(process.env.REGISTER_RATE_LIMIT || 30) });
const googleAuthLimiter = createLimiter({ windowMs: 10 * 60 * 1000, max: Number(process.env.GOOGLE_AUTH_RATE_LIMIT || 30) });
const basicRegisterLimiter = createLimiter({ windowMs: 10 * 60 * 1000, max: Number(process.env.BASIC_REGISTER_RATE_LIMIT || 60) });

function safeEqualString(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a || ''), 'utf8').digest();
  const hashB = crypto.createHash('sha256').update(String(b || ''), 'utf8').digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function verifyBasicAuthRegister(req, res) {
  if (process.env.NODE_ENV !== 'test') {
    reloadDotEnvIfChanged();
  }
  const expectedUser = String(process.env.BASIC_AUTH_REGISTER_USER || '').trim();
  const expectedPass = String(process.env.BASIC_AUTH_REGISTER_PASS || '');

  if (!expectedUser || !expectedPass) {
    res.status(503).json({
      success: false,
      error: 'Basic Auth register API belum dikonfigurasi. Set BASIC_AUTH_REGISTER_USER dan BASIC_AUTH_REGISTER_PASS di .env.'
    });
    return null;
  }

  const rawAuth = String(req.headers.authorization || '').trim();
  const match = /^Basic\s+(.+)$/i.exec(rawAuth);
  if (!match) {
    res.setHeader('WWW-Authenticate', 'Basic realm="PlayGo Register API"');
    res.status(401).json({ success: false, error: 'Autentikasi Basic Auth tidak valid.' });
    return null;
  }

  let decoded = '';
  try {
    decoded = Buffer.from(match[1].trim(), 'base64').toString('utf8');
  } catch {
    res.setHeader('WWW-Authenticate', 'Basic realm="PlayGo Register API"');
    res.status(401).json({ success: false, error: 'Autentikasi Basic Auth tidak valid.' });
    return null;
  }

  const colonIdx = decoded.indexOf(':');
  if (colonIdx === -1) {
    res.setHeader('WWW-Authenticate', 'Basic realm="PlayGo Register API"');
    res.status(401).json({ success: false, error: 'Autentikasi Basic Auth tidak valid.' });
    return null;
  }

  const providedUser = decoded.slice(0, colonIdx);
  const providedPass = decoded.slice(colonIdx + 1);

  if (!safeEqualString(providedUser, expectedUser) || !safeEqualString(providedPass, expectedPass)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="PlayGo Register API"');
    res.status(401).json({ success: false, error: 'Autentikasi Basic Auth tidak valid.' });
    return null;
  }

  return { authenticatedUser: expectedUser };
}

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

// Admin sesuai role akun (kolom users.role atau username di ADMIN_USERNAMES, lihat db.isUserAdmin)
function requireAdmin(req, res) {
  const user = requireUser(req, res);
  if (!user) return null;
  if (!db.isUserAdmin(user)) {
    res.status(403).json({ success: false, error: 'Akses ditolak: khusus admin.' });
    return null;
  }
  return user;
}

// Stok item pemain di cache server berubah: samakan juga ke room Ludo & kuis yang sedang berjalan
function syncUserItemsToRooms(userId) {
  const owned = db.getUserItems(userId);
  for (const r of store.rooms.values()) {
    const playerInRoom = r.players.find(p => p.userId === userId);
    if (playerInRoom) {
      inventory.loadOwned(playerInRoom, owned);
      store.emitRoom(r);
    }
  }
  quizEngine.syncUserInventory(userId);
}

function createApiRouter() {
  const api = express.Router();

  api.post('/auth/register', asyncRoute(async (req, res) => {
    if (!registerLimiter(req.ip)) {
      return res.status(429).json({ success: false, error: 'Terlalu banyak pendaftaran dari jaringan ini. Coba lagi nanti.' });
    }
    const { username, password, name, recaptchaToken, referralCode } = req.body || {};

    const captchaRes = await recaptcha.verifyRecaptchaToken({
      token: recaptchaToken,
      expectedAction: 'register',
      remoteIp: req.ip
    });
    if (!captchaRes.success) {
      return res.status(400).json({ success: false, error: captchaRes.error });
    }

    const result = await db.registerUser({ username, password, name, referralCode });
    if (result.error) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, user: withKing(result.user), token: result.token });
  }));

  // Endpoint registrasi user langsung dari Postman/API klien menggunakan HTTP Basic Auth (tanpa reCAPTCHA)
  api.post('/auth/register-basic', asyncRoute(async (req, res) => {
    if (!(process.env.NODE_ENV === 'test' && process.env.ENABLE_RATE_LIMIT_IN_TEST !== '1')) {
      if (!basicRegisterLimiter(req.ip)) {
        return res.status(429).json({ success: false, error: 'Terlalu banyak permintaan ke register API. Coba lagi sebentar.' });
      }
    }

    const authInfo = verifyBasicAuthRegister(req, res);
    if (!authInfo) return;

    const { username, password, name, email, role, points, coins, diamonds, referralCode } = req.body || {};

    let cleanReferralCode = '';
    if (referralCode !== undefined && referralCode !== null && String(referralCode).trim() !== '') {
      cleanReferralCode = String(referralCode).trim();
      if (!/^\d{6}$/.test(cleanReferralCode)) {
        return res.status(400).json({ success: false, error: 'Kode referral harus berupa 6 digit angka.' });
      }
      const referrer = db.findUserByReferralCode(cleanReferralCode);
      if (!referrer) {
        return res.status(400).json({ success: false, error: 'Kode referral tidak valid atau tidak ditemukan.' });
      }
      if (typeof username === 'string' && referrer.username.toLowerCase() === username.trim().toLowerCase()) {
        return res.status(400).json({ success: false, error: 'Tidak dapat menggunakan kode referral milik sendiri.' });
      }
    }

    const initialCoins = points !== undefined && points !== '' && points !== null ? points : coins;
    const initialDiamonds = diamonds !== undefined && diamonds !== '' && diamonds !== null ? Number(diamonds) : 0;
    if (!Number.isInteger(initialDiamonds) || initialDiamonds < 0 || initialDiamonds > 10000000) {
      return res.status(400).json({ success: false, error: 'Saldo Diamonds awal harus bilangan bulat >= 0.' });
    }

    const resolvedRole = role === 'admin' ? 'admin' : 'player';
    const created = await db.adminCreateUser({
      username,
      password,
      name,
      email: email || null,
      role: resolvedRole,
      points: initialCoins
    });
    if (created.error) {
      return res.status(created.status || 400).json({ success: false, error: created.error });
    }

    if (initialDiamonds > 0) {
      await economy.adminAdjustDiamonds({
        targetUserId: created.user.id,
        amount: initialDiamonds,
        reason: 'Saldo awal via Basic Auth Register API (Postman)',
        txType: 'ADMIN_ADJUSTMENT',
        adminUser: { id: null, username: authInfo.authenticatedUser }
      });
    }

    if (cleanReferralCode) {
      await db.claimReferral({ userId: created.user.id, referralCode: cleanReferralCode });
    }

    const freshUser = db.sanitizeUser(db.findUserById(created.user.id));

    recordAdminAudit({
      adminUser: { id: null, username: `basic:${authInfo.authenticatedUser}` },
      action: 'USER_REGISTER_BASIC_API',
      targetType: 'user',
      targetId: freshUser.id,
      summary: `Registrasi user @${freshUser.username} via Basic Auth API (role: ${freshUser.role}, coins: ${freshUser.points}, diamonds: ${freshUser.diamonds})`
    });

    res.status(201).json({
      success: true,
      message: 'User berhasil didaftarkan.',
      user: withKing(freshUser)
    });
  }));

  api.post('/auth/login', asyncRoute(async (req, res) => {
    const { username, password, recaptchaToken } = req.body || {};
    if (!loginLimiter(`${req.ip}:${String(username || '').toLowerCase()}`)) {
      return res.status(429).json({ success: false, error: 'Terlalu banyak percobaan login. Coba lagi dalam 10 menit.' });
    }

    const captchaRes = await recaptcha.verifyRecaptchaToken({
      token: recaptchaToken,
      expectedAction: 'login',
      remoteIp: req.ip
    });
    if (!captchaRes.success) {
      return res.status(400).json({ success: false, error: captchaRes.error });
    }

    const result = await db.loginUser({ username, password });
    if (result.error) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, user: withKing(result.user), token: result.token });
  }));

  api.get('/auth/recaptcha/config', (req, res) => {
    loadDotEnv(true);
    const config = recaptcha.getRecaptchaConfig();
    res.json({
      success: true,
      enabled: config.isConfigured && Boolean(config.siteKey),
      siteKey: config.siteKey
    });
  });

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
    if (!googleAuthLimiter(req.ip)) {
      return res.status(429).json({ success: false, error: 'Terlalu banyak percobaan login Google. Coba lagi nanti.' });
    }
    loadDotEnv(true);
    const { credential, code, redirectUri, testUser, referralCode } = req.body || {};

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
      avatar: googleProfile.picture,
      referralCode
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

  // Cek validitas kode referral
  api.get('/referral/check/:code', (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ success: false, valid: false, error: 'Kode referral kosong.' });
    const referrer = db.findUserByReferralCode(code);
    if (!referrer) {
      return res.json({ success: false, valid: false, error: 'Kode referral tidak ditemukan.' });
    }
    return res.json({
      success: true,
      valid: true,
      referrer: {
        username: referrer.username,
        name: referrer.name,
        avatar: referrer.avatar
      }
    });
  });

  // Informasi dan riwayat referral pengguna yang sedang login
  api.get('/referral/info', (req, res) => {
    const user = requireUser(req, res, 'Silakan login terlebih dahulu.');
    if (!user) return;
    const info = db.getReferralInfo(user.id);
    if (!info) return res.status(404).json({ success: false, error: 'Data referral tidak ditemukan.' });
    res.json({ success: true, ...info });
  });

  // Klaim/hubungkan kode referral saat user pertama kali login dan masuk ke platform
  api.post('/referral/claim', asyncRoute(async (req, res) => {
    const user = requireUser(req, res, 'Silakan login terlebih dahulu untuk mengklaim kode referral.');
    if (!user) return;
    const { referralCode } = req.body || {};
    const result = await db.claimReferral({ userId: user.id, referralCode });
    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }
    return res.json({
      success: true,
      message: result.message,
      user: withKing(result.user),
      referrer: result.referrer
    });
  }));

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

  // Room yang masih aktif milik user (dibuat atau diikuti, termasuk yang sudah OUT agar tetap bisa menonton)
  api.get('/rooms/active', (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;

    const list = [];
    for (const r of store.rooms.values()) {
      if (r.winner) continue;
      const me = r.players.find(p => p.userId === user.id);
      if (!me) continue;
      list.push({
        code: r.code,
        started: r.started,
        isCreator: r.creatorUserId === user.id,
        isOut: Boolean(me.isOut),
        myColor: me.color,
        players: r.players.map(p => ({
          name: p.name,
          color: p.color,
          isBot: !!p.isBot,
          connected: !!p.isBot || !!p.connected,
          isOut: !!p.isOut
        })),
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

  // Katalog toko dibaca dari database (shop_items)
  api.get('/shop/items', asyncRoute(async (req, res) => {
    const catalog = await db.queryShopItems();
    res.json({ success: true, items: catalog });
  }));

  api.post('/shop/buy', asyncRoute(async (req, res) => {
    const user = requireUser(req, res, 'Silakan login terlebih dahulu untuk berbelanja.');
    if (!user) return;

    const itemId = req.body?.itemId || req.body?.itemType;
    if (!itemId) return res.status(400).json({ success: false, error: 'ID item toko wajib disertakan.' });

    // Harga dan validasi item diproses langsung di database
    const result = await db.purchaseItem({ userId: user.id, itemId });
    if (result.error) return res.status(400).json({ success: false, error: result.error });

    // Sinkronkan stok jika user sedang berada di room aktif
    syncUserItemsToRooms(user.id);

    res.json({
      success: true,
      message: `Berhasil membeli ${result.item.name}!`,
      item: result.item,
      user: withKing(result.user)
    });
  }));

  // ==========================================
  // ADMIN: KOREKSI STOK ITEM & COINS PEMAIN
  // Ubah lewat endpoint ini, bukan langsung di database: server menyimpan stok & Coins di cache,
  // jadi perubahan langsung di database baru terbaca setelah server restart.
  // ==========================================

  const findTargetUser = (req, res) => {
    const target = db.getUserByUsername(String(req.params.username || '').replace(/^@/, ''));
    if (!target) res.status(404).json({ success: false, error: 'Pemain tidak ditemukan.' });
    return target;
  };
  const itemsAndCoins = target => ({
    username: target.username,
    coins: db.sanitizeUser(target).points ?? 0,
    items: db.getUserItems(target.id)
  });

  api.get('/admin/users/:username/items', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const target = findTargetUser(req, res);
    if (!target) return;
    res.json({ success: true, ...itemsAndCoins(target) });
  });

  // Body: { items?: { [itemId]: jumlah }, coins?: jumlah }. Nilai = jumlah akhir (bukan tambahan);
  // jumlah 0 menghapus item. Room yang sedang berjalan langsung memakai stok baru.
  api.patch('/admin/users/:username/items', asyncRoute(async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const target = findTargetUser(req, res);
    if (!target) return;

    const isCount = v => Number.isInteger(v) && v >= 0 && v <= 100000;
    const body = req.body || {};
    const quantities = body.items && typeof body.items === 'object' ? body.items : {};
    for (const [itemId, qty] of Object.entries(quantities)) {
      if (!items.get(itemId)) return res.status(400).json({ success: false, error: `Item ${itemId} tidak dikenal.` });
      if (!isCount(qty)) return res.status(400).json({ success: false, error: `Jumlah ${itemId} harus bilangan bulat >= 0.` });
    }
    if (body.coins !== undefined && !isCount(body.coins)) {
      return res.status(400).json({ success: false, error: 'Coins harus bilangan bulat >= 0.' });
    }
    if (!Object.keys(quantities).length && body.coins === undefined) {
      return res.status(400).json({ success: false, error: 'Isi items dan/atau coins.' });
    }

    if (Object.keys(quantities).length) {
      await db.setUserItemQuantities(target.id, quantities);
      syncUserItemsToRooms(target.id);
    }
    if (body.coins !== undefined) await db.setUserPoints(target.id, body.coins);

    console.log(`[admin] ${admin.username} mengubah @${target.username}: ${JSON.stringify({ items: quantities, coins: body.coins })}`);
    res.json({ success: true, ...itemsAndCoins(target) });
  }));

  // ==========================================
  // TOPUP COINS (MULTI-GATEWAY: DOKU / DUITKU)
  // ==========================================

  api.get('/topup/config', asyncRoute(async (req, res) => {
    const config = paymentGateway.getActiveConfig();
    const packages = await db.queryDiamondPackages();
    res.json({
      success: true,
      gateway: config.gateway,
      mode: 'direct_api',
      packages,
      paymentMethods: paymentGateway.getPaymentMethodsCatalog(config.gateway),
      merchantCode: config.merchantCode || config.clientId || '',
      isProduction: config.isProduction,
      isConfigured: config.isConfigured
    });
  }));

  // Buat transaksi pembayaran via gateway aktif (DOKU atau Duitku sesuai .env)
  api.post(['/topup/create', '/topup/charge'], asyncRoute(async (req, res) => {
    const user = requireUser(req, res, 'Silakan login terlebih dahulu untuk melakukan topup Coins.');
    if (!user) return;

    const { packageId, paymentMethod } = req.body || {};
    const selectedMethod = String(paymentMethod || 'SP').trim().toUpperCase() || 'SP';
    // Ambil detail paket resmi langsung dari database PostgreSQL
    const pkg = await db.getDiamondPackageById(packageId);
    if (!pkg) {
      return res.status(400).json({ success: false, error: 'Paket Coins tidak valid atau sudah tidak aktif.' });
    }

    const orderId = `TOPUP-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

    try {
      const host = req.get('host') || '';
      const activeGateway = paymentGateway.getActiveGatewayName();
      const gwRes = await paymentGateway.createInvoice({
        gateway: activeGateway,
        orderId,
        pkg,
        user,
        host,
        callbackPath: '/api/topup/notification',
        paymentMethod: selectedMethod
      });

      await db.createTopupOrder({
        orderId,
        userId: user.id,
        packageId: pkg.id,
        diamonds: pkg.diamonds,
        grossAmount: pkg.price,
        snapToken: gwRes.reference,
        paymentType: gwRes.paymentMethod || selectedMethod,
        paymentDetails: gwRes
      });

      res.json({
        success: true,
        gateway: gwRes.gateway || activeGateway,
        orderId,
        package: pkg,
        reference: gwRes.reference,
        paymentUrl: gwRes.paymentUrl,
        vaNumber: gwRes.vaNumber || null,
        qrString: gwRes.qrString || null,
        qrCodeUrl: gwRes.qrCodeUrl || null,
        deeplinkUrl: gwRes.deeplinkUrl || null,
        actions: gwRes.actions || null,
        paymentMethod: gwRes.paymentMethod || selectedMethod,
        paymentMethodName: gwRes.paymentMethodName || null,
        paymentCategory: gwRes.paymentCategory || null,
        bank: gwRes.bank || null,
        payment: gwRes,
        isSimulation: gwRes.isSimulation || false
      });
    } catch (err) {
      console.error('[TOPUP GATEWAY ERROR]', err.message);
      res.status(500).json({ success: false, error: err.message || 'Gagal memproses pembayaran.' });
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

  // Fallback GET jika browser user diarahkan ke URL notifikasi (Back to Merchant)
  api.get('/topup/notification', (req, res) => {
    const targetUrl = process.env.PUBLIC_URL || process.env.APP_URL || '/';
    return res.redirect(302, targetUrl);
  });

  // Webhook notifikasi Payment Gateway (DOKU / Duitku Callback URL)
  api.post('/topup/notification', asyncRoute(async (req, res) => {
    const notif = req.body || {};
    const headers = {
      ...(req.headers || {}),
      'x-resolved-target': String(req.originalUrl || '/api/topup/notification').split('?')[0]
    };
    const preNormalized = paymentGateway.normalizeCallback(notif, headers);
    const orderId = preNormalized.merchantOrderId;

    if (!orderId) {
      return res.status(400).send('Bad Parameter: missing merchantOrderId');
    }

    // Delegasikan callback order Diamonds (PGD_*) ke economy store jika Callback URL diarahkan ke endpoint ini
    if (orderId.startsWith('PGD_')) {
      const result = await economy.handleDuitkuDiamondCallback(notif, headers);
      if (result.httpStatus && result.httpStatus >= 400) {
        return res.status(result.httpStatus).send(result.error || 'Bad Callback');
      }
      return res.status(200).send('OK');
    }

    const order = await db.getTopupOrder(orderId);
    if (!order) {
      console.warn('[PAYMENT NOTIFICATION] Order not found:', orderId);
      return res.status(404).send('Bad Parameter: order not found');
    }

    const orderGateway = order.paymentDetails?.gateway || preNormalized.gateway;
    const normalized = paymentGateway.normalizeCallback(notif, headers, orderGateway);
    const isValid = paymentGateway.verifyCallback(notif, headers, orderGateway);
    if (!isValid) {
      console.warn(`[${String(orderGateway).toUpperCase()} NOTIFICATION] Invalid signature for order`, orderId);
      return res.status(400).send('Bad Signature');
    }

    const resultCode = String(normalized.resultCode || '');
    if (order.status === 'cancelled') {
      return res.status(200).send('OK');
    }
    if (resultCode === '00') {
      const paidAmount = Number(normalized.amount);
      if (!Number.isFinite(paidAmount) || paidAmount <= 0 || paidAmount !== Number(order.grossAmount)) {
        console.warn(`[${String(orderGateway).toUpperCase()} NOTIFICATION] Amount mismatch for order`, orderId, 'expected', order.grossAmount, 'got', normalized.amount);
        return res.status(400).send('Bad Parameter: amount mismatch');
      }
      const paymentMethod = normalized.paymentMethod || orderGateway || 'doku';
      await db.completeTopupOrder(orderId, paymentMethod);
      console.log(`[${String(orderGateway).toUpperCase()} NOTIFICATION] Order completed successfully:`, orderId);
    }

    // Gateway callback standar mengharapkan balasan HTTP 200 dengan text "OK"
    res.status(200).send('OK');
  }));

  // Riwayat & pembatalan order top-up Coins milik pemain
  api.get('/topup/history', asyncRoute(async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const limit = Number(req.query?.limit || 30);
    res.json({
      success: true,
      orders: db.listUserTopupOrders(user.id, limit)
    });
  }));

  api.post('/topup/cancel', asyncRoute(async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const orderId = String(req.body?.orderId || '').trim();
    const result = await db.cancelTopupOrder(orderId, user.id);
    if (result.error) {
      return res.status(result.status || 400).json({ success: false, error: result.error });
    }
    res.json({ success: true, order: result.order });
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
      return res.json({ success: true, status: 'success', user: withKing(freshUser), diamonds: order.diamonds, coins: order.diamonds });
    }
    if (order.status !== 'pending') {
      return res.json({ success: true, status: order.status, message: `Pesanan top-up berstatus ${order.status}.` });
    }

    // Coba polling status ke Payment Gateway Status API secara realtime
    try {
      const orderGateway = order.paymentDetails?.gateway || paymentGateway.getActiveGatewayName();
      const gwStatus = await paymentGateway.checkStatus(orderId, orderGateway);
      if (gwStatus) {
        const isGwSuccess =
          gwStatus.statusCode === '00' ||
          gwStatus.status === '00' ||
          gwStatus.resultCode === '00';

        if (isGwSuccess) {
          if (gwStatus.amount !== undefined && gwStatus.amount !== null && String(gwStatus.amount).trim() !== '') {
            const gwAmount = Number(gwStatus.amount);
            if (!Number.isFinite(gwAmount) || gwAmount <= 0 || gwAmount !== Number(order.grossAmount)) {
              console.warn('[TOPUP VERIFY GATEWAY AMOUNT MISMATCH]', orderId, 'expected', order.grossAmount, 'got', gwStatus.amount);
              return res.status(400).json({ success: false, error: 'Nominal pembayaran tidak sesuai dengan pesanan.' });
            }
          }
          const completed = await db.completeTopupOrder(orderId, orderGateway);
          return res.json({
            success: true,
            status: 'success',
            user: withKing(completed.user),
            diamonds: order.diamonds,
            coins: order.diamonds
          });
        }
      }
    } catch (err) {
      console.warn('[TOPUP VERIFY GATEWAY STATUS ERROR]', err.message);
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
      message: `Topup berhasil! +${order.diamonds} Coins telah ditambahkan ke akunmu.`,
      order: result.order,
      diamondsAwarded: order.diamonds,
      coinsAwarded: order.diamonds,
      user: withKing(result.user)
    });
  }));

  registerSocialRoutes(api);
  registerQuizRoutes(api);
  registerChessRoutes(api);
  registerSnakesRoutes(api);
  registerEconomyRoutes(api);
  registerAdminRoutes(api);

  api.use((req, res) => res.status(404).json({ success: false, error: 'Endpoint tidak ditemukan.' }));

  return api;
}

module.exports = { createApiRouter };
