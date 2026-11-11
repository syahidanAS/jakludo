// Alur permainan: giliran, dadu, langkah bidak, pemakaian item, dan keputusan perisai.
const crypto = require('crypto');
const db = require('../db');
const items = require('../items');
const inventory = require('./inventory');
const store = require('./store');
const social = require('../social/store');
const {
  COLORS,
  FINISH,
  getTrackIndex,
  canPawnMove,
  getMovablePawns,
  chooseBestPawn,
  rankPlayers,
  getBlackHoles,
  relocateBlackHoles,
  isPawnProtected,
  diceWeights,
  rollWeighted,
  isPawnIndex
} = require('./rules');
const { TURN_TIMEOUT_MS, DISCONNECTED_TURN_DELAY_MS, OFFLINE_OUT_MS, MAX_AUTO_PLAY, SHIELD_DECISION_MS, DICE } = require('./config');

const { addHistory, emitRoom, roomTimeout, clearRoomTimers } = store;
const eventId = () => Date.now() + Math.random();
// Sumber acak kriptografis [0, 1) untuk dadu
const secureRandom = () => crypto.randomInt(2 ** 47) / 2 ** 47;
const newDiceStats = () => ({ counts: [0, 0, 0, 0, 0, 0], total: 0, captureStreak: 0 });

// ==========================================
// MULAI & SELESAI
// ==========================================

function resetPlayerForGame(p) {
  p.autoPlayCount = 0;
  p.isOut = false;
  p.finishedCount = 0;
  p.diceStats = newDiceStats();
  inventory.resetForMatch(p);
  if (p.userId) inventory.loadOwned(p, db.getUserItems(p.userId));
}

function startGame(r) {
  for (const timer of r.lobbyRemovals.values()) clearTimeout(timer);
  r.lobbyRemovals.clear();
  clearRoomTimers(r);
  store.cancelCleanup(r);
  store.resetRoomEvents(r);
  r.started = true;
  r.turn = 0;
  r.blackHoles = r.settings.blackHole && r.settings.blackHoleMode === 'random' ? relocateBlackHoles(r) : null;
  r.turnsSinceBlackHoleShift = 0;
  for (const p of r.players) {
    r.pawns[p.id] = [0, 0, 0, 0];
    resetPlayerForGame(p);
  }
}

// Main lagi: hanya setelah ada pemenang. Pemain yang sudah menyerah tidak diikutkan.
function restartGame(r) {
  const remaining = r.players.filter(p => !p.left);
  if (remaining.length < 2) return 'Butuh minimal 2 pemain untuk bermain lagi. Tambahkan bot atau ajak teman.';
  for (const p of r.players) if (p.left) delete r.pawns[p.id];
  r.players = remaining;
  startGame(r);
  return null;
}

function declareWinner(room, winnerPlayer) {
  if (!room || room.winner) return;
  clearRoomTimers(room);
  room.winner = winnerPlayer.id;
  room.dice = null;
  room.pendingShield = null;
  room.message = `🏆 SELAMAT! ${winnerPlayer.name} MENANG!`;
  addHistory(room, `🎉 ${winnerPlayer.name} berhasil memenangkan pertandingan JakLudo!`);

  // Poin sama untuk permainan biasa dan grup; room grup juga ikut dicatat di leaderboard grupnya
  const ranking = rankPlayers(room, winnerPlayer.id);
  const awards = db.recordMatchResult({ winnerPlayerId: winnerPlayer.id, players: room.players, ranking });
  if (room.groupId) social.recordGroupMatchResult(room.groupId, { winnerPlayerId: winnerPlayer.id, players: room.players, ranking });
  // Peringkat resmi + poin yang didapat, ditampilkan di layar hasil
  room.matchResult = { ranking, awards };
  room.players.forEach(p => {
    p.isLudoKing = db.checkIsLudoKing(p.userId);
  });
  store.getIo().emit('leaderboard:update', db.getLeaderboard());

  emitRoom(room);
  store.scheduleCleanup(room);
}

// ==========================================
// GILIRAN
// ==========================================

