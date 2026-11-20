// Penyimpanan & query Monster Quiz Battle: bank soal, katalog monster, riwayat match,
// statistik pemain, dan leaderboard khusus Monster Quiz Battle (terpisah dari statistik Ludo).
// Mendukung PostgreSQL (transaksional via db.execPgTransaction) dan fallback JSON lokal untuk pengujian.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { MONSTERS, BOT_PROFILES, listMonsters, getMonster } = require('./monsters');
const { SEED_QUESTIONS, validateQuestionInput, relatedQuestionIds } = require('./questions');

const LOCAL_QUIZ_FILE = path.join(db.DATA_DIR, 'jakludo-quiz.json');
const MAX_LOCAL_HISTORY = 200;

const state = {
  questions: new Map(),   // questionId -> { id, category, topic, difficulty, prompt, options, correctIndex, active, createdAt, updatedAt }
  stats: new Map(),       // userId -> { userId, matchesPlayed, wins, losses, draws, updatedAt }
  matches: [],            // Array<matchSummary> terbaru di depan (untuk fallback lokal & pembacaan cepat)
  rooms: new Map()        // roomId -> { id, code, createdBy, source, status, createdAt, closedAt }
};

// Status rotasi soal: sudah muncul di siklus ini, berapa kali muncul, dan kapan terakhir muncul
function emptyRotation() {
  return { cycleSeen: false, shownCount: 0, lastShownAt: null };
}

function seedMemoryDefaults() {
  const now = Date.now();
  for (const q of SEED_QUESTIONS) {
    if (!state.questions.has(q.id)) {
      state.questions.set(q.id, {
        id: q.id,
        category: q.category,
        topic: q.topic,
        difficulty: q.difficulty,
        prompt: q.prompt,
        options: [...q.options],
        correctIndex: q.correctIndex,
        active: true,
        ...emptyRotation(),
        createdAt: now,
        updatedAt: now
      });
    }
  }
}

function persistLocalQuiz() {
  if (db.getPool()) return;
  try {
    const customQuestions = Array.from(state.questions.values());
    const dump = {
      questions: customQuestions,
      stats: Array.from(state.stats.values()),
      matches: state.matches.slice(0, MAX_LOCAL_HISTORY)
    };
    fs.writeFileSync(LOCAL_QUIZ_FILE, JSON.stringify(dump));
  } catch (err) {
    console.error('[QUIZ LOCAL]', err.message);
  }
}

function bootstrapLocalQuiz() {
  seedMemoryDefaults();
  if (!fs.existsSync(LOCAL_QUIZ_FILE)) return;
  try {
    const dump = JSON.parse(fs.readFileSync(LOCAL_QUIZ_FILE, 'utf8'));
    for (const q of dump.questions || []) {
      if (q && q.id) {
        state.questions.set(q.id, {
          id: q.id,
          category: q.category,
          topic: q.topic,
          difficulty: q.difficulty || 'easy',
          prompt: q.prompt,
          options: Array.isArray(q.options) ? q.options : [],
          correctIndex: Number(q.correctIndex) || 0,
          active: q.active !== false,
          cycleSeen: q.cycleSeen === true,
          shownCount: Number(q.shownCount) || 0,
          lastShownAt: Number(q.lastShownAt) || null,
          createdAt: Number(q.createdAt) || Date.now(),
          updatedAt: Number(q.updatedAt) || Date.now()
        });
      }
    }
    for (const s of dump.stats || []) {
      if (s && s.userId) {
        state.stats.set(s.userId, {
          userId: s.userId,
          matchesPlayed: Number(s.matchesPlayed) || 0,
          wins: Number(s.wins) || 0,
          losses: Number(s.losses) || 0,
          draws: Number(s.draws) || 0,
          updatedAt: Number(s.updatedAt) || Date.now()
        });
      }
    }
    if (Array.isArray(dump.matches)) {
      state.matches = dump.matches.slice(0, MAX_LOCAL_HISTORY);
    }
  } catch {
    // Abaikan jika file lokal belum valid
  }
}

