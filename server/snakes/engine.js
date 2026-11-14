// Engine Otoritatif & Smart Matchmaking Service untuk Snakes and Ladders / Ular Tangga (PlayGo).
// Mengelola:
// - Human-first Smart Matchmaking dengan 15 detik Bot Fallback transparan ("Pemain Komputer")
// - Private Room dengan kode unik 5 karakter
// - Server-authoritative Dice Roll (CSPRNG), Pergerakan Bidak, Tangga, Ular, Pantulan >100
// - Bot Game Logic otomatis dengan jeda natural 1–2 detik & proteksi anti-hang
// - Sinkronisasi Realtime Socket.IO, Reconnection, Chat Ruangan, dan Emoticon Reaction
const crypto = require('crypto');
const db = require('../db');
const { EMOJIS, MAX_CHATS } = require('../game/config');
const snakesConfig = require('./config');
const snakesRules = require('./rules');
const snakesStore = require('./store');

const DEFAULT_TIMINGS = {
  humanSearchTimeoutMs: snakesConfig.HUMAN_SEARCH_TIMEOUT_MS,
  botFallbackEnabled: snakesConfig.BOT_FALLBACK_ENABLED,
  queueExpiryMs: snakesConfig.MATCHMAKING_QUEUE_EXPIRY_MS,
  turnTimeoutMs: snakesConfig.TURN_TIMEOUT_MS,
  botActionDelayMinMs: snakesConfig.BOT_ACTION_DELAY_MIN_MS,
  botActionDelayMaxMs: snakesConfig.BOT_ACTION_DELAY_MAX_MS,
  disconnectGraceMs: snakesConfig.DISCONNECT_GRACE_MS,
  lobbyExpireMs: snakesConfig.LOBBY_EXPIRE_MS
};

let timings = { ...DEFAULT_TIMINGS };

function setTimings(overrides = {}) {
  timings = { ...DEFAULT_TIMINGS, ...overrides };
}

function getTimings() {
  return { ...timings };
}

let ioInstance = null;

// State aktif di memori
const snakesRooms = new Map();        // roomCode -> RoomObject
const roomsById = new Map();          // roomId -> RoomObject
const userActiveRoom = new Map();     // userId -> roomCode
const matchmakingQueue = new Map();   // userId -> QueueEntry
const matchmakingTimers = new Map();  // userId -> { fallbackTimer, expiryTimer }

// Antrean dadu deterministik khusus pengujian unit (tidak pernah dapat diakses dari request klien)
let testDiceQueue = [];

function setTestDiceSequence(seq = []) {
  testDiceQueue = Array.isArray(seq) ? [...seq] : [];
}

function nextDiceValue() {
  if (testDiceQueue.length > 0) {
    const val = Number(testDiceQueue.shift());
    if (Number.isInteger(val) && val >= 1 && val <= 6) return val;
  }
  return snakesRules.rollSecureDice();
}

function init(io) {
  ioInstance = io;
}

function socketRoomName(code) {
  return `snakes:${code}`;
}

function clearMatchmakingTimers(userId) {
  const t = matchmakingTimers.get(userId);
  if (t) {
    if (t.fallbackTimer) clearTimeout(t.fallbackTimer);
    if (t.expiryTimer) clearTimeout(t.expiryTimer);
    matchmakingTimers.delete(userId);
  }
}

function generateRoomCode(existingLudoRooms = null) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 120; attempt++) {
    let code = '';
    for (let i = 0; i < 5; i++) {
      code += chars[crypto.randomInt(0, chars.length)];
    }
    if (!snakesRooms.has(code) && (!existingLudoRooms || !existingLudoRooms.has(code))) {
      return code;
    }
  }
  return `S${Date.now().toString(36).slice(-4).toUpperCase()}`;
}

function resolveUser(socket, payload = {}) {
  const token = payload?.token || socket?.handshake?.auth?.token || socket?.data?.token || '';
  if (token) {
    const u = db.getUserByToken(token);
    if (u) {
      if (socket) {
        socket.data.userId = u.id;
        socket.data.token = token;
      }
      return u;
    }
  }
  if (socket?.data?.userId) {
    return db.getUserById(socket.data.userId);
  }
  return null;
}

function findPlayerSocket(userId, fallbackSocketId = null) {
  if (!ioInstance) return null;
  if (fallbackSocketId) {
    const byId = ioInstance.of('/').sockets.get(fallbackSocketId);
    if (byId && byId.connected) return byId;
  }
  if (!userId) return null;
  for (const [, sock] of ioInstance.of('/').sockets) {
    if (sock.data?.userId === userId) return sock;
  }
  return null;
}

function emitToRoom(room, event, payload) {
  if (!ioInstance || !room) return;
  ioInstance.to(socketRoomName(room.code)).emit(event, payload);
}

function emitToUser(userId, event, payload, directSocket = null) {
  if (directSocket && directSocket.connected) {
    directSocket.emit(event, payload);
    return;
  }
  if (!ioInstance || !userId) return;
  const sock = findPlayerSocket(userId);
  if (sock) {
    sock.emit(event, payload);
  } else {
    ioInstance.to(`user:${userId}`).emit(event, payload);
  }
}

function serializePlayer(p) {
  return {
    id: p.id,
    player_type: p.player_type,
    playerType: p.player_type,
    user_id: p.player_type === 'bot' ? null : p.user_id,
    userId: p.player_type === 'bot' ? null : p.user_id,
    bot_id: p.player_type === 'bot' ? p.bot_id || 'default-bot' : null,
    botId: p.player_type === 'bot' ? p.bot_id || 'default-bot' : null,
    display_name: p.display_name,
    name: p.display_name,
    username: p.player_type === 'bot' ? null : p.username,
    avatar: p.player_type === 'bot' ? null : p.avatar,
    isBot: p.player_type === 'bot',
    difficulty: p.difficulty || null,
    player_order: p.player_order,
    playerOrder: p.player_order,
    position: Number(p.position) || 0,
    color: p.color,
    status: p.status || 'active',
    autoTimeoutCount: Number(p.autoTimeoutCount) || 0,
    ready: Boolean(p.ready),
    connected: p.player_type === 'bot' ? true : Boolean(p.connected),
    disconnectedAt: p.disconnectedAt || null,
    graceEndsAt: p.graceEndsAt || null
  };
}

