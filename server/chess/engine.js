// Engine Otoritatif Chess Master (PlayGo)
// Mengelola: Quick Matchmaking, Private Room, Validasi Langkah (chess.js),
// Jam Catur Otoritatif Server (Bullet/Blitz/Rapid + Increment), Draw Offer, Resign, Rematch, dan Reconnect.
const crypto = require('crypto');
const { Chess } = require('chess.js');
const db = require('../db');
const chessStore = require('./store');
const {
  isBotUserId,
  getBotProfile,
  buildQuickMatchBotForRating,
  evaluateBoard,
  chooseBotMove
} = require('./bot');

const DISCONNECT_GRACE_MS = Number(process.env.CHESS_DISCONNECT_GRACE_MS || 60_000);
const LOBBY_EXPIRE_MS = Number(process.env.CHESS_LOBBY_EXPIRE_MS || 5 * 60 * 1000);
const DRAW_OFFER_EXPIRE_MS = 30_000;
const CLOCK_TICK_MS = 250;

const DEFAULT_TIMINGS = {
  botMatchmakingDelayMs: 5000,
  botMoveDelayMinMs: 450,
  botMoveDelayMaxMs: 950
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
const chessRooms = new Map();        // roomCode -> RoomObject
const roomsByMatchId = new Map();    // matchId -> RoomObject
const userActiveRoom = new Map();    // userId -> roomCode
const matchmakingQueue = new Map();  // userId -> { userId, socketId, rating, timeControl, joinedAt }
const matchmakingTimers = new Map(); // userId -> Timeout

function clearMatchmakingTimer(userId) {
  const t = matchmakingTimers.get(userId);
  if (t) {
    clearTimeout(t);
    matchmakingTimers.delete(userId);
  }
}

function init(io) {
  ioInstance = io;
}

function socketRoomName(code) {
  return `chess:${code}`;
}

function generateRoomCode(existingLudoRooms = null) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = '';
    for (let i = 0; i < 5; i++) {
      code += chars[crypto.randomInt(0, chars.length)];
    }
    if (!chessRooms.has(code) && (!existingLudoRooms || !existingLudoRooms.has(code))) {
      return code;
    }
  }
  return `C${Date.now().toString(36).slice(-4).toUpperCase()}`;
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

function findPlayerSocket(userId) {
  if (!ioInstance || !userId) return null;
  for (const [, sock] of ioInstance.of('/').sockets) {
    if (sock.data?.userId === userId) return sock;
  }
  return null;
}

function emitToRoom(room, event, payload) {
  if (!ioInstance || !room) return;
  ioInstance.to(socketRoomName(room.code)).emit(event, payload);
}

function emitToUser(userId, event, payload) {
  if (!ioInstance || !userId) return;
  ioInstance.to(`user:${userId}`).emit(event, payload);
  const sock = findPlayerSocket(userId);
  if (sock) sock.emit(event, payload);
}

function computeLiveClocks(room, now = Date.now()) {
  const m = room?.match;
  if (!m) {
    const tc = chessStore.getTimeControl(room?.timeControl || '5+0');
    return { whiteRemainingTimeMs: tc.initialMs, blackRemainingTimeMs: tc.initialMs };
  }
  if (m.status !== 'active' || !m.lastMoveAt) {
    return {
      whiteRemainingTimeMs: Math.max(0, m.whiteRemainingTimeMs),
      blackRemainingTimeMs: Math.max(0, m.blackRemainingTimeMs)
    };
  }
  const elapsed = Math.max(0, now - m.lastMoveAt);
  if (m.currentTurn === 'w') {
    return {
      whiteRemainingTimeMs: Math.max(0, m.whiteRemainingTimeMs - elapsed),
      blackRemainingTimeMs: Math.max(0, m.blackRemainingTimeMs)
    };
  }
  return {
    whiteRemainingTimeMs: Math.max(0, m.whiteRemainingTimeMs),
    blackRemainingTimeMs: Math.max(0, m.blackRemainingTimeMs - elapsed)
  };
}

function serializeRoomForUser(room, viewerUserId = null) {
  if (!room) return null;
  const now = Date.now();
  const clocks = computeLiveClocks(room, now);
  const m = room.match;

  // Bersihkan draw offer yang sudah kedaluwarsa
  if (m?.drawOffer && m.drawOffer.expiresAt <= now) {
    m.drawOffer = null;
  }

  const players = room.players.map(p => {
    const prof = p.isBot ? null : chessStore.getPlayerProfile(p.userId);
    return {
      userId: p.userId,
      username: p.username,
      name: p.name,
      avatar: p.avatar || '🎯',
      rating: p.isBot ? p.rating || chessStore.DEFAULT_RATING : prof?.rating || chessStore.DEFAULT_RATING,
      color: p.color || null,
      isBot: Boolean(p.isBot),
      difficulty: p.difficulty || null,
      ready: Boolean(p.ready),
      connected: Boolean(p.connected),
      disconnectedAt: p.disconnectedAt || null,
      graceEndsAt: p.graceEndsAt || null
    };
  });

  let legalMoves = [];
  let inCheck = false;
  if (m && m.chess) {
    inCheck = m.chess.inCheck();
    if (m.status === 'active') {
      try {
        legalMoves = m.chess.moves({ verbose: true }).map(mv => ({
          from: mv.from,
          to: mv.to,
          promotion: mv.promotion || null,
          san: mv.san,
          flags: mv.flags,
          piece: mv.piece,
          captured: mv.captured || null
        }));
      } catch {
        legalMoves = [];
      }
    }
  }

  const myPlayer = viewerUserId ? players.find(p => p.userId === viewerUserId) : null;
  const whitePlayerObj = m ? players.find(p => p.userId === m.whitePlayerId) || null : null;
  const blackPlayerObj = m ? players.find(p => p.userId === m.blackPlayerId) || null : null;
  const rematchReqs = m ? Array.from(m.rematchRequests || []) : [];

  return {
    id: room.id,
    code: room.code,
    groupId: room.groupId || null,
    hostUserId: room.hostUserId,
    source: room.source,
    phase: room.phase === 'finished' ? 'completed' : room.phase, // 'lobby' | 'playing' | 'completed'
    timeControl: room.timeControl,
    colorPreference: room.colorPreference || 'random',
    preferredSide: room.colorPreference || 'random',
    players,
    chats: Array.isArray(room.chats) ? room.chats : [],
    rematchRequests: rematchReqs,
    myColor: myPlayer?.color || null,
    serverNow: now,
    match: m
      ? {
          id: m.id,
          matchType: m.matchType,
          timeControl: m.timeControl,
          initialFen: m.initialFen,
          currentFen: m.currentFen,
          fen: m.currentFen,
          currentTurn: m.currentTurn,
          turn: m.currentTurn,
          inCheck,
          isCheckmate: Boolean(m.chess && m.chess.isCheckmate()),
          whitePlayerId: m.whitePlayerId,
          blackPlayerId: m.blackPlayerId,
          whitePlayer: whitePlayerObj,
          blackPlayer: blackPlayerObj,
          whiteRemainingTimeMs: clocks.whiteRemainingTimeMs,
          blackRemainingTimeMs: clocks.blackRemainingTimeMs,
          whiteTimeMs: clocks.whiteRemainingTimeMs,
          blackTimeMs: clocks.blackRemainingTimeMs,
          incrementSeconds: m.incrementSeconds,
          lastMoveAt: m.lastMoveAt,
          turnStartedAt: m.lastMoveAt,
          moveVersion: m.moveVersion,
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
          moves: m.moves || [],
          lastMove: m.moves && m.moves.length > 0 ? m.moves[m.moves.length - 1] : null,
          legalMoves,
          drawOffer: m.drawOffer
            ? {
                fromUserId: m.drawOffer.fromUserId,
                byUserId: m.drawOffer.fromUserId,
                fromColor: m.drawOffer.fromColor,
                offeredAt: m.drawOffer.offeredAt,
                expiresAt: m.drawOffer.expiresAt
              }
            : null,
          rematchRequests: rematchReqs,
          completedPayload: m.completedPayload || null,
          nextMatchId: m.nextMatchId || null,
          startedAt: m.startedAt,
          finishedAt: m.finishedAt
        }
      : null
  };
}