bootstrapLocalQuiz();

async function hydrateFromPostgres() {
  const pool = db.getPool();
  seedMemoryDefaults();
  if (!pool) return;

  const now = Date.now();

  // 1) Seed katalog monster dan 64 soal awal secara idempoten ke PostgreSQL
  await db.execPgTransaction(async client => {
    for (const m of MONSTERS) {
      await client.query(
        `INSERT INTO quiz_monsters (id, name, element, description, base_hp, sort_order, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           element = EXCLUDED.element,
           description = EXCLUDED.description,
           base_hp = EXCLUDED.base_hp,
           sort_order = EXCLUDED.sort_order,
           active = EXCLUDED.active`,
        [m.id, m.name, m.element, m.description, m.baseHp, m.sortOrder, m.active]
      );
    }

    for (const q of SEED_QUESTIONS) {
      await client.query(
        `INSERT INTO quiz_questions (id, category, topic, difficulty, prompt, options, correct_index, active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, TRUE, $8, $8)
         ON CONFLICT (id) DO NOTHING`,
        [q.id, q.category, q.topic, q.difficulty, q.prompt, JSON.stringify(q.options), q.correctIndex, now]
      );
    }

    // Seed profil akun bot quiz ke tabel users (auth_type = 'bot') agar integritas foreign key terjamin
    for (const b of (BOT_PROFILES || [])) {
      await client.query(
        `INSERT INTO users (id, username, name, password_hash, auth_type, avatar, created_at)
         VALUES ($1, $2, $3, '', 'bot', $4, $5)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, username = EXCLUDED.username, avatar = EXCLUDED.avatar`,
        [b.id, b.username, b.name, b.avatar, now]
      );
    }

    // Tandai room/match yang menggantung akibat restart server sebelumnya
    await client.query(
      `UPDATE quiz_matches
       SET status = 'abandoned', end_reason = 'server_restart', finished_at = $1
       WHERE status = 'in_progress'`,
      [now]
    );
    await client.query(
      `UPDATE quiz_rooms
       SET status = 'closed', closed_at = $1
       WHERE status <> 'closed'`,
      [now]
    );
  });

  // 2) Muat seluruh soal, statistik pemain, dan riwayat pertandingan terakhir dari PostgreSQL
  const [qRes, statsRes, matchesRes] = await Promise.all([
    pool.query('SELECT * FROM quiz_questions ORDER BY id ASC'),
    pool.query('SELECT * FROM quiz_player_stats'),
    pool.query(
      `SELECT
         m.id,
         m.room_id,
         m.status,
         m.winner_user_id,
         m.end_reason,
         m.max_rounds,
         m.rounds_played,
         m.started_at,
         m.finished_at,
         COALESCE(
           json_agg(
             json_build_object(
               'userId', mp.user_id,
               'slot', mp.slot,
               'monsterId', mp.monster_id,
               'startHp', mp.start_hp,
               'currentHp', mp.current_hp,
               'correctAnswers', mp.correct_answers,
               'result', mp.result
             ) ORDER BY mp.slot ASC
           ) FILTER (WHERE mp.user_id IS NOT NULL),
           '[]'::json
         ) AS players
       FROM quiz_matches m
       LEFT JOIN quiz_match_players mp ON mp.match_id = m.id
       WHERE m.status = 'finished'
       GROUP BY m.id
       ORDER BY m.finished_at DESC NULLS LAST
       LIMIT 200`
    )
  ]);

  state.questions.clear();
  seedMemoryDefaults();
  for (const r of qRes.rows) {
    const opts = typeof r.options === 'string' ? JSON.parse(r.options) : r.options;
    state.questions.set(r.id, {
      id: r.id,
      category: r.category,
      topic: r.topic,
      difficulty: r.difficulty,
      prompt: r.prompt,
      options: Array.isArray(opts) ? opts : [],
      correctIndex: Number(r.correct_index),
      active: Boolean(r.active),
      cycleSeen: Boolean(r.cycle_seen),
      shownCount: Number(r.shown_count) || 0,
      lastShownAt: Number(r.last_shown_at) || null,
      createdAt: Number(r.created_at) || now,
      updatedAt: Number(r.updated_at) || now
    });
  }

  state.stats.clear();
  for (const r of statsRes.rows) {
    state.stats.set(r.user_id, {
      userId: r.user_id,
      matchesPlayed: Number(r.matches_played) || 0,
      wins: Number(r.wins) || 0,
      losses: Number(r.losses) || 0,
      draws: Number(r.draws) || 0,
      updatedAt: Number(r.updated_at) || now
    });
  }

  state.matches = matchesRes.rows.map(r => ({
    id: r.id,
    roomId: r.room_id,
    status: r.status,
    winnerUserId: r.winner_user_id || null,
    endReason: r.end_reason || 'knockout',
    maxRounds: Number(r.max_rounds) || 20,
    roundsPlayed: Number(r.rounds_played) || 0,
    startedAt: Number(r.started_at) || now,
    finishedAt: Number(r.finished_at) || now,
    players: Array.isArray(r.players) ? r.players : []
  }));
}

