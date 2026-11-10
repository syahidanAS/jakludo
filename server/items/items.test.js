// Test fitur toko & item: registry, pembelian, Force Return, Blackhole Shield, dan Universal Shield
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jakludo-items-'));
process.env.JAKLUDO_DATA_DIR = dataDir;

const { io: ioClient } = require('socket.io-client');
const { server, rooms, shutdown } = require('../index');
const db = require('../db');
const items = require('./index');

let url;
const clients = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
const once = (c, event) => new Promise(resolve => c.once(event, resolve));
const engine = require('../game/engine');

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

let userSeq = 0;
async function register() {
  const res = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: `pemain_item_${++userSeq}`, password: 'Rahasia#123' })
  });
  return res.json();
}

const buy = (token, itemId) => fetch(`${url}/api/shop/buy`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ itemId })
}).then(r => r.json());

// Room 2 pemain (A login, B tamu) yang sudah dimulai; giliran A
async function startedRoom({ blackHole = false } = {}) {
  const a = await register();
  const host = await connect();
  host.emit('room:create', { token: a.token });
  const { code } = await once(host, 'room:joined');
  const guest = await connect();
  guest.emit('room:join', { code, name: 'B' });
  await once(guest, 'room:joined');
  if (blackHole) host.emit('room:update_settings', { blackHole: true });
  await wait(30);
  host.emit('game:start');
  await wait(80);
  const room = rooms.get(code);
  clearTimeout(room.turnTimer);
  return { a, host, guest, room, pa: room.players[0], pb: room.players[1] };
}

test('setiap item di registry memenuhi kontrak dan tampil di katalog toko', async () => {
  const res = await fetch(`${url}/api/shop/items`).then(r => r.json());
  assert.deepEqual(res.items.map(i => i.id), items.list().map(i => i.id));
  for (const item of res.items) {
    assert.ok(item.name && item.icon && item.description && Number.isInteger(item.price));
    assert.ok(['active', 'passive', 'reactive'].includes(item.kind));
    assert.equal(typeof item.use, 'undefined', 'function tidak ikut dikirim ke klien');
  }
});

test('Force Return yang dibeli bisa langsung dipakai tanpa harus menginjak lawan', async () => {
  const { a, host, room, pa, pb } = await startedRoom();
  const bought = await buy(a.token, 'forceReturn');
  assert.equal(bought.success, true);
  assert.equal(pa.items.forceReturn.owned, 1, 'stok di room ikut tersinkron setelah membeli');

  room.pawns[pb.id] = [12, 0, 0, 0];
  room.pawns[pa.id] = [5, 0, 0, 0]; // Force Return butuh bidak sendiri di luar markas
  host.emit('game:use_item', { itemId: 'forceReturn', target: { playerId: pb.id, pawnIdx: 0 } });
  await wait(100);
  assert.equal(room.pawns[pb.id][0], 0, 'bidak lawan pulang ke markas');
  assert.equal(pa.items.forceReturn.owned, 0);
  assert.equal(db.getUserItems(a.user.id).forceReturn || 0, 0, 'stok di database berkurang');
  assert.equal(room.lastItemEvent.itemId, 'forceReturn');
  assert.equal(room.turn, 0, 'giliran tetap milik pemain yang memakai item');
});

test('menginjak lawan dan memasukkan 3 bidak tidak lagi memberi Force Return gratis', async () => {
  const { room, pa, pb } = await startedRoom();
  for (let i = 0; i < 3; i++) {
    // Merah val 2 + dadu 3 -> track 4; hijau val 35 -> track (10 + 34) % 40 = 4
    room.pawns[pa.id] = [2, 44, 44, 44 - i];
    room.pawns[pb.id] = [35, 0, 0, 0];
    room.turn = 0;
    room.dice = 3;
    clearTimeout(room.turnTimer);
    require('../game/engine').handleMove(room, pa.id, 0);
    await wait(3 * 220 + 500);
    assert.equal(room.pawns[pb.id][0], 0);
  }
  assert.equal(pa.items.forceReturn?.earned || 0, 0);
  assert.equal(pa.skillPoints, undefined, 'skill eliminasi sudah dihapus');
});