function emitRoomState(room) {
  if (!ioInstance || !room) return;
  for (const p of room.players) {
    const sock = findPlayerSocket(p.userId);
    if (sock) {
      sock.emit('chess:room:state', serializeRoomForUser(room, p.userId));
    }
  }
}

function clearRoomTimers(room) {
  if (!room) return;
  if (room.clockTimer) {
    clearInterval(room.clockTimer);
    room.clockTimer = null;
  }
  if (room.lobbyExpireTimer) {
    clearTimeout(room.lobbyExpireTimer);
    room.lobbyExpireTimer = null;
  }
  if (room.botMoveTimer) {
    clearTimeout(room.botMoveTimer);
    room.botMoveTimer = null;
  }
  if (room.botDrawTimer) {
    clearTimeout(room.botDrawTimer);
    room.botDrawTimer = null;
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
    if (room.phase === 'lobby') {
      closeRoom(room, 'Room kedaluwarsa karena tidak aktif.');
    }
  }, LOBBY_EXPIRE_MS);
  if (room.lobbyExpireTimer.unref) room.lobbyExpireTimer.unref();
}

function closeRoom(room, reason = 'Room ditutup.') {
  if (!room) return;
  clearRoomTimers(room);
  emitToRoom(room, 'chess:room:closed', { roomCode: room.code, reason });
  for (const p of room.players) {
    if (userActiveRoom.get(p.userId) === room.code) {
      userActiveRoom.delete(p.userId);
    }
    const sock = findPlayerSocket(p.userId);
    if (sock) sock.leave(socketRoomName(room.code));
  }
  if (room.match?.id) {
    if (room.match.status === 'waiting' || (room.match.status === 'active' && (room.match.moves?.length || 0) === 0)) {
      chessStore.cancelMatchRecord(room.match.id, 'cancelled');
    }
    roomsByMatchId.delete(room.match.id);
  }
  chessRooms.delete(room.code);
}

// ==========================================
// START MATCH & CLOCK MANAGEMENT
// ==========================================

function assignColors(room) {
  const [p0, p1] = room.players;
  if (!p0 || !p1) return;

  const pref = room.colorPreference || 'random';
  let hostWhite;
  if (pref === 'w') hostWhite = true;
  else if (pref === 'b') hostWhite = false;
  else hostWhite = crypto.randomInt(0, 2) === 0;

  if (p0.userId === room.hostUserId) {
    p0.color = hostWhite ? 'w' : 'b';
    p1.color = hostWhite ? 'b' : 'w';
  } else {
    p1.color = hostWhite ? 'w' : 'b';
    p0.color = hostWhite ? 'b' : 'w';
  }
}

function startMatchInRoom(room, { matchType = 'quick', swapColors = false, customFen = null } = {}) {
  if (!room || room.players.length < 2) return null;

  if (swapColors && room.players[0].color && room.players[1].color) {
    const c0 = room.players[0].color;
    room.players[0].color = room.players[1].color;
    room.players[1].color = c0;
  } else if (!room.players[0].color || !room.players[1].color) {
    assignColors(room);
  }

  const whitePlayer = room.players.find(p => p.color === 'w') || room.players[0];
  const blackPlayer = room.players.find(p => p.color === 'b') || room.players[1];
  whitePlayer.color = 'w';
  blackPlayer.color = 'b';

  const tc = chessStore.getTimeControl(room.timeControl);
  const chess = customFen ? new Chess(customFen) : new Chess();
  const initialFen = chess.fen();
  const now = Date.now();
  const matchId = `chess_${now}_${crypto.randomBytes(4).toString('hex')}`;

  if (room.lobbyExpireTimer) {
    clearTimeout(room.lobbyExpireTimer);
    room.lobbyExpireTimer = null;
  }

  const dbRecord = chessStore.createMatchRecord({
    id: matchId,
    whitePlayerId: whitePlayer.userId,
    blackPlayerId: blackPlayer.userId,
    whiteBotRating: whitePlayer.isBot ? whitePlayer.rating : null,
    blackBotRating: blackPlayer.isBot ? blackPlayer.rating : null,
    roomCode: room.code,
    groupId: room.groupId || null,
    matchType,
    timeControl: tc.id,
    initialFen,
    whiteRemainingTimeMs: tc.initialMs,
    blackRemainingTimeMs: tc.initialMs,
    incrementSeconds: tc.incrementSeconds,
    status: 'active',
    startedAt: now
  });

  room.phase = 'playing';
  const wProfile = whitePlayer.isBot ? null : chessStore.getPlayerProfile(whitePlayer.userId);
  const bProfile = blackPlayer.isBot ? null : chessStore.getPlayerProfile(blackPlayer.userId);
  room.match = {
    ...dbRecord,
    whitePlayer: {
      userId: whitePlayer.userId,
      username: whitePlayer.username,
      name: whitePlayer.name,
      avatar: whitePlayer.avatar || '🎯',
      isBot: Boolean(whitePlayer.isBot),
      difficulty: whitePlayer.difficulty || null,
      rating: whitePlayer.isBot ? whitePlayer.rating || chessStore.DEFAULT_RATING : wProfile?.rating || chessStore.DEFAULT_RATING
    },
    blackPlayer: {
      userId: blackPlayer.userId,
      username: blackPlayer.username,
      name: blackPlayer.name,
      avatar: blackPlayer.avatar || '🎯',
      isBot: Boolean(blackPlayer.isBot),
      difficulty: blackPlayer.difficulty || null,
      rating: blackPlayer.isBot ? blackPlayer.rating || chessStore.DEFAULT_RATING : bProfile?.rating || chessStore.DEFAULT_RATING
    },
    winnerId: null,
    resultReason: null,
    chess,
    moves: [],
    drawOffer: null,
    rematchRequests: new Set(),
    nextMatchId: null
  };

  roomsByMatchId.set(matchId, room);
  startRoomClockTimer(room);

  const startedPayload = {
    roomCode: room.code,
    matchId,
    matchType,
    timeControl: tc.id,
    initialFen,
    currentFen: initialFen,
    currentTurn: chess.turn(),
    whitePlayerId: whitePlayer.userId,
    blackPlayerId: blackPlayer.userId,
    whiteRemainingTimeMs: tc.initialMs,
    blackRemainingTimeMs: tc.initialMs,
    incrementSeconds: tc.incrementSeconds,
    startedAt: now
  };

  emitToRoom(room, 'MatchStarted', startedPayload);
  emitRoomState(room);
  scheduleBotMoveIfNeeded(room);
  return room.match;
}

function startRoomClockTimer(room) {
  if (!room) return;
  if (room.clockTimer) clearInterval(room.clockTimer);

  room.clockTimer = setInterval(() => {
    const m = room.match;
    if (!m || m.status !== 'active') {
      clearInterval(room.clockTimer);
      room.clockTimer = null;
      return;
    }
    const now = Date.now();
    const clocks = computeLiveClocks(room, now);
    if (clocks.whiteRemainingTimeMs <= 0) {
      m.whiteRemainingTimeMs = 0;
      m.blackRemainingTimeMs = clocks.blackRemainingTimeMs;
      completeMatch(room, {
        result: '0-1',
        winnerUserId: m.blackPlayerId,
        terminationReason: 'timeout'
      });
    } else if (clocks.blackRemainingTimeMs <= 0) {
      m.whiteRemainingTimeMs = clocks.whiteRemainingTimeMs;
      m.blackRemainingTimeMs = 0;
      completeMatch(room, {
        result: '1-0',
        winnerUserId: m.whitePlayerId,
        terminationReason: 'timeout'
      });
    }
  }, CLOCK_TICK_MS);

  if (room.clockTimer.unref) room.clockTimer.unref();
}