function serializeRoomForUser(room, viewerUserId = null) {
  if (!room) return null;
  const now = Date.now();
  const players = (room.players || []).map(serializePlayer);
  const currentTurnPlayer = players[room.turnIndex] || null;
  const myPlayer = viewerUserId
    ? players.find(p => p.player_type === 'human' && p.user_id === viewerUserId)
    : null;

  const hasBotOpponent = players.some(p => p.player_type === 'bot');
  const opponentType = hasBotOpponent ? 'bot' : 'human';
  const remainingTurnMs = room.turnDeadlineAt ? Math.max(0, room.turnDeadlineAt - now) : timings.turnTimeoutMs;

  return {
    id: room.id,
    gameId: snakesConfig.GAME_ID,
    code: room.code,
    roomCode: room.code,
    roomType: room.roomType,
    groupId: room.groupId || null,
    hostUserId: room.hostUserId,
    maxPlayers: room.maxPlayers || snakesConfig.MAX_PLAYERS,
    status: room.status, // 'waiting' | 'playing' | 'finished'
    phase: room.phase,   // 'lobby' | 'playing' | 'finished'
    finishReason: room.finishReason || null,
    opponentType,
    turnIndex: room.turnIndex,
    turnNumber: room.turnNumber || 0,
    currentTurn: currentTurnPlayer ? currentTurnPlayer.id : null,
    currentTurnPlayerId: currentTurnPlayer ? currentTurnPlayer.id : null,
    currentTurnUserId: currentTurnPlayer ? currentTurnPlayer.user_id : null,
    currentTurnPlayer,
    isMyTurn: Boolean(
      room.status === 'playing' &&
      myPlayer &&
      currentTurnPlayer &&
      currentTurnPlayer.id === myPlayer.id
    ),
    turnClock: room.status === 'playing'
      ? {
          id: `${room.id}_turn_${room.turnNumber}_${room.turnIndex}`,
          remainingMs: remainingTurnMs,
          totalMs: timings.turnTimeoutMs,
          deadlineAt: room.turnDeadlineAt
        }
      : null,
    lastRoll: room.lastRoll || null,
    moveLog: (room.moveLog || []).slice(-25),
    players,
    myPlayerId: myPlayer?.id || null,
    myColor: myPlayer?.color || null,
    winnerPlayerId: room.winnerPlayerId || null,
    winnerUserId: room.winnerUserId || null,
    winner: room.winner || null,
    durationSeconds: room.finishedAt && room.startedAt
      ? Math.max(1, Math.round((room.finishedAt - room.startedAt) / 1000))
      : 0,
    rewardCoins: room.rewardCoins || 0,
    rematchVotes: Array.from(room.rematchVotes || []),
    chats: Array.isArray(room.chats) ? room.chats : [],
    boardConfig: {
      size: snakesConfig.BOARD_SIZE,
      gridSize: snakesConfig.GRID_SIZE,
      ladders: snakesConfig.LADDERS,
      snakes: snakesConfig.SNAKES
    },
    startedAt: room.startedAt || null,
    finishedAt: room.finishedAt || null,
    serverNow: now
  };
}

function emitRoomState(room) {
  if (!ioInstance || !room) return;
  for (const p of room.players || []) {
    if (p.player_type !== 'human' || !p.user_id) continue;
    const sock = findPlayerSocket(p.user_id, p.socketId);
    if (sock) {
      sock.emit('snakes:room:state', serializeRoomForUser(room, p.user_id));
    }
  }
}

function clearRoomTimers(room) {
  if (!room) return;
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  if (room.botTimer) {
    clearTimeout(room.botTimer);
    room.botTimer = null;
  }
  if (room.botWatchdogTimer) {
    clearTimeout(room.botWatchdogTimer);
    room.botWatchdogTimer = null;
  }
  if (room.lobbyExpireTimer) {
    clearTimeout(room.lobbyExpireTimer);
    room.lobbyExpireTimer = null;
  }
  for (const p of room.players || []) {
    if (p.disconnectTimer) {
      clearTimeout(p.disconnectTimer);
      p.disconnectTimer = null;
    }
  }
}

function scheduleLobbyExpiration(room) {
  if (!room) return;
  if (room.lobbyExpireTimer) clearTimeout(room.lobbyExpireTimer);
  room.lobbyExpireTimer = setTimeout(() => {
    if (room.status === 'waiting') {
      closeRoom(room, 'Room Ular Tangga ditutup karena tidak aktif.');
    }
  }, timings.lobbyExpireMs);
  if (room.lobbyExpireTimer.unref) room.lobbyExpireTimer.unref();
}

function closeRoom(room, reason = 'Room ditutup.') {
  if (!room) return;
  clearRoomTimers(room);
  emitToRoom(room, 'snakes:room:closed', { roomId: room.id, roomCode: room.code, reason });
  for (const p of room.players || []) {
    if (p.player_type === 'human' && p.user_id) {
      if (userActiveRoom.get(p.user_id) === room.code) {
        userActiveRoom.delete(p.user_id);
      }
      const sock = findPlayerSocket(p.user_id);
      if (sock) {
        sock.leave(socketRoomName(room.code));
        if (sock.data?.snakesRoom === room.code) delete sock.data.snakesRoom;
      }
    }
  }
  roomsById.delete(room.id);
  snakesRooms.delete(room.code);
}

// ==========================================
// GAME FLOW: START, TURN TIMER, BOT LOGIC, ROLL DICE, FINISH
// ==========================================

function startGameInRoom(room) {
  if (!room || room.players.length < 2) return null;
  if (room.lobbyExpireTimer) {
    clearTimeout(room.lobbyExpireTimer);
    room.lobbyExpireTimer = null;
  }

  const now = Date.now();
  // Reset posisi semua pemain ke 0 (belum masuk papan)
  room.players.forEach((p, idx) => {
    p.player_order = idx;
    p.playerOrder = idx;
    p.position = 0;
    p.color = snakesConfig.PLAYER_COLORS[idx % snakesConfig.PLAYER_COLORS.length];
    p.status = 'active';
    p.autoTimeoutCount = 0;
    p.ready = true;
  });

  // Penentuan giliran pertama secara acak di backend
  const firstTurnIdx = snakesRules.determineFirstTurnIndex(room.players.length);
  const firstPlayer = room.players[firstTurnIdx];

  room.status = 'playing';
  room.phase = 'playing';
  room.turnIndex = firstTurnIdx;
  room.turnNumber = 1;
  room.currentTurnPlayerId = firstPlayer.id;
  room.winnerPlayerId = null;
  room.winnerUserId = null;
  room.winner = null;
  room.finishReason = null;
  room.consecutiveSixes = 0;
  room.lastRoll = null;
  room.moveLog = [];
  room.rematchVotes = new Set();
  room.historyRecorded = false;
  room.rollingLock = false;
  room.startedAt = now;
  room.finishedAt = null;
  room.updatedAt = now;

  snakesStore.saveRoomAndPlayers(room);

  const startedPayload = {
    roomId: room.id,
    roomCode: room.code,
    roomType: room.roomType,
    status: 'playing',
    firstTurnPlayerId: firstPlayer.id,
    firstTurnUserId: firstPlayer.user_id || null,
    firstTurnIndex: firstTurnIdx,
    players: room.players.map(serializePlayer),
    startedAt: now,
    serverNow: now
  };

  emitToRoom(room, 'game.started', startedPayload);
  scheduleTurnTimerAndBot(room);
  emitRoomState(room);
  return room;
}

