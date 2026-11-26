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

test('peluang makan turun eksponensial setiap kali makan beruntun', () => {
  // Hanya angka 3 yang memakan (lihat test dorongan makan di atas)
  const room = makeRoom({ a: [2, 0, 0, 0], b: [35, 0, 0, 0] });
  const cfg = { gamma: 0.4, maxAdd: 0.06, chainDecay: 0.5 };
  const chance = streak => share(diceWeights(room, room.players[0], { ...freshStats(), captureStreak: streak }, cfg), [3]);
  assert.ok(Math.abs(chance(0) - 1.4 / 6.4) < 1e-9, 'makan pertama sedikit didorong');
  assert.ok(Math.abs(chance(1) - 0.7 / 5.7) < 1e-9, 'makan kedua di bawah peluang normal');
  assert.ok(Math.abs(chance(2) - 0.35 / 5.35) < 1e-9, 'makan ketiga makin kecil');
  assert.ok(chance(0) > 1 / 6 && chance(1) < 1 / 6 && chance(2) < chance(1) / 1.8);
});

test('peringkat akhir: pemenang, lalu bidak finish, total langkah, dan pemain OUT paling bawah', () => {
  const { rankPlayers } = require('./rules');
  const room = makeRoom({ a: [44, 44, 44, 44], b: [44, 10, 0, 0], c: [44, 20, 5, 0], d: [44, 44, 0, 0] });
  room.players[3].isOut = true; // d menyerah walau 2 bidaknya sudah finish
  assert.deepEqual(rankPlayers(room, 'a'), ['a', 'c', 'b', 'd']);
});

// ---------- Skin Ocean Blue: Hint langkah taktis ----------

function makeHintRoom(pawnsByPlayer, { settings = { safeZones: true }, skin = { id: 'ocean_blue', assetKey: 'ocean_blue' }, itemsByPlayer = {} } = {}) {
  const room = makeRoom(pawnsByPlayer, settings);
  room.started = true;
  room.turn = 0;
  room.players[0].equippedSkin = skin;
  for (const [pid, items] of Object.entries(itemsByPlayer)) {
    const p = room.players.find(pl => pl.id === pid);
    if (p) p.items = items;
  }
  return room;
}

