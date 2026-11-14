// Penyimpanan, Rating Elo, Riwayat Pertandingan, PGN Export, dan Leaderboard untuk Chess Master (PlayGo).
// Mendukung PostgreSQL (transaksional via db.execPgTransaction) dan fallback JSON lokal untuk pengujian.
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { isBotUserId, getBotProfile } = require('./bot');

function resolveUserOrBot(userId, fallbackRating = DEFAULT_RATING) {
  if (!userId) return null;
  if (isBotUserId(userId)) {
    return getBotProfile(userId, fallbackRating);
  }
  return db.getUserById(userId);
}

const LOCAL_CHESS_FILE = path.join(db.DATA_DIR, 'jakludo-chess.json');
const MAX_LOCAL_MATCHES = 300;
const DEFAULT_RATING = 1200;
const MIN_RATING = 100;
const DEFAULT_K_FACTOR = Number(process.env.CHESS_ELO_K_FACTOR || 32);
const WIN_REWARD_COINS = 15;
const DRAW_REWARD_COINS = 5;

const TIME_CONTROLS = {
  '1+0': { id: '1+0', label: '1+0 · Bullet', category: 'Bullet', initialMs: 60 * 1000, incrementSeconds: 0 },
  '2+1': { id: '2+1', label: '2+1 · Bullet', category: 'Bullet', initialMs: 2 * 60 * 1000, incrementSeconds: 1 },
  '3+0': { id: '3+0', label: '3+0 · Blitz', category: 'Blitz', initialMs: 3 * 60 * 1000, incrementSeconds: 0 },
  '3+2': { id: '3+2', label: '3+2 · Blitz', category: 'Blitz', initialMs: 3 * 60 * 1000, incrementSeconds: 2 },
  '5+0': { id: '5+0', label: '5+0 · Blitz', category: 'Blitz', initialMs: 5 * 60 * 1000, incrementSeconds: 0, primary: true },
  '10+0': { id: '10+0', label: '10+0 · Rapid', category: 'Rapid', initialMs: 10 * 60 * 1000, incrementSeconds: 0, primary: true },
  '10+5': { id: '10+5', label: '10+5 · Rapid', category: 'Rapid', initialMs: 10 * 60 * 1000, incrementSeconds: 5 }
};

const state = {
  profiles: new Map(),        // userId -> { userId, rating, highestRating, totalGames, wins, losses, draws, currentStreak, createdAt, updatedAt }
  matches: new Map(),         // matchId -> matchObject
  movesByMatch: new Map(),    // matchId -> Array<moveObject>
  ratingHistories: []         // Array<{ userId, matchId, ratingBefore, ratingAfter, ratingChange, createdAt }>
};

function getTimeControl(tcId) {
  return TIME_CONTROLS[String(tcId || '5+0').trim()] || TIME_CONTROLS['5+0'];
}

function listTimeControls() {
  return Object.values(TIME_CONTROLS);
}

function persistLocalChess() {
  if (db.getPool()) return;
  try {
    const matchesArr = Array.from(state.matches.values())
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, MAX_LOCAL_MATCHES);
    const keepIds = new Set(matchesArr.map(m => m.id));
    const movesObj = {};
    for (const [mId, moves] of state.movesByMatch.entries()) {
      if (keepIds.has(mId)) movesObj[mId] = moves;
    }
    const dump = {
      profiles: Array.from(state.profiles.values()),
      matches: matchesArr,
      movesByMatch: movesObj,
      ratingHistories: state.ratingHistories.slice(0, 1000)
    };
    fs.writeFileSync(LOCAL_CHESS_FILE, JSON.stringify(dump));
  } catch (err) {
    console.error('[CHESS LOCAL]', err.message);
  }
}

function bootstrapLocalChess() {
  if (!fs.existsSync(LOCAL_CHESS_FILE)) return;
  try {
    const dump = JSON.parse(fs.readFileSync(LOCAL_CHESS_FILE, 'utf8'));
    for (const p of dump.profiles || []) {
      if (p && p.userId) {
        state.profiles.set(p.userId, {
          userId: p.userId,
          rating: Number(p.rating) || DEFAULT_RATING,
          highestRating: Number(p.highestRating) || Number(p.rating) || DEFAULT_RATING,
          totalGames: Number(p.totalGames) || 0,
          wins: Number(p.wins) || 0,
          losses: Number(p.losses) || 0,
          draws: Number(p.draws) || 0,
          currentStreak: Number(p.currentStreak) || 0,
          createdAt: Number(p.createdAt) || Date.now(),
          updatedAt: Number(p.updatedAt) || Date.now()
        });
      }
    }
    for (const m of dump.matches || []) {
      if (m && m.id) state.matches.set(m.id, m);
    }
    if (dump.movesByMatch && typeof dump.movesByMatch === 'object') {
      for (const [mId, moves] of Object.entries(dump.movesByMatch)) {
        if (Array.isArray(moves)) state.movesByMatch.set(mId, moves);
      }
    }
    if (Array.isArray(dump.ratingHistories)) {
      state.ratingHistories = dump.ratingHistories;
    }
  } catch (err) {
    console.error('[CHESS BOOTSTRAP]', err.message);
  }
}

