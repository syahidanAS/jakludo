// Pengaturan waktu & batas permainan di satu tempat
module.exports = {
  // Lobby tanpa pemain yang tersambung, atau room yang permainannya sudah selesai, dihapus setelah ini
  ROOM_IDLE_TTL_MS: 5 * 60 * 1000,
  // Jeda menyimpan snapshot room ke database (mengelompokkan banyak perubahan beruntun)
  ROOM_SAVE_DELAY_MS: 300,
  // Batas waktu giliran pemain online sebelum dimainkan sistem
  TURN_TIMEOUT_MS: 15000,
  // Pemain yang koneksinya putus diberi waktu tersambung ulang sebelum gilirannya dimainkan sistem
  DISCONNECTED_TURN_DELAY_MS: 8000,
  // Pemain yang terputus baru bisa dinyatakan OUT setelah offline selama ini (bukan karena sinyal goyang)
  OFFLINE_OUT_MS: 2 * 60 * 1000,
  // Kursi pemain (selain pembuat room) di lobby ditahan selama ini setelah koneksi putus
  LOBBY_SEAT_GRACE_MS: 2 * 60 * 1000,
  // Waktu pemain memutuskan memakai perisai (Universal Shield); lewat dari ini perisai otomatis dipakai
  SHIELD_DECISION_MS: 10000,
  // Dadu seimbang + proteksi anti-sial & anti-frustrasi Black Hole (adil untuk semua pemain).
  DICE: {
    beta: 0.3,
    gamma: 0.1,
    maxAdd: 0.02,
    chainDecay: 0.5,
    lowStreakThreshold: 3,
    lowStreakBoost: 0.25,
    stuckBaseThreshold: 3,
    stuckBaseBoost: 0.35,
    blackHoleGracePenalty: 0.55
  },
  // Batas auto-play berturut-turut sebelum pemain dinyatakan OUT
  MAX_AUTO_PLAY: 3,
  MAX_PLAYERS: 4,
  MAX_CHATS: 50,
  MAX_HISTORY: 15,
  // Batas waktu pencarian pemain acak sebelum sistem mengisi kursi kosong dengan bot organik
  MATCHMAKING_TIMEOUT_MS: Number(process.env.LUDO_MATCHMAKING_TIMEOUT_MS) || 12000,
  EMOJIS: ['🎲', '🔥', '👏', '😂', '😭', '👑', '⚡', '🎯'],
  BOT_NAMES: { red: 'Bot Merah', green: 'Bot Hijau', yellow: 'Bot Kuning', blue: 'Bot Biru' }
};
