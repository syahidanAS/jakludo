// Layer Penyimpanan, Statistik Pemain, Riwayat Pertandingan, dan Leaderboard untuk Snakes and Ladders (PlayGo).
// Menyimpan ke tabel PostgreSQL (game_rooms, game_room_players, game_matchmaking_queue, game_match_history)
// sekaligus menyediakan write-through cache di memori dan fallback JSON lokal untuk pengujian.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { GAME_ID, HUMAN_WIN_REWARD_COINS } = require('./config');

const LOCAL_SNAKES_FILE = path.join(db.DATA_DIR, 'jakludo-snakes.json');
const MAX_LOCAL_HISTORY = 500;
const MAX_LOCAL_ROOMS = 200;

const state = {
  rooms: new Map(),         // roomId -> roomRecord
  roomPlayers: new Map(),   // roomId -> Array<playerRecord>
  queueEntries: new Map(),  // queueId -> queueRecord
  matchHistory: []          // Array<historyRecord> (terbaru di depan)
};

function persistLocalSnakes() {
  if (db.getPool()) return;
  try {
    const roomsArr = Array.from(state.rooms.values())
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, MAX_LOCAL_ROOMS);
    const keepRoomIds = new Set(roomsArr.map(r => r.id));
    const playersObj = {};
    for (const [rId, pList] of state.roomPlayers.entries()) {
      if (keepRoomIds.has(rId)) playersObj[rId] = pList;
    }
    const dump = {
      rooms: roomsArr,
      roomPlayers: playersObj,
      matchHistory: state.matchHistory.slice(0, MAX_LOCAL_HISTORY)
    };
    fs.writeFileSync(LOCAL_SNAKES_FILE, JSON.stringify(dump));
  } catch (err) {
    console.error('[SNAKES LOCAL]', err.message);
  }
}

function bootstrapLocalSnakes() {
  if (!fs.existsSync(LOCAL_SNAKES_FILE)) return;
  try {
    const dump = JSON.parse(fs.readFileSync(LOCAL_SNAKES_FILE, 'utf8'));
    for (const r of dump.rooms || []) {
      if (r && r.id) state.rooms.set(r.id, r);
    }
    if (dump.roomPlayers && typeof dump.roomPlayers === 'object') {
      for (const [rId, pList] of Object.entries(dump.roomPlayers)) {
        if (Array.isArray(pList)) state.roomPlayers.set(rId, pList);
      }
    }
    if (Array.isArray(dump.matchHistory)) {
      state.matchHistory = dump.matchHistory;
    }
  } catch (err) {
    console.error('[SNAKES BOOTSTRAP]', err.message);
  }
}

bootstrapLocalSnakes();

