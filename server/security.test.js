'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playgo-sec-test-'));
process.env.JAKLUDO_DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';

const { io: ioClient } = require('socket.io-client');
const { server, rooms, shutdown } = require('./index');
const db = require('./db');
const duitku = require('./lib/duitku');
const { verifyGoogleIdToken } = require('./lib/googleAuth');
const chessEngine = require('./chess/engine');
const chessStore = require('./chess/store');
const snakesEngine = require('./snakes/engine');

let url;
const clients = [];

test.before(async () => {
  await new Promise(resolve => server.listen(0, resolve));
  url = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  clients.forEach(c => c.close());
  chessEngine.stopAllTimers();
  snakesEngine.stopAllTimers();
  await shutdown();
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

function emitAck(c, event, payload) {
  return new Promise(resolve => c.emit(event, payload, res => resolve(res)));
}

const wait = ms => new Promise(r => setTimeout(r, ms));

let seq = 0;
async function register(prefix = 'sec') {
  seq += 1;
  const username = `${prefix}_${seq}_${Date.now().toString(36).slice(-4)}`.slice(0, 20);
  const res = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email: `${username}@playgo.test`, password: 'Password#123', name: `Tester ${seq}` })
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  return body;
}

test('Security 1: Google OAuth mock token DITOLAK saat NODE_ENV bukan test', async () => {
  const prevEnv = process.env.NODE_ENV;
  const mockToken = 'mock_google_token_' + Buffer.from(JSON.stringify({
    sub: 'attacker_sub',
    email: 'admin@playgo.devgate.my.id',
    name: 'Attacker'
  })).toString('base64');

  try {
    process.env.NODE_ENV = 'production';
    const prodRes = await verifyGoogleIdToken(mockToken);
    assert.ok(prodRes.error, 'Token simulasi wajib ditolak di production');
    assert.equal(prodRes.email, undefined);
  } finally {
    process.env.NODE_ENV = prevEnv;
  }

  // Di mode test tetap bekerja
  const testRes = await verifyGoogleIdToken(mockToken);
  assert.equal(testRes.email, 'admin@playgo.devgate.my.id');
});