function scheduleTurnTimerAndBot(room) {
  if (!room || room.status !== 'playing') return;

  if (room.turnTimer) clearTimeout(room.turnTimer);
  if (room.botTimer) clearTimeout(room.botTimer);
  if (room.botWatchdogTimer) clearTimeout(room.botWatchdogTimer);

  const currentPlayer = room.players[room.turnIndex];
  if (!currentPlayer) return;

  const now = Date.now();
  room.turnDeadlineAt = now + timings.turnTimeoutMs;
  room.currentTurnPlayerId = currentPlayer.id;

  emitToRoom(room, 'game.turn_changed', {
    roomId: room.id,
    roomCode: room.code,
    turnIndex: room.turnIndex,
    turnNumber: room.turnNumber,
    currentPlayerId: currentPlayer.id,
    currentUserId: currentPlayer.user_id || null,
    currentPlayerType: currentPlayer.player_type,
    currentDisplayName: currentPlayer.display_name,
    deadlineAt: room.turnDeadlineAt,
    remainingMs: timings.turnTimeoutMs,
    serverNow: now
  });

  if (currentPlayer.player_type === 'bot') {
    const minDelay = Math.max(20, Number(timings.botActionDelayMinMs) || 1000);
    const maxDelay = Math.max(minDelay, Number(timings.botActionDelayMaxMs) || 2000);
    let delay = minDelay === maxDelay
      ? minDelay
      : crypto.randomInt(minDelay, maxDelay + 1);
    if (minDelay >= 500 && room.lastAnimDelayMs) {
      delay = Math.max(delay, room.lastAnimDelayMs);
    }
    room.lastAnimDelayMs = 0;

    const expectedTurnNumber = room.turnNumber;
    room.botTimer = setTimeout(() => {
      executeBotTurn(room, expectedTurnNumber);
    }, delay);
    if (room.botTimer.unref) room.botTimer.unref();

    // Watchdog anti-hang: jika bot gagal bertindak karena kendala tak terduga, coba ulang / fallback
    room.botWatchdogTimer = setTimeout(() => {
      if (room.status === 'playing' && room.turnNumber === expectedTurnNumber) {
        const cur = room.players[room.turnIndex];
        if (cur && cur.player_type === 'bot') {
          executeBotTurn(room, expectedTurnNumber, true);
        }
      }
    }, delay + 2500);
    if (room.botWatchdogTimer.unref) room.botWatchdogTimer.unref();
  } else {
    // Turn timeout untuk pemain manusia: otomatis lempar dadu agar permainan tidak macet
    const expectedTurnNumber = room.turnNumber;
    room.turnTimer = setTimeout(() => {
      if (room.status !== 'playing' || room.turnNumber !== expectedTurnNumber) return;
      const cur = room.players[room.turnIndex];
      if (!cur || cur.player_type !== 'human') return;
      executeAuthoritativeRoll(room, cur, { isAutoTimeout: true });
    }, timings.turnTimeoutMs);
    if (room.turnTimer.unref) room.turnTimer.unref();
  }
}

function executeBotTurn(room, expectedTurnNumber, isRetry = false) {
  if (!room || room.status !== 'playing') return;
  if (typeof expectedTurnNumber === 'number' && room.turnNumber !== expectedTurnNumber) return;

  const currentPlayer = room.players[room.turnIndex];
  if (!currentPlayer || currentPlayer.player_type !== 'bot') return;

  try {
    room.rollingLock = false;
    executeAuthoritativeRoll(room, currentPlayer, { isBotAction: true });
  } catch (err) {
    console.error('[SNAKES BOT ERROR]', err);
    room.rollingLock = false;
    if (!isRetry) {
      // Retry sekali secara aman
      try {
        executeAuthoritativeRoll(room, currentPlayer, { isBotAction: true });
      } catch (retryErr) {
        console.error('[SNAKES BOT RETRY FAILED]', retryErr);
        // Jangan biarkan giliran terkunci selamanya: geser giliran ke pemain berikutnya
        advanceTurn(room);
      }
    } else {
      advanceTurn(room);
    }
  }
}

function advanceTurn(room) {
  if (!room || room.status !== 'playing') return;
  room.consecutiveSixes = 0;
  const total = room.players.length;
  let nextIdx = snakesRules.getNextTurnIndex(room.turnIndex, total);
  for (let i = 0; i < total; i++) {
    if (room.players[nextIdx]?.status === 'active') break;
    nextIdx = snakesRules.getNextTurnIndex(nextIdx, total);
  }
  room.turnIndex = nextIdx;
  room.turnNumber = (Number(room.turnNumber) || 1) + 1;
  room.currentTurnPlayerId = room.players[room.turnIndex]?.id || null;
  room.updatedAt = Date.now();
  snakesStore.saveRoomAndPlayers(room);
  scheduleTurnTimerAndBot(room);
  emitRoomState(room);
}

function grantExtraTurn(room) {
  if (!room || room.status !== 'playing') return;
  room.turnNumber = (Number(room.turnNumber) || 1) + 1;
  room.currentTurnPlayerId = room.players[room.turnIndex]?.id || null;
  room.updatedAt = Date.now();
  snakesStore.saveRoomAndPlayers(room);
  scheduleTurnTimerAndBot(room);
  emitRoomState(room);
}

