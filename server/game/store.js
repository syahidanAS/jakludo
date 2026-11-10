// State room di memori: broadcast ke klien, snapshot ke SQLite, dan siklus hidup room.
const db = require('../db');
const inventory = require('./inventory');
const social = require('../social/store');
const { getMovablePawns, getBlackHoles } = require('./rules');
const { ROOM_IDLE_TTL_MS, ROOM_SAVE_DELAY_MS, LOBBY_SEAT_GRACE_MS, MAX_HISTORY } = require('./config');

const rooms = new Map();
let io = null;
// true setelah shutdown: tidak ada timer baru yang dibuat (event yang masih tertunda tidak menghidupkan room lagi)
let stopped = false;

function init(socketServer) {
  io = socketServer;
}

function getIo() {
  return io;
}

// Timer milik room: dibatalkan otomatis jika room sudah dihapus, dan error tidak menjatuhkan proses
function roomTimeout(room, fn, ms) {
  if (stopped) return null;
  return setTimeout(() => {
    if (rooms.get(room.code) !== room) return;
    try {
      fn();
    } catch (err) {
      console.error(`[room ${room.code}] timer error`, err);
    }
  }, ms);
}

// ==========================================
// DATA UNTUK KLIEN
// ==========================================

function publicPlayer(p, room) {
  // sessionId adalah rahasia reconnect; catatan dadu tidak dikirim agar lemparan tidak bisa dihitung;
  // stok item dikirim dalam bentuk ringkasan
  const { sessionId, items, diceStats, ...rest } = p;
  return { ...rest, items: inventory.publicItems(p, room) };
}

function publicRoom(r) {
  const current = r.players[r.turn];
  const movable = r.started && !r.winner && r.dice !== null && !r.rolling && !r.animatingMove && !r.pendingShield && current
    ? getMovablePawns(r, current, r.dice)
    : [];
  return {
    code: r.code,
    group: r.groupId ? social.getGroupBasic(r.groupId) : null,
    host: r.host,
    players: r.players.map(p => publicPlayer(p, r)),
    started: r.started,
    turn: r.turn,
    dice: r.dice,
    movable,
    rolling: !!r.rolling,
    animatingMove: r.animatingMove || null,
    winner: r.winner,
    pawns: r.pawns,
    message: r.message,
    lastCapture: r.lastCapture || null,
    lastBlackHole: r.lastBlackHole || null,
    lastGoal: r.lastGoal || null,
    lastItemEvent: r.lastItemEvent || null,
    // Sisa waktu giliran pemain manusia (dihitung saat dikirim agar tidak bergantung jam klien)
    turnClock: r.turnClock && !r.pendingShield && !r.winner
      ? { id: r.turnClock.id, playerId: r.turnClock.playerId, totalMs: r.turnClock.totalMs, remainingMs: Math.max(0, r.turnClock.endsAt - Date.now()) }
      : null,
    // Keputusan perisai yang sedang ditunggu (data lanjutan permainan tidak dikirim ke klien)
    pendingShield: r.pendingShield
      ? { id: r.pendingShield.id, playerId: r.pendingShield.playerId, itemId: r.pendingShield.itemId, event: r.pendingShield.event, pawnIdx: r.pendingShield.pawnIdx, attackerId: r.pendingShield.attackerId, remainingMs: Math.max(0, r.pendingShield.expiresAt - Date.now()) }
      : null,
    lastBlackHoleShift: r.lastBlackHoleShift || null,
    blackHoles: r.settings?.blackHole ? getBlackHoles(r) : [],
    // Mode acak: sisa pergantian giliran sampai Black Hole pindah (1 = pindah setelah giliran ini)
    blackHoleShiftIn: r.started && r.settings?.blackHole && r.settings.blackHoleMode === 'random'
      ? Math.max(1, r.players.filter(p => !p.isOut).length - (r.turnsSinceBlackHoleShift || 0))
      : null,
    history: r.history || [],
    settings: { blackHoleMode: 'static', ...(r.settings || { safeZones: true, blackHole: false }) }
  };
}

