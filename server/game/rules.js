// Aturan main JakLudo dalam bentuk fungsi murni (tanpa socket / timer / IO)
// sehingga bisa diuji langsung lewat `npm test`.

// Registry item hanya data (tanpa IO), dipakai bot untuk tahu item mana yang menahan Black Hole
const items = require('../items');

const COLORS = ['red', 'green', 'yellow', 'blue'];
const COLOR_OFFSETS = [0, 10, 20, 30];
const SAFE_TRACK_INDICES = [0, 6, 10, 16, 20, 26, 30, 36];
const BLACK_HOLE_INDICES = [4, 14, 24, 34];
const FINISH = 44;

// Posisi bidak: 0 = markas, 1..39 = lintasan utama, 40..43 = jalur finish, 44 = finish
function getTrackIndex(colorIdx, pawnVal) {
  if (pawnVal >= 1 && pawnVal <= 39) {
    return (COLOR_OFFSETS[colorIdx] + pawnVal - 1) % 40;
  }
  return null;
}

// Warna pertama yang belum dipakai pemain lain di room
function nextFreeColor(players) {
  const used = new Set(players.map(p => p.color));
  return COLORS.find(c => !used.has(c)) || null;
}

// Perlindungan bidak di sebuah petak lintasan:
// - Petak start (kotak pertama di luar markas) hanya aman bagi pemilik warnanya, selalu.
//   Bidak warna lain yang singgah di sana bisa dimakan, termasuk oleh pemiliknya yang baru keluar markas.
// - Petak bintang aman bagi semua pemain selama safe zone aktif.
// - Bidak milik pemain yang sudah out tidak punya perlindungan.
function isPawnProtected(room, owner, trackPos) {
  if (owner.isOut) return false;
  const colorIdx = COLORS.indexOf(owner.color);
  if (trackPos === COLOR_OFFSETS[colorIdx]) return true;
  if (COLOR_OFFSETS.includes(trackPos)) return false;
  return room.settings?.safeZones !== false && SAFE_TRACK_INDICES.includes(trackPos);
}

// Satu petak satu bidak: petak tujuan tertutup jika ada bidak lawan yang terlindungi di sana
function isLandingBlocked(room, player, trackPos) {
  for (const opp of room.players) {
    if (opp.id === player.id) continue;
    const oppColorIdx = COLORS.indexOf(opp.color);
    const oppPawns = room.pawns[opp.id] || [];
    const here = oppPawns.some(v => v >= 1 && v <= 39 && getTrackIndex(oppColorIdx, v) === trackPos);
    if (here && isPawnProtected(room, opp, trackPos)) return true;
  }
  return false;
}

// Aturan: Dalam satu kotak tidak bisa ada 2 bidak.
// - Tidak boleh mendarat di petak yang sudah ada bidak milik sendiri.
// - Tidak boleh mendarat di petak yang ditempati bidak lawan yang terlindungi (lihat isPawnProtected).
// - Selain itu bidak lawan di petak tujuan dimakan.
// - Petak finish (44) boleh menampung semua bidak yang finish.
function canPawnMove(room, player, pawnIdx, dice) {
  if (!room || !player || dice === null || dice === undefined) return false;
  const currentPawns = room.pawns[player.id];
  if (!currentPawns) return false;

  const val = currentPawns[pawnIdx];
  const colorIdx = COLORS.indexOf(player.color);

  // Bidak di markas (0): keluar dengan angka 6 atau 1. Lawan yang singgah di petak start dimakan.
  if (val === 0) {
    if (dice !== 6 && dice !== 1) return false;
    if (currentPawns.some((v, idx) => idx !== pawnIdx && v === 1)) return false;
    return !isLandingBlocked(room, player, COLOR_OFFSETS[colorIdx]);
  }

  if (val > 0 && val < FINISH) {
    const newVal = val + dice;
    if (newVal > FINISH) return false;
    if (newVal === FINISH) return true;
    if (currentPawns.some((v, idx) => idx !== pawnIdx && v === newVal)) return false;
    if (newVal <= 39 && isLandingBlocked(room, player, getTrackIndex(colorIdx, newVal))) return false;
    return true;
  }

  return false;
}

