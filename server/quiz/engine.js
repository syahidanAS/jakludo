// Authoritative Multiplayer Engine untuk Monster Quiz Battle.
// Mengelola siklus hidup room, matchmaking, pemilihan monster, timer sinkron server (15 detik),
// evaluasi jawaban dan serangan (-10 HP), pencegahan event ganda, serta grace period disconnect 30 detik.
const { canAwardPoints } = require('../lib/rewards');
const crypto = require('crypto');
const db = require('../db');
const quizStore = require('./store');
const social = require('../social/store');
const { INITIAL_HP, ATTACK_DAMAGE, getMonster, listMonsters, BOT_PROFILES } = require('./monsters');
const { buildRoundQuestionPayload } = require('./questions');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 3;
// Hadiah hanya untuk pemenang; syarat lengkapnya di server/lib/rewards.js (ada lawan asli, bukan forfeit)
const WIN_REWARD_POINTS = 10;
const DEFAULT_SLOT_MONSTERS = ['emberon', 'aquaris', 'terragon'];

const DEFAULT_TIMINGS = {
  countdownMs: 3000,
  questionDurationMs: 15000,
  roundTransitionMs: 3200,
  disconnectGraceMs: 30000,
  maxRounds: 20,
  botMatchmakingDelayMs: 5000
};

const timings = { ...DEFAULT_TIMINGS };

function setTimings(overrides = {}) {
  Object.assign(timings, DEFAULT_TIMINGS, overrides);
}

function getTimings() {
  return { ...timings };
}

let ioInstance = null;
// code -> room object
const quizRooms = new Map();
// userId -> roomCode (1 room aktif per user pada satu waktu)
const userRoomMap = new Map();
// Antrean matchmaking: Map<userId, { userId, socketId, monsterId, joinedAt }>
const matchmakingQueue = new Map();
// Timer matchmaking bot per user: Map<userId, Timeout>
const matchmakingTimers = new Map();

function init(io) {
  ioInstance = io;
}

function socketRoomName(code) {
  return `quiz:${code}`;
}

function makeQuizRoomCode(existingLudoRooms = null) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 5; i++) {
      code += chars[crypto.randomInt(0, chars.length)];
    }
  } while (quizRooms.has(code) || (existingLudoRooms && existingLudoRooms.has(code)));
  return code;
}

/**
 * Pure function aturan battle Monster Quiz Battle (TAHAP 2):
 * - A benar, B salah -> Monster A menyerang Monster B (HP B -10)
 * - A salah, B benar -> Monster B menyerang Monster A (HP A -10)
 * - A benar, B benar -> tidak ada serangan (0 damage)
 * - A salah, B salah -> tidak ada serangan (0 damage)
 * - HP selalu berada di rentang 0..100
 */
function evaluateRoundOutcome({ p0Correct, p1Correct, p0Hp, p1Hp, p0UserId, p1UserId }) {
  const clampHp = hp => Math.max(0, Math.min(INITIAL_HP, Number(hp) || 0));
  const cur0 = clampHp(p0Hp);
  const cur1 = clampHp(p1Hp);

  if (p0Correct && !p1Correct) {
    const next1 = clampHp(cur1 - ATTACK_DAMAGE);
    return {
      outcome: 'p0_attack',
      attackerUserId: p0UserId,
      targetUserId: p1UserId,
      damage: ATTACK_DAMAGE,
      p0HpBefore: cur0,
      p1HpBefore: cur1,
      p0HpAfter: cur0,
      p1HpAfter: next1
    };
  }

  if (!p0Correct && p1Correct) {
    const next0 = clampHp(cur0 - ATTACK_DAMAGE);
    return {
      outcome: 'p1_attack',
      attackerUserId: p1UserId,
      targetUserId: p0UserId,
      damage: ATTACK_DAMAGE,
      p0HpBefore: cur0,
      p1HpBefore: cur1,
      p0HpAfter: next0,
      p1HpAfter: cur1
    };
  }

  if (p0Correct && p1Correct) {
    return {
      outcome: 'both_correct',
      attackerUserId: null,
      targetUserId: null,
      damage: 0,
      p0HpBefore: cur0,
      p1HpBefore: cur1,
      p0HpAfter: cur0,
      p1HpAfter: cur1
    };
  }

  return {
    outcome: 'both_wrong',
    attackerUserId: null,
    targetUserId: null,
    damage: 0,
    p0HpBefore: cur0,
    p1HpBefore: cur1,
    p0HpAfter: cur0,
    p1HpAfter: cur1
  };
}

function clearMatchmakingTimer(userId) {
  if (!userId) return;
  const timer = matchmakingTimers.get(userId);
  if (timer) {
    clearTimeout(timer);
    matchmakingTimers.delete(userId);
  }
}

function clearRoomTimers(room) {
  if (!room) return;
  if (room.countdownTimer) {
    clearTimeout(room.countdownTimer);
    room.countdownTimer = null;
  }
  if (room.roundTimer) {
    clearTimeout(room.roundTimer);
    room.roundTimer = null;
  }
  if (room.transitionTimer) {
    clearTimeout(room.transitionTimer);
    room.transitionTimer = null;
  }
  if (room.autoReadyTimer) {
    clearTimeout(room.autoReadyTimer);
    room.autoReadyTimer = null;
  }
  if (room.botTimers) {
    for (const t of room.botTimers) {
      clearTimeout(t);
    }
    room.botTimers.clear();
  }
}

function clearPlayerDisconnectTimer(player) {
  if (player?.disconnectTimer) {
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
  }
  if (player) {
    player.disconnectedAt = null;
    player.graceEndsAt = null;
  }
}

// Dipanggil saat server dimatikan (deploy/restart). Room kuis hanya ada di memori dan tidak bisa
// dilanjutkan, jadi pemain diberi tahu supaya tidak tertahan di layar pertandingan yang sudah mati.
function closeAllRoomsForShutdown() {
  const reason = 'Server sedang diperbarui. Pertandingan kuis dibatalkan dan tidak dihitung, silakan mulai lagi.';
  for (const room of Array.from(quizRooms.values())) {
    emitToRoom(room, 'quiz:room:closed', { roomCode: room.code, reason });
    closeAndDeleteRoom(room);
  }
}

function stopAllTimers() {
  for (const room of quizRooms.values()) {
    clearRoomTimers(room);
    for (const p of room.players) {
      clearPlayerDisconnectTimer(p);
    }
  }
  for (const timer of matchmakingTimers.values()) {
    clearTimeout(timer);
  }
  matchmakingTimers.clear();
  matchmakingQueue.clear();
}

// Stok hint hanya dikirim ke pemiliknya; lawan tidak boleh tahu sisa hint pemain lain (null)
function serializePlayer(p, currentRound = null, viewerUserId = null) {
  const monster = getMonster(p.monsterId) || listMonsters()[0];
  const hasAnswered = currentRound ? currentRound.answers.has(p.userId) : false;
  const isViewer = Boolean(viewerUserId) && p.userId === viewerUserId;
  const hintCount = isViewer && !p.isBot ? Number(db.getUserItems(p.userId)?.quizHint || 0) : null;
  return {
    userId: p.userId,
    username: p.username,
    name: p.name,
    avatar: p.avatar || '🎯',
    slot: p.slot,
    monsterId: monster.id,
    monster,
    ready: Boolean(p.ready),
    connected: Boolean(p.connected),
    isBot: Boolean(p.isBot),
    disconnectedAt: p.disconnectedAt || null,
    graceEndsAt: p.graceEndsAt || null,
    hp: typeof p.hp === 'number' ? p.hp : INITIAL_HP,
    maxHp: INITIAL_HP,
    correctAnswers: p.correctAnswers || 0,
    hintCount,
    answeredCurrentRound: hasAnswered
  };
}

/**
 * Bangun state room untuk dikirim ke klien tertentu.
 * Jawaban rahasia lawan TIDAK PERNAH disertakan selama ronde masih berlangsung!
 */