function advanceTurn(room) {
  if (!room || !room.started || room.winner) return;
  clearRoomTimers(room);
  room.pendingShield = null; // giliran dipaksa pindah (mis. pemain menyerah): keputusan perisai batal

  const activePlayers = room.players.filter(p => !p.isOut);
  if (activePlayers.length <= 1) {
    if (activePlayers.length === 1) declareWinner(room, activePlayers[0]);
    return;
  }

  let next = (room.turn + 1) % room.players.length;
  for (let attempts = 0; room.players[next]?.isOut && attempts < room.players.length; attempts++) {
    next = (next + 1) % room.players.length;
  }

  room.turn = next;
  room.dice = null;
  room.consecutiveSixes = 0;
  const holesShifted = shiftBlackHolesEachRound(room, activePlayers.length);
  const nextPlayer = room.players[room.turn];
  room.message = `Giliran ${nextPlayer.name}${nextPlayer.autoPlayCount > 0 ? ` (Auto-Play ${nextPlayer.autoPlayCount}/${MAX_AUTO_PLAY})` : ''}.${holesShifted ? ' 🕳️ Black Hole pindah tempat!' : ''}`;

  emitRoom(room);
  triggerTurn(room);
}

// Mode Black Hole acak: setelah semua pemain aktif mendapat giliran (1 putaran),
// keempat Black Hole pindah ke petak lain di ruasnya masing-masing.
function shiftBlackHolesEachRound(room, activeCount) {
  if (!room.settings?.blackHole || room.settings.blackHoleMode !== 'random') return false;
  room.turnsSinceBlackHoleShift = (room.turnsSinceBlackHoleShift || 0) + 1;
  if (room.turnsSinceBlackHoleShift < activeCount) return false;
  room.turnsSinceBlackHoleShift = 0;
  room.blackHoles = relocateBlackHoles(room);
  room.lastBlackHoleShift = { id: eventId(), positions: room.blackHoles };
  addHistory(room, '🕳️ Black Hole berpindah tempat!');
  return true;
}

// Jadwalkan aksi berikutnya untuk pemain yang sedang mendapat giliran
function triggerTurn(room) {
  if (!room || !room.started || room.winner || room.rolling || room.animatingMove) return;
  // Permainan berhenti sampai pemilik perisai memutuskan (timer dipasang ulang setelah server restart)
  if (room.pendingShield) {
    armShieldTimer(room);
    return;
  }
  const currentPlayer = room.players[room.turn];
  if (!currentPlayer) return;

  if (room.botTimeout) clearTimeout(room.botTimeout);
  if (room.turnTimer) clearTimeout(room.turnTimer);
  room.turnClock = null;

  if (currentPlayer.isOut) {
    advanceTurn(room);
    return;
  }

  if (currentPlayer.isBot) {
    if (room.dice === null) {
      room.botTimeout = roomTimeout(room, () => {
        if (room.players[room.turn]?.id === currentPlayer.id && room.dice === null && !room.animatingMove) {
          handleRoll(room, currentPlayer.id);
        }
      }, 700);
    } else {
      scheduleAutoMove(room, currentPlayer, false);
    }
    return;
  }

  // Pemain manusia: online -> batas waktu 15 detik, terputus -> tunggu sebentar agar sempat tersambung ulang
  const delay = currentPlayer.connected ? TURN_TIMEOUT_MS : DISCONNECTED_TURN_DELAY_MS;
  room.turnTimer = roomTimeout(room, () => {
    if (room.players[room.turn]?.id === currentPlayer.id) executeAutoPlay(room, currentPlayer);
  }, delay);
  // Hitung mundur yang terlihat di klien (sisa waktu sebelum langkah dijalankan sistem)
  room.turnClock = { id: eventId(), playerId: currentPlayer.id, totalMs: delay, endsAt: Date.now() + delay };
  emitRoom(room);
}

function scheduleAutoMove(room, player, isAuto) {
  const bestPawn = chooseBestPawn(room, player, room.dice);
  if (bestPawn === null) return;
  room.botTimeout = roomTimeout(room, () => {
    if (room.players[room.turn]?.id === player.id && room.dice !== null && !room.animatingMove) {
      handleMove(room, player.id, bestPawn, isAuto);
    }
  }, 800);
}

