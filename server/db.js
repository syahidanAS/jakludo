// Layer database JakLudo berbasis PostgreSQL (pg.Pool) dengan write-through cache
// di memori agar loop permainan realtime (Socket.IO) tetap sinkron dan bebas race condition,
// sekaligus menyimpan seluruh perubahan secara transaksional ke PostgreSQL.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { Pool } = require('pg');
const {
  getPoolConfig,
  ensureDatabaseExists,
  runSchemaMigrations,
  migrateSqliteToPostgres,
  migrateLegacyJsonToPostgres,
  readSqliteDatabase
} = require('./migrate');
const { canAwardPoints } = require('./lib/rewards');

const scrypt = promisify(crypto.scrypt);

const DATA_DIR = process.env.JAKLUDO_DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'jakludo.db');
const LOCAL_STATE_FILE = path.join(DATA_DIR, 'jakludo-state.json');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 hari
const STARTER_POINTS = 200;
// Poin per peringkat, menurut jumlah pemain di room (bot ikut dihitung). Peringkat terakhir selalu 5,
// supaya pemain yang kalah di permainan 2 orang tidak dapat poin hampir sebesar pemenangnya.
// Bonus harian: sekali per hari (WIB) untuk pemain yang menyelesaikan minimal 1 pertandingan tanpa OUT
const DAILY_BONUS_POINTS = 5;
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const todayWib = (now = Date.now()) => new Date(now + WIB_OFFSET_MS).toISOString().slice(0, 10);

const RANK_POINTS = {
  2: [30, 5],
  3: [30, 15, 5],
  4: [30, 20, 15, 5]
};

// Poin untuk peringkat ke-(rank+1) dari playerCount pemain (dipakai permainan biasa maupun grup)
function rankPoints(playerCount, rank) {
  const table = RANK_POINTS[Math.min(Math.max(playerCount, 2), 4)];
  return table[Math.min(Math.max(rank, 0), table.length - 1)];
}

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ==========================================
// STATE WRITE-THROUGH & KONEKSI POSTGRESQL
// ==========================================

// Default price list & items (seed awal & fallback offline/test)
const DEFAULT_DIAMOND_PACKAGES = [
  {
    id: 'diamond_50',
    name: '50 Coins',
    diamonds: 50,
    coins: 50,
    price: 5000,
    formattedPrice: 'Rp 5.000',
    description: 'Paket pemula untuk mencoba item & avatar baru.',
    subtitle: 'Paket pemula',
    badge: null,
    icon: 'coin',
    sortOrder: 1,
    isActive: true
  },
  {
    id: 'diamond_120',
    name: '120 Coins',
    diamonds: 120,
    coins: 120,
    price: 10000,
    formattedPrice: 'Rp 10.000',
    description: 'Paket hemat paling diminati pemain!',
    subtitle: 'Paket hemat',
    badge: 'Populer',
    icon: 'coin',
    sortOrder: 2,
    isActive: true
  },
  {
    id: 'diamond_260',
    name: '260 Coins',
    diamonds: 260,
    coins: 260,
    price: 20000,
    formattedPrice: 'Rp 20.000',
    description: 'Cukup untuk beli dice, emote, dan skin spesial.',
    subtitle: 'Paket reguler',
    badge: null,
    icon: 'coin',
    sortOrder: 3,
    isActive: true
  },
  {
    id: 'diamond_700',
    name: '700 Coins',
    diamonds: 700,
    coins: 700,
    price: 50000,
    formattedPrice: 'Rp 50.000',
    description: 'Dapatkan 600 + Bonus 100 Coins.',
    subtitle: 'Paket premium',
    badge: 'Bonus 100',
    icon: 'coin',
    sortOrder: 4,
    isActive: true
  },
  {
    id: 'diamond_1500',
    name: '1.500 Coins',
    diamonds: 1500,
    coins: 1500,
    price: 100000,
    formattedPrice: 'Rp 100.000',
    description: 'Dapatkan 1.250 + Bonus 250 Coins.',
    subtitle: 'Paket besar',
    badge: 'Bonus 250',
    icon: 'coin',
    sortOrder: 5,
    isActive: true
  },
  {
    id: 'diamond_3250',
    name: '3.250 Coins',
    diamonds: 3250,
    coins: 3250,
    price: 200000,
    formattedPrice: 'Rp 200.000',
    description: 'Paket Sultan! Dapatkan 2.500 + Bonus 750 Coins.',
    subtitle: 'Paket sultan',
    badge: 'Bonus 750',
    icon: 'crown',
    sortOrder: 6,
    isActive: true
  }
];

const DEFAULT_SHOP_ITEMS = [
  {
    id: 'blackholeShield',
    name: 'Blackhole Shield',
    price: 50,
    game: 'ludo',
    icon: '🛡️',
    description: 'Melindungi bidakmu dari sedotan Black Hole. Saat bidakmu mendarat di petak Black Hole, perisai otomatis aktif sehingga bidakmu tidak kembali ke markas.',
    kind: 'passive',
    badge: 'Perisai Pasif Otomatis',
    badgeColor: '#3b82f6',
    highlight: 'Otomatis aktif saat terkena Black Hole',
    target: null,
    sound: 'chime',
    protects: ['blackHole'],
    sortOrder: 1,
    isActive: true
  },
  {
    id: 'universalShield',
    name: 'Universal Shield',
    price: 100,
    game: 'ludo',
    icon: '🔰',
    description: 'Menahan Force Return dari lawan dan sedotan Black Hole. Saat bidakmu jadi target Force Return atau mendarat di Black Hole, muncul pilihan untuk memakai perisai ini atau menyimpannya.',
    kind: 'reactive',
    badge: 'Perisai Pilihan',
    badgeColor: '#7c3aed',
    highlight: 'Menahan Force Return & Black Hole, kamu yang memilih',
    target: null,
    sound: 'chime',
    protects: ['forceReturn', 'blackHole'],
    sortOrder: 2,
    isActive: true
  },
  {
    id: 'forceReturn',
    name: 'Force Return',
    price: 100,
    game: 'ludo',
    icon: '⚡',
    description: 'Pulangkan 1 bidak lawan di lintasan langsung ke markas. Dipakai di giliranmu sebelum melempar dadu, dan hanya jika minimal 1 bidakmu sudah keluar dari markas. Lawan yang punya Universal Shield bisa memilih menahannya.',
    kind: 'active',
    badge: 'Eliminasi Instan',
    badgeColor: '#f59e0b',
    highlight: 'Dipakai di giliranmu sebelum melempar dadu',
    target: 'opponentPawn',
    sound: 'thunder',
    protects: [],
    sortOrder: 3,
    isActive: true
  },
  {
    id: 'quizHint',
    name: 'Hints Jawaban',
    price: 25,
    game: 'quiz',
    icon: '💡',
    description: 'Bantuan pintar saat ragu menjawab soal di Monster Quiz Battle! Menghilangkan 2 pilihan jawaban yang salah (50:50) pada ronde yang sedang berlangsung sehingga peluang benar meningkat tajam. Maksimal 1 Hint per ronde.',
    kind: 'active',
    badge: 'Monster Quiz',
    badgeColor: '#3b82f6',
    highlight: 'Eliminasi 2 opsi jawaban salah (50:50) saat duel Monster Quiz Battle',
    target: null,
    sound: 'chime',
    protects: [],
    sortOrder: 4,
    isActive: true
  }
];

