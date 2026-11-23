// Store Ekonomi Dual Currency (Coins + Diamonds), Konversi, Top-Up DOKU & Duitku,
// Ludo Skin Shop & Dashboard Admin PlayGo.
// Semua mutasi saldo & kepemilikan skin berjalan aman dengan per-user / per-order lock
// dan transaksi PostgreSQL (plus fallback lokal untuk pengujian tanpa PG).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paymentGateway = require('../lib/paymentGateway');

const DATA_DIR = process.env.JAKLUDO_DATA_DIR || path.join(__dirname, '..', 'data');
const LOCAL_ECONOMY_FILE = path.join(DATA_DIR, 'economy-state.json');

const ALLOWED_RARITIES = ['Common', 'Rare', 'Epic', 'Legendary'];
const ALLOWED_TX_TYPES = ['TOPUP', 'CONVERSION', 'SKIN_PURCHASE', 'REFUND', 'ADMIN_ADJUSTMENT'];
const ALLOWED_ORDER_STATUSES = ['PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED'];

const DEFAULT_SETTINGS = {
  coinsPerDiamond: 100,
  minConvertDiamonds: 10,
  maxConvertDiamonds: 50,
  conversionEnabled: true,
  updatedAt: new Date(0).toISOString(),
  updatedBy: null
};

const DEFAULT_TOPUP_PACKAGES = [
  {
    id: 'pkg_starter',
    name: 'Starter',
    diamonds: 10,
    bonusDiamonds: 0,
    priceIdr: 5000,
    badge: 'Hemat',
    sortOrder: 1,
    isActive: true
  },
  {
    id: 'pkg_popular',
    name: 'Popular',
    diamonds: 25,
    bonusDiamonds: 0,
    priceIdr: 10000,
    badge: 'Populer',
    sortOrder: 2,
    isActive: true
  },
  {
    id: 'pkg_premium',
    name: 'Premium',
    diamonds: 50,
    bonusDiamonds: 0,
    priceIdr: 20000,
    badge: 'Best Value',
    sortOrder: 3,
    isActive: true
  },
  {
    id: 'pkg_mega',
    name: 'Mega',
    diamonds: 150,
    bonusDiamonds: 0,
    priceIdr: 50000,
    badge: 'Sultan',
    sortOrder: 4,
    isActive: true
  }
];

const DEFAULT_LUDO_SKINS = [
  {
    id: 'classic_gold',
    name: 'Classic Gold',
    description: 'Bidak emas klasik berlapis kilau mewah untuk gaya juara sejati.',
    priceDiamonds: 10,
    rarity: 'Common',
    assetKey: 'classic_gold',
    previewUrl: '',
    imageUrl: '',
    accentColor: '#f59e0b',
    isActive: true,
    sortOrder: 1
  },
  {
    id: 'ruby_crystal',
    name: 'Ruby Crystal',
    description: 'Kristal delima merah menyala dengan potongan faset permata elegan.',
    priceDiamonds: 15,
    rarity: 'Common',
    assetKey: 'ruby_crystal',
    previewUrl: '',
    imageUrl: '',
    accentColor: '#ef4444',
    isActive: true,
    sortOrder: 2
  },
  {
    id: 'ocean_blue',
    name: 'Ocean Blue',
    description: 'Bidak biru samudra dengan inti mutiara laut. Dilengkapi kemampuan Hint Langkah Terbaik yang menyalakan bidak paling menguntungkan berurutan dari peluang tertinggi.',
    priceDiamonds: 20,
    rarity: 'Rare',
    assetKey: 'ocean_blue',
    previewUrl: '',
    imageUrl: '',
    accentColor: '#0ea5e9',
    isActive: true,
    sortOrder: 3
  },
  {
    id: 'emerald_green',
    name: 'Emerald Green',
    description: 'Zamrud hijau berkilau dengan aura hutan mistis. Dilengkapi skill Anti-Eliminasi (1x awal laga, +1 tiap bidak finish, maks. 3) untuk menahan injakan & Force Return dengan konfirmasi.',
    priceDiamonds: 25,
    rarity: 'Rare',
    assetKey: 'emerald_green',
    previewUrl: '',
    imageUrl: '',
    accentColor: '#10b981',
    isActive: true,
    sortOrder: 4
  },
  {
    id: 'galaxy_purple',
    name: 'Galaxy Purple',
    description: 'Bidak nebula ungu kosmik bertabur bintang. Dilengkapi skill Anti-Eliminasi (1x awal laga, +1 tiap bidak finish, maks. 3) untuk menahan injakan & Force Return dengan konfirmasi.',
    priceDiamonds: 30,
    rarity: 'Epic',
    assetKey: 'galaxy_purple',
    previewUrl: '',
    imageUrl: '',
    accentColor: '#8b5cf6',
    isActive: true,
    sortOrder: 5
  },
  {
    id: 'fire_phoenix',
    name: 'Fire Phoenix',
    description: 'Sayap api phoenix membara yang memancarkan semangat pantang menyerah.',
    priceDiamonds: 40,
    rarity: 'Epic',
    assetKey: 'fire_phoenix',
    previewUrl: '',
    imageUrl: '',
    accentColor: '#f97316',
    isActive: true,
    sortOrder: 6
  },
  {
    id: 'legendary_diamond',
    name: 'Legendary Diamond',
    description: 'Bidak berlian legendaris berlapis mahkota kristal tertinggi di PlayGo.',
    priceDiamonds: 50,
    rarity: 'Legendary',
    assetKey: 'legendary_diamond',
    previewUrl: '',
    imageUrl: '',
    accentColor: '#38bdf8',
    isActive: true,
    sortOrder: 7
  }
];

const state = {
  settings: { ...DEFAULT_SETTINGS },
  wallets: new Map(),             // userId -> wallet object
  diamondTransactions: [],        // immutable ledger entries
  idempotencyIndex: new Map(),    // idempotencyKey -> diamondTx
  coinConversions: [],            // immutable conversion records
  packages: new Map(),            // id -> package object
  paymentOrders: new Map(),       // id -> payment order object
  callbackLogs: [],               // audit callback logs
  skins: new Map(),               // id -> ludo skin object
  ownedSkins: new Map(),          // userId -> Map<skinId, { skinId, purchaseTxId, pricePaidDiamonds, purchasedAt }>
  equippedSkins: new Map()        // userId -> skinId | null
};

const userLocks = new Map();
const orderLocks = new Map();

function getDb() {
  return require('../db');
}

function getPool() {
  return getDb().getPool();
}

function withKeyLock(lockMap, key, fn) {
  const k = String(key);
  const prev = lockMap.get(k) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => fn());
  const marker = next.catch(() => {});
  lockMap.set(k, marker);
  marker.finally(() => {
    if (lockMap.get(k) === marker) {
      lockMap.delete(k);
    }
  });
  return next;
}

function withUserLock(userId, fn) {
  return withKeyLock(userLocks, `u:${userId}`, fn);
}

function withOrderLock(orderId, fn) {
  return withKeyLock(orderLocks, `o:${orderId}`, fn);
}

function makeError(status, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

function persistLocalFallback() {
  if (getPool()) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const dump = {
      settings: state.settings,
      wallets: Array.from(state.wallets.values()),
      diamondTransactions: state.diamondTransactions,
      coinConversions: state.coinConversions,
      packages: Array.from(state.packages.values()),
      paymentOrders: Array.from(state.paymentOrders.values()),
      callbackLogs: state.callbackLogs,
      skins: Array.from(state.skins.values()),
      ownedSkins: Object.fromEntries(
        Array.from(state.ownedSkins.entries()).map(([uid, m]) => [uid, Array.from(m.values())])
      ),
      equippedSkins: Object.fromEntries(state.equippedSkins.entries())
    };
    fs.writeFileSync(LOCAL_ECONOMY_FILE, JSON.stringify(dump));
  } catch (err) {
    console.warn('[ECONOMY LOCAL PERSIST]', err.message);
  }
}