function executeAutoPlay(room, player) {
  if (!room || !room.started || room.winner || room.rolling || room.animatingMove || room.pendingShield) return;
  if (room.players[room.turn]?.id !== player.id) return;

  // OUT setelah 3x auto-play berturut-turut: langsung jika pemain online tapi diam (AFK),
  // atau jika sudah offline cukup lama. Sinyal yang goyang sebentar tidak membuat pemain OUT.
  const offlineTooLong = !player.connected && Date.now() - (player.disconnectedAt || 0) >= OFFLINE_OUT_MS;
  if ((player.autoPlayCount || 0) >= MAX_AUTO_PLAY && (player.connected || offlineTooLong)) {
    player.isOut = true;
    player.autoPlayCount = MAX_AUTO_PLAY;
    addHistory(room, `❌ ${player.name} dinyatakan OUT (batas ${MAX_AUTO_PLAY}x auto-play tercapai tanpa respon).`);
    room.message = `❌ ${player.name} dinyatakan OUT!`;
    if (store.deleteIfAllHumansOut(room, `${player.name} dinyatakan OUT karena ${MAX_AUTO_PLAY}x tidak jalan. Room ditutup karena tidak ada pemain lain.`)) return;
    advanceTurn(room);
    return;
  }

  player.autoPlayCount = Math.min(MAX_AUTO_PLAY, (player.autoPlayCount || 0) + 1);
  addHistory(room, `🤖 [Auto-Play ${player.autoPlayCount}/${MAX_AUTO_PLAY}] Bidak ${player.name} dijalankan otomatis oleh sistem.`);

  if (room.dice === null) {
    handleRoll(room, player.id, true);
  } else {
    const bestPawn = chooseBestPawn(room, player, room.dice);
    if (bestPawn !== null) handleMove(room, player.id, bestPawn, true);
  }
}

// ==========================================
// DADU
// ==========================================

function handleRoll(room, playerId, isAuto = false) {
  if (!room || !room.started || room.winner) return;
  const currentPlayer = room.players[room.turn];
  if (!currentPlayer || currentPlayer.id !== playerId || currentPlayer.isOut) return;
  if (room.dice !== null || room.rolling || room.animatingMove || room.pendingShield) return;

  if (room.turnTimer) clearTimeout(room.turnTimer);
  room.turnClock = null;
  if (!isAuto && !currentPlayer.isBot) currentPlayer.autoPlayCount = 0;

  room.rolling = true;
  room.message = `${currentPlayer.name} sedang mengocok dadu...`;
  emitRoom(room);

  if (room.rollTimer) clearTimeout(room.rollTimer);
  room.rollTimer = roomTimeout(room, () => {
    room.rolling = false;
    // Room dari snapshot lama belum punya catatan lemparan
    if (!currentPlayer.diceStats) currentPlayer.diceStats = newDiceStats();
    const stats = currentPlayer.diceStats;
    const roll = rollWeighted(diceWeights(room, currentPlayer, stats, DICE), secureRandom);
    stats.counts[roll - 1]++;
    stats.total++;
    room.dice = roll;
    room.consecutiveSixes = roll === 6 ? (room.consecutiveSixes || 0) + 1 : 0;

    // Lemparan tanpa langkah (hangus 3x angka 6 / tidak ada bidak yang bisa jalan) memutus rantai makan
    if (room.consecutiveSixes >= 3 || getMovablePawns(room, currentPlayer, roll).length === 0) stats.captureStreak = 0;

    if (room.consecutiveSixes >= 3) {
      room.message = `${currentPlayer.name} dapat angka 6 tiga kali berturut-turut! Giliran hangus.`;
      addHistory(room, `${currentPlayer.name} melempar 6 (3x berturut-turut) - giliran hangus!`);
      advanceTurn(room);
      return;
    }

    if (getMovablePawns(room, currentPlayer, roll).length === 0) {
      // Angka 6 tetap memberi lemparan bonus walaupun tidak ada bidak yang bisa jalan
      // (mis. bidak terakhir di jalur finish butuh angka yang lebih kecil)
      const bonus = roll === 6;
      room.message = bonus
        ? `${currentPlayer.name} dapat 6 tapi tidak ada langkah. Tetap dapat lemparan bonus!`
        : `${currentPlayer.name} mendapatkan angka ${roll}, tetapi tidak ada bidak yang dapat melangkah.`;
      addHistory(room, `${currentPlayer.name} melempar dadu: ${roll} (tidak ada langkah valid${bonus ? ', lempar lagi' : ''})`);
      emitRoom(room);
      if (room.passTimer) clearTimeout(room.passTimer);
      room.passTimer = roomTimeout(room, () => {
        if (!bonus) return advanceTurn(room);
        room.dice = null;
        emitRoom(room);
        triggerTurn(room);
      }, 1300);
      return;
    }

    room.message = `${currentPlayer.name} mendapatkan angka ${roll}! Pilih bidak untuk dijalankan.`;
    addHistory(room, `${currentPlayer.name} melempar dadu: ${roll}`);
    emitRoom(room);

    if (currentPlayer.isBot || isAuto || !currentPlayer.connected) {
      scheduleAutoMove(room, currentPlayer, isAuto);
    } else {
      triggerTurn(room);
    }
  }, 750);
}