const state = {
  usersById: new Map(),       // id -> { id, username, name, passwordHash, authType, avatar, email, googleId, createdAt }
  usersByUsername: new Map(), // lower(username) -> id
  usersByGoogleId: new Map(), // googleId -> id
  usersByEmail: new Map(),    // lower(email) -> id
  userItems: new Map(),       // userId -> { [itemId]: quantity }
  sessions: new Map(),        // tokenHash -> { tokenHash, userId, createdAt, expiresAt }
  leaderboard: new Map(),     // userId -> { userId, username, name, avatar, wins, matchesPlayed, points, authType }
  rooms: new Map(),           // code -> { code, state, updatedAt }
  topupOrders: new Map(),     // orderId -> { orderId, userId, packageId, diamonds, grossAmount, status, snapToken, paymentType, createdAt, updatedAt }
  shopItems: new Map(),       // id -> shop item record dari database
  diamondPackages: new Map()  // id -> diamond package record dari database
};

let pool = null;
let initialized = false;
let initPromise = null;
let closed = false;
const pendingQueries = new Set();

const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');

function trackQuery(promise) {
  const tracked = promise.catch(err => {
    console.error('[PG ERROR]', err.message);
  }).finally(() => {
    pendingQueries.delete(tracked);
  });
  pendingQueries.add(tracked);
  return tracked;
}

function execPg(text, params = []) {
  if (!pool || closed) return Promise.resolve();
  return trackQuery(pool.query(text, params));
}

function execPgTransaction(fn) {
  if (!pool || closed) return Promise.resolve();
  const run = (async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await fn(client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  })();
  return trackQuery(run);
}

// Persistensi cadangan lokal jika berjalan di mode test lokal tanpa server PostgreSQL aktif
function persistLocalFallback() {
  if (pool || closed) return;
  try {
    const dump = {
      users: Array.from(state.usersById.values()),
      userItems: Object.fromEntries(state.userItems.entries()),
      sessions: Array.from(state.sessions.values()),
      leaderboard: Array.from(state.leaderboard.values()),
      rooms: Array.from(state.rooms.values())
    };
    fs.writeFileSync(LOCAL_STATE_FILE, JSON.stringify(dump));
  } catch (err) {
    console.error('[DB LOCAL]', err.message);
  }
}

function setUserInState(u) {
  const row = {
    id: u.id,
    username: u.username,
    name: u.name || u.username,
    passwordHash: u.passwordHash ?? u.password_hash ?? null,
    authType: u.authType || u.auth_type || 'password',
    avatar: u.avatar || null,
    email: u.email || null,
    googleId: u.googleId || u.google_id || null,
    createdAt: u.createdAt || u.created_at || new Date().toISOString()
  };
  state.usersById.set(row.id, row);
  state.usersByUsername.set(row.username.toLowerCase(), row.id);
  if (row.googleId) {
    state.usersByGoogleId.set(String(row.googleId), row.id);
  }
  if (row.email) {
    state.usersByEmail.set(String(row.email).toLowerCase(), row.id);
  }
}

function setItemInState(userId, itemId, quantity) {
  const qty = Number(quantity || 0);
  if (!state.userItems.has(userId)) state.userItems.set(userId, {});
  const items = state.userItems.get(userId);
  if (qty > 0) items[itemId] = qty;
  else delete items[itemId];
}

// Impor dari JSON lama atau SQLite lokal untuk kebutuhan offline/test
function bootstrapLocalState() {
  for (const pkg of DEFAULT_DIAMOND_PACKAGES) {
    state.diamondPackages.set(pkg.id, { ...pkg });
  }
  for (const it of DEFAULT_SHOP_ITEMS) {
    state.shopItems.set(it.id, { ...it });
  }

  if (fs.existsSync(LOCAL_STATE_FILE)) {
    try {
      const dump = JSON.parse(fs.readFileSync(LOCAL_STATE_FILE, 'utf8'));
      for (const u of dump.users || []) setUserInState(u);
      for (const [uid, items] of Object.entries(dump.userItems || {})) {
        for (const [itemId, qty] of Object.entries(items || {})) setItemInState(uid, itemId, qty);
      }
      for (const s of dump.sessions || []) {
        if (s.expiresAt > Date.now()) state.sessions.set(s.tokenHash, s);
      }
      for (const e of dump.leaderboard || []) state.leaderboard.set(e.userId, e);
      for (const r of dump.rooms || []) state.rooms.set(r.code, r);
    } catch {
      // Abaikan jika gagal dibaca
    }
  }

  // Cek juga file SQLite (jakludo.db) jika ada
  if (fs.existsSync(DB_FILE)) {
    try {
      const sq = readSqliteDatabase(DB_FILE);
      if (sq) {
        for (const u of sq.users) {
          setUserInState(u);
          if (Number(u.shield_count) > 0) setItemInState(u.id, 'blackholeShield', Number(u.shield_count));
          if (Number(u.force_return_count) > 0) setItemInState(u.id, 'forceReturn', Number(u.force_return_count));
        }
        for (const it of sq.user_items) setItemInState(it.user_id, it.item_id, it.quantity);
        for (const s of sq.sessions) {
          if (Number(s.expires_at) > Date.now()) {
            state.sessions.set(s.token_hash, {
              tokenHash: s.token_hash,
              userId: s.user_id,
              createdAt: Number(s.created_at),
              expiresAt: Number(s.expires_at)
            });
          }
        }
        for (const e of sq.leaderboard) {
          state.leaderboard.set(e.user_id, {
            userId: e.user_id,
            username: e.username,
            name: e.name || e.username,
            avatar: e.avatar || null,
            wins: Number(e.wins || 0),
            matchesPlayed: Number(e.matches_played || 0),
            points: Number(e.points || 0),
            authType: e.auth_type || 'password'
          });
        }
        for (const r of sq.rooms) {
          try {
            const parsed = typeof r.state === 'string' ? JSON.parse(r.state) : r.state;
            state.rooms.set(r.code, { code: r.code, state: parsed, updatedAt: Number(r.updated_at) });
          } catch {}
        }
      }
    } catch {}
  }

  // Impor file JSON generasi pertama (users.json, sessions.json, leaderboard.json)
  const files = {
    users: path.join(DATA_DIR, 'users.json'),
    sessions: path.join(DATA_DIR, 'sessions.json'),
    leaderboard: path.join(DATA_DIR, 'leaderboard.json')
  };
  if (!Object.values(files).some(f => fs.existsSync(f))) return;

  const load = (file, fallback) => {
    if (!fs.existsSync(file)) return fallback;
    const content = fs.readFileSync(file, 'utf8').trim();
    if (!content) return fallback;
    try {
      return JSON.parse(content);
    } catch (err) {
      throw new Error(`[DB FATAL] ${file} tidak valid (${err.message}). Perbaiki/pulihkan file ini agar data bisa dipindahkan.`);
    }
  };
  const users = load(files.users, []);
  const sessions = load(files.sessions, {});
  const leaderboard = load(files.leaderboard, []);

  for (const u of users) {
    setUserInState(u);
    for (const [itemId, qty] of Object.entries(u.inventory || {})) {
      if (qty > 0) setItemInState(u.id, itemId, qty);
    }
  }
  for (const [token, s] of Object.entries(sessions)) {
    if (s && state.usersById.has(s.userId) && s.expiresAt > Date.now()) {
      const th = hashToken(token);
      state.sessions.set(th, { tokenHash: th, userId: s.userId, createdAt: s.createdAt || Date.now(), expiresAt: s.expiresAt });
    }
  }
  for (const e of leaderboard) {
    if (!e.userId || !e.username) continue;
    state.leaderboard.set(e.userId, {
      userId: e.userId,
      username: e.username,
      name: e.name || e.username,
      avatar: e.avatar || null,
      wins: e.wins || 0,
      matchesPlayed: e.matchesPlayed || 0,
      points: e.points || 0,
      authType: e.authType || 'player'
    });
  }

  const stamp = Date.now();
  for (const file of Object.values(files)) {
    if (fs.existsSync(file)) fs.renameSync(file, `${file}.migrated-${stamp}`);
  }
  persistLocalFallback();
  console.log(`[DB] Data JSON lama dimigrasikan: ${users.length} user, ${leaderboard.length} baris leaderboard.`);
}