function seedDefaults() {
  for (const pkg of DEFAULT_TOPUP_PACKAGES) {
    if (!state.packages.has(pkg.id)) {
      state.packages.set(pkg.id, { ...pkg, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
  }
  for (const skin of DEFAULT_LUDO_SKINS) {
    if (!state.skins.has(skin.id)) {
      state.skins.set(skin.id, { ...skin, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
  }
}

function bootstrapLocalState() {
  seedDefaults();
  if (fs.existsSync(LOCAL_ECONOMY_FILE)) {
    try {
      const dump = JSON.parse(fs.readFileSync(LOCAL_ECONOMY_FILE, 'utf8'));
      if (dump.settings) {
        state.settings = { ...DEFAULT_SETTINGS, ...dump.settings };
      }
      if (Array.isArray(dump.packages) && dump.packages.length > 0) {
        for (const p of dump.packages) state.packages.set(p.id, p);
      }
      if (Array.isArray(dump.skins) && dump.skins.length > 0) {
        for (const s of dump.skins) state.skins.set(s.id, s);
      }
      for (const w of dump.wallets || []) state.wallets.set(w.userId, w);
      for (const tx of dump.diamondTransactions || []) {
        const frozen = Object.freeze({ ...tx });
        state.diamondTransactions.push(frozen);
        if (frozen.idempotencyKey) {
          state.idempotencyIndex.set(frozen.idempotencyKey, frozen);
        }
      }
      for (const cv of dump.coinConversions || []) {
        state.coinConversions.push(Object.freeze({ ...cv }));
      }
      for (const o of dump.paymentOrders || []) state.paymentOrders.set(o.id, o);
      for (const log of dump.callbackLogs || []) state.callbackLogs.push(Object.freeze({ ...log }));
      for (const [uid, list] of Object.entries(dump.ownedSkins || {})) {
        const m = new Map();
        for (const row of list || []) m.set(row.skinId, row);
        state.ownedSkins.set(uid, m);
      }
      for (const [uid, sid] of Object.entries(dump.equippedSkins || {})) {
        state.equippedSkins.set(uid, sid || null);
      }
    } catch (err) {
      console.warn('[ECONOMY BOOTSTRAP]', err.message);
    }
  }
}

bootstrapLocalState();

async function hydrateFromPostgres() {
  const pool = getPool();
  if (!pool) return;

  try {
    const userRoleRes = await pool.query('SELECT id, role FROM users');
    const db = getDb();
    for (const r of userRoleRes.rows || []) {
      db.syncUserRoleInState(r.id, r.role);
    }

    const settingsRes = await pool.query('SELECT * FROM economy_settings WHERE id = 1');
    if (settingsRes.rows && settingsRes.rows[0]) {
      const r = settingsRes.rows[0];
      state.settings = {
        coinsPerDiamond: Number(r.coins_per_diamond),
        minConvertDiamonds: Number(r.min_convert_diamonds),
        maxConvertDiamonds: Number(r.max_convert_diamonds),
        conversionEnabled: Boolean(r.conversion_enabled),
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString(),
        updatedBy: r.updated_by || null
      };
    }

    const pkgRes = await pool.query('SELECT * FROM diamond_topup_packages ORDER BY sort_order ASC, price_idr ASC');
    if (pkgRes.rows && pkgRes.rows.length > 0) {
      state.packages.clear();
      for (const r of pkgRes.rows) {
        state.packages.set(r.id, {
          id: r.id,
          name: r.name,
          diamonds: Number(r.diamonds),
          bonusDiamonds: Number(r.bonus_diamonds || 0),
          priceIdr: Number(r.price_idr),
          badge: r.badge || '',
          sortOrder: Number(r.sort_order || 0),
          isActive: Boolean(r.is_active),
          createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
          updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString()
        });
      }
    }

    const skinRes = await pool.query('SELECT * FROM ludo_skins ORDER BY sort_order ASC, price_diamonds ASC');
    if (skinRes.rows && skinRes.rows.length > 0) {
      state.skins.clear();
      for (const r of skinRes.rows) {
        state.skins.set(r.id, {
          id: r.id,
          name: r.name,
          description: r.description || '',
          priceDiamonds: Number(r.price_diamonds),
          rarity: r.rarity,
          assetKey: r.asset_key || r.id,
          previewUrl: r.preview_url || '',
          imageUrl: r.image_url || '',
          accentColor: r.accent_color || '#fbbf24',
          isActive: Boolean(r.is_active),
          sortOrder: Number(r.sort_order || 0),
          createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
          updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString()
        });
      }
    }

    const walletRes = await pool.query('SELECT * FROM diamond_wallets');
    state.wallets.clear();
    for (const r of walletRes.rows || []) {
      state.wallets.set(r.user_id, {
        userId: r.user_id,
        balance: Number(r.balance || 0),
        totalPurchased: Number(r.total_purchased || 0),
        totalConverted: Number(r.total_converted || 0),
        totalSpent: Number(r.total_spent || 0),
        totalRefunded: Number(r.total_refunded || 0),
        totalAdminAdjusted: Number(r.total_admin_adjusted || 0),
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString()
      });
    }

    const txRes = await pool.query('SELECT * FROM diamond_transactions ORDER BY created_at DESC LIMIT 2000');
    state.diamondTransactions = [];
    state.idempotencyIndex.clear();
    for (const r of (txRes.rows || []).reverse()) {
      const tx = Object.freeze({
        id: r.id,
        userId: r.user_id,
        txType: r.tx_type,
        amount: Number(r.amount),
        previousBalance: Number(r.previous_balance),
        newBalance: Number(r.new_balance),
        referenceId: r.reference_id || null,
        idempotencyKey: r.idempotency_key || null,
        description: r.description || '',
        metadata: r.metadata || {},
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString()
      });
      state.diamondTransactions.push(tx);
      if (tx.idempotencyKey) state.idempotencyIndex.set(tx.idempotencyKey, tx);
    }

    const convRes = await pool.query('SELECT * FROM coin_conversion_transactions ORDER BY created_at DESC LIMIT 1000');
    state.coinConversions = (convRes.rows || []).reverse().map(r => {
      const direction =
        r.direction ||
        (Number(r.new_diamonds) < Number(r.previous_diamonds) ? 'diamonds_to_coins' : 'coins_to_diamonds');
      return Object.freeze({
        id: r.id,
        userId: r.user_id,
        direction,
        coinsSpent: Number(r.coins_spent || 0),
        diamondsReceived: Number(r.diamonds_received || 0),
        diamondsSpent: Number(r.diamonds_spent || r.diamonds_received || 0),
        coinsReceived: Number(r.coins_received || r.coins_spent || 0),
        rateCoinsPerDiamond: Number(r.rate_coins_per_diamond),
        previousCoins: Number(r.previous_coins),
        newCoins: Number(r.new_coins),
        previousDiamonds: Number(r.previous_diamonds),
        newDiamonds: Number(r.new_diamonds),
        idempotencyKey: r.idempotency_key || null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString()
      });
    });

    const orderRes = await pool.query('SELECT * FROM payment_orders ORDER BY created_at DESC LIMIT 1500');
    state.paymentOrders.clear();
    for (const r of orderRes.rows || []) {
      let rawCreate = r.raw_create_response || {};
      if (typeof rawCreate === 'string') {
        try { rawCreate = JSON.parse(rawCreate); } catch { rawCreate = {}; }
      }
      state.paymentOrders.set(r.id, {
        id: r.id,
        userId: r.user_id,
        packageId: r.package_id,
        packageName: r.package_name,
        diamonds: Number(r.diamonds),
        bonusDiamonds: Number(r.bonus_diamonds || 0),
        totalDiamonds: Number(r.total_diamonds),
        amountIdr: Number(r.amount_idr),
        paymentMethod: r.payment_method || rawCreate.paymentMethod || 'SP',
        paymentMethodName: rawCreate.paymentMethodName || null,
        paymentCategory: rawCreate.paymentCategory || null,
        bank: rawCreate.bank || null,
        vaNumber: rawCreate.vaNumber || null,
        qrString: rawCreate.qrString || null,
        qrCodeUrl: rawCreate.qrCodeUrl || null,
        deeplinkUrl: rawCreate.deeplinkUrl || null,
        gateway: r.gateway || 'duitku',
        gatewayReference: r.gateway_reference || null,
        paymentUrl: r.payment_url || null,
        status: r.status,
        creditedAt: r.credited_at ? new Date(r.credited_at).toISOString() : null,
        expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
        failureReason: r.failure_reason || null,
        rawCreateResponse: rawCreate,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString()
      });
    }

    const cbRes = await pool.query('SELECT * FROM payment_callback_logs ORDER BY created_at DESC LIMIT 500');
    state.callbackLogs = (cbRes.rows || []).reverse().map(r => Object.freeze({
      id: r.id,
      orderId: r.order_id || null,
      gateway: r.gateway || 'duitku',
      merchantCode: r.merchant_code || null,
      amountRaw: r.amount_raw || null,
      resultCode: r.result_code || null,
      signatureReceived: r.signature_received || null,
      signatureValid: Boolean(r.signature_valid),
      processingStatus: r.processing_status,
      notes: r.notes || '',
      payload: r.payload || {},
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString()
    }));

    const ownedRes = await pool.query('SELECT * FROM user_ludo_skins');
    state.ownedSkins.clear();
    for (const r of ownedRes.rows || []) {
      if (!state.ownedSkins.has(r.user_id)) state.ownedSkins.set(r.user_id, new Map());
      state.ownedSkins.get(r.user_id).set(r.skin_id, {
        skinId: r.skin_id,
        purchaseTxId: r.purchase_tx_id || null,
        pricePaidDiamonds: Number(r.price_paid_diamonds || 0),
        purchasedAt: r.purchased_at ? new Date(r.purchased_at).toISOString() : new Date().toISOString()
      });
    }

    const eqRes = await pool.query('SELECT * FROM user_ludo_equipped_skins');
    state.equippedSkins.clear();
    for (const r of eqRes.rows || []) {
      state.equippedSkins.set(r.user_id, r.skin_id || null);
    }
  } catch (err) {
    console.warn('[ECONOMY PG HYDRATE]', err.message);
  }
}

// Reset state untuk unit test terisolasi
function resetForTests() {
  state.settings = { ...DEFAULT_SETTINGS };
  state.wallets.clear();
  state.diamondTransactions = [];
  state.idempotencyIndex.clear();
  state.coinConversions = [];
  state.packages.clear();
  state.paymentOrders.clear();
  state.callbackLogs = [];
  state.skins.clear();
  state.ownedSkins.clear();
  state.equippedSkins.clear();
  seedDefaults();
}

// Helper sinkron untuk sanitizeUser & game room sync
function ensureWalletRecord(userId) {
  if (!userId) return null;
  if (!state.wallets.has(userId)) {
    const now = new Date().toISOString();
    state.wallets.set(userId, {
      userId,
      balance: 0,
      totalPurchased: 0,
      totalConverted: 0,
      totalSpent: 0,
      totalRefunded: 0,
      totalAdminAdjusted: 0,
      createdAt: now,
      updatedAt: now
    });
  }
  return state.wallets.get(userId);
}

function getDiamondBalanceSync(userId) {
  if (!userId) return 0;
  const w = state.wallets.get(userId);
  return w ? Number(w.balance || 0) : 0;
}

function getOwnedSkinIdsSync(userId) {
  if (!userId) return [];
  const owned = state.ownedSkins.get(userId);
  return owned ? Array.from(owned.keys()) : [];
}

function getEquippedSkinSync(userId) {
  if (!userId) return null;
  const skinId = state.equippedSkins.get(userId) || null;
  if (!skinId) return null;
  const owned = state.ownedSkins.get(userId);
  if (!owned || !owned.has(skinId)) return null;
  const skin = state.skins.get(skinId);
  if (!skin) return null;
  return {
    id: skin.id,
    name: skin.name,
    rarity: skin.rarity,
    assetKey: skin.assetKey,
    accentColor: skin.accentColor
  };
}

function getValidatedEquippedSkin(userId) {
  return getEquippedSkinSync(userId);
}

function getEconomySettings() {
  return { ...state.settings };
}

function formatWalletResponse(userId) {
  const db = getDb();
  const wallet = ensureWalletRecord(userId);
  const coins = db.getUserPoints(userId);
  return {
    userId,
    coins,
    diamonds: Number(wallet.balance || 0),
    balance: Number(wallet.balance || 0),
    totalPurchased: Number(wallet.totalPurchased || 0),
    totalConverted: Number(wallet.totalConverted || 0),
    totalSpent: Number(wallet.totalSpent || 0),
    totalRefunded: Number(wallet.totalRefunded || 0),
    totalAdminAdjusted: Number(wallet.totalAdminAdjusted || 0),
    equippedLudoSkin: getEquippedSkinSync(userId),
    ownedSkinCount: getOwnedSkinIdsSync(userId).length,
    settings: getEconomySettings()
  };
}

function buildDiamondTransaction({
  userId,
  txType,
  amount,
  previousBalance,
  newBalance,
  referenceId = null,
  idempotencyKey = null,
  description = '',
  metadata = {},
  createdAt = new Date().toISOString()
}) {
  if (!ALLOWED_TX_TYPES.includes(txType)) {
    throw makeError(400, `Tipe transaksi tidak valid: ${txType}`);
  }
  return Object.freeze({
    id: 'dtx_' + crypto.randomUUID(),
    userId,
    txType,
    amount: Math.trunc(amount),
    previousBalance: Math.trunc(previousBalance),
    newBalance: Math.trunc(newBalance),
    referenceId,
    idempotencyKey: idempotencyKey || null,
    description,
    metadata: Object.freeze({ ...(metadata || {}) }),
    createdAt
  });
}

function recordTxInMemory(tx) {
  state.diamondTransactions.push(tx);
  if (tx.idempotencyKey) {
    state.idempotencyIndex.set(tx.idempotencyKey, tx);
  }
  return tx;
}

function listUserTransactions(userId, { txType = '', limit = 50 } = {}) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const items = state.diamondTransactions
    .filter(tx => tx.userId === userId && (!txType || tx.txType === txType))
    .slice(-safeLimit)
    .reverse();
  const conversions = state.coinConversions
    .filter(cv => cv.userId === userId)
    .slice(-safeLimit)
    .reverse();
  return { transactions: items, conversions };
}

function enrichOrderFields(order) {
  if (!order) return order;
  const raw = order.rawCreateResponse || {};
  return {
    ...order,
    paymentMethod: order.paymentMethod || raw.paymentMethod || 'SP',
    paymentMethodName: order.paymentMethodName || raw.paymentMethodName || null,
    paymentCategory: order.paymentCategory || raw.paymentCategory || null,
    bank: order.bank || raw.bank || null,
    vaNumber: order.vaNumber || raw.vaNumber || null,
    qrString: order.qrString || raw.qrString || null,
    qrCodeUrl: order.qrCodeUrl || raw.qrCodeUrl || null,
    deeplinkUrl: order.deeplinkUrl || raw.deeplinkUrl || null
  };
}

function listPaymentOrdersForUser(userId, { limit = 30 } = {}) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 30));
  return Array.from(state.paymentOrders.values())
    .filter(o => o.userId === userId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, safeLimit)
    .map(enrichOrderFields);
}

// ==========================================
// KONVERSI DIAMONDS <-> COINS
// ==========================================

function validateConversionInput(userId, diamonds) {
  const db = getDb();
  const user = db.findUserById(userId);
  if (!user) throw makeError(404, 'Pengguna tidak ditemukan.');

  const settings = state.settings;
  if (!settings.conversionEnabled) {
    throw makeError(400, 'Fitur konversi Diamonds dan Coins sedang dinonaktifkan sementara oleh admin.');
  }

  const parsedDiamonds = Number(diamonds);
  if (
    diamonds === undefined ||
    diamonds === null ||
    diamonds === '' ||
    typeof diamonds === 'boolean' ||
    !Number.isInteger(parsedDiamonds) ||
    parsedDiamonds <= 0
  ) {
    throw makeError(400, 'Jumlah Diamonds konversi harus berupa bilangan bulat positif.');
  }

  if (parsedDiamonds < settings.minConvertDiamonds || parsedDiamonds > settings.maxConvertDiamonds) {
    throw makeError(
      400,
      `Konversi per transaksi harus antara ${settings.minConvertDiamonds} hingga ${settings.maxConvertDiamonds} Diamonds.`
    );
  }

  return { db, user, settings, parsedDiamonds };
}

async function convertCoinsToDiamonds({ userId, diamonds, idempotencyKey = null }) {
  const { db, user, settings, parsedDiamonds } = validateConversionInput(userId, diamonds);
  const cleanKey = idempotencyKey ? `conv:${userId}:${String(idempotencyKey).slice(0, 100)}` : null;

  return withUserLock(userId, async () => {
    if (cleanKey && state.idempotencyIndex.has(cleanKey)) {
      const existingTx = state.idempotencyIndex.get(cleanKey);
      return {
        success: true,
        idempotentReplay: true,
        direction: 'coins_to_diamonds',
        conversion: state.coinConversions.find(c => c.idempotencyKey === cleanKey) || null,
        transaction: existingTx,
        wallet: formatWalletResponse(userId),
        user: db.sanitizeUser(db.findUserById(userId))
      };
    }

    const rate = Number(settings.coinsPerDiamond);
    const coinsRequired = parsedDiamonds * rate;
    const currentCoins = db.getUserPoints(userId);
    if (currentCoins < coinsRequired) {
      throw makeError(
        400,
        `Coins tidak mencukupi. Dibutuhkan ${coinsRequired} Coins untuk ${parsedDiamonds} Diamonds (saldo kamu: ${currentCoins} Coins).`
      );
    }

    const wallet = ensureWalletRecord(userId);
    const prevDiamonds = Number(wallet.balance || 0);
    const nextDiamonds = prevDiamonds + parsedDiamonds;
    const prevCoins = currentCoins;
    const nextCoins = prevCoins - coinsRequired;
    const now = new Date().toISOString();
    const convId = 'ccv_' + crypto.randomUUID();

    const tx = buildDiamondTransaction({
      userId,
      txType: 'CONVERSION',
      amount: parsedDiamonds,
      previousBalance: prevDiamonds,
      newBalance: nextDiamonds,
      referenceId: convId,
      idempotencyKey: cleanKey,
      description: `Konversi ${coinsRequired} Coins menjadi ${parsedDiamonds} Diamonds`,
      metadata: {
        direction: 'coins_to_diamonds',
        coinsSpent: coinsRequired,
        diamondsReceived: parsedDiamonds,
        rateCoinsPerDiamond: rate
      },
      createdAt: now
    });

    const convRecord = Object.freeze({
      id: convId,
      userId,
      direction: 'coins_to_diamonds',
      coinsSpent: coinsRequired,
      diamondsReceived: parsedDiamonds,
      diamondsSpent: 0,
      coinsReceived: 0,
      rateCoinsPerDiamond: rate,
      previousCoins: prevCoins,
      newCoins: nextCoins,
      previousDiamonds: prevDiamonds,
      newDiamonds: nextDiamonds,
      idempotencyKey: cleanKey,
      createdAt: now
    });

    const pool = getPool();
    if (pool) {
      await db.execPgTransaction(async client => {
        await db.ensureGlobalLeaderboardRow(client, user);
        const coinRes = await client.query(
          'UPDATE leaderboard SET points = points - $1 WHERE user_id = $2 AND points >= $1 RETURNING points',
          [coinsRequired, userId]
        );
        if (!coinRes.rows || coinRes.rows.length === 0) {
          throw makeError(400, 'Coins tidak mencukupi saat memproses transaksi konversi.');
        }

        await client.query(
          `INSERT INTO diamond_wallets (user_id, balance, total_converted)
           VALUES ($1, 0, 0) ON CONFLICT (user_id) DO NOTHING`,
          [userId]
        );
        const walletRowRes = await client.query(
          'SELECT balance FROM diamond_wallets WHERE user_id = $1 FOR UPDATE',
          [userId]
        );
        const pgPrevDiamonds = Number(walletRowRes.rows[0].balance || 0);
        const pgNextDiamonds = pgPrevDiamonds + parsedDiamonds;
        await client.query(
          `UPDATE diamond_wallets
           SET balance = $1, total_converted = total_converted + $2, updated_at = NOW()
           WHERE user_id = $3`,
          [pgNextDiamonds, parsedDiamonds, userId]
        );
        await client.query(
          `INSERT INTO coin_conversion_transactions
             (id, user_id, direction, coins_spent, diamonds_received, diamonds_spent, coins_received, rate_coins_per_diamond, previous_coins, new_coins, previous_diamonds, new_diamonds, idempotency_key, created_at)
           VALUES ($1, $2, 'coins_to_diamonds', $3, $4, 0, 0, $5, $6, $7, $8, $9, $10, $11)`,
          [
            convId,
            userId,
            coinsRequired,
            parsedDiamonds,
            rate,
            prevCoins,
            nextCoins,
            pgPrevDiamonds,
            pgNextDiamonds,
            cleanKey,
            now
          ]
        );
        await client.query(
          `INSERT INTO diamond_transactions
             (id, user_id, tx_type, amount, previous_balance, new_balance, reference_id, idempotency_key, description, metadata, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            tx.id,
            userId,
            tx.txType,
            tx.amount,
            pgPrevDiamonds,
            pgNextDiamonds,
            tx.referenceId,
            tx.idempotencyKey,
            tx.description,
            JSON.stringify(tx.metadata),
            now
          ]
        );
      });
    }

    db.adjustUserPointsInState(userId, -coinsRequired);
    wallet.balance = nextDiamonds;
    wallet.totalConverted = Number(wallet.totalConverted || 0) + parsedDiamonds;
    wallet.updatedAt = now;
    state.coinConversions.push(convRecord);
    recordTxInMemory(tx);
    persistLocalFallback();

    return {
      success: true,
      idempotentReplay: false,
      direction: 'coins_to_diamonds',
      conversion: convRecord,
      transaction: tx,
      wallet: formatWalletResponse(userId),
      user: db.sanitizeUser(db.findUserById(userId))
    };
  });
}

async function convertDiamondsToCoins({ userId, diamonds, idempotencyKey = null }) {
  const { db, user, settings, parsedDiamonds } = validateConversionInput(userId, diamonds);
  const cleanKey = idempotencyKey ? `conv_d2c:${userId}:${String(idempotencyKey).slice(0, 100)}` : null;

  return withUserLock(userId, async () => {
    if (cleanKey && state.idempotencyIndex.has(cleanKey)) {
      const existingTx = state.idempotencyIndex.get(cleanKey);
      return {
        success: true,
        idempotentReplay: true,
        direction: 'diamonds_to_coins',
        conversion: state.coinConversions.find(c => c.idempotencyKey === cleanKey) || null,
        transaction: existingTx,
        wallet: formatWalletResponse(userId),
        user: db.sanitizeUser(db.findUserById(userId))
      };
    }

    const rate = Number(settings.coinsPerDiamond);
    const coinsReceived = parsedDiamonds * rate;
    const wallet = ensureWalletRecord(userId);
    const prevDiamonds = Number(wallet.balance || 0);
    if (prevDiamonds < parsedDiamonds) {
      throw makeError(
        400,
        `Diamonds tidak mencukupi. Dibutuhkan ${parsedDiamonds} Diamonds untuk +${coinsReceived.toLocaleString('id-ID')} Coins (saldo kamu: ${prevDiamonds} Diamonds).`
      );
    }

    const nextDiamonds = prevDiamonds - parsedDiamonds;
    const prevCoins = db.getUserPoints(userId);
    const nextCoins = prevCoins + coinsReceived;
    const now = new Date().toISOString();
    const convId = 'ccv_' + crypto.randomUUID();

    const tx = buildDiamondTransaction({
      userId,
      txType: 'CONVERSION',
      amount: -parsedDiamonds,
      previousBalance: prevDiamonds,
      newBalance: nextDiamonds,
      referenceId: convId,
      idempotencyKey: cleanKey,
      description: `Konversi ${parsedDiamonds} Diamonds menjadi +${coinsReceived.toLocaleString('id-ID')} Coins`,
      metadata: {
        direction: 'diamonds_to_coins',
        diamondsSpent: parsedDiamonds,
        coinsReceived,
        rateCoinsPerDiamond: rate
      },
      createdAt: now
    });

    const convRecord = Object.freeze({
      id: convId,
      userId,
      direction: 'diamonds_to_coins',
      diamondsSpent: parsedDiamonds,
      coinsReceived,
      coinsSpent: coinsReceived,
      diamondsReceived: parsedDiamonds,
      rateCoinsPerDiamond: rate,
      previousCoins: prevCoins,
      newCoins: nextCoins,
      previousDiamonds: prevDiamonds,
      newDiamonds: nextDiamonds,
      idempotencyKey: cleanKey,
      createdAt: now
    });

    const pool = getPool();
    if (pool) {
      await db.execPgTransaction(async client => {
        await db.ensureGlobalLeaderboardRow(client, user);
        await client.query(
          `INSERT INTO diamond_wallets (user_id, balance, total_spent)
           VALUES ($1, 0, 0) ON CONFLICT (user_id) DO NOTHING`,
          [userId]
        );
        const walletRowRes = await client.query(
          'SELECT balance FROM diamond_wallets WHERE user_id = $1 FOR UPDATE',
          [userId]
        );
        const pgPrevDiamonds = Number(walletRowRes.rows[0].balance || 0);
        if (pgPrevDiamonds < parsedDiamonds) {
          throw makeError(400, 'Diamonds tidak mencukupi saat memproses transaksi konversi.');
        }
        const pgNextDiamonds = pgPrevDiamonds - parsedDiamonds;
        await client.query(
          `UPDATE diamond_wallets
           SET balance = $1, total_spent = total_spent + $2, updated_at = NOW()
           WHERE user_id = $3`,
          [pgNextDiamonds, parsedDiamonds, userId]
        );
        const coinRes = await client.query(
          'UPDATE leaderboard SET points = points + $1 WHERE user_id = $2 RETURNING points',
          [coinsReceived, userId]
        );
        const pgNextCoins = coinRes.rows?.[0] ? Number(coinRes.rows[0].points) : nextCoins;
        const pgPrevCoins = Math.max(0, pgNextCoins - coinsReceived);

        await client.query(
          `INSERT INTO coin_conversion_transactions
             (id, user_id, direction, coins_spent, diamonds_received, diamonds_spent, coins_received, rate_coins_per_diamond, previous_coins, new_coins, previous_diamonds, new_diamonds, idempotency_key, created_at)
           VALUES ($1, $2, 'diamonds_to_coins', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            convId,
            userId,
            coinsReceived,
            parsedDiamonds,
            parsedDiamonds,
            coinsReceived,
            rate,
            pgPrevCoins,
            pgNextCoins,
            pgPrevDiamonds,
            pgNextDiamonds,
            cleanKey,
            now
          ]
        );
        await client.query(
          `INSERT INTO diamond_transactions
             (id, user_id, tx_type, amount, previous_balance, new_balance, reference_id, idempotency_key, description, metadata, created_at)
           VALUES ($1, $2, 'CONVERSION', $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            tx.id,
            userId,
            tx.amount,
            pgPrevDiamonds,
            pgNextDiamonds,
            tx.referenceId,
            tx.idempotencyKey,
            tx.description,
            JSON.stringify(tx.metadata),
            now
          ]
        );
      });
    }

    db.adjustUserPointsInState(userId, coinsReceived);
    wallet.balance = nextDiamonds;
    wallet.totalSpent = Number(wallet.totalSpent || 0) + parsedDiamonds;
    wallet.updatedAt = now;
    state.coinConversions.push(convRecord);
    recordTxInMemory(tx);
    persistLocalFallback();

    return {
      success: true,
      idempotentReplay: false,
      direction: 'diamonds_to_coins',
      conversion: convRecord,
      transaction: tx,
      wallet: formatWalletResponse(userId),
      user: db.sanitizeUser(db.findUserById(userId))
    };
  });
}

// ==========================================
// PAKET TOP-UP & MULTI-GATEWAY (DOKU / DUITKU)
// ==========================================

function listDiamondPackages({ includeInactive = false } = {}) {
  return Array.from(state.packages.values())
    .filter(p => includeInactive || p.isActive)
    .sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder) || Number(a.priceIdr) - Number(b.priceIdr))
    .map(p => ({
      ...p,
      totalDiamonds: Number(p.diamonds) + Number(p.bonusDiamonds || 0)
    }));
}

async function createDiamondTopupOrder({ userId, packageId, paymentMethod = 'SP', host = '' }) {
  const db = getDb();
  const user = db.findUserById(userId);
  if (!user) throw makeError(404, 'Pengguna tidak ditemukan.');

  const pkg = state.packages.get(packageId);
  if (!pkg || !pkg.isActive) {
    throw makeError(400, 'Paket Diamond tidak tersedia atau sudah tidak aktif.');
  }

  return withUserLock(userId, async () => {
    const orderId = `PGD_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const totalDiamonds = Number(pkg.diamonds) + Number(pkg.bonusDiamonds || 0);
    const amountIdr = Number(pkg.priceIdr);
    const resolvedMethod = String(paymentMethod || 'SP').trim().toUpperCase().slice(0, 16) || 'SP';
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const activeGateway = paymentGateway.getActiveGatewayName();

    const invoice = await paymentGateway.createInvoice({
      gateway: activeGateway,
      orderId,
      pkg: {
        id: pkg.id,
        name: pkg.name,
        price: amountIdr,
        priceIdr: amountIdr,
        diamonds: pkg.diamonds,
        totalDiamonds
      },
      user,
      host,
      callbackPath: '/api/economy/topup/callback',
      paymentMethod: resolvedMethod
    });
    const orderGateway = invoice.gateway || activeGateway;

    const order = {
      id: orderId,
      userId,
      packageId: pkg.id,
      packageName: pkg.name,
      diamonds: Number(pkg.diamonds),
      bonusDiamonds: Number(pkg.bonusDiamonds || 0),
      totalDiamonds,
      amountIdr,
      paymentMethod: invoice.paymentMethod || resolvedMethod,
      paymentMethodName: invoice.paymentMethodName || null,
      paymentCategory: invoice.paymentCategory || null,
      bank: invoice.bank || null,
      vaNumber: invoice.vaNumber || null,
      qrString: invoice.qrString || null,
      qrCodeUrl: invoice.qrCodeUrl || null,
      deeplinkUrl: invoice.deeplinkUrl || null,
      gateway: orderGateway,
      gatewayReference: invoice.reference || null,
      paymentUrl: invoice.paymentUrl || null,
      status: 'PENDING',
      creditedAt: null,
      expiresAt,
      failureReason: null,
      rawCreateResponse: invoice,
      createdAt: now,
      updatedAt: now
    };

    const pool = getPool();
    if (pool) {
      await pool.query(
        `INSERT INTO payment_orders
           (id, user_id, package_id, package_name, diamonds, bonus_diamonds, total_diamonds, amount_idr, payment_method, gateway, gateway_reference, payment_url, status, expires_at, raw_create_response, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'PENDING', $13, $14, $15, $15)`,
        [
          order.id,
          order.userId,
          order.packageId,
          order.packageName,
          order.diamonds,
          order.bonusDiamonds,
          order.totalDiamonds,
          order.amountIdr,
          order.paymentMethod,
          order.gateway,
          order.gatewayReference,
          order.paymentUrl,
          order.expiresAt,
          JSON.stringify(order.rawCreateResponse),
          now
        ]
      );
    }

    state.paymentOrders.set(orderId, order);
    persistLocalFallback();

    return {
      success: true,
      order,
      invoice: {
        orderId: order.id,
        gateway: order.gateway,
        reference: order.gatewayReference,
        paymentUrl: order.paymentUrl,
        vaNumber: order.vaNumber,
        qrString: order.qrString,
        qrCodeUrl: order.qrCodeUrl,
        deeplinkUrl: order.deeplinkUrl || invoice.deeplinkUrl || null,
        paymentMethod: order.paymentMethod,
        paymentMethodName: order.paymentMethodName,
        paymentCategory: order.paymentCategory,
        bank: order.bank,
        merchantCode: invoice.merchantCode,
        amountIdr: order.amountIdr,
        totalDiamonds: order.totalDiamonds,
        expiresAt: order.expiresAt,
        isSimulation: Boolean(invoice.isSimulation)
      }
    };
  });
}

function recordCallbackLog({
  orderId = null,
  gateway = paymentGateway.getActiveGatewayName(),
  merchantCode = null,
  amountRaw = null,
  resultCode = null,
  signatureReceived = null,
  signatureValid = false,
  processingStatus,
  notes = '',
  payload = {}
}) {
  const entry = Object.freeze({
    id: 'cb_' + crypto.randomUUID(),
    orderId: orderId ? String(orderId) : null,
    gateway: String(gateway || 'doku'),
    merchantCode: merchantCode ? String(merchantCode) : null,
    amountRaw: amountRaw !== undefined && amountRaw !== null ? String(amountRaw) : null,
    resultCode: resultCode !== undefined && resultCode !== null ? String(resultCode) : null,
    signatureReceived: signatureReceived ? String(signatureReceived) : null,
    signatureValid: Boolean(signatureValid),
    processingStatus,
    notes: String(notes || ''),
    payload: Object.freeze({ ...(payload || {}) }),
    createdAt: new Date().toISOString()
  });
  state.callbackLogs.push(entry);
  const pool = getPool();
  if (pool) {
    getDb().execPg(
      `INSERT INTO payment_callback_logs
         (id, order_id, gateway, merchant_code, amount_raw, result_code, signature_received, signature_valid, processing_status, notes, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        entry.id,
        entry.orderId,
        entry.gateway,
        entry.merchantCode,
        entry.amountRaw,
        entry.resultCode,
        entry.signatureReceived,
        entry.signatureValid,
        entry.processingStatus,
        entry.notes,
        JSON.stringify(entry.payload),
        entry.createdAt
      ]
    );
  }
  persistLocalFallback();
  return entry;
}

async function applyOrderPaidCredit(order, sourceLabel = 'duitku_callback') {
  const db = getDb();
  const idempotencyKey = `topup:${order.id}`;

  return withUserLock(order.userId, async () => {
    if (order.status === 'PAID' || state.idempotencyIndex.has(idempotencyKey)) {
      return { alreadyCredited: true, order, wallet: formatWalletResponse(order.userId) };
    }
    if (order.status !== 'PENDING') {
      return { ignored: true, status: order.status, order, wallet: formatWalletResponse(order.userId) };
    }

    const wallet = ensureWalletRecord(order.userId);
    const prevDiamonds = Number(wallet.balance || 0);
    const creditAmount = Number(order.totalDiamonds);
    const nextDiamonds = prevDiamonds + creditAmount;
    const now = new Date().toISOString();

    const tx = buildDiamondTransaction({
      userId: order.userId,
      txType: 'TOPUP',
      amount: creditAmount,
      previousBalance: prevDiamonds,
      newBalance: nextDiamonds,
      referenceId: order.id,
      idempotencyKey,
      description: `Top-up ${order.packageName} (+${creditAmount} Diamonds)`,
      metadata: {
        packageId: order.packageId,
        amountIdr: order.amountIdr,
        gatewayReference: order.gatewayReference,
        source: sourceLabel
      },
      createdAt: now
    });

    const pool = getPool();
    if (pool) {
      let txReplay = false;
      await db.execPgTransaction(async client => {
        const ordRes = await client.query(
          'SELECT status, credited_at FROM payment_orders WHERE id = $1 FOR UPDATE',
          [order.id]
        );
        if (!ordRes.rows || !ordRes.rows[0]) {
          throw makeError(404, 'Order top-up tidak ditemukan.');
        }
        if (ordRes.rows[0].status === 'PAID' || ordRes.rows[0].credited_at) {
          txReplay = true;
          return;
        }
        if (ordRes.rows[0].status !== 'PENDING') {
          txReplay = true;
          return;
        }

        await client.query(
          `INSERT INTO diamond_wallets (user_id, balance, total_purchased)
           VALUES ($1, 0, 0) ON CONFLICT (user_id) DO NOTHING`,
          [order.userId]
        );
        const wRes = await client.query(
          'SELECT balance FROM diamond_wallets WHERE user_id = $1 FOR UPDATE',
          [order.userId]
        );
        const pgPrev = Number(wRes.rows[0].balance || 0);
        const pgNext = pgPrev + creditAmount;
        await client.query(
          `UPDATE diamond_wallets
           SET balance = $1, total_purchased = total_purchased + $2, updated_at = NOW()
           WHERE user_id = $3`,
          [pgNext, creditAmount, order.userId]
        );
        await client.query(
          `UPDATE payment_orders
           SET status = 'PAID', credited_at = $1, updated_at = $1
           WHERE id = $2`,
          [now, order.id]
        );
        await client.query(
          `INSERT INTO diamond_transactions
             (id, user_id, tx_type, amount, previous_balance, new_balance, reference_id, idempotency_key, description, metadata, created_at)
           VALUES ($1, $2, 'TOPUP', $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            tx.id,
            order.userId,
            tx.amount,
            pgPrev,
            pgNext,
            tx.referenceId,
            tx.idempotencyKey,
            tx.description,
            JSON.stringify(tx.metadata),
            now
          ]
        );
      });
      if (txReplay) {
        return { alreadyCredited: true, order, wallet: formatWalletResponse(order.userId) };
      }
    }

    wallet.balance = nextDiamonds;
    wallet.totalPurchased = Number(wallet.totalPurchased || 0) + creditAmount;
    wallet.updatedAt = now;
    order.status = 'PAID';
    order.creditedAt = now;
    order.updatedAt = now;
    recordTxInMemory(tx);
    persistLocalFallback();

    return {
      alreadyCredited: false,
      order,
      transaction: tx,
      wallet: formatWalletResponse(order.userId)
    };
  });
}

async function markOrderNonPaidStatus(order, nextStatus, reason = '') {
  if (!ALLOWED_ORDER_STATUSES.includes(nextStatus) || nextStatus === 'PAID') {
    throw makeError(400, `Status order tidak valid: ${nextStatus}`);
  }
  if (order.status !== 'PENDING') {
    return order;
  }
  const now = new Date().toISOString();
  const pool = getPool();
  if (pool) {
    await pool.query(
      `UPDATE payment_orders SET status = $1, failure_reason = $2, updated_at = $3 WHERE id = $4 AND status = 'PENDING'`,
      [nextStatus, reason || null, now, order.id]
    );
  }
  order.status = nextStatus;
  order.failureReason = reason || null;
  order.updatedAt = now;
  persistLocalFallback();
  return order;
}

async function handleDuitkuDiamondCallback(payload, headers = {}) {
  const preNorm = paymentGateway.normalizeCallback(payload, headers);
  const existingOrder = preNorm.merchantOrderId
    ? state.paymentOrders.get(String(preNorm.merchantOrderId))
    : null;
  const gateway = existingOrder?.gateway || preNorm.gateway || paymentGateway.getActiveGatewayName();
  const norm = paymentGateway.normalizeCallback(payload, headers, existingOrder?.gateway || gateway);

  const {
    merchantCode,
    amount,
    merchantOrderId,
    resultCode,
    reference,
    statusMessage,
    signature
  } = norm;

  const sigValid = paymentGateway.verifyCallback(payload, headers, existingOrder?.gateway || gateway);
  if (!sigValid) {
    recordCallbackLog({
      orderId: merchantOrderId,
      gateway,
      merchantCode,
      amountRaw: amount,
      resultCode,
      signatureReceived: signature,
      signatureValid: false,
      processingStatus: 'REJECTED_INVALID_SIGNATURE',
      notes: `Signature callback ${gateway.toUpperCase()} tidak valid atau merchantCode tidak cocok.`,
      payload
    });
    return { httpStatus: 400, success: false, error: `Invalid ${gateway.toUpperCase()} callback signature.` };
  }

  if (!merchantOrderId) {
    recordCallbackLog({
      orderId: null,
      gateway,
      merchantCode,
      amountRaw: amount,
      resultCode,
      signatureReceived: signature,
      signatureValid: true,
      processingStatus: 'MISSING_ORDER_ID',
      notes: 'merchantOrderId kosong.',
      payload
    });
    return { httpStatus: 400, success: false, error: 'merchantOrderId wajib disertakan.' };
  }

  return withOrderLock(merchantOrderId, async () => {
    const order = state.paymentOrders.get(String(merchantOrderId));
    if (!order) {
      recordCallbackLog({
        orderId: merchantOrderId,
        gateway,
        merchantCode,
        amountRaw: amount,
        resultCode,
        signatureReceived: signature,
        signatureValid: true,
        processingStatus: 'ORDER_NOT_FOUND',
        notes: 'Order internal tidak ditemukan.',
        payload
      });
      return { httpStatus: 404, success: false, error: 'Order top-up tidak ditemukan.' };
    }

    const orderGw = order.gateway || gateway;
    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount !== Number(order.amountIdr)) {
      recordCallbackLog({
        orderId: order.id,
        gateway: orderGw,
        merchantCode,
        amountRaw: amount,
        resultCode,
        signatureReceived: signature,
        signatureValid: true,
        processingStatus: 'AMOUNT_MISMATCH',
        notes: `Nominal tidak cocok: diterima ${amount}, seharusnya ${order.amountIdr}`,
        payload
      });
      return { httpStatus: 400, success: false, error: 'Nominal pembayaran tidak sesuai dengan order.' };
    }

    if (reference && !order.gatewayReference) {
      order.gatewayReference = String(reference);
    }

    const code = String(resultCode || '');

    // Expiry check if order still PENDING and expired before confirmation
    if (order.status === 'PENDING' && order.expiresAt && Date.now() > Date.parse(order.expiresAt)) {
      await markOrderNonPaidStatus(order, 'EXPIRED', 'Batas waktu pembayaran order telah berakhir.');
      recordCallbackLog({
        orderId: order.id,
        gateway: orderGw,
        merchantCode,
        amountRaw: amount,
        resultCode: code,
        signatureReceived: signature,
        signatureValid: true,
        processingStatus: 'EXPIRED_BEFORE_CALLBACK',
        notes: 'Order telah kedaluwarsa.',
        payload
      });
      return { httpStatus: 200, success: true, status: order.status, order };
    }

    if (code === '00') {
      if (order.status === 'PAID') {
        recordCallbackLog({
          orderId: order.id,
          gateway: orderGw,
          merchantCode,
          amountRaw: amount,
          resultCode: code,
          signatureReceived: signature,
          signatureValid: true,
          processingStatus: 'DUPLICATE_PAID_IGNORED',
          notes: 'Callback duplikat pada order yang sudah PAID diabaikan secara idempoten.',
          payload
        });
        return {
          httpStatus: 200,
          success: true,
          alreadyProcessed: true,
          status: 'PAID',
          order,
          wallet: formatWalletResponse(order.userId)
        };
      }

      if (order.status !== 'PENDING') {
        recordCallbackLog({
          orderId: order.id,
          gateway: orderGw,
          merchantCode,
          amountRaw: amount,
          resultCode: code,
          signatureReceived: signature,
          signatureValid: true,
          processingStatus: `IGNORED_TERMINAL_${order.status}`,
          notes: `Callback PAID ditolak karena status order sudah ${order.status}.`,
          payload
        });
        return {
          httpStatus: 200,
          success: true,
          ignored: true,
          status: order.status,
          order
        };
      }

      const creditRes = await applyOrderPaidCredit(order, `${orderGw}_callback`);
      recordCallbackLog({
        orderId: order.id,
        gateway: orderGw,
        merchantCode,
        amountRaw: amount,
        resultCode: code,
        signatureReceived: signature,
        signatureValid: true,
        processingStatus: creditRes.alreadyCredited ? 'DUPLICATE_PAID_IGNORED' : 'CREDITED_PAID',
        notes: creditRes.alreadyCredited
          ? 'Order sudah dikreditkan sebelumnya.'
          : `Berhasil mengkreditkan ${order.totalDiamonds} Diamonds.`,
        payload
      });
      return {
        httpStatus: 200,
        success: true,
        alreadyProcessed: Boolean(creditRes.alreadyCredited),
        status: 'PAID',
        order: creditRes.order,
        wallet: creditRes.wallet
      };
    }

    if (code === '01') {
      order.updatedAt = new Date().toISOString();
      persistLocalFallback();
      recordCallbackLog({
        orderId: order.id,
        gateway: orderGw,
        merchantCode,
        amountRaw: amount,
        resultCode: code,
        signatureReceived: signature,
        signatureValid: true,
        processingStatus: 'PENDING_NOTIFICATION',
        notes: 'Pembayaran masih berstatus PENDING.',
        payload
      });
      return { httpStatus: 200, success: true, status: order.status, order };
    }

    // Mapping failure / expired / cancelled (resultCode '02' or explicit status)
    const msgUpper = String(statusMessage || payload?.status || '').toUpperCase();
    let finalStatus = 'FAILED';
    if (msgUpper.includes('EXPIRED') || msgUpper.includes('KADALUARSA') || code === 'EXPIRED') {
      finalStatus = 'EXPIRED';
    } else if (msgUpper.includes('CANCEL') || msgUpper.includes('BATAL') || code === 'CANCELLED') {
      finalStatus = 'CANCELLED';
    }

    await markOrderNonPaidStatus(order, finalStatus, statusMessage || `${orderGw.toUpperCase()} resultCode: ${code}`);
    recordCallbackLog({
      orderId: order.id,
      gateway: orderGw,
      merchantCode,
      amountRaw: amount,
      resultCode: code,
      signatureReceived: signature,
      signatureValid: true,
      processingStatus: `MARKED_${finalStatus}`,
      notes: `Status order diperbarui menjadi ${finalStatus}.`,
      payload
    });

    return { httpStatus: 200, success: true, status: order.status, order };
  });
}

async function getAndVerifyOrderStatus({ orderId, requesterUser }) {
  const db = getDb();
  const order = state.paymentOrders.get(orderId);
  if (!order) throw makeError(404, 'Order top-up tidak ditemukan.');

  const isAdmin = db.isUserAdmin(requesterUser);
  if (!isAdmin && order.userId !== requesterUser.id) {
    throw makeError(403, 'Kamu tidak memiliki akses ke order pembayaran ini.');
  }

  return withOrderLock(orderId, async () => {
    if (order.status === 'PENDING' && order.expiresAt && Date.now() > Date.parse(order.expiresAt)) {
      await markOrderNonPaidStatus(order, 'EXPIRED', 'Batas waktu pembayaran berakhir.');
      return { order: enrichOrderFields(order), verifiedWithGateway: false, wallet: formatWalletResponse(order.userId) };
    }

    if (order.status === 'PENDING') {
      const orderGw = order.gateway || paymentGateway.getActiveGatewayName();
      const gatewayRes = await paymentGateway.checkStatus(order.id, orderGw);
      if (gatewayRes && gatewayRes.statusCode) {
        const gwAmount =
          gatewayRes.amount !== undefined && gatewayRes.amount !== null && String(gatewayRes.amount).trim() !== ''
            ? Number(gatewayRes.amount)
            : Number(order.amountIdr);
        if (String(gatewayRes.statusCode) === '00' && gwAmount === Number(order.amountIdr)) {
          const creditRes = await applyOrderPaidCredit(order, `${orderGw}_status_verify`);
          return {
            order: enrichOrderFields(creditRes.order),
            verifiedWithGateway: true,
            wallet: creditRes.wallet
          };
        }
        if (String(gatewayRes.statusCode) === '02') {
          const msg = String(gatewayRes.statusMessage || '').toUpperCase();
          const st = msg.includes('EXPIRED') ? 'EXPIRED' : msg.includes('CANCEL') ? 'CANCELLED' : 'FAILED';
          await markOrderNonPaidStatus(order, st, gatewayRes.statusMessage || `${orderGw.toUpperCase()} status 02`);
        }
      }
    }

    return {
      order: enrichOrderFields(order),
      verifiedWithGateway: false,
      wallet: formatWalletResponse(order.userId)
    };
  });
}

async function cancelPendingOrder({ orderId, userId }) {
  const order = state.paymentOrders.get(orderId);
  if (!order) throw makeError(404, 'Order top-up tidak ditemukan.');
  if (order.userId !== userId) throw makeError(403, 'Tidak diizinkan membatalkan order pengguna lain.');

  return withOrderLock(orderId, async () => {
    if (order.status === 'PAID') {
      throw makeError(400, 'Order yang sudah dibayar tidak dapat dibatalkan.');
    }
    if (order.status === 'PENDING') {
      await markOrderNonPaidStatus(order, 'CANCELLED', 'Dibatalkan oleh pengguna.');
    }
    return { success: true, order };
  });
}

// ==========================================
// LUDO SKIN SHOP & EQUIP SYSTEM
// ==========================================

function listLudoSkins({ userId = null, includeInactive = false } = {}) {
  const ownedMap = userId ? state.ownedSkins.get(userId) : null;
  const equippedId = userId ? state.equippedSkins.get(userId) || null : null;

  return Array.from(state.skins.values())
    .filter(s => includeInactive || s.isActive)
    .sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder) || Number(a.priceDiamonds) - Number(b.priceDiamonds))
    .map(s => {
      const ownedInfo = ownedMap ? ownedMap.get(s.id) : null;
      return {
        ...s,
        owned: Boolean(ownedInfo),
        equipped: Boolean(ownedInfo && equippedId === s.id),
        purchasedAt: ownedInfo ? ownedInfo.purchasedAt : null
      };
    });
}