// ==========================================
// LANGKAH BIDAK
// ==========================================

function handleMove(room, playerId, pawnIdx, isAuto = false) {
  if (!room || !room.started || room.winner || room.rolling || room.animatingMove || room.pendingShield) return;
  const player = room.players[room.turn];
  if (!player || player.id !== playerId || player.isOut) return;
  if (room.dice === null) return;
  if (!isPawnIndex(pawnIdx)) return;
  if (!canPawnMove(room, player, pawnIdx, room.dice)) return;

  if (room.turnTimer) clearTimeout(room.turnTimer);
  room.turnClock = null;
  if (!isAuto && !player.isBot) player.autoPlayCount = 0;

  const pawns = room.pawns[playerId];
  const fromVal = pawns[pawnIdx];
  const rollVal = room.dice;
  const toVal = fromVal === 0 ? 1 : fromVal + rollVal;
  const steps = fromVal === 0 ? 1 : rollVal;

  room.animatingMove = { id: eventId(), playerId, pawnIdx, from: fromVal, to: toVal, steps, color: player.color };
  room.lastCapture = null;
  room.lastBlackHole = null;
  room.lastGoal = null;

  pawns[pawnIdx] = toVal;
  room.message = `${player.name} memajukan bidak ${pawnIdx + 1} (${steps} langkah)...`;
  emitRoom(room);

  // Efek langkah diproses setelah animasi di klien selesai
  if (room.moveTimer) clearTimeout(room.moveTimer);
  room.moveTimer = roomTimeout(room, () => {
    room.animatingMove = null;
    const move = { pawnIdx, fromVal, toVal, rollVal, captured: captureAt(room, player, toVal) };

    // Black Hole: perisai pasif dicoba dulu, lalu pemain bisa ditanya soal Universal Shield
    const trackPos = toVal <= 39 ? getTrackIndex(COLORS.indexOf(player.color), toVal) : null;
    if (trackPos !== null && room.settings?.blackHole && getBlackHoles(room).includes(trackPos)) {
      const outcome = protectPawn(room, player, 'blackHole', { pawnIdx, trackPos }, { type: 'move', playerId: player.id, move });
      if (outcome === 'pending') return emitRoom(room);
      if (outcome === 'exposed') suckIntoBlackHole(room, player, pawnIdx, trackPos);
    }
    finishMove(room, player, move);
  }, steps * 220 + 360);
}

// Lanjutan langkah setelah efek petak selesai: menang, finish, bonus giliran, atau giliran berikutnya
function finishMove(room, player, { pawnIdx, fromVal, toVal, rollVal, captured }) {
  const pawns = room.pawns[player.id];
  if (player.diceStats) player.diceStats.captureStreak = captured ? (player.diceStats.captureStreak || 0) + 1 : 0;
  if (pawns.every(v => v === FINISH)) {
    declareWinner(room, player);
    return;
  }

  const reachedGoal = toVal === FINISH;
  if (reachedGoal) resolveGoal(room, player, pawnIdx);
  room.dice = null;

  // Angka 6, bidak masuk finish, atau memakan lawan memberi bonus giliran
  if (rollVal === 6 || reachedGoal || captured) {
    if (reachedGoal) {
      room.message = `🎯 Bidak masuk ke garis tengah! ${player.name} dapat bonus giliran lempar dadu & jalan satu bidak lagi!`;
      addHistory(room, `🎯 ${player.name} memasukkan bidak ke tengah (bonus lempar dadu & jalan lagi)!`);
    } else if (captured) {
      room.message = `⚔️ Bidak lawan berhasil dieliminasi! ${player.name} dapat giliran jalan lagi sekali!${room.lastBlackHole ? ' (Bidakmu sendiri tersedot Black Hole.)' : ''}`;
      addHistory(room, `⚔️ ${player.name} mengeliminasi bidak lawan (bonus lempar dadu & jalan lagi)!`);
    } else {
      room.message = `Dapat angka 6! ${player.name} dapat melempar dadu sekali lagi.`;
      addHistory(room, `🎲 ${player.name} dapat angka 6 (bonus lempar lagi)!`);
    }
    emitRoom(room);
    triggerTurn(room);
  } else {
    if (fromVal === 0 && rollVal === 1) addHistory(room, `🚪 ${player.name} keluar kotak dengan angka 1.`);
    advanceTurn(room);
  }
}

