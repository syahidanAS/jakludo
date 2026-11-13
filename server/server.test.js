// Integration test lewat socket sungguhan. Data disimpan di folder sementara.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jakludo-test-'));
process.env.JAKLUDO_DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';

const { io: ioClient } = require('socket.io-client');
const { server, rooms, shutdown } = require('./index');
const db = require('./db');

let url;
const clients = [];

test.before(async () => {
  await new Promise(resolve => server.listen(0, resolve));
  url = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  clients.forEach(c => c.close());
  shutdown();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function connect() {
  const c = ioClient(url, { forceNew: true, transports: ['websocket'] });
  clients.push(c);
  return new Promise(resolve => c.on('connect', () => resolve(c)));
}

function once(c, event) {
  return new Promise(resolve => c.once(event, resolve));
}

const wait = ms => new Promise(r => setTimeout(r, ms));

async function register(username) {
  const res = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'Rahasia#123', name: username })
  });
  return res.json();
}

async function createRoomWith(names) {
  const sockets = [];
  const host = await connect();
  host.emit('room:create', { name: names[0] });
  const joined = await once(host, 'room:joined');
  sockets.push({ socket: host, ...joined });
  for (const name of names.slice(1)) {
    const c = await connect();
    c.emit('room:join', { code: joined.code, name });
    sockets.push({ socket: c, ...(await once(c, 'room:joined')) });
  }
  return { code: joined.code, sockets, room: rooms.get(joined.code) };
}

test('payload kosong / rusak tidak menjatuhkan server', async () => {
  const c = await connect();
  for (const ev of ['game:move', 'room:update_settings', 'game:use_skill', 'game:use_force_return', 'game:use_item', 'game:reaction', 'room:chat', 'room:join', 'room:leave']) {
    c.emit(ev);
    c.emit(ev, null);
    c.emit(ev, 'string');
  }
  c.emit('room:check_active');
  await wait(150);
  const res = await fetch(`${url}/health`);
  assert.equal(res.status, 200);
});

test('menyerah saat giliran sendiri tidak crash dan giliran berpindah', async () => {
  const { sockets, room } = await createRoomWith(['A', 'B', 'C']);
  const [a] = sockets;
  a.socket.emit('game:start');
  await wait(100);
  assert.equal(room.started, true);
  assert.equal(room.turn, 0);
  a.socket.emit('room:leave', {});
  await wait(100);
  assert.equal(room.players[0].isOut, true);
  assert.equal(room.turn, 1);
});

test('warna tidak dobel setelah pemain keluar dari lobby', async () => {
  const { code, sockets, room } = await createRoomWith(['A', 'B', 'C']);
  sockets[1].socket.emit('room:leave', {});
  await wait(80);
  const d = await connect();
  d.emit('room:join', { code, name: 'D' });
  await once(d, 'room:joined');
  const colors = room.players.map(p => p.color);
  assert.equal(new Set(colors).size, colors.length, `warna dobel: ${colors}`);
});

test('pemain lain tidak bisa mengambil alih kursi dengan nama yang sama', async () => {
  const { code, sockets, room } = await createRoomWith(['Pemain', 'Pemain']);
  assert.equal(room.players.length, 2);
  assert.notEqual(sockets[0].playerId, sockets[1].playerId);

  // sessionId tidak boleh ikut disiarkan
  const update = await new Promise(resolve => {
    sockets[0].socket.once('room:update', resolve);
    sockets[0].socket.emit('room:add_bot');
  });
  assert.ok(update.players.every(p => p.sessionId === undefined));

  // Reconnect sah dengan sessionId rahasia mempertahankan kursi
  const again = await connect();
  again.emit('room:join', { code, sessionId: sockets[1].sessionId, name: 'x' });
  const rejoined = await once(again, 'room:joined');
  assert.equal(rejoined.reconnected, true);
  assert.equal(room.players.length, 3);
});

test('restart hanya setelah ada pemenang dan mereset state pemain', async () => {
  const { sockets, room } = await createRoomWith(['A', 'B']);
  const host = sockets[0].socket;
  host.emit('game:start');
  await wait(50);
  host.emit('game:restart');
  await wait(50);
  assert.equal(room.winner, null);

  room.players[0].items.forceReturn = { owned: 0, earned: 2, state: { note: 'x' } };
  host.emit('game:start'); // start ulang di tengah game harus ditolak
  await wait(50);
  assert.equal(room.players[0].items.forceReturn.earned, 2);

  room.winner = room.players[1].id;
  host.emit('game:restart');
  await wait(80);
  assert.equal(room.winner, null);
  assert.equal(room.players[0].items.forceReturn.earned, 0, 'item hasil pertandingan hilang saat main lagi');
  assert.deepEqual(room.players[0].items.forceReturn.state, {});
  assert.deepEqual(room.pawns[room.players[0].id], [0, 0, 0, 0]);
});