function getUserSkinInventory(userId) {
  const ownedMap = state.ownedSkins.get(userId) || new Map();
  const equippedId = state.equippedSkins.get(userId) || null;
  const items = [];
  for (const [skinId, info] of ownedMap.entries()) {
    const skin = state.skins.get(skinId);
    if (!skin) continue;
    items.push({
      ...skin,
      owned: true,
      equipped: equippedId === skinId,
      purchasedAt: info.purchasedAt,
      pricePaidDiamonds: info.pricePaidDiamonds
    });
  }
  items.sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder));
  return {
    equippedSkinId: equippedId,
    equippedSkin: getEquippedSkinSync(userId),
    skins: items
  };
}

function syncEquippedSkinToActiveRooms(userId) {
  try {
    const roomStore = require('../game/store');
    if (typeof roomStore.syncPlayerSkin === 'function') {
      roomStore.syncPlayerSkin(userId, getEquippedSkinSync(userId));
    }
  } catch {
    // Abaikan jika game store belum di-init pada unit test tertentu
  }
}

async function purchaseLudoSkin({ userId, skinId, idempotencyKey = null }) {
  const db = getDb();
  const user = db.findUserById(userId);
  if (!user) throw makeError(404, 'Pengguna tidak ditemukan.');

  const skin = state.skins.get(skinId);
  if (!skin || !skin.isActive) {
    throw makeError(404, 'Skin Ludo tidak ditemukan atau sedang tidak dijual.');
  }

  const cleanKey = idempotencyKey ? `skin:${userId}:${skinId}:${String(idempotencyKey).slice(0, 80)}` : null;

  return withUserLock(userId, async () => {
    if (cleanKey && state.idempotencyIndex.has(cleanKey)) {
      return {
        success: true,
        idempotentReplay: true,
        skin,
        transaction: state.idempotencyIndex.get(cleanKey),
        wallet: formatWalletResponse(userId),
        inventory: getUserSkinInventory(userId),
        user: db.sanitizeUser(db.findUserById(userId))
      };
    }

    if (!state.ownedSkins.has(userId)) state.ownedSkins.set(userId, new Map());
    const ownedMap = state.ownedSkins.get(userId);
    if (ownedMap.has(skinId)) {
      throw makeError(409, `Kamu sudah memiliki skin ${skin.name}.`);
    }

    const wallet = ensureWalletRecord(userId);
    const price = Number(skin.priceDiamonds);
    const prevDiamonds = Number(wallet.balance || 0);
    if (prevDiamonds < price) {
      throw makeError(
        400,
        `Diamonds tidak mencukupi. Dibutuhkan ${price} Diamonds untuk membeli ${skin.name} (saldo kamu: ${prevDiamonds} Diamonds).`
      );
    }

    const nextDiamonds = prevDiamonds - price;
    const now = new Date().toISOString();

    const tx = buildDiamondTransaction({
      userId,
      txType: 'SKIN_PURCHASE',
      amount: -price,
      previousBalance: prevDiamonds,
      newBalance: nextDiamonds,
      referenceId: skin.id,
      idempotencyKey: cleanKey,
      description: `Membeli Skin Bidak Ludo: ${skin.name} (${skin.rarity})`,
      metadata: {
        skinId: skin.id,
        skinName: skin.name,
        rarity: skin.rarity,
        priceDiamonds: price
      },
      createdAt: now
    });

    const pool = getPool();
    if (pool) {
      await db.execPgTransaction(async client => {
        const ownCheck = await client.query(
          'SELECT 1 FROM user_ludo_skins WHERE user_id = $1 AND skin_id = $2',
          [userId, skinId]
        );
        if (ownCheck.rows && ownCheck.rows.length > 0) {
          throw makeError(409, `Kamu sudah memiliki skin ${skin.name}.`);
        }

        await client.query(
          `INSERT INTO diamond_wallets (user_id, balance, total_spent)
           VALUES ($1, 0, 0) ON CONFLICT (user_id) DO NOTHING`,
          [userId]
        );
        const wRes = await client.query(
          'SELECT balance FROM diamond_wallets WHERE user_id = $1 FOR UPDATE',
          [userId]
        );
        const pgPrev = Number(wRes.rows[0].balance || 0);
        if (pgPrev < price) {
          throw makeError(400, 'Saldo Diamonds tidak mencukupi di database.');
        }
        const pgNext = pgPrev - price;
        await client.query(
          `UPDATE diamond_wallets
           SET balance = $1, total_spent = total_spent + $2, updated_at = NOW()
           WHERE user_id = $3`,
          [pgNext, price, userId]
        );
        await client.query(
          `INSERT INTO user_ludo_skins (user_id, skin_id, purchase_tx_id, price_paid_diamonds, purchased_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [userId, skin.id, tx.id, price, now]
        );
        await client.query(
          `INSERT INTO diamond_transactions
             (id, user_id, tx_type, amount, previous_balance, new_balance, reference_id, idempotency_key, description, metadata, created_at)
           VALUES ($1, $2, 'SKIN_PURCHASE', $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            tx.id,
            userId,
            tx.amount,
            pgPrev,
            pgNext,
            tx.referenceId,
            tx.idempotencyKey,
            tx.description,
            JSON.stringify(tx.metadata),
            now
          ]
        );
      });
    }

    wallet.balance = nextDiamonds;
    wallet.totalSpent = Number(wallet.totalSpent || 0) + price;
    wallet.updatedAt = now;
    ownedMap.set(skin.id, {
      skinId: skin.id,
      purchaseTxId: tx.id,
      pricePaidDiamonds: price,
      purchasedAt: now
    });
    recordTxInMemory(tx);
    persistLocalFallback();

    return {
      success: true,
      idempotentReplay: false,
      skin: { ...skin, owned: true, equipped: state.equippedSkins.get(userId) === skin.id },
      transaction: tx,
      wallet: formatWalletResponse(userId),
      inventory: getUserSkinInventory(userId),
      user: db.sanitizeUser(db.findUserById(userId))
    };
  });
}