function completeMatch(room, { result, winnerUserId = null, terminationReason = 'checkmate' }) {
  if (!room || !room.match) return null;
  const m = room.match;
  if (m.status === 'completed') return m;

  if (room.clockTimer) {
    clearInterval(room.clockTimer);
    room.clockTimer = null;
  }
  if (room.botMoveTimer) {
    clearTimeout(room.botMoveTimer);
    room.botMoveTimer = null;
  }
  if (room.botDrawTimer) {
    clearTimeout(room.botDrawTimer);
    room.botDrawTimer = null;
  }

  for (const p of room.players) {
    if (p.disconnectTimer) {
      clearTimeout(p.disconnectTimer);
      p.disconnectTimer = null;
    }
    p.ready = false;
  }

  m.drawOffer = null;
  room.phase = 'completed';

  const finalized = chessStore.finalizeMatchRecord({
    matchId: m.id,
    result,
    winnerUserId,
    terminationReason,
    whiteRemainingTimeMs: m.whiteRemainingTimeMs,
    blackRemainingTimeMs: m.blackRemainingTimeMs,
    currentFen: m.currentFen
  });

  if (finalized) {
    Object.assign(m, finalized);
  }
  m.winnerId = m.winnerUserId;
  m.resultReason = m.terminationReason;

  const completedPayload = {
    roomCode: room.code,
    matchId: m.id,
    result: m.result,
    winnerUserId: m.winnerUserId,
    winnerId: m.winnerUserId,
    terminationReason: m.terminationReason,
    resultReason: m.terminationReason,
    currentFen: m.currentFen,
    fen: m.currentFen,
    pgn: m.pgn,
    rewardCoins: m.rewardCoins || 0,
    whiteRatingBefore: m.whiteRatingBefore,
    whiteRatingAfter: m.whiteRatingAfter,
    whiteRatingChange: m.whiteRatingChange,
    blackRatingBefore: m.blackRatingBefore,
    blackRatingAfter: m.blackRatingAfter,
    blackRatingChange: m.blackRatingChange,
    finishedAt: m.finishedAt,
    serverNow: Date.now()
  };
  m.completedPayload = completedPayload;

  emitToRoom(room, 'MatchCompleted', completedPayload);
  emitRoomState(room);

  if (ioInstance) {
    ioInstance.emit('chess:leaderboard:update', chessStore.getChessLeaderboard({ limit: 50, page: 1 }));
  }

  return m;
}

// ==========================================
// QUICK MATCHMAKING & BOT MATCHING SERVICE
// ==========================================

function matchUserWithBot(userId, timeControlId = '5+0', existingLudoRooms = null) {
  clearMatchmakingTimer(userId);
  const qEntry = matchmakingQueue.get(userId);
  matchmakingQueue.delete(userId);

  // Pastikan user belum masuk ke room lain
  if (userActiveRoom.has(userId)) return null;

  const user = db.getUserById(userId);
  if (!user) return null;

  const sock = findPlayerSocket(userId);
  if (!sock || !sock.connected) return null;

  const tc = chessStore.getTimeControl(qEntry?.timeControl || timeControlId || '5+0');
  const prof = chessStore.getPlayerProfile(user.id);
  const myRating = prof?.rating || chessStore.DEFAULT_RATING;
  const botInfo = buildQuickMatchBotForRating(myRating);

  const code = generateRoomCode(existingLudoRooms);
  const now = Date.now();
  const room = {
    id: `croom_${now}_${crypto.randomBytes(3).toString('hex')}`,
    code,
    groupId: null,
    hostUserId: user.id,
    source: 'quick',
    phase: 'lobby',
    timeControl: tc.id,
    colorPreference: 'random',
    players: [
      {
        userId: user.id,
        username: user.username,
        name: user.name || user.username,
        avatar: user.avatar || '🎯',
        isBot: false,
        difficulty: null,
        color: null,
        ready: true,
        connected: true,
        disconnectedAt: null,
        graceEndsAt: null
      },
      {
        userId: botInfo.userId,
        username: botInfo.username,
        name: botInfo.name,
        avatar: botInfo.avatar,
        rating: botInfo.rating,
        isBot: true,
        difficulty: botInfo.difficulty,
        color: null,
        ready: true,
        connected: true,
        disconnectedAt: null,
        graceEndsAt: null
      }
    ],
    match: null,
    createdAt: now
  };

  chessRooms.set(code, room);
  userActiveRoom.set(user.id, code);
  sock.join(socketRoomName(code));

  startMatchInRoom(room, { matchType: 'quick' });

  const matchFoundPayload = {
    roomCode: code,
    matchId: room.match.id,
    timeControl: tc.id,
    whitePlayerId: room.match.whitePlayerId,
    blackPlayerId: room.match.blackPlayerId,
    vsBot: true
  };

  emitToRoom(room, 'MatchFound', matchFoundPayload);
  emitRoomState(room);
  return room;
}

function playVsBot(socket, payload = {}, existingLudoRooms = null) {
  const user = resolveUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu untuk bermain Chess Master.' };

  clearMatchmakingTimer(user.id);
  matchmakingQueue.delete(user.id);

  // Jika masih di room lama yang sudah selesai, keluarkan dulu
  const prevCode = userActiveRoom.get(user.id);
  if (prevCode) {
    const prevRoom = chessRooms.get(prevCode);
    if (prevRoom && prevRoom.phase !== 'playing') {
      leaveRoom(socket, { token: payload.token });
    } else if (prevRoom && prevRoom.phase === 'playing') {
      if (socket) socket.join(socketRoomName(prevRoom.code));
      return {
        ok: true,
        matched: true,
        reconnected: true,
        roomCode: prevRoom.code,
        room: serializeRoomForUser(prevRoom, user.id)
      };
    }
  }

  const tc = chessStore.getTimeControl(payload.timeControl || '5+0');
  const rawPref = payload.preferredSide || payload.colorPreference;
  const pref = ['random', 'w', 'b'].includes(rawPref) ? rawPref : 'random';
  const prof = chessStore.getPlayerProfile(user.id);
  const myRating = prof?.rating || chessStore.DEFAULT_RATING;

  const botInfo = payload.fromQueue
    ? buildQuickMatchBotForRating(myRating)
    : (() => {
        const bp = getBotProfile(`bot_chess_${payload.difficulty || 'medium'}`) || getBotProfile('bot_chess_medium');
        return {
          userId: bp.id,
          username: bp.username,
          name: bp.name,
          avatar: bp.avatar,
          rating: bp.rating,
          difficulty: bp.difficulty,
          isBot: true
        };
      })();

  const code = generateRoomCode(existingLudoRooms);
  const now = Date.now();
  const room = {
    id: `croom_${now}_${crypto.randomBytes(3).toString('hex')}`,
    code,
    groupId: null,
    hostUserId: user.id,
    source: payload.fromQueue ? 'quick' : 'bot',
    phase: 'lobby',
    timeControl: tc.id,
    colorPreference: pref,
    players: [
      {
        userId: user.id,
        username: user.username,
        name: user.name || user.username,
        avatar: user.avatar || '🎯',
        isBot: false,
        difficulty: null,
        color: null,
        ready: true,
        connected: true,
        disconnectedAt: null,
        graceEndsAt: null
      },
      {
        userId: botInfo.userId,
        username: botInfo.username,
        name: botInfo.name,
        avatar: botInfo.avatar,
        rating: botInfo.rating,
        isBot: true,
        difficulty: botInfo.difficulty,
        color: null,
        ready: true,
        connected: true,
        disconnectedAt: null,
        graceEndsAt: null
      }
    ],
    match: null,
    createdAt: now
  };

  chessRooms.set(code, room);
  userActiveRoom.set(user.id, code);
  if (socket) socket.join(socketRoomName(code));

  startMatchInRoom(room, { matchType: payload.fromQueue ? 'quick' : 'bot' });

  const matchFoundPayload = {
    roomCode: code,
    matchId: room.match.id,
    timeControl: tc.id,
    whitePlayerId: room.match.whitePlayerId,
    blackPlayerId: room.match.blackPlayerId,
    vsBot: true
  };

  emitToRoom(room, 'MatchFound', matchFoundPayload);
  emitRoomState(room);

  return {
    ok: true,
    matched: true,
    vsBot: true,
    roomCode: code,
    matchId: room.match.id,
    room: serializeRoomForUser(room, user.id)
  };
}