test('chat dikirim sebagai event terpisah dan dibatasi kecepatannya', async () => {
  const { sockets } = await createRoomWith(['A', 'B']);
  const received = [];
  sockets[1].socket.on('room:chat_message', m => received.push(m.text));
  for (let i = 0; i < 8; i++) sockets[0].socket.emit('room:chat', { text: `halo ${i}` });
  await wait(150);
  assert.equal(received.length, 5);
});

test('menang melawan bot tidak memberi poin; hanya akun terdaftar yang dicatat', async () => {
  const u1 = await register('pemain_satu');
  const u2 = await register('pemain_dua');
  assert.equal(u1.success, true);
  const before = db.getLeaderboard().find(e => e.userId === u1.user.id).points;

  db.recordMatchResult({ winnerPlayerId: 'p1', players: [{ id: 'p1', userId: u1.user.id }, { id: 'bot', isBot: true }] });
  assert.equal(db.getLeaderboard().find(e => e.userId === u1.user.id).points, before);

  db.recordMatchResult({ winnerPlayerId: 'p1', players: [{ id: 'p1', userId: u1.user.id }, { id: 'p2', userId: u2.user.id }, { id: 'g', name: 'tamu' }] });
  const board = db.getLeaderboard();
  assert.equal(board.find(e => e.userId === u1.user.id).points, before + 30 + 5, 'peringkat 1 + bonus harian pertama');
  assert.ok(!board.some(e => e.username === 'tamu'));
});

test('logout menghapus sesi dan login dibatasi', async () => {
  const u = await register('pemain_tiga');
  const me = () => fetch(`${url}/api/auth/me`, { headers: { Authorization: `Bearer ${u.token}` } });
  assert.equal((await me()).status, 200);
  await fetch(`${url}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${u.token}` } });
  assert.equal((await me()).status, 401);

  // Batas login 20 percobaan per 10 menit (server/http/routes.js), percobaan ke-21 ditolak
  let last;
  for (let i = 0; i < 21; i++) {
    last = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'pemain_tiga', password: 'salah' })
    });
  }
  assert.equal(last.status, 429);
});

test('endpoint /api yang tidak ada mengembalikan 404 JSON', async () => {
  const res = await fetch(`${url}/api/tidak-ada`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).success, false);
});

test('memakan bidak lawan di petak Black Hole tetap memberi bonus giliran', async () => {
  const { sockets, room } = await createRoomWith(['A', 'B']);
  const a = sockets[0].socket;
  a.emit('room:update_settings', { blackHole: true });
  await wait(30);
  a.emit('game:start');
  await wait(80);
  clearTimeout(room.turnTimer);
  const [pa, pb] = room.players;
  // Merah val 2 + 3 = val 5 -> track 4 (Black Hole). Hijau val 35 -> track (10 + 34) % 40 = 4.
  room.pawns[pa.id] = [2, 0, 0, 0];
  room.pawns[pb.id] = [35, 0, 0, 0];
  room.dice = 3;
  a.emit('game:move', { pawn: 0 });
  await wait(3 * 220 + 600);
  assert.equal(room.pawns[pb.id][0], 0, 'bidak lawan harus kembali ke markas');
  assert.equal(room.turn, 0, 'pemain yang memakan harus mendapat giliran lagi');
  assert.equal(room.dice, null);
  assert.equal(pa.diceStats.captureStreak, 1, 'rantai makan tercatat untuk peredam dadu');
});

test('koneksi putus di lobby tidak langsung menghapus kursi', async () => {
  const { code, sockets, room } = await createRoomWith(['A', 'B']);
  const colorB = room.players[1].color;
  sockets[1].socket.disconnect();
  await wait(80);
  assert.equal(room.players.length, 2);
  assert.equal(room.players[1].connected, false);

  const again = await connect();
  again.emit('room:join', { code, sessionId: sockets[1].sessionId, name: 'B' });
  const rejoined = await once(again, 'room:joined');
  assert.equal(rejoined.reconnected, true);
  assert.equal(room.players[1].connected, true);
  assert.equal(room.players[1].color, colorB);
});

