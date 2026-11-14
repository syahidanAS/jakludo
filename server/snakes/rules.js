// Domain Rules Engine untuk Snakes and Ladders (Ular Tangga).
// Murni server-side: menghasilkan dadu CSPRNG, menghitung langkah, tangga, ular, pantulan >100, dan kondisi menang.
const crypto = require('crypto');
const { BOARD_SIZE, LADDERS, SNAKES } = require('./config');

// Menghasilkan angka dadu 1..6 secara kriptografis aman di sisi server
function rollSecureDice() {
  return crypto.randomInt(1, 7);
}

// Menentukan giliran pertama secara acak di sisi server
function determineFirstTurnIndex(playerCount = 2) {
  const count = Math.max(1, Number(playerCount) || 2);
  return crypto.randomInt(0, count);
}

// Menghitung hasil pergerakan satu lemparan dadu sesuai aturan Ular Tangga PlayGo
// Aturan dadu 6: mendapat kesempatan kocok lagi; jika 6 tiga kali berturut-turut, giliran dilewati ke lawan.
function calculateTurnOutcome({
  currentPosition = 0,
  dice,
  consecutiveSixes = 0,
  ladders = LADDERS,
  snakes = SNAKES
}) {
  const startPos = Math.max(0, Math.min(BOARD_SIZE, Number(currentPosition) || 0));
  const diceVal = Number(dice);

  if (!Number.isInteger(diceVal) || diceVal < 1 || diceVal > 6) {
    throw new Error('Nilai dadu tidak valid (harus bulat 1–6).');
  }

  const nextConsecutiveSixes = diceVal === 6 ? Number(consecutiveSixes || 0) + 1 : 0;

  // Jika mendapatkan angka 6 tiga kali berturut-turut: skip ke pemain lawan tanpa bergerak
  if (diceVal === 6 && nextConsecutiveSixes >= 3) {
    return {
      dice: diceVal,
      from: startPos,
      stepTo: startPos,
      finalPosition: startPos,
      moved: false,
      overshoot: false,
      threeSixesSkip: true,
      consecutiveSixes: 0,
      ladder: null,
      snake: null,
      isWin: false,
      extraTurn: false,
      stepPath: []
    };
  }

  const rawTarget = startPos + diceVal;

  // Aturan 6 & 7: Harus mendapatkan angka tepat untuk mencapai 100; jika melewati 100, bidak tidak bergerak
  if (rawTarget > BOARD_SIZE) {
    return {
      dice: diceVal,
      from: startPos,
      stepTo: startPos,
      finalPosition: startPos,
      moved: false,
      overshoot: true,
      threeSixesSkip: false,
      consecutiveSixes: nextConsecutiveSixes,
      ladder: null,
      snake: null,
      isWin: false,
      extraTurn: diceVal === 6,
      stepPath: []
    };
  }

  const stepTo = rawTarget;
  const stepPath = [];
  for (let sq = startPos + 1; sq <= stepTo; sq++) {
    stepPath.push(sq);
  }

  let finalPosition = stepTo;
  let ladder = null;
  let snake = null;

  // Aturan 4: Mendarat di pangkal tangga -> otomatis naik
  if (Object.prototype.hasOwnProperty.call(ladders, stepTo)) {
    finalPosition = Number(ladders[stepTo]);
    ladder = { from: stepTo, to: finalPosition };
  } else if (Object.prototype.hasOwnProperty.call(snakes, stepTo)) {
    // Aturan 5: Mendarat di kepala ular -> otomatis turun
    finalPosition = Number(snakes[stepTo]);
    snake = { from: stepTo, to: finalPosition };
  }

  const isWin = finalPosition === BOARD_SIZE;

  // Mendapatkan angka 6 (ke-1 atau ke-2) memberi kesempatan lempar dadu lagi selama belum menang
  return {
    dice: diceVal,
    from: startPos,
    stepTo,
    finalPosition,
    moved: true,
    overshoot: false,
    threeSixesSkip: false,
    consecutiveSixes: isWin ? 0 : nextConsecutiveSixes,
    ladder,
    snake,
    isWin,
    extraTurn: !isWin && diceVal === 6,
    stepPath
  };
}

function getNextTurnIndex(currentIndex, playerCount = 2) {
  const count = Math.max(1, Number(playerCount) || 2);
  return (Number(currentIndex) + 1) % count;
}

module.exports = {
  rollSecureDice,
  determineFirstTurnIndex,
  calculateTurnOutcome,
  getNextTurnIndex
};