async function equipLudoSkin({ userId, skinId = null }) {
  const db = getDb();
  const user = db.findUserById(userId);
  if (!user) throw makeError(404, 'Pengguna tidak ditemukan.');

  const targetId = !skinId || skinId === 'default' || skinId === 'none' ? null : String(skinId);

  return withUserLock(userId, async () => {
    if (targetId !== null) {
      const owned = state.ownedSkins.get(userId);
      if (!owned || !owned.has(targetId)) {
        throw makeError(403, 'Kamu belum memiliki skin ini. Beli terlebih dahulu di Skin Shop.');
      }
      if (!state.skins.has(targetId)) {
        throw makeError(404, 'Data skin tidak ditemukan.');
      }
    }

    const pool = getPool();
    const now = new Date().toISOString();
    if (pool) {
      await pool.query(
        `INSERT INTO user_ludo_equipped_skins (user_id, skin_id, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET skin_id = EXCLUDED.skin_id, updated_at = EXCLUDED.updated_at`,
        [userId, targetId, now]
      );
    }

    state.equippedSkins.set(userId, targetId);
    persistLocalFallback();
    syncEquippedSkinToActiveRooms(userId);

    return {
      success: true,
      equippedSkinId: targetId,
      equippedSkin: getEquippedSkinSync(userId),
      inventory: getUserSkinInventory(userId),
      user: db.sanitizeUser(db.findUserById(userId))
    };
  });
}