async function hydrateFromPostgres() {
  const pool = db.getPool();
  if (!pool) return;

  try {
    const histRes = await pool.query(
      `SELECT * FROM game_match_history
       WHERE game_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [GAME_ID, MAX_LOCAL_HISTORY]
    );
    state.matchHistory = histRes.rows.map(r => ({
      id: r.id,
      roomId: r.room_id,
      gameId: r.game_id,
      userId: r.user_id,
      opponentType: r.opponent_type,
      opponentName: r.opponent_name || 'pemain',
      result: r.result,
      duration: Number(r.duration) || 0,
      totalTurns: Number(r.total_turns) || 0,
      rewardCoins: Number(r.reward_coins) || 0,
      createdAt: Number(r.created_at) || Date.now()
    }));
  } catch (err) {
    console.error('[SNAKES HYDRATE]', err.message);
  }
}

// ==========================================
// ANTREAN MATCHMAKING (game_matchmaking_queue)
// ==========================================

function recordQueueEntry({ id, userId, status = 'searching', queuedAt, expiresAt }) {
  const now = Date.now();
  const entry = {
    id: id || `snk_q_${now}_${crypto.randomBytes(3).toString('hex')}`,
    userId,
    gameId: GAME_ID,
    status,
    queuedAt: queuedAt || now,
    expiresAt: expiresAt || now + 60000,
    createdAt: now,
    updatedAt: now
  };
  state.queueEntries.set(entry.id, entry);

  db.execPg(
    `INSERT INTO game_matchmaking_queue (
       id, user_id, game_id, status, queued_at, expires_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
    [entry.id, entry.userId, GAME_ID, entry.status, entry.queuedAt, entry.expiresAt, now]
  );

  return entry;
}

function updateQueueEntryStatus(queueId, status) {
  if (!queueId) return null;
  const now = Date.now();
  const existing = state.queueEntries.get(queueId);
  if (existing) {
    existing.status = status;
    existing.updatedAt = now;
  }
  db.execPg(
    `UPDATE game_matchmaking_queue SET status = $1, updated_at = $2 WHERE id = $3`,
    [status, now, queueId]
  );
  return existing;
}

// ==========================================
// ROOM & PEMAIN (game_rooms & game_room_players)
// ==========================================

function saveRoomAndPlayers(room) {
  if (!room || !room.id) return;
  const now = Date.now();

  const roomRec = {
    id: room.id,
    gameId: GAME_ID,
    roomCode: room.code,
    roomType: room.roomType || 'quick',
    status: room.status || 'waiting',
    currentTurn: room.currentTurnPlayerId || null,
    winnerPlayerId: room.winnerPlayerId || null,
    gameState: {
      turnIndex: room.turnIndex,
      turnNumber: room.turnNumber,
      lastRoll: room.lastRoll || null,
      moveLog: (room.moveLog || []).slice(-30)
    },
    startedAt: room.startedAt || null,
    finishedAt: room.finishedAt || null,
    createdAt: room.createdAt || now,
    updatedAt: now
  };

  const playerRecs = (room.players || []).map((p, idx) => ({
    id: p.id,
    roomId: room.id,
    userId: p.player_type === 'bot' ? null : p.user_id,
    botId: p.player_type === 'bot' ? p.bot_id || 'default-bot' : null,
    playerType: p.player_type === 'bot' ? 'bot' : 'human',
    displayName: p.username || p.display_name || p.name || 'pemain',
    avatar: p.player_type === 'bot' ? null : p.avatar || null,
    playerOrder: typeof p.player_order === 'number' ? p.player_order : idx,
    position: Number(p.position) || 0,
    color: p.color || 'red',
    status: p.status || 'active',
    createdAt: p.createdAt || now,
    updatedAt: now
  }));

  state.rooms.set(room.id, roomRec);
  state.roomPlayers.set(room.id, playerRecs);
  persistLocalSnakes();

  db.execPgTransaction(async client => {
    await client.query(
      `INSERT INTO game_rooms (
         id, game_id, room_code, room_type, status, current_turn, winner_player_id,
         game_state, started_at, finished_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         current_turn = EXCLUDED.current_turn,
         winner_player_id = EXCLUDED.winner_player_id,
         game_state = EXCLUDED.game_state,
         started_at = EXCLUDED.started_at,
         finished_at = EXCLUDED.finished_at,
         updated_at = EXCLUDED.updated_at`,
      [
        roomRec.id,
        roomRec.gameId,
        roomRec.roomCode,
        roomRec.roomType,
        roomRec.status,
        roomRec.currentTurn,
        roomRec.winnerPlayerId,
        JSON.stringify(roomRec.gameState),
        roomRec.startedAt,
        roomRec.finishedAt,
        roomRec.createdAt,
        roomRec.updatedAt
      ]
    );

    for (const pr of playerRecs) {
      await client.query(
        `INSERT INTO game_room_players (
           id, room_id, user_id, bot_id, player_type, display_name, avatar,
           player_order, position, color, status, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO UPDATE SET
           position = EXCLUDED.position,
           status = EXCLUDED.status,
           updated_at = EXCLUDED.updated_at`,
        [
          pr.id,
          pr.roomId,
          pr.userId,
          pr.botId,
          pr.playerType,
          pr.displayName,
          pr.avatar,
          pr.playerOrder,
          pr.position,
          pr.color,
          pr.status,
          pr.createdAt,
          pr.updatedAt
        ]
      );
    }
  });
}

// ==========================================
// PENYELESAIAN PERTANDINGAN & RIWAYAT (game_match_history)
// ==========================================

function recordCompletedMatch(room) {
  if (!room || !room.id || room.historyRecorded) return [];
  room.historyRecorded = true;

  const now = room.finishedAt || Date.now();
  const startedAt = room.startedAt || room.createdAt || now;
  const durationSeconds = Math.max(1, Math.round((now - startedAt) / 1000));
  const totalTurns = Number(room.turnNumber) || 1;
  const players = room.players || [];

  const hasHumanOpponent = viewerId =>
    players.some(p => p.id !== viewerId && p.player_type === 'human' && p.user_id);

  const createdRecords = [];

  for (const p of players) {
    // Jangan pernah membuat riwayat user atau memberikan kemenangan untuk bot
    if (p.player_type !== 'human' || !p.user_id) continue;

    const isVsHuman = hasHumanOpponent(p.id);
    const opponentType = isVsHuman ? 'human' : 'bot';
    const opponents = players.filter(other => other.id !== p.id);
    const opponentName = opponents.map(o => o.display_name || o.name).join(', ') ||
      (opponent ? (opponent.username || opponent.display_name || opponent.name) : 'pemain');

    const isWinner = room.winnerPlayerId === p.id || (room.winnerUserId && room.winnerUserId === p.user_id);
    const result = isWinner ? 'win' : 'loss';

    // Hadiah Coins kompetitif hanya diberikan saat menang melawan manusia
    let rewardCoins = 0;
    if (isWinner && opponentType === 'human') {
      rewardCoins = HUMAN_WIN_REWARD_COINS;
      db.awardUserPoints(p.user_id, rewardCoins);
    }

    const rec = {
      id: `snk_hist_${now}_${p.user_id}_${crypto.randomBytes(3).toString('hex')}`,
      roomId: room.id,
      roomCode: room.code,
      gameId: GAME_ID,
      userId: p.user_id,
      opponentType,
      opponentName,
      result,
      duration: durationSeconds,
      totalTurns,
      rewardCoins,
      createdAt: now
    };

    state.matchHistory.unshift(rec);
    createdRecords.push(rec);
  }

  if (state.matchHistory.length > MAX_LOCAL_HISTORY) {
    state.matchHistory.length = MAX_LOCAL_HISTORY;
  }

  saveRoomAndPlayers(room);

  db.execPgTransaction(async client => {
    for (const rec of createdRecords) {
      await client.query(
        `INSERT INTO game_match_history (
           id, room_id, game_id, user_id, opponent_type, opponent_name,
           result, duration, total_turns, reward_coins, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO NOTHING`,
        [
          rec.id,
          rec.roomId,
          rec.gameId,
          rec.userId,
          rec.opponentType,
          rec.opponentName,
          rec.result,
          rec.duration,
          rec.totalTurns,
          rec.rewardCoins,
          rec.createdAt
        ]
      );
    }
  });

  return createdRecords;
}

// ==========================================
// STATISTIK PEMAIN & LEADERBOARD (MURNI HUMAN, BOT TERPISAH)
// ==========================================

function getPlayerStats(userId) {
  if (!userId) return null;
  const user = db.getUserById(userId);
  if (!user) return null;

  let humanMatches = 0;
  let humanWins = 0;
  let humanLosses = 0;
  let humanDurationTotal = 0;
  let coinsEarned = 0;

  let botMatches = 0;
  let botWins = 0;
  let botLosses = 0;
  let botDurationTotal = 0;

  for (const h of state.matchHistory) {
    if (h.userId !== userId || h.gameId !== GAME_ID) continue;
    if (h.opponentType === 'human') {
      humanMatches += 1;
      if (h.result === 'win') humanWins += 1;
      else humanLosses += 1;
      humanDurationTotal += Number(h.duration) || 0;
      coinsEarned += Number(h.rewardCoins) || 0;
    } else if (h.opponentType === 'bot') {
      botMatches += 1;
      if (h.result === 'win') botWins += 1;
      else botLosses += 1;
      botDurationTotal += Number(h.duration) || 0;
    }
  }

  const winRate = humanMatches > 0 ? Math.round((humanWins / humanMatches) * 100) : 0;
  const avgDuration = humanMatches > 0 ? Math.round(humanDurationTotal / humanMatches) : 0;
  const botWinRate = botMatches > 0 ? Math.round((botWins / botMatches) * 100) : 0;
  const totalAllMatches = humanMatches + botMatches;

  const allRanked = getSortedLeaderboardEntries();
  const rankIdx = allRanked.findIndex(e => e.userId === userId);

  return {
    userId: user.id,
    username: user.username,
    name: user.name || user.username,
    avatar: user.avatar || '🎯',
    // Statistik kompetitif (vs Manusia) yang dihitung untuk Leaderboard
    totalMatches: humanMatches,
    matchesPlayed: humanMatches,
    wins: humanWins,
    losses: humanLosses,
    winRate,
    avgDuration,
    coinsEarned,
    rank: rankIdx >= 0 ? rankIdx + 1 : null,
    // Statistik terpisah melawan Pemain Komputer (Bot)
    botStats: {
      totalMatches: botMatches,
      wins: botWins,
      losses: botLosses,
      winRate: botWinRate,
      avgDuration: botMatches > 0 ? Math.round(botDurationTotal / botMatches) : 0
    },
    totalAllMatches
  };
}

function getPlayerHistory(userId, limit = 20) {
  if (!userId) return [];
  const max = Math.min(100, Math.max(1, Number(limit) || 20));
  const items = [];
  for (const h of state.matchHistory) {
    if (h.userId !== userId || h.gameId !== GAME_ID) continue;
    items.push({ ...h });
    if (items.length >= max) break;
  }
  return items;
}

function getSortedLeaderboardEntries() {
  // Agregasi hanya dari pertandingan melawan manusia (opponentType === 'human')
  // dan hanya untuk user nyata yang terdaftar di tabel users. Bot tidak pernah masuk ke sini.
  const map = new Map();

  for (const h of state.matchHistory) {
    if (h.gameId !== GAME_ID) continue;
    if (h.opponentType !== 'human') continue;
    if (!h.userId || String(h.userId).startsWith('bot_')) continue;

    let agg = map.get(h.userId);
    if (!agg) {
      agg = {
        userId: h.userId,
        totalMatches: 0,
        wins: 0,
        losses: 0,
        totalDuration: 0,
        coinsEarned: 0
      };
      map.set(h.userId, agg);
    }
    agg.totalMatches += 1;
    if (h.result === 'win') agg.wins += 1;
    else agg.losses += 1;
    agg.totalDuration += Number(h.duration) || 0;
    agg.coinsEarned += Number(h.rewardCoins) || 0;
  }

  const rows = [];
  for (const agg of map.values()) {
    if (agg.totalMatches <= 0) continue;
    const u = db.getUserById(agg.userId);
    if (!u || String(u.id).startsWith('bot_')) continue;
    const winRate = Math.round((agg.wins / agg.totalMatches) * 100);
    const avgDuration = Math.round(agg.totalDuration / agg.totalMatches);
    rows.push({
      userId: u.id,
      username: u.username,
      name: u.name || u.username,
      avatar: u.avatar || '🎯',
      playerType: 'human',
      totalMatches: agg.totalMatches,
      matchesPlayed: agg.totalMatches,
      wins: agg.wins,
      losses: agg.losses,
      winRate,
      avgDuration,
      coinsEarned: agg.coinsEarned
    });
  }

  rows.sort((a, b) =>
    b.wins - a.wins ||
    b.winRate - a.winRate ||
    b.totalMatches - a.totalMatches ||
    a.avgDuration - b.avgDuration ||
    String(a.username).localeCompare(String(b.username))
  );

  return rows.map((item, idx) => ({
    ...item,
    rank: idx + 1
  }));
}

function getSnakesLeaderboard(options = {}) {
  const limit = Math.min(100, Math.max(1, Number(options.limit || options) || 50));
  const page = Math.max(1, Number(options.page) || 1);
  const offset = (page - 1) * limit;
  const all = getSortedLeaderboardEntries();
  const items = all.slice(offset, offset + limit);

  if (typeof options === 'number') {
    return items;
  }

  const viewerUserId = options.viewerUserId || null;
  const myEntry = viewerUserId ? all.find(e => e.userId === viewerUserId) || null : null;

  return {
    items,
    entries: items,
    leaderboard: items,
    total: all.length,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(all.length / limit)),
    myEntry
  };
}

function getStoredRoomByIdOrCode(idOrCode) {
  if (!idOrCode) return null;
  const key = String(idOrCode).trim();
  if (state.rooms.has(key)) {
    return {
      ...state.rooms.get(key),
      players: state.roomPlayers.get(key) || []
    };
  }
  const upper = key.toUpperCase();
  for (const r of state.rooms.values()) {
    if (r.roomCode === upper) {
      return {
        ...r,
        players: state.roomPlayers.get(r.id) || []
      };
    }
  }
  return null;
}

function resetStoreForTesting() {
  state.rooms.clear();
  state.roomPlayers.clear();
  state.queueEntries.clear();
  state.matchHistory = [];
  persistLocalSnakes();
}

module.exports = {
  hydrateFromPostgres,
  recordQueueEntry,
  updateQueueEntryStatus,
  saveRoomAndPlayers,
  recordCompletedMatch,
  getPlayerStats,
  getPlayerHistory,
  getSnakesLeaderboard,
  getStoredRoomByIdOrCode,
  resetStoreForTesting
};