test('Ocean Blue & Combo Skins ability: aktif pada ocean_blue, fire_phoenix, dan legendary_diamond', async () => {
  const { hasOceanBlueHintAbility, evaluateOceanBlueHints } = await import('../../client/src/utils/oceanBlueHints.mjs');

  assert.equal(hasOceanBlueHintAbility('ocean_blue'), true);
  assert.equal(hasOceanBlueHintAbility({ id: 'ocean_blue' }), true);
  assert.equal(hasOceanBlueHintAbility({ id: 'custom_skin', assetKey: 'ocean_blue' }), true);
  assert.equal(hasOceanBlueHintAbility({ id: 'fire_phoenix', assetKey: 'fire_phoenix' }), true);
  assert.equal(hasOceanBlueHintAbility({ id: 'legendary_diamond', assetKey: 'legendary_diamond' }), true);
  assert.equal(hasOceanBlueHintAbility('fire_phoenix'), true);
  assert.equal(hasOceanBlueHintAbility('legendary_diamond'), true);
  assert.equal(hasOceanBlueHintAbility(null), false);
  assert.equal(hasOceanBlueHintAbility(undefined), false);
  assert.equal(hasOceanBlueHintAbility({ id: 'classic_gold', assetKey: 'classic_gold' }), false);
  assert.equal(hasOceanBlueHintAbility({ id: 'ruby_crystal', assetKey: 'ruby_crystal' }), false);
  assert.equal(hasOceanBlueHintAbility({ id: 'emerald_green', assetKey: 'emerald_green' }), false);
  assert.equal(hasOceanBlueHintAbility({ id: 'galaxy_purple', assetKey: 'galaxy_purple' }), false);

  const baseRoom = makeHintRoom({ a: [2, 10, 0, 0], b: [3, 0, 0, 0] });
  baseRoom.dice = 3;
  assert.equal(evaluateOceanBlueHints({ room: baseRoom, playerId: 'a', movablePawns: [0, 1], isMyTurn: true }).active, true);

  const phoenixRoom = makeHintRoom(
    { a: [2, 10, 0, 0], b: [3, 0, 0, 0] },
    { skin: { id: 'fire_phoenix', assetKey: 'fire_phoenix' } }
  );
  phoenixRoom.dice = 3;
  assert.equal(evaluateOceanBlueHints({ room: phoenixRoom, playerId: 'a', movablePawns: [0, 1], isMyTurn: true }).active, true);

  const diamondRoom = makeHintRoom(
    { a: [2, 10, 0, 0], b: [3, 0, 0, 0] },
    { skin: { id: 'legendary_diamond', assetKey: 'legendary_diamond' } }
  );
  diamondRoom.dice = 3;
  assert.equal(evaluateOceanBlueHints({ room: diamondRoom, playerId: 'a', movablePawns: [0, 1], isMyTurn: true }).active, true);

  // Guard non-aktif
  assert.equal(evaluateOceanBlueHints({ room: baseRoom, playerId: 'a', movablePawns: [0, 1], isMyTurn: false }).active, false);
  assert.equal(evaluateOceanBlueHints({ room: baseRoom, playerId: 'a', movablePawns: [0, 1], isMyTurn: true, targeting: true }).active, false);
  assert.equal(evaluateOceanBlueHints({ room: baseRoom, playerId: 'a', movablePawns: [], isMyTurn: true }).active, false);

  const noDiceRoom = { ...baseRoom, dice: null };
  assert.equal(evaluateOceanBlueHints({ room: noDiceRoom, playerId: 'a', movablePawns: [0, 1], isMyTurn: true }).active, false);

  const nonOceanRoom = makeHintRoom({ a: [2, 10, 0, 0], b: [3, 0, 0, 0] }, { skin: { id: 'classic_gold', assetKey: 'classic_gold' } });
  nonOceanRoom.dice = 3;
  assert.equal(evaluateOceanBlueHints({ room: nonOceanRoom, playerId: 'a', movablePawns: [0, 1], isMyTurn: true }).active, false);
});

test('Ocean Blue hint mengurutkan >2 bidak menguntungkan dari peluang terbaik (Finish > Makan > Jalur Finish > Safe Star)', async () => {
  const { evaluateOceanBlueHints } = await import('../../client/src/utils/oceanBlueHints.mjs');
  // Merah (offset 0), dadu 3:
  //   bidak 0 (val 10 -> 13, track 12): makan hijau (val 3, track 12)
  //   bidak 1 (val 4 -> 7, track 6): mendarat di petak aman bintang (SAFE_TRACK_INDICES = 6)
  //   bidak 2 (val 41 -> 44): masuk finish
  //   bidak 3 (val 37 -> 40): masuk jalur finish aman
  const room = makeHintRoom({ a: [10, 4, 41, 37], b: [3, 0, 0, 0] });
  room.dice = 3;
  const movablePawns = getMovablePawns(room, room.players[0], 3);
  const res = evaluateOceanBlueHints({ room, playerId: 'a', movablePawns, isMyTurn: true });

  assert.equal(res.active, true);
  assert.deepEqual(res.recommended.map(r => r.pawnIdx), [2, 0, 3, 1]);
  assert.deepEqual(res.recommended.map(r => r.rank), [1, 2, 3, 4]);
  assert.equal(res.byPawn[2].tags.isFinish, true);
  assert.equal(res.byPawn[0].tags.isCapture, true);
  assert.equal(res.byPawn[3].tags.isEnterHome, true);
  assert.equal(res.byPawn[1].tags.isSafeLanding, true);
});