function executeAuthoritativeRoll(room, actingPlayer, options = {}) {
  if (!room || room.status !== 'playing') {
    return { ok: false, error: 'Pertandingan sudah selesai atau belum dimulai.' };
  }
  const currentPlayer = room.players[room.turnIndex];
  if (!currentPlayer || currentPlayer.id !== actingPlayer.id) {
    return { ok: false, error: 'Bukan giliranmu saat ini.' };
  }
  if (room.rollingLock) {
    return { ok: false, error: 'Lemparan dadu sedang diproses.' };
  }

  room.rollingLock = true;
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  if (room.botTimer) {
    clearTimeout(room.botTimer);
    room.botTimer = null;
  }
  if (room.botWatchdogTimer) {
    clearTimeout(room.botWatchdogTimer);
    room.botWatchdogTimer = null;
  }

  try {
    const now = Date.now();

    if (options.isAutoTimeout) {
      currentPlayer.autoTimeoutCount = (Number(currentPlayer.autoTimeoutCount) || 0) + 1;
      if (currentPlayer.autoTimeoutCount >= 3) {
        currentPlayer.status = 'eliminated';
        room.updatedAt = now;
        emitToRoom(room, 'game.player_afk_out', {
          roomId: room.id,
          roomCode: room.code,
          playerId: currentPlayer.id,
          userId: currentPlayer.user_id || null,
          displayName: currentPlayer.username || currentPlayer.display_name,
          autoTimeoutCount: currentPlayer.autoTimeoutCount,
          serverNow: now
        });

        const remainingActive = room.players.filter(p => p.id !== currentPlayer.id && p.status === 'active');
        room.rollingLock = false;
        if (remainingActive.length <= 1) {
          finishGameInRoom(room, remainingActive[0] || null, 'afk_timeout_3');
          return {
            ok: true,
            finished: true,
            afkOut: true,
            room: serializeRoomForUser(room, currentPlayer.user_id)
          };
        }
        advanceTurn(room);
        return {
          ok: true,
          finished: false,
          afkOut: true,
          room: serializeRoomForUser(room, currentPlayer.user_id)
        };
      }
    } else if (currentPlayer.player_type === 'human') {
      currentPlayer.autoTimeoutCount = 0;
    }

    const dice = nextDiceValue();
    const outcome = snakesRules.calculateTurnOutcome({
      currentPosition: currentPlayer.position,
      dice,
      consecutiveSixes: room.consecutiveSixes || 0,
      ladders: snakesConfig.LADDERS,
      snakes: snakesConfig.SNAKES
    });

    currentPlayer.position = outcome.finalPosition;
    room.consecutiveSixes = outcome.consecutiveSixes;
    room.lastAnimDelayMs = outcome.threeSixesSkip || outcome.overshoot
      ? 900
      : 280 + (outcome.stepPath?.length || 1) * 450 + (outcome.ladder || outcome.snake ? 1100 : 350);
    room.updatedAt = now;

    const rollInfo = {
      id: `roll_${now}_${room.turnNumber}`,
      turnNumber: room.turnNumber,
      playerId: currentPlayer.id,
      userId: currentPlayer.user_id || null,
      playerType: currentPlayer.player_type,
      displayName: currentPlayer.display_name,
      color: currentPlayer.color,
      dice: outcome.dice,
      from: outcome.from,
      stepTo: outcome.stepTo,
      to: outcome.finalPosition,
      moved: outcome.moved,
      overshoot: outcome.overshoot,
      threeSixesSkip: outcome.threeSixesSkip,
      extraTurn: outcome.extraTurn,
      stepPath: outcome.stepPath,
      ladder: outcome.ladder,
      snake: outcome.snake,
      isWin: outcome.isWin,
      isAutoTimeout: Boolean(options.isAutoTimeout),
      autoTimeoutCount: Number(currentPlayer.autoTimeoutCount) || 0,
      timestamp: now
    };

    room.lastRoll = rollInfo;
    room.moveLog.push(rollInfo);
    if (room.moveLog.length > 50) room.moveLog.shift();

    // 1. Event dadu dilempar
    emitToRoom(room, 'game.dice_rolled', {
      roomId: room.id,
      roomCode: room.code,
      playerId: currentPlayer.id,
      userId: currentPlayer.user_id || null,
      playerType: currentPlayer.player_type,
      displayName: currentPlayer.display_name,
      dice: outcome.dice,
      turnNumber: room.turnNumber,
      serverNow: now
    });

    // 2. Event pergerakan bidak
    emitToRoom(room, 'game.player_moved', {
      roomId: room.id,
      roomCode: room.code,
      playerId: currentPlayer.id,
      userId: currentPlayer.user_id || null,
      playerType: currentPlayer.player_type,
      displayName: currentPlayer.display_name,
      color: currentPlayer.color,
      dice: outcome.dice,
      from: outcome.from,
      stepTo: outcome.stepTo,
      to: outcome.finalPosition,
      moved: outcome.moved,
      overshoot: outcome.overshoot,
      threeSixesSkip: outcome.threeSixesSkip,
      extraTurn: outcome.extraTurn,
      stepPath: outcome.stepPath,
      ladder: outcome.ladder,
      snake: outcome.snake,
      serverNow: now
    });

    // 3. Event tangga / ular jika terpicu
    if (outcome.ladder) {
      emitToRoom(room, 'game.ladder_triggered', {
        roomId: room.id,
        roomCode: room.code,
        playerId: currentPlayer.id,
        userId: currentPlayer.user_id || null,
        playerType: currentPlayer.player_type,
        displayName: currentPlayer.display_name,
        from: outcome.ladder.from,
        to: outcome.ladder.to,
        serverNow: now
      });
    } else if (outcome.snake) {
      emitToRoom(room, 'game.snake_triggered', {
        roomId: room.id,
        roomCode: room.code,
        playerId: currentPlayer.id,
        userId: currentPlayer.user_id || null,
        playerType: currentPlayer.player_type,
        displayName: currentPlayer.display_name,
        from: outcome.snake.from,
        to: outcome.snake.to,
        serverNow: now
      });
    }

    // 4. Cek apakah pemain mencapai kotak 100 (Menang)
    if (outcome.isWin) {
      room.rollingLock = false;
      finishGameInRoom(room, currentPlayer, 'reached_100');
      return {
        ok: true,
        roll: rollInfo,
        finished: true,
        room: serializeRoomForUser(room, currentPlayer.user_id)
      };
    }

    room.rollingLock = false;
    if (outcome.extraTurn) {
      grantExtraTurn(room);
    } else {
      advanceTurn(room);
    }

    return {
      ok: true,
      roll: rollInfo,
      finished: false,
      room: serializeRoomForUser(room, currentPlayer.user_id)
    };
  } catch (err) {
    room.rollingLock = false;
    throw err;
  }
}

function finishGameInRoom(room, winnerPlayer, reason = 'reached_100') {
  if (!room || room.status === 'finished') return room;

  clearRoomTimers(room);
  const now = Date.now();
  room.status = 'finished';
  room.phase = 'finished';
  room.finishedAt = now;
  room.updatedAt = now;
  room.winnerPlayerId = winnerPlayer ? winnerPlayer.id : null;
  room.winnerUserId = winnerPlayer && winnerPlayer.player_type === 'human' ? winnerPlayer.user_id : null;
  room.winner = winnerPlayer ? serializePlayer(winnerPlayer) : null;
  room.finishReason = reason;

  const historyRecords = snakesStore.recordCompletedMatch(room);
  const winnerRec = historyRecords.find(r => r.result === 'win');
  room.rewardCoins = winnerRec ? winnerRec.rewardCoins : 0;

  const hasBotOpponent = room.players.some(p => p.player_type === 'bot');
  const opponentType = hasBotOpponent ? 'bot' : 'human';
  const durationSeconds = room.startedAt ? Math.max(1, Math.round((now - room.startedAt) / 1000)) : 1;

  const wonPayload = {
    roomId: room.id,
    roomCode: room.code,
    winnerPlayerId: room.winnerPlayerId,
    winnerUserId: room.winnerUserId,
    winner: room.winner,
    opponentType,
    reason,
    durationSeconds,
    totalTurns: room.turnNumber,
    rewardCoins: room.rewardCoins,
    finishedAt: now,
    serverNow: now
  };

  emitToRoom(room, 'game.player_won', wonPayload);
  emitToRoom(room, 'game.finished', {
    ...wonPayload,
    players: room.players.map(serializePlayer)
  });
  emitRoomState(room);

  if (ioInstance && opponentType === 'human') {
    ioInstance.emit('snakes:leaderboard:update', snakesStore.getSnakesLeaderboard({ limit: 50, page: 1 }));
  }

  return room;
}

// ==========================================
// SMART MATCHMAKING: HUMAN FIRST, BOT FALLBACK (15s)
// ==========================================

function createRoomInstance({
  roomType = 'quick',
  hostUserId,
  players = [],
  maxPlayers = snakesConfig.MAX_PLAYERS,
  groupId = null,
  existingLudoRooms = null
}) {
  const now = Date.now();
  const code = generateRoomCode(existingLudoRooms);
  const room = {
    id: `snk_room_${now}_${crypto.randomBytes(4).toString('hex')}`,
    gameId: snakesConfig.GAME_ID,
    code,
    roomType,
    groupId,
    hostUserId,
    maxPlayers,
    status: 'waiting',
    phase: 'lobby',
    turnIndex: 0,
    turnNumber: 0,
    currentTurnPlayerId: null,
    winnerPlayerId: null,
    winnerUserId: null,
    winner: null,
    lastRoll: null,
    moveLog: [],
    chats: [],
    rematchVotes: new Set(),
    players,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null
  };

  snakesRooms.set(code, room);
  roomsById.set(room.id, room);
  for (const p of players) {
    if (p.player_type === 'human' && p.user_id) {
      userActiveRoom.set(p.user_id, code);
      const sock = findPlayerSocket(p.user_id, p.socketId);
      if (sock) {
        sock.join(socketRoomName(code));
        sock.data.snakesRoom = code;
      }
    }
  }

  snakesStore.saveRoomAndPlayers(room);

  emitToRoom(room, 'game.room_created', {
    roomId: room.id,
    roomCode: room.code,
    roomType: room.roomType,
    players: room.players.map(serializePlayer),
    serverNow: now
  });

  return room;
}