// ==========================================
// MANAJEMEN BANK SOAL (SIAP ADMIN PANEL)
// ==========================================

function listQuestions({ category = null, activeOnly = true, includeAnswer = false } = {}) {
  const result = [];
  for (const q of state.questions.values()) {
    if (activeOnly && !q.active) continue;
    if (category && q.category !== category) continue;
    const item = {
      id: q.id,
      category: q.category,
      topic: q.topic,
      difficulty: q.difficulty,
      prompt: q.prompt,
      options: [...q.options],
      active: q.active,
      cycleSeen: Boolean(q.cycleSeen),
      shownCount: q.shownCount || 0,
      lastShownAt: q.lastShownAt || null,
      createdAt: q.createdAt,
      updatedAt: q.updatedAt
    };
    if (includeAnswer) item.correctIndex = q.correctIndex;
    result.push(item);
  }
  return result;
}

function getQuestionById(id) {
  if (typeof id !== 'string') return null;
  const q = state.questions.get(id);
  return q ? { ...q, options: [...q.options] } : null;
}

function saveQuestion(input) {
  const validation = validateQuestionInput(input);
  if (!validation.valid) return { error: validation.error };
  const now = Date.now();
  const existing = state.questions.get(validation.value.id);
  const row = {
    ...validation.value,
    ...(existing
      ? { cycleSeen: existing.cycleSeen, shownCount: existing.shownCount, lastShownAt: existing.lastShownAt }
      : emptyRotation()),
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now
  };
  state.questions.set(row.id, row);
  persistLocalQuiz();

  db.execPg(
    `INSERT INTO quiz_questions (id, category, topic, difficulty, prompt, options, correct_index, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
     ON CONFLICT (id) DO UPDATE SET
       category = EXCLUDED.category,
       topic = EXCLUDED.topic,
       difficulty = EXCLUDED.difficulty,
       prompt = EXCLUDED.prompt,
       options = EXCLUDED.options,
       correct_index = EXCLUDED.correct_index,
       active = EXCLUDED.active,
       updated_at = EXCLUDED.updated_at`,
    [
      row.id,
      row.category,
      row.topic,
      row.difficulty,
      row.prompt,
      JSON.stringify(row.options),
      row.correctIndex,
      row.active,
      row.createdAt,
      row.updatedAt
    ]
  );

  return { question: { ...row, options: [...row.options] } };
}