test('Ocean Blue hint mengecualikan jebakan Black Hole saat >2 bidak lain menguntungkan', async () => {
  const { evaluateOceanBlueHints } = await import('../../client/src/utils/oceanBlueHints.mjs');
  // Merah dadu 3:
  //   bidak 0 (val 10 -> 13, track 12): makan hijau val 3 -> rank #1
  //   bidak 2 (val 38 -> 41): masuk jalur finish -> rank #2
  //   bidak 1 (val 4 -> 7, track 6): safe star -> rank #3
  //   bidak 3 (val 2 -> 5, track 4): Black Hole tanpa perisai -> tidak masuk recommended
  const room = makeHintRoom(
    { a: [10, 4, 38, 2], b: [3, 0, 0, 0] },
    { settings: { safeZones: true, blackHole: true } }
  );
  room.dice = 3;
  const movablePawns = getMovablePawns(room, room.players[0], 3);
  const res = evaluateOceanBlueHints({ room, playerId: 'a', movablePawns, isMyTurn: true });

  assert.deepEqual(res.recommended.map(r => r.pawnIdx), [0, 2, 1]);
  assert.deepEqual(res.recommended.map(r => r.rank), [1, 2, 3]);
  assert.equal(res.byPawn[3], undefined);
  const bhEval = res.evaluated.find(e => e.pawnIdx === 3);
  assert.equal(bhEval.tags.isBlackHoleDanger, true);
});

test('Ocean Blue hint mengenali Blackhole Shield dan Universal Shield (format client & server)', async () => {
  const { evaluatePawnMove } = await import('../../client/src/utils/oceanBlueHints.mjs');
  const unshieldedRoom = makeHintRoom(
    { a: [2, 0, 0, 0], b: [0, 0, 0, 0] },
    { settings: { safeZones: true, blackHole: true } }
  );
  const clientShieldRoom = makeHintRoom(
    { a: [2, 0, 0, 0], b: [0, 0, 0, 0] },
    { settings: { safeZones: true, blackHole: true }, itemsByPlayer: { a: { blackholeShield: { count: 1 } } } }
  );
  const serverShieldRoom = makeHintRoom(
    { a: [2, 0, 0, 0], b: [0, 0, 0, 0] },
    { settings: { safeZones: true, blackHole: true }, itemsByPlayer: { a: { universalShield: { owned: 1, earned: 0 } } } }
  );

  const evalUnshielded = evaluatePawnMove(unshieldedRoom, unshieldedRoom.players[0], 0, 3);
  const evalClientShield = evaluatePawnMove(clientShieldRoom, clientShieldRoom.players[0], 0, 3);
  const evalServerShield = evaluatePawnMove(serverShieldRoom, serverShieldRoom.players[0], 0, 3);

  assert.equal(evalUnshielded.tags.isBlackHoleDanger, true);
  assert.equal(evalClientShield.tags.isBlackHoleDanger, false);
  assert.equal(evalClientShield.tags.isBlackHoleShielded, true);
  assert.equal(evalServerShield.tags.isBlackHoleDanger, false);
  assert.equal(evalServerShield.tags.isBlackHoleShielded, true);
  assert.ok(evalClientShield.score > evalUnshielded.score);
  assert.ok(evalServerShield.score > evalUnshielded.score);
});

test('Ocean Blue hint memprioritaskan makan pemain aktif dibanding OUT dan kabur dari ancaman', async () => {
  const { evaluateOceanBlueHints } = await import('../../client/src/utils/oceanBlueHints.mjs');

  // Makan pemain aktif vs pemain OUT (nilai jarak bidak korban sama-sama 3)
  const capRoom = makeHintRoom(
    { a: [10, 20, 0, 0], b: [3, 0, 0, 0], c: [3, 0, 0, 0] },
    { settings: { safeZones: false } }
  );
  capRoom.players[2].isOut = true;
  capRoom.dice = 3;
  const capRes = evaluateOceanBlueHints({ room: capRoom, playerId: 'a', movablePawns: [0, 1], isMyTurn: true });
  assert.equal(capRes.recommended[0].pawnIdx, 0);

  // Kabur dari ancaman vs melangkah ke posisi rawan dikejar
  // Merah bidak 0 di val 6 (track 5, dikejar hijau val 32 track 1 -> jarak 4) + 4 -> val 10 (track 9, aman)
  // Merah bidak 1 di val 14 (track 13, aman) + 4 -> val 18 (track 17, dikejar kuning val 36 track 15 -> jarak 2)
  const escapeRoom = makeHintRoom({ a: [6, 14, 0, 0], b: [32, 0, 0, 0], c: [36, 0, 0, 0] });
  escapeRoom.dice = 4;
  const escRes = evaluateOceanBlueHints({ room: escapeRoom, playerId: 'a', movablePawns: [0, 1], isMyTurn: true });
  assert.equal(escRes.recommended[0].pawnIdx, 0);
  assert.equal(escRes.recommended[0].tags.isEscapeDanger, true);
  assert.equal(escRes.byPawn[1], undefined);
});