function joinMatchmaking(socket, payload = {}, existingLudoRooms = null) {
  const user = resolveUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu untuk bermain Chess Master.' };

  // Cek apakah sudah berada di room aktif
  const existingCode = userActiveRoom.get(user.id);
  if (existingCode) {
    const existingRoom = chessRooms.get(existingCode);
    if (existingRoom && existingRoom.phase !== 'completed' && existingRoom.phase !== 'finished') {
      if (socket) socket.join(socketRoomName(existingRoom.code));
      return {
        ok: true,
        matched: true,
        reconnected: true,
        roomCode: existingRoom.code,
        room: serializeRoomForUser(existingRoom, user.id)
      };
    }
    userActiveRoom.delete(user.id);
  }

  const tc = chessStore.getTimeControl(payload.timeControl || '5+0');
  const prof = chessStore.getPlayerProfile(user.id);
  const myRating = prof?.rating || chessStore.DEFAULT_RATING;

  // Bersihkan entri antrean yang sudah putus koneksi
  for (const [qUserId] of matchmakingQueue.entries()) {
    if (qUserId === user.id) continue;
    const sock = findPlayerSocket(qUserId);
    if (!sock || !sock.connected) {
      clearMatchmakingTimer(qUserId);
      matchmakingQueue.delete(qUserId);
    }
  }

  // Prioritas 1: Cari akun orang sungguhan (human) dengan timeControl yang sama dan rating terdekat
  let bestCandidate = null;
  let bestDiff = Infinity;
  for (const [qUserId, entry] of matchmakingQueue.entries()) {
    if (qUserId === user.id) continue;
    if (entry.timeControl !== tc.id) continue;
    const diff = Math.abs((entry.rating || chessStore.DEFAULT_RATING) - myRating);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestCandidate = entry;
    }
  }

  // Prioritas 2: Jika tidak ada yang timeControl-nya persis sama, tetap prioritaskan akun orang sungguhan yang sedang mengantre
  if (!bestCandidate) {
    for (const [qUserId, entry] of matchmakingQueue.entries()) {
      if (qUserId === user.id) continue;
      const diff = Math.abs((entry.rating || chessStore.DEFAULT_RATING) - myRating);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestCandidate = entry;
      }
    }
  }

  if (bestCandidate) {
    clearMatchmakingTimer(bestCandidate.userId);
    clearMatchmakingTimer(user.id);
    matchmakingQueue.delete(bestCandidate.userId);
    matchmakingQueue.delete(user.id);

    const otherUser = db.getUserById(bestCandidate.userId);
    const otherSock = findPlayerSocket(bestCandidate.userId);
    const activeTc = chessStore.getTimeControl(bestCandidate.timeControl || tc.id);

    if (otherUser) {
      const code = generateRoomCode(existingLudoRooms);
      const now = Date.now();
      const room = {
        id: `croom_${now}_${crypto.randomBytes(3).toString('hex')}`,
        code,
        groupId: null,
        hostUserId: otherUser.id,
        source: 'quick',
        phase: 'lobby',
        timeControl: activeTc.id,
        colorPreference: 'random',
        players: [
          {
            userId: otherUser.id,
            username: otherUser.username,
            name: otherUser.name || otherUser.username,
            avatar: otherUser.avatar || '🎯',
            isBot: false,
            difficulty: null,
            color: null,
            ready: true,
            connected: Boolean(otherSock?.connected),
            disconnectedAt: null,
            graceEndsAt: null
          },
          {
            userId: user.id,
            username: user.username,
            name: user.name || user.username,
            avatar: user.avatar || '🎯',
            isBot: false,
            difficulty: null,
            color: null,
            ready: true,
            connected: true,
            disconnectedAt: null,
            graceEndsAt: null
          }
        ],
        match: null,
        createdAt: now
      };

      chessRooms.set(code, room);
      userActiveRoom.set(otherUser.id, code);
      userActiveRoom.set(user.id, code);

      if (otherSock) otherSock.join(socketRoomName(code));
      if (socket) socket.join(socketRoomName(code));

      startMatchInRoom(room, { matchType: 'quick' });

      const matchFoundPayload = {
        roomCode: code,
        matchId: room.match.id,
        timeControl: activeTc.id,
        whitePlayerId: room.match.whitePlayerId,
        blackPlayerId: room.match.blackPlayerId,
        vsBot: false
      };

      emitToRoom(room, 'MatchFound', matchFoundPayload);
      emitRoomState(room);

      return {
        ok: true,
        matched: true,
        vsBot: false,
        roomCode: code,
        matchId: room.match.id,
        room: serializeRoomForUser(room, user.id)
      };
    }
  }

  // Belum ada lawan manusia saat ini: masukkan ke antrean & pasang timer fallback ke Bot
  clearMatchmakingTimer(user.id);
  matchmakingQueue.set(user.id, {
    userId: user.id,
    socketId: socket?.id || null,
    rating: myRating,
    timeControl: tc.id,
    joinedAt: Date.now()
  });

  if (timings.botMatchmakingDelayMs > 0) {
    const botTimer = setTimeout(() => {
      matchmakingTimers.delete(user.id);
      if (matchmakingQueue.has(user.id)) {
        matchUserWithBot(user.id, tc.id, existingLudoRooms);
      }
    }, timings.botMatchmakingDelayMs);
    if (botTimer.unref) botTimer.unref();
    matchmakingTimers.set(user.id, botTimer);
  }

  return {
    ok: true,
    matched: false,
    queued: true,
    searching: true,
    timeControl: tc.id,
    rating: myRating,
    botFallbackMs: timings.botMatchmakingDelayMs
  };
}

function leaveMatchmaking(socket, payload = {}) {
  const user = resolveUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu.' };
  clearMatchmakingTimer(user.id);
  const removed = matchmakingQueue.delete(user.id);
  return { ok: true, removed };
}

// ==========================================
// PRIVATE ROOM SERVICE
// ==========================================

function createRoom(socket, payload = {}, existingLudoRooms = null) {
  const user = resolveUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu untuk membuat room Chess Master.' };

  matchmakingQueue.delete(user.id);

  // Jika masih di room lama yang sudah selesai, keluarkan dulu
  const prevCode = userActiveRoom.get(user.id);
  if (prevCode) {
    const prevRoom = chessRooms.get(prevCode);
    if (prevRoom && prevRoom.phase !== 'playing') {
      leaveRoom(socket, { token: payload.token });
    } else if (prevRoom && prevRoom.phase === 'playing') {
      if (socket) socket.join(socketRoomName(prevRoom.code));
      return {
        ok: true,
        reconnected: true,
        roomCode: prevRoom.code,
        room: serializeRoomForUser(prevRoom, user.id)
      };
    }
  }

  const tc = chessStore.getTimeControl(payload.timeControl || '5+0');
  const rawPref = payload.preferredSide || payload.colorPreference;
  const pref = ['random', 'w', 'b'].includes(rawPref) ? rawPref : 'random';
  const code = generateRoomCode(existingLudoRooms);
  const now = Date.now();

  const room = {
    id: `croom_${now}_${crypto.randomBytes(3).toString('hex')}`,
    code,
    groupId: payload.groupId || null,
    hostUserId: user.id,
    source: 'private',
    phase: 'lobby',
    timeControl: tc.id,
    colorPreference: pref,
    players: [
      {
        userId: user.id,
        username: user.username,
        name: user.name || user.username,
        avatar: user.avatar || '🎯',
        color: pref === 'w' ? 'w' : pref === 'b' ? 'b' : null,
        ready: false,
        connected: true,
        disconnectedAt: null,
        graceEndsAt: null
      }
    ],
    match: null,
    createdAt: now
  };

  chessRooms.set(code, room);
  userActiveRoom.set(user.id, code);
  scheduleLobbyExpiration(room);

  if (socket) socket.join(socketRoomName(code));

  const statePayload = serializeRoomForUser(room, user.id);
  emitRoomState(room);

  return {
    ok: true,
    roomCode: code,
    room: statePayload
  };
}

