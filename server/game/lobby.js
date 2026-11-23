// Masuk/keluar room: membuat room, join & reconnect, bot, dan pemain yang keluar/terputus.
const crypto = require('crypto');
const db = require('../db');
const inventory = require('./inventory');
const store = require('./store');
const engine = require('./engine');
const social = require('../social/store');
const { nextFreeColor } = require('./rules');
const { MAX_PLAYERS, BOT_NAMES, MATCHMAKING_TIMEOUT_MS } = require('./config');
const { createOrganicBotPlayer } = require('./organicBots');

const { rooms, addHistory, emitRoom } = store;

let matchmakingTimeoutMs = MATCHMAKING_TIMEOUT_MS;
function setMatchmakingTimeoutMs(ms) {
  const n = Number(ms);
  matchmakingTimeoutMs = Number.isFinite(n) && n > 0 ? n : MATCHMAKING_TIMEOUT_MS;
}

const makeRoomCode = () => Math.random().toString(36).slice(2, 7).toUpperCase();
const makeSessionId = () => 'sess_' + crypto.randomBytes(12).toString('hex');

function createRoom(socket, payload) {
  const groupId = typeof payload?.groupId === 'string' && payload.groupId.trim() ? payload.groupId.trim() : null;
  let creatorUser = null;
  if (groupId) {
    creatorUser = typeof payload?.token === 'string' ? db.getUserByToken(payload.token) : null;
    if (!creatorUser || !social.isGroupMember(groupId, creatorUser.id)) {
      return socket.emit('room:error', 'Kamu harus menjadi anggota grup untuk membuat match grup.');
    }
  }

  let code;
  do {
    code = makeRoomCode();
  } while (rooms.has(code));

  const room = {
    code,
    groupId,
    host: socket.id,
    players: [],
    started: false,
    turn: 0,
    pawns: {},
    message: 'Menunggu pemain bergabung...',
    history: [],
    chats: [],
    lobbyRemovals: new Map(),
    settings: { safeZones: true, blackHole: false, blackHoleMode: 'static' },
    matchmaking: null,
    matchmakingTimer: null,
    hasMatchmakingBots: false,
    botTimeout: null,
    rollTimer: null,
    passTimer: null,
    moveTimer: null,
    turnTimer: null,
    cleanupTimer: null
  };
  store.resetRoomEvents(room);
  rooms.set(code, room);
  joinRoom(socket, code, payload);

  if (groupId && creatorUser) {
    social.postGroupMatchMessage(groupId, creatorUser.id, code).catch(err => {
      console.error('[room group match msg]', err);
    });
  }
}