function triggerBotFallbackForUser(userId, existingLudoRooms = null) {
  clearMatchmakingTimers(userId);
  const qEntry = matchmakingQueue.get(userId);
  if (!qEntry) return null;

  matchmakingQueue.delete(userId);

  // Jangan jalankan fallback bot jika pemain sudah dipasangkan ke room aktif
  if (userActiveRoom.has(userId)) {
    snakesStore.updateQueueEntryStatus(qEntry.id, 'matched');
    return null;
  }

  const user = db.getUserById(userId);
  if (!user) {
    snakesStore.updateQueueEntryStatus(qEntry.id, 'cancelled');
    return null;
  }

  snakesStore.updateQueueEntryStatus(qEntry.id, 'bot_fallback');

  const humanPlayer = snakesConfig.createHumanPlayerRecord(user, {
    order: 0,
    color: snakesConfig.PLAYER_COLORS[0],
    socketId: qEntry.socketId,
    ready: true
  });
  const botPlayer = snakesConfig.createBotPlayerRecord({
    order: 1,
    color: snakesConfig.PLAYER_COLORS[1],
    difficulty: 'easy'
  });

  const room = createRoomInstance({
    roomType: 'quick',
    hostUserId: user.id,
    players: [humanPlayer, botPlayer],
    maxPlayers: 2,
    existingLudoRooms
  });

  const sock = findPlayerSocket(user.id);
  emitToUser(
    user.id,
    'matchmaking.bot_fallback',
    {
      roomId: room.id,
      roomCode: room.code,
      message: 'Lawan ditemukan!',
      opponent: serializePlayer(botPlayer),
      serverNow: Date.now()
    },
    sock
  );

  startGameInRoom(room);
  return room;
}

function joinMatchmaking(socket, payload = {}, existingLudoRooms = null) {
  const user = resolveUser(socket, payload);
  if (!user) {
    return { ok: false, error: 'Silakan login terlebih dahulu untuk bermain Ular Tangga.' };
  }

  // 1. Cek apakah user sedang berada di pertandingan aktif
  const activeCode = userActiveRoom.get(user.id);
  if (activeCode) {
    const activeRoom = snakesRooms.get(activeCode);
    if (activeRoom && activeRoom.status !== 'finished' && activeRoom.status !== 'cancelled') {
      return {
        ok: false,
        error: 'Kamu sedang berada dalam pertandingan yang masih berlangsung.',
        code: 'ALREADY_IN_GAME',
        roomCode: activeRoom.code,
        roomId: activeRoom.id,
        room: serializeRoomForUser(activeRoom, user.id)
      };
    }
    userActiveRoom.delete(user.id);
  }

  // 2. Cek apakah user sudah berada di antrean matchmaking aktif (cegah antrean ganda)
  if (matchmakingQueue.has(user.id)) {
    const existingQ = matchmakingQueue.get(user.id);
    if (socket) {
      existingQ.socketId = socket.id;
    }
    return {
      ok: true,
      searching: true,
      alreadyQueued: true,
      queueId: existingQ.id,
      timeoutSeconds: Math.round(timings.humanSearchTimeoutMs / 1000),
      queuedAt: existingQ.queuedAt
    };
  }

  const now = Date.now();

  // 3. Bersihkan antrean yang sudah kedaluwarsa atau yang sudah memiliki room aktif
  for (const [qUserId, entry] of matchmakingQueue.entries()) {
    if (qUserId === user.id) continue;
    if (entry.expiresAt <= now || userActiveRoom.has(qUserId)) {
      clearMatchmakingTimers(qUserId);
      matchmakingQueue.delete(qUserId);
      snakesStore.updateQueueEntryStatus(entry.id, entry.expiresAt <= now ? 'expired' : 'matched');
      continue;
    }
    if (ioInstance && entry.socketId) {
      const s = findPlayerSocket(qUserId);
      if (!s || !s.connected) {
        clearMatchmakingTimers(qUserId);
        matchmakingQueue.delete(qUserId);
        snakesStore.updateQueueEntryStatus(entry.id, 'cancelled');
      }
    }
  }

  // 4. Cari kandidat pemain manusia pertama yang sedang menunggu di antrean (FIFO)
  let candidateEntry = null;
  for (const [qUserId, entry] of matchmakingQueue.entries()) {
    if (qUserId === user.id) continue;
    const candidateUser = db.getUserById(qUserId);
    if (!candidateUser) {
      clearMatchmakingTimers(qUserId);
      matchmakingQueue.delete(qUserId);
      continue;
    }
    candidateEntry = { entry, user: candidateUser };
    break;
  }

  // 5. Jika ditemukan pemain manusia, pasangkan secara atomik dan batalkan timer fallback bot!
  if (candidateEntry) {
    const { entry: otherQ, user: otherUser } = candidateEntry;
    clearMatchmakingTimers(otherUser.id);
    clearMatchmakingTimers(user.id);
    matchmakingQueue.delete(otherUser.id);
    matchmakingQueue.delete(user.id);

    snakesStore.updateQueueEntryStatus(otherQ.id, 'matched');
    const myQ = snakesStore.recordQueueEntry({
      userId: user.id,
      status: 'matched',
      queuedAt: now,
      expiresAt: now + timings.queueExpiryMs
    });

    const p1 = snakesConfig.createHumanPlayerRecord(otherUser, {
      order: 0,
      color: snakesConfig.PLAYER_COLORS[0],
      socketId: otherQ.socketId,
      ready: true
    });
    const p2 = snakesConfig.createHumanPlayerRecord(user, {
      order: 1,
      color: snakesConfig.PLAYER_COLORS[1],
      socketId: socket?.id || null,
      ready: true
    });

    const room = createRoomInstance({
      roomType: 'quick',
      hostUserId: otherUser.id,
      players: [p1, p2],
      maxPlayers: 2,
      existingLudoRooms
    });

    if (socket) {
      socket.join(socketRoomName(room.code));
      socket.data.snakesRoom = room.code;
    }

    const otherSock = findPlayerSocket(otherUser.id);
    emitToUser(
      otherUser.id,
      'matchmaking.human_found',
      {
        roomId: room.id,
        roomCode: room.code,
        message: 'Lawan ditemukan!',
        opponent: serializePlayer(p2),
        serverNow: now
      },
      otherSock
    );
    emitToUser(
      user.id,
      'matchmaking.human_found',
      {
        roomId: room.id,
        roomCode: room.code,
        message: 'Lawan ditemukan!',
        opponent: serializePlayer(p1),
        serverNow: now
      },
      socket
    );

    startGameInRoom(room);

    return {
      ok: true,
      matched: true,
      searching: false,
      opponentType: 'human',
      queueId: myQ.id,
      roomId: room.id,
      roomCode: room.code,
      room: serializeRoomForUser(room, user.id)
    };
  }

  // 6. Belum ada manusia lain di antrean: masukkan ke matchmakingQueue dan pasang timer 15 detik
  const queueRecord = snakesStore.recordQueueEntry({
    userId: user.id,
    status: 'searching',
    queuedAt: now,
    expiresAt: now + timings.queueExpiryMs
  });

  const qObj = {
    id: queueRecord.id,
    userId: user.id,
    socketId: socket?.id || null,
    queuedAt: now,
    expiresAt: now + timings.queueExpiryMs
  };
  matchmakingQueue.set(user.id, qObj);

  const timers = { fallbackTimer: null, expiryTimer: null };

  if (timings.botFallbackEnabled) {
    timers.fallbackTimer = setTimeout(() => {
      triggerBotFallbackForUser(user.id, existingLudoRooms);
    }, timings.humanSearchTimeoutMs);
    if (timers.fallbackTimer.unref) timers.fallbackTimer.unref();
  }

  timers.expiryTimer = setTimeout(() => {
    const cur = matchmakingQueue.get(user.id);
    if (cur && cur.id === qObj.id) {
      clearMatchmakingTimers(user.id);
      matchmakingQueue.delete(user.id);
      snakesStore.updateQueueEntryStatus(qObj.id, 'expired');
      emitToUser(user.id, 'matchmaking.cancelled', {
        reason: 'expired',
        message: 'Waktu pencarian lawan habis.'
      });
    }
  }, timings.queueExpiryMs);
  if (timers.expiryTimer.unref) timers.expiryTimer.unref();

  matchmakingTimers.set(user.id, timers);

  const searchingPayload = {
    queueId: qObj.id,
    status: 'searching',
    message: 'Mencari lawan...',
    subMessage: 'Memprioritaskan pemain online',
    timeoutSeconds: Math.round(timings.humanSearchTimeoutMs / 1000),
    queuedAt: now,
    serverNow: now
  };

  emitToUser(user.id, 'matchmaking.searching', searchingPayload, socket);

  return {
    ok: true,
    matched: false,
    searching: true,
    ...searchingPayload
  };
}