// ==========================================
// ADMIN DASHBOARD MANAGEMENT
// ==========================================

async function updateEconomySettings({
  coinsPerDiamond,
  minConvertDiamonds,
  maxConvertDiamonds,
  conversionEnabled,
  adminUser
}) {
  const rate = Number(coinsPerDiamond);
  const minD = Number(minConvertDiamonds);
  const maxD = Number(maxConvertDiamonds);
  const enabled = conversionEnabled === undefined ? state.settings.conversionEnabled : Boolean(conversionEnabled);

  if (!Number.isInteger(rate) || rate < 1 || rate > 1000000) {
    throw makeError(400, 'Kurs Coins per 1 Diamond harus bilangan bulat antara 1 hingga 1.000.000.');
  }
  if (!Number.isInteger(minD) || minD < 1) {
    throw makeError(400, 'Minimum konversi Diamonds minimal 1.');
  }
  if (!Number.isInteger(maxD) || maxD < minD) {
    throw makeError(400, 'Maksimum konversi Diamonds harus >= minimum konversi.');
  }

  const now = new Date().toISOString();
  const updatedBy = adminUser?.username || adminUser?.id || 'admin';
  const pool = getPool();
  if (pool) {
    await pool.query(
      `INSERT INTO economy_settings (id, coins_per_diamond, min_convert_diamonds, max_convert_diamonds, conversion_enabled, updated_at, updated_by)
       VALUES (1, $1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         coins_per_diamond = EXCLUDED.coins_per_diamond,
         min_convert_diamonds = EXCLUDED.min_convert_diamonds,
         max_convert_diamonds = EXCLUDED.max_convert_diamonds,
         conversion_enabled = EXCLUDED.conversion_enabled,
         updated_at = EXCLUDED.updated_at,
         updated_by = EXCLUDED.updated_by`,
      [rate, minD, maxD, enabled, now, updatedBy]
    );
  }

  state.settings = {
    coinsPerDiamond: rate,
    minConvertDiamonds: minD,
    maxConvertDiamonds: maxD,
    conversionEnabled: enabled,
    updatedAt: now,
    updatedBy
  };
  persistLocalFallback();
  return getEconomySettings();
}

