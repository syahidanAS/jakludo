'use strict';

const store = require('../game/store');
const quizEngine = require('../quiz/engine');
const chessEngine = require('../chess/engine');
const snakesEngine = require('../snakes/engine');
const { requireAdmin, adminMutationLimiter, asyncRoute, recordAdminAudit } = require('./middleware');

function normalizeLudoRoom(r) {
  const status = r.winner ? 'finished' : r.started ? 'playing' : 'lobby';
  const hasBot = (r.players || []).some(p => p.isBot);
  const roomType = r.groupId ? 'group' : hasBot ? 'bot' : 'private';
  const players = (r.players || []).map(p => ({
    id: p.id,
    userId: p.userId || null,
    username: p.username || null,
    name: p.name || 'Pemain',
    isBot: Boolean(p.isBot),
    connected: Boolean(p.isBot || p.connected),
    color: p.color || null,
    isHost: Boolean(p.isHost),
    isOut: Boolean(p.isOut),
    left: Boolean(p.left)
  }));
  const humans = players.filter(p => !p.isBot);
  return {
    game: 'ludo',
    gameLabel: 'JakLudo',
    code: r.code,
    roomId: r.code,
    status,
    roomType,
    groupId: r.groupId || null,
    playersCount: players.length,
    humansCount: humans.length,
    connectedHumansCount: humans.filter(p => p.connected && !p.left).length,
    botsCount: players.length - humans.length,
    players,
    updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
    createdAt: null,
    progressLabel: r.winner
      ? `Selesai (Pemenang: ${r.winner})`
      : r.started
      ? `Berjalan · Giliran #${Number(r.turn || 0) + 1}`
      : 'Menunggu di Lobby',
    metadata: {
      turn: r.turn,
      dice: r.dice,
      started: Boolean(r.started),
      winner: r.winner || null,
      settings: r.settings || {},
      message: r.message || '',
      recentHistory: (r.history || []).slice(0, 20)
    }
  };
}

function normalizeQuizRoom(r) {
  const status = r.phase === 'finished' ? 'finished' : r.phase === 'lobby' ? 'lobby' : 'playing';
  const players = (r.players || []).map(p => ({
    id: p.userId,
    userId: p.userId,
    username: p.username || null,
    name: p.name || 'Pemain',
    isBot: Boolean(p.isBot),
    connected: Boolean(p.isBot || p.connected),
    hp: p.hp,
    maxHp: p.maxHp,
    monsterId: p.monsterId || null,
    isHost: p.userId === r.hostUserId
  }));
  const humans = players.filter(p => !p.isBot);
  return {
    game: 'quiz',
    gameLabel: 'Monster Quiz',
    code: r.code,
    roomId: r.id || r.code,
    status,
    roomType: r.groupId ? 'group' : r.source || 'private',
    groupId: r.groupId || null,
    playersCount: players.length,
    humansCount: humans.length,
    connectedHumansCount: humans.filter(p => p.connected).length,
    botsCount: players.length - humans.length,
    players,
    updatedAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
    createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
    progressLabel:
      status === 'finished'
        ? 'Pertandingan Selesai'
        : status === 'playing'
        ? `Ronde ${Number(r.match?.roundNumber || 1)} (${r.phase})`
        : 'Menunggu di Lobby',
    metadata: {
      phase: r.phase,
      source: r.source || 'code',
      roundNumber: r.match?.roundNumber || 0,
      matchId: r.match?.id || null
    }
  };
}