async function hydrateFromPostgres(activePool) {
  state.usersById.clear();
  state.usersByUsername.clear();
  state.userItems.clear();
  state.sessions.clear();
  state.leaderboard.clear();
  state.rooms.clear();
  state.topupOrders.clear();

  const [usersRes, itemsRes, sessionsRes, lbRes, roomsRes, topupRes] = await Promise.all([
    activePool.query('SELECT * FROM users'),
    activePool.query('SELECT user_id, item_id, quantity FROM user_items WHERE quantity > 0'),
    activePool.query('SELECT token_hash, user_id, created_at, expires_at FROM sessions WHERE expires_at > $1', [Date.now()]),
    activePool.query('SELECT * FROM leaderboard'),
    activePool.query('SELECT code, state, updated_at FROM rooms'),
    activePool.query('SELECT * FROM topup_orders ORDER BY created_at DESC LIMIT 500').catch(() => ({ rows: [] }))
  ]);

  for (const r of usersRes.rows) setUserInState(r);
  for (const r of itemsRes.rows) setItemInState(r.user_id, r.item_id, Number(r.quantity));
  for (const r of sessionsRes.rows) {
    state.sessions.set(r.token_hash, {
      tokenHash: r.token_hash,
      userId: r.user_id,
      createdAt: Number(r.created_at),
      expiresAt: Number(r.expires_at)
    });
  }
  for (const r of lbRes.rows) {
    state.leaderboard.set(r.user_id, {
      userId: r.user_id,
      username: r.username,
      name: r.name,
      avatar: r.avatar,
      wins: Number(r.wins),
      matchesPlayed: Number(r.matches_played),
      points: Number(r.points),
      authType: r.auth_type,
      lastDailyBonus: r.last_daily_bonus || null
    });
  }
  for (const r of roomsRes.rows) {
    const parsed = typeof r.state === 'string' ? JSON.parse(r.state) : r.state;
    state.rooms.set(r.code, { code: r.code, state: parsed, updatedAt: Number(r.updated_at) });
  }
  for (const r of topupRes.rows) {
    let details = r.payment_details;
    if (typeof details === 'string') {
      try { details = JSON.parse(details); } catch {}
    }
    state.topupOrders.set(r.order_id, {
      orderId: r.order_id,
      userId: r.user_id,
      packageId: r.package_id,
      diamonds: Number(r.diamonds),
      grossAmount: Number(r.gross_amount),
      status: r.status,
      snapToken: r.snap_token,
      paymentType: r.payment_type,
      paymentDetails: details || null,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    });
  }

  // Muat price list diamond & katalog item toko dari PostgreSQL
  try {
    const [pkgRes, shopRes] = await Promise.all([
      activePool.query('SELECT * FROM diamond_packages WHERE is_active = TRUE ORDER BY sort_order ASC, price ASC').catch(() => ({ rows: [] })),
      activePool.query('SELECT * FROM shop_items WHERE is_active = TRUE ORDER BY sort_order ASC, name ASC').catch(() => ({ rows: [] }))
    ]);
    if (pkgRes.rows && pkgRes.rows.length > 0) {
      state.diamondPackages.clear();
      for (const r of pkgRes.rows) {
        state.diamondPackages.set(r.id, {
          id: r.id,
          name: r.name,
          diamonds: Number(r.diamonds),
          coins: Number(r.diamonds),
          price: Number(r.price),
          formattedPrice: r.formatted_price,
          description: r.description,
          subtitle: r.subtitle,
          badge: r.badge,
          icon: r.icon,
          sortOrder: Number(r.sort_order),
          isActive: Boolean(r.is_active)
        });
      }
    }
    if (shopRes.rows && shopRes.rows.length > 0) {
      state.shopItems.clear();
      for (const r of shopRes.rows) {
        let protects = r.protects;
        if (typeof protects === 'string') {
          try { protects = JSON.parse(protects); } catch { protects = []; }
        }
        state.shopItems.set(r.id, {
          id: r.id,
          name: r.name,
          price: Number(r.price),
          game: r.game,
          icon: r.icon,
          description: r.description,
          kind: r.kind,
          badge: r.badge,
          badgeColor: r.badge_color,
          highlight: r.highlight,
          target: r.target,
          sound: r.sound,
          protects: Array.isArray(protects) ? protects : [],
          sortOrder: Number(r.sort_order),
          isActive: Boolean(r.is_active)
        });
      }
    }
  } catch (err) {
    console.warn('[PG HYDRATE SHOP/DIAMONDS]', err.message);
  }
}

// Inisialisasi koneksi PostgreSQL, jalankan migrasi skema & migrasi data SQLite otomatis, lalu muat state
async function init(options = {}) {
  if (initialized && !options.force) return;
  if (initPromise && !options.force) return initPromise;

  initPromise = (async () => {
    closed = false;
    const customPool = options.pool || null;
    const poolConfig = customPool ? null : getPoolConfig(options.env || process.env);

    if (customPool || poolConfig) {
      if (!customPool && poolConfig) {
        await ensureDatabaseExists(poolConfig);
      }
      pool = customPool || new Pool(poolConfig);
      pool.on('error', err => console.error('[PG POOL ERROR]', err.message));

      await runSchemaMigrations(pool);
      await migrateLegacyJsonToPostgres(pool, DATA_DIR);
      if (fs.existsSync(DB_FILE)) {
        await migrateSqliteToPostgres(pool, { sqliteFile: DB_FILE, renameAfter: true });
      }
      await hydrateFromPostgres(pool);
      await require('./social/store').hydrateFromPostgres();
      await require('./quiz/store').hydrateFromPostgres();
      await require('./chess/store').hydrateFromPostgres();
      await require('./snakes/store').hydrateFromPostgres();
      console.log(`[PG] Terhubung ke PostgreSQL (${state.usersById.size} user, ${state.leaderboard.size} leaderboard, ${state.rooms.size} room aktif).`);
    } else {
      console.warn('[DB] DATABASE_URL belum diset; berjalan dengan penyimpanan lokal di', DATA_DIR);
    }

    initialized = true;
  })();

  return initPromise;
}

// Jalankan bootstrap lokal sinkron saat modul di-require agar unit test langsung siap
bootstrapLocalState();

function getStatus() {
  return {
    engine: pool ? 'postgresql' : 'local-fallback',
    initialized,
    pendingWrites: pendingQueries.size
  };
}

// ==========================================
// HELPER USER & ITEM
// ==========================================

function getUserItems(userId) {
  return { ...(state.userItems.get(userId) || {}) };
}

function buildUserObject(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    passwordHash: row.passwordHash,
    authType: row.authType,
    avatar: row.avatar,
    email: row.email || undefined,
    googleId: row.googleId || undefined,
    createdAt: row.createdAt,
    inventory: getUserItems(row.id)
  };
}