async function upsertDiamondPackage(input) {
  const rawId = String(input.id || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_');
  const id = rawId || `pkg_${crypto.randomBytes(4).toString('hex')}`;
  const existing = state.packages.get(id);

  const name = String(input.name ?? existing?.name ?? '').trim().slice(0, 60);
  const diamonds = Number(input.diamonds ?? existing?.diamonds);
  const bonusDiamonds = Number(input.bonusDiamonds ?? existing?.bonusDiamonds ?? 0);
  const priceIdr = Number(input.priceIdr ?? existing?.priceIdr);
  const badge = String(input.badge ?? existing?.badge ?? '').trim().slice(0, 32);
  const sortOrder = Number(input.sortOrder ?? existing?.sortOrder ?? 10);
  const isActive = input.isActive === undefined ? (existing ? existing.isActive : true) : Boolean(input.isActive);

  if (!name) throw makeError(400, 'Nama paket wajib diisi.');
  if (!Number.isInteger(diamonds) || diamonds < 1) throw makeError(400, 'Jumlah Diamonds harus bilangan bulat >= 1.');
  if (!Number.isInteger(bonusDiamonds) || bonusDiamonds < 0) throw makeError(400, 'Bonus Diamonds harus bilangan bulat >= 0.');
  if (!Number.isInteger(priceIdr) || priceIdr < 1000) throw makeError(400, 'Harga IDR minimal Rp 1.000.');

  const now = new Date().toISOString();
  const record = {
    id,
    name,
    diamonds,
    bonusDiamonds,
    priceIdr,
    badge,
    sortOrder: Number.isFinite(sortOrder) ? Math.trunc(sortOrder) : 10,
    isActive,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };

  const pool = getPool();
  if (pool) {
    await pool.query(
      `INSERT INTO diamond_topup_packages (id, name, diamonds, bonus_diamonds, price_idr, badge, sort_order, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         diamonds = EXCLUDED.diamonds,
         bonus_diamonds = EXCLUDED.bonus_diamonds,
         price_idr = EXCLUDED.price_idr,
         badge = EXCLUDED.badge,
         sort_order = EXCLUDED.sort_order,
         is_active = EXCLUDED.is_active,
         updated_at = EXCLUDED.updated_at`,
      [record.id, record.name, record.diamonds, record.bonusDiamonds, record.priceIdr, record.badge, record.sortOrder, record.isActive, record.createdAt, record.updatedAt]
    );
  }

  state.packages.set(id, record);
  persistLocalFallback();
  return { ...record, totalDiamonds: record.diamonds + record.bonusDiamonds };
}

async function upsertLudoSkin(input) {
  const rawId = String(input.id || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_');
  const id = rawId || `skin_${crypto.randomBytes(4).toString('hex')}`;
  const existing = state.skins.get(id);

  const name = String(input.name ?? existing?.name ?? '').trim().slice(0, 60);
  const description = String(input.description ?? existing?.description ?? '').trim().slice(0, 280);
  const priceDiamonds = Number(input.priceDiamonds ?? existing?.priceDiamonds);
  const rarity = String(input.rarity ?? existing?.rarity ?? 'Common').trim();
  const assetKey = String(input.assetKey ?? existing?.assetKey ?? id).trim().slice(0, 60) || id;
  const previewUrl = String(input.previewUrl ?? existing?.previewUrl ?? '').trim().slice(0, 300);
  const imageUrl = String(input.imageUrl ?? existing?.imageUrl ?? '').trim().slice(0, 300);
  const accentColor = String(input.accentColor ?? existing?.accentColor ?? '#fbbf24').trim().slice(0, 24);
  const sortOrder = Number(input.sortOrder ?? existing?.sortOrder ?? 10);
  const isActive = input.isActive === undefined ? (existing ? existing.isActive : true) : Boolean(input.isActive);

  if (!name) throw makeError(400, 'Nama skin wajib diisi.');
  if (!Number.isInteger(priceDiamonds) || priceDiamonds < 10 || priceDiamonds > 50) {
    throw makeError(400, 'Harga skin harus antara 10 hingga 50 Diamonds.');
  }
  if (!ALLOWED_RARITIES.includes(rarity)) {
    throw makeError(400, `Rarity harus salah satu dari: ${ALLOWED_RARITIES.join(', ')}`);
  }

  const now = new Date().toISOString();
  const record = {
    id,
    name,
    description,
    priceDiamonds,
    rarity,
    assetKey,
    previewUrl,
    imageUrl,
    accentColor,
    isActive,
    sortOrder: Number.isFinite(sortOrder) ? Math.trunc(sortOrder) : 10,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };

  const pool = getPool();
  if (pool) {
    await pool.query(
      `INSERT INTO ludo_skins (id, name, description, price_diamonds, rarity, asset_key, preview_url, image_url, accent_color, is_active, sort_order, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         price_diamonds = EXCLUDED.price_diamonds,
         rarity = EXCLUDED.rarity,
         asset_key = EXCLUDED.asset_key,
         preview_url = EXCLUDED.preview_url,
         image_url = EXCLUDED.image_url,
         accent_color = EXCLUDED.accent_color,
         is_active = EXCLUDED.is_active,
         sort_order = EXCLUDED.sort_order,
         updated_at = EXCLUDED.updated_at`,
      [
        record.id,
        record.name,
        record.description,
        record.priceDiamonds,
        record.rarity,
        record.assetKey,
        record.previewUrl,
        record.imageUrl,
        record.accentColor,
        record.isActive,
        record.sortOrder,
        record.createdAt,
        record.updatedAt
      ]
    );
  }

  state.skins.set(id, record);
  persistLocalFallback();
  return record;
}

async function adminAdjustDiamonds({ targetUserId, amount, reason, txType = 'ADMIN_ADJUSTMENT', adminUser }) {
  const db = getDb();
  const targetUser = db.findUserById(targetUserId) || db.findUserByUsername(targetUserId);
  if (!targetUser) throw makeError(404, 'Pemain tujuan tidak ditemukan.');

  const delta = Number(amount);
  if (!Number.isInteger(delta) || delta === 0) {
    throw makeError(400, 'Jumlah penyesuaian Diamonds harus bilangan bulat bukan nol.');
  }
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) {
    throw makeError(400, 'Alasan penyesuaian wajib diisi untuk audit.');
  }
  const resolvedType = txType === 'REFUND' ? 'REFUND' : 'ADMIN_ADJUSTMENT';
  if (resolvedType === 'REFUND' && delta < 0) {
    throw makeError(400, 'Transaksi REFUND harus bernilai positif.');
  }

  return withUserLock(targetUser.id, async () => {
    const wallet = ensureWalletRecord(targetUser.id);
    const prev = Number(wallet.balance || 0);
    const next = prev + delta;
    if (next < 0) {
      throw makeError(400, `Saldo Diamonds tidak boleh negatif (saldo saat ini: ${prev}).`);
    }

    const now = new Date().toISOString();
    const tx = buildDiamondTransaction({
      userId: targetUser.id,
      txType: resolvedType,
      amount: delta,
      previousBalance: prev,
      newBalance: next,
      referenceId: adminUser?.id || null,
      description: cleanReason,
      metadata: {
        adminId: adminUser?.id || null,
        adminUsername: adminUser?.username || null,
        reason: cleanReason
      },
      createdAt: now
    });

    const pool = getPool();
    if (pool) {
      await db.execPgTransaction(async client => {
        await client.query(
          `INSERT INTO diamond_wallets (user_id, balance) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`,
          [targetUser.id]
        );
        const wRes = await client.query(
          'SELECT balance FROM diamond_wallets WHERE user_id = $1 FOR UPDATE',
          [targetUser.id]
        );
        const pgPrev = Number(wRes.rows[0].balance || 0);
        const pgNext = pgPrev + delta;
        if (pgNext < 0) throw makeError(400, 'Saldo Diamonds tidak mencukupi di database.');
        await client.query(
          `UPDATE diamond_wallets
           SET balance = $1,
               total_refunded = total_refunded + $2,
               total_admin_adjusted = total_admin_adjusted + $3,
               updated_at = NOW()
           WHERE user_id = $4`,
          [pgNext, resolvedType === 'REFUND' ? delta : 0, resolvedType === 'ADMIN_ADJUSTMENT' ? delta : 0, targetUser.id]
        );
        await client.query(
          `INSERT INTO diamond_transactions
             (id, user_id, tx_type, amount, previous_balance, new_balance, reference_id, idempotency_key, description, metadata, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10)`,
          [tx.id, targetUser.id, tx.txType, tx.amount, pgPrev, pgNext, tx.referenceId, tx.description, JSON.stringify(tx.metadata), now]
        );
      });
    }

    wallet.balance = next;
    if (resolvedType === 'REFUND') {
      wallet.totalRefunded = Number(wallet.totalRefunded || 0) + delta;
    } else {
      wallet.totalAdminAdjusted = Number(wallet.totalAdminAdjusted || 0) + delta;
    }
    wallet.updatedAt = now;
    recordTxInMemory(tx);
    persistLocalFallback();

    return {
      success: true,
      transaction: tx,
      wallet: formatWalletResponse(targetUser.id)
    };
  });
}

function getAdminOverview({ limit = 50, txType = '' } = {}) {
  const db = getDb();
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));

  const orders = Array.from(state.paymentOrders.values()).sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
  );
  const paidOrders = orders.filter(o => o.status === 'PAID');
  const totalRevenueIdr = paidOrders.reduce((acc, o) => acc + Number(o.amountIdr || 0), 0);
  const totalDiamondsCirculating = Array.from(state.wallets.values()).reduce(
    (acc, w) => acc + Number(w.balance || 0),
    0
  );
  const totalSkinsSold = state.diamondTransactions.filter(tx => tx.txType === 'SKIN_PURCHASE').length;

  const transactions = state.diamondTransactions
    .filter(tx => !txType || tx.txType === txType)
    .slice(-safeLimit)
    .reverse()
    .map(tx => {
      const u = db.findUserById(tx.userId);
      return {
        ...tx,
        username: u?.username || tx.userId,
        playerName: u?.name || u?.username || tx.userId
      };
    });

  const wallets = Array.from(state.wallets.values())
    .map(w => {
      const u = db.findUserById(w.userId);
      return {
        ...w,
        username: u?.username || w.userId,
        playerName: u?.name || w.userId,
        coins: db.getUserPoints(w.userId)
      };
    })
    .sort((a, b) => b.balance - a.balance)
    .slice(0, safeLimit);

  return {
    settings: getEconomySettings(),
    summary: {
      totalDiamondsCirculating,
      totalPaidOrders: paidOrders.length,
      totalRevenueIdr,
      totalConversions: state.coinConversions.length,
      totalSkinsSold,
      activePackagesCount: Array.from(state.packages.values()).filter(p => p.isActive).length,
      activeSkinsCount: Array.from(state.skins.values()).filter(s => s.isActive).length
    },
    packages: listDiamondPackages({ includeInactive: true }),
    skins: Array.from(state.skins.values()).sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder)),
    wallets,
    paymentOrders: orders.slice(0, safeLimit).map(o => {
      const u = db.findUserById(o.userId);
      return { ...o, username: u?.username || o.userId };
    }),
    transactions,
    coinConversions: state.coinConversions.slice(-safeLimit).reverse(),
    callbackLogs: state.callbackLogs.slice(-safeLimit).reverse()
  };
}

