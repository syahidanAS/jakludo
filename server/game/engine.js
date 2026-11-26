// Alur permainan: giliran, dadu, langkah bidak, pemakaian item, dan keputusan perisai.
const crypto = require('crypto');
const db = require('../db');
const items = require('../items');
const inventory = require('./inventory');
const store = require('./store');
const social = require('../social/store');
const {
  MAX_SKIN_SHIELD_CHARGES,
  SKIN_ANTI_ELIMINATION_ID,
  MAX_SKIN_INVISIBLE_CHARGES,
  SKIN_INVISIBLE_ID,
  resolveSkinKey,
  skinDisplayName,
  canUseSkinAntiElimination,
  hasInvisibleSkin,
  isSkinInvisibleActive,
  canUseSkinInvisible,
  initPlayerSkinSkill,
  clearPlayerSkinSkill,
  rechargeSkinAntiElimination,
  consumeSkinAntiElimination,
  consumeSkinInvisible,
  expireSkinInvisible
} = require('./skinSkills');
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
const newDiceStats = () => ({
  counts: [0, 0, 0, 0, 0, 0],
  total: 0,
  captureStreak: 0,
  lowRollStreak: 0,
  stuckBaseStreak: 0,
  blackHoleGrace: 0
});

// ==========================================
// MULAI & SELESAI
// ==========================================