function joinRoom(socket, payload = {}) {
  const user = resolveUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu untuk bergabung ke room.' };

  const cleanCode = String(payload.roomCode || payload.code || '')
    .trim()
    .toUpperCase();
  if (!cleanCode) return { ok: false, error: 'Kode room wajib diisi.' };

  const room = chessRooms.get(cleanCode);
  if (!room) return { ok: false, error: 'Room Chess Master tidak ditemukan atau sudah berakhir.' };

  matchmakingQueue.delete(user.id);

  // Cek apakah pemain adalah anggota room yang sedang reconnect
  const existingPlayer = room.players.find(p => p.userId === user.id);
  if (existingPlayer) {
    existingPlayer.connected = true;
    existingPlayer.disconnectedAt = null;
    existingPlayer.graceEndsAt = null;
    existingPlayer.name = user.name || user.username;
    existingPlayer.avatar = user.avatar || '🎯';
    if (existingPlayer.disconnectTimer) {
      clearTimeout(existingPlayer.disconnectTimer);
      existingPlayer.disconnectTimer = null;
    }
    userActiveRoom.set(user.id, room.code);
    if (socket) socket.join(socketRoomName(room.code));

    emitToRoom(room, 'PlayerReconnected', {
      roomCode: room.code,
      userId: user.id,
      username: user.username,
      name: existingPlayer.name
    });
    emitRoomState(room);

    return {
      ok: true,
      reconnected: true,
      roomCode: room.code,
      room: serializeRoomForUser(room, user.id)
    };
  }

  // Tolak pihak ketiga jika room sudah penuh atau pertandingan sedang berlangsung
  if (room.players.length >= 2 || room.phase !== 'lobby') {
    return { ok: false, error: 'Room sudah penuh atau pertandingan sedang berlangsung.' };
  }

  // Keluar dari room lobi lain bila ada
  const prevCode = userActiveRoom.get(user.id);
  if (prevCode && prevCode !== room.code) {
    leaveRoom(socket, { token: payload.token });
  }

  const hostPlayer = room.players[0];
  let guestColor = null;
  if (hostPlayer?.color === 'w') guestColor = 'b';
  else if (hostPlayer?.color === 'b') guestColor = 'w';

  room.players.push({
    userId: user.id,
    username: user.username,
    name: user.name || user.username,
    avatar: user.avatar || '🎯',
    color: guestColor,
    ready: false,
    connected: true,
    disconnectedAt: null,
    graceEndsAt: null
  });

  userActiveRoom.set(user.id, room.code);
  scheduleLobbyExpiration(room);

  if (socket) socket.join(socketRoomName(room.code));

  emitToRoom(room, 'PlayerJoined', {
    roomCode: room.code,
    userId: user.id,
    username: user.username,
    name: user.name || user.username,
    avatar: user.avatar || '🎯'
  });
  emitRoomState(room);

  return {
    ok: true,
    reconnected: false,
    roomCode: room.code,
    room: serializeRoomForUser(room, user.id)
  };
}

function configureRoom(socket, payload = {}) {
  const user = resolveUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu.' };

  const roomCode = payload.code || payload.roomCode || userActiveRoom.get(user.id);
  const room = chessRooms.get(String(roomCode || '').toUpperCase());
  if (!room) return { ok: false, error: 'Room tidak ditemukan.' };
  if (room.phase !== 'lobby') return { ok: false, error: 'Pengaturan tidak bisa diubah saat pertandingan berlangsung.' };
  if (room.hostUserId !== user.id) return { ok: false, error: 'Hanya pembuat room yang dapat mengubah pengaturan.' };

  if (payload.timeControl) {
    const tc = chessStore.getTimeControl(payload.timeControl);
    room.timeControl = tc.id;
  }
  const nextPref = payload.preferredSide || payload.colorPreference;
  if (nextPref && ['random', 'w', 'b'].includes(nextPref)) {
    room.colorPreference = nextPref;
    room.preferredSide = nextPref;
    const hostP = room.players.find(p => p.userId === room.hostUserId);
    const guestP = room.players.find(p => p.userId !== room.hostUserId);
    if (room.colorPreference === 'w') {
      if (hostP) hostP.color = 'w';
      if (guestP) guestP.color = 'b';
    } else if (room.colorPreference === 'b') {
      if (hostP) hostP.color = 'b';
      if (guestP) guestP.color = 'w';
    } else {
      if (hostP) hostP.color = null;
      if (guestP) guestP.color = null;
    }
  }

  emitRoomState(room);
  return { ok: true, room: serializeRoomForUser(room, user.id) };
}

function setPlayerReady(socket, payload = {}) {
  const user = resolveUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu.' };

  const roomCode = payload.code || payload.roomCode || userActiveRoom.get(user.id);
  const room = chessRooms.get(String(roomCode || '').toUpperCase());
  if (!room) return { ok: false, error: 'Room tidak ditemukan.' };
  if (room.phase !== 'lobby') return { ok: false, error: 'Pertandingan sudah dimulai.' };

  const player = room.players.find(p => p.userId === user.id);
  if (!player) return { ok: false, error: 'Kamu bukan anggota room ini.' };

  player.ready = payload.ready !== undefined ? Boolean(payload.ready) : !player.ready;

  if (room.players.length === 2 && room.players.every(p => p.ready)) {
    startMatchInRoom(room, { matchType: 'private' });
  } else {
    emitRoomState(room);
  }

  return { ok: true, room: serializeRoomForUser(room, user.id) };
}

// ==========================================
// SERVER-AUTHORITATIVE MOVE VALIDATION
// ==========================================

function resolveRoomForAction(user, payload = {}) {
  if (payload.matchId && roomsByMatchId.has(payload.matchId)) {
    return roomsByMatchId.get(payload.matchId);
  }
  const code = String(payload.code || payload.roomCode || userActiveRoom.get(user.id) || '').toUpperCase();
  if (code && chessRooms.has(code)) {
    return chessRooms.get(code);
  }
  return null;
}

function detectTerminalCondition(chess) {
  if (chess.isCheckmate()) {
    // Pemain yang baru saja melangkah menang (lawan skakmat)
    const winnerColor = chess.turn() === 'w' ? 'b' : 'w';
    return {
      ended: true,
      result: winnerColor === 'w' ? '1-0' : '0-1',
      winnerColor,
      terminationReason: 'checkmate'
    };
  }
  if (chess.isStalemate()) {
    return { ended: true, result: '1/2-1/2', winnerColor: null, terminationReason: 'stalemate' };
  }
  if (chess.isThreefoldRepetition()) {
    return { ended: true, result: '1/2-1/2', winnerColor: null, terminationReason: 'threefold_repetition' };
  }
  if (chess.isInsufficientMaterial()) {
    return { ended: true, result: '1/2-1/2', winnerColor: null, terminationReason: 'insufficient_material' };
  }
  if (chess.isDraw()) {
    return { ended: true, result: '1/2-1/2', winnerColor: null, terminationReason: 'fifty_move_rule' };
  }
  return { ended: false };
}