function serializeRoomForUser(room, viewerUserId = null) {
  if (!room) return null;
  const currentRound = room.match?.currentRound || null;
  const players = room.players
    .slice()
    .sort((a, b) => a.slot - b.slot)
    .map(p => serializePlayer(p, currentRound, viewerUserId));

  let activeQuestion = null;
  let mySubmittedIndex = null;
  let myEliminatedOptions = [];

  if (currentRound) {
    activeQuestion = currentRound.clientQuestion;
    if (viewerUserId && currentRound.answers.has(viewerUserId)) {
      mySubmittedIndex = currentRound.answers.get(viewerUserId).selectedIndex;
    }
    if (viewerUserId && currentRound.hintsUsed?.has(viewerUserId)) {
      myEliminatedOptions = currentRound.hintsUsed.get(viewerUserId) || [];
    }
  }

  return {
    id: room.id,
    code: room.code,
    groupId: room.groupId || null,
    maxPlayers: MAX_PLAYERS,
    minPlayers: MIN_PLAYERS,
    source: room.source,
    phase: room.phase, // 'lobby' | 'countdown' | 'question' | 'round_result' | 'finished'
    hostUserId: room.hostUserId,
    serverNow: Date.now(),
    countdownEndsAt: room.countdownEndsAt || null,
    players,
    chats: Array.isArray(room.chats) ? room.chats : [],
    match: room.match
      ? {
          id: room.match.id,
          status: room.match.status,
          roundNo: room.match.roundNo,
          maxRounds: room.match.maxRounds,
          startedAt: room.match.startedAt,
          finishedAt: room.match.finishedAt || null,
          winnerUserId: room.match.winnerUserId || null,
          rewardPoints: room.match.rewardPoints || 0,
          endReason: room.match.endReason || null,
          question: activeQuestion,
          mySubmittedIndex,
          myEliminatedOptions,
          lastRoundResult: room.match.lastRoundResult || null
        }
      : null
  };
}

function emitToRoom(room, event, payload) {
  if (!ioInstance || !room) return;
  ioInstance.to(socketRoomName(room.code)).emit(event, payload);
}

function emitRoomState(room) {
  if (!ioInstance || !room) return;
  for (const p of room.players) {
    if (p.socketId && p.connected) {
      const sock = ioInstance.sockets.sockets.get(p.socketId);
      if (sock) {
        sock.emit('quiz:room:state', serializeRoomForUser(room, p.userId));
      }
    }
  }
}

function buildPlayerEntry(user, socketId, slot, preferredMonsterId = null) {
  const defaultMonster = DEFAULT_SLOT_MONSTERS[slot] || 'emberon';
  const validMonster = getMonster(preferredMonsterId) || getMonster(defaultMonster);
  return {
    userId: user.id,
    username: user.username,
    name: user.name,
    avatar: user.avatar || '🎯',
    socketId,
    slot,
    monsterId: validMonster.id,
    ready: false,
    connected: true,
    isBot: false,
    disconnectedAt: null,
    graceEndsAt: null,
    disconnectTimer: null,
    startHp: INITIAL_HP,
    hp: INITIAL_HP,
    correctAnswers: 0
  };
}

function buildBotPlayerEntry(botProfile, slot, preferredMonsterId = null) {
  const monsterId = preferredMonsterId || botProfile.monsterId || DEFAULT_SLOT_MONSTERS[slot] || 'aquaris';
  const validMonster = getMonster(monsterId) || listMonsters()[0];
  return {
    userId: botProfile.id,
    username: botProfile.username,
    name: botProfile.name,
    avatar: botProfile.avatar || '1',
    socketId: null,
    slot,
    monsterId: validMonster.id,
    ready: true,
    connected: true,
    isBot: true,
    disconnectedAt: null,
    graceEndsAt: null,
    disconnectTimer: null,
    startHp: INITIAL_HP,
    hp: INITIAL_HP,
    correctAnswers: 0
  };
}

function removeFromMatchmaking(userId) {
  matchmakingQueue.delete(userId);
  clearMatchmakingTimer(userId);
}

function authenticateSocketUser(socket, payload = {}) {
  const token = payload?.token || payload?.authToken || socket?.data?.token || '';
  if (typeof token === 'string' && token) {
    const user = db.getUserByToken(token);
    if (user) {
      socket.data.userId = user.id;
      socket.data.token = token;
      return user;
    }
  }
  if (socket?.data?.userId) {
    return db.getUserById(socket.data.userId);
  }
  return null;
}

// ==========================================
// PEMBUATAN ROOM, JOIN, & MATCHMAKING
// ==========================================

function createRoom(socket, payload = {}, existingLudoRooms = null) {
  const user = authenticateSocketUser(socket, payload);
  if (!user) {
    return { ok: false, error: 'Silakan login terlebih dahulu untuk bermain Monster Quiz Battle.' };
  }

  const groupId = typeof payload?.groupId === 'string' && payload.groupId.trim() ? payload.groupId.trim() : null;
  if (groupId && !social.isGroupMember(groupId, user.id)) {
    return { ok: false, error: 'Kamu harus menjadi anggota grup untuk membuat match grup.' };
  }

  removeFromMatchmaking(user.id);

  // Jika user masih berada di room lama yang belum selesai, keluarkan dulu jika hanya di lobby
  const prevCode = userRoomMap.get(user.id);
  if (prevCode && quizRooms.has(prevCode)) {
    const prevRoom = quizRooms.get(prevCode);
    if (prevRoom.phase === 'lobby' || prevRoom.phase === 'finished') {
      leaveRoom(socket, { code: prevCode, userId: user.id });
    } else if (!groupId) {
      // Rejoin room aktif jika sedang bertanding (kecuali membuat match grup baru)
      return joinRoom(socket, { ...payload, code: prevCode });
    }
  }

  const code = makeQuizRoomCode(existingLudoRooms);
  const roomId = 'qroom_' + crypto.randomUUID();
  const now = Date.now();
  const p0 = buildPlayerEntry(user, socket.id, 0, payload.monsterId);

  const room = {
    id: roomId,
    code,
    groupId,
    source: 'code',
    phase: 'lobby',
    hostUserId: user.id,
    createdAt: now,
    countdownEndsAt: null,
    players: [p0],
    match: null,
    countdownTimer: null,
    roundTimer: null,
    transitionTimer: null
  };

  quizRooms.set(code, room);
  userRoomMap.set(user.id, code);
  socket.join(socketRoomName(code));
  socket.data.quizRoom = code;

  quizStore.recordRoomCreated({ roomId, code, createdBy: user.id, source: 'code', createdAt: now });
  quizStore.recordRoomPlayerJoined({ roomId, userId: user.id, slot: 0, monsterId: p0.monsterId, joinedAt: now });

  const statePayload = serializeRoomForUser(room, user.id);
  socket.emit('room.created', { roomCode: code, room: statePayload });
  socket.emit('room.joined', { roomCode: code, reconnected: false, room: statePayload });
  emitRoomState(room);

  if (groupId) {
    social.postGroupMatchMessage(groupId, user.id, code, 'quiz').catch(err => {
      console.error('[quiz group match msg]', err);
    });
  }

  return { ok: true, code, groupId, room: statePayload };
}

