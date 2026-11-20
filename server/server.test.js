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
    body: JSON.stringify({ username, email: `${username}@playgo.test`, password: 'Rahasia#123', name: username })
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
    body: JSON.stringify({ username, email: `${username}@playgo.test`, password: 'Rahasia#123' })
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
      email: `link_init_${Date.now()}@playgo.test`,
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
      email: `init_${origUsername}@playgo.test`,
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

test('Google reCAPTCHA v3: config endpoint dan verifikasi token login / register', async () => {
  // 1. GET /api/auth/recaptcha/config
  const cfgRes = await fetch(`${url}/api/auth/recaptcha/config`);
  assert.equal(cfgRes.status, 200);
  const cfg = await cfgRes.json();
  assert.equal(cfg.success, true);
  assert.equal(typeof cfg.enabled, 'boolean');

  // 2. Register dengan mock recaptchaToken
  const testUser = 'rc_' + Math.random().toString(36).slice(2, 8);
  const regRes = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: testUser,
      email: `${testUser}@playgo.test`,
      password: 'StrongPassword123!',
      name: 'User Recaptcha',
      recaptchaToken: 'mock_recaptcha_token'
    })
  });
  assert.equal(regRes.status, 200);
  const regBody = await regRes.json();
  assert.equal(regBody.success, true);
  assert.equal(regBody.user.username, testUser);

  // 3. Login dengan mock recaptchaToken
  const loginRes = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: testUser,
      password: 'StrongPassword123!',
      recaptchaToken: 'mock_recaptcha_token'
    })
  });
  assert.equal(loginRes.status, 200);
  const loginBody = await loginRes.json();
  assert.equal(loginBody.success, true);
  assert.equal(loginBody.user.id, regBody.user.id);
});