function scheduleBotMoveIfNeeded(room) {
  if (!room || room.phase !== 'playing' || !room.match || room.match.status !== 'active') return;
  const m = room.match;
  const activeTurn = m.chess.turn();
  const activePlayer = room.players.find(p => p.color === activeTurn);
  if (!activePlayer || !activePlayer.isBot) return;

  if (room.botMoveTimer) {
    clearTimeout(room.botMoveTimer);
    room.botMoveTimer = null;
  }

  const minMs = Math.max(20, Number(timings.botMoveDelayMinMs ?? 450));
  const maxMs = Math.max(minMs, Number(timings.botMoveDelayMaxMs ?? 950));
  const delayMs = minMs === maxMs ? minMs : crypto.randomInt(minMs, maxMs + 1);
  const expectedMatchId = m.id;
  const expectedMoveVersion = m.moveVersion;

  room.botMoveTimer = setTimeout(() => {
    room.botMoveTimer = null;
    if (!room.match || room.match.id !== expectedMatchId || room.match.status !== 'active') return;
    if (room.match.moveVersion !== expectedMoveVersion) return;
    if (room.match.chess.turn() !== activePlayer.color) return;

    const chosen = chooseBotMove(room.match.currentFen, activePlayer.difficulty || 'medium');
    if (!chosen) return;

    executeMoveForPlayer(room, activePlayer, {
      from: chosen.from,
      to: chosen.to,
      promotion: chosen.promotion || 'q',
      moveVersion: expectedMoveVersion
    });
  }, delayMs);

  if (room.botMoveTimer.unref) room.botMoveTimer.unref();
}

function executeMoveForPlayer(room, player, payload = {}) {
  if (!room || !room.match) {
    return { ok: false, error: 'Pertandingan tidak ditemukan.' };
  }

  const m = room.match;
  if (m.status !== 'active') {
    return { ok: false, error: 'Pertandingan sudah berakhir atau belum aktif.' };
  }

  if (!player) {
    return { ok: false, error: 'Akses ditolak: kamu bukan peserta dalam pertandingan ini.' };
  }

  // Validasi giliran pemain
  const activeTurn = m.chess.turn();
  if (player.color !== activeTurn) {
    return { ok: false, error: 'Bukan giliranmu untuk melangkah.' };
  }

  // Optimistic locking / moveVersion check untuk mencegah duplicate atau race condition
  if (payload.moveVersion !== undefined && payload.moveVersion !== null) {
    if (Number(payload.moveVersion) !== m.moveVersion) {
      return { ok: false, error: 'Langkah ditolak: versi state tidak sesuai (duplicate atau out-of-sync).' };
    }
  }

  // Cek apakah waktu pemain sudah habis di sisi server sebelum langkah diproses
  const now = Date.now();
  const elapsed = Math.max(0, now - (m.lastMoveAt || now));
  if (activeTurn === 'w' && m.whiteRemainingTimeMs - elapsed <= 0) {
    m.whiteRemainingTimeMs = 0;
    completeMatch(room, {
      result: '0-1',
      winnerUserId: m.blackPlayerId,
      terminationReason: 'timeout'
    });
    return { ok: false, error: 'Waktu habis! Pertandingan berakhir dengan timeout.' };
  }
  if (activeTurn === 'b' && m.blackRemainingTimeMs - elapsed <= 0) {
    m.blackRemainingTimeMs = 0;
    completeMatch(room, {
      result: '1-0',
      winnerUserId: m.whitePlayerId,
      terminationReason: 'timeout'
    });
    return { ok: false, error: 'Waktu habis! Pertandingan berakhir dengan timeout.' };
  }

  const from = String(payload.from || '').trim().toLowerCase();
  const to = String(payload.to || '').trim().toLowerCase();
  const promotion = payload.promotion ? String(payload.promotion).trim().toLowerCase() : undefined;

  if (!/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to)) {
    return { ok: false, error: 'Koordinat petak tidak valid.' };
  }
  if (promotion && !['q', 'r', 'b', 'n'].includes(promotion)) {
    return { ok: false, error: 'Pilihan promosi bidak tidak valid.' };
  }

  // Validasi langkah menggunakan chess.js
  let moveResult;
  try {
    moveResult = m.chess.move({ from, to, promotion: promotion || 'q' });
  } catch {
    moveResult = null;
  }

  if (!moveResult) {
    return { ok: false, error: 'Langkah tidak sah menurut aturan catur.' };
  }

  // Hitung pembaruan jam catur + increment
  const incrementMs = (m.incrementSeconds || 0) * 1000;
  if (activeTurn === 'w') {
    m.whiteRemainingTimeMs = Math.max(1, m.whiteRemainingTimeMs - elapsed + incrementMs);
  } else {
    m.blackRemainingTimeMs = Math.max(1, m.blackRemainingTimeMs - elapsed + incrementMs);
  }

  const nextTurn = m.chess.turn();
  const fenAfter = m.chess.fen();
  const nextMoveVersion = m.moveVersion + 1;
  const moveNumber = m.moves.length + 1;

  // Langkah baru otomatis membatalkan tawaran remis yang menggantung dari lawan
  m.drawOffer = null;

  const recordedMove = chessStore.recordMove({
    matchId: m.id,
    moveNumber,
    playerId: player.userId,
    color: activeTurn,
    from: moveResult.from,
    to: moveResult.to,
    promotion: moveResult.promotion || null,
    piece: moveResult.piece,
    captured: moveResult.captured || null,
    flags: moveResult.flags || null,
    san: moveResult.san,
    fenAfter,
    nextTurn,
    elapsedTimeMs: elapsed,
    whiteRemainingTimeMs: m.whiteRemainingTimeMs,
    blackRemainingTimeMs: m.blackRemainingTimeMs,
    moveVersion: nextMoveVersion,
    now
  });

  m.currentFen = fenAfter;
  m.currentTurn = nextTurn;
  m.lastMoveAt = now;
  m.moveVersion = nextMoveVersion;
  m.moves.push(recordedMove);

  const inCheck = m.chess.inCheck();

  emitToRoom(room, 'ChessMoveMade', {
    roomCode: room.code,
    matchId: m.id,
    move: recordedMove,
    currentFen: fenAfter,
    fen: fenAfter,
    currentTurn: nextTurn,
    turn: nextTurn,
    inCheck,
    moveVersion: nextMoveVersion,
    whiteRemainingTimeMs: m.whiteRemainingTimeMs,
    blackRemainingTimeMs: m.blackRemainingTimeMs,
    whiteTimeMs: m.whiteRemainingTimeMs,
    blackTimeMs: m.blackRemainingTimeMs,
    serverNow: now
  });

  emitToRoom(room, 'TurnChanged', {
    roomCode: room.code,
    matchId: m.id,
    currentTurn: nextTurn,
    turn: nextTurn,
    moveVersion: nextMoveVersion,
    serverNow: now
  });

  emitToRoom(room, 'ClockUpdated', {
    roomCode: room.code,
    matchId: m.id,
    whiteRemainingTimeMs: m.whiteRemainingTimeMs,
    blackRemainingTimeMs: m.blackRemainingTimeMs,
    whiteTimeMs: m.whiteRemainingTimeMs,
    blackTimeMs: m.blackRemainingTimeMs,
    turn: nextTurn,
    lastMoveAt: now,
    serverNow: now
  });

  // Cek kondisi akhir permainan (Checkmate, Stalemate, Threefold, Insufficient, 50-move)
  const terminal = detectTerminalCondition(m.chess);
  if (terminal.ended) {
    const winnerUserId =
      terminal.winnerColor === 'w'
        ? m.whitePlayerId
        : terminal.winnerColor === 'b'
        ? m.blackPlayerId
        : null;
    completeMatch(room, {
      result: terminal.result,
      winnerUserId,
      terminationReason: terminal.terminationReason
    });
  } else {
    emitRoomState(room);
    scheduleBotMoveIfNeeded(room);
  }

  return {
    ok: true,
    move: recordedMove,
    currentFen: fenAfter,
    currentTurn: nextTurn,
    inCheck,
    moveVersion: nextMoveVersion,
    status: m.status,
    result: m.result,
    terminationReason: m.terminationReason,
    room: serializeRoomForUser(room, player.userId)
  };
}

function submitMove(socket, payload = {}) {
  const user = resolveUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu.' };

  const room = resolveRoomForAction(user, payload);
  if (!room || !room.match) {
    return { ok: false, error: 'Pertandingan tidak ditemukan.' };
  }

  const player = room.players.find(p => p.userId === user.id);
  if (!player) {
    return { ok: false, error: 'Akses ditolak: kamu bukan peserta dalam pertandingan ini.' };
  }

  return executeMoveForPlayer(room, player, payload);
}

