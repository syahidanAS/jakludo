'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playgo-admin-test-'));
process.env.JAKLUDO_DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
process.env.PAYMENT_GATEWAY = 'midtrans';
process.env.MIDTRANS_SERVER_KEY = 'SB-Mid-server-test-key-123';
process.env.MIDTRANS_CLIENT_KEY = 'SB-Mid-client-test-key-123';

const { server, shutdown } = require('../index');
const db = require('../db');
const store = require('../game/store');
const quizEngine = require('../quiz/engine');
const chessEngine = require('../chess/engine');
const snakesEngine = require('../snakes/engine');

let url;

test.before(async () => {
  await new Promise(resolve => server.listen(0, resolve));
  url = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  chessEngine.stopAllTimers();
  snakesEngine.stopAllTimers();
  quizEngine.stopAllTimers();
  await shutdown();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function apiJson(route, { method = 'GET', token = '', body = undefined } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${url}${route}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { status: res.status, headers: res.headers, data, rawText: text };
}

async function registerPlayer(username) {
  const res = await apiJson('/api/auth/register', {
    method: 'POST',
    body: { username, password: 'Rahasia#123', name: username }
  });
  assert.equal(res.status, 200, `Registrasi ${username} gagal: ${JSON.stringify(res.data)}`);
  return res.data;
}

test('Admin CMS entry routes (/admin and /admin/users) serve built admin.html with noindex', async () => {
  const adminHtmlPath = path.join(__dirname, '../../dist/admin.html');
  assert.ok(fs.existsSync(adminHtmlPath), 'dist/admin.html harus ada (jalankan npm run build)');

  const resRoot = await fetch(`${url}/admin`);
  assert.equal(resRoot.status, 200);
  assert.equal(resRoot.headers.get('x-robots-tag'), 'noindex, nofollow');
  const htmlRoot = await resRoot.text();
  assert.ok(htmlRoot.includes('admin-root'), 'HTML /admin harus memuat #admin-root');

  const resSub = await fetch(`${url}/admin/users`);
  assert.equal(resSub.status, 200);
  assert.equal(resSub.headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('Admin CMS RBAC, User CRUD, Active Room Monitoring, and Financial Transactions', async () => {
  const adminAuth = await registerPlayer('cms_superadmin');
  await db.setUserRole(adminAuth.user.id, 'admin');
  const playerAuth = await registerPlayer('cms_regular_player');

  // 1. RBAC guards
  const noAuth = await apiJson('/api/admin/overview');
  assert.equal(noAuth.status, 401);

  const nonAdmin = await apiJson('/api/admin/overview', { token: playerAuth.token });
  assert.equal(nonAdmin.status, 403);

  const okAdmin = await apiJson('/api/admin/overview', { token: adminAuth.token });
  assert.equal(okAdmin.status, 200);
  assert.equal(okAdmin.data.success, true);

  // 2. Create user via Admin CMS
  const created = await apiJson('/api/admin/users', {
    method: 'POST',
    token: adminAuth.token,
    body: {
      username: 'cms_target_u1',
      name: 'Target Pertama',
      email: 'target1@playgo.id',
      password: 'Password#123',
      role: 'player',
      points: 500,
      diamonds: 25
    }
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.user.username, 'cms_target_u1');
  assert.equal(created.data.user.points, 500);
  assert.equal(created.data.user.diamonds, 25);
  const targetId = created.data.user.id;

  // Search & List users
  const listRes = await apiJson('/api/admin/users?q=cms_target_u1&role=player', { token: adminAuth.token });
  assert.equal(listRes.status, 200);
  assert.equal(listRes.data.total, 1);
  assert.equal(listRes.data.items[0].id, targetId);

  // Detail user
  const detailRes = await apiJson(`/api/admin/users/${targetId}`, { token: adminAuth.token });
  assert.equal(detailRes.status, 200);
  assert.ok(Array.isArray(detailRes.data.itemCatalog));
  assert.ok(detailRes.data.itemCatalog.length > 0);

  // Edit user (name, role, newPassword, coins, diamonds, inventory items)
  const patchRes = await apiJson(`/api/admin/users/${targetId}`, {
    method: 'PATCH',
    token: adminAuth.token,
    body: {
      name: 'Target Edited',
      points: 850,
      diamonds: 40,
      diamondReason: 'Bonus tes CMS',
      newPassword: 'NewPassword#999',
      items: { blackholeShield: 3 }
    }
  });
  assert.equal(patchRes.status, 200);
  assert.equal(patchRes.data.user.name, 'Target Edited');
  assert.equal(patchRes.data.user.points, 850);
  assert.equal(patchRes.data.user.diamonds, 40);
  assert.equal(patchRes.data.inventory.blackholeShield, 3);

  // Login using the password reset by Admin CMS
  const targetLogin = await apiJson('/api/auth/login', {
    method: 'POST',
    body: { username: 'cms_target_u1', password: 'NewPassword#999' }
  });
  assert.equal(targetLogin.status, 200);
  assert.ok(targetLogin.data.token);

  // Revoke sessions
  const revokeRes = await apiJson(`/api/admin/users/${targetId}/revoke-sessions`, {
    method: 'POST',
    token: adminAuth.token,
    body: {}
  });
  assert.equal(revokeRes.status, 200);
  assert.ok(revokeRes.data.revokedCount >= 1);

  const revokedCheck = await apiJson('/api/auth/me', { token: targetLogin.data.token });
  assert.equal(revokedCheck.status, 401);

  // Self-demote & self-delete guards
  const selfDemote = await apiJson(`/api/admin/users/${adminAuth.user.id}`, {
    method: 'PATCH',
    token: adminAuth.token,
    body: { role: 'player' }
  });
  assert.equal(selfDemote.status, 400);

  const selfDelete = await apiJson(`/api/admin/users/${adminAuth.user.id}`, {
    method: 'DELETE',
    token: adminAuth.token
  });
  assert.equal(selfDelete.status, 400);

  // 3. Active Room Monitoring across Ludo, Quiz, Chess, Snakes
  store.rooms.set('LUDO1', {
    code: 'LUDO1',
    host: 'sock1',
    started: true,
    turn: 0,
    dice: 6,
    winner: null,
    pawns: {},
    players: [
      { id: 'sock1', userId: playerAuth.user.id, username: playerAuth.user.username, name: playerAuth.user.name, color: 'red', isHost: true, isBot: false, connected: true }
    ],
    history: [],
    lobbyRemovals: new Map(),
    updatedAt: Date.now()
  });
  quizEngine.quizRooms.set('QUIZ1', {
    id: 'qroom_1',
    code: 'QUIZ1',
    source: 'code',
    phase: 'lobby',
    hostUserId: playerAuth.user.id,
    createdAt: Date.now(),
    players: [{ userId: playerAuth.user.id, username: playerAuth.user.username, name: playerAuth.user.name, isBot: false, connected: true, hp: 100, maxHp: 100 }],
    match: null
  });
  chessEngine.chessRooms.set('CHES1', {
    id: 'croom_1',
    code: 'CHES1',
    source: 'private',
    phase: 'lobby',
    timeControl: '5+0',
    hostUserId: playerAuth.user.id,
    createdAt: Date.now(),
    players: [{ userId: playerAuth.user.id, username: playerAuth.user.username, name: playerAuth.user.name, isBot: false, connected: true }],
    match: null
  });
  snakesEngine.snakesRooms.set('SNAK1', {
    id: 'sroom_1',
    code: 'SNAK1',
    roomType: 'private',
    status: 'waiting',
    maxPlayers: 4,
    hostUserId: playerAuth.user.id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    players: [{ id: 'sp1', user_id: playerAuth.user.id, username: playerAuth.user.username, name: playerAuth.user.name, player_type: 'human', connected: true, position: 0, color: 'red' }],
    moveLog: []
  });

  const roomsRes = await apiJson('/api/admin/rooms', { token: adminAuth.token });
  assert.equal(roomsRes.status, 200);
  assert.ok(roomsRes.data.summary.totalRooms >= 4);
  assert.ok(roomsRes.data.rooms.some(r => r.game === 'ludo' && r.code === 'LUDO1'));
  assert.ok(roomsRes.data.rooms.some(r => r.game === 'quiz' && r.code === 'QUIZ1'));
  assert.ok(roomsRes.data.rooms.some(r => r.game === 'chess' && r.code === 'CHES1'));
  assert.ok(roomsRes.data.rooms.some(r => r.game === 'snakes' && r.code === 'SNAK1'));

  const inspectLudo = await apiJson('/api/admin/rooms/ludo/LUDO1', { token: adminAuth.token });
  assert.equal(inspectLudo.status, 200);
  assert.equal(inspectLudo.data.room.code, 'LUDO1');

  for (const [game, code] of [['ludo', 'LUDO1'], ['quiz', 'QUIZ1'], ['chess', 'CHES1'], ['snakes', 'SNAK1']]) {
    const closeRes = await apiJson(`/api/admin/rooms/${game}/${code}/close`, {
      method: 'POST',
      token: adminAuth.token,
      body: { reason: 'Unit test close' }
    });
    assert.equal(closeRes.status, 200, `Gagal close room ${game}/${code}`);
  }
  const afterCloseRooms = await apiJson('/api/admin/rooms', { token: adminAuth.token });
  assert.equal(afterCloseRooms.data.rooms.filter(r => ['LUDO1', 'QUIZ1', 'CHES1', 'SNAK1'].includes(r.code)).length, 0);

  // 4. Financial Transactions (Orders, Approve, Cancel, Adjust, CSV Export, Ledger)
  const diamondOrderCreate = await apiJson('/api/economy/topup/create', {
    method: 'POST',
    token: playerAuth.token,
    body: { packageId: 'pkg_starter', paymentMethod: 'bca_va' }
  });
  assert.equal(diamondOrderCreate.status, 200);
  const dOrderId = diamondOrderCreate.data.order.id;

  const coinOrderCreate = await apiJson('/api/topup/charge', {
    method: 'POST',
    token: playerAuth.token,
    body: { packageId: 'diamond_260', paymentMethod: 'qris' }
  });
  assert.equal(coinOrderCreate.status, 200);
  const cOrderId = coinOrderCreate.data.orderId;

  const ordersRes = await apiJson('/api/admin/finance/orders?status=PENDING', { token: adminAuth.token });
  assert.equal(ordersRes.status, 200);
  assert.ok(ordersRes.data.items.some(o => o.kind === 'diamond' && o.orderId === dOrderId));
  assert.ok(ordersRes.data.items.some(o => o.kind === 'coin' && o.orderId === cOrderId));

  // Manual approve Diamond order + verify idempotent replay
  const approveRes = await apiJson(`/api/admin/finance/orders/diamond/${dOrderId}/approve`, {
    method: 'POST',
    token: adminAuth.token,
    body: { reason: 'Mutasi BCA terkonfirmasi' }
  });
  assert.equal(approveRes.status, 200);
  assert.equal(approveRes.data.order.status, 'PAID');
  assert.equal(approveRes.data.wallet.diamonds, 10);

  const approveReplay = await apiJson(`/api/admin/finance/orders/diamond/${dOrderId}/approve`, {
    method: 'POST',
    token: adminAuth.token,
    body: { reason: 'Replay approval' }
  });
  assert.equal(approveReplay.status, 200);
  assert.equal(approveReplay.data.alreadyCredited, true);
  assert.equal(approveReplay.data.wallet.diamonds, 10);

  // Cancel Coin order
  const cancelRes = await apiJson(`/api/admin/finance/orders/coin/${cOrderId}/cancel`, {
    method: 'POST',
    token: adminAuth.token,
    body: { reason: 'Batal oleh test' }
  });
  assert.equal(cancelRes.status, 200);
  assert.equal(cancelRes.data.order.status, 'CANCELLED');

  // Adjust Coins & Diamonds
  const adjCoins = await apiJson('/api/admin/finance/adjust', {
    method: 'POST',
    token: adminAuth.token,
    body: { targetUser: playerAuth.user.username, currency: 'coins', mode: 'delta', amount: 150, reason: 'Hadiah event' }
  });
  assert.equal(adjCoins.status, 200);
  assert.equal(adjCoins.data.currentCoins, 350); // starter 200 + 150

  const adjDiamonds = await apiJson('/api/admin/finance/adjust', {
    method: 'POST',
    token: adminAuth.token,
    body: { targetUser: playerAuth.user.id, currency: 'diamonds', txType: 'REFUND', amount: 5, reason: 'Refund uji' }
  });
  assert.equal(adjDiamonds.status, 200);
  assert.equal(adjDiamonds.data.wallet.diamonds, 15);

  // Finance summary, ledger & CSV export
  const finSummary = await apiJson('/api/admin/finance/summary', { token: adminAuth.token });
  assert.equal(finSummary.status, 200);
  assert.ok(finSummary.data.summary.totalRevenueIdr >= 5000);
  assert.equal(finSummary.data.summary.recentDailyRevenue.length, 7);

  const ledgerRes = await apiJson('/api/admin/finance/ledger', { token: adminAuth.token });
  assert.equal(ledgerRes.status, 200);
  assert.ok(ledgerRes.data.total >= 2);

  const csvRes = await apiJson('/api/admin/finance/orders/export', { token: adminAuth.token });
  assert.equal(csvRes.status, 200);
  assert.ok(csvRes.headers.get('content-type').includes('text/csv'));
  assert.ok(csvRes.rawText.includes(dOrderId));
  assert.ok(csvRes.rawText.includes(cOrderId));

  // Delete target user and verify complete removal
  const delRes = await apiJson(`/api/admin/users/${targetId}`, {
    method: 'DELETE',
    token: adminAuth.token
  });
  assert.equal(delRes.status, 200);

  const afterDelDetail = await apiJson(`/api/admin/users/${targetId}`, { token: adminAuth.token });
  assert.equal(afterDelDetail.status, 404);
});