// Makan bidak lawan di petak tujuan (lintasan utama). Return true jika ada yang dimakan.
function captureAt(room, player, toVal) {
  if (toVal < 1 || toVal > 39) return false;
  const trackPos = getTrackIndex(COLORS.indexOf(player.color), toVal);
  let captured = false;

  // Dicek sebelum Black Hole, termasuk di petak Black Hole: lawan yang bertahan
  //    di sana (memakai perisai) tetap bisa dimakan dan tetap memberi bonus giliran.
  //    Bidak yang terlindungi (start miliknya / bintang) tidak pernah sampai sini karena
  //    canPawnMove menutup petak itu, tapi tetap dicek agar aman.
  for (const opponent of room.players) {
    if (opponent.id === player.id) continue;
    const oppColorIdx = COLORS.indexOf(opponent.color);
    const oppPawns = room.pawns[opponent.id];
    if (!oppPawns) continue;

    oppPawns.forEach((oppVal, j) => {
      if (oppVal < 1 || oppVal > 39) return;
      if (getTrackIndex(oppColorIdx, oppVal) !== trackPos || isPawnProtected(room, opponent, trackPos)) return;

      oppPawns[j] = 0;
      captured = true;
      room.lastCapture = {
        id: eventId(),
        attacker: player.name,
        attackerId: player.id,
        defender: opponent.name,
        defenderId: opponent.id,
        color: opponent.color,
        defenderIsOut: !!opponent.isOut,
        trackPos
      };
      addHistory(room, `⚔️ ${player.name} memakan bidak ${opponent.name}${opponent.isOut ? ' (pemain out)' : ''}!`);
      runItemHooks(room, player, 'capture', { victim: opponent, pawnIdx: j });
    });
  }
  return captured;
}

function suckIntoBlackHole(room, player, pawnIdx, trackPos) {
  room.pawns[player.id][pawnIdx] = 0;
  room.lastBlackHole = { id: eventId(), playerId: player.id, pawnIdx, trackPos, color: player.color, time: Date.now() };
  addHistory(room, `🕳️ Bidak ${pawnIdx + 1} milik ${player.name} menginjak Black Hole dan tersedot kembali ke Base!`);
  room.message = `🕳️ Bidak ${player.name} tersedot Black Hole ke base!`;
}

// Bidak masuk finish
function resolveGoal(room, player, pawnIdx) {
  room.lastGoal = { id: eventId(), playerId: player.id, playerName: player.name, color: player.color, pawnIdx };
  addHistory(room, `⭐ ${player.name} berhasil memasukkan 1 bidak ke garis akhir!`);
  player.finishedCount = room.pawns[player.id].filter(v => v === FINISH).length;
}

// ==========================================
// ITEM
// ==========================================

// Helper engine yang boleh dipakai definisi item (lihat server/items/index.js)
function gameApi(room, player, item) {
  return {
    addHistory: text => addHistory(room, text),
    setMessage: text => { room.message = text; },
    announce: ({ title, text }) => {
      room.lastItemEvent = {
        id: eventId(),
        itemId: item.id,
        icon: item.icon,
        sound: item.sound || 'chime',
        title,
        text,
        playerId: player.id,
        playerName: player.name
      };
    },
    sendPawnHome: (owner, pawnIdx) => {
      room.pawns[owner.id][pawnIdx] = 0;
    },
    recordCapture: (defender, extra = {}) => {
      room.lastCapture = { id: eventId(), attacker: player.name, attackerId: player.id, defender: defender.name, defenderId: defender.id, color: defender.color, ...extra };
    }
  };
}

