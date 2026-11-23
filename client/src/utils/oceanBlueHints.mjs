// Evaluator taktis langkah bidak JakLudo khusus skin Ocean Blue.
// Dibuat sebagai modul ES murni tanpa dependensi eksternal agar bisa dijalankan oleh Vite/React maupun Node test.

export const COLORS = ['red', 'green', 'yellow', 'blue'];
export const COLOR_OFFSETS = [0, 10, 20, 30];
export const SAFE_TRACK_INDICES = [0, 6, 10, 16, 20, 26, 30, 36];
export const BLACK_HOLE_INDICES = [4, 14, 24, 34];
export const FINISH = 44;

export function hasOceanBlueHintAbility(skin) {
  if (!skin) return false;
  if (typeof skin === 'string') return skin === 'ocean_blue';
  return skin.id === 'ocean_blue' || skin.assetKey === 'ocean_blue';
}

export function getTrackIndex(colorIdx, pawnVal) {
  if (colorIdx < 0 || colorIdx >= COLOR_OFFSETS.length) return null;
  if (pawnVal >= 1 && pawnVal <= 39) {
    return (COLOR_OFFSETS[colorIdx] + pawnVal - 1) % 40;
  }
  return null;
}

export function isPawnProtected(room, owner, trackPos) {
  if (!owner || owner.isOut || trackPos === null || trackPos === undefined) return false;
  const colorIdx = COLORS.indexOf(owner.color);
  if (colorIdx === -1) return false;
  if (trackPos === COLOR_OFFSETS[colorIdx]) return true;
  if (COLOR_OFFSETS.includes(trackPos)) return false;
  return room?.settings?.safeZones !== false && SAFE_TRACK_INDICES.includes(trackPos);
}

export function getBlackHoles(room) {
  if (!room?.settings?.blackHole) return [];
  return Array.isArray(room.blackHoles) && room.blackHoles.length > 0
    ? room.blackHoles
    : BLACK_HOLE_INDICES;
}

function itemStockCount(stock) {
  if (!stock || typeof stock !== 'object') return 0;
  if (typeof stock.count === 'number') return stock.count;
  return (stock.owned || 0) + (stock.earned || 0);
}

export function hasBlackHoleShield(player) {
  const items = player?.items;
  if (!items) return false;
  return itemStockCount(items.blackholeShield) > 0 || itemStockCount(items.universalShield) > 0;
}

export function opponentPawnAt(room, player, trackPos) {
  if (!room?.players || !player || trackPos === null || trackPos === undefined) return null;
  let fallback = null;
  for (const opp of room.players) {
    if (!opp || opp.id === player.id) continue;
    const oppColorIdx = COLORS.indexOf(opp.color);
    if (oppColorIdx === -1) continue;
    const pawns = room.pawns?.[opp.id] || [];
    for (let i = 0; i < pawns.length; i++) {
      const val = pawns[i];
      if (val >= 1 && val <= 39 && getTrackIndex(oppColorIdx, val) === trackPos) {
        const candidate = { player: opp, pawnIdx: i, val };
        if (!isPawnProtected(room, opp, trackPos)) {
          if (!opp.isOut) return candidate;
          if (!fallback) fallback = candidate;
        } else if (!fallback) {
          fallback = candidate;
        }
      }
    }
  }
  return fallback;
}

export function captureRisk(room, player, trackPos) {
  if (trackPos === null || trackPos === undefined || isPawnProtected(room, player, trackPos)) return 0;

  let chance = 0;
  for (const opp of room.players || []) {
    if (!opp || opp.id === player.id || opp.isOut) continue;
    const oppColorIdx = COLORS.indexOf(opp.color);
    if (oppColorIdx === -1) continue;
    for (const v of room.pawns?.[opp.id] || []) {
      if (v >= 1 && v <= 39) {
        const distance = (trackPos - getTrackIndex(oppColorIdx, v) + 40) % 40;
        if (distance >= 1 && distance <= 6 && v + distance <= 39) chance += 1 / 6;
      } else if (v === 0 && trackPos === COLOR_OFFSETS[oppColorIdx]) {
        chance += 2 / 6;
      }
    }
  }
  return Math.min(chance, 1);
}

export function countThreatenedOpponents(room, player, toVal, toTrack) {
  if (toTrack === null || toTrack === undefined || toVal <= 0 || toVal >= 40) return 0;
  let count = 0;
  for (const opp of room.players || []) {
    if (!opp || opp.id === player.id || opp.isOut) continue;
    const oppColorIdx = COLORS.indexOf(opp.color);
    if (oppColorIdx === -1) continue;
    for (const v of room.pawns?.[opp.id] || []) {
      if (v < 1 || v > 39) continue;
      const oppTrack = getTrackIndex(oppColorIdx, v);
      if (isPawnProtected(room, opp, oppTrack)) continue;
      const dist = (oppTrack - toTrack + 40) % 40;
      if (dist >= 1 && dist <= 6 && toVal + dist <= 39) count++;
    }
  }
  return count;
}