test('Security 2: Callback legacy topup menolak nominal 0 atau negatif', async () => {
  const u = await register('topup0');
  const orderRes = await fetch(`${url}/api/topup/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.token}` },
    body: JSON.stringify({ packageId: 'diamond_120', paymentMethod: 'BC' })
  });
  const orderBody = await orderRes.json();
  assert.equal(orderBody.success, true);

  const cfgRes = await fetch(`${url}/api/topup/config`);
  const cfg = await cfgRes.json();
  const mCode = cfg.merchantCode || 'DTEST';
  const mKey = process.env.DUITKU_API_KEY || '';

  for (const badAmount of ['0', 0, '-10000', 'abc']) {
    const validSig = duitku.md5(`${mCode}${badAmount}${orderBody.orderId}${mKey}`);
    const res = await fetch(`${url}/api/topup/notification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchantCode: mCode,
        merchantOrderId: orderBody.orderId,
        amount: badAmount,
        resultCode: '00',
        signature: validSig
      })
    });
    assert.equal(res.status, 400, `Nominal ${badAmount} seharusnya ditolak`);
  }

  const meRes = await fetch(`${url}/api/auth/me`, { headers: { Authorization: `Bearer ${u.token}` } });
  const meBody = await meRes.json();
  assert.equal(meBody.user.points, 200, 'Saldo tidak boleh bertambah dari callback nominal 0');
});

test('Security 3: Race condition pembelian item Coins dicegah dengan per-user lock', async () => {
  const u = await register('race'); // starter points = 200; forceReturn price = 100
  const results = await Promise.all([
    db.purchaseItem({ userId: u.user.id, itemId: 'forceReturn' }),
    db.purchaseItem({ userId: u.user.id, itemId: 'forceReturn' }),
    db.purchaseItem({ userId: u.user.id, itemId: 'forceReturn' })
  ]);
  const successes = results.filter(r => r.success);
  const failures = results.filter(r => r.error);
  assert.equal(successes.length, 2, 'Hanya 2 pembelian senilai 200 Coins yang boleh berhasil');
  assert.equal(failures.length, 1, 'Pembelian ke-3 wajib gagal karena saldo habis');
  assert.equal(db.getUserPoints(u.user.id), 0);
  assert.equal(db.getUserItems(u.user.id).forceReturn, 2);
});

test('Security 4: Chess Master memblokir farming Coins & Elo dari Bot maupun Resign 0-langkah', async () => {
  const p1 = await register('cw1');
  const p2 = await register('cw2');
  const initialCoins1 = db.getUserPoints(p1.user.id);
  const initialCoins2 = db.getUserPoints(p2.user.id);

  // A. Resign 0-langkah pada pertandingan manusia
  const c1 = await connect();
  const c2 = await connect();
  const createAck = await emitAck(c1, 'chess:room:create', { token: p1.token, timeControl: '5+0', preferredSide: 'w' });
  await emitAck(c2, 'chess:room:join', { token: p2.token, code: createAck.room.code });
  await emitAck(c1, 'chess:player:ready', { token: p1.token, code: createAck.room.code, ready: true });
  await emitAck(c2, 'chess:player:ready', { token: p2.token, code: createAck.room.code, ready: true });

  const roomObj = chessEngine.chessRooms.get(createAck.room.code);
  const resignAck = await emitAck(c1, 'chess:resign', { token: p1.token, code: createAck.room.code });
  assert.equal(resignAck.ok, true);
  assert.equal(roomObj.match.rewardCoins, 0, 'Resign 0-langkah tidak boleh memberi Coins');
  assert.equal(db.getUserPoints(p1.user.id), initialCoins1);
  assert.equal(db.getUserPoints(p2.user.id), initialCoins2);
  assert.equal(chessStore.getPlayerProfile(p1.user.id).rating, 1200);
  assert.equal(chessStore.getPlayerProfile(p2.user.id).rating, 1200);

  // B. Kemenangan melawan Bot tidak memberi Coins atau menaikkan Elo
  const botStart = await emitAck(c1, 'chess:bot:play', {
    token: p1.token,
    timeControl: '5+0',
    preferredSide: 'w',
    difficulty: 'easy'
  });
  assert.equal(botStart.ok, true);
  const botMatchRec = chessStore.finalizeMatchRecord({
    matchId: botStart.matchId,
    result: '1-0',
    winnerUserId: p1.user.id,
    terminationReason: 'checkmate'
  });
  assert.equal(botMatchRec.rewardCoins, 0, 'Menang melawan bot tidak boleh memberi Coins');
  assert.equal(botMatchRec.whiteRatingChange, 0, 'Menang melawan bot tidak boleh menaikkan Elo');
  assert.equal(db.getUserPoints(p1.user.id), initialCoins1);
  assert.equal(chessStore.getPlayerProfile(p1.user.id).rating, 1200);
});

test('Security 5: JakLudo memblokir forfeit farming & reset timer via reconnect', async () => {
  const u1 = await register('ludo_f1');
  const u2 = await register('ludo_f2');
  const c1 = await connect();
  const c2 = await connect();

  c1.emit('room:create', { token: u1.token });
  const j1 = await once(c1, 'room:joined');
  c2.emit('room:join', { code: j1.code, token: u2.token });
  const j2 = await once(c2, 'room:joined');

  c1.emit('game:start');
  await wait(80);
  const room = rooms.get(j1.code);
  assert.ok(room?.turnClock?.endsAt);

  // Uji anti-stalling saat reconnect: tunggu 350ms, reconnect player giliran 0, dan pastikan endsAt tidak di-reset ke +15s baru
  const originalEndsAt = room.turnClock.endsAt;
  room.players[0].autoPlayCount = 2;
  await wait(350);
  const c1Again = await connect();
  c1Again.emit('room:join', { code: j1.code, token: u1.token, sessionId: j1.sessionId });
  await once(c1Again, 'room:joined');
  assert.equal(room.players[0].autoPlayCount, 2, 'Reconnect tidak boleh menghapus hitungan autoPlayCount');
  assert.ok(room.turnClock.endsAt <= originalEndsAt + 100, 'Reconnect tidak boleh memperpanjang deadline timer giliran');

  // Uji anti-forfeit farming: pemain keluar sengaja -> tidak ada Coins yang diberikan ke kedua belah pihak
  const before1 = db.getUserPoints(u1.user.id);
  const before2 = db.getUserPoints(u2.user.id);
  c2.emit('room:leave', {});
  await wait(80);
  assert.ok(room.winner, 'Pemenang tetap diumumkan saat lawan keluar');
  assert.equal(db.getUserPoints(u1.user.id), before1, 'Pemenang forfeit instan tidak mendapat Coins');
  assert.equal(db.getUserPoints(u2.user.id), before2, 'Pemain yang menyerah/keluar tidak mendapat Coins');
  assert.equal(j2.reconnected, false);
});

test('Security 6: Snakes & Ladders memblokir farming Coins dari opponent_left instan', async () => {
  const w = await register('snk_w');
  const l = await register('snk_l');
  const cw = await connect();
  const cl = await connect();
  await emitAck(cw, 'social:identify', { token: w.token });
  await emitAck(cl, 'social:identify', { token: l.token });

  const created = await emitAck(cw, 'snakes:room:create', { token: w.token });
  await emitAck(cl, 'snakes:room:join', { token: l.token, code: created.roomCode });
  await emitAck(cw, 'snakes:room:start', { token: w.token, roomCode: created.roomCode });

  const beforeW = db.getUserPoints(w.user.id);
  const beforeL = db.getUserPoints(l.user.id);
  await emitAck(cl, 'snakes:room:leave', { token: l.token, roomCode: created.roomCode });

  assert.equal(db.getUserPoints(w.user.id), beforeW, 'Menang forfeit instan di giliran 1 tidak boleh memberi rewardCoins');
  assert.equal(db.getUserPoints(l.user.id), beforeL);
});