function itemContext(room, player, item, data = {}) {
  return {
    ...data,
    room,
    player,
    item,
    count: inventory.count(player, item.id),
    state: inventory.state(player, item.id),
    consume: () => inventory.consume(player, item.id),
    grant: (amount = 1) => inventory.grant(player, item.id, amount),
    game: gameApi(room, player, item)
  };
}

// Jalankan hook semua item untuk satu event. Berhenti di item pertama yang menangani event (return true).
function runItemHooks(room, player, event, data) {
  for (const item of items.list()) {
    const hook = item.hooks?.[event];
    if (hook && hook(itemContext(room, player, item, data)) === true) return true;
  }
  return false;
}

// Pemain yang sedang giliran dan boleh memakai item aktif. Item aktif hanya boleh dipakai
// SEBELUM melempar dadu agar tidak bisa dipakai untuk mengocok ulang.
function currentActor(socket, room) {
  if (!room || !room.started || room.winner || room.rolling || room.animatingMove || room.pendingShield) return null;
  const player = room.players[room.turn];
  if (!player || player.id !== socket.id || player.isOut) {
    socket.emit('room:error', 'Sekarang bukan giliranmu.');
    return null;
  }
  if (room.dice !== null) {
    socket.emit('room:error', 'Item hanya bisa dipakai sebelum melempar dadu.');
    return null;
  }
  return player;
}

// Target { playerId, pawnIdx } dari klien -> { player, pawnIdx }. Return null jika tidak valid.
function resolveOpponentPawn(socket, room, actor, target) {
  const targetPlayer = typeof target?.playerId === 'string' ? room.players.find(p => p.id === target.playerId) : null;
  if (!targetPlayer || targetPlayer.id === actor.id) {
    socket.emit('room:error', 'Pemain target tidak valid.');
    return null;
  }
  const pawns = room.pawns[targetPlayer.id];
  if (!pawns || !isPawnIndex(target.pawnIdx)) {
    socket.emit('room:error', 'Bidak target tidak valid.');
    return null;
  }
  const val = pawns[target.pawnIdx];
  if (val < 1 || val > 39) {
    socket.emit('room:error', 'Hanya bidak lawan di lintasan yang dapat dieliminasi.');
    return null;
  }
  return { player: targetPlayer, pawnIdx: target.pawnIdx };
}

function useItem(socket, room, { itemId, target }) {
  const item = items.get(itemId);
  if (!item || item.kind !== 'active') return socket.emit('room:error', 'Item tidak valid.');

  const player = currentActor(socket, room);
  if (!player) return;
  if (inventory.count(player, item.id) <= 0) {
    return socket.emit('room:error', `Kamu tidak punya ${item.name}. Beli dulu di Toko.`);
  }

  const reason = item.canUse?.(itemContext(room, player, item));
  if (reason) return socket.emit('room:error', `${item.name} belum bisa dipakai: ${reason}`);

  let resolvedTarget = null;
  if (item.target === 'opponentPawn') {
    resolvedTarget = resolveOpponentPawn(socket, room, player, target);
    if (!resolvedTarget) return;
  }

  const ctx = itemContext(room, player, item, { target: resolvedTarget });
  if (!ctx.consume()) return socket.emit('room:error', `${item.name} gagal dipakai. Coba lagi.`);

  // Serangan yang bisa ditahan perisai lawan (mis. Force Return vs Universal Shield)
  if (item.attack && resolvedTarget) {
    const outcome = protectPawn(room, resolvedTarget.player, item.attack, { pawnIdx: resolvedTarget.pawnIdx, attacker: player },
      { type: 'item', attackerId: player.id, itemId: item.id });
    if (outcome === 'pending') return emitRoom(room);
    if (outcome === 'protected') {
      emitRoom(room);
      return triggerTurn(room);
    }
  }

  item.use(ctx);
  emitRoom(room);
  triggerTurn(room);
}