function resolveMoveReason({
  isWin,
  isFinish,
  isCapture,
  isBlackHoleDanger,
  shielded,
  isEnterHome,
  isEscapeDanger,
  toProtected,
  isLeaveBase,
  isSafeLanding,
  isSetupThreat,
  isRiskyLanding
}) {
  if (isWin) return 'Menang sekarang!';
  if (isFinish) return 'Masuk Finish + bonus dadu';
  if (isCapture && isBlackHoleDanger) return 'Makan lawan (waspada Black Hole)';
  if (isCapture && shielded) return 'Makan lawan (pakai Perisai)';
  if (isCapture) return 'Makan lawan + bonus dadu';
  if (isBlackHoleDanger) return 'Hindari: Black Hole';
  if (shielded) return 'Black Hole (tertahan Perisai)';
  if (isEnterHome) return 'Masuk jalur finish aman';
  if (isEscapeDanger && toProtected) return 'Kabur ke petak aman ★';
  if (isEscapeDanger) return 'Kabur dari ancaman lawan';
  if (isLeaveBase) return 'Keluar markas ke petak aman';
  if (isSafeLanding) return 'Mendarat di petak aman ★';
  if (isSetupThreat) return 'Posisi incar bidak lawan';
  if (isRiskyLanding) return 'Rawan dikejar lawan';
  return 'Maju posisi aman';
}

export function evaluatePawnMove(room, player, pawnIdx, dice) {
  const pawns = room.pawns?.[player.id] || [0, 0, 0, 0];
  const colorIdx = COLORS.indexOf(player.color);
  const from = pawns[pawnIdx] ?? 0;
  const to = from === 0 ? 1 : from + dice;
  const fromTrack = getTrackIndex(colorIdx, from);
  const toTrack = getTrackIndex(colorIdx, to);

  const fromProtected = fromTrack !== null && isPawnProtected(room, player, fromTrack);
  const toProtected = toTrack !== null && isPawnProtected(room, player, toTrack);

  const finishedBefore = pawns.filter((v, idx) => idx !== pawnIdx && v === FINISH).length;
  const isFinish = to === FINISH;
  const isWin = isFinish && finishedBefore >= 3;
  const isEnterHome = from <= 39 && to >= 40 && to < FINISH;
  const isLeaveBase = from === 0;

  const victim = toTrack !== null ? opponentPawnAt(room, player, toTrack) : null;
  const isCapture = Boolean(victim && !isPawnProtected(room, victim.player, toTrack));

  const landsOnBlackHole = Boolean(room.settings?.blackHole && toTrack !== null && getBlackHoles(room).includes(toTrack));
  const shielded = landsOnBlackHole && hasBlackHoleShield(player);
  const isBlackHoleDanger = landsOnBlackHole && !shielded;

  const riskNow = fromTrack !== null ? captureRisk(room, player, fromTrack) : 0;
  const riskNext = toTrack !== null ? captureRisk(room, player, toTrack) : 0;
  const isEscapeDanger = riskNow > 0 && riskNext < riskNow;
  const isRiskyLanding = riskNext > riskNow && !isBlackHoleDanger;
  const isSafeLanding = !isLeaveBase && !isFinish && !isEnterHome && toProtected && !fromProtected;

  const targetsAhead = !isFinish && !isEnterHome ? countThreatenedOpponents(room, player, to, toTrack) : 0;
  const isSetupThreat = targetsAhead > 0 && riskNext === 0 && !isBlackHoleDanger;

  let score = 0;
  score += (to - from) * 1 + from * 0.05;

  if (isLeaveBase) {
    const activeOutside = pawns.filter(v => v >= 1 && v < FINISH).length;
    score += 30 + (activeOutside === 0 ? 20 : 0);
  }

  if (isWin) score += 500;
  if (isFinish) score += 120;
  else if (isEnterHome) score += 48;

  if (isCapture) {
    score += !victim.player.isOut ? 55 + victim.val * 1.5 : 32 + victim.val * 0.3;
  }

  score += riskNow * (from + 20) * 1.25;
  score -= riskNext * (to + 20) * 1.25;
  if (riskNow > 0 && riskNext === 0) score += 10;

  if (isSafeLanding) score += 14;
  else if (fromProtected && !toProtected && to <= 39) score -= 4;

  if (targetsAhead > 0 && !isBlackHoleDanger) {
    score += Math.min(targetsAhead, 2) * (riskNext === 0 ? (dice === 6 ? 16 : 10) : 4);
  }

  if (landsOnBlackHole) {
    score -= shielded ? 25 : 45 + (to + 20);
  }

  score = Math.round(score * 100) / 100;

  const reason = resolveMoveReason({
    isWin,
    isFinish,
    isCapture,
    isBlackHoleDanger,
    shielded,
    isEnterHome,
    isEscapeDanger,
    toProtected,
    isLeaveBase,
    isSafeLanding,
    isSetupThreat,
    isRiskyLanding
  });

  return {
    pawnIdx,
    from,
    to,
    score,
    riskNow,
    riskNext,
    reason,
    tags: {
      isWin,
      isFinish,
      isCapture,
      isEnterHome,
      isLeaveBase,
      isEscapeDanger,
      isSafeLanding,
      isSetupThreat,
      isBlackHoleDanger,
      isBlackHoleShielded: shielded,
      isRiskyLanding
    }
  };
}