function normalizeChessRoom(r) {
  const status = r.phase === 'finished' ? 'finished' : r.phase === 'playing' ? 'playing' : 'lobby';
  const players = (r.players || []).map(p => ({
    id: p.userId,
    userId: p.userId,
    username: p.username || null,
    name: p.name || 'Pemain',
    isBot: Boolean(p.isBot),
    connected: Boolean(p.isBot || p.connected),
    color: p.color || null,
    rating: p.rating || null,
    isHost: p.userId === r.hostUserId
  }));
  const humans = players.filter(p => !p.isBot);
  const movesCount = r.match?.moves?.length || 0;
  return {
    game: 'chess',
    gameLabel: 'Chess Master',
    code: r.code,
    roomId: r.id || r.code,
    status,
    roomType: r.groupId ? 'group' : r.source || 'private',
    groupId: r.groupId || null,
    playersCount: players.length,
    humansCount: humans.length,
    connectedHumansCount: humans.filter(p => p.connected).length,
    botsCount: players.length - humans.length,
    players,
    updatedAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
    createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
    progressLabel:
      status === 'finished'
        ? `Selesai (${movesCount} langkah)`
        : status === 'playing'
        ? `${r.timeControl || '5+0'} · ${movesCount} langkah`
        : `Lobby (${r.timeControl || '5+0'})`,
    metadata: {
      phase: r.phase,
      timeControl: r.timeControl || '5+0',
      source: r.source || 'private',
      movesCount,
      matchId: r.match?.id || null,
      matchStatus: r.match?.status || null
    }
  };
}

function normalizeSnakesRoom(r) {
  const status = r.status === 'finished' ? 'finished' : r.status === 'playing' ? 'playing' : 'lobby';
  const players = (r.players || []).map(p => {
    const isBot = p.player_type === 'bot';
    return {
      id: p.id || p.user_id,
      userId: isBot ? null : p.user_id || null,
      username: p.username || null,
      name: p.name || 'Pemain',
      isBot,
      connected: isBot ? true : p.connected !== false,
      color: p.color || null,
      position: Number(p.position || 0),
      isHost: Boolean(p.user_id && p.user_id === r.hostUserId)
    };
  });
  const humans = players.filter(p => !p.isBot);
  return {
    game: 'snakes',
    gameLabel: 'Ular Tangga',
    code: r.code,
    roomId: r.id || r.code,
    status,
    roomType: r.groupId ? 'group' : r.roomType || 'private',
    groupId: r.groupId || null,
    playersCount: players.length,
    humansCount: humans.length,
    connectedHumansCount: humans.filter(p => p.connected).length,
    botsCount: players.length - humans.length,
    players,
    updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
    createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
    progressLabel:
      status === 'finished'
        ? `Selesai (${Number(r.turnNumber || 0)} giliran)`
        : status === 'playing'
        ? `Giliran #${Number(r.turnNumber || 1)}`
        : `Lobby (Max ${Number(r.maxPlayers || 4)} pemain)`,
    metadata: {
      roomType: r.roomType || 'private',
      maxPlayers: r.maxPlayers || 4,
      turnNumber: r.turnNumber || 0,
      lastRoll: r.lastRoll || null,
      recentMoves: (r.moveLog || []).slice(-20)
    }
  };
}

function collectAllActiveRooms() {
  const all = [
    ...Array.from(store.rooms.values()).map(normalizeLudoRoom),
    ...Array.from(quizEngine.quizRooms.values()).map(normalizeQuizRoom),
    ...Array.from(chessEngine.chessRooms.values()).map(normalizeChessRoom),
    ...Array.from(snakesEngine.snakesRooms.values()).map(normalizeSnakesRoom)
  ];
  all.sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));
  return all;
}

function summarizeActiveRooms(roomsList = collectAllActiveRooms()) {
  const byGame = { ludo: 0, quiz: 0, chess: 0, snakes: 0 };
  const byStatus = { lobby: 0, playing: 0, finished: 0 };
  let totalPlayers = 0;
  let totalHumans = 0;
  let totalConnectedHumans = 0;
  let totalBots = 0;

  for (const r of roomsList) {
    if (byGame[r.game] !== undefined) byGame[r.game]++;
    if (byStatus[r.status] !== undefined) byStatus[r.status]++;
    totalPlayers += r.playersCount;
    totalHumans += r.humansCount;
    totalConnectedHumans += r.connectedHumansCount;
    totalBots += r.botsCount;
  }

  return {
    totalRooms: roomsList.length,
    totalPlayers,
    totalHumans,
    totalConnectedHumans,
    totalBots,
    byGame,
    byStatus,
    matchmakingQueues: {
      quiz: quizEngine.matchmakingQueue?.size || 0,
      chess: chessEngine.matchmakingQueue?.size || 0,
      snakes: snakesEngine.matchmakingQueue?.size || 0
    },
    serverUptimeSec: Math.floor(process.uptime()),
    memoryRssMb: Math.round(process.memoryUsage().rss / 1048576),
    generatedAt: new Date().toISOString()
  };
}