test('topup diamonds multi-gateway (switch DOKU <-> Duitku di .env, webhook verify & points award)', async () => {
  const prevEnv = {
    PAYMENT_GATEWAY: process.env.PAYMENT_GATEWAY,
    DOKU_CLIENT_ID: process.env.DOKU_CLIENT_ID,
    DOKU_SECRET_KEY: process.env.DOKU_SECRET_KEY,
    DOKU_MERCHANT_CODE: process.env.DOKU_MERCHANT_CODE
  };

  try {
    // A. Pastikan default / PAYMENT_GATEWAY=doku aktif dengan DOKU
    process.env.PAYMENT_GATEWAY = 'doku';
    const cfgRes = await fetch(`${url}/api/topup/config`);
    assert.equal(cfgRes.status, 200);
    const cfg = await cfgRes.json();
    assert.equal(cfg.success, true);
    assert.equal(cfg.gateway, 'doku');
    assert.equal(cfg.mode, 'direct_api');
    assert.equal(cfg.packages.length, 6);
    assert.ok(Array.isArray(cfg.paymentMethods) && cfg.paymentMethods.length === 6);
    assert.equal(cfg.popJsUrl, undefined);

    const p50 = cfg.packages.find(p => p.diamonds === 50);
    const p120 = cfg.packages.find(p => p.diamonds === 120);
    const p260 = cfg.packages.find(p => p.diamonds === 260);
    const p700 = cfg.packages.find(p => p.diamonds === 700);
    const p1500 = cfg.packages.find(p => p.diamonds === 1500);
    const p3250 = cfg.packages.find(p => p.diamonds === 3250);

    assert.ok(p50 && p50.price === 5000);
    assert.ok(p120 && p120.price === 10000 && p120.badge === 'Populer');
    assert.ok(p260 && p260.price === 20000);
    assert.ok(p700 && p700.price === 50000 && p700.badge === 'Bonus 100');
    assert.ok(p1500 && p1500.price === 100000 && p1500.badge === 'Bonus 250');
    assert.ok(p3250 && p3250.price === 200000 && p3250.badge === 'Bonus 750');

    // 2. Register user untuk topup
    const topupUser = 'tp_' + Math.random().toString(36).slice(2, 8);
    const reg = await register(topupUser);
    const token = reg.token;
    const initialPoints = reg.user.points;

    // 3. Create transaksi via DOKU (BCA VA)
    const dokuRes = await fetch(`${url}/api/topup/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ packageId: 'diamond_120', paymentMethod: 'BC' })
    });
    assert.equal(dokuRes.status, 200);
    const dokuBody = await dokuRes.json();
    assert.equal(dokuBody.success, true);
    assert.equal(dokuBody.gateway, 'doku');
    assert.ok(dokuBody.orderId);
    assert.ok(dokuBody.reference.startsWith('doku_ref_'));
    assert.equal(dokuBody.paymentMethod, 'BC');
    assert.ok(dokuBody.vaNumber);
    assert.equal(dokuBody.package.diamonds, 120);

    // 4. Simulasi pembayaran topup
    const simRes = await fetch(`${url}/api/topup/simulate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ orderId: dokuBody.orderId })
    });
    assert.equal(simRes.status, 200);
    const simBody = await simRes.json();
    assert.equal(simBody.diamondsAwarded, 120);
    assert.equal(simBody.user.points, initialPoints + 120);

    // 5. Cek verify endpoint
    const verifyRes = await fetch(`${url}/api/topup/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ orderId: dokuBody.orderId })
    });
    assert.equal(verifyRes.status, 200);
    const verifyBody = await verifyRes.json();
    assert.equal(verifyBody.status, 'success');
    assert.equal(verifyBody.user.points, initialPoints + 120);

    // 6. Webhook Notifikasi Resmi DOKU Jokul (HMACSHA256) untuk paket 3.250
    const dokuClientId = 'BRN-TEST-TOPUP';
    const dokuSecret = 'SK-TEST-TOPUP-SECRET';
    process.env.DOKU_CLIENT_ID = dokuClientId;
    process.env.DOKU_SECRET_KEY = dokuSecret;
    process.env.DOKU_MERCHANT_CODE = dokuClientId;

    const sultanRes = await fetch(`${url}/api/topup/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ packageId: 'diamond_3250', paymentMethod: 'SP' })
    });
    const sultanBody = await sultanRes.json();
    assert.equal(sultanBody.success, true);
    assert.equal(sultanBody.gateway, 'doku');

    const dokuLib = require('./lib/doku');
    const jokulPayloadObj = {
      order: { invoice_number: sultanBody.orderId, amount: 200000 },
      transaction: { status: 'SUCCESS', original_request_id: 'REQ-DOKU-SULTAN' },
      channel: { id: 'QRIS' }
    };
    const rawJokulBody = JSON.stringify(jokulPayloadObj);
    const reqId = 'req-srv-1';
    const reqTs = new Date().toISOString().slice(0, 19) + 'Z';
    const dokuSig = dokuLib.generateDokuSignature({
      clientId: dokuClientId,
      requestId: reqId,
      requestTimestamp: reqTs,
      requestTarget: '/api/topup/notification',
      digest: dokuLib.generateDigest(rawJokulBody),
      secretKey: dokuSecret
    });

    const dokuWebhookRes = await fetch(`${url}/api/topup/notification`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Client-Id': dokuClientId,
        'Request-Id': reqId,
        'Request-Timestamp': reqTs,
        Signature: dokuSig
      },
      body: rawJokulBody
    });
    assert.equal(dokuWebhookRes.status, 200);
    assert.equal(await dokuWebhookRes.text(), 'OK');

    // B. Switch gateway ke Duitku lewat env PAYMENT_GATEWAY=duitku
    process.env.PAYMENT_GATEWAY = 'duitku';
    const duitkuCfg = await (await fetch(`${url}/api/topup/config`)).json();
    assert.equal(duitkuCfg.gateway, 'duitku');

    const notifOrderRes = await fetch(`${url}/api/topup/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ packageId: 'diamond_260', paymentMethod: 'BC' })
    });
    const notifOrderBody = await notifOrderRes.json();
    assert.equal(notifOrderBody.success, true);
    assert.equal(notifOrderBody.gateway, 'duitku');

    const crypto = require('crypto');
    const mCode = duitkuCfg.merchantCode || 'DS37928';
    const mKey = process.env.DUITKU_API_KEY || '';
    const validSig = crypto.createHash('md5').update(`${mCode}20000${notifOrderBody.orderId}${mKey}`).digest('hex');

    const duitkuNotifRes = await fetch(`${url}/api/topup/notification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchantCode: mCode,
        merchantOrderId: notifOrderBody.orderId,
        amount: '20000',
        resultCode: '00',
        paymentMethod: 'BC',
        reference: 'mock_ref_123',
        signature: validSig
      })
    });
    assert.equal(duitkuNotifRes.status, 200);

    const finalUserRes = await fetch(`${url}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const finalUserData = await finalUserRes.json();
    assert.equal(finalUserData.user.points, initialPoints + 120 + 3250 + 260);

    // 7. Riwayat & pembatalan order Top-Up Coins via Payment Gateway
    const pendingCoinRes = await fetch(`${url}/api/topup/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ packageId: 'diamond_50', paymentMethod: 'I1' })
    });
    const pendingCoinBody = await pendingCoinRes.json();
    assert.equal(pendingCoinBody.success, true);

    const histRes = await fetch(`${url}/api/topup/history`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(histRes.status, 200);
    const histBody = await histRes.json();
    assert.equal(histBody.success, true);
    assert.ok(histBody.orders.some(o => o.orderId === pendingCoinBody.orderId && o.status === 'pending'));

    const cancelCoinRes = await fetch(`${url}/api/topup/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ orderId: pendingCoinBody.orderId })
    });
    assert.equal(cancelCoinRes.status, 200);
    const cancelCoinBody = await cancelCoinRes.json();
    assert.equal(cancelCoinBody.order.status, 'cancelled');
  } finally {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('GET /ads.txt mengembalikan text/plain dengan publisher Google AdSense', async () => {
  const res = await fetch(`${url}/ads.txt`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/plain/i);
  const body = await res.text();
  assert.equal(body.trim(), 'google.com, pub-9965100396262528, DIRECT, f08c47fec0942fa0');
});

test('SEO Global: robots.txt, sitemap.xml hreflang, dan SSR meta/JSON-LD untuk 4 game & multi-bahasa', async () => {
  // 1. /robots.txt
  const robotsRes = await fetch(`${url}/robots.txt`);
  assert.equal(robotsRes.status, 200);
  const robotsText = await robotsRes.text();
  assert.match(robotsText, /Allow: \/\?game=jakludo/);
  assert.match(robotsText, /Allow: \/\?game=chess-master/);
  assert.match(robotsText, /Allow: \/\?game=snakes-and-ladders/);
  assert.match(robotsText, /Allow: \/\?game=monster-quiz/);
  assert.match(robotsText, /Allow: \/\?hl=en/);
  assert.match(robotsText, /Allow: \/\?hl=id/);
  assert.match(robotsText, new RegExp(`Sitemap: ${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/sitemap\\.xml`));

  // 2. /sitemap.xml
  const sitemapRes = await fetch(`${url}/sitemap.xml`);
  assert.equal(sitemapRes.status, 200);
  assert.match(sitemapRes.headers.get('content-type') || '', /application\/xml/i);
  const sitemapXml = await sitemapRes.text();
  assert.match(sitemapXml, /xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml"/);
  for (const q of ['', '?game=jakludo', '?game=chess-master', '?game=snakes-and-ladders', '?game=monster-quiz']) {
    const baseLoc = `${url}/${q}`;
    assert.ok(sitemapXml.includes(`<loc>${baseLoc}</loc>`), `Sitemap harus memuat ${baseLoc}`);
    const sep = q ? '&amp;' : '?';
    assert.ok(sitemapXml.includes(`hreflang="x-default" href="${baseLoc}"`));
    assert.ok(sitemapXml.includes(`hreflang="en" href="${baseLoc}${sep}hl=en"`));
    assert.ok(sitemapXml.includes(`hreflang="id" href="${baseLoc}${sep}hl=id"`));
  }

  // 3. SSR Hub / (default global en)
  const hubHtml = await (await fetch(`${url}/`)).text();
  assert.match(hubHtml, /<html lang="en"/);
  assert.ok(hubHtml.includes(`<link rel="canonical" href="${url}/" />`));
  assert.ok(hubHtml.includes(`<link rel="alternate" hreflang="x-default" href="${url}/" />`));
  assert.ok(hubHtml.includes(`<link rel="alternate" hreflang="en" href="${url}/?hl=en" />`));
  assert.ok(hubHtml.includes(`<link rel="alternate" hreflang="id" href="${url}/?hl=id" />`));

  // Verifikasi JSON-LD valid dengan ke-4 game & URL absolut
  const jsonLdMatch = hubHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(jsonLdMatch, 'JSON-LD script harus ada');
  const jsonLd = JSON.parse(jsonLdMatch[1]);
  const graph = jsonLd['@graph'] || [];
  const org = graph.find(n => n['@type'] === 'Organization');
  assert.ok(org && org.url.startsWith(`${url}/`) && org.logo.startsWith(`${url}/playgo-logo.jpg`));
  const videoGameNames = graph.filter(n => n['@type'] === 'VideoGame').map(n => n.name);
  for (const expectedName of ['JakLudo', 'Monster Quiz Battle', 'Chess Master', 'Snakes and Ladders']) {
    assert.ok(videoGameNames.includes(expectedName), `JSON-LD harus memuat VideoGame ${expectedName}`);
  }
  assert.ok(graph.some(n => n['@type'] === 'ItemList' && n.numberOfItems === 4));
  assert.ok(graph.some(n => n['@type'] === 'FAQPage'));

  // 4. SSR Chess Master
  const chessHtml = await (await fetch(`${url}/?game=chess-master`)).text();
  assert.match(chessHtml, /<title>Chess Master \(Play Online Multiplayer Chess/);
  assert.ok(chessHtml.includes(`<link rel="canonical" href="${url}/?game=chess-master" />`));
  assert.ok(chessHtml.includes(`<link rel="alternate" hreflang="en" href="${url}/?game=chess-master&amp;hl=en" />`));

  // 5. SSR Snakes & Ladders (?hl=en)
  const snakesEnHtml = await (await fetch(`${url}/?game=snakes-and-ladders&hl=en`)).text();
  assert.match(snakesEnHtml, /<html lang="en"/);
  assert.match(snakesEnHtml, /<meta property="og:locale" content="en_US" \/>/);
  assert.match(snakesEnHtml, /<title>Snakes and Ladders Online Multiplayer/);
  assert.ok(snakesEnHtml.includes(`<link rel="canonical" href="${url}/?game=snakes-and-ladders&amp;hl=en" />`));

  // 6. SSR JakLudo (?hl=id)
  const ludoIdHtml = await (await fetch(`${url}/?game=jakludo&hl=id`)).text();
  assert.match(ludoIdHtml, /<html lang="id"/);
  assert.match(ludoIdHtml, /<meta property="og:locale" content="id_ID" \/>/);
  assert.match(ludoIdHtml, /<title>Main JakLudo Online \(Ludo 2–4 Pemain Realtime\)/);
  assert.ok(ludoIdHtml.includes(`<link rel="canonical" href="${url}/?game=jakludo&amp;hl=id" />`));
});

test('Pemain yang dinyatakan OUT tetap bisa masuk room untuk menonton (chat aktif, tidak bisa roll/ambil host)', async () => {
  const ua = await register('spec_a_' + Date.now().toString(36).slice(-5));
  const ub = await register('spec_b_' + Date.now().toString(36).slice(-5));
  const uc = await register('spec_c_' + Date.now().toString(36).slice(-5));

  const sockA = await connect();
  sockA.emit('room:create', { token: ua.token });
  const joinedA = await once(sockA, 'room:joined');
  const code = joinedA.code;

  const sockB = await connect();
  sockB.emit('room:join', { code, token: ub.token });
  await once(sockB, 'room:joined');

  const sockC = await connect();
  sockC.emit('room:join', { code, token: uc.token });
  await once(sockC, 'room:joined');

  const room = rooms.get(code);
  sockA.emit('game:start');
  await wait(80);
  clearTimeout(room.turnTimer);

  // 1. Pemain A menyerah/keluar di tengah match 3 orang -> A berstatus OUT, host berpindah ke B
  sockA.emit('room:leave', { code });
  await wait(100);
  const playerA = room.players.find(p => p.userId === ua.user.id);
  const playerB = room.players.find(p => p.userId === ub.user.id);
  assert.equal(playerA.isOut, true);
  assert.equal(playerB.isHost, true, 'host berpindah ke pemain aktif');

  // 2. Room tetap tampil di /api/rooms/active dengan isOut: true agar A bisa masuk menonton
  const activeRes = await fetch(`${url}/api/rooms/active`, {
    headers: { Authorization: `Bearer ${ua.token}` }
  });
  const activeBody = await activeRes.json();
  const listed = activeBody.rooms.find(r => r.code === code);
  assert.ok(listed, 'room yang masih berlangsung tetap muncul bagi pemain OUT');
  assert.equal(listed.isOut, true);

  // 3. A masuk kembali memakai socket baru untuk menonton pertandingan
  const specA = await connect();
  const updatePromise = once(specA, 'room:update');
  specA.emit('room:join', { code, token: ua.token });
  const rejoinedA = await once(specA, 'room:joined');
  const roomState = await updatePromise;
  assert.equal(rejoinedA.reconnected, true);
  assert.equal(rejoinedA.isOut, true);
  assert.equal(roomState.code, code);
  assert.equal(playerA.isHost, false, 'pemain OUT yang menonton tidak boleh merebut status host dari pemain aktif');

  // 4. A sebagai penonton OUT bisa mengirim chat ke room
  const chatPromise = once(sockB, 'room:chat_message');
  specA.emit('room:chat', { text: 'Semangat kawan!' });
  const receivedChat = await chatPromise;
  assert.equal(receivedChat.text, 'Semangat kawan!');

  // 5. A sebagai penonton OUT dilarang melempar dadu meski mengirim event game:roll
  const turnBefore = room.turn;
  specA.emit('game:roll');
  await wait(80);
  assert.equal(room.rolling, false);
  assert.equal(room.dice, null);
  assert.equal(room.turn, turnBefore);

  // 6. Pemain B kena OUT 3x Auto-Play saat gilirannya -> tetap bisa reconnect & menonton tanpa re-aktifasi giliran
  const engine = require('./game/engine');
  room.turn = room.players.findIndex(p => p.userId === ub.user.id);
  playerB.autoPlayCount = 3;
  engine.executeAutoPlay(room, playerB);
  await wait(80);
  clearTimeout(room.turnTimer);
  assert.equal(playerB.isOut, true);

  sockB.disconnect();
  await wait(60);
  const specB = await connect();
  specB.emit('room:join', { code, token: ub.token });
  const rejoinedB = await once(specB, 'room:joined');
  assert.equal(rejoinedB.reconnected, true);
  assert.equal(rejoinedB.isOut, true);

  clearTimeout(room.turnTimer);
});

test('Sistem Kode Referral: pendaftar baru memakai kode referral dan pemberi kode mendapat 50 coins', async () => {
  const ts = Date.now().toString(36).slice(-5);
  const hostUname = 'ref_host_' + ts;
  const guestUname = 'ref_guest_' + ts;

  // 1. Host mendaftar
  const hostRes = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: hostUname, email: `${hostUname}@playgo.test`, password: 'Password123!', name: 'Host Referral' })
  });
  const hostData = await hostRes.json();
  assert.equal(hostData.success, true);
  assert.ok(hostData.user.referralCode, 'User harus memiliki referralCode otomatis');
  assert.match(hostData.user.referralCode, /^\d{6}$/, 'Kode referral harus berupa angka acak 6 digit');
  const hostRefCode = hostData.user.referralCode;
  const initialHostPoints = hostData.user.points; // 200 (STARTER_POINTS)

  // 2. Cek endpoint validasi kode referral
  const checkValidRes = await fetch(`${url}/api/referral/check/${hostRefCode}`);
  const checkValidData = await checkValidRes.json();
  assert.equal(checkValidData.success, true);
  assert.equal(checkValidData.valid, true);
  assert.equal(checkValidData.referrer.username, hostUname);

  const checkInvalidRes = await fetch(`${url}/api/referral/check/KODEPALSU99`);
  const checkInvalidData = await checkInvalidRes.json();
  assert.equal(checkInvalidData.valid, false);

  // 3. Pendaftar baru mencoba kode referral tidak ada -> harus gagal
  const badRegRes = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'ref_bad_' + ts,
      email: `ref_bad_${ts}@playgo.test`,
      password: 'Password123!',
      name: 'Bad Guest',
      referralCode: 'TIDAK_ADA_CODE'
    })
  });
  const badRegData = await badRegRes.json();
  assert.equal(badRegData.success, false);
  assert.match(badRegData.error, /referral/i);

  // 4. Pendaftar baru mendaftar dengan kode referral milik host
  const guestRes = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: guestUname,
      email: `${guestUname}@playgo.test`,
      password: 'Password123!',
      name: 'Guest Teman',
      referralCode: hostRefCode.toLowerCase() // test case-insensitivity
    })
  });
  const guestData = await guestRes.json();
  assert.equal(guestData.success, true, 'Registrasi dengan kode referral harus sukses');
  assert.equal(guestData.user.referredBy, hostData.user.id);

  // 5. Verifikasi host mendapatkan reward +50 coins
  const meRes = await fetch(`${url}/api/auth/me`, {
    headers: { Authorization: `Bearer ${hostData.token}` }
  });
  const meData = await meRes.json();
  assert.equal(meData.success, true);
  assert.equal(
    meData.user.points,
    initialHostPoints + 50,
    `Host harus bertambah 50 coins (awal: ${initialHostPoints}, sekarang: ${meData.user.points})`
  );
  assert.equal(meData.user.referralCount, 1);
  assert.equal(meData.user.referralBonusCoins, 50);

  // 6. Cek endpoint GET /api/referral/info untuk host
  const infoRes = await fetch(`${url}/api/referral/info`, {
    headers: { Authorization: `Bearer ${hostData.token}` }
  });
  const infoData = await infoRes.json();
  assert.equal(infoData.success, true);
  assert.equal(infoData.referralCode, hostRefCode);
  assert.equal(infoData.totalReferrals, 1);
  assert.equal(infoData.totalCoinsEarned, 50);
  assert.equal(infoData.history.length, 1);
  assert.equal(infoData.history[0].username, guestUname);
  assert.equal(infoData.history[0].rewardPoints, 50);

  // 7. Test alur modal first-login: user mendaftar biasa, lalu klaim via POST /api/referral/claim
  const claimerUname = 'ref_claimer_' + ts;
  const claimerReg = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: claimerUname, email: `${claimerUname}@playgo.test`, password: 'Password123!', name: 'Claimer Player' })
  });
  const claimerData = await claimerReg.json();
  assert.equal(claimerData.success, true);
  assert.equal(claimerData.user.referredBy, null, 'Pendaftar biasa awalnya belum memiliki referredBy');

  // Coba klaim dengan kode sendiri -> harus ditolak
  const selfClaimRes = await fetch(`${url}/api/referral/claim`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${claimerData.token}`
    },
    body: JSON.stringify({ referralCode: claimerData.user.referralCode })
  });
  const selfClaimData = await selfClaimRes.json();
  assert.equal(selfClaimData.success, false);
  assert.match(selfClaimData.error, /sendiri/i);

  // Coba klaim dengan kode tidak valid
  const invalidClaimRes = await fetch(`${url}/api/referral/claim`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${claimerData.token}`
    },
    body: JSON.stringify({ referralCode: '111111' })
  });
  const invalidClaimData = await invalidClaimRes.json();
  assert.equal(invalidClaimData.success, false);
  assert.match(invalidClaimData.error, /tidak valid|tidak ditemukan/i);

  // Klaim kode referral milik host
  const validClaimRes = await fetch(`${url}/api/referral/claim`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${claimerData.token}`
    },
    body: JSON.stringify({ referralCode: hostRefCode })
  });
  const validClaimData = await validClaimRes.json();
  assert.equal(validClaimData.success, true);
  assert.equal(validClaimData.user.referredBy, hostData.user.id);
  assert.equal(validClaimData.referrer.username, hostUname);

  // Coba klaim lagi -> harus ditolak karena sudah pernah klaim
  const repeatClaimRes = await fetch(`${url}/api/referral/claim`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${claimerData.token}`
    },
    body: JSON.stringify({ referralCode: hostRefCode })
  });
  const repeatClaimData = await repeatClaimRes.json();
  assert.equal(repeatClaimData.success, false);
  assert.match(repeatClaimData.error, /pernah/i);

  // Verifikasi host mendapatkan reward tambahan (+50 coins lagi, total +100 coins)
  const hostMeRes = await fetch(`${url}/api/auth/me`, {
    headers: { Authorization: `Bearer ${hostData.token}` }
  });
  const hostMeData = await hostMeRes.json();
  assert.equal(hostMeData.user.points, initialHostPoints + 100);
  assert.equal(hostMeData.user.referralCount, 2);
  assert.equal(hostMeData.user.referralBonusCoins, 100);
});

test('Registrasi manual: wajib email valid serta cek keunikan username & email', async () => {
  const ts = Date.now().toString(36).slice(-5);
  const uname = `uniq_${ts}`;
  const rawEmail = `Pemain.${ts}@PlayGo.ID`;
  const normalizedEmail = rawEmail.toLowerCase();

  // 1. GET /api/auth/check-availability tanpa parameter -> 400
  const emptyCheck = await fetch(`${url}/api/auth/check-availability`);
  assert.equal(emptyCheck.status, 400);

  // 2. Cek username & email yang masih kosong/tersedia -> valid: true, available: true
  const availRes = await fetch(
    `${url}/api/auth/check-availability?username=${encodeURIComponent(uname)}&email=${encodeURIComponent(rawEmail)}`
  );
  assert.equal(availRes.status, 200);
  const availData = await availRes.json();
  assert.equal(availData.success, true);
  assert.equal(availData.username.valid, true);
  assert.equal(availData.username.available, true);
  assert.equal(availData.email.valid, true);
  assert.equal(availData.email.available, true);

  // 3. Cek format username & email tidak valid -> valid: false, available: false
  const invalidCheckRes = await fetch(
    `${url}/api/auth/check-availability?username=ab&email=bukan-email`
  );
  assert.equal(invalidCheckRes.status, 200);
  const invalidCheckData = await invalidCheckRes.json();
  assert.equal(invalidCheckData.username.valid, false);
  assert.equal(invalidCheckData.username.available, false);
  assert.equal(invalidCheckData.email.valid, false);
  assert.equal(invalidCheckData.email.available, false);

  // 4. POST /api/auth/register tanpa email -> 400
  const missingEmailRes = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: uname, password: 'Password#123' })
  });
  assert.equal(missingEmailRes.status, 400);
  const missingEmailData = await missingEmailRes.json();
  assert.match(missingEmailData.error, /email/i);

  // 5. POST /api/auth/register dengan format email tidak valid -> 400
  const badEmailRes = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: uname, email: 'email-rusak', password: 'Password#123' })
  });
  assert.equal(badEmailRes.status, 400);

  // 6. POST /api/auth/register valid dengan email campuran huruf besar -> 200 & dinormalisasi lowercase
  const okRes = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: uname,
      email: rawEmail,
      password: 'Password#123',
      name: 'Pemain Unik'
    })
  });
  assert.equal(okRes.status, 200);
  const okData = await okRes.json();
  assert.equal(okData.success, true);
  assert.equal(okData.user.username, uname);
  assert.equal(okData.user.email, normalizedEmail);

  const meRes = await fetch(`${url}/api/auth/me`, {
    headers: { Authorization: `Bearer ${okData.token}` }
  });
  const meData = await meRes.json();
  assert.equal(meData.user.email, normalizedEmail);

  // 7. GET /api/auth/check-availability untuk username & email yang sama (beda kapitalisasi) -> available: false
  const takenCheckRes = await fetch(
    `${url}/api/auth/check-availability?username=${encodeURIComponent(uname.toUpperCase())}&email=${encodeURIComponent(normalizedEmail.toUpperCase())}`
  );
  assert.equal(takenCheckRes.status, 200);
  const takenCheckData = await takenCheckRes.json();
  assert.equal(takenCheckData.username.available, false);
  assert.equal(takenCheckData.email.available, false);

  // 8. POST /api/auth/register duplikat username -> 400
  const dupUserRes = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: uname,
      email: `other_${ts}@playgo.id`,
      password: 'Password#123'
    })
  });
  assert.equal(dupUserRes.status, 400);
  const dupUserData = await dupUserRes.json();
  assert.match(dupUserData.error, /username/i);

  // 9. POST /api/auth/register duplikat email (case-insensitive) -> 400
  const dupEmailRes = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: `other_${ts}`,
      email: normalizedEmail.toUpperCase(),
      password: 'Password#123'
    })
  });
  assert.equal(dupEmailRes.status, 400);
  const dupEmailData = await dupEmailRes.json();
  assert.match(dupEmailData.error, /email/i);
});