bootstrapLocalChess();

async function hydrateFromPostgres() {
  const pool = db.getPool();
  if (!pool) return;

  try {
    const profRes = await pool.query('SELECT * FROM chess_profiles');
    for (const r of profRes.rows) {
      state.profiles.set(r.user_id, {
        userId: r.user_id,
        rating: Number(r.rating) || DEFAULT_RATING,
        highestRating: Number(r.highest_rating) || DEFAULT_RATING,
        totalGames: Number(r.total_games) || 0,
        wins: Number(r.wins) || 0,
        losses: Number(r.losses) || 0,
        draws: Number(r.draws) || 0,
        currentStreak: Number(r.current_streak) || 0,
        createdAt: Number(r.created_at) || Date.now(),
        updatedAt: Number(r.updated_at) || Date.now()
      });
    }

    const matchRes = await pool.query(
      `SELECT * FROM chess_matches ORDER BY created_at DESC LIMIT $1`,
      [MAX_LOCAL_MATCHES]
    );
    const matchIds = [];
    for (const r of matchRes.rows) {
      const m = mapRowToMatch(r);
      state.matches.set(m.id, m);
      matchIds.push(m.id);
    }

    if (matchIds.length > 0) {
      const moveRes = await pool.query(
        `SELECT * FROM chess_moves WHERE match_id = ANY($1::text[]) ORDER BY match_id, move_number ASC`,
        [matchIds]
      );
      for (const mr of moveRes.rows) {
        const list = state.movesByMatch.get(mr.match_id) || [];
        list.push(mapRowToMove(mr));
        state.movesByMatch.set(mr.match_id, list);
      }
    }

    const histRes = await pool.query(
      `SELECT * FROM chess_rating_histories ORDER BY created_at DESC LIMIT 1000`
    );
    state.ratingHistories = histRes.rows.map(r => ({
      userId: r.user_id,
      matchId: r.match_id,
      ratingBefore: Number(r.rating_before),
      ratingAfter: Number(r.rating_after),
      ratingChange: Number(r.rating_change),
      createdAt: Number(r.created_at)
    }));
  } catch (err) {
    console.error('[CHESS HYDRATE]', err.message);
  }
}

function mapRowToMatch(r) {
  return {
    id: r.id,
    whitePlayerId: r.white_player_id,
    blackPlayerId: r.black_player_id,
    roomCode: r.room_code || null,
    groupId: r.group_id || null,
    matchType: r.match_type || 'quick',
    timeControl: r.time_control || '5+0',
    initialFen: r.initial_fen,
    currentFen: r.current_fen,
    currentTurn: r.current_turn || 'w',
    whiteRemainingTimeMs: Number(r.white_remaining_time_ms),
    blackRemainingTimeMs: Number(r.black_remaining_time_ms),
    incrementSeconds: Number(r.increment_seconds) || 0,
    lastMoveAt: r.last_move_at ? Number(r.last_move_at) : null,
    moveVersion: Number(r.move_version) || 0,
    status: r.status || 'waiting',
    result: r.result || '*',
    winnerUserId: r.winner_user_id || null,
    terminationReason: r.termination_reason || null,
    pgn: r.pgn || '',
    whiteRatingBefore: r.white_rating_before != null ? Number(r.white_rating_before) : DEFAULT_RATING,
    whiteRatingAfter: r.white_rating_after != null ? Number(r.white_rating_after) : null,
    whiteRatingChange: Number(r.white_rating_change) || 0,
    blackRatingBefore: r.black_rating_before != null ? Number(r.black_rating_before) : DEFAULT_RATING,
    blackRatingAfter: r.black_rating_after != null ? Number(r.black_rating_after) : null,
    blackRatingChange: Number(r.black_rating_change) || 0,
    startedAt: r.started_at ? Number(r.started_at) : null,
    finishedAt: r.finished_at ? Number(r.finished_at) : null,
    createdAt: Number(r.created_at) || Date.now(),
    updatedAt: Number(r.updated_at) || Date.now()
  };
}

