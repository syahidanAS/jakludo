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
  // Dadu seimbang: beta = koreksi defisit, gamma = dorongan untuk angka yang bisa memakan lawan,
  // maxAdd = kenaikan maksimum peluang makan, chainDamp = peredam peluang makan setelah
  // chainAfter kali makan berturut-turut. beta 0, gamma 0, chainDamp 1 = dadu random murni.
  DICE: { beta: 0.3, gamma: 0.4, maxAdd: 0.06, chainAfter: 2, chainDamp: 0.4 },
  // Batas auto-play berturut-turut sebelum pemain dinyatakan OUT
  MAX_AUTO_PLAY: 3,
  MAX_PLAYERS: 4,
  MAX_CHATS: 50,
  MAX_HISTORY: 15,
  EMOJIS: ['🎲', '🔥', '👏', '😂', '😭', '👑', '⚡', '🎯'],
  BOT_NAMES: { red: 'Bot Merah', green: 'Bot Hijau', yellow: 'Bot Kuning', blue: 'Bot Biru' }
};