function cancelMatchmaking(socket, payload = {}) {
  const user = resolveUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu.' };

  clearMatchmakingTimers(user.id);
  const qEntry = matchmakingQueue.get(user.id);
  matchmakingQueue.delete(user.id);

  if (qEntry) {
    snakesStore.updateQueueEntryStatus(qEntry.id, 'cancelled');
  }

  emitToUser(
    user.id,
    'matchmaking.cancelled',
    {
      queueId: qEntry?.id || null,
      reason: 'user_cancelled',
      message: 'Pencarian lawan dibatalkan.',
      serverNow: Date.now()
    },
    socket
  );

  return { ok: true, cancelled: Boolean(qEntry) };
}

// ==========================================
// PRIVATE ROOM (CREATE, JOIN, START)
// ==========================================

function createPrivateRoom(socket, payload = {}, existingLudoRooms = null) {
  const user = resolveUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu untuk membuat Private Room.' };

  // Batalkan antrean matchmaking jika sedang mengantre
  cancelMatchmaking(socket, payload);

  const prevCode = userActiveRoom.get(user.id);
  if (prevCode) {
    const prevRoom = snakesRooms.get(prevCode);
    if (prevRoom && prevRoom.status === 'playing') {
      return {
        ok: false,
        error: 'Kamu masih berada di dalam pertandingan aktif.',
        roomCode: prevRoom.code,
        room: serializeRoomForUser(prevRoom, user.id)
      };
    }
    if (prevRoom) leaveRoom(socket, payload);
  }

  const groupId = typeof payload?.groupId === 'string' && payload.groupId.trim() ? payload.groupId.trim() : null;
  if (groupId) {
    const social = require('../social/store');
    if (!social.isGroupMember(groupId, user.id)) {
      return { ok: false, error: 'Kamu bukan anggota grup ini.' };
    }
  }

  const maxPlayers = Math.min(
    snakesConfig.MAX_PRIVATE_ROOM_PLAYERS,
    Math.max(2, Number(payload.maxPlayers) || snakesConfig.MAX_PRIVATE_ROOM_PLAYERS)
  );

  const hostPlayer = snakesConfig.createHumanPlayerRecord(user, {
    order: 0,
    color: snakesConfig.PLAYER_COLORS[0],
    socketId: socket?.id || null,
    ready: true
  });

  const room = createRoomInstance({
    roomType: groupId ? 'group' : 'private',
    hostUserId: user.id,
    players: [hostPlayer],
    maxPlayers,
    groupId,
    existingLudoRooms
  });

  if (socket) {
    socket.join(socketRoomName(room.code));
    socket.data.snakesRoom = room.code;
  }

  if (groupId) {
    const social = require('../social/store');
    social.postGroupMatchMessage(groupId, user.id, room.code, 'snakes').catch(err => {
      console.error('[snakes] postGroupMatchMessage failed:', err.message);
    });
  }

  scheduleLobbyExpiration(room);
  emitRoomState(room);

  return {
    ok: true,
    roomId: room.id,
    roomCode: room.code,
    room: serializeRoomForUser(room, user.id)
  };
}

function joinPrivateRoom(socket, payload = {}) {
  const user = resolveUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu.' };

  const rawCode = String(payload.code || payload.roomCode || payload.roomId || '').trim();
  if (!rawCode) return { ok: false, error: 'Kode room wajib diisi.' };

  const room = snakesRooms.get(rawCode.toUpperCase()) || roomsById.get(rawCode);
  if (!room) return { ok: false, error: 'Room tidak ditemukan atau sudah ditutup.' };

  // Cek apakah pemain merupakan anggota room yang sedang reconnect
  const existingPlayer = room.players.find(p => p.player_type === 'human' && p.user_id === user.id);
  if (existingPlayer) {
    const wasDisconnected = !existingPlayer.connected;
    existingPlayer.connected = true;
    existingPlayer.status = 'active';
    existingPlayer.disconnectedAt = null;
    existingPlayer.graceEndsAt = null;
    existingPlayer.socketId = socket?.id || existingPlayer.socketId;
    if (existingPlayer.disconnectTimer) {
      clearTimeout(existingPlayer.disconnectTimer);
      existingPlayer.disconnectTimer = null;
    }

    userActiveRoom.set(user.id, room.code);
    if (socket) {
      socket.join(socketRoomName(room.code));
      socket.data.snakesRoom = room.code;
    }

    if (wasDisconnected) {
      emitToRoom(room, 'game.player_reconnected', {
        roomId: room.id,
        roomCode: room.code,
        playerId: existingPlayer.id,
        userId: user.id,
        displayName: existingPlayer.display_name,
        serverNow: Date.now()
      });
    }

    emitRoomState(room);
    return {
      ok: true,
      reconnected: true,
      roomId: room.id,
      roomCode: room.code,
      room: serializeRoomForUser(room, user.id)
    };
  }

  // Pemain ketiga tidak boleh masuk jika room sudah mulai atau selesai
  if (room.status !== 'waiting') {
    return { ok: false, error: 'Pertandingan di room ini sudah dimulai.' };
  }

  if (room.groupId) {
    const social = require('../social/store');
    if (!social.isGroupMember(room.groupId, user.id)) {
      return { ok: false, error: 'Match ini khusus untuk anggota grup.' };
    }
  }

  if (room.players.length >= (room.maxPlayers || 2)) {
    return { ok: false, error: 'Room sudah penuh.' };
  }

  cancelMatchmaking(socket, payload);

  const order = room.players.length;
  const newPlayer = snakesConfig.createHumanPlayerRecord(user, {
    order,
    color: snakesConfig.PLAYER_COLORS[order % snakesConfig.PLAYER_COLORS.length],
    socketId: socket?.id || null,
    ready: true
  });

  room.players.push(newPlayer);
  room.updatedAt = Date.now();
  userActiveRoom.set(user.id, room.code);

  if (socket) {
    socket.join(socketRoomName(room.code));
    socket.data.snakesRoom = room.code;
  }

  snakesStore.saveRoomAndPlayers(room);
  emitRoomState(room);

  return {
    ok: true,
    roomId: room.id,
    roomCode: room.code,
    room: serializeRoomForUser(room, user.id)
  };
}

