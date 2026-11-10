const test = require('node:test');
const assert = require('node:assert/strict');
const { canPawnMove, getMovablePawns, chooseBestPawn, nextFreeColor, getTrackIndex, isPawnIndex } = require('./rules');

function makeRoom(pawnsByPlayer, settings = { safeZones: true }) {
  const colors = ['red', 'green', 'yellow', 'blue'];
  const players = Object.keys(pawnsByPlayer).map((id, i) => ({ id, color: colors[i] }));
  return { players, pawns: pawnsByPlayer, settings };
}

test('bidak di markas hanya keluar dengan angka 1 atau 6', () => {
  const room = makeRoom({ a: [0, 0, 0, 0], b: [0, 0, 0, 0] });
  const a = room.players[0];
  assert.deepEqual(getMovablePawns(room, a, 3), []);
  assert.deepEqual(getMovablePawns(room, a, 6), [0, 1, 2, 3]);
  assert.deepEqual(getMovablePawns(room, a, 1), [0, 1, 2, 3]);
});

test('tidak boleh mendarat di petak bidak sendiri', () => {
  const room = makeRoom({ a: [5, 8, 0, 0], b: [0, 0, 0, 0] });
  assert.equal(canPawnMove(room, room.players[0], 0, 3), false);
  assert.equal(canPawnMove(room, room.players[0], 0, 4), true);
});

test('tidak boleh melewati petak finish', () => {
  const room = makeRoom({ a: [42, 0, 0, 0], b: [0, 0, 0, 0] });
  assert.equal(canPawnMove(room, room.players[0], 0, 2), true);
  assert.equal(canPawnMove(room, room.players[0], 0, 3), false);
});

test('safe zone yang ditempati lawan tidak bisa didarati', () => {
  // Track 6 adalah safe zone. Merah val 7 -> track 6. Hijau val 37 -> track (10+36)%40 = 6.
  const room = makeRoom({ a: [3, 0, 0, 0], b: [37, 0, 0, 0] });
  assert.equal(getTrackIndex(1, 37), 6);
  assert.equal(canPawnMove(room, room.players[0], 0, 4), false);
  room.settings.safeZones = false;
  assert.equal(canPawnMove(room, room.players[0], 0, 4), true);
});

test('bot memprioritaskan memakan lawan', () => {
  // Merah: bidak 0 di val 2 (track 1), bidak 1 di val 10 (track 9). Hijau di track 12 (val 3).
  const room = makeRoom({ a: [2, 10, 0, 0], b: [3, 0, 0, 0] });
  // dadu 3: bidak 1 -> val 13 -> track 12 = makan lawan
  assert.equal(chooseBestPawn(room, room.players[0], 3), 1);
});

test('nextFreeColor memilih warna yang belum dipakai', () => {
  assert.equal(nextFreeColor([{ color: 'red' }, { color: 'yellow' }]), 'green');
  assert.equal(nextFreeColor([{ color: 'red' }, { color: 'green' }, { color: 'yellow' }, { color: 'blue' }]), null);
});

test('isPawnIndex hanya menerima bilangan bulat 0..3', () => {
  for (const ok of [0, 1, 2, 3]) assert.equal(isPawnIndex(ok), true);
  for (const bad of [-1, 4, 1.5, '1', 'abc', null, undefined, NaN]) assert.equal(isPawnIndex(bad), false);
});

// ---------- Bot ----------

test('bot memilih bidak yang aman daripada mendarat tepat di depan lawan', () => {
  // Merah bidak 0 di val 3 (track 2), bidak 1 di val 20 (track 19). Dadu 2.
  // Bidak 0 -> track 4: ada hijau di track 1 (val 32, jarak 3) -> berisiko.
  // Bidak 1 -> track 21: tidak ada lawan di belakangnya -> aman.
  const room = makeRoom({ a: [3, 20, 0, 0], b: [32, 0, 0, 0] });
  assert.equal(getTrackIndex(1, 32), 1);
  assert.equal(chooseBestPawn(room, room.players[0], 2), 1);
});

test('bot lebih memilih memakan bidak lawan yang sudah jauh', () => {
  // Dadu 3: bidak 0 (val 2) -> track 4 memakan hijau val 35 (jauh); bidak 1 (val 10) -> track 12 memakan hijau val 3 (dekat markas)
  const room = makeRoom({ a: [2, 10, 0, 0], b: [35, 3, 0, 0] }, { safeZones: false });
  assert.equal(chooseBestPawn(room, room.players[0], 3), 0);
});

test('bot memasukkan bidak ke jalur finish yang aman jika lawan mengejar', () => {
  // Bidak 0 di val 37 dikejar hijau (track 33 = val 24), dadu 4 -> val 41 (jalur finish)
  const room = makeRoom({ a: [37, 5, 0, 0], b: [24, 0, 0, 0] });
  assert.equal(chooseBestPawn(room, room.players[0], 4), 0);
});