function mapRowToMove(mr) {
  const num = Number(mr.move_number);
  const san = mr.san || '';
  return {
    moveNumber: num,
    ply: num,
    playerId: mr.player_id,
    color: mr.color,
    from: mr.from_square,
    to: mr.to_square,
    promotion: mr.promotion || null,
    piece: mr.piece || null,
    captured: mr.captured || null,
    flags: mr.flags || null,
    san,
    isCheck: san.includes('+') || san.includes('#'),
    isCheckmate: san.includes('#'),
    fenAfter: mr.fen_after,
    elapsedTimeMs: Number(mr.elapsed_time_ms) || 0,
    whiteRemainingMs: mr.white_remaining_ms != null ? Number(mr.white_remaining_ms) : null,
    blackRemainingMs: mr.black_remaining_ms != null ? Number(mr.black_remaining_ms) : null,
    createdAt: Number(mr.created_at)
  };
}

// ==========================================
// ELO RATING SERVICE
// ==========================================

function calculateEloChanges(whiteRating, blackRating, resultString, kFactor = DEFAULT_K_FACTOR) {
  const rW = Number(whiteRating) || DEFAULT_RATING;
  const rB = Number(blackRating) || DEFAULT_RATING;
  const K = Number(kFactor) || 32;

  const expectedWhite = 1 / (1 + Math.pow(10, (rB - rW) / 400));
  const expectedBlack = 1 - expectedWhite;

  let actualWhite = 0.5;
  let actualBlack = 0.5;
  if (resultString === '1-0') {
    actualWhite = 1;
    actualBlack = 0;
  } else if (resultString === '0-1') {
    actualWhite = 0;
    actualBlack = 1;
  }

  let whiteChange = Math.round(K * (actualWhite - expectedWhite));
  let blackChange = Math.round(K * (actualBlack - expectedBlack));

  // Pastikan pemenang minimal +1 dan yang kalah minimal -1 pada pertandingan normal
  if (resultString === '1-0') {
    if (whiteChange < 1) whiteChange = 1;
    if (blackChange > -1) blackChange = -1;
  } else if (resultString === '0-1') {
    if (blackChange < 1) blackChange = 1;
    if (whiteChange > -1) whiteChange = -1;
  }

  const whiteAfter = Math.max(MIN_RATING, rW + whiteChange);
  const blackAfter = Math.max(MIN_RATING, rB + blackChange);

  return {
    whiteBefore: rW,
    whiteAfter,
    whiteChange: whiteAfter - rW,
    blackBefore: rB,
    blackAfter,
    blackChange: blackAfter - rB
  };
}