function startPrivateRoom(socket, payload = {}) {
  const user = resolveUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu.' };

  const code = String(payload.code || payload.roomCode || socket?.data?.snakesRoom || userActiveRoom.get(user.id) || '').toUpperCase();
  const room = snakesRooms.get(code) || roomsById.get(payload.roomId);
  if (!room) return { ok: false, error: 'Room tidak ditemukan.' };

  if (room.hostUserId !== user.id) {
    return { ok: false, error: 'Hanya pembuat room (Host) yang dapat memulai permainan.' };
  }
  if (room.status !== 'waiting') {
    return { ok: false, error: 'Permainan sudah dimulai.' };
  }
  if (room.players.length < 2) {
    return { ok: false, error: 'Minimal 2 pemain diperlukan untuk memulai permainan.' };
  }

  startGameInRoom(room);
  return {
    ok: true,
    roomId: room.id,
    roomCode: room.code,
    room: serializeRoomForUser(room, user.id)
  };
}

// ==========================================
// PLAYER ACTIONS: ROLL DICE, REMATCH, LEAVE, CHAT, REACTION
// ==========================================

function handleRollDice(socket, payload = {}) {
  const user = resolveUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu.' };

  // Keamanan: Tolak jika client mencoba mengirim hasil dadu atau posisi bidak sendiri
  if (
    payload &&
    (payload.dice_result !== undefined ||
      payload.dice !== undefined ||
      payload.position !== undefined ||
      payload.targetPosition !== undefined)
  ) {
    return {
      ok: false,
      error: 'Manipulasi hasil dadu atau posisi tidak diizinkan. Hasil dadu ditentukan sepenuhnya oleh server.'
    };
  }

  const lookup = String(payload.roomId || payload.room_id || payload.roomCode || payload.code || socket?.data?.snakesRoom || userActiveRoom.get(user.id) || '').trim();
  const room = roomsById.get(lookup) || snakesRooms.get(lookup.toUpperCase());
  if (!room) return { ok: false, error: 'Room permainan tidak ditemukan.' };

  const player = room.players.find(p => p.player_type === 'human' && p.user_id === user.id);
  if (!player) {
    return { ok: false, error: 'Kamu tidak terdaftar sebagai pemain di room ini.' };
  }

  if (room.status !== 'playing') {
    return { ok: false, error: 'Pertandingan belum dimulai atau sudah selesai.' };
  }

  const currentTurnPlayer = room.players[room.turnIndex];
  if (!currentTurnPlayer || currentTurnPlayer.id !== player.id) {
    return { ok: false, error: 'Bukan giliranmu untuk melempar dadu.' };
  }

  return executeAuthoritativeRoll(room, player);
}