function joinRoom(socket, code, payload) {
  const room = rooms.get(String(code || '').toUpperCase());
  if (!room) return socket.emit('room:error', 'Room tidak ditemukan. Periksa kembali kode room.');

  // Socket yang masih tercatat di room lain harus keluar dulu
  if (socket.data.room && socket.data.room !== room.code) {
    const prev = rooms.get(socket.data.room);
    if (prev) handleDeparture(socket, prev, { intentional: false });
    socket.leave(socket.data.room);
    delete socket.data.room;
  }

  const user = typeof payload.token === 'string' ? db.getUserByToken(payload.token) : null;
  if (user && payload.token) social.identifySocket(socket, payload.token);
  const sessionId = typeof payload.sessionId === 'string' && payload.sessionId ? payload.sessionId : null;

  // Reconnect hanya lewat bukti yang tidak bisa ditebak: sessionId rahasia atau token login
  const existingPlayer = room.players.find(p =>
    !p.isBot && ((sessionId && p.sessionId === sessionId) || (user && p.userId === user.id))
  );
  if (existingPlayer) return rejoinPlayer(socket, room, existingPlayer, user);

  if (room.groupId && (!user || !social.isGroupMember(room.groupId, user.id))) {
    return socket.emit('room:error', 'Room ini khusus untuk anggota grup.');
  }

  if (room.started) return socket.emit('room:error', 'Permainan sudah dimulai.');
  const maxCapacity = room.matchmaking?.active ? room.matchmaking.targetPlayers : MAX_PLAYERS;
  if (room.players.length >= maxCapacity) return socket.emit('room:error', `Room sudah penuh (maksimal ${maxCapacity} pemain).`);

  const rawName = typeof payload.name === 'string' ? payload.name : '';
  const isFirstPlayer = room.players.length === 0;
  const economyStore = require('../economy/store');
  const player = {
    id: socket.id,
    sessionId: makeSessionId(),
    userId: user?.id || null,
    username: user?.username || null,
    name: user?.name || rawName.trim().slice(0, 18) || 'Pemain',
    avatar: user?.avatar || '🎲',
    color: nextFreeColor(room.players),
    isHost: room.host === socket.id,
    isBot: false,
    isLudoKing: db.checkIsLudoKing(user?.id),
    equippedSkin: economyStore.getValidatedEquippedSkin(user?.id),
    connected: true,
    autoPlayCount: 0,
    isOut: false,
    items: {}
  };
  inventory.loadOwned(player, user?.inventory);

  if (isFirstPlayer) {
    room.creatorUserId = player.userId;
    room.creatorSessionId = player.sessionId;
  }
  room.players.push(player);
  room.pawns[socket.id] = [0, 0, 0, 0];
  store.cancelCleanup(room);
  socket.join(room.code);
  socket.data.room = room.code;

  addHistory(room, `${player.isLudoKing ? '👑 [Ludo King] ' : ''}${player.name} bergabung ke dalam room.`);
  socket.emit('room:joined', {
    code: room.code,
    playerId: socket.id,
    sessionId: player.sessionId,
    isLudoKing: player.isLudoKing,
    reconnected: false
  });
  socket.emit('room:chats', room.chats);

  if (!isFirstPlayer) {
    store.getIo().to(room.code).emit('room:member_joined', {
      name: player.name,
      avatar: player.avatar,
      playerId: socket.id,
      reconnected: false
    });
  }
  emitRoom(room);

  if (room.matchmaking?.active && room.players.length >= room.matchmaking.targetPlayers) {
    startMatchedRoom(room);
  }
}

// Pemain lama tersambung ulang (reload, sinyal putus, pindah perangkat, server restart, atau masuk menonton setelah OUT)
function rejoinPlayer(socket, room, player, user) {
  const oldSocketId = player.id;
  if (oldSocketId !== socket.id) {
    // Room dibuka di tab/perangkat lain: putuskan socket lama dari room
    const oldSocket = store.getIo().sockets.sockets.get(oldSocketId);
    if (oldSocket) {
      oldSocket.leave(room.code);
      delete oldSocket.data.room;
      oldSocket.emit('room:error', 'Room ini dibuka di tab atau perangkat lain.');
    }
    room.pawns[socket.id] = room.pawns[oldSocketId] || [0, 0, 0, 0];
    delete room.pawns[oldSocketId];
    if (room.winner === oldSocketId) room.winner = socket.id;
    if (room.matchResult?.ranking) {
      room.matchResult.ranking = room.matchResult.ranking.map(id => (id === oldSocketId ? socket.id : id));
    }
    if (room.matchResult?.awards && room.matchResult.awards[oldSocketId]) {
      room.matchResult.awards[socket.id] = room.matchResult.awards[oldSocketId];
      delete room.matchResult.awards[oldSocketId];
    }
  }

  player.id = socket.id;
  player.connected = true;
  player.disconnectedAt = null;
  if (!player.isOut && room.turnClock && room.turnClock.playerId === oldSocketId) {
    room.turnClock.playerId = socket.id;
  }
  store.cancelLobbyRemoval(room, player);
  if (user) {
    const economyStore = require('../economy/store');
    inventory.loadOwned(player, user.inventory);
    player.name = user.name || player.name;
    player.avatar = user.avatar || '🎲';
    player.isLudoKing = db.checkIsLudoKing(user.id);
    player.equippedSkin = economyStore.getValidatedEquippedSkin(user.id);
  }

  if (!player.isOut && (room.host === oldSocketId || store.isCreator(room, player))) {
    room.host = socket.id; // Pembuat/pemain aktif mengambil kembali peran host
  } else if (!room.players.some(p => p.id === room.host && p.connected && !p.isOut)) {
    store.reassignHost(room);
  }
  room.players.forEach(p => { p.isHost = p.id === room.host; });
  store.cancelCleanup(room);
  if (room.winner) store.scheduleCleanup(room);

  socket.join(room.code);
  socket.data.room = room.code;

  addHistory(
    room,
    player.isOut
      ? `👀 ${player.name} kembali masuk untuk menonton pertandingan.`
      : `🎮 ${player.name} kembali masuk ke dalam room.`
  );
  socket.emit('room:joined', {
    code: room.code,
    playerId: socket.id,
    sessionId: player.sessionId,
    isLudoKing: player.isLudoKing,
    isOut: Boolean(player.isOut),
    reconnected: true
  });
  socket.emit('room:chats', room.chats);
  store.getIo().to(room.code).emit('room:member_joined', {
    name: player.name,
    avatar: player.avatar,
    playerId: socket.id,
    isOut: Boolean(player.isOut),
    reconnected: true
  });
  emitRoom(room);

  if (room.started && !player.isOut && room.players[room.turn]?.id === socket.id) {
    engine.triggerTurn(room, { preserveClock: true });
  }
}