function ensureProfile(userId) {
  if (!userId || isBotUserId(userId)) return null;
  let prof = state.profiles.get(userId);
  if (!prof) {
    const now = Date.now();
    prof = {
      userId,
      rating: DEFAULT_RATING,
      highestRating: DEFAULT_RATING,
      totalGames: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      currentStreak: 0,
      createdAt: now,
      updatedAt: now
    };
    state.profiles.set(userId, prof);
    db.execPg(
      `INSERT INTO chess_profiles (user_id, rating, highest_rating, total_games, wins, losses, draws, current_streak, created_at, updated_at)
       VALUES ($1, $2, $2, 0, 0, 0, 0, 0, $3, $3)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, DEFAULT_RATING, now]
    );
    persistLocalChess();
  }
  return prof;
}

function getPlayerProfile(userId) {
  if (!userId) return null;
  if (isBotUserId(userId)) {
    const bot = getBotProfile(userId);
    return {
      userId: bot.id,
      username: bot.username,
      name: bot.name,
      avatar: bot.avatar || '🤖',
      rating: bot.rating || DEFAULT_RATING,
      highestRating: bot.rating || DEFAULT_RATING,
      totalGames: 0,
      matchesPlayed: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      winRate: 50,
      currentStreak: 0,
      rank: null,
      isBot: true
    };
  }
  const user = db.getUserById(userId);
  const prof = state.profiles.get(userId) || {
    userId,
    rating: DEFAULT_RATING,
    highestRating: DEFAULT_RATING,
    totalGames: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    currentStreak: 0
  };
  const winRate = prof.totalGames > 0 ? Math.round((prof.wins / prof.totalGames) * 100) : 0;

  // Hitung peringkat bila sudah pernah bertanding
  const allRanked = getSortedLeaderboardEntries();
  const rankIdx = allRanked.findIndex(e => e.userId === userId);

  return {
    userId,
    username: user?.username || 'player',
    name: user?.name || user?.username || 'Pemain',
    avatar: user?.avatar || '🎯',
    rating: prof.rating,
    highestRating: Math.max(prof.highestRating || prof.rating, prof.rating),
    totalGames: prof.totalGames,
    matchesPlayed: prof.totalGames,
    wins: prof.wins,
    losses: prof.losses,
    draws: prof.draws,
    winRate,
    currentStreak: prof.currentStreak || 0,
    rank: rankIdx >= 0 ? rankIdx + 1 : null
  };
}

function getSortedLeaderboardEntries() {
  const rows = [];
  for (const prof of state.profiles.values()) {
    if (prof.totalGames <= 0 && prof.rating === DEFAULT_RATING) continue;
    const u = db.getUserById(prof.userId);
    if (!u) continue;
    const winRate = prof.totalGames > 0 ? Math.round((prof.wins / prof.totalGames) * 100) : 0;
    rows.push({
      userId: prof.userId,
      username: u.username,
      name: u.name || u.username,
      avatar: u.avatar || '🎯',
      rating: prof.rating,
      highestRating: prof.highestRating || prof.rating,
      totalGames: prof.totalGames,
      matchesPlayed: prof.totalGames,
      wins: prof.wins,
      losses: prof.losses,
      draws: prof.draws,
      winRate,
      currentStreak: prof.currentStreak || 0
    });
  }

  rows.sort((a, b) =>
    b.rating - a.rating ||
    b.wins - a.wins ||
    b.winRate - a.winRate ||
    a.totalGames - b.totalGames ||
    String(a.username).localeCompare(String(b.username))
  );

  return rows.map((item, idx) => ({
    ...item,
    rank: idx + 1
  }));
}

function getChessLeaderboard(options = {}) {
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
    total: all.length,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(all.length / limit)),
    myEntry
  };
}

// ==========================================
// PGN GENERATOR & MATCH STORAGE
// ==========================================

function generatePgn({ match, whiteUser, blackUser, moves }) {
  const dateObj = new Date(match.startedAt || match.createdAt || Date.now());
  const yyyy = dateObj.getUTCFullYear();
  const mm = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dateObj.getUTCDate()).padStart(2, '0');
  const dateStr = `${yyyy}.${mm}.${dd}`;

  const headers = [
    `[Event "PlayGo Chess Master (${match.matchType || 'quick'})"]`,
    `[Site "PlayGo"]`,
    `[Date "${dateStr}"]`,
    `[Round "-"]`,
    `[White "${(whiteUser?.name || whiteUser?.username || 'White').replace(/"/g, "'")}"]`,
    `[Black "${(blackUser?.name || blackUser?.username || 'Black').replace(/"/g, "'")}"]`,
    `[Result "${match.result || '*'}"]`,
    `[WhiteElo "${match.whiteRatingBefore || DEFAULT_RATING}"]`,
    `[BlackElo "${match.blackRatingBefore || DEFAULT_RATING}"]`,
    `[TimeControl "${match.timeControl || '5+0'}"]`
  ];
  if (match.terminationReason) {
    headers.push(`[Termination "${match.terminationReason}"]`);
  }

  const moveTokens = [];
  for (let i = 0; i < moves.length; i += 2) {
    const fullMoveNo = Math.floor(i / 2) + 1;
    const wMove = moves[i];
    const bMove = moves[i + 1];
    if (wMove && bMove) {
      moveTokens.push(`${fullMoveNo}. ${wMove.san} ${bMove.san}`);
    } else if (wMove) {
      moveTokens.push(`${fullMoveNo}. ${wMove.san}`);
    }
  }
  if (match.result && match.result !== '*') {
    moveTokens.push(match.result);
  }

  return `${headers.join('\n')}\n\n${moveTokens.join(' ').trim()}`;
}