test('item gratis dari pertandingan dipakai lebih dulu, item yang dibeli tetap tersimpan', async () => {
  const { a, host, room, pa, pb } = await startedRoom();
  await buy(a.token, 'forceReturn');
  pa.items.forceReturn.earned = 1;

  room.pawns[pb.id] = [12, 0, 0, 0];
  room.pawns[pa.id] = [5, 0, 0, 0]; // Force Return butuh bidak sendiri di luar markas
  host.emit('game:use_item', { itemId: 'forceReturn', target: { playerId: pb.id, pawnIdx: 0 } });
  await wait(100);
  assert.equal(pa.items.forceReturn.earned, 0);
  assert.equal(pa.items.forceReturn.owned, 1);
  assert.equal(db.getUserItems(a.user.id).forceReturn, 1);
});

test('item aktif tidak bisa dipakai tanpa stok atau setelah melempar dadu', async () => {
  const { a, host, room, pa, pb } = await startedRoom();
  room.pawns[pb.id] = [12, 0, 0, 0];
  room.pawns[pa.id] = [5, 0, 0, 0]; // Force Return butuh bidak sendiri di luar markas
  let err = once(host, 'room:error');
  host.emit('game:use_item', { itemId: 'forceReturn', target: { playerId: pb.id, pawnIdx: 0 } });
  assert.match(await err, /tidak punya/);

  await buy(a.token, 'forceReturn');
  room.dice = 4;
  err = once(host, 'room:error');
  host.emit('game:use_item', { itemId: 'forceReturn', target: { playerId: pb.id, pawnIdx: 0 } });
  assert.match(await err, /sebelum melempar dadu/);
  assert.equal(pa.items.forceReturn.owned, 1);

  room.dice = null;
  err = once(host, 'room:error');
  host.emit('game:use_item', { itemId: 'blackholeShield' });
  assert.match(await err, /tidak valid/, 'item pasif tidak bisa dipakai manual');
});

test('Force Return butuh minimal 1 bidak sendiri di luar markas', async () => {
  const { host, room, pa, pb } = await startedRoom();
  pa.items.forceReturn = { owned: 0, earned: 1, state: {} };
  room.pawns[pb.id] = [12, 0, 0, 0];
  room.pawns[pa.id] = [0, 0, 0, 44]; // bidak yang sudah finish tidak dihitung
  assert.match(require('../game/store').publicRoom(room).players[0].items.forceReturn.blocked, /keluarkan dulu/);
  let err = once(host, 'room:error');
  host.emit('game:use_item', { itemId: 'forceReturn', target: { playerId: pb.id, pawnIdx: 0 } });
  assert.match(await err, /keluarkan dulu minimal 1 bidakmu/);
  assert.equal(room.pawns[pb.id][0], 12);
  assert.equal(pa.items.forceReturn.earned, 1, 'stok tidak berkurang');

  room.pawns[pa.id] = [3, 0, 0, 44];
  assert.equal(require('../game/store').publicRoom(room).players[0].items.forceReturn.blocked, null);
  host.emit('game:use_item', { itemId: 'forceReturn', target: { playerId: pb.id, pawnIdx: 0 } });
  await wait(80);
  assert.equal(room.pawns[pb.id][0], 0, 'setelah ada bidak di luar markas, Force Return bisa dipakai');
});

test('Force Return tidak bisa dipakai jika tidak ada bidak lawan di luar markas', async () => {
  const { host, room, pa, pb } = await startedRoom();
  pa.items.forceReturn = { owned: 0, earned: 1, state: {} };
  room.pawns[pa.id] = [5, 0, 0, 0];
  room.pawns[pb.id] = [0, 0, 44, 41]; // markas dan jalur finish bukan target
  const err = once(host, 'room:error');
  host.emit('game:use_item', { itemId: 'forceReturn', target: { playerId: pb.id, pawnIdx: 0 } });
  assert.match(await err, /tidak ada bidak lawan di luar markas/);
  assert.equal(pa.items.forceReturn.earned, 1, 'stok tidak berkurang');
});

