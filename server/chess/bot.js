// Mesin AI / Bot Catur untuk Chess Master (PlayGo)
// Menggunakan chess.js + Minimax dengan Alpha-Beta Pruning & Piece-Square Tables.
const crypto = require('crypto');
const { Chess } = require('chess.js');

const BOT_PROFILES = {
  easy: {
    id: 'bot_chess_easy',
    username: 'bot_pion',
    name: 'Bot Pion (AI Pemula)',
    avatar: '🤖',
    rating: 950,
    difficulty: 'easy',
    isBot: true
  },
  medium: {
    id: 'bot_chess_medium',
    username: 'bot_ksatria',
    name: 'Bot Ksatria (AI Menengah)',
    avatar: '🤖',
    rating: 1200,
    difficulty: 'medium',
    isBot: true
  },
  hard: {
    id: 'bot_chess_hard',
    username: 'bot_grandmaster',
    name: 'Bot Grandmaster (AI Master)',
    avatar: '🤖',
    rating: 1550,
    difficulty: 'hard',
    isBot: true
  }
};

const QUICK_MATCH_BOT_NAMES = [
  { id: 'bot_chess_raka', username: 'raka_ai', name: 'Raka Pratama (Bot)', avatar: '🤖' },
  { id: 'bot_chess_dewi', username: 'dewi_ai', name: 'Dewi Kartika (Bot)', avatar: '🤖' },
  { id: 'bot_chess_bima', username: 'bima_ai', name: 'Bima Sakti (Bot)', avatar: '🤖' },
  { id: 'bot_chess_citra', username: 'citra_ai', name: 'Citra Kirana (Bot)', avatar: '🤖' },
  { id: 'bot_chess_arya', username: 'arya_ai', name: 'Arya Wijaya (Bot)', avatar: '🤖' }
];

function isBotUserId(userId) {
  return typeof userId === 'string' && userId.startsWith('bot_');
}

function getBotProfile(difficultyOrId = 'medium', targetRating = null) {
  const key = String(difficultyOrId || 'medium').toLowerCase();
  if (BOT_PROFILES[key]) {
    return { ...BOT_PROFILES[key] };
  }
  for (const prof of Object.values(BOT_PROFILES)) {
    if (prof.id === key) return { ...prof };
  }
  const matchedPersona = QUICK_MATCH_BOT_NAMES.find(p => p.id === key);
  if (matchedPersona) {
    return {
      ...matchedPersona,
      rating: targetRating || 1200,
      difficulty: 'medium',
      isBot: true
    };
  }
  return { ...BOT_PROFILES.medium };
}

function buildQuickMatchBotForRating(playerRating = 1200) {
  const persona = QUICK_MATCH_BOT_NAMES[crypto.randomInt(0, QUICK_MATCH_BOT_NAMES.length)];
  const baseRating = Number(playerRating) || 1200;
  const jitter = crypto.randomInt(-35, 36);
  const botRating = Math.max(800, Math.min(2000, baseRating + jitter));

  let difficulty = 'medium';
  if (baseRating < 1080) difficulty = 'easy';
  else if (baseRating >= 1380) difficulty = 'hard';

  return {
    id: persona.id,
    userId: persona.id,
    username: persona.username,
    name: persona.name,
    avatar: persona.avatar,
    rating: botRating,
    difficulty,
    isBot: true
  };
}

// Nilai material bidak (centipawns)
const PIECE_VALUES = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 20000
};

// Tabel posisi bidak (Piece-Square Tables) dari sudut pandang Putih (baris 0 = rank 8, baris 7 = rank 1)
const PAWN_PST = [
  [0,  0,  0,  0,  0,  0,  0,  0],
  [50, 50, 50, 50, 50, 50, 50, 50],
  [10, 10, 20, 30, 30, 20, 10, 10],
  [5,  5, 10, 25, 25, 10,  5,  5],
  [0,  0,  0, 22, 22,  0,  0,  0],
  [5, -5,-10,  0,  0,-10, -5,  5],
  [5, 10, 10,-20,-20, 10, 10,  5],
  [0,  0,  0,  0,  0,  0,  0,  0]
];

const KNIGHT_PST = [
  [-50,-40,-30,-30,-30,-30,-40,-50],
  [-40,-20,  0,  0,  0,  0,-20,-40],
  [-30,  0, 10, 15, 15, 10,  0,-30],
  [-30,  5, 15, 20, 20, 15,  5,-30],
  [-30,  0, 15, 20, 20, 15,  0,-30],
  [-30,  5, 10, 15, 15, 10,  5,-30],
  [-40,-20,  0,  5,  5,  0,-20,-40],
  [-50,-40,-30,-30,-30,-30,-40,-50]
];

