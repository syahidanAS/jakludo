// REST API untuk Chess Master (PlayGo):
// - Profil & Rating Elo (/api/chess/profile)
// - Leaderboard Elo (/api/chess/leaderboard)
// - Riwayat Pertandingan (/api/chess/matches)
// - Matchmaking & Private Room (/api/chess/matchmaking, /api/chess/rooms, /api/chess/rooms/join)
// - Aksi Pertandingan (/api/chess/matches/:id/moves, resign, draw, rematch, history, pgn)
const db = require('../db');
const store = require('../game/store');
const chessStore = require('./store');
const chessEngine = require('./engine');
const { createLimiter } = require('../lib/limiter');

const chessActionLimiter = createLimiter({ windowMs: 60 * 1000, max: 120 });

function bearerToken(req) {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
}

function optionalUser(req) {
  const token = bearerToken(req) || String(req.body?.token || req.query?.token || '');
  return token ? db.getUserByToken(token) : null;
}

function requireUser(req, res, message = 'Silakan login terlebih dahulu.') {
  const user = optionalUser(req);
  if (!user) res.status(401).json({ success: false, error: message });
  return user;
}

function registerChessRoutes(api) {
  // Daftar kontrol waktu yang didukung (Bullet, Blitz, Rapid)
  api.get('/chess/time-controls', (req, res) => {
    res.json({
      success: true,
      timeControls: chessStore.listTimeControls()
    });
  });

  // Profil & statistik rating Elo pemain
  api.get('/chess/profile', (req, res) => {
    const targetUserId = typeof req.query.userId === 'string' && req.query.userId.trim()
      ? req.query.userId.trim()
      : null;

    if (targetUserId) {
      const targetUser = db.getUserById(targetUserId);
      if (!targetUser) {
        return res.status(404).json({ success: false, error: 'Pemain tidak ditemukan.' });
      }
      const matches = chessStore.getPlayerMatches(targetUser.id, Number(req.query.limit) || 15);
      return res.json({
        success: true,
        profile: chessStore.getPlayerProfile(targetUser.id),
        matches,
        recentMatches: matches,
        ratingHistory: chessStore.getPlayerRatingHistory(targetUser.id, 20)
      });
    }

    const user = requireUser(req, res);
    if (!user) return;
    const matches = chessStore.getPlayerMatches(user.id, Number(req.query.limit) || 20);
    res.json({
      success: true,
      profile: chessStore.getPlayerProfile(user.id),
      matches,
      recentMatches: matches,
      ratingHistory: chessStore.getPlayerRatingHistory(user.id, 20)
    });
  });

  // Leaderboard khusus Chess Master (diurutkan berdasarkan Elo Rating)
  api.get('/chess/leaderboard', (req, res) => {
    const viewer = optionalUser(req);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const page = Math.max(1, Number(req.query.page) || 1);
    const lb = chessStore.getChessLeaderboard({
      limit,
      page,
      viewerUserId: viewer?.id || null
    });
    res.json({
      success: true,
      leaderboard: lb.items,
      entries: lb.items,
      page: lb.page,
      limit: lb.limit,
      total: lb.total,
      totalPages: lb.totalPages,
      pagination: {
        page: lb.page,
        limit: lb.limit,
        total: lb.total,
        totalPages: lb.totalPages
      },
      myEntry: lb.myEntry
    });
  });

  // Riwayat pertandingan pemain yang sedang login
  api.get('/chess/matches', (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    res.json({
      success: true,
      matches: chessStore.getPlayerMatches(user.id, limit)
    });
  });

  // Cek room aktif milik pemain untuk keperluan reconnect
  api.get('/chess/active-room', (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    res.json({
      success: true,
      room: chessEngine.getActiveRoomForUser(user.id)
    });
  });

  // Masuk antrean Quick Matchmaking
  api.post('/chess/matchmaking', (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (!chessActionLimiter(user.id)) {
      return res.status(429).json({ success: false, error: 'Terlalu banyak permintaan dalam waktu singkat.' });
    }
    const token = bearerToken(req) || req.body?.token;
    const result = chessEngine.joinMatchmaking(null, { ...req.body, token }, store.rooms);
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, ...result });
  });

  // Keluar dari antrean Quick Matchmaking
  api.delete('/chess/matchmaking', (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const token = bearerToken(req) || req.body?.token;
    const result = chessEngine.leaveMatchmaking(null, { token });
    res.json({ success: true, ...result });
  });

  // Main langsung melawan Bot (AI)
  api.post('/chess/bot', (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (!chessActionLimiter(user.id)) {
      return res.status(429).json({ success: false, error: 'Terlalu banyak permintaan dalam waktu singkat.' });
    }
    const token = bearerToken(req) || req.body?.token;
    const result = chessEngine.playVsBot(null, { ...req.body, token }, store.rooms);
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, ...result });
  });

  // Buat Private Room
  api.post('/chess/rooms', (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (!chessActionLimiter(user.id)) {
      return res.status(429).json({ success: false, error: 'Terlalu banyak permintaan dalam waktu singkat.' });
    }
    const token = bearerToken(req) || req.body?.token;
    const result = chessEngine.createRoom(null, { ...req.body, token }, store.rooms);
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, ...result });
  });

  // Gabung ke Private Room menggunakan kode
  api.post('/chess/rooms/join', (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (!chessActionLimiter(user.id)) {
      return res.status(429).json({ success: false, error: 'Terlalu banyak permintaan dalam waktu singkat.' });
    }
    const token = bearerToken(req) || req.body?.token;
    const result = chessEngine.joinRoom(null, { ...req.body, token });
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, ...result });
  });

  // Detail pertandingan (aktif maupun selesai)
  api.get('/chess/matches/:id', (req, res) => {
    const viewer = optionalUser(req);
    const matchId = String(req.params.id || '').trim();
    const detail = chessStore.getMatchDetail(matchId, viewer?.id || null);
    if (!detail) {
      return res.status(404).json({ success: false, error: 'Pertandingan tidak ditemukan.' });
    }
    const liveRoom = chessEngine.getRoomByMatchId(matchId, viewer?.id || null);
    res.json({
      success: true,
      match: detail,
      room: liveRoom || null
    });
  });

  // Kirim langkah catur via HTTP (mendukung REST selain WebSocket)
  api.post('/chess/matches/:id/moves', (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (!chessActionLimiter(user.id)) {
      return res.status(429).json({ success: false, error: 'Terlalu banyak permintaan langkah.' });
    }
    const token = bearerToken(req) || req.body?.token;
    const result = chessEngine.submitMove(null, {
      ...req.body,
      matchId: req.params.id,
      token
    });
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, ...result });
  });

  // Menyerah (Resign)
  api.post('/chess/matches/:id/resign', (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const token = bearerToken(req) || req.body?.token;
    const result = chessEngine.resignMatch(null, { matchId: req.params.id, token });
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, ...result });
  });

  // Tawarkan Remis (Offer Draw)
  api.post('/chess/matches/:id/draw', (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const token = bearerToken(req) || req.body?.token;
    const result = chessEngine.offerDraw(null, { matchId: req.params.id, token });
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, ...result });
  });

  // Terima Remis (Accept Draw)
  api.post('/chess/matches/:id/draw/accept', (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const token = bearerToken(req) || req.body?.token;
    const result = chessEngine.acceptDraw(null, { matchId: req.params.id, token });
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, ...result });
  });

  // Tolak Remis (Decline Draw)
  api.post('/chess/matches/:id/draw/decline', (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const token = bearerToken(req) || req.body?.token;
    const result = chessEngine.declineDraw(null, { matchId: req.params.id, token });
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, ...result });
  });

  // Minta / Terima Rematch
  api.post('/chess/matches/:id/rematch', (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const token = bearerToken(req) || req.body?.token;
    const result = chessEngine.requestRematch(null, { matchId: req.params.id, token });
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, ...result });
  });

  // Riwayat langkah untuk Replay
  api.get('/chess/matches/:id/history', (req, res) => {
    const viewer = optionalUser(req);
    const detail = chessStore.getMatchDetail(req.params.id, viewer?.id || null);
    if (!detail) {
      return res.status(404).json({ success: false, error: 'Pertandingan tidak ditemukan.' });
    }
    res.json({
      success: true,
      matchId: detail.id,
      initialFen: detail.initialFen,
      currentFen: detail.currentFen,
      result: detail.result,
      terminationReason: detail.terminationReason,
      moves: detail.moves
    });
  });

  // Ekspor PGN standar
  api.get('/chess/matches/:id/pgn', (req, res) => {
    const viewer = optionalUser(req);
    const detail = chessStore.getMatchDetail(req.params.id, viewer?.id || null);
    if (!detail) {
      return res.status(404).json({ success: false, error: 'Pertandingan tidak ditemukan.' });
    }
    if (req.query.format === 'json') {
      return res.json({
        success: true,
        matchId: detail.id,
        pgn: detail.pgn
      });
    }
    res.setHeader('Content-Type', 'application/x-chess-pgn; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="playgo-chess-${detail.id}.pgn"`);
    return res.send(detail.pgn);
  });
}

module.exports = { registerChessRoutes };