function requestRematch(socket, payload = {}) {
  const user = resolveUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu.' };

  const lookup = String(payload.roomId || payload.roomCode || payload.code || socket?.data?.snakesRoom || userActiveRoom.get(user.id) || '').trim();
  const room = roomsById.get(lookup) || snakesRooms.get(lookup.toUpperCase());
  if (!room) return { ok: false, error: 'Room tidak ditemukan.' };

  const player = room.players.find(p => p.player_type === 'human' && p.user_id === user.id);
  if (!player) return { ok: false, error: 'Kamu bukan peserta di room ini.' };

  if (room.status !== 'finished') {
    return { ok: false, error: 'Pertandingan masih berlangsung.' };
  }

  if (!room.rematchVotes) room.rematchVotes = new Set();
  room.rematchVotes.add(user.id);

  const humanPlayers = room.players.filter(p => p.player_type === 'human' && p.user_id);
  const allHumansVoted = humanPlayers.every(p => room.rematchVotes.has(p.user_id));

  if (allHumansVoted) {
    // Buat ID room baru untuk sesi pertandingan baru agar riwayat sebelumnya tetap utuh
    const oldId = room.id;
    roomsById.delete(oldId);
    room.id = `snk_room_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    roomsById.set(room.id, room);
    startGameInRoom(room);
    return {
      ok: true,
      restarted: true,
      roomId: room.id,
      roomCode: room.code,
      room: serializeRoomForUser(room, user.id)
    };
  }

  emitRoomState(room);
  return {
    ok: true,
    restarted: false,
    rematchVotes: Array.from(room.rematchVotes),
    room: serializeRoomForUser(room, user.id)
  };
}

function leaveRoom(socket, payload = {}) {
  const user = resolveUser(socket, payload);
  const code = String(payload?.code || payload?.roomCode || socket?.data?.snakesRoom || (user && userActiveRoom.get(user.id)) || '').toUpperCase();
  const room = snakesRooms.get(code);
  if (!room) {
    if (user) userActiveRoom.delete(user.id);
    return { ok: true };
  }

  const userId = user?.id || socket?.data?.userId;
  const player = room.players.find(p => p.player_type === 'human' && p.user_id === userId);
  if (!player) return { ok: true };

  if (userId && userActiveRoom.get(userId) === room.code) {
    userActiveRoom.delete(userId);
  }
  if (socket) {
    socket.leave(socketRoomName(room.code));
    delete socket.data.snakesRoom;
  }

  // Jika pertandingan sedang berlangsung dan pemain keluar secara sengaja, lawan menang
  if (room.status === 'playing') {
    player.status = 'left';
    player.connected = false;
    const remainingActive = room.players.filter(p => p.id !== player.id && p.status === 'active');
    const hasRemainingHuman = remainingActive.some(p => p.player_type === 'human');
    if (remainingActive.length === 1) {
      finishGameInRoom(room, remainingActive[0], 'opponent_left');
      if (!hasRemainingHuman) {
        closeRoom(room, 'Pertandingan selesai.');
      }
      return { ok: true };
    }
    if (!hasRemainingHuman) {
      closeRoom(room, 'Semua pemain manusia telah keluar.');
      return { ok: true };
    }
  }

  // Jika di lobby atau sudah selesai
  room.players = room.players.filter(p => p.id !== player.id);
  const remainingHumans = room.players.filter(p => p.player_type === 'human');
  if (remainingHumans.length === 0) {
    closeRoom(room, 'Room ditutup karena semua pemain keluar.');
    return { ok: true };
  }

  if (room.hostUserId === userId) {
    room.hostUserId = remainingHumans[0].user_id;
  }
  emitRoomState(room);
  return { ok: true };
}

function handleDisconnect(socket) {
  const userId = socket?.data?.userId;
  if (userId && matchmakingQueue.has(userId)) {
    const qEntry = matchmakingQueue.get(userId);
    if (!qEntry.socketId || qEntry.socketId === socket.id) {
      clearMatchmakingTimers(userId);
      matchmakingQueue.delete(userId);
      snakesStore.updateQueueEntryStatus(qEntry.id, 'cancelled');
    }
  }

  const code = socket?.data?.snakesRoom || (userId && userActiveRoom.get(userId));
  if (!code) return;
  const room = snakesRooms.get(code);
  if (!room) return;

  const player = room.players.find(
    p => p.player_type === 'human' && (p.user_id === userId || p.socketId === socket.id)
  );
  if (!player) return;

  const now = Date.now();
  player.connected = false;
  player.status = 'disconnected';
  player.disconnectedAt = now;
  player.graceEndsAt = now + timings.disconnectGraceMs;

  emitToRoom(room, 'game.player_disconnected', {
    roomId: room.id,
    roomCode: room.code,
    playerId: player.id,
    userId: player.user_id,
    displayName: player.display_name,
    graceEndsAt: player.graceEndsAt,
    serverNow: now
  });

  if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
  player.disconnectTimer = setTimeout(() => {
    if (player.connected) return;
    if (room.status === 'playing') {
      const otherActive = room.players.filter(p => p.id !== player.id && p.status === 'active');
      if (otherActive.length >= 1) {
        finishGameInRoom(room, otherActive[0], 'disconnect_forfeit');
      }
    } else if (room.status === 'waiting') {
      closeRoom(room, 'Pemain terputus terlalu lama.');
    }
  }, timings.disconnectGraceMs);
  if (player.disconnectTimer.unref) player.disconnectTimer.unref();

  emitRoomState(room);
}

// ==========================================
// CHAT RUANGAN & EMOTICON REACTIONS (JAKLUDO STYLE)
// ==========================================

function sendChat(socket, payload = {}) {
  const user = resolveUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu.' };

  const code = String(payload.code || payload.roomCode || socket?.data?.snakesRoom || userActiveRoom.get(user.id) || '').toUpperCase();
  const room = snakesRooms.get(code);
  if (!room) return { ok: false, error: 'Room tidak ditemukan.' };

  const player = room.players.find(p => p.player_type === 'human' && p.user_id === user.id);
  if (!player) return { ok: false, error: 'Kamu bukan peserta di room ini.' };

  const cleanText = String(payload.text || '').trim().slice(0, 140);
  if (!cleanText) return { ok: false, error: 'Pesan tidak boleh kosong.' };

  if (!Array.isArray(room.chats)) room.chats = [];

  let replyTo = null;
  const replyToId = payload.replyToId;
  if (replyToId !== undefined && replyToId !== null && replyToId !== '') {
    const target = room.chats.find(c => String(c.id) === String(replyToId));
    if (target) {
      replyTo = {
        id: target.id,
        senderId: target.senderId,
        senderName: target.senderName,
        senderColor: target.senderColor,
        text: String(target.text || '').slice(0, 90)
      };
    }
  }

  const chatMsg = {
    id: Date.now() + Math.random(),
    senderId: player.user_id,
    senderName: player.display_name,
    senderAvatar: player.avatar || '🎲',
    senderColor: player.color || 'red',
    text: cleanText,
    replyTo,
    time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
  };

  room.chats.push(chatMsg);
  if (room.chats.length > (MAX_CHATS || 50)) room.chats.shift();

  emitToRoom(room, 'snakes:chat_message', chatMsg);
  return { ok: true, message: chatMsg };
}

function sendReaction(socket, payload = {}) {
  const user = resolveUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu.' };

  const emoji = String(payload.emoji || '').trim();
  if (!EMOJIS.includes(emoji)) return { ok: false, error: 'Reaksi tidak valid.' };

  const code = String(payload.code || payload.roomCode || socket?.data?.snakesRoom || userActiveRoom.get(user.id) || '').toUpperCase();
  const room = snakesRooms.get(code);
  if (!room) return { ok: false, error: 'Room tidak ditemukan.' };

  const player = room.players.find(p => p.player_type === 'human' && p.user_id === user.id);
  if (!player) return { ok: false, error: 'Kamu bukan peserta di room ini.' };

  const reactionPayload = {
    id: Date.now() + Math.random(),
    playerId: player.user_id,
    playerName: player.display_name,
    color: player.color || 'red',
    emoji
  };

  emitToRoom(room, 'room:reaction', reactionPayload);
  return { ok: true };
}

// ==========================================
// GETTERS & CLEANUP
// ==========================================

function getRoomStateForUser(roomIdOrCode, viewerUserId = null) {
  if (!roomIdOrCode) return null;
  const key = String(roomIdOrCode).trim();
  const live = roomsById.get(key) || snakesRooms.get(key.toUpperCase());
  if (live) {
    return serializeRoomForUser(live, viewerUserId);
  }
  return snakesStore.getStoredRoomByIdOrCode(key);
}

function getActiveRoomForUser(userId) {
  if (!userId) return null;
  const code = userActiveRoom.get(userId);
  if (!code) return null;
  const room = snakesRooms.get(code);
  if (!room || room.status === 'finished' || room.status === 'cancelled') {
    userActiveRoom.delete(userId);
    return null;
  }
  return serializeRoomForUser(room, userId);
}

function closeAllRoomsForShutdown() {
  for (const [userId] of matchmakingQueue.entries()) {
    clearMatchmakingTimers(userId);
  }
  matchmakingQueue.clear();
  for (const room of snakesRooms.values()) {
    clearRoomTimers(room);
  }
  snakesRooms.clear();
  roomsById.clear();
  userActiveRoom.clear();
}

function stopAllTimers() {
  for (const userId of matchmakingTimers.keys()) {
    clearMatchmakingTimers(userId);
  }
  for (const room of snakesRooms.values()) {
    clearRoomTimers(room);
  }
}

module.exports = {
  init,
  snakesRooms,
  roomsById,
  userActiveRoom,
  matchmakingQueue,
  setTimings,
  getTimings,
  setTestDiceSequence,
  joinMatchmaking,
  cancelMatchmaking,
  createPrivateRoom,
  joinPrivateRoom,
  startPrivateRoom,
  handleRollDice,
  requestRematch,
  leaveRoom,
  handleDisconnect,
  sendChat,
  sendReaction,
  getRoomStateForUser,
  getActiveRoomForUser,
  closeAllRoomsForShutdown,
  stopAllTimers
};