test('pemain yang terputus di tengah giliran tidak langsung dimainkan sistem', async () => {
  const { code, sockets, room } = await createRoomWith(['A', 'B']);
  sockets[0].socket.emit('game:start');
  await wait(80);
  sockets[0].socket.disconnect(); // giliran A, lalu sinyal putus
  await wait(2500);
  assert.equal(room.players[0].autoPlayCount, 0, 'auto-play tidak boleh langsung mengambil giliran');
  assert.equal(room.dice, null);

  const again = await connect();
  again.emit('room:join', { code, sessionId: sockets[0].sessionId, name: 'A' });
  await once(again, 'room:joined');
  again.emit('game:roll');
  await wait(900);
  assert.notEqual(room.dice, null, 'pemain bisa melempar dadu sendiri setelah tersambung ulang');
  assert.equal(room.players[0].autoPlayCount, 0);
});

test('room aktif muncul di daftar pembuatnya dan kursinya ditahan saat terputus', async () => {
  const u = await register('pembuat_room');
  const others = await register('teman_main');
  const host = await connect();
  host.emit('room:create', { token: u.token });
  const { code } = await once(host, 'room:joined');
  const friend = await connect();
  friend.emit('room:join', { code, token: others.token });
  await once(friend, 'room:joined');
  const room = rooms.get(code);

  host.disconnect();
  await wait(100);
  assert.equal(room.players.length, 2, 'kursi pembuat room tetap ada');
  assert.equal(room.lobbyRemovals.size, 0, 'kursi pembuat room tidak dijadwalkan dilepas');

  const res = await fetch(`${url}/api/rooms/active`, { headers: { Authorization: `Bearer ${u.token}` } });
  const body = await res.json();
  const listed = body.rooms.find(r => r.code === code);
  assert.ok(listed, 'room tampil di daftar room aktif');
  assert.equal(listed.isCreator, true);

  const back = await connect();
  back.emit('room:join', { code, token: u.token });
  const rejoined = await once(back, 'room:joined');
  assert.equal(rejoined.reconnected, true);
  assert.equal(room.host, back.id, 'pembuat room kembali menjadi host');
});

test('lobby yang ditinggal semua pemain tetap ada (dijadwalkan dihapus setelah 5 menit)', async () => {
  const { code, sockets, room } = await createRoomWith(['Solo']);
  sockets[0].socket.disconnect();
  await wait(100);
  assert.equal(rooms.get(code), room, 'room tidak langsung dihapus');
  assert.ok(room.cleanupTimer, 'penghapusan dijadwalkan');
});