function emitRoom(room) {
  if (!room) return;
  io.to(room.code).emit('room:update', publicRoom(room));
  markRoomDirty(room);
}

function addHistory(room, text) {
  room.history.unshift({
    id: Date.now() + Math.random(),
    text,
    time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
  });
  if (room.history.length > MAX_HISTORY) room.history.pop();
}

function resetRoomEvents(r) {
  r.dice = null;
  r.rolling = false;
  r.animatingMove = null;
  r.winner = null;
  r.consecutiveSixes = 0;
  r.lastCapture = null;
  r.lastBlackHole = null;
  r.lastGoal = null;
  r.pendingShield = null;
  r.lastItemEvent = null;
  r.lastBlackHoleShift = null;
}

function clearRoomTimers(r) {
  if (!r) return;
  for (const key of ['botTimeout', 'rollTimer', 'passTimer', 'moveTimer', 'turnTimer', 'shieldTimer']) {
    if (r[key]) clearTimeout(r[key]);
    r[key] = null;
  }
  r.turnClock = null;
}

// ==========================================
// PERSISTENSI: snapshot ke SQLite agar permainan selamat dari restart/deploy
// ==========================================

const RUNTIME_KEYS = new Set(['botTimeout', 'rollTimer', 'passTimer', 'moveTimer', 'turnTimer', 'shieldTimer', 'cleanupTimer', 'lobbyRemovals']);
const dirtyRooms = new Set();
let saveTimer = null;

function snapshotRoom(room) {
  const state = {};
  for (const [key, value] of Object.entries(room)) {
    if (!RUNTIME_KEYS.has(key)) state[key] = value;
  }
  return state;
}

function flushRooms() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  for (const code of dirtyRooms) {
    const room = rooms.get(code);
    try {
      if (room) db.saveRoom(code, snapshotRoom(room));
      else db.deleteRoom(code);
    } catch (err) {
      console.error(`[room ${code}] gagal menyimpan snapshot`, err);
    }
  }
  dirtyRooms.clear();
}

function queueRoomSave(code) {
  dirtyRooms.add(code);
  if (!saveTimer && !stopped) saveTimer = setTimeout(flushRooms, ROOM_SAVE_DELAY_MS);
}

function markRoomDirty(room) {
  room.updatedAt = Date.now();
  queueRoomSave(room.code);
}

// Pulihkan room dari snapshot terakhir. Semua socket lama sudah tidak ada, jadi pemain manusia
// ditandai terputus dan tinggal tersambung ulang (lewat token / sessionId) ke kursinya.
// onResume(room) dipanggil untuk permainan yang masih berjalan agar giliran dilanjutkan.
function restoreRooms({ onResume }) {
  const now = Date.now();
  for (const { code, state } of db.loadRooms()) {
    const room = {
      ...state,
      lobbyRemovals: new Map(),
      botTimeout: null,
      rollTimer: null,
      passTimer: null,
      moveTimer: null,
      turnTimer: null,
      cleanupTimer: null
    };
    for (const p of room.players) {
      inventory.normalizeLegacy(p);
      if (!p.isBot) {
        p.connected = false;
        p.disconnectedAt = now;
      }
    }
    delete room.lastShieldProtect;
    delete room.lastForceReturnReady;
    delete room.lastForceReturnUse;
    // Animasi/kocokan yang terpotong restart: langkah bidak sudah tercatat, giliran dilanjutkan
    room.rolling = false;
    if (room.animatingMove) {
      room.animatingMove = null;
      room.dice = null;
    }
    rooms.set(code, room);
    addHistory(room, '🔄 Server dimulai ulang. Menunggu pemain tersambung kembali...');

    if (!room.started) {
      for (const p of room.players) if (!p.isBot) holdLobbySeat(room, p);
      scheduleCleanup(room);
    } else if (room.winner) {
      scheduleCleanup(room);
    } else {
      onResume(room);
    }
  }
  if (rooms.size > 0) console.log(`[room] ${rooms.size} room dipulihkan dari database.`);
}