function createMatchRecord({
  id,
  whitePlayerId,
  blackPlayerId,
  whiteBotRating = null,
  blackBotRating = null,
  roomCode = null,
  groupId = null,
  matchType = 'quick',
  timeControl = '5+0',
  initialFen,
  whiteRemainingTimeMs,
  blackRemainingTimeMs,
  incrementSeconds = 0,
  status = 'active',
  startedAt = Date.now()
}) {
  const now = Date.now();
  const wProf = ensureProfile(whitePlayerId);
  const bProf = ensureProfile(blackPlayerId);
  const wBot = isBotUserId(whitePlayerId) ? getBotProfile(whitePlayerId, whiteBotRating) : null;
  const bBot = isBotUserId(blackPlayerId) ? getBotProfile(blackPlayerId, blackBotRating) : null;

  const match = {
    id,
    whitePlayerId,
    blackPlayerId,
    roomCode,
    groupId,
    matchType,
    timeControl,
    initialFen,
    currentFen: initialFen,
    currentTurn: 'w',
    whiteRemainingTimeMs,
    blackRemainingTimeMs,
    incrementSeconds,
    lastMoveAt: startedAt,
    moveVersion: 0,
    status,
    result: '*',
    winnerUserId: null,
    terminationReason: null,
    pgn: '',
    whiteRatingBefore: wProf ? wProf.rating : wBot ? wBot.rating : DEFAULT_RATING,
    whiteRatingAfter: null,
    whiteRatingChange: 0,
    blackRatingBefore: bProf ? bProf.rating : bBot ? bBot.rating : DEFAULT_RATING,
    blackRatingAfter: null,
    blackRatingChange: 0,
    startedAt,
    finishedAt: null,
    createdAt: now,
    updatedAt: now
  };

  state.matches.set(id, match);
  state.movesByMatch.set(id, []);
  persistLocalChess();

  const pgWhiteId = isBotUserId(whitePlayerId) ? null : whitePlayerId;
  const pgBlackId = isBotUserId(blackPlayerId) ? null : blackPlayerId;

  db.execPg(
    `INSERT INTO chess_matches (
       id, white_player_id, black_player_id, room_code, group_id, match_type, time_control,
       initial_fen, current_fen, current_turn, white_remaining_time_ms, black_remaining_time_ms,
       increment_seconds, last_move_at, move_version, status, result,
       white_rating_before, black_rating_before, started_at, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $8, 'w', $9, $10,
       $11, $12, 0, $13, '*',
       $14, $15, $12, $16, $16
     )
     ON CONFLICT (id) DO NOTHING`,
    [
      id,
      pgWhiteId,
      pgBlackId,
      roomCode,
      groupId,
      matchType === 'bot' ? 'quick' : matchType,
      timeControl,
      initialFen,
      whiteRemainingTimeMs,
      blackRemainingTimeMs,
      incrementSeconds,
      startedAt,
      status,
      match.whiteRatingBefore,
      match.blackRatingBefore,
      now
    ]
  );

  return match;
}

function recordMove({
  matchId,
  moveNumber,
  playerId,
  color,
  from,
  to,
  promotion = null,
  piece = null,
  captured = null,
  flags = null,
  san,
  fenAfter,
  nextTurn,
  elapsedTimeMs,
  whiteRemainingTimeMs,
  blackRemainingTimeMs,
  moveVersion,
  now = Date.now()
}) {
  const match = state.matches.get(matchId);
  if (match) {
    match.currentFen = fenAfter;
    match.currentTurn = nextTurn;
    match.whiteRemainingTimeMs = whiteRemainingTimeMs;
    match.blackRemainingTimeMs = blackRemainingTimeMs;
    match.lastMoveAt = now;
    match.moveVersion = moveVersion;
    match.updatedAt = now;
  }

  const moveRecord = {
    moveNumber,
    ply: moveNumber,
    playerId,
    color,
    from,
    to,
    promotion: promotion || null,
    piece: piece || null,
    captured: captured || null,
    flags: flags || null,
    san,
    isCheck: String(san || '').includes('+') || String(san || '').includes('#'),
    isCheckmate: String(san || '').includes('#'),
    fenAfter,
    elapsedTimeMs,
    whiteRemainingMs: whiteRemainingTimeMs,
    blackRemainingMs: blackRemainingTimeMs,
    createdAt: now
  };

  const list = state.movesByMatch.get(matchId) || [];
  list.push(moveRecord);
  state.movesByMatch.set(matchId, list);
  persistLocalChess();

  db.execPgTransaction(async client => {
    await client.query(
      `UPDATE chess_matches
       SET current_fen = $1,
           current_turn = $2,
           white_remaining_time_ms = $3,
           black_remaining_time_ms = $4,
           last_move_at = $5,
           move_version = $6,
           updated_at = $5
       WHERE id = $7`,
      [fenAfter, nextTurn, whiteRemainingTimeMs, blackRemainingTimeMs, now, moveVersion, matchId]
    );
    await client.query(
      `INSERT INTO chess_moves (
         match_id, move_number, player_id, color, from_square, to_square,
         promotion, piece, captured, flags, san, fen_after,
         elapsed_time_ms, white_remaining_ms, black_remaining_ms, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (match_id, move_number) DO NOTHING`,
      [
        matchId,
        moveNumber,
        playerId,
        color,
        from,
        to,
        promotion || null,
        piece || null,
        captured || null,
        flags || null,
        san,
        fenAfter,
        elapsedTimeMs,
        whiteRemainingTimeMs,
        blackRemainingTimeMs,
        now
      ]
    );
  });

  return moveRecord;
}