test('bot menghindari Black Hole jika tidak punya perisai', () => {
  // Dadu 3: bidak 0 (val 2) -> track 4 = Black Hole; bidak 1 (val 20) -> track 22 = petak biasa
  const room = makeRoom({ a: [2, 20, 0, 0], b: [0, 0, 0, 0] }, { safeZones: true, blackHole: true });
  assert.equal(chooseBestPawn(room, room.players[0], 3), 1);
});

// ---------- Black Hole acak ----------

test('Black Hole acak pindah di ruasnya sendiri dan menghindari bidak, petak aman, dan start', () => {
  const { relocateBlackHoles, COLOR_OFFSETS: offsets, SAFE_TRACK_INDICES: safe } = require('./rules');
  // Merah menempati track 1..5 (val 2..6 untuk bidak 0..3 + 1 bidak di val 4)
  const room = makeRoom({ a: [2, 3, 4, 5], b: [0, 0, 0, 0] }, { safeZones: true, blackHole: true });
  for (let i = 0; i < 200; i++) {
    const holes = relocateBlackHoles(room);
    holes.forEach((t, segment) => {
      assert.equal(Math.floor(t / 10), segment, 'tetap di ruasnya');
      assert.ok(!offsets.includes(t) && !safe.includes(t), 'bukan petak start/aman');
      assert.ok(![1, 2, 3, 4].includes(t), 'bukan petak berisi bidak');
    });
  }
});

// ---------- Petak start hanya aman bagi pemiliknya ----------

test('keluar markas memakan bidak lawan yang singgah di petak start sendiri', () => {
  // Hijau val 31 -> track 0 = petak start merah. Merah dapat 6 atau 1: tetap boleh keluar.
  const room = makeRoom({ a: [0, 0, 0, 0], b: [31, 0, 0, 0] });
  assert.equal(getTrackIndex(1, 31), 0);
  assert.equal(canPawnMove(room, room.players[0], 0, 6), true);
  assert.equal(canPawnMove(room, room.players[0], 0, 1), true);
});

test('bidak di petak start warna lain bisa dimakan pemain ketiga', () => {
  // Kuning (pemain C) val 21 -> track 0 = start merah. Biru val 6 -> track 35, dadu 5 -> track 0: kuning dimakan.
  const room = makeRoom({ a: [0, 0, 0, 0], b: [0, 0, 0, 0], c: [21, 0, 0, 0], d: [6, 0, 0, 0] });
  assert.equal(getTrackIndex(2, 21), 0);
  assert.equal(getTrackIndex(3, 11), 0);
  assert.equal(canPawnMove(room, room.players[3], 0, 5), true);
});

test('bidak di petak start warnanya sendiri tetap tidak bisa didarati lawan', () => {
  // Merah val 1 -> track 0 (start merah). Biru val 6, dadu 5 -> track 0: tertutup, dengan atau tanpa safe zone.
  const room = makeRoom({ a: [1, 0, 0, 0], b: [0, 0, 0, 0], c: [0, 0, 0, 0], d: [6, 0, 0, 0] });
  assert.equal(canPawnMove(room, room.players[3], 0, 5), false);
  room.settings.safeZones = false;
  assert.equal(canPawnMove(room, room.players[3], 0, 5), false);
});

test('petak start tetap aman bagi pemiliknya walaupun safe zone dimatikan', () => {
  const { isPawnProtected, captureRisk } = require('./rules');
  // Safe zone mati. Merah val 1 -> track 0 (start merah). Biru val 6 (track 35) di belakangnya, jarak 5.
  const room = makeRoom({ a: [1, 0, 0, 0], b: [0, 0, 0, 0], c: [0, 0, 0, 0], d: [6, 0, 0, 0] }, { safeZones: false });
  const [red, green, , blue] = room.players;
  assert.equal(isPawnProtected(room, red, 0), true, 'start sendiri tetap aman');
  assert.equal(isPawnProtected(room, green, 0), false, 'start warna lain tidak melindungi tamu');
  assert.equal(isPawnProtected(room, red, 6), false, 'petak bintang ikut mati bersama safe zone');
  assert.equal(canPawnMove(room, blue, 0, 5), false, 'lawan tidak bisa mendarat di start merah');
  assert.equal(captureRisk(room, red, 0), 0, 'bot tahu bidaknya aman di start sendiri');
  // Pemilik yang sudah OUT kehilangan perlindungan
  red.isOut = true;
  assert.equal(canPawnMove(room, blue, 0, 5), true);
});

// ---------- Dadu seimbang ----------