function setQuestionActive(id, active) {
  const existing = state.questions.get(id);
  if (!existing) return { error: 'Soal tidak ditemukan.', status: 404 };
  existing.active = Boolean(active);
  existing.updatedAt = Date.now();
  persistLocalQuiz();
  db.execPg('UPDATE quiz_questions SET active = $1, updated_at = $2 WHERE id = $3', [
    existing.active,
    existing.updatedAt,
    existing.id
  ]);
  return { question: { ...existing, options: [...existing.options] } };
}

// Rotasi soal lintas pertandingan: soal yang sudah muncul di siklus ini tetap bisa keluar, tapi
// peluangnya jauh lebih kecil (bobot 1 berbanding 20). Begitu semua soal aktif sekategori sudah
// pernah muncul, tanda siklus kategori itu di-reset sehingga semua soal kembali berpeluang sama.
const UNSEEN_WEIGHT = 20;
const SEEN_WEIGHT = 1;

function pickWeighted(pool) {
  let total = 0;
  for (const q of pool) total += q.cycleSeen ? SEEN_WEIGHT : UNSEEN_WEIGHT;
  let roll = crypto.randomInt(0, total);
  for (const q of pool) {
    roll -= q.cycleSeen ? SEEN_WEIGHT : UNSEEN_WEIGHT;
    if (roll < 0) return q;
  }
  return pool[pool.length - 1];
}

/**
 * Pilih satu soal acak yang belum pernah dipakai di dalam pertandingan ini.
 * Soal yang sudah muncul di pertandingan lain (siklus ini) peluangnya diperkecil.
 * Menyeimbangkan kategori 'general' dan 'math' secara bergantian apabila memungkinkan.
 */
function selectRandomUnusedQuestion(usedIds = new Set(), preferredCategory = null) {
  // Soal yang segrup dengan soal yang sudah keluar di match ini dihindari (lihat RELATED_QUESTION_GROUPS)
  const related = new Set();
  for (const id of usedIds) relatedQuestionIds(id).forEach(r => related.add(r));

  const pickFrom = avoidRelated => {
    const unused = [];
    const unusedPreferred = [];
    for (const q of state.questions.values()) {
      if (!q.active) continue;
      if (usedIds.has(q.id)) continue;
      if (avoidRelated && related.has(q.id)) continue;
      unused.push(q);
      if (preferredCategory && q.category === preferredCategory) {
        unusedPreferred.push(q);
      }
    }
    // Utamakan kategori pilihan; bila soal kategori itu sudah habis, ambil dari kategori mana pun
    return unusedPreferred.length > 0 ? unusedPreferred : unused;
  };

  let pool = pickFrom(true);
  if (pool.length === 0) pool = pickFrom(false);
  if (pool.length === 0) return null;
  const chosen = pickWeighted(pool);
  return { ...chosen, options: [...chosen.options] };
}

// Catat bahwa soal baru saja muncul di sebuah ronde, lalu reset siklus kategori bila semua sudah muncul
function markQuestionShown(questionId, now = Date.now()) {
  const q = state.questions.get(questionId);
  if (!q) return;
  q.cycleSeen = true;
  q.shownCount = (q.shownCount || 0) + 1;
  q.lastShownAt = now;
  db.execPg(
    'UPDATE quiz_questions SET cycle_seen = TRUE, shown_count = shown_count + 1, last_shown_at = $2 WHERE id = $1',
    [q.id, now]
  );

  let allSeen = true;
  for (const other of state.questions.values()) {
    if (other.active && other.category === q.category && !other.cycleSeen) {
      allSeen = false;
      break;
    }
  }
  if (allSeen) {
    for (const other of state.questions.values()) {
      if (other.category === q.category) other.cycleSeen = false;
    }
    db.execPg('UPDATE quiz_questions SET cycle_seen = FALSE WHERE category = $1', [q.category]);
  }
  persistLocalQuiz();
}

// ==========================================
// PERSISTENSI ROOM, MATCH, RONDE & STATISTIK
// ==========================================