test('Ocean Blue hint menggabungkan bidak identik di markas menjadi peringkat #1 dan tetap menyarankan langkah paling aman saat semua berisiko', async () => {
  const { evaluateOceanBlueHints } = await import('../../client/src/utils/oceanBlueHints.mjs');

  const baseRoom = makeHintRoom({ a: [0, 0, 0, 0], b: [0, 0, 0, 0] });
  baseRoom.dice = 6;
  const baseRes = evaluateOceanBlueHints({ room: baseRoom, playerId: 'a', movablePawns: [0, 1, 2, 3], isMyTurn: true });
  assert.deepEqual(baseRes.recommended.map(r => r.rank), [1, 1, 1, 1]);
  assert.equal(baseRes.displayList.length, 1);
  assert.equal(baseRes.displayList[0].label, 'Bidak 1–4');

  // Semua bidak yang bisa jalan menuju bahaya (1 kena Black Hole jauh, 1 sekadar rawan dikejar):
  // Bidak dengan kerugian lebih kecil tetap muncul sebagai #1
  const badRoom = makeHintRoom(
    { a: [12, 2, 0, 0], b: [33, 0, 0, 0] },
    { settings: { safeZones: true, blackHole: true } }
  );
  // Dice 3: bidak 0 (12->15, track 14 BLACK HOLE!), bidak 1 (2->5, track 4 juga Black Hole!)
  // Bidak 1 lebih murah (from 2 vs 12 -> penalty to+20 lebih kecil: 45+25=70 vs 45+35=80), tetap terpilih sebagai #1
  badRoom.dice = 3;
  const badRes = evaluateOceanBlueHints({ room: badRoom, playerId: 'a', movablePawns: [0, 1], isMyTurn: true });
  assert.equal(badRes.recommended.length, 1);
  assert.equal(badRes.recommended[0].pawnIdx, 1);
  assert.equal(badRes.recommended[0].rank, 1);
});

test('Ocean Blue hint #1 konsisten dengan chooseBestPawn pada skenario taktis utama', async () => {
  const { evaluateOceanBlueHints } = await import('../../client/src/utils/oceanBlueHints.mjs');

  const scenarios = [
    { room: makeHintRoom({ a: [2, 10, 0, 0], b: [3, 0, 0, 0] }), dice: 3 },
    { room: makeHintRoom({ a: [3, 20, 0, 0], b: [32, 0, 0, 0] }), dice: 2 },
    { room: makeHintRoom({ a: [37, 5, 0, 0], b: [24, 0, 0, 0] }), dice: 4 },
    { room: makeHintRoom({ a: [2, 20, 0, 0], b: [0, 0, 0, 0] }, { settings: { safeZones: true, blackHole: true } }), dice: 3 }
  ];

  for (const { room, dice } of scenarios) {
    room.dice = dice;
    const movablePawns = getMovablePawns(room, room.players[0], dice);
    const botBest = chooseBestPawn(room, room.players[0], dice);
    const hintBest = evaluateOceanBlueHints({ room, playerId: 'a', movablePawns, isMyTurn: true }).recommended[0]?.pawnIdx;
    assert.equal(hintBest, botBest);
  }
});

// ---------- Proteksi Anti-Bad-Luck & Anti-Frustrasi Black Hole ----------