const { diceWeights, rollWeighted, captureFaces } = require('./rules');
const freshStats = () => ({ counts: [0, 0, 0, 0, 0, 0], total: 0 });
const share = (w, faces) => faces.reduce((s, f) => s + w[f - 1], 0) / w.reduce((a, b) => a + b, 0);

test('dadu tanpa koreksi sama dengan dadu biasa', () => {
  const room = makeRoom({ a: [0, 0, 0, 0], b: [0, 0, 0, 0] });
  const w = diceWeights(room, room.players[0], freshStats(), { beta: 0, gamma: 0 });
  assert.deepEqual(w, [1, 1, 1, 1, 1, 1]);
});

test('koreksi defisit memberi bobot terbesar ke angka yang paling jarang keluar', () => {
  const room = makeRoom({ a: [0, 0, 0, 0], b: [0, 0, 0, 0] });
  const stats = { counts: [0, 5, 5, 5, 5, 5], total: 25 };
  const w = diceWeights(room, room.players[0], stats, { beta: 0.3 });
  assert.equal(w.indexOf(Math.max(...w)), 0);
  assert.ok(share(w, [1]) < 0.5, 'tetap acak, bukan dipaksa keluar');
});

test('angka yang bisa memakan lawan didorong sesuai gamma', () => {
  // Merah val 2 (track 1); hijau val 35 -> track 4: hanya angka 3 yang memakan
  const room = makeRoom({ a: [2, 0, 0, 0], b: [35, 0, 0, 0] });
  assert.deepEqual([...captureFaces(room, room.players[0])], [3]);
  const w = diceWeights(room, room.players[0], freshStats(), { gamma: 0.4, maxAdd: 0.06 });
  assert.ok(Math.abs(share(w, [3]) - 1.4 / 6.4) < 1e-9);
});

test('dorongan makan dibatasi maksimal +6 poin persen', () => {
  // Hijau di track 3, 4, 5 -> angka 2, 3, 4 semuanya memakan (awalnya 50%)
  const room = makeRoom({ a: [2, 0, 0, 0], b: [34, 35, 36, 0] });
  assert.deepEqual([...captureFaces(room, room.players[0])].sort(), [2, 3, 4]);
  const w = diceWeights(room, room.players[0], freshStats(), { gamma: 0.4, maxAdd: 0.06 });
  assert.ok(Math.abs(share(w, [2, 3, 4]) - 0.56) < 1e-9);
});

test('bidak lawan yang terlindungi tidak memicu dorongan makan', () => {
  // Merah val 8 (track 7) + 3 -> track 10 = start hijau, ditempati hijau sendiri (kebal)
  const room = makeRoom({ a: [8, 0, 0, 0], b: [1, 0, 0, 0] });
  assert.equal(captureFaces(room, room.players[0]).size, 0);
});

test('rollWeighted memetakan angka acak ke sisi dadu sesuai bobot', () => {
  const w = [1, 1, 1, 1, 1, 1];
  assert.equal(rollWeighted(w, () => 0), 1);
  assert.equal(rollWeighted(w, () => 0.5), 4);
  assert.equal(rollWeighted(w, () => 0.999999), 6);
});

test('dalam jangka panjang tiap angka tetap keluar sekitar 1/6', () => {
  const room = makeRoom({ a: [0, 0, 0, 0], b: [0, 0, 0, 0] });
  const counts = [0, 0, 0, 0, 0, 0];
  let stats = freshStats();
  for (let i = 0; i < 60000; i++) {
    if (stats.total === 50) stats = freshStats(); // satu permainan
    const face = rollWeighted(diceWeights(room, room.players[0], stats, { beta: 0.3 }), Math.random);
    stats.counts[face - 1]++;
    stats.total++;
    counts[face - 1]++;
  }
  for (const c of counts) assert.ok(Math.abs(c / 60000 - 1 / 6) < 0.01, `frekuensi ${c / 60000}`);
});

test('lemparan setelah makan tidak lagi didorong, dan makan beruntun diredam', () => {
  // Hanya angka 3 yang memakan (lihat test dorongan makan di atas)
  const room = makeRoom({ a: [2, 0, 0, 0], b: [35, 0, 0, 0] });
  const cfg = { gamma: 0.4, maxAdd: 0.06, chainAfter: 2, chainDamp: 0.4 };
  const afterOne = diceWeights(room, room.players[0], { ...freshStats(), captureStreak: 1 }, cfg);
  assert.ok(Math.abs(share(afterOne, [3]) - 1 / 6) < 1e-9, 'tanpa dorongan setelah 1x makan');
  const afterTwo = diceWeights(room, room.players[0], { ...freshStats(), captureStreak: 2 }, cfg);
  assert.ok(Math.abs(share(afterTwo, [3]) - 0.4 / 5.4) < 1e-9, 'diredam setelah 2x makan beruntun');
});