function getOrderById(orderId) {
  if (!orderId) return null;
  const order = state.paymentOrders.get(orderId);
  return order ? enrichOrderFields(order) : null;
}

function listAllPaymentOrders() {
  return Array.from(state.paymentOrders.values())
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map(enrichOrderFields);
}

function listAllDiamondTransactions() {
  return state.diamondTransactions.slice().reverse();
}

function listCallbackLogs() {
  return state.callbackLogs.slice().reverse();
}

async function adminApproveOrder({ orderId, reason, adminUser }) {
  const order = state.paymentOrders.get(orderId);
  if (!order) throw makeError(404, 'Order top-up tidak ditemukan.');
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) {
    throw makeError(400, 'Alasan approval manual wajib diisi untuk audit.');
  }

  return withOrderLock(orderId, async () => {
    if (order.status === 'PAID') {
      return {
        success: true,
        alreadyCredited: true,
        order: enrichOrderFields(order),
        wallet: formatWalletResponse(order.userId)
      };
    }
    if (order.status !== 'PENDING') {
      throw makeError(400, `Hanya order berstatus PENDING yang dapat disetujui manual (status saat ini: ${order.status}).`);
    }
    const label = `admin_manual:${adminUser?.username || 'admin'}:${cleanReason.slice(0, 80)}`;
    const creditRes = await applyOrderPaidCredit(order, label);
    return {
      success: true,
      ...creditRes,
      order: enrichOrderFields(creditRes.order)
    };
  });
}