function joinRoom(socket, payload = {}) {
  const user = authenticateSocketUser(socket, payload);
  if (!user) {
    return { ok: false, error: 'Silakan login terlebih dahulu untuk bergabung ke room.' };
  }

  const rawCode = String(payload.code || userRoomMap.get(user.id) || '').trim().toUpperCase();
  if (!rawCode) {
    return { ok: false, error: 'Masukkan kode room yang valid.' };
  }

  const room = quizRooms.get(rawCode);
  if (!room) {
    return { ok: false, error: 'Room Monster Quiz Battle tidak ditemukan atau sudah ditutup.' };
  }

  removeFromMatchmaking(user.id);

  // Cek apakah pemain ini sudah ada di dalam room (reconnect!)
  const existingPlayer = room.players.find(p => p.userId === user.id);
  if (existingPlayer) {
    const wasDisconnected = !existingPlayer.connected;
    clearPlayerDisconnectTimer(existingPlayer);
    existingPlayer.connected = true;
    existingPlayer.socketId = socket.id;
    existingPlayer.name = user.name || existingPlayer.name;
    existingPlayer.avatar = user.avatar || existingPlayer.avatar;

    userRoomMap.set(user.id, room.code);
    socket.join(socketRoomName(room.code));
    socket.data.quizRoom = room.code;

    const statePayload = serializeRoomForUser(room, user.id);
    socket.emit('room.joined', { roomCode: room.code, reconnected: true, room: statePayload });
    if (wasDisconnected) {
      emitToRoom(room, 'player.reconnected', {
        roomCode: room.code,
        userId: user.id,
        name: existingPlayer.name,
        slot: existingPlayer.slot,
        serverNow: Date.now()
      });
    }
    emitRoomState(room);
    return { ok: true, code: room.code, reconnected: true, room: statePayload };
  }

  if (room.groupId && !social.isGroupMember(room.groupId, user.id)) {
    return { ok: false, error: 'Room Monster Quiz ini khusus untuk anggota grup.' };
  }

  // Pemain baru bergabung (maksimal 3 pemain)
  if (room.players.length >= MAX_PLAYERS) {
    return { ok: false, error: `Room sudah penuh (maksimal ${MAX_PLAYERS} pemain).` };
  }
  if (room.phase !== 'lobby') {
    return { ok: false, error: 'Pertandingan di room ini sudah dimulai.' };
  }

  // Jika user punya room lobby lain, keluarkan dulu
  const prevCode = userRoomMap.get(user.id);
  if (prevCode && prevCode !== room.code && quizRooms.has(prevCode)) {
    leaveRoom(socket, { code: prevCode, userId: user.id });
  }

  const usedSlots = new Set(room.players.map(p => p.slot));
  let slot = 0;
  for (let s = 0; s < MAX_PLAYERS; s++) {
    if (!usedSlots.has(s)) {
      slot = s;
      break;
    }
  }
  const takenMonsters = new Set(room.players.map(p => p.monsterId));
  const defaultMonster =
    DEFAULT_SLOT_MONSTERS.find(mId => !takenMonsters.has(mId)) || DEFAULT_SLOT_MONSTERS[slot] || 'aquaris';
  const newPlayer = buildPlayerEntry(user, socket.id, slot, payload.monsterId || defaultMonster);

  room.players.push(newPlayer);
  room.players.sort((a, b) => a.slot - b.slot);
  userRoomMap.set(user.id, room.code);
  socket.join(socketRoomName(room.code));
  socket.data.quizRoom = room.code;

  quizStore.recordRoomPlayerJoined({
    roomId: room.id,
    userId: user.id,
    slot,
    monsterId: newPlayer.monsterId,
    joinedAt: Date.now()
  });

  const statePayload = serializeRoomForUser(room, user.id);
  emitToRoom(room, 'room.joined', {
    roomCode: room.code,
    userId: user.id,
    slot,
    reconnected: false,
    room: serializeRoomForUser(room, null)
  });
  emitRoomState(room);

  return { ok: true, code: room.code, reconnected: false, room: statePayload };
}

function matchUserWithBot(socket, user, requestedMonsterId, existingLudoRooms = null) {
  if (!matchmakingQueue.has(user.id)) return null;
  matchmakingQueue.delete(user.id);
  clearMatchmakingTimer(user.id);

  // Pilih bot yang monsternya berbeda dari pilihan pemain
  const userMonster = requestedMonsterId || 'emberon';
  const candidates = BOT_PROFILES.filter(b => b.monsterId !== userMonster);
  const botProfile = candidates.length > 0
    ? candidates[crypto.randomInt(0, candidates.length)]
    : BOT_PROFILES[crypto.randomInt(0, BOT_PROFILES.length)];

  const code = makeQuizRoomCode(existingLudoRooms);
  const roomId = 'qroom_' + crypto.randomUUID();
  const now = Date.now();
  const p0 = buildPlayerEntry(user, socket.id, 0, userMonster);
  const p1 = buildBotPlayerEntry(botProfile, 1);

  const room = {
    id: roomId,
    code,
    source: 'matchmaking',
    phase: 'lobby',
    hostUserId: user.id,
    createdAt: now,
    countdownEndsAt: null,
    players: [p0, p1],
    match: null,
    countdownTimer: null,
    roundTimer: null,
    transitionTimer: null,
    autoReadyTimer: null,
    botTimers: new Set()
  };

  quizRooms.set(code, room);
  userRoomMap.set(user.id, code);

  socket.join(socketRoomName(code));
  socket.data.quizRoom = code;

  quizStore.recordRoomCreated({ roomId, code, createdBy: user.id, source: 'matchmaking', createdAt: now });
  quizStore.recordRoomPlayerJoined({ roomId, userId: user.id, slot: 0, monsterId: p0.monsterId, joinedAt: now });
  quizStore.recordRoomPlayerJoined({ roomId, userId: botProfile.id, slot: 1, monsterId: p1.monsterId, joinedAt: now });

  socket.emit('room.created', { roomCode: code, room: serializeRoomForUser(room, user.id) });
  emitToRoom(room, 'room.joined', {
    roomCode: code,
    matched: true,
    reconnected: false,
    userId: user.id,
    room: serializeRoomForUser(room, null)
  });
  emitRoomState(room);

  return room;
}