// ==========================================
// DRAW, RESIGN, REMATCH
// ==========================================

function offerDraw(socket, payload = {}) {
  const user = resolveUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu.' };

  const room = resolveRoomForAction(user, payload);
  if (!room || !room.match || room.match.status !== 'active') {
    return { ok: false, error: 'Pertandingan tidak sedang berlangsung.' };
  }

  const player = room.players.find(p => p.userId === user.id);
  if (!player) return { ok: false, error: 'Bukan peserta pertandingan ini.' };

  const m = room.match;
  const now = Date.now();
  if (m.drawOffer && m.drawOffer.expiresAt > now) {
    return { ok: false, error: 'Masih ada tawaran remis yang aktif.' };
  }

  m.drawOffer = {
    fromUserId: user.id,
    byUserId: user.id,
    fromColor: player.color,
    offeredAt: now,
    expiresAt: now + DRAW_OFFER_EXPIRE_MS
  };

  emitToRoom(room, 'DrawOffered', {
    roomCode: room.code,
    matchId: m.id,
    fromUserId: user.id,
    byUserId: user.id,
    fromName: player.name,
    byName: player.name,
    fromColor: player.color,
    expiresAt: m.drawOffer.expiresAt,
    serverNow: now
  });
  emitRoomState(room);

  // Jika lawan adalah Bot, Bot merespons tawaran remis secara otomatis
  const opponent = room.players.find(p => p.userId !== user.id);
  if (opponent && opponent.isBot) {
    if (room.botDrawTimer) clearTimeout(room.botDrawTimer);
    room.botDrawTimer = setTimeout(() => {
      room.botDrawTimer = null;
      if (!room.match || room.match.status !== 'active' || !room.match.drawOffer) return;
      const whiteScore = evaluateBoard(room.match.chess);
      const botScore = opponent.color === 'w' ? whiteScore : -whiteScore;
      // Bot menerima remis bila tertinggal cukup jauh atau langkah sudah panjang & seimbang
      if (botScore <= -250 || (room.match.moves.length >= 50 && Math.abs(botScore) <= 100)) {
        const clocks = computeLiveClocks(room, Date.now());
        room.match.whiteRemainingTimeMs = clocks.whiteRemainingTimeMs;
        room.match.blackRemainingTimeMs = clocks.blackRemainingTimeMs;
        emitToRoom(room, 'DrawAccepted', {
          roomCode: room.code,
          matchId: room.match.id,
          acceptedByUserId: opponent.userId
        });
        completeMatch(room, {
          result: '1/2-1/2',
          winnerUserId: null,
          terminationReason: 'draw_agreement'
        });
      } else {
        room.match.drawOffer = null;
        emitToRoom(room, 'DrawDeclined', {
          roomCode: room.code,
          matchId: room.match.id,
          declinedByUserId: opponent.userId
        });
        emitRoomState(room);
      }
    }, 350);
    if (room.botDrawTimer.unref) room.botDrawTimer.unref();
  }

  return { ok: true, drawOffer: m.drawOffer };
}

function acceptDraw(socket, payload = {}) {
  const user = resolveUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu.' };

  const room = resolveRoomForAction(user, payload);
  if (!room || !room.match || room.match.status !== 'active') {
    return { ok: false, error: 'Pertandingan tidak sedang berlangsung.' };
  }

  const m = room.match;
  const now = Date.now();
  if (!m.drawOffer || m.drawOffer.expiresAt <= now) {
    m.drawOffer = null;
    return { ok: false, error: 'Tidak ada tawaran remis yang aktif.' };
  }
  if (m.drawOffer.fromUserId === user.id) {
    return { ok: false, error: 'Hanya lawan yang dapat menerima tawaran remis.' };
  }

  const clocks = computeLiveClocks(room, now);
  m.whiteRemainingTimeMs = clocks.whiteRemainingTimeMs;
  m.blackRemainingTimeMs = clocks.blackRemainingTimeMs;

  emitToRoom(room, 'DrawAccepted', {
    roomCode: room.code,
    matchId: m.id,
    acceptedByUserId: user.id
  });

  completeMatch(room, {
    result: '1/2-1/2',
    winnerUserId: null,
    terminationReason: 'draw_agreement'
  });

  return { ok: true, room: serializeRoomForUser(room, user.id) };
}

function declineDraw(socket, payload = {}) {
  const user = resolveUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu.' };

  const room = resolveRoomForAction(user, payload);
  if (!room || !room.match || room.match.status !== 'active') {
    return { ok: false, error: 'Pertandingan tidak sedang berlangsung.' };
  }

  const m = room.match;
  if (!m.drawOffer) {
    return { ok: false, error: 'Tidak ada tawaran remis yang aktif.' };
  }
  if (m.drawOffer.fromUserId === user.id) {
    return { ok: false, error: 'Hanya lawan yang dapat menolak tawaran remis.' };
  }

  m.drawOffer = null;
  emitToRoom(room, 'DrawDeclined', {
    roomCode: room.code,
    matchId: m.id,
    declinedByUserId: user.id
  });
  emitRoomState(room);

  return { ok: true };
}

function resignMatch(socket, payload = {}) {
  const user = resolveUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu.' };

  const room = resolveRoomForAction(user, payload);
  if (!room || !room.match || room.match.status !== 'active') {
    return { ok: false, error: 'Pertandingan tidak sedang berlangsung.' };
  }

  const player = room.players.find(p => p.userId === user.id);
  if (!player) return { ok: false, error: 'Bukan peserta pertandingan ini.' };

  const m = room.match;
  const now = Date.now();
  const clocks = computeLiveClocks(room, now);
  m.whiteRemainingTimeMs = clocks.whiteRemainingTimeMs;
  m.blackRemainingTimeMs = clocks.blackRemainingTimeMs;

  const winnerColor = player.color === 'w' ? 'b' : 'w';
  const result = winnerColor === 'w' ? '1-0' : '0-1';
  const winnerUserId = winnerColor === 'w' ? m.whitePlayerId : m.blackPlayerId;

  emitToRoom(room, 'PlayerResigned', {
    roomCode: room.code,
    matchId: m.id,
    resignedUserId: user.id,
    resignedName: player.name,
    resignedColor: player.color,
    winnerUserId,
    winnerId: winnerUserId,
    result
  });

  completeMatch(room, {
    result,
    winnerUserId,
    terminationReason: 'resigned'
  });

  return { ok: true, result, winnerUserId, room: serializeRoomForUser(room, user.id) };
}

function requestRematch(socket, payload = {}) {
  const user = resolveUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu.' };

  const room = resolveRoomForAction(user, payload);
  if (!room || !room.match) {
    return { ok: false, error: 'Room tidak ditemukan.' };
  }

  const m = room.match;
  if (m.status !== 'completed') {
    return { ok: false, error: 'Rematch hanya dapat diminta setelah pertandingan selesai.' };
  }

  const player = room.players.find(p => p.userId === user.id);
  if (!player) return { ok: false, error: 'Bukan peserta pertandingan ini.' };
  if (room.players.length < 2) {
    return { ok: false, error: 'Lawan sudah meninggalkan room.' };
  }

  m.rematchRequests.add(user.id);
  for (const p of room.players) {
    if (p.isBot) m.rematchRequests.add(p.userId);
  }

  emitToRoom(room, 'RematchRequested', {
    roomCode: room.code,
    matchId: m.id,
    fromUserId: user.id,
    byUserId: user.id,
    fromName: player.name,
    byName: player.name,
    rematchRequests: Array.from(m.rematchRequests)
  });

  // Jika kedua pemain setuju rematch, buat match baru dengan ID baru dan tukar warna bidak
  if (room.players.every(p => m.rematchRequests.has(p.userId))) {
    const oldMatch = m;
    const newMatch = startMatchInRoom(room, { matchType: 'rematch', swapColors: true });
    if (oldMatch && newMatch) {
      oldMatch.nextMatchId = newMatch.id;
    }
    return {
      ok: true,
      started: true,
      newMatchId: newMatch?.id || null,
      room: serializeRoomForUser(room, user.id)
    };
  }

  emitRoomState(room);
  return {
    ok: true,
    started: false,
    rematchRequests: Array.from(m.rematchRequests),
    room: serializeRoomForUser(room, user.id)
  };
}