function getMovablePawns(room, player, dice) {
  if (!room || !player || !dice) return [];
  const result = [];
  for (let i = 0; i < 4; i++) {
    if (canPawnMove(room, player, i, dice)) result.push(i);
  }
  return result;
}

// ==========================================
// BLACK HOLE
// ==========================================

// Posisi Black Hole yang berlaku di room (statis atau hasil pindah acak)
function getBlackHoles(room) {
  return Array.isArray(room.blackHoles) && room.blackHoles.length ? room.blackHoles : BLACK_HOLE_INDICES;
}

// Pindahkan tiap Black Hole ke petak acak di ruasnya sendiri (ruas k = petak 10k..10k+9).
// Petak start, petak aman, petak berisi bidak, dan posisi lama dihindari.
function relocateBlackHoles(room, random = Math.random) {
  const occupied = new Set();
  for (const p of room.players) {
    const colorIdx = COLORS.indexOf(p.color);
    for (const v of room.pawns[p.id] || []) {
      const t = getTrackIndex(colorIdx, v);
      if (t !== null) occupied.add(t);
    }
  }
  const current = getBlackHoles(room);
  return [0, 1, 2, 3].map(segment => {
    const candidates = [];
    for (let i = 0; i < 10; i++) {
      const t = segment * 10 + i;
      if (COLOR_OFFSETS.includes(t) || SAFE_TRACK_INDICES.includes(t) || occupied.has(t) || t === current[segment]) continue;
      candidates.push(t);
    }
    // Ruas penuh bidak: Black Hole tetap di tempat lamanya
    if (candidates.length === 0) return current[segment];
    return candidates[Math.floor(random() * candidates.length)];
  });
}

// ==========================================
// BOT: menimbang untung-rugi setiap langkah
// ==========================================

// Bobot keputusan bot. Nilai bidak = seberapa jauh ia sudah berjalan (makin jauh, makin mahal hilang).
const AI = {
  progress: 1,          // per langkah maju
  leaveBase: 30,        // mengeluarkan bidak dari markas
  enterHome: 45,        // masuk jalur finish (tidak bisa diinjak lagi)
  finish: 120,          // bidak sampai finish
  captureBase: 50,      // memakan bidak lawan
  captureProgress: 1.5, // ditambah sejauh apa bidak lawan sudah berjalan
  riskWeight: 1,        // kerugian = peluang dimakan x nilai bidak
  blackHole: 40,        // mendarat di Black Hole tanpa perisai
  shieldCost: 25        // memakai perisai (bisa item yang dibeli pemain saat langkahnya dijalankan otomatis)
};

const pawnWorth = val => val + 20;

// Peluang sebuah petak lintasan dimakan lawan di giliran berikutnya. Setiap bidak lawan yang
// berada 1-6 langkah di belakang petak (dan belum berbelok ke jalur finishnya) punya peluang 1/6.
function captureRisk(room, player, trackPos) {
  if (trackPos === null || isPawnProtected(room, player, trackPos)) return 0;

  let chance = 0;
  for (const opp of room.players) {
    if (opp.id === player.id || opp.isOut) continue;
    const oppColorIdx = COLORS.indexOf(opp.color);
    for (const v of room.pawns[opp.id] || []) {
      if (v >= 1 && v <= 39) {
        const distance = (trackPos - getTrackIndex(oppColorIdx, v) + 40) % 40;
        if (distance >= 1 && distance <= 6 && v + distance <= 39) chance += 1 / 6;
      } else if (v === 0 && trackPos === COLOR_OFFSETS[oppColorIdx]) {
        chance += 2 / 6; // lawan keluar markas dengan 1 atau 6 tepat di petak ini
      }
    }
  }
  return Math.min(chance, 1);
}