function joinMatchmaking(socket, payload = {}, existingLudoRooms = null) {
  const user = authenticateSocketUser(socket, payload);
  if (!user) {
    return { ok: false, error: 'Silakan login terlebih dahulu untuk mencari lawan.' };
  }

  // Jika masih di room aktif, kembalikan ke room tersebut
  const activeCode = userRoomMap.get(user.id);
  if (activeCode && quizRooms.has(activeCode)) {
    const activeRoom = quizRooms.get(activeCode);
    if (activeRoom.phase !== 'lobby' && activeRoom.phase !== 'finished') {
      return joinRoom(socket, { ...payload, code: activeCode });
    }
    leaveRoom(socket, { code: activeCode, userId: user.id });
  }

  // Cari lawan lain di antrean yang socket-nya masih terhubung
  for (const [otherUserId, entry] of matchmakingQueue.entries()) {
    if (otherUserId === user.id) continue;
    const otherSocket = ioInstance?.sockets?.sockets?.get(entry.socketId);
    if (!otherSocket || !otherSocket.connected) {
      matchmakingQueue.delete(otherUserId);
      clearMatchmakingTimer(otherUserId);
      continue;
    }

    // Pasangan ditemukan! Buat room otomatis untuk kedua pemain
    matchmakingQueue.delete(otherUserId);
    matchmakingQueue.delete(user.id);
    clearMatchmakingTimer(otherUserId);
    clearMatchmakingTimer(user.id);

    const otherUser = db.getUserById(otherUserId);
    if (!otherUser) continue;

    const code = makeQuizRoomCode(existingLudoRooms);
    const roomId = 'qroom_' + crypto.randomUUID();
    const now = Date.now();
    const p0 = buildPlayerEntry(otherUser, otherSocket.id, 0, entry.monsterId);
    const p1 = buildPlayerEntry(
      user,
      socket.id,
      1,
      payload.monsterId || (p0.monsterId === 'aquaris' ? 'emberon' : 'aquaris')
    );

    const room = {
      id: roomId,
      code,
      source: 'matchmaking',
      phase: 'lobby',
      hostUserId: otherUser.id,
      createdAt: now,
      countdownEndsAt: null,
      players: [p0, p1],
      match: null,
      countdownTimer: null,
      roundTimer: null,
      transitionTimer: null,
      autoReadyTimer: null,
      botTimers: new Set()
    };

    quizRooms.set(code, room);
    userRoomMap.set(otherUser.id, code);
    userRoomMap.set(user.id, code);

    otherSocket.join(socketRoomName(code));
    otherSocket.data.quizRoom = code;
    socket.join(socketRoomName(code));
    socket.data.quizRoom = code;

    quizStore.recordRoomCreated({ roomId, code, createdBy: otherUser.id, source: 'matchmaking', createdAt: now });
    quizStore.recordRoomPlayerJoined({ roomId, userId: otherUser.id, slot: 0, monsterId: p0.monsterId, joinedAt: now });
    quizStore.recordRoomPlayerJoined({ roomId, userId: user.id, slot: 1, monsterId: p1.monsterId, joinedAt: now });

    otherSocket.emit('room.created', { roomCode: code, room: serializeRoomForUser(room, otherUser.id) });
    emitToRoom(room, 'room.joined', {
      roomCode: code,
      matched: true,
      reconnected: false,
      userId: user.id,
      room: serializeRoomForUser(room, null)
    });
    emitRoomState(room);

    return { ok: true, matched: true, code, room: serializeRoomForUser(room, user.id) };
  }

  // Belum ada lawan manusia: masukkan ke antrean dan pasang timer bot jika tidak menemukan orang sungguhan
  const entry = {
    userId: user.id,
    socketId: socket.id,
    monsterId: payload.monsterId || 'emberon',
    joinedAt: Date.now()
  };
  matchmakingQueue.set(user.id, entry);

  clearMatchmakingTimer(user.id);
  const botDelay = timings.botMatchmakingDelayMs || 5000;
  const botTimer = setTimeout(() => {
    matchmakingTimers.delete(user.id);
    const queuedEntry = matchmakingQueue.get(user.id);
    if (!queuedEntry) return;
    const sock = ioInstance?.sockets?.sockets?.get(queuedEntry.socketId);
    if (!sock || !sock.connected) {
      matchmakingQueue.delete(user.id);
      return;
    }
    matchUserWithBot(sock, user, queuedEntry.monsterId, existingLudoRooms);
  }, botDelay);
  matchmakingTimers.set(user.id, botTimer);

  return { ok: true, matched: false, searching: true };
}

function leaveMatchmaking(socket, payload = {}) {
  const user = authenticateSocketUser(socket, payload);
  if (user) {
    removeFromMatchmaking(user.id);
  }
  return { ok: true };
}

// ==========================================
// PEMILIHAN MONSTER, READY, & MULAI BATTLE
// ==========================================

function selectMonster(socket, payload = {}) {
  const user = authenticateSocketUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu.' };

  const code = String(payload.code || socket.data.quizRoom || userRoomMap.get(user.id) || '').toUpperCase();
  const room = quizRooms.get(code);
  if (!room) return { ok: false, error: 'Room tidak ditemukan.' };
  if (room.phase !== 'lobby' && room.phase !== 'finished') {
    return { ok: false, error: 'Monster tidak dapat diubah saat pertandingan sedang berjalan.' };
  }

  const player = room.players.find(p => p.userId === user.id);
  if (!player) return { ok: false, error: 'Kamu bukan anggota room ini.' };

  const monster = getMonster(payload.monsterId);
  if (!monster) return { ok: false, error: 'Pilihan monster tidak valid.' };

  player.monsterId = monster.id;
  quizStore.recordRoomPlayerMonster({ roomId: room.id, userId: user.id, monsterId: monster.id });
  emitRoomState(room);

  return { ok: true, monsterId: monster.id, monster };
}

function setPlayerReady(socket, payload = {}) {
  const user = authenticateSocketUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu.' };

  const code = String(payload.code || socket.data.quizRoom || userRoomMap.get(user.id) || '').toUpperCase();
  const room = quizRooms.get(code);
  if (!room) return { ok: false, error: 'Room tidak ditemukan.' };
  if (room.phase !== 'lobby' && room.phase !== 'finished') {
    return { ok: false, error: 'Pertandingan sedang berlangsung.' };
  }

  const player = room.players.find(p => p.userId === user.id);
  if (!player) return { ok: false, error: 'Kamu bukan anggota room ini.' };

  if (payload.monsterId) {
    const monster = getMonster(payload.monsterId);
    if (!monster) return { ok: false, error: 'Pilihan monster tidak valid.' };
    player.monsterId = monster.id;
    quizStore.recordRoomPlayerMonster({ roomId: room.id, userId: user.id, monsterId: monster.id });
  }

  if (!getMonster(player.monsterId)) {
    return { ok: false, error: 'Pilih monster terlebih dahulu sebelum siap.' };
  }

  const nextReady = payload.ready !== undefined ? Boolean(payload.ready) : !player.ready;
  player.ready = nextReady;

  // Pastikan bot selalu siap bertarung
  for (const p of room.players) {
    if (p.isBot) {
      p.ready = true;
    }
  }

  emitToRoom(room, 'player.ready', {
    roomCode: room.code,
    userId: player.userId,
    slot: player.slot,
    monsterId: player.monsterId,
    ready: player.ready
  });
  emitRoomState(room);

  // Jika minimal 2 pemain (maksimal 3 pemain) sudah ada, terhubung, memilih monster, dan semuanya siap -> mulai pertandingan!
  if (
    room.players.length >= MIN_PLAYERS &&
    room.players.length <= MAX_PLAYERS &&
    room.players.every(p => p.ready && p.connected && getMonster(p.monsterId))
  ) {
    startMatchCountdown(room);
  }

  return { ok: true, ready: player.ready };
}

function startMatchCountdown(room) {
  if (!room || (room.phase !== 'lobby' && room.phase !== 'finished')) return;
  clearRoomTimers(room);

  const now = Date.now();
  const matchId = 'qmatch_' + crypto.randomUUID();
  const totalAvailableQuestions = quizStore.listQuestions({ activeOnly: true }).length;
  const maxRounds = Math.min(timings.maxRounds, Math.max(1, totalAvailableQuestions));
  // Batasi soal matematika muncul 2 sampai 3 kali saja per pertandingan
  const targetMathCount = crypto.randomInt(2, 4);

  room.players.sort((a, b) => a.slot - b.slot);
  for (const p of room.players) {
    p.startHp = INITIAL_HP;
    p.hp = INITIAL_HP;
    p.correctAnswers = 0;
  }

  room.phase = 'countdown';
  room.countdownEndsAt = now + timings.countdownMs;
  room.match = {
    id: matchId,
    status: 'in_progress',
    roundNo: 0,
    maxRounds,
    startedAt: now,
    finishedAt: null,
    winnerUserId: null,
    endReason: null,
    usedQuestionIds: new Set(),
    departedPlayers: [], // pemain yang keluar/terputus di tengah match (tetap dicatat kalah)
    mathCount: 0,
    targetMathCount,
    currentRound: null,
    lastRoundResult: null,
    finished: false
  };

  quizStore.recordRoomStatus({ roomId: room.id, status: 'playing' });
  quizStore.recordMatchStarted({
    matchId,
    roomId: room.id,
    maxRounds,
    startedAt: now,
    players: room.players
  });

  emitToRoom(room, 'game.started', {
    roomCode: room.code,
    matchId,
    countdownMs: timings.countdownMs,
    countdownEndsAt: room.countdownEndsAt,
    serverNow: now,
    maxRounds,
    players: room.players.map(p => serializePlayer(p, null))
  });
  emitRoomState(room);

  room.countdownTimer = setTimeout(() => {
    room.countdownTimer = null;
    startNextQuestion(room);
  }, timings.countdownMs);
}

// ==========================================
// SIKLUS RONDE PERTANYAAN, TIMER 15 DETIK & EVALUASI
// ==========================================