async function adminCancelOrder({ orderId, reason, adminUser }) {
  const order = state.paymentOrders.get(orderId);
  if (!order) throw makeError(404, 'Order top-up tidak ditemukan.');

  return withOrderLock(orderId, async () => {
    if (order.status === 'PAID') {
      throw makeError(400, 'Order yang sudah PAID tidak dapat dibatalkan.');
    }
    if (order.status !== 'PENDING') {
      throw makeError(400, `Order sudah berstatus ${order.status}.`);
    }
    const cleanReason = String(reason || 'Manual cancel dari Admin CMS').trim();
    await markOrderNonPaidStatus(order, 'CANCELLED', `Dibatalkan admin (${adminUser?.username || 'admin'}): ${cleanReason}`);
    return {
      success: true,
      order: enrichOrderFields(order)
    };
  });
}

function purgeUserInMemory(userId) {
  if (!userId) return;
  state.wallets.delete(userId);
  state.ownedSkins.delete(userId);
  state.equippedSkins.delete(userId);
  for (const [oid, ord] of state.paymentOrders.entries()) {
    if (ord.userId === userId) state.paymentOrders.delete(oid);
  }
  state.diamondTransactions = state.diamondTransactions.filter(tx => {
    if (tx.userId === userId) {
      if (tx.idempotencyKey) state.idempotencyIndex.delete(tx.idempotencyKey);
      return false;
    }
    return true;
  });
  state.coinConversions = state.coinConversions.filter(cv => cv.userId !== userId);
  persistLocalFallback();
}

module.exports = {
  hydrateFromPostgres,
  resetForTests,
  getDiamondBalanceSync,
  getOwnedSkinIdsSync,
  getEquippedSkinSync,
  getValidatedEquippedSkin,
  getEconomySettings,
  formatWalletResponse,
  listUserTransactions,
  listPaymentOrdersForUser,
  getOrderById,
  listAllPaymentOrders,
  listAllDiamondTransactions,
  listCallbackLogs,
  convertCoinsToDiamonds,
  convertDiamondsToCoins,
  listDiamondPackages,
  createDiamondTopupOrder,
  handleDuitkuDiamondCallback,
  handlePaymentGatewayCallback: handleDuitkuDiamondCallback,
  getAndVerifyOrderStatus,
  cancelPendingOrder,
  adminApproveOrder,
  adminCancelOrder,
  purgeUserInMemory,
  listLudoSkins,
  getUserSkinInventory,
  purchaseLudoSkin,
  equipLudoSkin,
  updateEconomySettings,
  upsertDiamondPackage,
  upsertLudoSkin,
  adminAdjustDiamonds,
  getAdminOverview
};