// ==========================================
// LEAVE ROOM & DISCONNECT / RECONNECT
// ==========================================

function leaveRoom(socket, payload = {}) {
  const user = resolveUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu.' };

  clearMatchmakingTimer(user.id);
  matchmakingQueue.delete(user.id);
  const code = String(payload.roomCode || userActiveRoom.get(user.id) || '').toUpperCase();
  const room = chessRooms.get(code);
  if (!room) {
    userActiveRoom.delete(user.id);
    return { ok: true };
  }

  // Jika meninggalkan saat pertandingan masih aktif, dianggap menyerah (resign)
  if (room.phase === 'playing' && room.match && room.match.status === 'active') {
    resignMatch(socket, { roomCode: room.code, token: payload.token });
  }

  userActiveRoom.delete(user.id);
  if (socket) socket.leave(socketRoomName(room.code));

  room.players = room.players.filter(p => p.userId !== user.id);

  if (room.players.length === 0 || room.players.every(p => p.isBot)) {
    closeRoom(room, 'Semua pemain telah keluar.');
  } else {
    if (room.hostUserId === user.id) {
      room.hostUserId = room.players[0].userId;
    }
    emitRoomState(room);
  }

  return { ok: true };
}

function handleDisconnect(socket) {
  const userId = socket?.data?.userId;
  if (!userId) return;

  // Hapus dari antrean matchmaking bila sedang mengantre
  clearMatchmakingTimer(userId);
  matchmakingQueue.delete(userId);

  const code = userActiveRoom.get(userId);
  if (!code) return;
  const room = chessRooms.get(code);
  if (!room) return;

  const player = room.players.find(p => p.userId === userId);
  if (!player) return;

  // Cek apakah pemain masih punya socket lain yang terhubung
  const otherSock = findPlayerSocket(userId);
  if (otherSock && otherSock.id !== socket.id && otherSock.connected) {
    return;
  }

  const now = Date.now();
  player.connected = false;
  player.disconnectedAt = now;
  player.graceEndsAt = now + DISCONNECT_GRACE_MS;

  emitToRoom(room, 'PlayerDisconnected', {
    roomCode: room.code,
    userId,
    username: player.username,
    name: player.name,
    graceEndsAt: player.graceEndsAt
  });
  emitRoomState(room);

  if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
  player.disconnectTimer = setTimeout(() => {
    if (player.connected) return;
    if (room.phase === 'playing' && room.match && room.match.status === 'active') {
      const winnerColor = player.color === 'w' ? 'b' : 'w';
      const result = winnerColor === 'w' ? '1-0' : '0-1';
      const winnerUserId = winnerColor === 'w' ? room.match.whitePlayerId : room.match.blackPlayerId;
      completeMatch(room, {
        result,
        winnerUserId,
        terminationReason: 'abandonment'
      });
    } else if (room.phase === 'lobby') {
      room.players = room.players.filter(p => p.userId !== userId);
      userActiveRoom.delete(userId);
      if (room.players.length === 0) {
        closeRoom(room, 'Pemain terputus dari lobi.');
      } else {
        if (room.hostUserId === userId) room.hostUserId = room.players[0].userId;
        emitRoomState(room);
      }
    }
  }, DISCONNECT_GRACE_MS);

  if (player.disconnectTimer.unref) player.disconnectTimer.unref();
}

const ALLOWED_REACTIONS = ['🎲', '🔥', '👏', '😂', '😭', '👑', '⚡', '🎯'];
const MAX_CHESS_CHATS = 50;

function playerThemeColor(room, player) {
  if (!player) return 'blue';
  if (player.color === 'w') return 'blue';
  if (player.color === 'b') return 'red';
  const idx = room?.players?.findIndex(p => p.userId === player.userId) ?? 0;
  return idx === 0 ? 'blue' : 'red';
}

function sendReaction(socket, payload = {}) {
  const user = resolveUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu.' };

  const emoji = String(payload?.emoji || '').trim();
  if (!ALLOWED_REACTIONS.includes(emoji)) {
    return { ok: false, error: 'Reaksi tidak valid.' };
  }

  const room = resolveRoomForAction(user, payload);
  if (!room) return { ok: false, error: 'Room tidak ditemukan.' };

  const player = room.players.find(p => p.userId === user.id);
  if (!player) return { ok: false, error: 'Kamu bukan peserta room ini.' };

  const color = playerThemeColor(room, player);
  emitToRoom(room, 'room:reaction', {
    id: Date.now() + Math.random(),
    playerId: user.id,
    playerName: player.name,
    color,
    emoji
  });
  return { ok: true };
}

function sendChat(socket, payload = {}) {
  const user = resolveUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu.' };

  const room = resolveRoomForAction(user, payload);
  if (!room) return { ok: false, error: 'Room tidak ditemukan.' };

  const player = room.players.find(p => p.userId === user.id);
  if (!player) return { ok: false, error: 'Kamu bukan peserta room ini.' };

  const cleanText = String(payload?.text || '').trim().slice(0, 140);
  if (!cleanText) return { ok: false, error: 'Pesan tidak boleh kosong.' };

  if (!Array.isArray(room.chats)) room.chats = [];

  let replyTo = null;
  if (payload?.replyToId !== undefined && payload?.replyToId !== null && payload?.replyToId !== '') {
    const target = room.chats.find(c => String(c.id) === String(payload.replyToId));
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

  const color = playerThemeColor(room, player);
  const chatMsg = {
    id: Date.now() + Math.random(),
    senderId: user.id,
    senderName: player.name,
    senderAvatar: player.avatar || '♟️',
    senderColor: color,
    text: cleanText,
    replyTo,
    time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
  };

  room.chats.push(chatMsg);
  if (room.chats.length > MAX_CHESS_CHATS) room.chats.shift();
  emitToRoom(room, 'chess:chat_message', chatMsg);
  return { ok: true, message: chatMsg };
}

function getActiveRoomForUser(userId) {
  if (!userId) return null;
  const code = userActiveRoom.get(userId);
  if (!code) return null;
  const room = chessRooms.get(code);
  if (!room) {
    userActiveRoom.delete(userId);
    return null;
  }
  return serializeRoomForUser(room, userId);
}

function getRoomByMatchId(matchId, viewerUserId = null) {
  const room = roomsByMatchId.get(matchId);
  if (!room) return null;
  return serializeRoomForUser(room, viewerUserId);
}

function stopAllTimers() {
  for (const t of matchmakingTimers.values()) {
    clearTimeout(t);
  }
  matchmakingTimers.clear();
  for (const room of chessRooms.values()) {
    clearRoomTimers(room);
  }
}

function closeAllRoomsForShutdown() {
  for (const t of matchmakingTimers.values()) {
    clearTimeout(t);
  }
  matchmakingTimers.clear();
  for (const room of Array.from(chessRooms.values())) {
    closeRoom(room, 'Server sedang dimuat ulang.');
  }
  matchmakingQueue.clear();
  userActiveRoom.clear();
}

module.exports = {
  chessRooms,
  roomsByMatchId,
  matchmakingQueue,
  init,
  setTimings,
  getTimings,
  joinMatchmaking,
  leaveMatchmaking,
  playVsBot,
  createRoom,
  joinRoom,
  configureRoom,
  setPlayerReady,
  submitMove,
  offerDraw,
  acceptDraw,
  declineDraw,
  resignMatch,
  requestRematch,
  sendChat,
  sendReaction,
  leaveRoom,
  handleDisconnect,
  getActiveRoomForUser,
  getRoomByMatchId,
  serializeRoomForUser,
  startMatchInRoom,
  stopAllTimers,
  closeAllRoomsForShutdown
};