function finalizeMatchRecord({
  matchId,
  result,
  winnerUserId = null,
  terminationReason = 'checkmate',
  whiteRemainingTimeMs,
  blackRemainingTimeMs,
  currentFen
}) {
  const match = state.matches.get(matchId);
  if (!match) return null;
  if (match.status === 'completed') return match;

  const now = Date.now();
  const whiteUser = resolveUserOrBot(match.whitePlayerId, match.whiteRatingBefore);
  const blackUser = resolveUserOrBot(match.blackPlayerId, match.blackRatingBefore);
  const wProf = ensureProfile(match.whitePlayerId);
  const bProf = ensureProfile(match.blackPlayerId);

  const elo = calculateEloChanges(
    wProf ? wProf.rating : match.whiteRatingBefore,
    bProf ? bProf.rating : match.blackRatingBefore,
    result
  );

  // Update profil White
  if (wProf) {
    wProf.rating = elo.whiteAfter;
    if (wProf.rating > wProf.highestRating) wProf.highestRating = wProf.rating;
    wProf.totalGames += 1;
    if (result === '1-0') {
      wProf.wins += 1;
      wProf.currentStreak = wProf.currentStreak > 0 ? wProf.currentStreak + 1 : 1;
    } else if (result === '0-1') {
      wProf.losses += 1;
      wProf.currentStreak = wProf.currentStreak < 0 ? wProf.currentStreak - 1 : -1;
    } else {
      wProf.draws += 1;
      wProf.currentStreak = 0;
    }
    wProf.updatedAt = now;
  }

  // Update profil Black
  if (bProf) {
    bProf.rating = elo.blackAfter;
    if (bProf.rating > bProf.highestRating) bProf.highestRating = bProf.rating;
    bProf.totalGames += 1;
    if (result === '0-1') {
      bProf.wins += 1;
      bProf.currentStreak = bProf.currentStreak > 0 ? bProf.currentStreak + 1 : 1;
    } else if (result === '1-0') {
      bProf.losses += 1;
      bProf.currentStreak = bProf.currentStreak < 0 ? bProf.currentStreak - 1 : -1;
    } else {
      bProf.draws += 1;
      bProf.currentStreak = 0;
    }
    bProf.updatedAt = now;
  }

  const moves = state.movesByMatch.get(matchId) || [];

  match.status = 'completed';
  match.result = result;
  match.winnerUserId = winnerUserId;
  match.terminationReason = terminationReason;
  if (typeof whiteRemainingTimeMs === 'number') match.whiteRemainingTimeMs = whiteRemainingTimeMs;
  if (typeof blackRemainingTimeMs === 'number') match.blackRemainingTimeMs = blackRemainingTimeMs;
  if (currentFen) match.currentFen = currentFen;
  match.whiteRatingBefore = elo.whiteBefore;
  match.whiteRatingAfter = elo.whiteAfter;
  match.whiteRatingChange = elo.whiteChange;
  match.blackRatingBefore = elo.blackBefore;
  match.blackRatingAfter = elo.blackAfter;
  match.blackRatingChange = elo.blackChange;
  match.finishedAt = now;
  match.updatedAt = now;
  match.pgn = generatePgn({ match, whiteUser, blackUser, moves });

  if (wProf) {
    state.ratingHistories.unshift({
      userId: match.whitePlayerId,
      matchId,
      ratingBefore: elo.whiteBefore,
      ratingAfter: elo.whiteAfter,
      ratingChange: elo.whiteChange,
      createdAt: now
    });
  }
  if (bProf) {
    state.ratingHistories.unshift({
      userId: match.blackPlayerId,
      matchId,
      ratingBefore: elo.blackBefore,
      ratingAfter: elo.blackAfter,
      ratingChange: elo.blackChange,
      createdAt: now
    });
  }

  // Berikan hadiah Coins PlayGo untuk pemenang manusia
  let rewardCoins = 0;
  if (winnerUserId && !isBotUserId(winnerUserId)) {
    rewardCoins = WIN_REWARD_COINS;
    db.awardUserPoints(winnerUserId, WIN_REWARD_COINS);
  } else if (result === '1/2-1/2' && moves.length >= 6) {
    rewardCoins = DRAW_REWARD_COINS;
    if (match.whitePlayerId && !isBotUserId(match.whitePlayerId)) {
      db.awardUserPoints(match.whitePlayerId, DRAW_REWARD_COINS);
    }
    if (match.blackPlayerId && !isBotUserId(match.blackPlayerId)) {
      db.awardUserPoints(match.blackPlayerId, DRAW_REWARD_COINS);
    }
  }
  match.rewardCoins = rewardCoins;

  persistLocalChess();

  const pgWinnerId = winnerUserId && !isBotUserId(winnerUserId) ? winnerUserId : null;

  db.execPgTransaction(async client => {
    await client.query(
      `UPDATE chess_matches
       SET status = 'completed',
           result = $1,
           winner_user_id = $2,
           termination_reason = $3,
           white_remaining_time_ms = $4,
           black_remaining_time_ms = $5,
           current_fen = $6,
           pgn = $7,
           white_rating_before = $8,
           white_rating_after = $9,
           white_rating_change = $10,
           black_rating_before = $11,
           black_rating_after = $12,
           black_rating_change = $13,
           finished_at = $14,
           updated_at = $14
       WHERE id = $15`,
      [
        result,
        pgWinnerId,
        terminationReason,
        match.whiteRemainingTimeMs,
        match.blackRemainingTimeMs,
        match.currentFen,
        match.pgn,
        elo.whiteBefore,
        elo.whiteAfter,
        elo.whiteChange,
        elo.blackBefore,
        elo.blackAfter,
        elo.blackChange,
        now,
        matchId
      ]
    );

    if (wProf) {
      await client.query(
        `INSERT INTO chess_profiles (user_id, rating, highest_rating, total_games, wins, losses, draws, current_streak, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
         ON CONFLICT (user_id) DO UPDATE SET
           rating = EXCLUDED.rating,
           highest_rating = EXCLUDED.highest_rating,
           total_games = EXCLUDED.total_games,
           wins = EXCLUDED.wins,
           losses = EXCLUDED.losses,
           draws = EXCLUDED.draws,
           current_streak = EXCLUDED.current_streak,
           updated_at = EXCLUDED.updated_at`,
        [wProf.userId, wProf.rating, wProf.highestRating, wProf.totalGames, wProf.wins, wProf.losses, wProf.draws, wProf.currentStreak, now]
      );
      await client.query(
        `INSERT INTO chess_rating_histories (user_id, match_id, rating_before, rating_after, rating_change, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [wProf.userId, matchId, elo.whiteBefore, elo.whiteAfter, elo.whiteChange, now]
      );
    }

    if (bProf) {
      await client.query(
        `INSERT INTO chess_profiles (user_id, rating, highest_rating, total_games, wins, losses, draws, current_streak, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
         ON CONFLICT (user_id) DO UPDATE SET
           rating = EXCLUDED.rating,
           highest_rating = EXCLUDED.highest_rating,
           total_games = EXCLUDED.total_games,
           wins = EXCLUDED.wins,
           losses = EXCLUDED.losses,
           draws = EXCLUDED.draws,
           current_streak = EXCLUDED.current_streak,
           updated_at = EXCLUDED.updated_at`,
        [bProf.userId, bProf.rating, bProf.highestRating, bProf.totalGames, bProf.wins, bProf.losses, bProf.draws, bProf.currentStreak, now]
      );
      await client.query(
        `INSERT INTO chess_rating_histories (user_id, match_id, rating_before, rating_after, rating_change, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [bProf.userId, matchId, elo.blackBefore, elo.blackAfter, elo.blackChange, now]
      );
    }
  });

  return match;
}

function cancelMatchRecord(matchId, reason = 'cancelled') {
  const match = state.matches.get(matchId);
  if (!match || match.status === 'completed') return null;
  const now = Date.now();
  match.status = 'cancelled';
  match.terminationReason = reason;
  match.finishedAt = now;
  match.updatedAt = now;
  persistLocalChess();

  db.execPg(
    `UPDATE chess_matches SET status = 'cancelled', termination_reason = $1, finished_at = $2, updated_at = $2 WHERE id = $3`,
    [reason, now, matchId]
  );
  return match;
}

function decorateMatchSummary(m, viewerUserId = null) {
  if (!m) return null;
  const wUser = resolveUserOrBot(m.whitePlayerId, m.whiteRatingBefore);
  const bUser = resolveUserOrBot(m.blackPlayerId, m.blackRatingBefore);
  const moves = state.movesByMatch.get(m.id) || [];

  const isWhite = viewerUserId && m.whitePlayerId === viewerUserId;
  const isBlack = viewerUserId && m.blackPlayerId === viewerUserId;
  const myColor = isWhite ? 'w' : isBlack ? 'b' : null;
  let myOutcome = null;
  let myRatingChange = 0;
  if (myColor && m.status === 'completed') {
    if (m.result === '1/2-1/2') myOutcome = 'draw';
    else if ((myColor === 'w' && m.result === '1-0') || (myColor === 'b' && m.result === '0-1')) myOutcome = 'win';
    else myOutcome = 'loss';
    myRatingChange = myColor === 'w' ? (m.whiteRatingChange || 0) : (m.blackRatingChange || 0);
  }

  const opponentUser = myColor === 'w' ? bUser : myColor === 'b' ? wUser : null;
  const opponentRating = myColor === 'w' ? m.blackRatingBefore : myColor === 'b' ? m.whiteRatingBefore : null;

  const durationMs = m.finishedAt && m.startedAt ? Math.max(0, m.finishedAt - m.startedAt) : 0;

  return {
    id: m.id,
    roomCode: m.roomCode,
    matchType: m.matchType,
    timeControl: m.timeControl,
    initialFen: m.initialFen,
    currentFen: m.currentFen,
    fen: m.currentFen,
    currentTurn: m.currentTurn,
    whiteRemainingTimeMs: m.whiteRemainingTimeMs,
    blackRemainingTimeMs: m.blackRemainingTimeMs,
    incrementSeconds: m.incrementSeconds,
    moveVersion: m.moveVersion,
    moveCount: moves.length,
    movesCount: moves.length,
    status: m.status,
    result: m.result,
    winnerUserId: m.winnerUserId,
    winnerId: m.winnerUserId,
    terminationReason: m.terminationReason,
    resultReason: m.terminationReason,
    rewardCoins: m.rewardCoins || 0,
    whiteRatingBefore: m.whiteRatingBefore,
    whiteRatingAfter: m.whiteRatingAfter,
    whiteRatingChange: m.whiteRatingChange || 0,
    blackRatingBefore: m.blackRatingBefore,
    blackRatingAfter: m.blackRatingAfter,
    blackRatingChange: m.blackRatingChange || 0,
    durationMs,
    durationSeconds: Math.round(durationMs / 1000),
    startedAt: m.startedAt,
    finishedAt: m.finishedAt,
    createdAt: m.createdAt,
    whitePlayer: {
      userId: m.whitePlayerId,
      username: wUser?.username || 'white',
      name: wUser?.name || wUser?.username || 'White',
      avatar: wUser?.avatar || '🎯',
      ratingBefore: m.whiteRatingBefore,
      ratingAfter: m.whiteRatingAfter,
      ratingChange: m.whiteRatingChange || 0
    },
    blackPlayer: {
      userId: m.blackPlayerId,
      username: bUser?.username || 'black',
      name: bUser?.name || bUser?.username || 'Black',
      avatar: bUser?.avatar || '🎯',
      ratingBefore: m.blackRatingBefore,
      ratingAfter: m.blackRatingAfter,
      ratingChange: m.blackRatingChange || 0
    },
    myColor,
    myOutcome,
    myRatingChange,
    opponent: opponentUser
      ? {
          userId: opponentUser.id,
          username: opponentUser.username,
          name: opponentUser.name || opponentUser.username,
          avatar: opponentUser.avatar || '🎯',
          rating: opponentRating || DEFAULT_RATING
        }
      : null
  };
}

function getPlayerMatches(userId, limit = 20) {
  if (!userId) return [];
  const max = Math.min(50, Math.max(1, Number(limit) || 20));
  const list = [];
  for (const m of state.matches.values()) {
    if (m.status !== 'completed') continue;
    if (m.whitePlayerId === userId || m.blackPlayerId === userId) {
      list.push(decorateMatchSummary(m, userId));
    }
  }
  list.sort((a, b) => (b.finishedAt || b.createdAt || 0) - (a.finishedAt || a.createdAt || 0));
  return list.slice(0, max);
}

function getMatchDetail(matchId, viewerUserId = null) {
  const m = state.matches.get(matchId);
  if (!m) return null;
  const moves = state.movesByMatch.get(matchId) || [];
  const summary = decorateMatchSummary(m, viewerUserId);
  return {
    ...summary,
    pgn: m.pgn || generatePgn({
      match: m,
      whiteUser: resolveUserOrBot(m.whitePlayerId, m.whiteRatingBefore),
      blackUser: resolveUserOrBot(m.blackPlayerId, m.blackRatingBefore),
      moves
    }),
    moves
  };
}

function getPlayerRatingHistory(userId, limit = 20) {
  if (!userId) return [];
  return state.ratingHistories
    .filter(h => h.userId === userId)
    .slice(0, Math.min(50, Math.max(1, Number(limit) || 20)));
}

module.exports = {
  DEFAULT_RATING,
  MIN_RATING,
  DEFAULT_K_FACTOR,
  ELO_K_FACTOR: DEFAULT_K_FACTOR,
  WIN_REWARD_COINS,
  DRAW_REWARD_COINS,
  TIME_CONTROLS,
  getTimeControl,
  listTimeControls,
  hydrateFromPostgres,
  calculateEloChanges,
  ensureProfile,
  getPlayerProfile,
  getChessLeaderboard,
  createMatchRecord,
  recordMove,
  finalizeMatchRecord,
  cancelMatchRecord,
  getPlayerMatches,
  getMatchDetail,
  getPlayerRatingHistory,
  generatePgn
};