function startNextQuestion(room) {
  if (!room || !room.match || room.match.finished) return;
  clearRoomTimers(room);

  const match = room.match;
  if (match.roundNo >= match.maxRounds) {
    return finishMatch(room, 'questions_exhausted');
  }

  // Batasi soal matematika hanya muncul 2 sampai 3 kali saja per pertandingan
  const targetMathCount = match.targetMathCount || 2;
  const currentMathCount = match.mathCount || 0;
  const nextRoundNo = match.roundNo + 1;

  let preferredCategory = 'general';

  if (currentMathCount < targetMathCount) {
    // Tentukan ronde untuk mengeluarkan soal matematika (diselingi soal umum):
    // Contoh target 2: ronde 3 dan 7
    // Contoh target 3: ronde 3, 6, dan 9
    const isMathRound = targetMathCount === 3
      ? (nextRoundNo === 3 || nextRoundNo === 6 || nextRoundNo === 9)
      : (nextRoundNo === 3 || nextRoundNo === 7);

    if (isMathRound) {
      preferredCategory = 'math';
    }
  }

  const question = quizStore.selectRandomUnusedQuestion(match.usedQuestionIds, preferredCategory);

  if (!question) {
    return finishMatch(room, 'questions_exhausted');
  }

  match.usedQuestionIds.add(question.id);
  quizStore.markQuestionShown(question.id);
  if (question.category === 'math') {
    match.mathCount = (match.mathCount || 0) + 1;
  }
  match.roundNo = nextRoundNo;
  room.countdownEndsAt = null;
  room.phase = 'question';

  const now = Date.now();
  const deadlineAt = now + timings.questionDurationMs;
  const roundId = 'qround_' + crypto.randomUUID();
  const built = buildRoundQuestionPayload(question, nextRoundNo, match.maxRounds, now, deadlineAt);

  const round = {
    id: roundId,
    roundNo: nextRoundNo,
    questionId: question.id,
    rawQuestion: question,
    optionOrder: built.optionOrder,
    shuffledCorrectIndex: built.shuffledCorrectIndex,
    clientQuestion: built.clientQuestion,
    startedAt: now,
    deadlineAt,
    answers: new Map(), // userId -> { userId, selectedIndex, isCorrect, timedOut, answeredAt, responseMs }
    hintsUsed: new Map(), // userId -> number[] (2 indeks opsi salah yang dieliminasi)
    resolved: false
  };

  match.currentRound = round;

  emitToRoom(room, 'question.started', {
    roomCode: room.code,
    matchId: match.id,
    roundId,
    roundNo: nextRoundNo,
    maxRounds: match.maxRounds,
    question: built.clientQuestion,
    serverNow: now
  });
  emitRoomState(room);

  scheduleBotAnswers(room, round);

  room.roundTimer = setTimeout(() => {
    room.roundTimer = null;
    resolveCurrentRound(room, 'timeout');
  }, timings.questionDurationMs);
}

function scheduleBotAnswers(room, round) {
  if (!room || !room.match || room.match.finished || !round) return;
  const bots = room.players.filter(p => p.isBot && (p.hp ?? INITIAL_HP) > 0);
  if (bots.length === 0) return;

  if (!room.botTimers) room.botTimers = new Set();

  for (const bot of bots) {
    const qDuration = timings.questionDurationMs;
    const minDelay = Math.max(50, Math.min(3500, Math.floor(qDuration * 0.25)));
    const maxDelay = Math.max(minDelay + 50, Math.min(7500, Math.floor(qDuration * 0.55)));
    const delay = crypto.randomInt(minDelay, maxDelay);

    const timer = setTimeout(() => {
      if (room.botTimers) room.botTimers.delete(timer);
      if (
        !room ||
        !room.match ||
        room.match.finished ||
        room.phase !== 'question' ||
        room.match.currentRound?.id !== round.id ||
        round.resolved ||
        round.answers.has(bot.userId)
      ) {
        return;
      }

      // Akurasi bot: ~70% benar, 30% salah
      const isCorrect = Math.random() < 0.7;
      let selectedIndex = round.shuffledCorrectIndex;
      if (!isCorrect) {
        const wrongIndices = [0, 1, 2, 3].filter(idx => idx !== round.shuffledCorrectIndex);
        selectedIndex = wrongIndices[crypto.randomInt(0, wrongIndices.length)];
      }

      const answeredAt = Date.now();
      const responseMs = Math.max(0, Math.min(timings.questionDurationMs, answeredAt - round.startedAt));

      round.answers.set(bot.userId, {
        userId: bot.userId,
        selectedIndex,
        isCorrect: selectedIndex === round.shuffledCorrectIndex,
        timedOut: false,
        answeredAt,
        responseMs
      });

      emitToRoom(room, 'answer.submitted', {
        roomCode: room.code,
        matchId: room.match.id,
        roundId: round.id,
        roundNo: round.roundNo,
        userId: bot.userId,
        slot: bot.slot,
        answered: true,
        answeredAt
      });
      emitRoomState(room);

      const activePlayers = room.players.filter(p => (p.hp ?? INITIAL_HP) > 0);
      if (activePlayers.length > 0 && activePlayers.every(p => round.answers.has(p.userId))) {
        resolveCurrentRound(room, 'both_answered');
      }
    }, delay);

    room.botTimers.add(timer);
  }
}

function useHint(socket, payload = {}) {
  const user = authenticateSocketUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu.' };

  const code = String(payload.code || socket?.data?.quizRoom || userRoomMap.get(user.id) || '').toUpperCase();
  const room = quizRooms.get(code);
  if (!room || !room.match || room.match.finished) {
    return { ok: false, error: 'Pertandingan tidak aktif.' };
  }

  const player = room.players.find(p => p.userId === user.id);
  if (!player) {
    return { ok: false, error: 'Kamu bukan peserta pertandingan ini.' };
  }
  if ((player.hp ?? INITIAL_HP) <= 0) {
    return { ok: false, error: 'Monstermu sudah tumbang (0 HP).' };
  }

  const round = room.match.currentRound;
  if (room.phase !== 'question' || !round || round.resolved) {
    return { ok: false, error: 'Hint hanya bisa digunakan saat waktu menjawab masih berjalan.' };
  }

  const now = Date.now();
  if (now > round.deadlineAt) {
    resolveCurrentRound(room, 'timeout');
    return { ok: false, error: 'Waktu menjawab sudah habis.' };
  }

  if (round.answers.has(user.id)) {
    return { ok: false, error: 'Kamu sudah mengirim jawaban untuk ronde ini.' };
  }

  if (!round.hintsUsed) round.hintsUsed = new Map();
  if (round.hintsUsed.has(user.id)) {
    return { ok: false, error: 'Kamu sudah menggunakan Hint Jawaban pada ronde ini.' };
  }

  const consumed = db.consumeUserItem({ userId: user.id, itemId: 'quizHint' });
  if (!consumed) {
    return { ok: false, error: 'Kamu tidak memiliki item Hints Jawaban. Beli dulu di Toko Item!' };
  }

  // Pilih 2 indeks opsi yang salah untuk dieliminasi (50:50)
  const wrongIndices = [0, 1, 2, 3].filter(idx => idx !== round.shuffledCorrectIndex);
  for (let i = wrongIndices.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    const tmp = wrongIndices[i];
    wrongIndices[i] = wrongIndices[j];
    wrongIndices[j] = tmp;
  }
  const eliminatedIndices = wrongIndices.slice(0, 2).sort((a, b) => a - b);
  round.hintsUsed.set(user.id, eliminatedIndices);

  emitRoomState(room);

  const updatedUser = db.sanitizeUser(db.getUserById(user.id));
  return {
    ok: true,
    roundId: round.id,
    roundNo: round.roundNo,
    eliminatedIndices,
    remainingHints: Number(updatedUser?.inventory?.quizHint || 0),
    user: updatedUser
  };
}

