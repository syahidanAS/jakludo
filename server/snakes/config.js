// Konfigurasi terpusat permainan Snakes and Ladders (Ular Tangga) di PlayGo.
// Seluruh posisi tangga, ular, batas waktu matchmaking, dan identitas bot disimpan di satu sumber data.

const GAME_ID = 'snakes-and-ladders';
const GAME_DISPLAY_NAME = 'Ular Tangga';
const GAME_NAME = 'Snakes and Ladders';
const BOARD_SIZE = 100;
const GRID_SIZE = 10;

// Konfigurasi Tangga: pangkal -> puncak (naik)
const LADDERS = Object.freeze({
  4: 14,
  9: 31,
  20: 38,
  28: 84,
  40: 59,
  51: 67,
  63: 81,
  71: 91
});

// Konfigurasi Ular: kepala -> ekor (turun)
const SNAKES = Object.freeze({
  17: 7,
  54: 34,
  62: 19,
  64: 60,
  87: 24,
  93: 73,
  95: 75,
  99: 78
});

// Warna bidak pemain (mendukung pengembangan 2–4 pemain)
const PLAYER_COLORS = Object.freeze(['red', 'blue', 'green', 'yellow']);

// Konfigurasi Matchmaking & Tempo Permainan
const HUMAN_SEARCH_TIMEOUT_SECONDS = Number(process.env.SNAKES_HUMAN_SEARCH_TIMEOUT || 15);
const HUMAN_SEARCH_TIMEOUT_MS = HUMAN_SEARCH_TIMEOUT_SECONDS * 1000;
const BOT_FALLBACK_ENABLED = process.env.SNAKES_BOT_FALLBACK_ENABLED !== 'false';
const MAX_PLAYERS = Number(process.env.SNAKES_MAX_PLAYERS || 2);
const MAX_PRIVATE_ROOM_PLAYERS = 4;
const MATCHMAKING_QUEUE_EXPIRY_SECONDS = Number(process.env.SNAKES_QUEUE_EXPIRY || 60);
const MATCHMAKING_QUEUE_EXPIRY_MS = MATCHMAKING_QUEUE_EXPIRY_SECONDS * 1000;
const TURN_TIMEOUT_SECONDS = Number(process.env.SNAKES_TURN_TIMEOUT || 30);
const TURN_TIMEOUT_MS = TURN_TIMEOUT_SECONDS * 1000;
const BOT_ACTION_DELAY_MIN_MS = Number(process.env.SNAKES_BOT_DELAY_MIN_MS || 2000);
const BOT_ACTION_DELAY_MAX_MS = Number(process.env.SNAKES_BOT_DELAY_MAX_MS || 2800);
const DISCONNECT_GRACE_MS = Number(process.env.SNAKES_DISCONNECT_GRACE_MS || 60000);
const LOBBY_EXPIRE_MS = Number(process.env.SNAKES_LOBBY_EXPIRE_MS || 5 * 60 * 1000);

// Hadiah Coins untuk pertandingan kompetitif melawan manusia
const HUMAN_WIN_REWARD_COINS = 15;

// Identitas transparan untuk Bot (wajib: tidak menyamar sebagai manusia, user_id = null)
const DEFAULT_BOT_IDENTITY = Object.freeze({
  player_type: 'bot',
  user_id: null,
  bot_id: 'default-bot',
  display_name: 'Pemain Komputer',
  avatar: null,
  difficulty: 'easy'
});