function findUserById(id) {
  if (typeof id !== 'string') return null;
  const row = state.usersById.get(id);
  if (row) return buildUserObject(row);
  if (id.startsWith('bot_')) {
    const botProfileMap = {
      bot_quiz_rex: { name: 'Rian Pratama', username: 'rian_pratama', avatar: '1' },
      bot_quiz_luna: { name: 'Nadia Safitri', username: 'nadiasafitri', avatar: '2' },
      bot_quiz_blaze: { name: 'Dimas Setiawan', username: 'dimas_stw', avatar: '3' },
      bot_quiz_terra: { name: 'Citra Kirana', username: 'citrakirana', avatar: '4' },
      bot_quiz_flora: { name: 'Reza Aditya', username: 'reza_aditya', avatar: '5' },
      bot_quiz_frosty: { name: 'Indah Permata', username: 'indah_prm', avatar: '6' },
      bot_quiz_budi: { name: 'Budi Santoso', username: 'budi_santoso', avatar: '1' },
      bot_quiz_alya: { name: 'Alya Putri', username: 'alya_putri', avatar: '2' },
      bot_quiz_fajar: { name: 'Fajar Nugraha', username: 'fajar_nugraha', avatar: '3' },
      bot_quiz_sitir: { name: 'Siti Rahma', username: 'siti_rahma', avatar: '4' },
      bot_quiz_kevin: { name: 'Kevin Wijaya', username: 'kevin_wijaya', avatar: '5' },
      bot_quiz_dewi: { name: 'Dewi Lestari', username: 'dewi_lestari', avatar: '6' }
    };
    const mapped = botProfileMap[id];
    const rawName = id.replace(/^bot_(quiz_)?/, '');
    const cleanName = rawName.charAt(0).toUpperCase() + rawName.slice(1);
    return {
      id,
      username: mapped?.username || id,
      name: mapped?.name || cleanName || 'Pemain',
      passwordHash: '',
      authType: 'bot',
      avatar: mapped?.avatar || '1',
      createdAt: Date.now(),
      inventory: {}
    };
  }
  return null;
}

function findUserByUsername(username) {
  if (!username) return null;
  const id = state.usersByUsername.get(String(username).toLowerCase());
  return id ? findUserById(id) : null;
}

function findUserByGoogleId(googleId) {
  if (!googleId) return null;
  const id = state.usersByGoogleId.get(String(googleId));
  return id ? findUserById(id) : null;
}

function findUserByEmail(email) {
  if (!email) return null;
  const id = state.usersByEmail.get(String(email).toLowerCase());
  return id ? findUserById(id) : null;
}

// ==========================================
// STANDARD KEAMANAN PASSWORD & VALIDASI
// ==========================================

function validateUsername(username) {
  if (!username || typeof username !== 'string') {
    return { valid: false, message: 'Username wajib diisi.' };
  }
  const clean = username.trim();
  if (clean.length < 3 || clean.length > 20) {
    return { valid: false, message: 'Username harus memiliki panjang 3-20 karakter.' };
  }
  if (!/^[a-zA-Z0-9_]+$/.test(clean)) {
    return { valid: false, message: 'Username hanya boleh berisi huruf, angka, dan underscore (_).' };
  }
  return { valid: true, cleanUsername: clean };
}

function validatePassword(password) {
  if (!password || typeof password !== 'string') {
    return { valid: false, message: 'Password wajib diisi.' };
  }
  if (password.length < 8) {
    return { valid: false, message: 'Password minimal 8 karakter.' };
  }
  if (password.length > 128) {
    return { valid: false, message: 'Password maksimal 128 karakter.' };
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, message: 'Password harus mengandung minimal 1 huruf kecil.' };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, message: 'Password harus mengandung minimal 1 huruf besar.' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, message: 'Password harus mengandung minimal 1 angka.' };
  }
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/.test(password)) {
    return { valid: false, message: 'Password harus mengandung minimal 1 karakter spesial/simbol (@#$% dll).' };
  }
  return { valid: true };
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${derivedKey.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  try {
    const [algorithm, salt, originalKeyHex] = String(storedHash).split(':');
    if (algorithm !== 'scrypt' || !salt || !originalKeyHex) return false;
    const derivedKey = await scrypt(password, salt, 64);
    const originalKey = Buffer.from(originalKeyHex, 'hex');
    if (originalKey.length !== derivedKey.length) return false;
    return crypto.timingSafeEqual(derivedKey, originalKey);
  } catch (err) {
    console.error('Password verify error:', err);
    return false;
  }
}

// ==========================================
// MANAJEMEN USER
// ==========================================

async function registerUser({ username, password, name }) {
  const userValid = validateUsername(username);
  if (!userValid.valid) return { error: userValid.message };

  const passValid = validatePassword(password);
  if (!passValid.valid) return { error: passValid.message };

  if (findUserByUsername(userValid.cleanUsername)) {
    return { error: 'Username sudah digunakan, silakan pilih username lain.' };
  }

  const passwordHash = await hashPassword(password);
  // Cek ulang setelah proses scrypt async selesai untuk mencegah pendaftaran ganda bersamaan
  if (findUserByUsername(userValid.cleanUsername)) {
    return { error: 'Username sudah digunakan, silakan pilih username lain.' };
  }

  const displayName = (typeof name === 'string' ? name.trim().slice(0, 18) : '') || userValid.cleanUsername;
  const id = 'user_' + crypto.randomUUID();
  const createdAt = new Date().toISOString();

  if (pool && !closed) {
    try {
      await execPgTransaction(async client => {
        await client.query(
          `INSERT INTO users (id, username, name, password_hash, auth_type, avatar, created_at)
           VALUES ($1, $2, $3, $4, 'password', '🎯', $5)`,
          [id, userValid.cleanUsername, displayName, passwordHash, createdAt]
        );
        await client.query(
          `INSERT INTO leaderboard (user_id, username, name, avatar, wins, matches_played, points, auth_type)
           VALUES ($1, $2, $3, '🎯', 0, 0, $4, 'password')
           ON CONFLICT (user_id) DO NOTHING`,
          [id, userValid.cleanUsername, displayName, STARTER_POINTS]
        );
      });
    } catch (err) {
      if (String(err.code) === '23505' || String(err.message).includes('unique')) {
        return { error: 'Username sudah digunakan, silakan pilih username lain.' };
      }
      throw err;
    }
  }

  setUserInState({
    id,
    username: userValid.cleanUsername,
    name: displayName,
    passwordHash,
    authType: 'password',
    avatar: '🎯',
    createdAt
  });
  state.leaderboard.set(id, {
    userId: id,
    username: userValid.cleanUsername,
    name: displayName,
    avatar: '🎯',
    wins: 0,
    matchesPlayed: 0,
    points: STARTER_POINTS,
    authType: 'password'
  });
  persistLocalFallback();

  return { user: sanitizeUser(findUserById(id)), token: createSession(id) };
}

async function loginUser({ username, password }) {
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return { error: 'Username dan password wajib diisi.' };
  }

  const user = findUserByUsername(username.trim());
  if (!user || !user.passwordHash) {
    return { error: 'Username atau password salah.' };
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    return { error: 'Username atau password salah.' };
  }
  return { user: sanitizeUser(user), token: createSession(user.id) };
}