function syncUserInventory(userId) {
  if (!userId) return;
  const code = userRoomMap.get(userId);
  if (!code) return;
  const room = quizRooms.get(code);
  if (room) {
    emitRoomState(room);
  }
}

function submitAnswer(socket, payload = {}) {
  const user = authenticateSocketUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu.' };

  const code = String(payload.code || socket.data.quizRoom || userRoomMap.get(user.id) || '').toUpperCase();
  const room = quizRooms.get(code);
  if (!room || !room.match || room.match.finished) {
    return { ok: false, error: 'Pertandingan tidak aktif.' };
  }

  const player = room.players.find(p => p.userId === user.id);
  if (!player) {
    return { ok: false, error: 'Kamu bukan peserta pertandingan ini.' };
  }
  if ((player.hp ?? INITIAL_HP) <= 0) {
    return { ok: false, error: 'Monstermu sudah tumbang (0 HP).' };
  }

  const round = room.match.currentRound;
  if (room.phase !== 'question' || !round || round.resolved) {
    return { ok: false, error: 'Waktu menjawab untuk ronde ini sudah berakhir.' };
  }

  // Tolak jika klien mengirim untuk ronde atau soal lama
  if (payload.roundId && String(payload.roundId) !== round.id) {
    return { ok: false, error: 'Ronde tidak sesuai (jawaban untuk ronde lama ditolak).' };
  }
  if (payload.roundNo !== undefined && Number(payload.roundNo) !== round.roundNo) {
    return { ok: false, error: 'Nomor ronde tidak sesuai.' };
  }
  if (payload.questionId && String(payload.questionId) !== round.questionId) {
    return { ok: false, error: 'ID pertanyaan tidak sesuai.' };
  }

  // Tolak jawaban ganda / perubahan jawaban setelah submit
  if (round.answers.has(user.id)) {
    return { ok: false, error: 'Jawaban sudah dikirim dan tidak dapat diubah.' };
  }

  const now = Date.now();
  if (now > round.deadlineAt) {
    resolveCurrentRound(room, 'timeout');
    return { ok: false, error: 'Waktu menjawab sudah habis.' };
  }

  const selectedIndex = Number(payload.selectedIndex ?? payload.answerIndex);
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex > 3) {
    return { ok: false, error: 'Pilihan jawaban harus berupa indeks 0 sampai 3.' };
  }
  if (round.hintsUsed?.get(user.id)?.includes(selectedIndex)) {
    return { ok: false, error: 'Opsi jawaban ini sudah dieliminasi oleh Hint.' };
  }

  const isCorrect = selectedIndex === round.shuffledCorrectIndex;
  const responseMs = Math.max(0, Math.min(timings.questionDurationMs, now - round.startedAt));

  round.answers.set(user.id, {
    userId: user.id,
    selectedIndex,
    isCorrect,
    timedOut: false,
    answeredAt: now,
    responseMs
  });

  // Beritahu room bahwa pemain ini sudah menjawab TANPA membocorkan pilihan maupun benar/salahnya
  emitToRoom(room, 'answer.submitted', {
    roomCode: room.code,
    matchId: room.match.id,
    roundId: round.id,
    roundNo: round.roundNo,
    userId: user.id,
    slot: player.slot,
    answered: true,
    answeredAt: now
  });
  emitRoomState(room);

  const activePlayers = room.players.filter(p => (p.hp ?? INITIAL_HP) > 0);
  if (activePlayers.length > 0 && activePlayers.every(p => round.answers.has(p.userId))) {
    resolveCurrentRound(room, 'both_answered');
  }

  return { ok: true, roundId: round.id, roundNo: round.roundNo, submittedIndex: selectedIndex };
}

function resolveCurrentRound(room, triggerReason = 'both_answered') {
  if (!room || !room.match || room.match.finished) return;
  const round = room.match.currentRound;
  // Lock sinkron untuk mencegah eksekusi ganda (idempotent terhadap race timeout vs submit terakhir)
  if (!round || round.resolved) return;
  round.resolved = true;

  if (room.roundTimer) {
    clearTimeout(room.roundTimer);
    room.roundTimer = null;
  }

  const now = Date.now();
  const sortedPlayers = room.players.slice().sort((a, b) => a.slot - b.slot);
  if (sortedPlayers.length < MIN_PLAYERS) return;

  const activePlayers = sortedPlayers.filter(p => (p.hp ?? INITIAL_HP) > 0);

  // Pemain yang belum menjawab hingga waktu habis otomatis dianggap salah (timedOut: true)
  for (const p of sortedPlayers) {
    if (!round.answers.has(p.userId)) {
      round.answers.set(p.userId, {
        userId: p.userId,
        selectedIndex: null,
        isCorrect: false,
        timedOut: true,
        answeredAt: null,
        responseMs: timings.questionDurationMs
      });
    }
  }

  for (const p of activePlayers) {
    const ans = round.answers.get(p.userId);
    if (ans?.isCorrect) {
      p.correctAnswers = (p.correctAnswers || 0) + 1;
    }
  }

  let outcome;
  const hpBeforeByUser = {};
  for (const p of sortedPlayers) {
    hpBeforeByUser[p.userId] = p.hp;
  }

  if (sortedPlayers.length === 2) {
    const [p0, p1] = sortedPlayers;
    const ans0 = round.answers.get(p0.userId);
    const ans1 = round.answers.get(p1.userId);
    outcome = evaluateRoundOutcome({
      p0Correct: ans0.isCorrect,
      p1Correct: ans1.isCorrect,
      p0Hp: p0.hp,
      p1Hp: p1.hp,
      p0UserId: p0.userId,
      p1UserId: p1.userId
    });
    p0.hp = outcome.p0HpAfter;
    p1.hp = outcome.p1HpAfter;
    outcome.attackerUserIds = outcome.attackerUserId ? [outcome.attackerUserId] : [];
    outcome.targetUserIds = outcome.targetUserId ? [outcome.targetUserId] : [];
  } else {
    // Aturan 3 pemain: pemain aktif yang menjawab benar menyerang pemain aktif yang menjawab salah (-10 HP)
    const correctPlayers = activePlayers.filter(p => round.answers.get(p.userId)?.isCorrect);
    const wrongPlayers = activePlayers.filter(p => !round.answers.get(p.userId)?.isCorrect);

    if (correctPlayers.length > 0 && wrongPlayers.length > 0) {
      for (const wp of wrongPlayers) {
        wp.hp = Math.max(0, Math.min(INITIAL_HP, wp.hp - ATTACK_DAMAGE));
      }
      outcome = {
        outcome: 'multi_attack',
        attackerUserId: correctPlayers[0].userId,
        targetUserId: wrongPlayers[0].userId,
        attackerUserIds: correctPlayers.map(p => p.userId),
        targetUserIds: wrongPlayers.map(p => p.userId),
        damage: ATTACK_DAMAGE
      };
    } else if (correctPlayers.length === activePlayers.length && activePlayers.length > 0) {
      outcome = {
        outcome: 'both_correct',
        attackerUserId: null,
        targetUserId: null,
        attackerUserIds: [],
        targetUserIds: [],
        damage: 0
      };
    } else {
      outcome = {
        outcome: 'both_wrong',
        attackerUserId: null,
        targetUserId: null,
        attackerUserIds: [],
        targetUserIds: [],
        damage: 0
      };
    }
  }

  room.phase = 'round_result';

  const answersMap = {};
  const hpMap = {};
  for (const p of sortedPlayers) {
    const ans = round.answers.get(p.userId);
    answersMap[p.userId] = {
      userId: p.userId,
      slot: p.slot,
      selectedIndex: ans.selectedIndex,
      isCorrect: ans.isCorrect,
      timedOut: ans.timedOut,
      responseMs: ans.responseMs
    };
    hpMap[p.userId] = p.hp;
  }

  const resultPayload = {
    eventId: round.id,
    roomCode: room.code,
    matchId: room.match.id,
    roundId: round.id,
    roundNo: round.roundNo,
    questionId: round.questionId,
    triggerReason,
    correctIndex: round.shuffledCorrectIndex,
    correctOption: round.clientQuestion.options[round.shuffledCorrectIndex],
    outcome: outcome.outcome,
    attackerUserId: outcome.attackerUserId,
    targetUserId: outcome.targetUserId,
    attackerUserIds: outcome.attackerUserIds,
    targetUserIds: outcome.targetUserIds,
    damage: outcome.damage,
    answers: answersMap,
    hp: hpMap,
    serverNow: now
  };

  room.match.lastRoundResult = resultPayload;

  quizStore.recordRoundResolved({
    roundId: round.id,
    matchId: room.match.id,
    roundNo: round.roundNo,
    questionId: round.questionId,
    optionOrder: round.optionOrder,
    startedAt: round.startedAt,
    deadlineAt: round.deadlineAt,
    resolvedAt: now,
    attackerUserId: outcome.attackerUserId,
    targetUserId: outcome.targetUserId,
    damage: outcome.damage,
    answers: sortedPlayers.map(p => round.answers.get(p.userId)),
    playerStates: sortedPlayers.map(p => ({
      userId: p.userId,
      hp: p.hp,
      correctAnswers: p.correctAnswers
    }))
  });

  emitToRoom(room, 'answer.result', resultPayload);

  if (outcome.damage > 0 && outcome.attackerUserIds.length > 0 && outcome.targetUserIds.length > 0) {
    const attacker = sortedPlayers.find(p => p.userId === outcome.attackerUserId) || sortedPlayers[0];
    const target = sortedPlayers.find(p => p.userId === outcome.targetUserId) || sortedPlayers[1];
    const hpBefore = hpBeforeByUser[target.userId] ?? INITIAL_HP;
    const attackerSlots = outcome.attackerUserIds
      .map(uid => sortedPlayers.find(p => p.userId === uid)?.slot)
      .filter(s => s !== undefined);
    const targetSlots = outcome.targetUserIds
      .map(uid => sortedPlayers.find(p => p.userId === uid)?.slot)
      .filter(s => s !== undefined);

    emitToRoom(room, 'monster.attacked', {
      eventId: round.id,
      roomCode: room.code,
      matchId: room.match.id,
      roundId: round.id,
      roundNo: round.roundNo,
      attackerUserId: attacker.userId,
      attackerSlot: attacker.slot,
      attackerSlots,
      attackerMonsterId: attacker.monsterId,
      targetUserId: target.userId,
      targetSlot: target.slot,
      targetSlots,
      targetMonsterId: target.monsterId,
      damage: outcome.damage,
      serverNow: now
    });

    emitToRoom(room, 'monster.damaged', {
      eventId: round.id,
      roomCode: room.code,
      matchId: room.match.id,
      roundId: round.id,
      roundNo: round.roundNo,
      targetUserId: target.userId,
      targetSlot: target.slot,
      targetSlots,
      targetMonsterId: target.monsterId,
      attackerUserId: attacker.userId,
      damage: outcome.damage,
      hpBefore,
      hpAfter: target.hp,
      serverNow: now
    });
  }

  emitRoomState(room);

  const aliveAfter = sortedPlayers.filter(p => p.hp > 0);
  const matchEndedByKnockout = sortedPlayers.length === 2
    ? sortedPlayers.some(p => p.hp <= 0)
    : aliveAfter.length <= 1;
  const reachedMaxRounds = round.roundNo >= room.match.maxRounds;

  room.transitionTimer = setTimeout(() => {
    room.transitionTimer = null;
    if (!room.match || room.match.finished) return;
    if (matchEndedByKnockout) {
      finishMatch(room, 'knockout');
    } else if (reachedMaxRounds) {
      finishMatch(room, 'questions_exhausted');
    } else {
      startNextQuestion(room);
    }
  }, timings.roundTransitionMs);
}