function findActiveRoomForUser(userId) {
  if (!userId) return null;
  const all = collectAllActiveRooms();
  return all.find(r => r.players.some(p => !p.isBot && p.userId === userId)) || null;
}

function registerAdminRoomRoutes(router) {
  router.get('/admin/rooms', asyncRoute(async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const allRooms = collectAllActiveRooms();
    const gameFilter = String(req.query?.game || 'all').trim().toLowerCase();
    const statusFilter = String(req.query?.status || 'all').trim().toLowerCase();
    const q = String(req.query?.q || '').trim().toLowerCase();

    const filtered = allRooms.filter(r => {
      if (gameFilter !== 'all' && r.game !== gameFilter) return false;
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (q) {
        const matchCode = r.code.toLowerCase().includes(q);
        const matchPlayer = r.players.some(
          p =>
            String(p.name || '').toLowerCase().includes(q) ||
            String(p.username || '').toLowerCase().includes(q)
        );
        if (!matchCode && !matchPlayer) return false;
      }
      return true;
    });

    res.json({
      success: true,
      rooms: filtered,
      summary: summarizeActiveRooms(allRooms)
    });
  }));

  router.get('/admin/rooms/:game/:code', asyncRoute(async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const game = String(req.params.game || '').trim().toLowerCase();
    const code = String(req.params.code || '').trim().toUpperCase();
    const room = collectAllActiveRooms().find(r => r.game === game && r.code.toUpperCase() === code);
    if (!room) {
      return res.status(404).json({ success: false, error: `Room ${game}/${code} tidak ditemukan atau sudah ditutup.` });
    }
    res.json({ success: true, room });
  }));

  router.post('/admin/rooms/:game/:code/close', adminMutationLimiter, asyncRoute(async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const game = String(req.params.game || '').trim().toLowerCase();
    const code = String(req.params.code || '').trim().toUpperCase();
    const reason = String(req.body?.reason || '').trim() || `Room ditutup paksa oleh Admin (@${admin.username}).`;

    let closedOk = false;
    let errMsg = '';

    if (game === 'ludo') {
      const targetRoom = store.rooms.get(code);
      if (!targetRoom) {
        errMsg = 'Room JakLudo tidak ditemukan.';
      } else {
        store.deleteRoom(targetRoom, reason);
        closedOk = true;
      }
    } else if (game === 'quiz') {
      const result = quizEngine.adminCloseRoom(code, reason);
      closedOk = Boolean(result.ok);
      errMsg = result.error || '';
    } else if (game === 'chess') {
      const result = chessEngine.adminCloseRoom(code, reason);
      closedOk = Boolean(result.ok);
      errMsg = result.error || '';
    } else if (game === 'snakes') {
      const result = snakesEngine.adminCloseRoom(code, reason);
      closedOk = Boolean(result.ok);
      errMsg = result.error || '';
    } else {
      return res.status(400).json({ success: false, error: 'Tipe game tidak dikenal.' });
    }

    if (!closedOk) {
      return res.status(404).json({ success: false, error: errMsg || 'Room tidak ditemukan.' });
    }

    recordAdminAudit({
      adminUser: admin,
      action: 'ROOM_FORCE_CLOSE',
      targetType: `room:${game}`,
      targetId: code,
      summary: `Menutup room ${game.toUpperCase()} #${code} (${reason})`,
      meta: { game, code, reason }
    });

    res.json({
      success: true,
      game,
      code,
      message: `Room ${game.toUpperCase()} #${code} berhasil ditutup.`
    });
  }));
}

module.exports = {
  collectAllActiveRooms,
  summarizeActiveRooms,
  findActiveRoomForUser,
  registerAdminRoomRoutes
};