function clearMatchmaking(room) {
  if (!room) return;
  if (room.matchmakingTimer) {
    clearTimeout(room.matchmakingTimer);
    room.matchmakingTimer = null;
  }
  room.matchmaking = null;
}

function startMatchedRoom(room) {
  if (!room || room.started) return;
  clearMatchmaking(room);
  engine.startGame(room);
  room.message = `Permainan dimulai! Giliran ${room.players[0].name}.`;
  addHistory(room, '🎲 Permainan dimulai!');
  emitRoom(room);
  engine.triggerTurn(room);
}

function findCompatibleMatchmakingRoom(sourceRoom, targetPlayers) {
  const sourceUserIds = new Set((sourceRoom.players || []).map(p => p.userId).filter(Boolean));
  const safeZones = sourceRoom.settings?.safeZones !== false;
  const blackHole = !!sourceRoom.settings?.blackHole;
  const blackHoleMode = sourceRoom.settings?.blackHoleMode || 'static';

  for (const r of rooms.values()) {
    if (r === sourceRoom || r.code === sourceRoom.code) continue;
    if (r.started || r.winner || r.groupId || !r.matchmaking?.active) continue;
    if (r.matchmaking.targetPlayers !== targetPlayers) continue;
    if ((r.settings?.safeZones !== false) !== safeZones) continue;
    if (!!r.settings?.blackHole !== blackHole) continue;
    if ((r.settings?.blackHoleMode || 'static') !== blackHoleMode) continue;
    if (r.players.length + sourceRoom.players.length > targetPlayers) continue;
    if (!store.hasConnectedHuman(r)) continue;
    if (r.players.some(p => p.userId && sourceUserIds.has(p.userId))) continue;
    return r;
  }
  return null;
}

function mergeRoomInto(sourceRoom, targetRoom) {
  const io = store.getIo();
  const movingPlayers = [...(sourceRoom.players || [])];
  for (const p of movingPlayers) {
    p.color = nextFreeColor(targetRoom.players);
    p.isHost = false;
    targetRoom.players.push(p);
    targetRoom.pawns[p.id] = [0, 0, 0, 0];
    addHistory(targetRoom, `${p.isLudoKing ? '👑 [Ludo King] ' : ''}${p.name} bergabung ke dalam room.`);

    const sock = io?.sockets?.sockets?.get(p.id);
    if (sock) {
      sock.leave(sourceRoom.code);
      sock.join(targetRoom.code);
      sock.data.room = targetRoom.code;
      sock.emit('room:joined', {
        code: targetRoom.code,
        playerId: p.id,
        sessionId: p.sessionId,
        isLudoKing: p.isLudoKing,
        reconnected: false
      });
      sock.emit('room:chats', targetRoom.chats);
    }
    if (io) {
      io.to(targetRoom.code).emit('room:member_joined', {
        name: p.name,
        avatar: p.avatar,
        playerId: p.id,
        reconnected: false
      });
    }
  }
  store.cancelCleanup(targetRoom);
  store.removeRoomQuietly(sourceRoom);
}