function recordRoomCreated({ roomId, code, createdBy, source = 'code', createdAt = Date.now() }) {
  state.rooms.set(roomId, { id: roomId, code, createdBy, source, status: 'open', createdAt, closedAt: null });
  db.execPg(
    `INSERT INTO quiz_rooms (id, code, created_by, source, status, created_at)
     VALUES ($1, $2, $3, $4, 'open', $5)
     ON CONFLICT (id) DO NOTHING`,
    [roomId, code, createdBy || null, source, createdAt]
  );
}

function recordRoomPlayerJoined({ roomId, userId, slot, monsterId = null, joinedAt = Date.now() }) {
  db.execPg(
    `INSERT INTO quiz_room_players (room_id, user_id, slot, monster_id, joined_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (room_id, user_id) DO UPDATE SET
       slot = EXCLUDED.slot,
       monster_id = COALESCE(EXCLUDED.monster_id, quiz_room_players.monster_id),
       left_at = NULL`,
    [roomId, userId, slot, monsterId, joinedAt]
  );
}

function recordRoomPlayerMonster({ roomId, userId, monsterId }) {
  db.execPg(
    `UPDATE quiz_room_players SET monster_id = $1 WHERE room_id = $2 AND user_id = $3`,
    [monsterId, roomId, userId]
  );
}

function recordRoomStatus({ roomId, status, closedAt = null }) {
  const r = state.rooms.get(roomId);
  if (r) {
    r.status = status;
    if (closedAt) r.closedAt = closedAt;
  }
  db.execPg(
    `UPDATE quiz_rooms SET status = $1, closed_at = COALESCE($2, closed_at) WHERE id = $3`,
    [status, closedAt, roomId]
  );
}

function recordMatchStarted({ matchId, roomId, maxRounds, startedAt, players }) {
  db.execPgTransaction(async client => {
    await client.query(
      `INSERT INTO quiz_matches (id, room_id, status, max_rounds, rounds_played, started_at)
       VALUES ($1, $2, 'in_progress', $3, 0, $4)`,
      [matchId, roomId, maxRounds, startedAt]
    );
    for (const p of players) {
      await client.query(
        `INSERT INTO quiz_match_players (match_id, user_id, slot, monster_id, start_hp, current_hp, correct_answers)
         VALUES ($1, $2, $3, $4, $5, $6, 0)`,
        [matchId, p.userId, p.slot, p.monsterId, p.startHp, p.hp]
      );
    }
  });
}

function recordRoundResolved({
  roundId,
  matchId,
  roundNo,
  questionId,
  optionOrder,
  startedAt,
  deadlineAt,
  resolvedAt,
  attackerUserId,
  targetUserId,
  damage,
  answers,
  playerStates
}) {
  db.execPgTransaction(async client => {
    await client.query(
      `INSERT INTO quiz_rounds
        (id, match_id, round_no, question_id, option_order, started_at, deadline_at, resolved_at, attacker_user_id, target_user_id, damage)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (match_id, round_no) DO NOTHING`,
      [
        roundId,
        matchId,
        roundNo,
        questionId,
        JSON.stringify(optionOrder),
        startedAt,
        deadlineAt,
        resolvedAt,
        attackerUserId || null,
        targetUserId || null,
        damage
      ]
    );

    for (const ans of answers) {
      await client.query(
        `INSERT INTO quiz_answers
          (round_id, user_id, selected_index, is_correct, timed_out, answered_at, response_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (round_id, user_id) DO NOTHING`,
        [
          roundId,
          ans.userId,
          ans.selectedIndex ?? null,
          Boolean(ans.isCorrect),
          Boolean(ans.timedOut),
          ans.answeredAt ?? null,
          ans.responseMs ?? null
        ]
      );
    }

    await client.query(
      `UPDATE quiz_matches SET rounds_played = $1 WHERE id = $2`,
      [roundNo, matchId]
    );

    for (const ps of playerStates) {
      await client.query(
        `UPDATE quiz_match_players
         SET current_hp = $1, correct_answers = $2
         WHERE match_id = $3 AND user_id = $4`,
        [ps.hp, ps.correctAnswers, matchId, ps.userId]
      );
    }
  });
}