function createBotPlayerRecord({ order = 1, color = 'blue', difficulty = 'easy' } = {}) {
  return {
    id: `snk_comp_${order}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    player_type: 'bot',
    playerType: 'bot',
    user_id: null,
    userId: null,
    bot_id: DEFAULT_BOT_IDENTITY.bot_id,
    botId: DEFAULT_BOT_IDENTITY.bot_id,
    display_name: DEFAULT_BOT_IDENTITY.display_name,
    name: DEFAULT_BOT_IDENTITY.display_name,
    username: null,
    avatar: null,
    isBot: true,
    difficulty: difficulty || 'easy',
    player_order: order,
    playerOrder: order,
    position: 0,
    color: color || PLAYER_COLORS[order % PLAYER_COLORS.length],
    status: 'active',
    ready: true,
    connected: true
  };
}

function createHumanPlayerRecord(user, { order = 0, color = 'red', socketId = null, ready = false } = {}) {
  return {
    id: `human_${user.id}_${order}_${Date.now()}`,
    player_type: 'human',
    playerType: 'human',
    user_id: user.id,
    userId: user.id,
    bot_id: null,
    botId: null,
    display_name: user.name || user.username,
    name: user.name || user.username,
    username: user.username,
    avatar: user.avatar || null,
    isBot: false,
    difficulty: null,
    player_order: order,
    playerOrder: order,
    position: 0,
    color: color || PLAYER_COLORS[order % PLAYER_COLORS.length],
    status: 'active',
    ready: Boolean(ready),
    connected: true,
    socketId: socketId || null,
    disconnectedAt: null,
    graceEndsAt: null
  };
}

// Konversi nomor kotak (1..100) ke koordinat baris/kolom papan 10x10 zig-zag
// Nomor 1 di kiri bawah (rowFromBottom=0, col=0 -> visualRow=9, visualCol=0)
// Nomor 100 di kiri atas (rowFromBottom=9, col=0 -> visualRow=0, visualCol=0)
function squareToBoardCoords(square) {
  const num = Number(square);
  if (!Number.isInteger(num) || num < 1 || num > BOARD_SIZE) return null;
  const zeroBased = num - 1;
  const rowFromBottom = Math.floor(zeroBased / GRID_SIZE);
  const offsetInRow = zeroBased % GRID_SIZE;
  const col = rowFromBottom % 2 === 0 ? offsetInRow : GRID_SIZE - 1 - offsetInRow;
  const visualRow = GRID_SIZE - 1 - rowFromBottom;
  return {
    square: num,
    rowFromBottom,
    visualRow,
    col,
    // Persentase titik tengah kotak (0..100) untuk menggambar SVG ular/tangga & animasi bidak
    xPercent: col * 10 + 5,
    yPercent: visualRow * 10 + 5
  };
}

// Validasi integritas konfigurasi ular dan tangga
function validateBoardConfiguration(ladders = LADDERS, snakes = SNAKES) {
  const usedStarts = new Set();
  const errors = [];

  for (const [startStr, endVal] of Object.entries(ladders)) {
    const start = Number(startStr);
    const end = Number(endVal);
    if (start < 2 || start >= BOARD_SIZE) errors.push(`Pangkal tangga tidak valid: ${start}`);
    if (end <= start || end > BOARD_SIZE) errors.push(`Puncak tangga harus lebih tinggi dari pangkal: ${start} -> ${end}`);
    if (usedStarts.has(start)) errors.push(`Kotak awal ganda pada: ${start}`);
    usedStarts.add(start);
  }

  for (const [headStr, tailVal] of Object.entries(snakes)) {
    const head = Number(headStr);
    const tail = Number(tailVal);
    if (head < 2 || head >= BOARD_SIZE) errors.push(`Kepala ular tidak valid: ${head}`);
    if (tail >= head || tail < 1) errors.push(`Ekor ular harus lebih rendah dari kepala: ${head} -> ${tail}`);
    if (usedStarts.has(head)) errors.push(`Kotak awal bertabrakan pada: ${head}`);
    usedStarts.add(head);
  }

  for (const [startStr, endVal] of Object.entries(ladders)) {
    if (snakes[endVal] || ladders[endVal]) {
      errors.push(`Puncak tangga ${startStr}->${endVal} tidak boleh langsung menabrak pangkal tangga/kepala ular lain.`);
    }
  }
  for (const [headStr, tailVal] of Object.entries(snakes)) {
    if (snakes[tailVal] || ladders[tailVal]) {
      errors.push(`Ekor ular ${headStr}->${tailVal} tidak boleh langsung menabrak pangkal tangga/kepala ular lain.`);
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  GAME_ID,
  GAME_DISPLAY_NAME,
  GAME_NAME,
  BOARD_SIZE,
  GRID_SIZE,
  LADDERS,
  SNAKES,
  PLAYER_COLORS,
  HUMAN_SEARCH_TIMEOUT_SECONDS,
  HUMAN_SEARCH_TIMEOUT_MS,
  BOT_FALLBACK_ENABLED,
  MAX_PLAYERS,
  MAX_PRIVATE_ROOM_PLAYERS,
  MATCHMAKING_QUEUE_EXPIRY_SECONDS,
  MATCHMAKING_QUEUE_EXPIRY_MS,
  TURN_TIMEOUT_SECONDS,
  TURN_TIMEOUT_MS,
  BOT_ACTION_DELAY_MIN_MS,
  BOT_ACTION_DELAY_MAX_MS,
  DISCONNECT_GRACE_MS,
  LOBBY_EXPIRE_MS,
  HUMAN_WIN_REWARD_COINS,
  DEFAULT_BOT_IDENTITY,
  createBotPlayerRecord,
  createHumanPlayerRecord,
  squareToBoardCoords,
  validateBoardConfiguration
};