async function loginOrRegisterGoogleUser({ googleId, email, name, avatar }) {
  if (!googleId && !email) {
    return { error: 'Identitas akun Google tidak lengkap.' };
  }

  // 1. Cek apakah user sudah pernah terdaftar dengan Google ID ini
  if (googleId) {
    const existingByGoogleId = findUserByGoogleId(googleId);
    if (existingByGoogleId) {
      return { user: sanitizeUser(existingByGoogleId), token: createSession(existingByGoogleId.id) };
    }
  }

  // 2. Cek apakah ada akun yang terdaftar dengan email yang sama (link akun)
  if (email) {
    const existingByEmail = findUserByEmail(email);
    if (existingByEmail) {
      if (googleId && !existingByEmail.googleId) {
        existingByEmail.googleId = String(googleId);
        state.usersByGoogleId.set(String(googleId), existingByEmail.id);
        if (pool && !closed) {
          await execPg(
            'UPDATE users SET google_id = $1 WHERE id = $2',
            [String(googleId), existingByEmail.id]
          );
        }
        persistLocalFallback();
      }
      return { user: sanitizeUser(existingByEmail), token: createSession(existingByEmail.id) };
    }
  }

  // 3. User baru: buat username yang unik
  const rawBase = (email ? email.split('@')[0] : '') || (name || 'player');
  let cleanUsername = rawBase.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 15);
  if (cleanUsername.length < 3) cleanUsername = 'player_' + crypto.randomInt(100, 999);

  let finalUsername = cleanUsername;
  let counter = 1;
  while (findUserByUsername(finalUsername)) {
    const suffix = String(counter);
    finalUsername = cleanUsername.slice(0, 20 - suffix.length) + suffix;
    counter++;
  }

  const displayName = (typeof name === 'string' ? name.trim().slice(0, 18) : '') || finalUsername;
  const id = 'user_' + crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const userAvatar = (typeof avatar === 'string' && avatar.trim()) ? avatar.trim() : '🎯';
  const userEmail = (typeof email === 'string' && email.trim()) ? email.trim().toLowerCase() : null;
  const userGoogleId = googleId ? String(googleId) : null;

  if (pool && !closed) {
    try {
      await execPgTransaction(async client => {
        await client.query(
          `INSERT INTO users (id, username, name, password_hash, auth_type, avatar, email, google_id, created_at)
           VALUES ($1, $2, $3, NULL, 'google', $4, $5, $6, $7)`,
          [id, finalUsername, displayName, userAvatar, userEmail, userGoogleId, createdAt]
        );
        await client.query(
          `INSERT INTO leaderboard (user_id, username, name, avatar, wins, matches_played, points, auth_type)
           VALUES ($1, $2, $3, $4, 0, 0, $5, 'google')
           ON CONFLICT (user_id) DO NOTHING`,
          [id, finalUsername, displayName, userAvatar, STARTER_POINTS]
        );
      });
    } catch (err) {
      if (String(err.code) === '23505' || String(err.message).includes('unique')) {
        if (userGoogleId && findUserByGoogleId(userGoogleId)) {
          const u = findUserByGoogleId(userGoogleId);
          return { user: sanitizeUser(u), token: createSession(u.id) };
        }
        if (userEmail && findUserByEmail(userEmail)) {
          const u = findUserByEmail(userEmail);
          return { user: sanitizeUser(u), token: createSession(u.id) };
        }
      }
      throw err;
    }
  }

  setUserInState({
    id,
    username: finalUsername,
    name: displayName,
    passwordHash: null,
    authType: 'google',
    avatar: userAvatar,
    email: userEmail,
    googleId: userGoogleId,
    createdAt
  });

  state.leaderboard.set(id, {
    userId: id,
    username: finalUsername,
    name: displayName,
    avatar: userAvatar,
    wins: 0,
    matchesPlayed: 0,
    points: STARTER_POINTS,
    authType: 'google'
  });

  persistLocalFallback();

  return {
    user: sanitizeUser(findUserById(id)),
    token: createSession(id),
    isNewUser: true
  };
}

// ==========================================
// PROFIL USER
// ==========================================

function sanitizeUser(u) {
  if (!u) return null;
  const entry = state.leaderboard.get(u.id);
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    avatar: u.avatar,
    email: u.email,
    authType: u.authType,
    points: entry ? entry.points : 0,
    inventory: { ...u.inventory }
  };
}

function updateUserAvatar(userId, avatarUrl) {
  const row = state.usersById.get(userId);
  if (!row) return null;
  const cleanAvatar = String(avatarUrl || '🎯').trim();
  row.avatar = cleanAvatar;
  const lb = state.leaderboard.get(userId);
  if (lb) lb.avatar = cleanAvatar;
  persistLocalFallback();

  execPgTransaction(async client => {
    await client.query('UPDATE users SET avatar = $1 WHERE id = $2', [cleanAvatar, userId]);
    await client.query('UPDATE leaderboard SET avatar = $1 WHERE user_id = $2', [cleanAvatar, userId]);
  });

  return sanitizeUser(findUserById(userId));
}

function updateUserEmail(userId, email) {
  const row = state.usersById.get(userId);
  if (!row) return null;
  const cleanEmail = email ? String(email).trim().toLowerCase() : null;
  row.email = cleanEmail;
  if (cleanEmail) {
    state.usersByEmail.set(cleanEmail, userId);
  }
  persistLocalFallback();

  execPg('UPDATE users SET email = $1 WHERE id = $2', [cleanEmail, userId]);
  return sanitizeUser(findUserById(userId));
}

async function updateUserProfile(userId, { name, username, email, currentPassword, newPassword } = {}) {
  const row = state.usersById.get(userId);
  if (!row) return { error: 'Pemain tidak ditemukan.' };

  let nextName = row.name;
  if (name !== undefined) {
    if (typeof name !== 'string') return { error: 'Format nama tidak valid.' };
    const cleanName = name.trim().slice(0, 30);
    if (!cleanName) return { error: 'Nama tampilan tidak boleh kosong.' };
    nextName = cleanName;
  }

  let nextUsername = row.username;
  if (username !== undefined) {
    const userValid = validateUsername(username);
    if (!userValid.valid) return { error: userValid.message };
    const cleanUsername = userValid.cleanUsername;
    if (cleanUsername.toLowerCase() !== row.username.toLowerCase()) {
      const existing = findUserByUsername(cleanUsername);
      if (existing && existing.id !== userId) {
        return { error: 'Username sudah digunakan oleh akun lain.' };
      }
      nextUsername = cleanUsername;
    }
  }

  let nextEmail = row.email || null;
  if (email !== undefined) {
    if (email === null || email === '') {
      nextEmail = null;
    } else {
      if (typeof email !== 'string') return { error: 'Format email tidak valid.' };
      const cleanEmail = email.trim().toLowerCase();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(cleanEmail)) {
        return { error: 'Format email tidak valid.' };
      }
      const existing = findUserByEmail(cleanEmail);
      if (existing && existing.id !== userId) {
        return { error: 'Email sudah digunakan oleh akun lain.' };
      }
      nextEmail = cleanEmail;
    }
  }

  let nextPasswordHash = row.passwordHash;
  if (newPassword) {
    if (row.passwordHash) {
      if (!currentPassword) {
        return { error: 'Password saat ini wajib diisi untuk mengubah password.' };
      }
      const match = await verifyPassword(currentPassword, row.passwordHash);
      if (!match) {
        return { error: 'Password saat ini tidak sesuai.' };
      }
    }
    const passValid = validatePassword(newPassword);
    if (!passValid.valid) return { error: passValid.message };
    nextPasswordHash = await hashPassword(newPassword);
  }

  // Update PostgreSQL jika aktif
  if (pool && !closed) {
    try {
      await execPgTransaction(async client => {
        await client.query(
          `UPDATE users
           SET name = $1, username = $2, email = $3, password_hash = $4
           WHERE id = $5`,
          [nextName, nextUsername, nextEmail, nextPasswordHash, userId]
        );
        await client.query(
          `UPDATE leaderboard
           SET name = $1, username = $2
           WHERE user_id = $3`,
          [nextName, nextUsername, userId]
        );
      });
    } catch (err) {
      if (String(err.code) === '23505' || String(err.message).includes('unique')) {
        return { error: 'Username atau email sudah digunakan oleh akun lain.' };
      }
      throw err;
    }
  }

  // Update in-memory state
  const prevUsername = row.username;
  const prevEmail = row.email;

  if (prevUsername.toLowerCase() !== nextUsername.toLowerCase()) {
    state.usersByUsername.delete(prevUsername.toLowerCase());
    state.usersByUsername.set(nextUsername.toLowerCase(), userId);
  }

  if (prevEmail && (!nextEmail || prevEmail.toLowerCase() !== nextEmail.toLowerCase())) {
    state.usersByEmail.delete(prevEmail.toLowerCase());
  }
  if (nextEmail) {
    state.usersByEmail.set(nextEmail.toLowerCase(), userId);
  }

  row.name = nextName;
  row.username = nextUsername;
  row.email = nextEmail;
  row.passwordHash = nextPasswordHash;

  const lb = state.leaderboard.get(userId);
  if (lb) {
    lb.name = nextName;
    lb.username = nextUsername;
  }

  persistLocalFallback();

  return { success: true, user: sanitizeUser(findUserById(userId)) };
}