function recordMatchFinished({
  matchId,
  roomId,
  winnerUserId,
  endReason,
  maxRounds,
  roundsPlayed,
  startedAt,
  finishedAt = Date.now(),
  players
}) {
  const summaryPlayers = players.map(p => {
    let result = 'draw';
    if (p.forfeited) {
      // Keluar/terputus di tengah match selalu dihitung kalah, walaupun hasil akhirnya seri
      result = 'lose';
    } else if (winnerUserId) {
      result = p.userId === winnerUserId ? 'win' : 'lose';
    }
    return {
      userId: p.userId,
      slot: p.slot,
      monsterId: p.monsterId,
      startHp: p.startHp ?? 100,
      currentHp: p.hp,
      correctAnswers: p.correctAnswers || 0,
      result
    };
  });

  // Update in-memory stats untuk masing-masing pemain manusia (terpisah dari leaderboard Ludo!)
  for (const sp of summaryPlayers) {
    if (String(sp.userId).startsWith('bot_')) continue;
    const cur = state.stats.get(sp.userId) || {
      userId: sp.userId,
      matchesPlayed: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      updatedAt: finishedAt
    };
    cur.matchesPlayed += 1;
    if (sp.result === 'win') cur.wins += 1;
    else if (sp.result === 'lose') cur.losses += 1;
    else cur.draws += 1;
    cur.updatedAt = finishedAt;
    state.stats.set(sp.userId, cur);
  }

  const matchRecord = {
    id: matchId,
    roomId,
    status: 'finished',
    winnerUserId: winnerUserId || null,
    endReason,
    maxRounds,
    roundsPlayed,
    startedAt,
    finishedAt,
    players: summaryPlayers
  };

  state.matches.unshift(matchRecord);
  if (state.matches.length > MAX_LOCAL_HISTORY) {
    state.matches.length = MAX_LOCAL_HISTORY;
  }
  persistLocalQuiz();

  db.execPgTransaction(async client => {
    await client.query(
      `UPDATE quiz_matches
       SET status = 'finished',
           winner_user_id = $1,
           end_reason = $2,
           rounds_played = $3,
           finished_at = $4
       WHERE id = $5`,
      [winnerUserId || null, endReason, roundsPlayed, finishedAt, matchId]
    );

    for (const sp of summaryPlayers) {
      await client.query(
        `UPDATE quiz_match_players
         SET current_hp = $1,
             correct_answers = $2,
             result = $3
         WHERE match_id = $4 AND user_id = $5`,
        [sp.currentHp, sp.correctAnswers, sp.result, matchId, sp.userId]
      );

      const deltaWin = sp.result === 'win' ? 1 : 0;
      const deltaLoss = sp.result === 'lose' ? 1 : 0;
      const deltaDraw = sp.result === 'draw' ? 1 : 0;

      // Hanya catat statistik untuk pemain terdaftar asli, bukan bot
      if (!String(sp.userId).startsWith('bot_')) {
        await client.query(
          `INSERT INTO quiz_player_stats (user_id, matches_played, wins, losses, draws, updated_at)
           VALUES ($1, 1, $2, $3, $4, $5)
           ON CONFLICT (user_id) DO UPDATE SET
             matches_played = quiz_player_stats.matches_played + 1,
             wins = quiz_player_stats.wins + EXCLUDED.wins,
             losses = quiz_player_stats.losses + EXCLUDED.losses,
             draws = quiz_player_stats.draws + EXCLUDED.draws,
             updated_at = EXCLUDED.updated_at`,
          [sp.userId, deltaWin, deltaLoss, deltaDraw, finishedAt]
        );
      }
    }
  });

  return matchRecord;
}

