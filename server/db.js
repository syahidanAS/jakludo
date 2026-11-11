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

const state = {
  usersById: new Map(),       // id -> { id, username, name, passwordHash, authType, avatar, email, createdAt }
  usersByUsername: new Map(), // lower(username) -> id
  userItems: new Map(),       // userId -> { [itemId]: quantity }
  sessions: new Map(),        // tokenHash -> { tokenHash, userId, createdAt, expiresAt }
  leaderboard: new Map(),     // userId -> { userId, username, name, avatar, wins, matchesPlayed, points, authType }
  rooms: new Map()            // code -> { code, state, updatedAt }
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
    createdAt: u.createdAt || u.created_at || new Date().toISOString()
  };
  state.usersById.set(row.id, row);
  state.usersByUsername.set(row.username.toLowerCase(), row.id);
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

  const [usersRes, itemsRes, sessionsRes, lbRes, roomsRes] = await Promise.all([
    activePool.query('SELECT * FROM users'),
    activePool.query('SELECT user_id, item_id, quantity FROM user_items WHERE quantity > 0'),
    activePool.query('SELECT token_hash, user_id, created_at, expires_at FROM sessions WHERE expires_at > $1', [Date.now()]),
    activePool.query('SELECT * FROM leaderboard'),
    activePool.query('SELECT code, state, updated_at FROM rooms')
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
    createdAt: row.createdAt,
    inventory: getUserItems(row.id)
  };
}

function findUserById(id) {
  if (typeof id !== 'string') return null;
  return buildUserObject(state.usersById.get(id));
}

function findUserByUsername(username) {
  if (!username) return null;
  const id = state.usersByUsername.get(String(username).toLowerCase());
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

// Catat hasil pertandingan. Hanya akun terdaftar yang mendapat poin, dan hanya
// jika lawannya mencakup minimal satu manusia lain (menang lawan bot tidak dihitung).
// ranking: id pemain dari peringkat 1 ke bawah (lihat rankPlayers). Tanpa ranking, pemenang dianggap
// peringkat 1 dan sisanya mengikuti urutan players.
// Return { [playerId]: { points, dailyBonus } } untuk ditampilkan di layar hasil.
function recordMatchResult({ winnerPlayerId, players, ranking, now = Date.now() }) {
  const awards = {};
  if (!players || players.length === 0) return awards;
  const humans = players.filter(p => !p.isBot);
  if (humans.length < 2) return awards; // menang melawan bot tidak memberi poin
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
        await client.query(
          `INSERT INTO leaderboard (user_id, username, name, avatar, wins, matches_played, points, auth_type)
           VALUES ($1, $2, $3, $4, 0, 0, $5, $6)
           ON CONFLICT (user_id) DO NOTHING`,
          [user.id, user.username, user.name, user.avatar || '🎲', STARTER_POINTS, user.authType]
        );
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

function getRankedEntries() {
  const excluded = new Set(['bot', 'player', 'seed']);
  return Array.from(state.leaderboard.values())
    .filter(e => !excluded.has(e.authType))
    .sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.points !== a.points) return b.points - a.points;
      const wrA = a.matchesPlayed > 0 ? a.wins / a.matchesPlayed : 0;
      const wrB = b.matchesPlayed > 0 ? b.wins / b.matchesPlayed : 0;
      return wrB - wrA;
    });
}

function getLeaderboard() {
  return getRankedEntries().map((player, index) => {
    const rank = index + 1;
    const winRate = player.matchesPlayed > 0 ? Math.round((player.wins / player.matchesPlayed) * 100) : 0;
    return { ...player, rank, winRate, isLudoKing: rank === 1 && player.wins > 0 };
  });
}

function checkIsLudoKing(userId) {
  if (!userId) return false;
  const king = getRankedEntries()[0];
  return !!(king && king.wins > 0 && king.userId === userId);
}

// ==========================================
// TOKO & INVENTARIS ITEM
// ==========================================

function purchaseItem({ userId, itemId, price }) {
  const user = findUserById(userId);
  if (!user) return { error: 'Pengguna tidak ditemukan.' };

  const entry = ensureLeaderboardEntry(user);
  if (entry.points < price) {
    return { error: `Poin tidak mencukupi. Diperlukan ${price} poin, kamu memiliki ${entry.points} poin.` };
  }

  entry.points -= price;
  const currentQty = getUserItems(user.id)[itemId] || 0;
  setItemInState(user.id, itemId, currentQty + 1);
  persistLocalFallback();

  execPgTransaction(async client => {
    await client.query(
      `INSERT INTO leaderboard (user_id, username, name, avatar, wins, matches_played, points, auth_type)
       VALUES ($1, $2, $3, $4, 0, 0, $5, $6)
       ON CONFLICT (user_id) DO NOTHING`,
      [user.id, user.username, user.name, user.avatar || '🎲', STARTER_POINTS, user.authType]
    );
    await client.query(
      'UPDATE leaderboard SET points = points - $1 WHERE user_id = $2 AND points >= $1',
      [price, user.id]
    );
    await client.query(
      `INSERT INTO user_items (user_id, item_id, quantity) VALUES ($1, $2, 1)
       ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = user_items.quantity + 1`,
      [user.id, itemId]
    );
  });

  return { success: true, user: sanitizeUser(findUserById(user.id)) };
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
  getUserByToken,
  getUserById: findUserById,
  deleteSession,
  pruneExpiredSessions,
  recordMatchResult,
  rankPoints,
  getLeaderboard,
  checkIsLudoKing,
  sanitizeUser,
  updateUserAvatar,
  getUserItems,
  purchaseItem,
  consumeUserItem,
  saveRoom,
  deleteRoom,
  loadRooms,
  close
};
