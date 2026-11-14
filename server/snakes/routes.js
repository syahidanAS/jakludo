// REST API untuk Snakes and Ladders / Ular Tangga (PlayGo):
// Mendukung prefix standar /api/games/snakes-and-ladders/* dan alias pendek /api/snakes/*
const db = require('../db');
const store = require('../game/store');
const snakesConfig = require('./config');
const snakesStore = require('./store');
const snakesEngine = require('./engine');
const { createLimiter } = require('../lib/limiter');

const snakesActionLimiter = createLimiter({ windowMs: 60 * 1000, max: 120 });
const snakesRollLimiter = createLimiter({ windowMs: 3 * 1000, max: 10 });

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

function registerSnakesRoutes(api) {
  const prefixes = ['/games/snakes-and-ladders', '/snakes'];

  for (const prefix of prefixes) {
    // Info konfigurasi papan & aturan
    api.get(`${prefix}/config`, (req, res) => {
      res.json({
        success: true,
        gameId: snakesConfig.GAME_ID,
        name: snakesConfig.GAME_NAME,
        displayName: snakesConfig.GAME_DISPLAY_NAME,
        boardSize: snakesConfig.BOARD_SIZE,
        gridSize: snakesConfig.GRID_SIZE,
        ladders: snakesConfig.LADDERS,
        snakes: snakesConfig.SNAKES,
        timings: snakesEngine.getTimings()
      });
    });

    // Statistik profil & riwayat pemain
    api.get(`${prefix}/profile`, (req, res) => {
      const targetUserId = typeof req.query.userId === 'string' && req.query.userId.trim()
        ? req.query.userId.trim()
        : null;

      if (targetUserId) {
        const targetUser = db.getUserById(targetUserId);
        if (!targetUser) {
          return res.status(404).json({ success: false, error: 'Pemain tidak ditemukan.' });
        }
        const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
        return res.json({
          success: true,
          stats: snakesStore.getPlayerStats(targetUser.id),
          history: snakesStore.getPlayerHistory(targetUser.id, limit)
        });
      }

      const user = requireUser(req, res);
      if (!user) return;
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
      res.json({
        success: true,
        stats: snakesStore.getPlayerStats(user.id),
        history: snakesStore.getPlayerHistory(user.id, limit)
      });
    });

    // Riwayat pertandingan
    api.get(`${prefix}/history`, (req, res) => {
      const user = requireUser(req, res);
      if (!user) return;
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
      res.json({
        success: true,
        stats: snakesStore.getPlayerStats(user.id),
        history: snakesStore.getPlayerHistory(user.id, limit)
      });
    });

    // Leaderboard kompetitif (hanya pertandingan vs manusia; bot tidak pernah masuk leaderboard)
    api.get(`${prefix}/leaderboard`, (req, res) => {
      const viewer = optionalUser(req);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
      const page = Math.max(1, Number(req.query.page) || 1);
      const lb = snakesStore.getSnakesLeaderboard({
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
        myEntry: lb.myEntry
      });
    });

    // Cek room aktif milik pemain
    api.get(`${prefix}/active-room`, (req, res) => {
      const user = requireUser(req, res);
      if (!user) return;
      res.json({
        success: true,
        room: snakesEngine.getActiveRoomForUser(user.id)
      });
    });

    // Mulai pencarian lawan (Quick Matchmaking: Human First, 15s Bot Fallback)
    api.post(`${prefix}/matchmaking`, (req, res) => {
      const user = requireUser(req, res);
      if (!user) return;
      if (!snakesActionLimiter(user.id)) {
        return res.status(429).json({ success: false, error: 'Terlalu banyak permintaan dalam waktu singkat.' });
      }
      const token = bearerToken(req) || req.body?.token;
      const result = snakesEngine.joinMatchmaking(null, { ...req.body, token }, store.rooms);
      if (!result.ok) return res.status(400).json({ success: false, error: result.error, code: result.code, roomCode: result.roomCode, room: result.room });
      res.json({ success: true, ...result });
    });

    // Batalkan pencarian lawan
    const handleCancelMatchmaking = (req, res) => {
      const user = requireUser(req, res);
      if (!user) return;
      const token = bearerToken(req) || req.body?.token;
      const result = snakesEngine.cancelMatchmaking(null, { token });
      res.json({ success: true, ...result });
    };
    api.post(`${prefix}/matchmaking/cancel`, handleCancelMatchmaking);
    api.delete(`${prefix}/matchmaking`, handleCancelMatchmaking);

    // Buat Private Room
    api.post(`${prefix}/rooms`, (req, res) => {
      const user = requireUser(req, res);
      if (!user) return;
      if (!snakesActionLimiter(user.id)) {
        return res.status(429).json({ success: false, error: 'Terlalu banyak permintaan dalam waktu singkat.' });
      }
      const token = bearerToken(req) || req.body?.token;
      const result = snakesEngine.createPrivateRoom(null, { ...req.body, token }, store.rooms);
      if (!result.ok) return res.status(400).json({ success: false, error: result.error });
      res.json({ success: true, ...result });
    });

    // Bergabung ke Private Room menggunakan kode
    api.post(`${prefix}/rooms/join`, (req, res) => {
      const user = requireUser(req, res);
      if (!user) return;
      if (!snakesActionLimiter(user.id)) {
        return res.status(429).json({ success: false, error: 'Terlalu banyak permintaan dalam waktu singkat.' });
      }
      const token = bearerToken(req) || req.body?.token;
      const result = snakesEngine.joinPrivateRoom(null, { ...req.body, token });
      if (!result.ok) return res.status(400).json({ success: false, error: result.error });
      res.json({ success: true, ...result });
    });

    // Ambil state room pertandingan berdasarkan roomId atau roomCode
    api.get(`${prefix}/rooms/:roomId`, (req, res) => {
      const user = requireUser(req, res);
      if (!user) return;
      const roomId = String(req.params.roomId || '').trim();
      const roomState = snakesEngine.getRoomStateForUser(roomId, user.id);
      if (!roomState) {
        return res.status(404).json({ success: false, error: 'Room pertandingan tidak ditemukan.' });
      }
      // Hanya izinkan peserta room yang melihat detail state aktif
      const isParticipant = (roomState.players || []).some(
        p => (p.player_type === 'human' || p.playerType === 'human') && (p.user_id === user.id || p.userId === user.id)
      );
      if (!isParticipant) {
        return res.status(403).json({ success: false, error: 'Kamu tidak memiliki akses ke room ini.' });
      }
      res.json({
        success: true,
        room: roomState
      });
    });

    // Host memulai Private Room
    api.post(`${prefix}/rooms/:roomId/start`, (req, res) => {
      const user = requireUser(req, res);
      if (!user) return;
      const token = bearerToken(req) || req.body?.token;
      const result = snakesEngine.startPrivateRoom(null, {
        ...req.body,
        roomId: req.params.roomId,
        code: req.params.roomId,
        token
      });
      if (!result.ok) return res.status(400).json({ success: false, error: result.error });
      res.json({ success: true, ...result });
    });

    // Lempar dadu (Roll Dice)
    api.post(`${prefix}/rooms/:roomId/roll`, (req, res) => {
      const user = requireUser(req, res);
      if (!user) return;
      if (!snakesRollLimiter(user.id)) {
        return res.status(429).json({ success: false, error: 'Terlalu cepat menekan tombol dadu. Tunggu sebentar.' });
      }
      const token = bearerToken(req) || req.body?.token;
      const result = snakesEngine.handleRollDice(null, {
        ...req.body,
        roomId: req.params.roomId,
        token
      });
      if (!result.ok) return res.status(400).json({ success: false, error: result.error });
      res.json({ success: true, ...result });
    });

    // Main Lagi (Rematch)
    api.post(`${prefix}/rooms/:roomId/rematch`, (req, res) => {
      const user = requireUser(req, res);
      if (!user) return;
      const token = bearerToken(req) || req.body?.token;
      const result = snakesEngine.requestRematch(null, {
        ...req.body,
        roomId: req.params.roomId,
        token
      });
      if (!result.ok) return res.status(400).json({ success: false, error: result.error });
      res.json({ success: true, ...result });
    });
  }
}

module.exports = { registerSnakesRoutes };