// Nilai sebuah langkah dari sudut pandang pemain: untung (maju, makan, aman, finish) dikurangi rugi
function evaluateMove(room, player, pawnIdx, dice) {
  const pawns = room.pawns[player.id];
  const colorIdx = COLORS.indexOf(player.color);
  const from = pawns[pawnIdx];
  const to = from === 0 ? 1 : from + dice;
  const fromTrack = getTrackIndex(colorIdx, from);
  const toTrack = getTrackIndex(colorIdx, to);
  let score = 0;

  score += (to - from) * AI.progress;
  if (from === 0) score += AI.leaveBase + (pawns.filter(v => v >= 1 && v < FINISH).length === 0 ? 20 : 0);
  if (to === FINISH) score += AI.finish;
  else if (from <= 39 && to >= 40) score += AI.enterHome;

  if (toTrack !== null) {
    const victim = opponentPawnAt(room, player, toTrack);
    if (victim && !isPawnProtected(room, victim.player, toTrack)) {
      score += AI.captureBase + victim.val * AI.captureProgress;
    }
  }

  // Selisih risiko: lepas dari ancaman di posisi sekarang vs ancaman di posisi baru
  const riskNow = fromTrack !== null ? captureRisk(room, player, fromTrack) : 0;
  const riskNext = toTrack !== null ? captureRisk(room, player, toTrack) : 0;
  score += riskNow * pawnWorth(from) * AI.riskWeight;
  score -= riskNext * pawnWorth(to) * AI.riskWeight;

  if (room.settings?.blackHole && toTrack !== null && getBlackHoles(room).includes(toTrack)) {
    const shielded = items.protectorsOf('blackHole').some(item => {
      const stock = player.items?.[item.id];
      return (stock?.owned || 0) + (stock?.earned || 0) > 0;
    });
    score -= shielded ? AI.shieldCost : AI.blackHole + pawnWorth(to);
  }

  return score;
}

function opponentPawnAt(room, player, trackPos) {
  for (const opp of room.players) {
    if (opp.id === player.id) continue;
    const oppColorIdx = COLORS.indexOf(opp.color);
    const pawns = room.pawns[opp.id] || [];
    for (let i = 0; i < pawns.length; i++) {
      if (pawns[i] >= 1 && pawns[i] <= 39 && getTrackIndex(oppColorIdx, pawns[i]) === trackPos) {
        return { player: opp, pawnIdx: i, val: pawns[i] };
      }
    }
  }
  return null;
}

// Pilih langkah dengan nilai tertinggi; seri dipecah dengan bidak yang paling jauh
function chooseBestPawn(room, player, dice) {
  if (!room.pawns[player.id]) return null;
  const movable = getMovablePawns(room, player, dice);
  if (movable.length === 0) return null;

  let best = null;
  for (const pawnIdx of movable) {
    const score = evaluateMove(room, player, pawnIdx, dice);
    const progress = room.pawns[player.id][pawnIdx];
    if (!best || score > best.score || (score === best.score && progress > best.progress)) {
      best = { pawnIdx, score, progress };
    }
  }
  return best.pawnIdx;
}

// ==========================================
// PERINGKAT AKHIR
// ==========================================

// Urutan pemain saat permainan selesai: pemenang dulu, lalu pemain yang masih main di atas
// pemain yang OUT/menyerah. Sesama itu diurutkan dari jumlah bidak finish, lalu total langkah.
function rankPlayers(room, winnerId) {
  const progress = p => {
    const pawns = room.pawns[p.id] || [];
    return { finished: pawns.filter(v => v === FINISH).length, steps: pawns.reduce((a, b) => a + b, 0) };
  };
  return [...room.players]
    .sort((a, b) => {
      if (a.id === winnerId) return -1;
      if (b.id === winnerId) return 1;
      if (!!a.isOut !== !!b.isOut) return a.isOut ? 1 : -1;
      const pa = progress(a);
      const pb = progress(b);
      return pb.finished - pa.finished || pb.steps - pa.steps;
    })
    .map(p => p.id);
}