// ==========================================
// SESSION MANAGEMENT (TOKEN)
// ==========================================

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  const tokenHash = hashToken(token);

  state.sessions.set(tokenHash, { tokenHash, userId, createdAt: now, expiresAt });
  execPg(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (token_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
    [tokenHash, userId, now, expiresAt]
  );
  persistLocalFallback();
  return token;
}

function getUserByToken(token) {
  if (!token || typeof token !== 'string') return null;
  const hash = hashToken(token);
  const session = state.sessions.get(hash);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    state.sessions.delete(hash);
    execPg('DELETE FROM sessions WHERE token_hash = $1', [hash]);
    persistLocalFallback();
    return null;
  }
  return findUserById(session.userId);
}

function deleteSession(token) {
  if (!token || typeof token !== 'string') return false;
  const hash = hashToken(token);
  const existed = state.sessions.delete(hash);
  if (existed) {
    execPg('DELETE FROM sessions WHERE token_hash = $1', [hash]);
    persistLocalFallback();
  }
  return existed;
}

function pruneExpiredSessions() {
  const now = Date.now();
  let removed = 0;
  for (const [hash, s] of state.sessions.entries()) {
    if (s.expiresAt < now) {
      state.sessions.delete(hash);
      removed++;
    }
  }
  if (removed > 0) persistLocalFallback();
  execPg('DELETE FROM sessions WHERE expires_at < $1', [now]);
  return removed;
}

pruneExpiredSessions();
setInterval(pruneExpiredSessions, 60 * 60 * 1000).unref();

// ==========================================
// LEADERBOARD & LUDO KING
// ==========================================

function ensureLeaderboardEntry(user) {
  if (!state.leaderboard.has(user.id)) {
    state.leaderboard.set(user.id, {
      userId: user.id,
      username: user.username,
      name: user.name,
      avatar: user.avatar || '🎲',
      wins: 0,
      matchesPlayed: 0,
      points: STARTER_POINTS,
      authType: user.authType
    });
  }
  return state.leaderboard.get(user.id);
}

function ensureGlobalLeaderboardRow(client, user) {
  return client.query(
    `INSERT INTO leaderboard (user_id, username, name, avatar, wins, matches_played, points, auth_type)
     VALUES ($1, $2, $3, $4, 0, 0, $5, $6)
     ON CONFLICT (user_id) DO NOTHING`,
    [user.id, user.username, user.name, user.avatar || '🎲', STARTER_POINTS, user.authType]
  );
}

// Catat hasil pertandingan. Hanya akun terdaftar yang mendapat poin, dan hanya
// jika lawannya mencakup minimal satu manusia lain (menang lawan bot tidak dihitung).
// ranking: id pemain dari peringkat 1 ke bawah (lihat rankPlayers). Tanpa ranking, pemenang dianggap
// peringkat 1 dan sisanya mengikuti urutan players.
// Return { [playerId]: { points, dailyBonus } } untuk ditampilkan di layar hasil.
function recordMatchResult({ winnerPlayerId, players, ranking, now = Date.now() }) {
  const awards = {};
  // Aturan bersama semua game: minimal 2 pemain asli (menang hanya melawan bot tidak dapat poin),
  // lihat server/lib/rewards.js
  if (!canAwardPoints(players)) return awards;
  const humans = players.filter(p => !p.isBot);
  const today = todayWib(now);

  const order = ranking || [winnerPlayerId, ...players.map(p => p.id).filter(id => id !== winnerPlayerId)];
  const updates = [];
  for (const p of humans) {
    const user = p.userId ? findUserById(p.userId) : null;
    if (!user) continue;
    const entry = ensureLeaderboardEntry(user);
    const won = p.id === winnerPlayerId;
    const deltaWins = won ? 1 : 0;
    const points = rankPoints(players.length, order.indexOf(p.id));
    // Pemain yang OUT/menyerah tidak dihitung "main" untuk bonus harian
    const dailyBonus = !p.isOut && entry.lastDailyBonus !== today ? DAILY_BONUS_POINTS : 0;
    if (dailyBonus) entry.lastDailyBonus = today;
    const deltaPoints = points + dailyBonus;
    entry.matchesPlayed += 1;
    entry.wins += deltaWins;
    entry.points += deltaPoints;
    awards[p.id] = { points, dailyBonus };
    updates.push({ user, deltaWins, deltaPoints, bonusDate: dailyBonus ? today : null });
  }

  if (updates.length > 0) {
    persistLocalFallback();
    execPgTransaction(async client => {
      for (const { user, deltaWins, deltaPoints, bonusDate } of updates) {
        await ensureGlobalLeaderboardRow(client, user);
        await client.query(
          `UPDATE leaderboard
           SET matches_played = matches_played + 1,
               wins = wins + $1,
               points = points + $2,
               last_daily_bonus = COALESCE($4, last_daily_bonus)
           WHERE user_id = $3`,
          [deltaWins, deltaPoints, user.id, bonusDate]
        );
      }
    });
  }
  return awards;
}

function formatLeaderboardRows(rows) {
  return rows
    .slice()
    .sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.points !== a.points) return b.points - a.points;
      const wrA = a.matchesPlayed > 0 ? a.wins / a.matchesPlayed : 0;
      const wrB = b.matchesPlayed > 0 ? b.wins / b.matchesPlayed : 0;
      return wrB - wrA;
    })
    .map((player, index) => {
      const rank = index + 1;
      const winRate = player.matchesPlayed > 0 ? Math.round((player.wins / player.matchesPlayed) * 100) : 0;
      return { ...player, rank, winRate, isLudoKing: rank === 1 && player.wins > 0 };
    });
}

function getRankedEntries() {
  const excluded = new Set(['bot', 'player', 'seed']);
  return formatLeaderboardRows(
    Array.from(state.leaderboard.values()).filter(e => !excluded.has(e.authType))
  );
}