test('data JSON lama dipindahkan saat pertama kali start', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jakludo-migrate-'));
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([
    { id: 'u1', username: 'lama', name: 'Lama', passwordHash: 'scrypt:a:b', authType: 'password', inventory: { blackholeShield: 2, forceReturn: 1 } }
  ]));
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({ tok123: { userId: 'u1', createdAt: Date.now(), expiresAt: Date.now() + 60000 } }));
  fs.writeFileSync(path.join(dir, 'leaderboard.json'), JSON.stringify([{ userId: 'u1', username: 'lama', name: 'Lama', wins: 3, matchesPlayed: 4, points: 90, authType: 'password' }]));

  const { spawnSync } = require('child_process');
  const script = `const db = require('./server/db');
    const u = db.getUserByToken('tok123');
    console.log(JSON.stringify({ name: u && u.name, inv: u && u.inventory, entry: db.getLeaderboard().find(e => e.userId === 'u1') }));
    db.close();`;
  const r = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, JAKLUDO_DATA_DIR: dir, DATABASE_URL: '' }, encoding: 'utf8'
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.name, 'Lama');
  assert.deepEqual(out.inv, { blackholeShield: 2, forceReturn: 1 });
  assert.equal(out.entry.points, 90);
  assert.ok(fs.readdirSync(dir).some(f => f.startsWith('users.json.migrated-')), 'file JSON lama diberi tanda migrated');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('file JSON lama yang rusak menghentikan migrasi tanpa menghapus data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jakludo-corrupt-'));
  fs.writeFileSync(path.join(dir, 'users.json'), '[{"id": "u1", ');
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, ['-e', "require('./server/db')"], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, JAKLUDO_DATA_DIR: dir }, encoding: 'utf8'
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /DB FATAL/);
  assert.equal(fs.readFileSync(path.join(dir, 'users.json'), 'utf8'), '[{"id": "u1", ');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('room dan data pemain tetap ada setelah server restart', async () => {
  const { spawn } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jakludo-restart-'));
  const start = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/index.js'], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, JAKLUDO_DATA_DIR: dir, PORT: '0' }
    });
    child.stdout.on('data', d => {
      const m = String(d).match(/listening on (\d+)/);
      if (m) resolve({ child, url: `http://localhost:${m[1]}` });
    });
    child.on('error', reject);
  });
  const stop = child => new Promise(resolve => { child.on('exit', resolve); child.kill('SIGTERM'); });
  const client = u => {
    const c = ioClient(u, { forceNew: true, transports: ['websocket'] });
    clients.push(c);
    return new Promise(resolve => c.on('connect', () => resolve(c)));
  };
  const reg = (u, username) => fetch(`${u}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'Rahasia#123' })
  }).then(r => r.json());

  let srv = await start();
  const restartUser = 'tahan_' + Date.now().toString(36).slice(-6);
  const a = await reg(srv.url, restartUser);
  assert.ok(a.token, 'Token pendaftaran harus tersedia: ' + JSON.stringify(a));
  const host = await client(srv.url);
  host.emit('room:create', { token: a.token });
  const { code } = await once(host, 'room:joined');
  host.emit('room:add_bot');
  await wait(500);
  host.close();
  await stop(srv.child);

  srv = await start();
  const me = await fetch(`${srv.url}/api/auth/me`, { headers: { Authorization: `Bearer ${a.token}` } });
  assert.equal(me.status, 200, 'token login tetap berlaku setelah restart');
  const back = await client(srv.url);
  back.emit('room:join', { code, token: a.token });
  const rejoined = await once(back, 'room:joined');
  assert.equal(rejoined.reconnected, true, 'kembali ke kursi lama di room yang sama');
  const update = await once(back, 'room:update');
  assert.equal(update.players.length, 2);
  back.close();
  await stop(srv.child);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('dapat 6 tanpa langkah yang mungkin tetap mendapat lemparan bonus', async () => {
  const { sockets, room } = await createRoomWith(['A', 'B']);
  const a = sockets[0].socket;
  a.emit('game:start');
  await wait(80);
  clearTimeout(room.turnTimer);
  const pa = room.players[0];
  // Tiga bidak finish, satu di jalur finish (val 41): angka 6 melewati finish
  room.pawns[pa.id] = [41, 44, 44, 44];
  const crypto = require('crypto');
  const original = crypto.randomInt;
  crypto.randomInt = max => max - 1; // angka acak tertinggi -> dadu = 6
  try {
    a.emit('game:roll');
    await wait(750 + 1300 + 300);
  } finally {
    crypto.randomInt = original;
  }
  assert.equal(room.turn, 0, 'giliran tetap milik pemain yang dapat 6');
  assert.equal(room.dice, null, 'boleh melempar lagi');
});

test('langkah otomatis pemain AFK memakai pertimbangan bot, bukan bidak pertama', async () => {
  const engine = require('./game/engine');
  const { sockets, room } = await createRoomWith(['A', 'B']);
  sockets[0].socket.emit('game:start');
  await wait(80);
  clearTimeout(room.turnTimer);
  const [pa, pb] = room.players;
  // Dadu 2: bidak 0 (val 3) akan mendarat tepat di depan bidak hijau -> berisiko; bidak 1 (val 20) aman
  room.pawns[pa.id] = [3, 20, 0, 0];
  room.pawns[pb.id] = [32, 0, 0, 0];
  room.dice = 2;
  engine.executeAutoPlay(room, pa);
  await wait(2500);
  clearTimeout(room.turnTimer);
  assert.deepEqual(room.pawns[pa.id].slice(0, 2), [3, 22], 'bidak yang aman yang dijalankan');
  assert.equal(pa.autoPlayCount, 1);
});

test('catatan dadu pemain tersimpan di server tapi tidak dikirim ke klien', async () => {
  const { sockets, room } = await createRoomWith(['A', 'B']);
  const a = sockets[0].socket;
  a.emit('game:start');
  await wait(80);
  clearTimeout(room.turnTimer);
  const update = new Promise(resolve => a.on('room:update', r => r.dice !== null && resolve(r)));
  a.emit('game:roll');
  const pub = await update;
  clearTimeout(room.turnTimer);
  assert.equal(room.players[0].diceStats.total, 1);
  assert.equal(pub.players[0].diceStats, undefined);
});

test('hitung mundur giliran dikirim ke klien dan hilang saat pemain bertindak', async () => {
  const { sockets, room } = await createRoomWith(['A', 'B']);
  const a = sockets[0].socket;
  const withClock = new Promise(resolve => a.on('room:update', r => r.turnClock && resolve(r)));
  a.emit('game:start');
  const pub = await withClock;
  assert.equal(pub.turnClock.playerId, room.players[0].id);
  assert.equal(pub.turnClock.totalMs, 15000);
  assert.ok(pub.turnClock.remainingMs > 14000 && pub.turnClock.remainingMs <= 15000);
  assert.equal(pub.turnClock.endsAt, undefined, 'jam server tidak dikirim, cukup sisa waktunya');

  a.emit('game:roll');
  await wait(50);
  assert.equal(room.turnClock, null, 'jam berhenti begitu dadu dilempar');
  clearTimeout(room.turnTimer);
});

test('pemain diberi tahu saat room ditutup karena semua pemain manusia OUT', async () => {
  const { sockets, room } = await createRoomWith(['A']);
  const a = sockets[0].socket;
  a.emit('room:add_bot');
  await wait(50);
  a.emit('game:start');
  await wait(80);
  clearTimeout(room.turnTimer);
  const closed = new Promise(resolve => a.once('room:closed', resolve));
  room.players[0].autoPlayCount = 3; // sudah 3x tidak jalan
  require('./game/engine').executeAutoPlay(room, room.players[0]);
  const msg = await closed;
  assert.equal(msg.code, room.code);
  assert.match(msg.reason, /OUT/);
  assert.equal(rooms.has(room.code), false);
});

test('poin akhir mengikuti peringkat dan jumlah pemain', async () => {
  const users = [await register('rank_satu'), await register('rank_dua'), await register('rank_tiga'), await register('rank_empat')];
  const pts = u => db.getLeaderboard().find(e => e.userId === u.user.id).points;
  const before = users.map(pts);
  const players = users.map((u, i) => ({ id: 'r' + i, userId: u.user.id }));

  db.recordMatchResult({ winnerPlayerId: 'r2', players, ranking: ['r2', 'r0', 'r3', 'r1'] });
  // Termasuk bonus harian +5 karena ini permainan pertama mereka hari ini
  assert.deepEqual(users.map((u, i) => pts(u) - before[i]), [25, 10, 35, 20]);

  // Dua pemain: yang kalah hanya dapat 5 (bonus harian sudah diambil)
  const mid = users.map(pts);
  db.recordMatchResult({ winnerPlayerId: 'r0', players: players.slice(0, 2) });
  assert.deepEqual([pts(users[0]) - mid[0], pts(users[1]) - mid[1]], [30, 5]);
});

test('bonus harian 5 poin hanya sekali per hari (WIB) dan tidak untuk pemain OUT', async () => {
  const a = await register('harian_a');
  const b = await register('harian_b');
  const pts = u => db.getLeaderboard().find(e => e.userId === u.user.id).points;
  const day1 = Date.UTC(2030, 0, 1, 10, 0); // 1 Jan 17.00 WIB
  const players = [{ id: 'a', userId: a.user.id }, { id: 'b', userId: b.user.id, isOut: true }];

  const before = [pts(a), pts(b)];
  const awards = db.recordMatchResult({ winnerPlayerId: 'a', players, now: day1 });
  assert.deepEqual(awards, { a: { points: 30, dailyBonus: 5 }, b: { points: 5, dailyBonus: 0 } });
  assert.deepEqual([pts(a) - before[0], pts(b) - before[1]], [35, 5]);

  // Masih hari yang sama (23.30 WIB): tidak dapat bonus lagi
  const again = db.recordMatchResult({ winnerPlayerId: 'a', players, now: day1 + 6.5 * 3600 * 1000 });
  assert.equal(again.a.dailyBonus, 0);

  // Lewat tengah malam WIB (00.30 WIB = 17.30 UTC hari sebelumnya): dapat bonus lagi
  const nextDay = db.recordMatchResult({ winnerPlayerId: 'a', players, now: day1 + 7.5 * 3600 * 1000 });
  assert.equal(nextDay.a.dailyBonus, 5);
});

test('lemparan 6, 6, lalu 1 tidak kena hangus 3x angka 6 dan bidak tetap bisa jalan', async () => {
  const { sockets, room } = await createRoomWith(['A', 'B']);
  const a = sockets[0].socket;
  a.emit('game:start');
  await wait(80);
  clearTimeout(room.turnTimer);
  const pa = room.players[0];
  const crypto = require('crypto');
  const original = crypto.randomInt;
  // Angka acak tertinggi -> dadu 6, terendah -> dadu 1
  const rollAs = face => { crypto.randomInt = max => (face === 6 ? max - 1 : 0); };
  const roll = async face => {
    rollAs(face);
    a.emit('game:roll');
    await wait(900);
    clearTimeout(room.turnTimer);
  };
  const move = async pawn => {
    a.emit('game:move', { pawn });
    await wait(1800);
    clearTimeout(room.turnTimer);
  };
  try {
    await roll(6);
    assert.equal(room.dice, 6);
    await move(0); // keluar markas
    await roll(6);
    assert.equal(room.dice, 6);
    await move(0); // 1 -> 7
    await roll(1);
    assert.equal(room.dice, 1, 'angka 1 keluar, bukan giliran hangus');
    assert.equal(room.turn, 0, 'giliran masih milik pemain yang melempar');
    assert.equal(room.consecutiveSixes, 0);
    assert.ok(require('./game/store').publicRoom(room).movable.length > 0, 'ada bidak yang bisa jalan');
    await move(0); // 7 -> 8
    assert.equal(room.pawns[pa.id][0], 8, 'bidak benar-benar jalan');
    assert.equal(room.turn, 1, 'setelah angka 1, giliran pindah');
  } finally {
    crypto.randomInt = original;
  }
});

test('6 tiga kali berturut-turut: giliran hangus dan bidak tidak jalan', async () => {
  const { sockets, room } = await createRoomWith(['A', 'B']);
  const a = sockets[0].socket;
  a.emit('game:start');
  await wait(80);
  clearTimeout(room.turnTimer);
  const pa = room.players[0];
  const crypto = require('crypto');
  const original = crypto.randomInt;
  crypto.randomInt = max => max - 1; // selalu dadu 6
  const roll = async () => {
    a.emit('game:roll');
    await wait(900);
    clearTimeout(room.turnTimer);
  };
  try {
    await roll();
    a.emit('game:move', { pawn: 0 }); // keluar markas
    await wait(1800);
    clearTimeout(room.turnTimer);
    await roll();
    a.emit('game:move', { pawn: 0 }); // 1 -> 7
    await wait(1800);
    clearTimeout(room.turnTimer);
    await roll(); // 6 yang ketiga: hangus

    assert.equal(room.turn, 1, 'giliran langsung pindah');
    assert.equal(room.pawns[pa.id][0], 7, 'bidak tidak jalan');
    assert.match(room.history[0].text, /3x berturut-turut/);
  } finally {
    crypto.randomInt = original;
    clearTimeout(room.turnTimer);
  }
});

test('Google Auth: GET /api/auth/google/config mengembalikan status konfigurasi', async () => {
  const res = await fetch(`${url}/api/auth/google/config`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(typeof body.enabled, 'boolean');
  assert.equal(typeof body.clientId, 'string');
});

test('Google Auth: POST /api/auth/google menolak jika tanpa kredensial', async () => {
  const res = await fetch(`${url}/api/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.success, false);
});