// ==========================================
// DADU SEIMBANG (lihat riset "Dadu Seimbang JakLudo")
// ==========================================

// Angka dadu (1-6) yang membuat salah satu bidak pemain memakan bidak lawan
function captureFaces(room, player) {
  const colorIdx = COLORS.indexOf(player.color);
  const faces = new Set();
  for (let face = 1; face <= 6; face++) {
    for (let i = 0; i < 4; i++) {
      if (!canPawnMove(room, player, i, face)) continue;
      const from = room.pawns[player.id][i];
      const to = from === 0 ? 1 : from + face;
      if (to > 39) continue;
      const victim = opponentPawnAt(room, player, getTrackIndex(colorIdx, to));
      if (victim && !isPawnProtected(room, victim.player, getTrackIndex(colorIdx, to))) {
        faces.add(face);
        break;
      }
    }
  }
  return faces;
}

// Bobot tiap angka untuk lemparan berikutnya:
// 1. Koreksi defisit (beta): angka yang kurang keluar di permainan ini sedikit lebih mungkin muncul,
//    sehingga nasib buruk beruntun ditekan tapi peluang jangka panjang tetap 1/6.
// 2. Dorongan makan (gamma) yang meluruh: angka yang bisa memakan lawan dikali
//    (1 + gamma) x chainDecay^streak, streak = berapa kali pemain ini makan berturut-turut.
//    Dengan gamma 0.4 dan chainDecay 0.5: 1.4 -> 0.7 -> 0.35 -> 0.175, jadi makan pertama
//    sedikit didorong, makan kedua sudah di bawah normal, dan makan ketiga jarang terjadi.
//    Kenaikan peluang dibatasi maxAdd (mis. 0.06 = 6 poin persen).
// stats = { counts: [6 angka], total, captureStreak } milik pemain di permainan ini.
function diceWeights(room, player, stats, { beta = 0, gamma = 0, maxAdd = 1, chainDecay = 1 } = {}) {
  const expected = stats.total / 6;
  const weights = stats.counts.map(c => Math.exp(beta * (expected - c)));
  const mult = (1 + gamma) * Math.pow(chainDecay, stats.captureStreak || 0);
  if (mult === 1) return weights;

  const capture = captureFaces(room, player);
  if (capture.size === 0 || capture.size === 6) return weights;
  const sum = weights.reduce((a, b) => a + b, 0);
  const captureWeight = [...capture].reduce((s, f) => s + weights[f - 1], 0);
  const before = captureWeight / sum;
  let target = (captureWeight * mult) / (sum - captureWeight + captureWeight * mult);
  if (mult > 1) target = Math.min(target, before + maxAdd);
  const k = (target * (sum - captureWeight)) / ((1 - target) * captureWeight);
  return weights.map((w, i) => (capture.has(i + 1) ? w * k : w));
}

// random() -> [0, 1)
function rollWeighted(weights, random) {
  let r = random() * weights.reduce((a, b) => a + b, 0);
  for (let face = 1; face <= 6; face++) {
    r -= weights[face - 1];
    if (r < 0) return face;
  }
  return 6;
}

// Validasi indeks bidak dari payload klien
function isPawnIndex(v) {
  return Number.isInteger(v) && v >= 0 && v <= 3;
}

module.exports = {
  COLORS,
  COLOR_OFFSETS,
  SAFE_TRACK_INDICES,
  BLACK_HOLE_INDICES,
  FINISH,
  getTrackIndex,
  nextFreeColor,
  canPawnMove,
  getMovablePawns,
  isPawnProtected,
  getBlackHoles,
  relocateBlackHoles,
  captureRisk,
  evaluateMove,
  chooseBestPawn,
  rankPlayers,
  captureFaces,
  diceWeights,
  rollWeighted,
  isPawnIndex
};
