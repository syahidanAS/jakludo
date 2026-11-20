'use strict';

const db = require('../db');
const { recordAdminAudit } = require('./middleware');

const SUPPORTED_GAMES = new Set(['ludo', 'quiz', 'chess', 'snakes']);
let io = null;

function init(socketServer) {
  io = socketServer;
}

function watchChannel(game, code) {
  const g = String(game || '').trim().toLowerCase();
  const c = String(code || '').trim().toUpperCase();
  return `admin:watch:${g}:${c}`;
}

function getWatcherCount(game, code) {
  if (!io || !game || !code) return 0;
  const ch = watchChannel(game, code);
  const roomSet = io.sockets?.adapter?.rooms?.get(ch);
  return roomSet ? roomSet.size : 0;
}

function hasWatchers(game, code) {
  return getWatcherCount(game, code) > 0;
}

function notifyState(game, code, state) {
  if (!hasWatchers(game, code)) return;
  const cleanGame = String(game).trim().toLowerCase();
  const cleanCode = String(code).trim().toUpperCase();
  io.to(watchChannel(cleanGame, cleanCode)).emit('admin:watch:state', {
    game: cleanGame,
    code: cleanCode,
    state,
    serverNow: Date.now()
  });
}

function notifyChat(game, code, message) {
  if (!hasWatchers(game, code)) return;
  const cleanGame = String(game).trim().toLowerCase();
  const cleanCode = String(code).trim().toUpperCase();
  io.to(watchChannel(cleanGame, cleanCode)).emit('admin:watch:chat', {
    game: cleanGame,
    code: cleanCode,
    message,
    serverNow: Date.now()
  });
}

function notifyReaction(game, code, reaction) {
  if (!hasWatchers(game, code)) return;
  const cleanGame = String(game).trim().toLowerCase();
  const cleanCode = String(code).trim().toUpperCase();
  io.to(watchChannel(cleanGame, cleanCode)).emit('admin:watch:reaction', {
    game: cleanGame,
    code: cleanCode,
    reaction,
    serverNow: Date.now()
  });
}

function notifyClosed(game, code, reason = 'Room sudah ditutup.') {
  if (!hasWatchers(game, code)) return;
  const cleanGame = String(game).trim().toLowerCase();
  const cleanCode = String(code).trim().toUpperCase();
  const ch = watchChannel(cleanGame, cleanCode);
  io.to(ch).emit('admin:watch:closed', {
    game: cleanGame,
    code: cleanCode,
    reason,
    serverNow: Date.now()
  });
  io.in(ch).socketsLeave(ch);
}

// Bangun snapshot state room saat admin pertama kali membuka mode pantau senyap.
// Require modul game dilakukan lazy di dalam fungsi untuk menghindari circular dependency saat boot.
function buildSnapshot(game, code) {
  const cleanGame = String(game || '').trim().toLowerCase();
  const cleanCode = String(code || '').trim().toUpperCase();
  if (!SUPPORTED_GAMES.has(cleanGame) || !cleanCode) return null;

  if (cleanGame === 'ludo') {
    const store = require('../game/store');
    const room = store.rooms.get(cleanCode);
    if (!room) return null;
    return {
      ...store.publicRoom(room),
      chats: Array.isArray(room.chats) ? room.chats.slice(-50) : []
    };
  }

  if (cleanGame === 'quiz') {
    const quizEngine = require('../quiz/engine');
    const room = quizEngine.quizRooms.get(cleanCode);
    if (!room) return null;
    return quizEngine.serializeRoomForAdmin(room);
  }

  if (cleanGame === 'chess') {
    const chessEngine = require('../chess/engine');
    const room = chessEngine.chessRooms.get(cleanCode);
    if (!room) return null;
    return chessEngine.serializeRoomForUser(room, null);
  }

  if (cleanGame === 'snakes') {
    const snakesEngine = require('../snakes/engine');
    const room = snakesEngine.snakesRooms.get(cleanCode);
    if (!room) return null;
    return snakesEngine.serializeRoomForUser(room, null);
  }

  return null;
}

function leaveCurrentWatch(socket) {
  if (!socket?.data?.adminWatchChannel) return;
  const prev = socket.data.adminWatchChannel;
  delete socket.data.adminWatchChannel;
  socket.leave(prev);
}

// Admin bergabung ke channel terisolasi admin:watch:<game>:<CODE> tanpa menyentuh room atau daftar pemain.
function handleWatchJoin(socket, payload = {}, cb) {
  const reply = res => {
    if (typeof cb === 'function') cb(res);
  };

  const token = typeof payload?.token === 'string' ? payload.token.trim() : '';
  const user = token ? db.getUserByToken(token) : null;
  if (!user || !db.isUserAdmin(user)) {
    return reply({ ok: false, error: 'Akses ditolak: khusus admin.' });
  }

  const cleanGame = String(payload?.game || '').trim().toLowerCase();
  const cleanCode = String(payload?.code || '').trim().toUpperCase();
  if (!SUPPORTED_GAMES.has(cleanGame) || !cleanCode) {
    return reply({ ok: false, error: 'Parameter game atau kode room tidak valid.' });
  }

  leaveCurrentWatch(socket);

  const state = buildSnapshot(cleanGame, cleanCode);
  if (!state) {
    return reply({ ok: false, error: 'Room tidak ditemukan atau sudah ditutup.' });
  }

  const ch = watchChannel(cleanGame, cleanCode);
  socket.join(ch);
  socket.data.adminWatchChannel = ch;

  recordAdminAudit({
    adminUser: user,
    action: 'ROOM_STEALTH_WATCH',
    targetType: `room:${cleanGame}`,
    targetId: cleanCode,
    summary: `Memantau live (senyap) room ${cleanGame.toUpperCase()} #${cleanCode}`,
    meta: { game: cleanGame, code: cleanCode }
  });

  return reply({
    ok: true,
    game: cleanGame,
    code: cleanCode,
    state,
    serverNow: Date.now()
  });
}

function handleWatchLeave(socket, cb) {
  leaveCurrentWatch(socket);
  if (typeof cb === 'function') cb({ ok: true });
}

module.exports = {
  init,
  watchChannel,
  getWatcherCount,
  hasWatchers,
  notifyState,
  notifyChat,
  notifyReaction,
  notifyClosed,
  buildSnapshot,
  handleWatchJoin,
  handleWatchLeave
};