function getLeaderboard() {
  return getRankedEntries();
}

async function queryGlobalLeaderboard() {
  if (!pool || closed) return getLeaderboard();
  await flush();
  const { rows } = await pool.query(
    `SELECT user_id, username, name, avatar, wins, matches_played, points, auth_type
     FROM leaderboard
     WHERE auth_type NOT IN ('bot', 'player', 'seed')`
  );
  return formatLeaderboardRows(
    rows.map(r => ({
      userId: r.user_id,
      username: r.username,
      name: r.name,
      avatar: r.avatar,
      wins: Number(r.wins),
      matchesPlayed: Number(r.matches_played),
      points: Number(r.points),
      authType: r.auth_type
    }))
  );
}

function checkIsLudoKing(userId) {
  if (!userId) return false;
  const king = getRankedEntries()[0];
  return !!(king && king.wins > 0 && king.userId === userId);
}

// ==========================================
// TOKO & INVENTARIS ITEM (DATABASE-DRIVEN)
// ==========================================

async function queryShopItems() {
  if (pool && !closed) {
    try {
      const res = await pool.query('SELECT * FROM shop_items WHERE is_active = TRUE ORDER BY sort_order ASC, name ASC');
      if (res.rows && res.rows.length > 0) {
        return res.rows.map(r => {
          let protects = r.protects;
          if (typeof protects === 'string') {
            try { protects = JSON.parse(protects); } catch { protects = []; }
          }
          return {
            id: r.id,
            name: r.name,
            price: Number(r.price),
            game: r.game,
            icon: r.icon,
            description: r.description,
            kind: r.kind,
            badge: r.badge,
            badgeColor: r.badge_color,
            highlight: r.highlight,
            target: r.target,
            sound: r.sound,
            protects: Array.isArray(protects) ? protects : [],
            sortOrder: Number(r.sort_order),
            isActive: Boolean(r.is_active)
          };
        });
      }
    } catch (err) {
      console.warn('[PG QUERY SHOP ITEMS]', err.message);
    }
  }
  return Array.from(state.shopItems.values()).filter(i => i.isActive);
}

async function getShopItemById(id) {
  if (!id) return null;
  if (pool && !closed) {
    try {
      const res = await pool.query('SELECT * FROM shop_items WHERE id = $1 AND is_active = TRUE', [id]);
      if (res.rows && res.rows.length > 0) {
        const r = res.rows[0];
        let protects = r.protects;
        if (typeof protects === 'string') {
          try { protects = JSON.parse(protects); } catch { protects = []; }
        }
        return {
          id: r.id,
          name: r.name,
          price: Number(r.price),
          game: r.game,
          icon: r.icon,
          description: r.description,
          kind: r.kind,
          badge: r.badge,
          badgeColor: r.badge_color,
          highlight: r.highlight,
          target: r.target,
          sound: r.sound,
          protects: Array.isArray(protects) ? protects : [],
          sortOrder: Number(r.sort_order),
          isActive: Boolean(r.is_active)
        };
      }
    } catch {}
  }
  const item = state.shopItems.get(id);
  return item && item.isActive ? item : null;
}

// Beli item toko: harga item diverifikasi langsung dari database untuk mencegah manipulasi
async function purchaseItem({ userId, itemId }) {
  const user = findUserById(userId);
  if (!user) return { error: 'Pengguna tidak ditemukan.' };

  const item = await getShopItemById(itemId);
  if (!item || !item.isActive) {
    return { error: 'Item toko tidak valid atau sudah tidak dijual.' };
  }

  const price = Number(item.price);
  const entry = ensureLeaderboardEntry(user);
  if (entry.points < price) {
    return { error: `Poin tidak mencukupi. Diperlukan ${price} poin, kamu memiliki ${entry.points} poin.` };
  }

  entry.points -= price;
  const currentQty = getUserItems(user.id)[itemId] || 0;
  setItemInState(user.id, itemId, currentQty + 1);
  persistLocalFallback();

  if (pool && !closed) {
    await execPgTransaction(async client => {
      await ensureGlobalLeaderboardRow(client, user);
      const updateRes = await client.query(
        'UPDATE leaderboard SET points = points - $1 WHERE user_id = $2 AND points >= $1',
        [price, user.id]
      );
      if (updateRes.rowCount === 0) {
        throw new Error('Poin tidak mencukupi saat proses transaksi database.');
      }
      await client.query(
        `INSERT INTO user_items (user_id, item_id, quantity) VALUES ($1, $2, 1)
         ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = user_items.quantity + 1`,
        [user.id, itemId]
      );
    });
  }

  return { success: true, item, user: sanitizeUser(findUserById(user.id)) };
}

function consumeUserItem({ userId, itemId }) {
  if (!userId || typeof itemId !== 'string') return false;
  const currentQty = getUserItems(userId)[itemId] || 0;
  if (currentQty <= 0) return false;

  setItemInState(userId, itemId, currentQty - 1);
  persistLocalFallback();
  execPg(
    'UPDATE user_items SET quantity = quantity - 1 WHERE user_id = $1 AND item_id = $2 AND quantity > 0',
    [userId, itemId]
  );
  return true;
}

// Tambah poin PlayGo ke saldo pemain (mis. hadiah +10 poin menang Monster Quiz Battle)
function awardUserPoints(userId, deltaPoints = 0) {
  const amount = Math.floor(Number(deltaPoints) || 0);
  if (!userId || amount <= 0) return null;
  const user = findUserById(userId);
  if (!user) return null;

  const entry = ensureLeaderboardEntry(user);
  entry.points += amount;
  persistLocalFallback();

  execPgTransaction(async client => {
    await ensureGlobalLeaderboardRow(client, user);
    await client.query(
      'UPDATE leaderboard SET points = points + $1 WHERE user_id = $2',
      [amount, user.id]
    );
  });

  return {
    userId: user.id,
    pointsAwarded: amount,
    totalPoints: entry.points,
    user: sanitizeUser(findUserById(user.id))
  };
}

// ==========================================
// TOPUP DIAMONDS / DUITKU ORDERS & PRICE LIST
// ==========================================

async function queryDiamondPackages() {
  if (pool && !closed) {
    try {
      const res = await pool.query('SELECT * FROM diamond_packages WHERE is_active = TRUE ORDER BY sort_order ASC, price ASC');
      if (res.rows && res.rows.length > 0) {
        return res.rows.map(r => ({
          id: r.id,
          name: r.name,
          diamonds: Number(r.diamonds),
          coins: Number(r.diamonds),
          price: Number(r.price),
          formattedPrice: r.formatted_price,
          description: r.description,
          subtitle: r.subtitle,
          badge: r.badge,
          icon: r.icon,
          sortOrder: Number(r.sort_order),
          isActive: Boolean(r.is_active)
        }));
      }
    } catch (err) {
      console.warn('[PG QUERY PACKAGES]', err.message);
    }
  }
  return Array.from(state.diamondPackages.values()).filter(p => p.isActive);
}

async function getDiamondPackageById(id) {
  if (!id) return null;
  if (pool && !closed) {
    try {
      const res = await pool.query('SELECT * FROM diamond_packages WHERE id = $1 AND is_active = TRUE', [id]);
      if (res.rows && res.rows.length > 0) {
        const r = res.rows[0];
        return {
          id: r.id,
          name: r.name,
          diamonds: Number(r.diamonds),
          coins: Number(r.diamonds),
          price: Number(r.price),
          formattedPrice: r.formatted_price,
          description: r.description,
          subtitle: r.subtitle,
          badge: r.badge,
          icon: r.icon,
          sortOrder: Number(r.sort_order),
          isActive: Boolean(r.is_active)
        };
      }
    } catch {}
  }
  const pkg = state.diamondPackages.get(id);
  return pkg && pkg.isActive ? pkg : null;
}

