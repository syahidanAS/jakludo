// Integration test lewat socket sungguhan. Data disimpan di folder sementara.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jakludo-test-'));
process.env.JAKLUDO_DATA_DIR = dataDir;

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
  assert.equal(board.find(e => e.userId === u1.user.id).points, before + 30);
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
  const a = await reg(srv.url, 'tahan_restart');
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
  assert.deepEqual(users.map((u, i) => pts(u) - before[i]), [20, 5, 30, 15]);

  // Dua pemain: yang kalah hanya dapat 5
  const mid = users.map(pts);
  db.recordMatchResult({ winnerPlayerId: 'r0', players: players.slice(0, 2) });
  assert.deepEqual([pts(users[0]) - mid[0], pts(users[1]) - mid[1]], [30, 5]);
});