const BISHOP_PST = [
  [-20,-10,-10,-10,-10,-10,-10,-20],
  [-10,  0,  0,  0,  0,  0,  0,-10],
  [-10,  0,  5, 10, 10,  5,  0,-10],
  [-10,  5,  5, 10, 10,  5,  5,-10],
  [-10,  0, 10, 10, 10, 10,  0,-10],
  [-10, 10, 10, 10, 10, 10, 10,-10],
  [-10,  5,  0,  0,  0,  0,  5,-10],
  [-20,-10,-10,-10,-10,-10,-10,-20]
];

function getPositionalBonus(piece, row, col) {
  const r = piece.color === 'w' ? row : 7 - row;
  if (piece.type === 'p') return PAWN_PST[r]?.[col] || 0;
  if (piece.type === 'n') return KNIGHT_PST[r]?.[col] || 0;
  if (piece.type === 'b') return BISHOP_PST[r]?.[col] || 0;
  return 0;
}

// Evaluasi papan dari sudut pandang Putih (+ menguntungkan Putih, - menguntungkan Hitam)
function evaluateBoard(chess) {
  if (chess.isCheckmate()) {
    return chess.turn() === 'w' ? -99999 : 99999;
  }
  if (chess.isDraw() || chess.isStalemate() || chess.isThreefoldRepetition() || chess.isInsufficientMaterial()) {
    return 0;
  }

  const board = chess.board();
  let score = 0;

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];
      if (!piece) continue;
      const base = PIECE_VALUES[piece.type] || 0;
      const pos = getPositionalBonus(piece, r, c);
      const val = base + pos;
      if (piece.color === 'w') score += val;
      else score -= val;
    }
  }

  return score;
}

function scoreMoveForOrdering(mv) {
  let s = 0;
  if (mv.san?.includes('#')) s += 10000;
  if (mv.promotion) s += 800;
  if (mv.captured) {
    s += 10 * (PIECE_VALUES[mv.captured] || 100) - ((PIECE_VALUES[mv.piece] || 100) / 10);
  }
  if (mv.san?.includes('+')) s += 150;
  return s;
}

function minimax(chess, depth, alpha, beta, isMaximizing) {
  if (depth === 0 || chess.isGameOver()) {
    return evaluateBoard(chess);
  }

  const moves = chess.moves({ verbose: true });
  moves.sort((a, b) => scoreMoveForOrdering(b) - scoreMoveForOrdering(a));

  if (isMaximizing) {
    let maxEval = -Infinity;
    for (const mv of moves) {
      chess.move(mv);
      const ev = minimax(chess, depth - 1, alpha, beta, false);
      chess.undo();
      if (ev > maxEval) maxEval = ev;
      if (ev > alpha) alpha = ev;
      if (beta <= alpha) break;
    }
    return maxEval;
  }

  let minEval = Infinity;
  for (const mv of moves) {
    chess.move(mv);
    const ev = minimax(chess, depth - 1, alpha, beta, true);
    chess.undo();
    if (ev < minEval) minEval = ev;
    if (ev < beta) beta = ev;
    if (beta <= alpha) break;
  }
  return minEval;
}

function chooseBotMove(fen, difficulty = 'medium') {
  const chess = new Chess(fen);
  const legalMoves = chess.moves({ verbose: true });
  if (!legalMoves || legalMoves.length === 0) return null;
  if (legalMoves.length === 1) {
    const only = legalMoves[0];
    return { from: only.from, to: only.to, promotion: only.promotion || 'q' };
  }

  const botColor = chess.turn(); // 'w' atau 'b'
  const isMaximizing = botColor === 'w';
  const diff = String(difficulty || 'medium').toLowerCase();

  // Cek apakah ada langkah skakmat langsung (1 langkah)
  for (const mv of legalMoves) {
    chess.move(mv);
    const isMate = chess.isCheckmate();
    chess.undo();
    if (isMate) {
      return { from: mv.from, to: mv.to, promotion: mv.promotion || 'q' };
    }
  }

  const searchDepth = diff === 'hard' ? 2 : 1;
  const scoredMoves = [];

  for (const mv of legalMoves) {
    chess.move(mv);
    const boardScore = minimax(chess, searchDepth, -Infinity, Infinity, !isMaximizing);
    chess.undo();

    // Konversi ke skor dari perspektif bot (semakin besar semakin bagus untuk bot)
    let myScore = isMaximizing ? boardScore : -boardScore;

    // Tambahkan sedikit variasi agar langkah pembukaan bot natural dan tidak selalu identik
    const jitterRange = diff === 'easy' ? 95 : diff === 'medium' ? 25 : 8;
    myScore += crypto.randomInt(-jitterRange, jitterRange + 1);

    scoredMoves.push({ mv, score: myScore });
  }

  scoredMoves.sort((a, b) => b.score - a.score);
  const chosen = scoredMoves[0].mv;
  return {
    from: chosen.from,
    to: chosen.to,
    promotion: chosen.promotion || 'q'
  };
}

module.exports = {
  BOT_PROFILES,
  QUICK_MATCH_BOT_NAMES,
  isBotUserId,
  getBotProfile,
  buildQuickMatchBotForRating,
  evaluateBoard,
  chooseBotMove
};