function formatPawnGroupLabel(pawnIndices) {
  if (pawnIndices.length === 1) return `Bidak ${pawnIndices[0] + 1}`;
  const isContiguous = pawnIndices.every((v, idx) => idx === 0 || v === pawnIndices[idx - 1] + 1);
  if (isContiguous) {
    return `Bidak ${pawnIndices[0] + 1}–${pawnIndices[pawnIndices.length - 1] + 1}`;
  }
  return `Bidak ${pawnIndices.map(idx => idx + 1).join(', ')}`;
}

const INACTIVE_RESULT = Object.freeze({
  active: false,
  evaluated: [],
  recommended: [],
  byPawn: {},
  displayList: []
});

export function evaluateOceanBlueHints({
  room,
  playerId,
  movablePawns = [],
  isMyTurn = false,
  targeting = false
} = {}) {
  if (
    !room ||
    !isMyTurn ||
    targeting ||
    !room.started ||
    room.winner ||
    room.dice === null ||
    room.dice === undefined ||
    room.rolling ||
    room.animatingMove ||
    room.pendingShield ||
    !Array.isArray(movablePawns) ||
    movablePawns.length === 0
  ) {
    return INACTIVE_RESULT;
  }

  const player = room.players?.find(p => p.id === playerId);
  if (!player || player.isOut || !hasOceanBlueHintAbility(player.equippedSkin)) {
    return INACTIVE_RESULT;
  }

  const uniquePawns = [];
  const seen = new Set();
  for (const idx of movablePawns) {
    if (Number.isInteger(idx) && idx >= 0 && idx <= 3 && !seen.has(idx)) {
      seen.add(idx);
      uniquePawns.push(idx);
    }
  }
  if (uniquePawns.length === 0) return INACTIVE_RESULT;

  const evaluated = uniquePawns
    .map(pawnIdx => evaluatePawnMove(room, player, pawnIdx, room.dice))
    .sort((a, b) => b.score - a.score || b.from - a.from || a.pawnIdx - b.pawnIdx);

  const recommended = [evaluated[0]];
  const topScore = evaluated[0].score;

  for (let i = 1; i < evaluated.length; i++) {
    const item = evaluated[i];
    if (item.tags.isBlackHoleDanger || item.score <= 0) continue;
    if (
      item.riskNext > item.riskNow &&
      !item.tags.isCapture &&
      !item.tags.isFinish &&
      !item.tags.isWin &&
      !item.tags.isEnterHome
    ) {
      continue;
    }

    const hasTacticalAdvantage =
      item.tags.isWin ||
      item.tags.isFinish ||
      item.tags.isCapture ||
      item.tags.isEnterHome ||
      item.tags.isEscapeDanger ||
      item.tags.isSafeLanding ||
      item.tags.isLeaveBase ||
      item.tags.isSetupThreat;

    if (hasTacticalAdvantage || (topScore - item.score <= 12 && item.riskNext <= item.riskNow)) {
      recommended.push(item);
    }
  }

  let prevRank = 1;
  const finalRecommended = recommended.map((item, i) => {
    let rank = 1;
    if (i > 0) {
      const prev = recommended[i - 1];
      if (item.from === 0 && prev.from === 0 && item.score === prev.score) {
        rank = prevRank;
      } else {
        rank = prevRank + 1;
      }
    }
    prevRank = rank;
    return {
      ...item,
      rank,
      tier: rank === 1 ? 'best' : rank === 2 ? 'strong' : 'good'
    };
  });

  const byPawn = {};
  for (const item of finalRecommended) {
    byPawn[item.pawnIdx] = item;
  }

  const displayList = [];
  for (const item of finalRecommended) {
    const last = displayList[displayList.length - 1];
    if (
      last &&
      item.from === 0 &&
      last._from === 0 &&
      item.rank === last.rank
    ) {
      last.pawnIndices.push(item.pawnIdx);
      last.label = formatPawnGroupLabel(last.pawnIndices);
    } else {
      displayList.push({
        rank: item.rank,
        tier: item.tier,
        pawnIdx: item.pawnIdx,
        pawnIndices: [item.pawnIdx],
        label: `Bidak ${item.pawnIdx + 1}`,
        reason: item.reason,
        score: item.score,
        _from: item.from
      });
    }
  }

  const cleanDisplayList = displayList.map(({ _from, ...rest }) => rest);

  return {
    active: true,
    evaluated,
    recommended: finalRecommended,
    byPawn,
    displayList: cleanDisplayList
  };
}