test('Google Auth: pendaftaran user baru via Google ID Token simulasi', async () => {
  const googleId = 'gid_' + Date.now();
  const mockToken = 'mock_google_token_' + Buffer.from(JSON.stringify({
    sub: googleId,
    email: `google_${Date.now()}@gmail.com`,
    name: 'Budi Google',
    picture: 'https://example.com/budi.jpg'
  })).toString('base64');

  const res = await fetch(`${url}/api/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential: mockToken })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.ok(body.token);
  assert.equal(body.user.name, 'Budi Google');
  assert.equal(body.user.authType, 'google');
  assert.equal(body.isNewUser, true);

  // Verifikasi sesi aktif
  const meRes = await fetch(`${url}/api/auth/me`, {
    headers: { Authorization: `Bearer ${body.token}` }
  });
  assert.equal(meRes.status, 200);
  const meBody = await meRes.json();
  assert.equal(meBody.user.id, body.user.id);
  assert.equal(meBody.user.authType, 'google');

  // Login ulang dengan kredensial yang sama mengembalikan akun yang sama (bukan akun ganda)
  const reLoginRes = await fetch(`${url}/api/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential: mockToken })
  });
  assert.equal(reLoginRes.status, 200);
  const reLoginBody = await reLoginRes.json();
  assert.equal(reLoginBody.user.id, body.user.id);
  assert.equal(reLoginBody.isNewUser, false);
});