test('anti-bad-luck dadu ringan mendorong angka besar setelah dadu kecil beruntun & angka 1/6 saat tertahan di markas', () => {
  const room = makeRoom({ a: [0, 0, 0, 0], b: [10, 0, 0, 0] });
  const cfg = { lowStreakThreshold: 3, lowStreakBoost: 0.25, stuckBaseThreshold: 3, stuckBaseBoost: 0.35 };

  // 1. Dadu kecil beruntun (<=3) selama 3x dan belum punya bidak di papan -> 4,5,6 + 1,6 terdorong
  const statsBoth = { ...freshStats(), lowRollStreak: 3, stuckBaseStreak: 3 };
  const wBoth = diceWeights(room, room.players[0], statsBoth, cfg);
  assert.ok(share(wBoth, [4, 5, 6]) > 0.5, 'angka besar 4-6 lebih tinggi saat dadu kecil beruntun');
  assert.ok(share(wBoth, [1, 6]) > 1 / 3, 'angka keluar markas 1 & 6 lebih tinggi saat tertahan di markas');

  // 2. Saat sudah ada bidak di papan, stuckBaseBoost tidak aktif meski stuckBaseStreak tinggi
  const activeRoom = makeRoom({ a: [10, 0, 0, 0], b: [20, 0, 0, 0] });
  const wActive = diceWeights(activeRoom, activeRoom.players[0], { ...freshStats(), stuckBaseStreak: 5 }, cfg);
  assert.deepEqual(wActive, [1, 1, 1, 1, 1, 1]);
});

test('anti-frustrasi Black Hole mengurangi peluang angka yang memaksa masuk lubang & relocateBlackHoles menghindar', () => {
  const { forcedBlackHoleFaces, relocateBlackHoles } = require('./rules');
  // Merah (offset 0) hanya 1 bidak di val 2 (track 1); Black Hole di track 4 -> angka 3 memaksa masuk lubang
  const room = makeRoom({ a: [2, 0, 0, 0], b: [0, 0, 0, 0] }, { safeZones: true, blackHole: true });
  const p = room.players[0];

  assert.deepEqual([...forcedBlackHoleFaces(room, p)], [3]);

  const wGrace = diceWeights(
    room,
    p,
    { ...freshStats(), blackHoleGrace: 2 },
    { blackHoleGracePenalty: 0.55 }
  );
  assert.ok(share(wGrace, [3]) < 1 / 6, 'peluang angka jebakan Black Hole diturunkan saat masa grace');

  // Jika ada bidak lain yg aman dijalankan (mis. val 6 -> track 5..11 tidak masuk lubang), angka 3 tidak dianggap memaksa
  room.pawns.a[1] = 6;
  assert.equal(forcedBlackHoleFaces(room, p).size, 0);

  // Jika punya Blackhole Shield, juga tidak dikurangi
  room.pawns.a[1] = 0;
  p.items = { blackholeShield: { owned: 1, earned: 0 } };
  assert.equal(forcedBlackHoleFaces(room, p).size, 0);

  // Mode acak: relocateBlackHoles menghindari 1..6 petak di depan bidak tunggal pemain tertinggal
  // Merah punya 1 bidak di val 2 (track 1); 1..6 langkah ke depan di ruas 0 adalah track 2,3,4,5,6(star),7 -> aman tersisa di ruas 0: 8, 9 (0=start,1=occupied,4=old)
  const relocRoom = makeRoom({ a: [2, 0, 0, 0], b: [0, 0, 0, 0] }, { safeZones: true, blackHole: true });
  relocRoom.blackHoles = [4, 14, 24, 34];
  const nextHoles = relocateBlackHoles(relocRoom, () => 0);
  assert.ok([8, 9].includes(nextHoles[0]), `ruas 0 memilih ${nextHoles[0]} di luar jangkauan 1-6 langkah di depan bidak tunggal`);
});

test('sortPlayersByColorOrder mengurutkan pemain mengikuti arah jarum jam red -> green -> yellow -> blue', () => {
  const { sortPlayersByColorOrder } = require('./rules');
  const players = [
    { id: '1', color: 'red' },
    { id: '3', color: 'yellow' },
    { id: '4', color: 'blue' },
    { id: '2', color: 'green' }
  ];
  sortPlayersByColorOrder(players);
  assert.deepEqual(
    players.map(p => p.color),
    ['red', 'green', 'yellow', 'blue']
  );
});