// Pemain yang keluar atau terputus di tengah pertandingan: HP jadi 0 dan tetap dicatat kalah saat
// pertandingan selesai, walaupun sudah dihapus dari room (mis. di mode 3 pemain match masih lanjut).
function markPlayerDeparted(room, player) {
  player.hp = 0;
  player.forfeited = true;
  const departed = room.match?.departedPlayers;
  if (departed && !departed.some(d => d.userId === player.userId)) {
    departed.push({ ...player, disconnectTimer: null });
  }
}

function finishMatch(room, endReason = 'knockout', forcedWinnerUserId = null) {
  if (!room || !room.match || room.match.finished) return;
  room.match.finished = true;
  clearRoomTimers(room);

  const now = Date.now();
  const sortedPlayers = room.players.slice().sort((a, b) => a.slot - b.slot);

  let winnerUserId = null;
  if (forcedWinnerUserId) {
    winnerUserId = forcedWinnerUserId;
  } else if (sortedPlayers.length >= 2) {
    let maxHp = -1;
    let leaders = [];
    for (const p of sortedPlayers) {
      if (p.hp > maxHp) {
        maxHp = p.hp;
        leaders = [p];
      } else if (p.hp === maxHp) {
        leaders.push(p);
      }
    }
    if (leaders.length === 1 && maxHp > 0) {
      winnerUserId = leaders[0].userId;
    }
  }

  // Tidak ada poin jika lawannya hanya bot atau menang karena lawan keluar/terputus (anti-farming)
  const eligible = winnerUserId && canAwardPoints(room.players, { endReason });
  const reward = eligible ? db.awardUserPoints(winnerUserId, WIN_REWARD_POINTS) : null;
  const rewardPoints = eligible ? WIN_REWARD_POINTS : 0;

  room.phase = 'finished';
  room.match.status = 'finished';
  room.match.winnerUserId = winnerUserId;
  room.match.rewardPoints = rewardPoints;
  room.match.endReason = endReason;
  room.match.finishedAt = now;
  room.match.currentRound = null;

  for (const p of room.players) {
    p.ready = false;
  }

  // Semua peserta match, termasuk yang sudah keluar lebih dulu
  const participants = room.players.concat(
    (room.match.departedPlayers || []).filter(d => !room.players.some(p => p.userId === d.userId))
  );

  quizStore.recordRoomStatus({ roomId: room.id, status: 'open' });
  const matchRecord = quizStore.recordMatchFinished({
    matchId: room.match.id,
    roomId: room.id,
    winnerUserId,
    endReason,
    maxRounds: room.match.maxRounds,
    roundsPlayed: room.match.roundNo,
    startedAt: room.match.startedAt,
    finishedAt: now,
    players: participants
  });

  const statsByUser = {};
  for (const p of participants) {
    statsByUser[p.userId] = quizStore.getPlayerStats(p.userId);
  }

  emitToRoom(room, 'game.finished', {
    roomCode: room.code,
    matchId: room.match.id,
    winnerUserId,
    rewardPoints,
    winnerReward: reward
      ? {
          userId: winnerUserId,
          points: rewardPoints,
          totalPoints: reward.totalPoints,
          user: reward.user
        }
      : null,
    endReason,
    roundsPlayed: room.match.roundNo,
    startedAt: room.match.startedAt,
    finishedAt: now,
    players: matchRecord.players.map(mp => {
      const rp = participants.find(p => p.userId === mp.userId);
      const monster = getMonster(mp.monsterId);
      return {
        ...mp,
        name: rp?.name || 'Pemain',
        username: rp?.username || 'pemain',
        avatar: rp?.avatar || '🎯',
        monster
      };
    }),
    stats: statsByUser,
    serverNow: now
  });

  emitRoomState(room);

  if (ioInstance) {
    ioInstance.emit('quiz:leaderboard:update', quizStore.getQuizLeaderboard());
  }
}

// ==========================================
// DISCONNECT GRACE PERIOD (30 DETIK), RECONNECT & LEAVE
// ==========================================