test('Google Auth: linking akun saat email Google cocok dengan akun terdaftar', async () => {
  const sharedEmail = `link_${Date.now()}@gmail.com`;
  // Daftarkan dulu akun biasa
  const regRes = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: `linkuser_${Date.now().toString(36)}`.slice(0, 20),
      password: 'Password#123',
      name: 'User Akun Biasa'
    })
  });
  const regBody = await regRes.json();
  assert.equal(regRes.status, 200);

  // Set email pada akun tersebut di database
  db.updateUserEmail(regBody.user.id, sharedEmail);

  // Login via Google dengan email yang sama
  const googleId = 'gid_link_' + Date.now();
  const mockToken = 'mock_google_token_' + Buffer.from(JSON.stringify({
    sub: googleId,
    email: sharedEmail,
    name: 'User Akun Biasa (Google)'
  })).toString('base64');

  const gRes = await fetch(`${url}/api/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential: mockToken })
  });
  assert.equal(gRes.status, 200);
  const gBody = await gRes.json();
  // Harus tertaut ke akun yang sudah ada
  assert.equal(gBody.user.id, regBody.user.id);
});

test('Update profil: nama, username, email, dan password', async () => {
  const ts = Date.now().toString(36);
  const origUsername = `up_${ts}`.slice(0, 18);
  const newUsername = `up2_${ts}`.slice(0, 18);
  const oldPassword = 'OldPassword#123';
  const newPassword = 'NewPassword#456';
  const testEmail = `user_${ts}@example.com`;

  // 1. Daftarkan user
  const regRes = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: origUsername,
      password: oldPassword,
      name: 'Nama Awal'
    })
  });
  assert.equal(regRes.status, 200);
  const { user, token } = await regRes.json();

  // 2. Update nama dan username
  const updateRes1 = await fetch(`${url}/api/auth/profile`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      name: 'Nama Baru Super',
      username: newUsername,
      email: testEmail
    })
  });
  assert.equal(updateRes1.status, 200);
  const body1 = await updateRes1.json();
  assert.equal(body1.success, true);
  assert.equal(body1.user.name, 'Nama Baru Super');
  assert.equal(body1.user.username, newUsername);
  assert.equal(body1.user.email, testEmail);

  // 3. Verifikasi melalui GET /api/auth/me
  const meRes = await fetch(`${url}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const meBody = await meRes.json();
  assert.equal(meBody.user.name, 'Nama Baru Super');
  assert.equal(meBody.user.username, newUsername);
  assert.equal(meBody.user.email, testEmail);

  // 4. Update password dengan password lama yang salah -> harus ditolak
  const badPassRes = await fetch(`${url}/api/auth/profile`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      currentPassword: 'WrongPassword',
      newPassword: newPassword
    })
  });
  assert.equal(badPassRes.status, 400);

  // 5. Update password dengan password lama yang benar -> harus berhasil
  const goodPassRes = await fetch(`${url}/api/auth/profile`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      currentPassword: oldPassword,
      newPassword: newPassword
    })
  });
  assert.equal(goodPassRes.status, 200);

  // 6. Coba login dengan password lama -> harus gagal
  const failLogin = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: newUsername, password: oldPassword })
  });
  assert.equal(failLogin.status, 400);

  // 7. Coba login dengan password baru dan username baru -> harus berhasil!
  const successLogin = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: newUsername, password: newPassword })
  });
  assert.equal(successLogin.status, 200);
  const loginBody = await successLogin.json();
  assert.equal(loginBody.user.id, user.id);
});