function completeMatchmakingWithFallback(room) {
  if (!room || room.started || !room.matchmaking?.active) return;
  if (!store.hasConnectedHuman(room)) {
    clearMatchmaking(room);
    return;
  }
  const target = room.matchmaking.targetPlayers;
  const io = store.getIo();
  clearMatchmaking(room);

  while (room.players.length < target) {
    const bot = createOrganicBotPlayer(room);
    room.players.push(bot);
    room.pawns[bot.id] = [0, 0, 0, 0];
    room.hasMatchmakingBots = true;
    addHistory(room, `${bot.name} bergabung ke dalam room.`);
    if (io) {
      io.to(room.code).emit('room:member_joined', {
        name: bot.name,
        avatar: bot.avatar,
        playerId: bot.id,
        reconnected: false
      });
    }
  }

  startMatchedRoom(room);
}

function findRandomPlayers(room, hostSocketId, payload) {
  if (!room || room.started) {
    return { ok: false, error: 'Room tidak tersedia atau permainan sudah dimulai.' };
  }
  if (room.host !== hostSocketId) {
    return { ok: false, error: 'Hanya host yang dapat mencari pemain acak.' };
  }
  if (room.groupId) {
    return { ok: false, error: 'Pencarian pemain acak tidak tersedia untuk match grup.' };
  }
  const targetPlayers = Number(payload?.targetPlayers);
  if (!Number.isInteger(targetPlayers) || targetPlayers < 2 || targetPlayers > MAX_PLAYERS) {
    return { ok: false, error: 'Pilih jumlah pemain (2, 3, atau 4) sebelum mencari pemain acak.' };
  }
  if (targetPlayers < room.players.length) {
    return { ok: false, error: `Jumlah pemain di room sudah ${room.players.length}. Pilih minimal ${room.players.length} pemain.` };
  }

  if (room.players.length === targetPlayers) {
    startMatchedRoom(room);
    return { ok: true, matched: true, code: room.code };
  }

  const candidate = findCompatibleMatchmakingRoom(room, targetPlayers);
  if (candidate) {
    mergeRoomInto(room, candidate);
    if (candidate.players.length >= candidate.matchmaking.targetPlayers) {
      startMatchedRoom(candidate);
    } else {
      candidate.message = `Mencari pemain acak (${candidate.players.length}/${candidate.matchmaking.targetPlayers})...`;
      emitRoom(candidate);
    }
    return { ok: true, matched: candidate.started, code: candidate.code };
  }

  clearMatchmaking(room);
  const now = Date.now();
  const totalMs = matchmakingTimeoutMs;
  room.matchmaking = {
    active: true,
    targetPlayers,
    totalMs,
    startedAt: now,
    expiresAt: now + totalMs
  };
  room.message = `Mencari pemain acak (${room.players.length}/${targetPlayers})...`;
  addHistory(room, `🔍 Mencari pemain acak untuk ${targetPlayers} pemain...`);
  emitRoom(room);
  room.matchmakingTimer = store.roomTimeout(room, () => completeMatchmakingWithFallback(room), totalMs);
  return { ok: true, matched: false, code: room.code };
}

function cancelRandomMatch(room, hostSocketId) {
  if (!room || room.started || room.host !== hostSocketId || !room.matchmaking?.active) return;
  clearMatchmaking(room);
  room.message = 'Pencarian pemain acak dibatalkan.';
  addHistory(room, '⏹️ Pencarian pemain acak dibatalkan oleh host.');
  emitRoom(room);
}