function closeAndDeleteRoom(room) {
  if (!room) return;
  clearRoomTimers(room);
  for (const p of room.players) {
    clearPlayerDisconnectTimer(p);
    if (userRoomMap.get(p.userId) === room.code) {
      userRoomMap.delete(p.userId);
    }
  }
  quizRooms.delete(room.code);
  quizStore.recordRoomStatus({ roomId: room.id, status: 'closed', closedAt: Date.now() });
}

function leaveRoom(socket, payload = {}) {
  // Identitas hanya dari login/socket sendiri: userId dari payload diabaikan supaya pemain tidak bisa
  // "mengeluarkan" lawan dari room.
  const user = authenticateSocketUser(socket, payload);
  const userId = user?.id || socket?.data?.userId;
  const code = String(payload.code || socket?.data?.quizRoom || (userId ? userRoomMap.get(userId) : '') || '').toUpperCase();

  if (socket) {
    socket.leave(socketRoomName(code));
    delete socket.data.quizRoom;
  }
  if (userId) {
    removeFromMatchmaking(userId);
  }

  const room = quizRooms.get(code);
  if (!room || !userId) return { ok: true };

  const player = room.players.find(p => p.userId === userId);
  if (!player) return { ok: true };

  clearPlayerDisconnectTimer(player);
  userRoomMap.delete(userId);

  // Jika keluar secara sengaja saat pertandingan sedang berjalan:
  if (room.match && !room.match.finished && (room.phase === 'countdown' || room.phase === 'question' || room.phase === 'round_result')) {
    player.connected = false;
    markPlayerDeparted(room, player);
    const aliveConnected = room.players.filter(p => p.userId !== userId && p.connected && p.hp > 0);
    if (aliveConnected.length <= 1) {
      finishMatch(room, 'forfeit', aliveConnected[0] ? aliveConnected[0].userId : null);
    }
    room.players = room.players.filter(p => p.userId !== userId);
    if (room.players.length === 0) {
      closeAndDeleteRoom(room);
    } else {
      room.players.forEach((p, idx) => { p.slot = idx; });
      room.hostUserId = room.players[0].userId;
      emitRoomState(room);
    }
    return { ok: true };
  }

  // Di lobby atau setelah pertandingan selesai
  room.players = room.players.filter(p => p.userId !== userId);
  if (room.players.length === 0 || room.players.every(p => p.isBot)) {
    closeAndDeleteRoom(room);
  } else {
    room.players.forEach((p, idx) => {
      p.slot = idx;
      p.ready = p.isBot ? true : false;
    });
    room.hostUserId = room.players[0].userId;
    room.phase = 'lobby';
    room.match = null;
    emitRoomState(room);
  }

  return { ok: true };
}

function handleDisconnect(socket) {
  const userId = socket?.data?.userId;
  if (userId) {
    removeFromMatchmaking(userId);
  }

  const code = socket?.data?.quizRoom || (userId ? userRoomMap.get(userId) : null);
  if (!code) return;
  const room = quizRooms.get(code);
  if (!room) return;

  const player = room.players.find(p => p.socketId === socket.id || (userId && p.userId === userId));
  if (!player || !player.connected) return;
  // Disconnect dari socket lama yang datang setelah pemain tersambung lagi lewat socket baru: abaikan
  if (player.socketId && player.socketId !== socket.id) return;

  player.connected = false;
  const now = Date.now();
  player.disconnectedAt = now;
  player.graceEndsAt = now + timings.disconnectGraceMs;

  emitToRoom(room, 'player.disconnected', {
    roomCode: room.code,
    userId: player.userId,
    name: player.name,
    slot: player.slot,
    graceMs: timings.disconnectGraceMs,
    graceEndsAt: player.graceEndsAt,
    serverNow: now
  });
  emitRoomState(room);

  clearPlayerDisconnectTimer(player);
  player.disconnectedAt = now;
  player.graceEndsAt = now + timings.disconnectGraceMs;

  player.disconnectTimer = setTimeout(() => {
    player.disconnectTimer = null;
    if (player.connected) return;

    // Setelah grace period 30 detik berakhir dan pemain belum kembali:
    if (room.match && !room.match.finished && (room.phase === 'countdown' || room.phase === 'question' || room.phase === 'round_result')) {
      markPlayerDeparted(room, player);
      const aliveConnected = room.players.filter(p => p.userId !== player.userId && p.connected && p.hp > 0);
      if (aliveConnected.length <= 1) {
        finishMatch(room, 'forfeit', aliveConnected[0] ? aliveConnected[0].userId : null);
      }
    }

    // Bersihkan pemain yang terputus dari room
    userRoomMap.delete(player.userId);
    room.players = room.players.filter(p => p.userId !== player.userId);
    if (room.players.length === 0 || room.players.every(p => !p.connected || p.isBot)) {
      closeAndDeleteRoom(room);
    } else {
      room.players.forEach((p, idx) => { p.slot = idx; });
      room.hostUserId = room.players[0].userId;
      emitRoomState(room);
    }
  }, timings.disconnectGraceMs);
}

const SLOT_COLORS = ['red', 'blue', 'green', 'yellow'];
const ALLOWED_REACTIONS = ['🎲', '🔥', '👏', '😂', '😭', '👑', '⚡', '🎯'];
const MAX_QUIZ_CHATS = 50;

function sendReaction(socket, payload = {}) {
  const user = authenticateSocketUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu.' };

  const emoji = String(payload?.emoji || '').trim();
  if (!ALLOWED_REACTIONS.includes(emoji)) {
    return { ok: false, error: 'Reaksi tidak valid.' };
  }

  const code = String(payload?.code || userRoomMap.get(user.id) || '').toUpperCase();
  const room = quizRooms.get(code);
  if (!room) return { ok: false, error: 'Room tidak ditemukan.' };

  const player = room.players.find(p => p.userId === user.id);
  if (!player) return { ok: false, error: 'Kamu bukan peserta room ini.' };

  const color = SLOT_COLORS[player.slot] || 'red';
  const reactionPayload = {
    id: Date.now() + Math.random(),
    playerId: user.id,
    playerName: player.name,
    color,
    emoji
  };
  emitToRoom(room, 'room:reaction', reactionPayload);
  return { ok: true };
}

function sendChat(socket, payload = {}) {
  const user = authenticateSocketUser(socket, payload);
  if (!user) return { ok: false, error: 'Silakan login terlebih dahulu.' };

  const code = String(payload?.code || userRoomMap.get(user.id) || '').toUpperCase();
  const room = quizRooms.get(code);
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

  const color = SLOT_COLORS[player.slot] || 'red';
  const chatMsg = {
    id: Date.now() + Math.random(),
    senderId: user.id,
    senderName: player.name,
    senderAvatar: player.avatar || '🎯',
    senderColor: color,
    text: cleanText,
    replyTo,
    time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
  };

  room.chats.push(chatMsg);
  if (room.chats.length > MAX_QUIZ_CHATS) room.chats.shift();
  emitToRoom(room, 'quiz:chat_message', chatMsg);
  return { ok: true, message: chatMsg };
}

function getActiveRoomForUser(userId) {
  if (!userId) return null;
  const code = userRoomMap.get(userId);
  if (!code) return null;
  const room = quizRooms.get(code);
  if (!room) {
    userRoomMap.delete(userId);
    return null;
  }
  return serializeRoomForUser(room, userId);
}

module.exports = {
  init,
  quizRooms,
  WIN_REWARD_POINTS,
  setTimings,
  getTimings,
  stopAllTimers,
  evaluateRoundOutcome,
  createRoom,
  joinRoom,
  joinMatchmaking,
  leaveMatchmaking,
  matchUserWithBot,
  selectMonster,
  setPlayerReady,
  useHint,
  syncUserInventory,
  submitAnswer,
  sendChat,
  sendReaction,
  leaveRoom,
  handleDisconnect,
  getActiveRoomForUser,
  closeAllRoomsForShutdown,
  serializeRoomForUser
};