test('topup diamonds dengan midtrans snap popup (config, snapToken, verify, notification, simulate, points award)', async () => {
  // 1. GET /api/topup/config
  const cfgRes = await fetch(`${url}/api/topup/config`);
  assert.equal(cfgRes.status, 200);
  const cfg = await cfgRes.json();
  assert.equal(cfg.success, true);
  assert.equal(cfg.gateway, 'midtrans_snap');
  assert.equal(cfg.packages.length, 6);
  assert.ok(cfg.snapJsUrl);

  const p50 = cfg.packages.find(p => p.diamonds === 50);
  const p120 = cfg.packages.find(p => p.diamonds === 120);
  const p260 = cfg.packages.find(p => p.diamonds === 260);
  const p700 = cfg.packages.find(p => p.diamonds === 700);
  const p1500 = cfg.packages.find(p => p.diamonds === 1500);
  const p3250 = cfg.packages.find(p => p.diamonds === 3250);

  assert.ok(p50, 'Paket 50 diamond harus ada');
  assert.equal(p50.price, 5000, '50 diamonds = Rp 5.000');
  assert.ok(p120, 'Paket 120 diamond harus ada');
  assert.equal(p120.price, 10000, '120 diamonds = Rp 10.000');
  assert.equal(p120.badge, 'Populer');
  assert.ok(p260, 'Paket 260 diamond harus ada');
  assert.equal(p260.price, 20000, '260 diamonds = Rp 20.000');
  assert.ok(p700, 'Paket 700 diamond harus ada');
  assert.equal(p700.price, 50000, '700 diamonds = Rp 50.000');
  assert.equal(p700.badge, 'Bonus 100');
  assert.ok(p1500, 'Paket 1.500 diamond harus ada');
  assert.equal(p1500.price, 100000, '1.500 diamonds = Rp 100.000');
  assert.equal(p1500.badge, 'Bonus 250');
  assert.ok(p3250, 'Paket 3.250 diamond harus ada');
  assert.equal(p3250.price, 200000, '3.250 diamonds = Rp 200.000');
  assert.equal(p3250.badge, 'Bonus 750');

  // 2. Register user untuk topup
  const topupUser = 'tp_' + Math.random().toString(36).slice(2, 8);
  const reg = await register(topupUser);
  const token = reg.token;
  const initialPoints = reg.user.points; // default starter points (200)

  // 3. Create Snap transaction untuk paket 120 diamonds
  const snapRes = await fetch(`${url}/api/topup/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ packageId: 'diamond_120' })
  });
  assert.equal(snapRes.status, 200);
  const snapBody = await snapRes.json();
  assert.equal(snapBody.success, true);
  assert.ok(snapBody.orderId);
  assert.ok(snapBody.snapToken || snapBody.token);
  assert.equal(snapBody.package.diamonds, 120);

  // 4. Simulasi pembayaran topup (simulate)
  const simRes = await fetch(`${url}/api/topup/simulate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ orderId: snapBody.orderId })
  });
  assert.equal(simRes.status, 200);
  const simBody = await simRes.json();
  assert.equal(simBody.success, true);
  assert.equal(simBody.diamondsAwarded, 120);
  assert.equal(simBody.user.points, initialPoints + 120);

  // 5. Cek verify endpoint
  const verifyRes = await fetch(`${url}/api/topup/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ orderId: snapBody.orderId })
  });
  assert.equal(verifyRes.status, 200);
  const verifyBody = await verifyRes.json();
  assert.equal(verifyBody.success, true);
  assert.equal(verifyBody.status, 'success');
  assert.equal(verifyBody.user.points, initialPoints + 120);

  // 6. Test paket 3.250 diamonds (Paket Sultan)
  const sultanRes = await fetch(`${url}/api/topup/charge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ packageId: 'diamond_3250' })
  });
  const sultanBody = await sultanRes.json();
  assert.equal(sultanBody.success, true);
  assert.ok(sultanBody.snapToken || sultanBody.token);

  const simSultanRes = await fetch(`${url}/api/topup/simulate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ orderId: sultanBody.orderId })
  });
  const simSultanBody = await simSultanRes.json();
  assert.equal(simSultanBody.diamondsAwarded, 3250);
  assert.equal(simSultanBody.user.points, initialPoints + 120 + 3250);

  // 7. Test Webhook Notifikasi Midtrans untuk paket 260 diamonds
  const notifOrderRes = await fetch(`${url}/api/topup/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ packageId: 'diamond_260' })
  });
  const notifOrderBody = await notifOrderRes.json();
  assert.equal(notifOrderBody.success, true);

  const midtransNotifRes = await fetch(`${url}/api/topup/notification`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      order_id: notifOrderBody.orderId,
      gross_amount: '20000.00',
      status_code: '200',
      transaction_status: 'settlement',
      payment_type: 'gopay'
    })
  });
  assert.equal(midtransNotifRes.status, 200);

  const finalUserRes = await fetch(`${url}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const finalUserData = await finalUserRes.json();
  assert.equal(finalUserData.user.points, initialPoints + 120 + 3250 + 260);
});