function updateSettings(room, hostSocketId, { safeZones, blackHole, blackHoleMode }) {
  if (!room || room.host !== hostSocketId || room.started || room.matchmaking?.active) return;
  let changed = false;
  if (typeof safeZones === 'boolean') {
    room.settings.safeZones = safeZones;
    addHistory(room, `⚙️ Host mengatur Zona Aman: ${safeZones ? 'AKTIF' : 'NONAKTIF (Hardcore)'}.`);
    changed = true;
  }
  if (typeof blackHole === 'boolean') {
    room.settings.blackHole = blackHole;
    addHistory(room, `⚙️ Host mengatur Black Hole: ${blackHole ? 'AKTIF 🕳️' : 'NONAKTIF'}.`);
    changed = true;
  }
  if (blackHoleMode === 'static' || blackHoleMode === 'random') {
    room.settings.blackHoleMode = blackHoleMode;
    addHistory(room, `⚙️ Host mengatur lokasi Black Hole: ${blackHoleMode === 'random' ? 'ACAK (pindah tiap putaran)' : 'TETAP'}.`);
    changed = true;
  }
  if (changed) emitRoom(room);
}

// Pemain keluar (intentional = klik keluar/menyerah) atau koneksi terputus
function handleDeparture(socket, r, { intentional }) {
  const departing = r.players.find(p => p.id === socket.id);
  if (!departing) return;

  if (!r.started) {
    store.cancelLobbyRemoval(r, departing);
    const wasHost = r.host === socket.id || departing.isHost;
    if (intentional) {
      if (wasHost && r.matchmaking?.active) clearMatchmaking(r);
      addHistory(r, `${departing.name} keluar dari ruang tunggu.`);
      store.removeLobbyPlayer(r, departing);
    } else {
      departing.disconnectedAt = Date.now();
      store.holdLobbySeat(r, departing);
      if (!store.hasConnectedHuman(r) && r.matchmaking?.active) clearMatchmaking(r);
      addHistory(r, `⚠️ ${departing.name} terputus dari ruang tunggu, menunggu tersambung ulang...`);
      if (r.host === socket.id) store.reassignHost(r);
      emitRoom(r);
    }
    if (rooms.get(r.code) === r && !store.hasConnectedHuman(r)) store.scheduleCleanup(r);
    return;
  }

  departing.connected = false;

  if (intentional) {
    const wasActive = !departing.isOut;
    departing.isOut = true;
    departing.left = true;
    addHistory(
      r,
      wasActive
        ? `🚪 ${departing.name} keluar dari permainan (menyerah).`
        : `👀 ${departing.name} keluar dari mode menonton.`
    );
    // Pemain yang sedang ditanya soal perisai lalu menyerah: anggap tidak memakai perisai
    if (r.pendingShield?.playerId === departing.id) engine.resolvePendingShield(r, false);

    if (store.deleteIfAllHumansOut(r)) return;
    if (r.host === socket.id) store.reassignHost(r);

    if (!r.winner && wasActive) {
      const activeRemaining = r.players.filter(p => !p.isOut);
      if (activeRemaining.length === 1) {
        engine.declareWinner(r, activeRemaining[0], { endReason: 'forfeit' });
      } else if (r.players[r.turn]?.id === departing.id) {
        engine.advanceTurn(r);
      } else {
        emitRoom(r);
      }
    } else if (!wasActive) {
      emitRoom(r);
    }
  } else {
    departing.disconnectedAt = Date.now();
    if (departing.isOut) {
      addHistory(r, `👀 ${departing.name} menutup tampilan menonton.`);
    } else {
      addHistory(r, `⚠️ ${departing.name} keluar web/terputus (dimainkan bot sementara).`);
    }
    if (r.host === socket.id) store.reassignHost(r);
    if (!r.winner && !departing.isOut && r.players[r.turn]?.id === departing.id) engine.triggerTurn(r);
    else if (departing.isOut) emitRoom(r);
  }

  emitRoom(r);
}

module.exports = {
  createRoom,
  joinRoom,
  findRandomPlayers,
  cancelRandomMatch,
  setMatchmakingTimeoutMs,
  updateSettings,
  handleDeparture
};