// ==========================================
// QUERY STATISTIK, RIWAYAT & LEADERBOARD QUIZ
// ==========================================

function enrichUser(userId) {
  const u = db.getUserById(userId);
  return {
    userId,
    username: u?.username || 'pemain',
    name: u?.name || 'Pemain',
    avatar: u?.avatar || '🎯'
  };
}

function getPlayerStats(userId) {
  const raw = state.stats.get(userId) || {
    userId,
    matchesPlayed: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    updatedAt: null
  };
  const winRate = raw.matchesPlayed > 0 ? Math.round((raw.wins / raw.matchesPlayed) * 100) : 0;
  return {
    ...enrichUser(userId),
    matchesPlayed: raw.matchesPlayed,
    wins: raw.wins,
    losses: raw.losses,
    draws: raw.draws,
    winRate
  };
}

function getPlayerMatchHistory(userId, limit = 20) {
  const cap = Math.max(1, Math.min(50, Number(limit) || 20));
  const list = [];
  for (const m of state.matches) {
    if (m.status !== 'finished') continue;
    const me = m.players.find(p => p.userId === userId);
    if (!me) continue;
    const opp = m.players.find(p => p.userId !== userId) || null;
    const myMonster = getMonster(me.monsterId);
    const oppMonster = opp ? getMonster(opp.monsterId) : null;
    list.push({
      id: m.id,
      finishedAt: new Date(m.finishedAt).toISOString(),
      startedAt: new Date(m.startedAt).toISOString(),
      roundsPlayed: m.roundsPlayed,
      endReason: m.endReason,
      result: me.result,
      me: {
        ...enrichUser(me.userId),
        monsterId: me.monsterId,
        monsterName: myMonster?.name || me.monsterId,
        startHp: me.startHp,
        currentHp: me.currentHp,
        correctAnswers: me.correctAnswers
      },
      opponent: opp
        ? {
            ...enrichUser(opp.userId),
            monsterId: opp.monsterId,
            monsterName: oppMonster?.name || opp.monsterId,
            startHp: opp.startHp,
            currentHp: opp.currentHp,
            correctAnswers: opp.correctAnswers
          }
        : null
    });
    if (list.length >= cap) break;
  }
  return list;
}

function getQuizLeaderboard(limit = 50) {
  const cap = Math.max(1, Math.min(100, Number(limit) || 50));
  const rows = [];
  for (const s of state.stats.values()) {
    if (s.matchesPlayed <= 0) continue;
    const rawUser = db.getUserById(s.userId);
    if (rawUser && db.isUserAdmin(rawUser)) continue;
    const user = enrichUser(s.userId);
    const winRate = Math.round((s.wins / s.matchesPlayed) * 100);
    rows.push({
      ...user,
      matchesPlayed: s.matchesPlayed,
      wins: s.wins,
      losses: s.losses,
      draws: s.draws,
      winRate
    });
  }

  rows.sort(
    (a, b) =>
      b.wins - a.wins ||
      b.winRate - a.winRate ||
      b.matchesPlayed - a.matchesPlayed ||
      a.name.localeCompare(b.name)
  );

  return rows.slice(0, cap).map((r, idx) => ({
    ...r,
    rank: idx + 1
  }));
}

module.exports = {
  hydrateFromPostgres,
  markQuestionShown,
  listMonsters,
  getMonster,
  listQuestions,
  getQuestionById,
  saveQuestion,
  setQuestionActive,
  selectRandomUnusedQuestion,
  recordRoomCreated,
  recordRoomPlayerJoined,
  recordRoomPlayerMonster,
  recordRoomStatus,
  recordMatchStarted,
  recordRoundResolved,
  recordMatchFinished,
  getPlayerStats,
  getPlayerMatchHistory,
  getQuizLeaderboard
};