// ==========================================
// PERISAI: item yang menahan Force Return / Black Hole untuk pemiliknya
// ==========================================

// Coba lindungi bidak `owner` dari sebuah event. Return:
//   'protected' -> dicegah item (pasif otomatis, atau reaktif yang dipakai otomatis untuk bot/terputus)
//   'exposed'   -> tidak ada perisai, efek berjalan
//   'pending'   -> pemilik ditanya dulu; permainan berhenti sampai resolvePendingShield()
// `resume` menyimpan cara melanjutkan permainan setelah keputusan (disimpan sebagai data agar
// tetap bisa dilanjutkan setelah server restart).
function protectPawn(room, owner, event, data, resume) {
  if (runItemHooks(room, owner, event, data)) return 'protected';

  const shield = items.list().find(item => item.kind === 'reactive' && item.protects.includes(event) && inventory.count(owner, item.id) > 0);
  if (!shield) return 'exposed';

  if (owner.isBot || !owner.connected) return useShield(room, owner, shield, event, data) ? 'protected' : 'exposed';

  room.pendingShield = {
    id: eventId(),
    playerId: owner.id,
    itemId: shield.id,
    event,
    pawnIdx: data.pawnIdx,
    trackPos: data.trackPos ?? null,
    attackerId: data.attacker?.id || null,
    expiresAt: Date.now() + SHIELD_DECISION_MS,
    resume
  };
  const threat = event === 'forceReturn' ? `Force Return dari ${data.attacker?.name || 'lawan'}` : 'Black Hole';
  room.message = `🔰 ${owner.name} sedang memutuskan memakai ${shield.name} untuk menahan ${threat}...`;
  armShieldTimer(room);
  return 'pending';
}

function useShield(room, owner, shield, event, data) {
  if (!inventory.consume(owner, shield.id)) return false;
  shield.protect(itemContext(room, owner, shield, { ...data, event }));
  return true;
}

// Waktu memutuskan habis: perisai dipakai (pemain membelinya untuk melindungi bidak)
function armShieldTimer(room) {
  if (room.shieldTimer) clearTimeout(room.shieldTimer);
  const pending = room.pendingShield;
  const delay = Math.max(0, pending.expiresAt - Date.now());
  room.shieldTimer = roomTimeout(room, () => {
    if (room.pendingShield?.id === pending.id) resolvePendingShield(room, true);
  }, delay);
}

// Pilihan pemain dari popup perisai
function decideShield(socket, room, { use }) {
  const pending = room?.pendingShield;
  if (!pending || pending.playerId !== socket.id) return;
  resolvePendingShield(room, use === true);
}

function resolvePendingShield(room, use) {
  const pending = room.pendingShield;
  if (!pending) return;
  room.pendingShield = null;
  if (room.shieldTimer) clearTimeout(room.shieldTimer);
  room.shieldTimer = null;

  const owner = room.players.find(p => p.id === pending.playerId);
  const attacker = pending.attackerId ? room.players.find(p => p.id === pending.attackerId) : null;
  const shield = items.get(pending.itemId);
  const data = { pawnIdx: pending.pawnIdx, trackPos: pending.trackPos, attacker };
  const isProtected = !!(use && owner && shield && useShield(room, owner, shield, pending.event, data));
  if (!isProtected && owner) addHistory(room, `${owner.name} memilih tidak memakai ${shield?.name || 'perisai'}.`);

  const { resume } = pending;
  if (resume.type === 'move') {
    const mover = room.players.find(p => p.id === resume.playerId) || owner;
    if (!isProtected) suckIntoBlackHole(room, mover, resume.move.pawnIdx, pending.trackPos);
    finishMove(room, mover, resume.move);
    return;
  }

  // resume.type === 'item': lanjutkan serangan item aktif yang tadi ditahan
  const item = items.get(resume.itemId);
  if (!isProtected && item && attacker && owner) {
    item.use(itemContext(room, attacker, item, { target: { player: owner, pawnIdx: pending.pawnIdx } }));
  }
  emitRoom(room);
  triggerTurn(room);
}

module.exports = {
  startGame,
  restartGame,
  declareWinner,
  advanceTurn,
  triggerTurn,
  executeAutoPlay,
  handleRoll,
  handleMove,
  useItem,
  decideShield,
  resolvePendingShield
};