test('Blackhole Shield otomatis mencegah bidak tersedot dan mengurangi stok', async () => {
  const { a, room, pa } = await startedRoom({ blackHole: true });
  await buy(a.token, 'blackholeShield');
  // Merah val 2 + dadu 3 -> val 5 -> track 4 (Black Hole)
  room.pawns[pa.id] = [2, 0, 0, 0];
  room.dice = 3;
  require('../game/engine').handleMove(room, pa.id, 0);
  await wait(3 * 220 + 500);
  assert.equal(room.pawns[pa.id][0], 5, 'bidak tidak tersedot');
  assert.equal(pa.items.blackholeShield.owned, 0);
  assert.equal(db.getUserItems(a.user.id).blackholeShield || 0, 0);
  assert.equal(room.lastItemEvent.itemId, 'blackholeShield');
});

test('poin tidak cukup menolak pembelian', async () => {
  const u = await register();
  await buy(u.token, 'forceReturn');
  await buy(u.token, 'forceReturn');
  const third = await buy(u.token, 'forceReturn');
  assert.equal(third.success, false);
  assert.match(third.error, /Poin tidak mencukupi/);
  assert.equal(db.getUserItems(u.user.id).forceReturn, 2);
});

test('poin tidak bisa ditambah lewat endpoint inject (sudah dihapus)', async () => {
  const u = await register();
  const res = await fetch(`${url}/api/shop/inject-diamonds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.token}` },
    body: JSON.stringify({ amount: 1000 })
  });
  assert.equal(res.status, 404);
});

// ---------- Universal Shield ----------

// Stok diberikan langsung sebagai item pertandingan: membeli di toko butuh akun baru per test,
// dan pendaftaran akun dibatasi per jaringan
const giveShield = player => {
  player.items.universalShield = { owned: 0, earned: 1, state: {} };
};
const giveForceReturn = player => {
  player.items.forceReturn = { owned: 0, earned: 1, state: {} };
};

test('harga item sesuai toko: Force Return 100, Blackhole Shield 50, Universal Shield 100', () => {
  assert.equal(items.get('forceReturn').price, 100);
  assert.equal(items.get('blackholeShield').price, 50);
  assert.equal(items.get('universalShield').price, 100);
  assert.equal(items.get('universalShield').kind, 'reactive');
});

test('target Force Return yang punya Universal Shield ditanya dan bisa menahannya', async () => {
  const { host, guest, room, pa, pb } = await startedRoom();
  giveForceReturn(pa);
  giveShield(pb);
  room.pawns[pb.id] = [12, 0, 0, 0];
  room.pawns[pa.id] = [5, 0, 0, 0]; // Force Return butuh bidak sendiri di luar markas

  const asked = new Promise(resolve => guest.on('room:update', r => r.pendingShield && resolve(r.pendingShield)));
  host.emit('game:use_item', { itemId: 'forceReturn', target: { playerId: pb.id, pawnIdx: 0 } });
  const pending = await asked;
  assert.equal(pending.playerId, pb.id);
  assert.equal(pending.itemId, 'universalShield');
  assert.equal(pending.event, 'forceReturn');
  assert.equal(pending.resume, undefined, 'data lanjutan tidak dikirim ke klien');

  // Selama menunggu keputusan, pemain yang giliran tidak bisa melempar dadu
  host.emit('game:roll');
  await wait(50);
  assert.equal(room.rolling, false);

  guest.emit('game:shield_decision', { use: true });
  await wait(80);
  assert.equal(room.pendingShield, null);
  assert.equal(room.pawns[pb.id][0], 12, 'bidak selamat');
  assert.equal(pb.items.universalShield.earned, 0, 'perisai terpakai');
  assert.equal(pa.items.forceReturn.earned, 0, 'Force Return penyerang tetap terpakai');
  assert.equal(room.lastItemEvent.itemId, 'universalShield');
  assert.equal(room.turn, 0, 'giliran tetap milik penyerang');
});