function resetPlayerForGame(p) {
  p.autoPlayCount = 0;
  p.isOut = false;
  p.left = false;
  p.finishedCount = 0;
  p.diceStats = newDiceStats();
  inventory.resetForMatch(p);
  if (p.userId) inventory.loadOwned(p, db.getUserItems(p.userId));
  initPlayerSkinSkill(p);
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

// Main lagi: hanya setelah ada pemenang. Pemain yang tetap berada di room (termasuk yang sempat OUT dan menonton) diikutkan.
function restartGame(r) {
  const remaining = r.players.filter(p => !p.left || p.connected);
  if (remaining.length < 2) return 'Butuh minimal 2 pemain untuk bermain lagi. Undang teman atau cari pemain acak di room baru.';
  for (const p of r.players) {
    if (p.left && !p.connected) delete r.pawns[p.id];
    else p.left = false;
  }
  r.players = remaining;
  startGame(r);
  return null;
}

function declareWinner(room, winnerPlayer, { endReason = null } = {}) {
  if (!room || room.winner) return;
  clearRoomTimers(room);
  room.winner = winnerPlayer.id;
  room.dice = null;
  room.pendingShield = null;
  room.message = `🏆 SELAMAT! ${winnerPlayer.name} MENANG!`;
  addHistory(room, `🎉 ${winnerPlayer.name} berhasil memenangkan pertandingan JakLudo!`);

  // Poin sama untuk permainan biasa dan grup (leaderboard grup diambil dari leaderboard yang sama)
  const ranking = rankPlayers(room, winnerPlayer.id);
  const allowBotMatch = Boolean(room.hasMatchmakingBots || room.players.some(p => p.isBot && p.organicBot));
  const awards = db.recordMatchResult({
    winnerPlayerId: winnerPlayer.id,
    players: room.players,
    ranking,
    endReason,
    allowBotMatch
  });
  // Peringkat resmi + poin yang didapat, ditampilkan di layar hasil
  room.matchResult = { ranking, awards };
  room.players.forEach(p => {
    p.isLudoKing = db.checkIsLudoKing(p.userId);
    clearPlayerSkinSkill(p);
  });
  store.getIo().emit('leaderboard:update', db.getLeaderboard());
  if (room.groupId) {
    social.notifyGroupLeaderboardUpdated(room.groupId);
  }

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
  const invisibleEnded = expireSkinInvisible(nextPlayer);
  if (invisibleEnded) addHistory(room, `👁️ Efek Invisible ${nextPlayer.name} berakhir. Bidaknya kembali terlihat.`);
  room.message = `Giliran ${nextPlayer.name}${nextPlayer.autoPlayCount > 0 ? ` (Auto-Play ${nextPlayer.autoPlayCount}/${MAX_AUTO_PLAY})` : ''}.${holesShifted ? ' 🕳️ Black Hole pindah tempat!' : ''}${invisibleEnded ? ' 👁️ Invisible berakhir.' : ''}`;

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
function triggerTurn(room, { preserveClock = false } = {}) {
  if (!room || !room.started || room.winner || room.rolling || room.animatingMove) return;
  // Permainan berhenti sampai pemilik perisai memutuskan (timer dipasang ulang setelah server restart)
  if (room.pendingShield) {
    armShieldTimer(room);
    return;
  }
  const currentPlayer = room.players[room.turn];
  if (!currentPlayer) return;

  const existingEndsAt = preserveClock && room.turnClock && room.turnClock.playerId === currentPlayer.id
    ? room.turnClock.endsAt
    : null;

  if (room.botTimeout) clearTimeout(room.botTimeout);
  if (room.turnTimer) clearTimeout(room.turnTimer);
  room.turnClock = null;

  if (currentPlayer.isOut) {
    advanceTurn(room);
    return;
  }

  if (currentPlayer.isBot) {
    if (room.dice === null) {
      const rollDelay = process.env.NODE_ENV === 'test' ? 120 : 850 + Math.floor(Math.random() * 850);
      room.botTimeout = roomTimeout(room, () => {
        if (room.players[room.turn]?.id === currentPlayer.id && room.dice === null && !room.animatingMove) {
          handleRoll(room, currentPlayer.id);
        }
      }, rollDelay);
    } else {
      scheduleAutoMove(room, currentPlayer, false);
    }
    return;
  }

  // Pemain manusia: online -> batas waktu 15 detik (atau lanjutkan sisa timer saat reconnect), terputus -> 8 detik
  const remainingExisting = existingEndsAt ? existingEndsAt - Date.now() : 0;
  const delay = currentPlayer.connected
    ? (remainingExisting > 0 ? Math.max(2000, Math.min(TURN_TIMEOUT_MS, remainingExisting)) : TURN_TIMEOUT_MS)
    : DISCONNECTED_TURN_DELAY_MS;
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
  const moveDelay = process.env.NODE_ENV === 'test' ? 150 : (player.isBot ? 650 + Math.floor(Math.random() * 750) : 800);
  room.botTimeout = roomTimeout(room, () => {
    if (room.players[room.turn]?.id === player.id && room.dice !== null && !room.animatingMove) {
      handleMove(room, player.id, bestPawn, isAuto);
    }
  }, moveDelay);
}

function executeAutoPlay(room, player) {
  if (!room || !room.started || room.winner || room.rolling || room.animatingMove || room.pendingShield) return;
  if (room.players[room.turn]?.id !== player.id) return;

  // OUT setelah 3x auto-play berturut-turut: langsung jika pemain online tapi diam (AFK),
  // atau jika sudah offline cukup lama. Sinyal yang goyang sebentar tidak membuat pemain OUT.
  const offlineTooLong = !player.connected && Date.now() - (player.disconnectedAt || 0) >= OFFLINE_OUT_MS;
  if ((player.autoPlayCount || 0) >= MAX_AUTO_PLAY && (player.connected || offlineTooLong)) {
    player.isOut = true;
    expireSkinInvisible(player);
    player.autoPlayCount = MAX_AUTO_PLAY;
    addHistory(room, `❌ ${player.name} dinyatakan OUT (batas ${MAX_AUTO_PLAY}x auto-play tercapai tanpa respon).`);
    room.message = `❌ ${player.name} dinyatakan OUT!`;
    if (store.deleteIfAllHumansOut(room, `${player.name} dinyatakan OUT karena ${MAX_AUTO_PLAY}x tidak jalan. Room ditutup karena tidak ada pemain lain.`)) return;
    if (room.host === player.id) store.reassignHost(room);
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
    const pawns = room.pawns[currentPlayer.id] || [];
    const hasActivePawn = pawns.some(v => v >= 1 && v < FINISH);
    stats.lowRollStreak = roll <= 3 ? (stats.lowRollStreak || 0) + 1 : 0;
    if (!hasActivePawn && pawns.some(v => v === 0)) {
      stats.stuckBaseStreak = roll === 1 || roll === 6 ? 0 : (stats.stuckBaseStreak || 0) + 1;
    } else {
      stats.stuckBaseStreak = 0;
    }
    if ((stats.blackHoleGrace || 0) > 0) stats.blackHoleGrace = Math.max(0, stats.blackHoleGrace - 1);
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
  room.message = isSkinInvisibleActive(player)
    ? `👻 ${player.name} melangkah secara tersembunyi...`
    : `${player.name} memajukan bidak ${pawnIdx + 1} (${steps} langkah)...`;
  emitRoom(room);

  // Efek langkah diproses setelah animasi di klien selesai
  if (room.moveTimer) clearTimeout(room.moveTimer);
  room.moveTimer = roomTimeout(room, () => {
    room.animatingMove = null;
    const move = { pawnIdx, fromVal, toVal, rollVal, captured: false };
    const victims = findCapturableVictims(room, player, toVal);
    processMoveCaptures(room, player, move, victims, 0);
  }, steps * 220 + 360);
}

function continueMoveAfterCaptures(room, player, move) {
  const { pawnIdx, toVal } = move;
  // Black Hole: perisai pasif dicoba dulu, lalu pemain bisa ditanya soal Universal Shield
  const trackPos = toVal <= 39 ? getTrackIndex(COLORS.indexOf(player.color), toVal) : null;
  if (trackPos !== null && room.settings?.blackHole && getBlackHoles(room).includes(trackPos)) {
    const outcome = protectPawn(room, player, 'blackHole', { pawnIdx, trackPos }, { type: 'move', playerId: player.id, move });
    if (outcome === 'pending') return emitRoom(room);
    if (outcome === 'exposed') suckIntoBlackHole(room, player, pawnIdx, trackPos);
  }
  finishMove(room, player, move);
}

function findCapturableVictims(room, player, toVal) {
  if (toVal < 1 || toVal > 39) return [];
  const trackPos = getTrackIndex(COLORS.indexOf(player.color), toVal);
  const victims = [];
  for (const opponent of room.players) {
    if (opponent.id === player.id) continue;
    const oppColorIdx = COLORS.indexOf(opponent.color);
    const oppPawns = room.pawns[opponent.id];
    if (!oppPawns) continue;
    oppPawns.forEach((oppVal, j) => {
      if (oppVal < 1 || oppVal > 39) return;
      if (getTrackIndex(oppColorIdx, oppVal) !== trackPos || isPawnProtected(room, opponent, trackPos)) return;
      victims.push({ playerId: opponent.id, pawnIdx: j, trackPos });
    });
  }
  return victims;
}

function executeStompCapture(room, attacker, victim, pawnIdx, trackPos) {
  const oppPawns = room.pawns[victim.id];
  if (!oppPawns) return false;
  const wasInvisible = isSkinInvisibleActive(victim);
  oppPawns[pawnIdx] = 0;
  room.lastCapture = {
    id: eventId(),
    attacker: attacker.name,
    attackerId: attacker.id,
    defender: victim.name,
    defenderId: victim.id,
    color: victim.color,
    defenderIsOut: !!victim.isOut,
    wasInvisible,
    trackPos
  };
  addHistory(
    room,
    wasInvisible
      ? `⚔️ ${attacker.name} menginjak bidak tersembunyi (Invisible) milik ${victim.name}${victim.isOut ? ' (pemain out)' : ''}!`
      : `⚔️ ${attacker.name} memakan bidak ${victim.name}${victim.isOut ? ' (pemain out)' : ''}!`
  );
  runItemHooks(room, attacker, 'capture', { victim, pawnIdx });
  return true;
}

function processMoveCaptures(room, player, move, victims, startIndex = 0) {
  for (let idx = startIndex; idx < victims.length; idx++) {
    const v = victims[idx];
    const victim = room.players.find(p => p.id === v.playerId);
    if (!victim) continue;
    const oppVal = room.pawns[victim.id]?.[v.pawnIdx];
    const oppColorIdx = COLORS.indexOf(victim.color);
    if (!oppVal || oppVal < 1 || oppVal > 39) continue;
    if (getTrackIndex(oppColorIdx, oppVal) !== v.trackPos || isPawnProtected(room, victim, v.trackPos)) continue;

    const outcome = protectPawn(
      room,
      victim,
      'stomp',
      { pawnIdx: v.pawnIdx, trackPos: v.trackPos, attacker: player },
      { type: 'stomp', playerId: player.id, move, victims, victimIndex: idx }
    );
    if (outcome === 'pending') {
      emitRoom(room);
      return;
    }
    if (outcome === 'protected') continue;

    if (executeStompCapture(room, player, victim, v.pawnIdx, v.trackPos)) {
      move.captured = true;
    }
  }
  continueMoveAfterCaptures(room, player, move);
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

function suckIntoBlackHole(room, player, pawnIdx, trackPos) {
  room.pawns[player.id][pawnIdx] = 0;
  if (!player.diceStats) player.diceStats = newDiceStats();
  player.diceStats.blackHoleGrace = Math.max(player.diceStats.blackHoleGrace || 0, 3);
  room.lastBlackHole = { id: eventId(), playerId: player.id, pawnIdx, trackPos, color: player.color, time: Date.now() };
  addHistory(room, `🕳️ Bidak ${pawnIdx + 1} milik ${player.name} menginjak Black Hole dan tersedot kembali ke Base!`);
  room.message = `🕳️ Bidak ${player.name} tersedot Black Hole ke base!`;
}

// Bidak masuk finish
function resolveGoal(room, player, pawnIdx) {
  room.lastGoal = { id: eventId(), playerId: player.id, playerName: player.name, color: player.color, pawnIdx };
  addHistory(room, `⭐ ${player.name} berhasil memasukkan 1 bidak ke garis akhir!`);
  player.finishedCount = room.pawns[player.id].filter(v => v === FINISH).length;
  const recharge = rechargeSkinAntiElimination(player);
  if (recharge.gained) {
    addHistory(room, `🛡️ ${player.name} mendapat +1 Anti-Eliminasi dari garis finish (${recharge.charges}/${recharge.max})!`);
  }
}

// ==========================================
// ITEM
// ==========================================

// Helper engine yang boleh dipakai definisi item (lihat server/items/index.js)
function gameApi(room, player, item) {
  return {
    addHistory: text => addHistory(room, text),
    setMessage: text => { room.message = text; },
    // pawn (opsional): bidak yang terkena item, untuk posisi efek visual di klien.
    // val bisa diisi manual bila bidaknya sudah dipindah (mis. Force Return sudah memulangkannya).
    announce: ({ title, text, pawn = null }) => {
      const fx = pawn
        ? { color: pawn.player.color, val: pawn.val ?? room.pawns[pawn.player.id]?.[pawn.pawnIdx] ?? 0 }
        : null;
      room.lastItemEvent = {
        fx,
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
  if (isSkinInvisibleActive(targetPlayer)) {
    socket.emit('room:error', 'Bidak lawan sedang tidak terlihat (Invisible) dan tidak bisa ditarget.');
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
function protectPawn(room, owner, event, data, resume, { skipSkinShield = false } = {}) {
  // Skill Anti-Eliminasi per pertandingan milik Emerald Green / Galaxy Purple (stomp & Force Return, wajib konfirmasi)
  if (
    !skipSkinShield &&
    (event === 'stomp' || event === 'forceReturn') &&
    !owner.isBot &&
    owner.connected &&
    canUseSkinAntiElimination(owner)
  ) {
    const skinKey = resolveSkinKey(owner.equippedSkin);
    const skinName = skinDisplayName(owner.equippedSkin);
    room.pendingShield = {
      id: eventId(),
      playerId: owner.id,
      source: 'skinShield',
      itemId: SKIN_ANTI_ELIMINATION_ID,
      skinKey,
      skinName,
      charges: Number(owner.skinShieldCharges || 0),
      maxCharges: MAX_SKIN_SHIELD_CHARGES,
      event,
      pawnIdx: data.pawnIdx,
      trackPos: data.trackPos ?? null,
      attackerId: data.attacker?.id || null,
      expiresAt: Date.now() + SHIELD_DECISION_MS,
      resume
    };
    const threat = event === 'forceReturn'
      ? `Force Return dari ${data.attacker?.name || 'lawan'}`
      : `injakan dari ${data.attacker?.name || 'lawan'}`;
    room.message = `🛡️ ${owner.name} sedang mengonfirmasi skill Anti-Eliminasi (${skinName}) untuk menahan ${threat}...`;
    armShieldTimer(room);
    return 'pending';
  }

  // Item perisai toko (Blackhole Shield / Universal Shield) tidak melindungi injakan biasa
  if (event === 'stomp') return 'exposed';

  if (runItemHooks(room, owner, event, data)) return 'protected';

  const shield = items.list().find(item => item.kind === 'reactive' && item.protects.includes(event) && inventory.count(owner, item.id) > 0);
  if (!shield) return 'exposed';

  if (owner.isBot || !owner.connected) return useShield(room, owner, shield, event, data) ? 'protected' : 'exposed';

  room.pendingShield = {
    id: eventId(),
    playerId: owner.id,
    source: 'item',
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

function activateSkinAntiElimination(room, owner, event, data) {
  if (!consumeSkinAntiElimination(owner)) return false;
  const skinKey = resolveSkinKey(owner.equippedSkin);
  const skinName = skinDisplayName(owner.equippedSkin);
  const remaining = Math.max(0, Number(owner.skinShieldCharges || 0));
  const what = event === 'forceReturn'
    ? `Force Return dari ${data.attacker?.name || 'lawan'}`
    : `injakan dari ${data.attacker?.name || 'lawan'}`;
  addHistory(room, `🛡️ ANTI-ELIMINASI (${skinName})! Bidak ${data.pawnIdx + 1} milik ${owner.name} selamat dari ${what}. (Sisa skill: ${remaining}/${MAX_SKIN_SHIELD_CHARGES})`);
  room.message = `🛡️ ${owner.name} mengaktifkan Anti-Eliminasi (${skinName}) dan menahan ${what}!`;
  room.lastItemEvent = {
    id: eventId(),
    itemId: SKIN_ANTI_ELIMINATION_ID,
    skinKey,
    icon: '🛡️',
    sound: 'chime',
    title: 'ANTI-ELIMINASI AKTIF!',
    text: `Bidak ${owner.name} selamat dari ${what} (Sisa skill: ${remaining}/${MAX_SKIN_SHIELD_CHARGES}).`,
    playerId: owner.id,
    playerName: owner.name,
    fx: { color: owner.color, val: room.pawns[owner.id]?.[data.pawnIdx] ?? 0 }
  };
  return true;
}

function useShield(room, owner, shield, event, data) {
  if (!inventory.consume(owner, shield.id)) return false;
  shield.protect(itemContext(room, owner, shield, { ...data, event }));
  return true;
}

// Waktu memutuskan habis: untuk Universal Shield otomatis dipakai, sedangkan untuk skill skin (butuh konfirmasi) tidak dipakai
function armShieldTimer(room) {
  if (room.shieldTimer) clearTimeout(room.shieldTimer);
  const pending = room.pendingShield;
  const delay = Math.max(0, pending.expiresAt - Date.now());
  const defaultUse = pending.source === 'skinShield' ? false : true;
  room.shieldTimer = roomTimeout(room, () => {
    if (room.pendingShield?.id === pending.id) resolvePendingShield(room, defaultUse, { timedOut: true });
  }, delay);
}

// Pilihan pemain dari popup perisai
function decideShield(socket, room, { use }) {
  const pending = room?.pendingShield;
  if (!pending || pending.playerId !== socket.id) return;
  resolvePendingShield(room, use === true);
}

function resolvePendingShield(room, use, { timedOut = false } = {}) {
  const pending = room.pendingShield;
  if (!pending) return;
  room.pendingShield = null;
  if (room.shieldTimer) clearTimeout(room.shieldTimer);
  room.shieldTimer = null;

  const owner = room.players.find(p => p.id === pending.playerId);
  const attacker = pending.attackerId ? room.players.find(p => p.id === pending.attackerId) : null;
  const data = { pawnIdx: pending.pawnIdx, trackPos: pending.trackPos, attacker };

  let isProtected = false;
  if (pending.source === 'skinShield') {
    isProtected = !!(use && owner && activateSkinAntiElimination(room, owner, pending.event, data));
    if (!isProtected && owner) {
      addHistory(
        room,
        timedOut
          ? `${owner.name} tidak mengonfirmasi Anti-Eliminasi tepat waktu.`
          : `${owner.name} memilih tidak memakai Anti-Eliminasi.`
      );
    }
  } else {
    const shield = items.get(pending.itemId);
    isProtected = !!(use && owner && shield && useShield(room, owner, shield, pending.event, data));
    if (!isProtected && owner) addHistory(room, `${owner.name} memilih tidak memakai ${shield?.name || 'perisai'}.`);
  }

  const { resume } = pending;
  if (resume.type === 'stomp') {
    const mover = room.players.find(p => p.id === resume.playerId) || attacker;
    if (!isProtected && mover && owner) {
      const oppVal = room.pawns[owner.id]?.[pending.pawnIdx];
      const oppColorIdx = COLORS.indexOf(owner.color);
      if (oppVal >= 1 && oppVal <= 39 && getTrackIndex(oppColorIdx, oppVal) === pending.trackPos && !isPawnProtected(room, owner, pending.trackPos)) {
        if (executeStompCapture(room, mover, owner, pending.pawnIdx, pending.trackPos)) {
          resume.move.captured = true;
        }
      }
    }
    processMoveCaptures(room, mover, resume.move, resume.victims, resume.victimIndex + 1);
    return;
  }

  if (resume.type === 'move') {
    const mover = room.players.find(p => p.id === resume.playerId) || owner;
    if (!isProtected) suckIntoBlackHole(room, mover, resume.move.pawnIdx, pending.trackPos);
    finishMove(room, mover, resume.move);
    return;
  }

  // resume.type === 'item': jika skinShield ditolak, cek apakah pemain punya Universal Shield sebagai cadangan
  if (!isProtected && pending.source === 'skinShield' && owner && attacker) {
    const fallbackOutcome = protectPawn(room, owner, pending.event, data, resume, { skipSkinShield: true });
    if (fallbackOutcome === 'pending') return emitRoom(room);
    if (fallbackOutcome === 'protected') {
      emitRoom(room);
      return triggerTurn(room);
    }
  }

  // Lanjutkan serangan item aktif yang tadi ditahan
  const item = items.get(resume.itemId);
  if (!isProtected && item && attacker && owner) {
    item.use(itemContext(room, attacker, item, { target: { player: owner, pawnIdx: pending.pawnIdx } }));
  }
  emitRoom(room);
  triggerTurn(room);
}

function useSkinSkill(socket, room, { skill } = {}) {
  if (skill !== 'invisible') return socket.emit('room:error', 'Skill skin tidak dikenal.');
  const player = currentActor(socket, room);
  if (!player) return;

  if (!player.skinInvisibleEnabled || !hasInvisibleSkin(player.equippedSkin)) {
    return socket.emit('room:error', 'Skin aktifmu tidak memiliki skill Invisible.');
  }
  if (isSkinInvisibleActive(player)) {
    return socket.emit('room:error', 'Skill Invisible sedang aktif.');
  }
  if (!canUseSkinInvisible(player)) {
    return socket.emit('room:error', 'Skill Invisible hanya bisa digunakan 2 kali per permainan.');
  }

  if (!consumeSkinInvisible(player)) {
    return socket.emit('room:error', 'Skill Invisible gagal diaktifkan.');
  }

  const skinKey = resolveSkinKey(player.equippedSkin);
  const skinName = skinDisplayName(player.equippedSkin);
  const remaining = Math.max(0, Number(player.skinInvisibleCharges || 0));

  addHistory(room, `👻 INVISIBLE (${skinName})! Bidak ${player.name} kini tidak terlihat musuh sampai giliran berikutnya. (Sisa skill: ${remaining}/${MAX_SKIN_INVISIBLE_CHARGES})`);
  room.message = `👻 ${player.name} mengaktifkan Invisible (${skinName})! Bidaknya tidak terlihat musuh.`;
  room.lastItemEvent = {
    id: eventId(),
    itemId: SKIN_INVISIBLE_ID,
    skinKey,
    icon: '👻',
    sound: 'chime',
    title: 'INVISIBLE AKTIF!',
    text: `Bidak ${player.name} tidak terlihat oleh musuh sampai giliran berikutnya (Sisa: ${remaining}/${MAX_SKIN_INVISIBLE_CHARGES}).`,
    playerId: player.id,
    playerName: player.name,
    fx: null
  };
  emitRoom(room);
  triggerTurn(room, { preserveClock: true });
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
  useSkinSkill,
  decideShield,
  resolvePendingShield
};