// ==========================================
// SIKLUS HIDUP ROOM
// ==========================================

function deleteRoom(room) {
  clearRoomTimers(room);
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  for (const timer of room.lobbyRemovals.values()) clearTimeout(timer);
  rooms.delete(room.code);
  queueRoomSave(room.code);
}

function isCreator(room, player) {
  return player.userId ? player.userId === room.creatorUserId : !!player.sessionId && player.sessionId === room.creatorSessionId;
}

function hasConnectedHuman(room) {
  return room.players.some(p => !p.isBot && p.connected && !p.left);
}

// Room yang sedang berjalan hanya dihapus jika semua pemain manusia sudah OUT
function deleteIfAllHumansOut(room) {
  if (room.players.some(p => !p.isBot && !p.isOut)) return false;
  deleteRoom(room);
  return true;
}

// Hapus room 5 menit setelah permainan selesai (memberi waktu untuk "Main Lagi"),
// atau jika lobby tidak punya satu pun pemain manusia yang tersambung selama 5 menit.
function scheduleCleanup(room) {
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  if (stopped) return;
  room.cleanupTimer = setTimeout(() => {
    room.cleanupTimer = null;
    if (rooms.get(room.code) !== room) return;
    if (room.winner || (!room.started && !hasConnectedHuman(room))) deleteRoom(room);
  }, ROOM_IDLE_TTL_MS);
  room.cleanupTimer.unref();
}

function cancelCleanup(room) {
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = null;
}

function reassignHost(room) {
  const next = room.players.find(p => !p.isBot && p.connected && !p.left);
  if (!next) return;
  room.players.forEach(p => { p.isHost = p === next; });
  room.host = next.id;
}

function removeLobbyPlayer(room, player) {
  room.players = room.players.filter(p => p !== player);
  delete room.pawns[player.id];
  if (!room.players.some(p => !p.isBot)) {
    deleteRoom(room);
    return;
  }
  if (room.host === player.id) reassignHost(room);
  emitRoom(room);
}

function cancelLobbyRemoval(room, player) {
  const timer = room.lobbyRemovals.get(player);
  if (timer) clearTimeout(timer);
  room.lobbyRemovals.delete(player);
}

// Koneksi putus di lobby: kursi ditahan agar bisa tersambung ulang.
// Kursi pembuat room ditahan selama room masih ada; kursi pemain lain dilepas setelah masa tenggang.
function holdLobbySeat(room, player) {
  player.connected = false;
  player.disconnectedAt = player.disconnectedAt || Date.now();
  cancelLobbyRemoval(room, player);
  if (isCreator(room, player) || stopped) return;
  room.lobbyRemovals.set(player, setTimeout(() => {
    room.lobbyRemovals.delete(player);
    if (rooms.get(room.code) !== room || room.started || player.connected) return;
    addHistory(room, `${player.name} meninggalkan ruang tunggu.`);
    removeLobbyPlayer(room, player);
  }, LOBBY_SEAT_GRACE_MS));
}

// Hentikan semua timer room tanpa menghapus room (snapshot tetap ada untuk dipulihkan)
function stopAllTimers() {
  stopped = true;
  for (const room of rooms.values()) {
    clearRoomTimers(room);
    cancelCleanup(room);
    for (const timer of room.lobbyRemovals.values()) clearTimeout(timer);
    room.lobbyRemovals.clear();
  }
}

module.exports = {
  rooms,
  stopAllTimers,
  init,
  getIo,
  roomTimeout,
  publicRoom,
  emitRoom,
  addHistory,
  resetRoomEvents,
  clearRoomTimers,
  flushRooms,
  markRoomDirty,
  restoreRooms,
  deleteRoom,
  isCreator,
  hasConnectedHuman,
  deleteIfAllHumansOut,
  scheduleCleanup,
  cancelCleanup,
  reassignHost,
  removeLobbyPlayer,
  cancelLobbyRemoval,
  holdLobbySeat
};