async function createTopupOrder({ orderId, userId, packageId, diamonds = null, grossAmount = null, snapToken = null, paymentType = null, paymentDetails = null }) {
  // Ambil paket diamond langsung dari database untuk validasi jumlah diamond & harga resmi
  const pkg = await getDiamondPackageById(packageId);
  const finalDiamonds = pkg ? pkg.diamonds : Number(diamonds || 0);
  const finalGrossAmount = pkg ? pkg.price : Number(grossAmount || 0);

  const now = new Date().toISOString();
  const order = {
    orderId,
    userId,
    packageId,
    diamonds: finalDiamonds,
    grossAmount: finalGrossAmount,
    status: 'pending',
    snapToken,
    paymentType,
    paymentDetails: paymentDetails || null,
    createdAt: now,
    updatedAt: now
  };
  state.topupOrders.set(orderId, order);
  persistLocalFallback();

  if (pool && !closed) {
    const detailsJson = paymentDetails ? JSON.stringify(paymentDetails) : null;
    await execPg(
      `INSERT INTO topup_orders (order_id, user_id, package_id, diamonds, gross_amount, status, snap_token, payment_type, payment_details, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (order_id) DO UPDATE SET
         status = EXCLUDED.status,
         snap_token = EXCLUDED.snap_token,
         payment_type = EXCLUDED.payment_type,
         payment_details = EXCLUDED.payment_details,
         updated_at = EXCLUDED.updated_at`,
      [orderId, userId, packageId, finalDiamonds, finalGrossAmount, 'pending', snapToken, paymentType, detailsJson, now, now]
    );
  }
  return order;
}

async function getTopupOrder(orderId) {
  if (!orderId) return null;
  let order = state.topupOrders.get(orderId);
  if (order) return order;
  if (pool && !closed) {
    try {
      const res = await pool.query('SELECT * FROM topup_orders WHERE order_id = $1', [orderId]);
      if (res.rows && res.rows.length > 0) {
        const r = res.rows[0];
        let details = r.payment_details;
        if (typeof details === 'string') {
          try { details = JSON.parse(details); } catch {}
        }
        order = {
          orderId: r.order_id,
          userId: r.user_id,
          packageId: r.package_id,
          diamonds: Number(r.diamonds),
          grossAmount: Number(r.gross_amount),
          status: r.status,
          snapToken: r.snap_token,
          paymentType: r.payment_type,
          paymentDetails: details || null,
          createdAt: r.created_at,
          updatedAt: r.updated_at
        };
        state.topupOrders.set(orderId, order);
        return order;
      }
    } catch {}
  }
  return null;
}

async function completeTopupOrder(orderId, paymentType = 'duitku') {
  const order = await getTopupOrder(orderId);
  if (!order) return { error: 'Order tidak ditemukan' };

  const now = new Date().toISOString();
  const chosenPayment = paymentType || order.paymentType || 'duitku';

  // Atomic update di database PostgreSQL untuk mencegah race condition (double credit)
  if (pool && !closed) {
    try {
      const res = await pool.query(
        `UPDATE topup_orders
         SET status = 'success', payment_type = $1, updated_at = $2
         WHERE order_id = $3 AND status != 'success'
         RETURNING *`,
        [chosenPayment, now, orderId]
      );
      if (res.rowCount === 0) {
        // Order sudah diselesaikan sebelumnya oleh request lain (idempotent)
        const existing = await getTopupOrder(orderId);
        const user = findUserById(existing ? existing.userId : order.userId);
        return { success: true, alreadyCompleted: true, order: existing || order, user: sanitizeUser(user) };
      }
    } catch (err) {
      console.error('[DB COMPLETE ORDER ERROR]', err.message);
      return { error: 'Gagal menyelesaikan order di database.' };
    }
  } else {
    if (order.status === 'success') {
      const user = findUserById(order.userId);
      return { success: true, alreadyCompleted: true, order, user: sanitizeUser(user) };
    }
  }

  order.status = 'success';
  order.paymentType = chosenPayment;
  order.updatedAt = now;
  state.topupOrders.set(orderId, order);
  persistLocalFallback();

  const awardResult = awardUserPoints(order.userId, order.diamonds);
  return {
    success: true,
    order,
    diamondsAwarded: order.diamonds,
    coinsAwarded: order.diamonds,
    user: awardResult ? awardResult.user : sanitizeUser(findUserById(order.userId))
  };
}


// ==========================================
// SNAPSHOT ROOM
// ==========================================

function saveRoom(code, roomState) {
  if (closed) return;
  const now = Date.now();
  state.rooms.set(code, { code, state: roomState, updatedAt: now });
  persistLocalFallback();
  execPg(
    `INSERT INTO rooms (code, state, updated_at) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (code) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at`,
    [code, JSON.stringify(roomState), now]
  );
}

function deleteRoom(code) {
  if (closed) return;
  state.rooms.delete(code);
  persistLocalFallback();
  execPg('DELETE FROM rooms WHERE code = $1', [code]);
}

function loadRooms() {
  const result = [];
  for (const row of state.rooms.values()) {
    try {
      const parsed = typeof row.state === 'string' ? JSON.parse(row.state) : row.state;
      result.push({ code: row.code, state: JSON.parse(JSON.stringify(parsed)), updatedAt: row.updatedAt });
    } catch (err) {
      console.error(`[DB] Snapshot room ${row.code} rusak, dilewati:`, err.message);
      deleteRoom(row.code);
    }
  }
  return result;
}

async function flush() {
  if (pendingQueries.size > 0) {
    await Promise.allSettled(Array.from(pendingQueries));
  }
}

async function close() {
  if (closed) return;
  await flush();
  closed = true;
  if (pool) {
    const activePool = pool;
    pool = null;
    await activePool.end().catch(err => console.error('[PG CLOSE]', err.message));
  }
}

module.exports = {
  DB_FILE,
  DATA_DIR,
  init,
  flush,
  getStatus,
  // Dipakai modul lain (server/social) untuk menulis ke PostgreSQL dengan antrean yang sama
  getPool: () => (closed ? null : pool),
  execPg,
  execPgTransaction,
  getUserByUsername: findUserByUsername,
  validateUsername,
  validatePassword,
  hashPassword,
  verifyPassword,
  registerUser,
  loginUser,
  loginOrRegisterGoogleUser,
  findUserByGoogleId,
  findUserByEmail,
  getUserByToken,
  getUserById: findUserById,
  deleteSession,
  pruneExpiredSessions,
  recordMatchResult,
  rankPoints,
  getLeaderboard,
  queryGlobalLeaderboard,
  checkIsLudoKing,
  sanitizeUser,
  updateUserAvatar,
  updateUserEmail,
  updateUserProfile,
  getUserItems,
  queryShopItems,
  getShopItemById,
  queryDiamondPackages,
  getDiamondPackageById,
  queryCoinPackages: queryDiamondPackages,
  getCoinPackageById: getDiamondPackageById,
  purchaseItem,
  consumeUserItem,
  awardUserPoints,
  createTopupOrder,
  getTopupOrder,
  completeTopupOrder,
  saveRoom,
  deleteRoom,
  loadRooms,
  close
};