test('target Force Return boleh memilih menyimpan Universal Shield', async () => {
  const { host, guest, room, pa, pb } = await startedRoom();
  giveForceReturn(pa);
  giveShield(pb);
  room.pawns[pb.id] = [12, 0, 0, 0];
  room.pawns[pa.id] = [5, 0, 0, 0]; // Force Return butuh bidak sendiri di luar markas
  host.emit('game:use_item', { itemId: 'forceReturn', target: { playerId: pb.id, pawnIdx: 0 } });
  await wait(80);
  assert.ok(room.pendingShield);

  host.emit('game:shield_decision', { use: true }); // bukan pemilik perisai: diabaikan
  await wait(50);
  assert.ok(room.pendingShield);

  guest.emit('game:shield_decision', { use: false });
  await wait(80);
  assert.equal(room.pawns[pb.id][0], 0, 'bidak pulang ke markas');
  assert.equal(pb.items.universalShield.earned, 1, 'perisai tetap tersimpan');
});

test('Universal Shield dipakai otomatis jika waktu memutuskan habis', async () => {
  const { host, room, pa, pb } = await startedRoom();
  giveForceReturn(pa);
  giveShield(pb);
  room.pawns[pb.id] = [12, 0, 0, 0];
  room.pawns[pa.id] = [5, 0, 0, 0]; // Force Return butuh bidak sendiri di luar markas
  host.emit('game:use_item', { itemId: 'forceReturn', target: { playerId: pb.id, pawnIdx: 0 } });
  await wait(80);
  room.pendingShield.expiresAt = Date.now();
  engine.triggerTurn(room); // pasang ulang timer, sama seperti setelah server restart
  await wait(80);
  assert.equal(room.pendingShield, null);
  assert.equal(room.pawns[pb.id][0], 12);
  assert.equal(pb.items.universalShield.earned, 0);
});

test('Black Hole: pemilik Universal Shield ditanya; menolak berarti bidak tersedot', async () => {
  const { host, room, pa } = await startedRoom({ blackHole: true });
  giveShield(pa);
  room.pawns[pa.id] = [2, 0, 0, 0];
  room.dice = 3;
  engine.handleMove(room, pa.id, 0);
  await wait(3 * 220 + 500);
  assert.equal(room.pendingShield?.event, 'blackHole');
  assert.equal(room.pawns[pa.id][0], 5, 'menunggu keputusan, bidak belum tersedot');
  assert.deepEqual(require('../game/store').publicRoom(room).movable, [], 'tidak ada langkah selama menunggu');

  host.emit('game:shield_decision', { use: false });
  await wait(80);
  assert.equal(room.pawns[pa.id][0], 0, 'bidak tersedot');
  assert.equal(pa.items.universalShield.earned, 1);
  assert.equal(room.turn, 1, 'giliran lanjut ke pemain berikutnya');
});

test('Black Hole: Blackhole Shield otomatis dipakai lebih dulu sebelum Universal Shield ditawarkan', async () => {
  const { room, pa } = await startedRoom({ blackHole: true });
  pa.items.blackholeShield = { owned: 0, earned: 1, state: {} };
  giveShield(pa);
  room.pawns[pa.id] = [2, 0, 0, 0];
  room.dice = 3;
  engine.handleMove(room, pa.id, 0);
  await wait(3 * 220 + 500);
  assert.equal(room.pendingShield, null, 'tidak perlu bertanya');
  assert.equal(room.pawns[pa.id][0], 5);
  assert.equal(pa.items.blackholeShield.earned, 0);
  assert.equal(pa.items.universalShield.earned, 1, 'Universal Shield tetap utuh');
});
