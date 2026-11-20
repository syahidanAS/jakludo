'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io: ioClient } = require('socket.io-client');

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
const quizStore = require('../quiz/store');
const chessEngine = require('../chess/engine');
const chessStore = require('../chess/store');
const snakesEngine = require('../snakes/engine');
const snakesStore = require('../snakes/store');

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
    body: { username, email: `${username}@playgo.test`, password: 'Rahasia#123', name: username }
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

test('POST /api/admin/register-basic enforces HTTP Basic Auth and always registers admin accounts', async () => {
  const prevUser = process.env.BASIC_AUTH_REGISTER_USER;
  const prevPass = process.env.BASIC_AUTH_REGISTER_PASS;

  try {
    // 1. Belum dikonfigurasi -> 503
    delete process.env.BASIC_AUTH_REGISTER_USER;
    delete process.env.BASIC_AUTH_REGISTER_PASS;
    const unconfigured = await apiJson('/api/admin/register-basic', {
      method: 'POST',
      body: { username: 'pm_admin_0', password: 'Password#123' }
    });
    assert.equal(unconfigured.status, 503);

    // Set kredensial termasuk simbol ":" pada password untuk menguji parsing yang benar
    process.env.BASIC_AUTH_REGISTER_USER = 'postman_client';
    process.env.BASIC_AUTH_REGISTER_PASS = 'Rahasia:Postman#2026';

    // 2. Tanpa header Authorization -> 401 + WWW-Authenticate
    const noAuth = await apiJson('/api/admin/register-basic', {
      method: 'POST',
      body: { username: 'pm_admin_0', password: 'Password#123' }
    });
    assert.equal(noAuth.status, 401);
    assert.ok(noAuth.headers.get('www-authenticate')?.includes('Basic'));

    // 3. Password salah -> 401
    const badCreds = Buffer.from('postman_client:salah', 'utf8').toString('base64');
    const badAuthRes = await fetch(`${url}/api/admin/register-basic`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${badCreds}`
      },
      body: JSON.stringify({ username: 'pm_admin_0', password: 'Password#123' })
    });
    assert.equal(badAuthRes.status, 401);

    // 4. Valid Basic Auth + register admin; meski body mengirim role: 'player', tetap dipaksa role: 'admin'
    const goodCreds = Buffer.from('postman_client:Rahasia:Postman#2026', 'utf8').toString('base64');
    const okRes = await fetch(`${url}/api/admin/register-basic`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${goodCreds}`
      },
      body: JSON.stringify({
        username: 'postman_admin1',
        password: 'AdminPass#123',
        name: 'Postman Admin',
        email: 'admin1@playgo.id',
        role: 'player',
        coins: 450,
        diamonds: 12
      })
    });
    const okData = await okRes.json();
    assert.equal(okRes.status, 201, `Gagal admin register-basic: ${JSON.stringify(okData)}`);
    assert.equal(okData.success, true);
    assert.equal(okData.message, 'Akun admin berhasil didaftarkan.');
    assert.equal(okData.user.username, 'postman_admin1');
    assert.equal(okData.user.name, 'Postman Admin');
    assert.equal(okData.user.email, 'admin1@playgo.id');
    assert.equal(okData.user.role, 'admin');
    assert.equal(okData.user.isAdmin, true);
    assert.equal(okData.user.points, 450);
    assert.equal(okData.user.diamonds, 12);

    // 5. Pastikan admin baru bisa langsung login via /api/auth/login dan mengakses endpoint CMS admin
    const loginCheck = await apiJson('/api/auth/login', {
      method: 'POST',
      body: { username: 'postman_admin1', password: 'AdminPass#123' }
    });
    assert.equal(loginCheck.status, 200);
    assert.ok(loginCheck.data.token, 'Harus mengembalikan token session admin');
    assert.equal(loginCheck.data.user.username, 'postman_admin1');
    assert.equal(loginCheck.data.user.role, 'admin');
    assert.equal(loginCheck.data.user.isAdmin, true);

    const overviewCheck = await apiJson('/api/admin/overview', {
      token: loginCheck.data.token
    });
    assert.equal(overviewCheck.status, 200);
    assert.equal(overviewCheck.data.success, true);

    // 6. Duplikat username ditolak 400
    const dupRes = await fetch(`${url}/api/admin/register-basic`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${goodCreds}`
      },
      body: JSON.stringify({
        username: 'postman_admin1',
        password: 'AdminPass#123'
      })
    });
    assert.equal(dupRes.status, 400);
  } finally {
    if (prevUser === undefined) delete process.env.BASIC_AUTH_REGISTER_USER;
    else process.env.BASIC_AUTH_REGISTER_USER = prevUser;
    if (prevPass === undefined) delete process.env.BASIC_AUTH_REGISTER_PASS;
    else process.env.BASIC_AUTH_REGISTER_PASS = prevPass;
  }
});

test('Akun role admin (db role & ADMIN_USERNAMES) tidak ditampilkan di seluruh leaderboard', async () => {
  const prevAdminUsernames = process.env.ADMIN_USERNAMES;

  try {
    const regularAuth = await registerPlayer('lb_regular');
    const adminRoleAuth = await registerPlayer('lb_admin_role');
    await db.setUserRole(adminRoleAuth.user.id, 'admin');

    const envAdminAuth = await registerPlayer('lb_env_admin');
    process.env.ADMIN_USERNAMES = `${prevAdminUsernames || 'admin'},${envAdminAuth.user.username}`;

    // 1. JakLudo: beri poin & kemenangan lebih tinggi untuk kedua admin dibanding pemain biasa
    await db.setUserPoints(adminRoleAuth.user.id, 99999);
    await db.setUserPoints(envAdminAuth.user.id, 88888);

    const awards1 = db.recordMatchResult({
      winnerPlayerId: 'p_admin',
      players: [
        { id: 'p_admin', userId: adminRoleAuth.user.id, isBot: false },
        { id: 'p_reg', userId: regularAuth.user.id, isBot: false }
      ]
    });
    db.recordMatchResult({
      winnerPlayerId: 'p_reg',
      players: [
        { id: 'p_reg', userId: regularAuth.user.id, isBot: false },
        { id: 'p_env', userId: envAdminAuth.user.id, isBot: false }
      ]
    });

    const ludoLbRes = await apiJson('/api/leaderboard');
    assert.equal(ludoLbRes.status, 200);
    assert.equal(ludoLbRes.data.leaderboard.some(e => e.userId === adminRoleAuth.user.id), false);
    assert.equal(ludoLbRes.data.leaderboard.some(e => e.userId === envAdminAuth.user.id), false);

    const regularLudoRow = ludoLbRes.data.leaderboard.find(e => e.userId === regularAuth.user.id);
    assert.ok(regularLudoRow, 'Pemain biasa harus muncul di leaderboard JakLudo');
    assert.equal(db.checkIsLudoKing(adminRoleAuth.user.id), false);
    assert.equal(db.checkIsLudoKing(envAdminAuth.user.id), false);
    assert.equal(db.checkIsLudoKing(regularAuth.user.id), ludoLbRes.data.leaderboard[0]?.userId === regularAuth.user.id);

    // Pastikan saldo Coins & profil publik admin tetap terjaga meski disembunyikan dari leaderboard
    const expectedAdminPoints = 99999 + Number(awards1?.p_admin?.points || 0) + Number(awards1?.p_admin?.dailyBonus || 0);
    assert.equal(db.getUserPoints(adminRoleAuth.user.id), expectedAdminPoints);
    const adminPubRes = await apiJson(`/api/users/${adminRoleAuth.user.username}/profile`);
    assert.equal(adminPubRes.status, 200);
    assert.equal(adminPubRes.data.profile.points, expectedAdminPoints);
    assert.equal(adminPubRes.data.profile.rank, null);
    assert.equal(adminPubRes.data.profile.isLudoKing, false);

    // 2. Monster Quiz Battle: admin menang duel melawan pemain biasa
    quizStore.recordMatchFinished({
      matchId: 'q_lb_test_1',
      roomId: 'qr_lb_1',
      winnerUserId: adminRoleAuth.user.id,
      endReason: 'hp_zero',
      maxRounds: 5,
      roundsPlayed: 2,
      startedAt: Date.now() - 15000,
      players: [
        { userId: adminRoleAuth.user.id, slot: 0, monsterId: 'emberon', hp: 80, correctAnswers: 2, forfeited: false },
        { userId: regularAuth.user.id, slot: 1, monsterId: 'aquaris', hp: 0, correctAnswers: 0, forfeited: false }
      ]
    });

    const quizLbRes = await apiJson('/api/quiz/leaderboard');
    assert.equal(quizLbRes.status, 200);
    assert.equal(quizLbRes.data.leaderboard.some(e => e.userId === adminRoleAuth.user.id), false);
    const regularQuizRow = quizLbRes.data.leaderboard.find(e => e.userId === regularAuth.user.id);
    assert.ok(regularQuizRow, 'Pemain biasa harus tetap tampil di leaderboard Monster Quiz');
    assert.equal(regularQuizRow.rank, 1);

    // 3. Chess Master: admin menang match kompetitif melawan pemain biasa
    chessStore.createMatchRecord({
      id: 'chess_lb_test_1',
      whitePlayerId: adminRoleAuth.user.id,
      blackPlayerId: regularAuth.user.id,
      initialFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      whiteRemainingTimeMs: 300000,
      blackRemainingTimeMs: 300000
    });
    chessStore.finalizeMatchRecord({
      matchId: 'chess_lb_test_1',
      result: '1-0',
      winnerUserId: adminRoleAuth.user.id,
      terminationReason: 'checkmate',
      whiteRemainingTimeMs: 280000,
      blackRemainingTimeMs: 270000
    });

    const chessLbRes = await apiJson('/api/chess/leaderboard', { token: adminRoleAuth.token });
    assert.equal(chessLbRes.status, 200);
    assert.equal(chessLbRes.data.entries.some(e => e.userId === adminRoleAuth.user.id), false);
    assert.equal(chessLbRes.data.myEntry, null);
    const regularChessRow = chessLbRes.data.entries.find(e => e.userId === regularAuth.user.id);
    assert.ok(regularChessRow, 'Pemain biasa harus tetap tampil di leaderboard Chess Master');

    // 4. Snakes & Ladders: admin menang match melawan pemain biasa
    snakesStore.recordCompletedMatch({
      id: 'snk_room_lb_1',
      code: 'SNKLB1',
      startedAt: Date.now() - 20000,
      finishedAt: Date.now(),
      turnNumber: 8,
      finishReason: 'finish',
      moveLog: [1, 2, 3, 4, 5, 6],
      winnerPlayerId: 'sp_admin',
      winnerUserId: adminRoleAuth.user.id,
      players: [
        { id: 'sp_admin', player_type: 'human', user_id: adminRoleAuth.user.id, display_name: adminRoleAuth.user.username },
        { id: 'sp_reg', player_type: 'human', user_id: regularAuth.user.id, display_name: regularAuth.user.username }
      ]
    });

    const snakesLbRes = await apiJson('/api/games/snakes-and-ladders/leaderboard', { token: adminRoleAuth.token });
    assert.equal(snakesLbRes.status, 200);
    assert.equal(snakesLbRes.data.entries.some(e => e.userId === adminRoleAuth.user.id), false);
    assert.equal(snakesLbRes.data.myEntry, null);
    const regularSnakesRow = snakesLbRes.data.entries.find(e => e.userId === regularAuth.user.id);
    assert.ok(regularSnakesRow, 'Pemain biasa harus tetap tampil di leaderboard Ular Tangga');
    assert.equal(regularSnakesRow.rank, 1);

    // 5. Group Leaderboard: admin masuk grup, namun tidak tampil di leaderboard grup
    const createGroupRes = await apiJson('/api/groups', {
      method: 'POST',
      token: regularAuth.token,
      body: { name: 'Grup Tes Leaderboard' }
    });
    assert.equal(createGroupRes.status, 200);
    const groupId = createGroupRes.data.group.id;

    const inviteRes = await apiJson(`/api/groups/${groupId}/invites`, {
      method: 'POST',
      token: regularAuth.token,
      body: { username: adminRoleAuth.user.username }
    });
    assert.equal(inviteRes.status, 200);

    const acceptRes = await apiJson(`/api/group-invites/${inviteRes.data.invite.id}/accept`, {
      method: 'POST',
      token: adminRoleAuth.token
    });
    assert.equal(acceptRes.status, 200);

    const grpLbRes = await apiJson(`/api/groups/${groupId}/leaderboard`, { token: regularAuth.token });
    assert.equal(grpLbRes.status, 200);
    assert.equal(grpLbRes.data.leaderboard.some(e => e.userId === adminRoleAuth.user.id), false);
    assert.equal(grpLbRes.data.leaderboard.length, 1);
    assert.equal(grpLbRes.data.leaderboard[0].userId, regularAuth.user.id);
    assert.equal(grpLbRes.data.leaderboard[0].rank, 1);

    const grpQueryRes = await apiJson(`/api/leaderboard?groupId=${groupId}`, { token: adminRoleAuth.token });
    assert.equal(grpQueryRes.status, 200);
    assert.equal(grpQueryRes.data.leaderboard.some(e => e.userId === adminRoleAuth.user.id), false);
    assert.equal(grpQueryRes.data.leaderboard[0].userId, regularAuth.user.id);
  } finally {
    if (prevAdminUsernames === undefined) delete process.env.ADMIN_USERNAMES;
    else process.env.ADMIN_USERNAMES = prevAdminUsernames;
  }
});

test('Admin stealth live room spectator memantau 4 game realtime tanpa diketahui pemain', async () => {
  const sockets = [];
  const connectSocket = () =>
    new Promise((resolve, reject) => {
      const s = ioClient(url, { forceNew: true, transports: ['websocket'] });
      sockets.push(s);
      s.once('connect', () => resolve(s));
      s.once('connect_error', reject);
    });
  const emitAck = (s, ev, payload) => new Promise(resolve => s.emit(ev, payload, res => resolve(res)));
  const onceEvent = (s, ev, timeoutMs = 4000) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        s.off(ev, handler);
        reject(new Error(`Timeout menunggu event ${ev}`));
      }, timeoutMs);
      const handler = data => {
        clearTimeout(t);
        resolve(data);
      };
      s.once(ev, handler);
    });
  const wait = ms => new Promise(r => setTimeout(r, ms));

  try {
    const adminAuth = await registerPlayer('stealth_admin');
    await db.setUserRole(adminAuth.user.id, 'admin');
    const p1 = await registerPlayer('stealth_p1');
    const p2 = await registerPlayer('stealth_p2');

    // 1. Tolak socket tanpa token & non-admin
    const unauthSock = await connectSocket();
    const unauthJoin = await emitAck(unauthSock, 'admin:watch:join', { game: 'ludo', code: 'ZZZZZ' });
    assert.equal(unauthJoin.ok, false);

    const playerWatchSock = await connectSocket();
    const playerWatchJoin = await emitAck(playerWatchSock, 'admin:watch:join', {
      token: p1.token,
      game: 'ludo',
      code: 'ZZZZZ'
    });
    assert.equal(playerWatchJoin.ok, false);

    // 2. JakLudo: 2 pemain main, admin masuk mode senyap -> pemain tidak menerima event apa pun
    const s1 = await connectSocket();
    const s2 = await connectSocket();

    const p1Created = onceEvent(s1, 'room:joined');
    const p1InitUpdate = onceEvent(s1, 'room:update');
    s1.emit('room:create', { token: p1.token });
    const ludoJoined1 = await p1Created;
    await p1InitUpdate;
    const ludoCode = ludoJoined1.code;

    const p2Joined = onceEvent(s2, 'room:joined');
    const p1SawP2 = onceEvent(s1, 'room:update');
    const p2InitUpdate = onceEvent(s2, 'room:update');
    s2.emit('room:join', { code: ludoCode, token: p2.token });
    await Promise.all([p2Joined, p1SawP2, p2InitUpdate]);
    await wait(30);

    const p1EventsAfterWatch = [];
    const p2EventsAfterWatch = [];
    s1.onAny((ev, data) => p1EventsAfterWatch.push({ ev, data }));
    s2.onAny((ev, data) => p2EventsAfterWatch.push({ ev, data }));

    const adminSock = await connectSocket();
    const ludoWatchRes = await emitAck(adminSock, 'admin:watch:join', {
      token: adminAuth.token,
      game: 'ludo',
      code: ludoCode
    });
    assert.equal(ludoWatchRes.ok, true);
    assert.equal(ludoWatchRes.state.code, ludoCode);
    assert.equal(ludoWatchRes.state.players.length, 2);

    await wait(120);
    // Tidak boleh ada notifikasi/member_joined/room:update ke pemain akibat admin masuk
    assert.equal(p1EventsAfterWatch.length, 0);
    assert.equal(p2EventsAfterWatch.length, 0);

    // Pemain mulai main, kirim chat, dan kirim reaksi -> admin menerima live
    const watchStatePromise = onceEvent(adminSock, 'admin:watch:state');
    s1.emit('game:start');
    const ludoStartedUpdate = await watchStatePromise;
    assert.equal(ludoStartedUpdate.game, 'ludo');
    assert.equal(ludoStartedUpdate.code, ludoCode);
    assert.equal(ludoStartedUpdate.state.started, true);

    const watchChatPromise = onceEvent(adminSock, 'admin:watch:chat');
    s1.emit('room:chat', { text: 'Halo sesama pemain' });
    const ludoWatchChat = await watchChatPromise;
    assert.equal(ludoWatchChat.message.text, 'Halo sesama pemain');

    const watchReactionPromise = onceEvent(adminSock, 'admin:watch:reaction');
    s2.emit('game:reaction', { emoji: '🔥' });
    const ludoWatchReaction = await watchReactionPromise;
    assert.equal(ludoWatchReaction.reaction.emoji, '🔥');

    // Admin keluar dari mode pantau -> pemain tidak mendapat event apa pun & room tetap berjalan
    p1EventsAfterWatch.length = 0;
    p2EventsAfterWatch.length = 0;
    const leaveWatchRes = await emitAck(adminSock, 'admin:watch:leave', {});
    assert.equal(leaveWatchRes.ok, true);
    await wait(80);
    assert.equal(p1EventsAfterWatch.length, 0);
    assert.equal(p2EventsAfterWatch.length, 0);
    assert.equal(store.rooms.get(ludoCode)?.started, true);

    // Bersihkan room Ludo
    s1.emit('room:leave', { code: ludoCode });
    s2.emit('room:leave', { code: ludoCode });
    await wait(80);

    // 3. Chess Master: 2 pemain main, admin memantau move & chat secara senyap
    const cs1 = await connectSocket();
    const cs2 = await connectSocket();
    const chessCreate = await emitAck(cs1, 'chess:room:create', {
      token: p1.token,
      timeControl: '5+0',
      colorPreference: 'w'
    });
    assert.equal(chessCreate.ok, true);
    const chessCode = chessCreate.room.code;

    const chessJoin = await emitAck(cs2, 'chess:room:join', { code: chessCode, token: p2.token });
    assert.equal(chessJoin.ok, true);
    await emitAck(cs1, 'chess:player:ready', { code: chessCode, token: p1.token, ready: true });
    const chessStart = await emitAck(cs2, 'chess:player:ready', { code: chessCode, token: p2.token, ready: true });
    assert.equal(chessStart.ok, true);
    const chessMatchId = chessEngine.chessRooms.get(chessCode)?.match?.id;
    assert.ok(chessMatchId);
    await wait(30);

    const chessPlayerEvents = [];
    cs1.onAny((ev, data) => chessPlayerEvents.push({ ev, data }));

    const chessWatchRes = await emitAck(adminSock, 'admin:watch:join', {
      token: adminAuth.token,
      game: 'chess',
      code: chessCode
    });
    assert.equal(chessWatchRes.ok, true);
    assert.equal(chessWatchRes.state.phase, 'playing');

    await wait(80);
    assert.equal(chessPlayerEvents.length, 0);

    const chessMoveWatch = onceEvent(adminSock, 'admin:watch:state');
    const moveRes = await emitAck(cs1, 'chess:move', {
      code: chessCode,
      matchId: chessMatchId,
      token: p1.token,
      from: 'e2',
      to: 'e4',
      moveVersion: 0
    });
    assert.equal(moveRes.ok, true);
    const chessUpdate = await chessMoveWatch;
    assert.equal(chessUpdate.state.match.moves.length, 1);
    assert.equal(chessUpdate.state.match.moves[0].san, 'e4');

    const chessChatWatch = onceEvent(adminSock, 'admin:watch:chat');
    const chessChatAck = await emitAck(cs1, 'chess:chat', { code: chessCode, token: p1.token, text: 'GG catur' });
    assert.equal(chessChatAck.ok, true);
    const chessChatEvt = await chessChatWatch;
    assert.equal(chessChatEvt.message.text, 'GG catur');

    chessEngine.adminCloseRoom(chessCode, 'Selesai uji stealth chess');

    // 4. Snakes & Ladders: admin memantau lemparan dadu & chat secara senyap
    const ss1 = await connectSocket();
    const ss2 = await connectSocket();
    const snakesCreate = await emitAck(ss1, 'snakes:room:create', { token: p1.token, maxPlayers: 2 });
    assert.equal(snakesCreate.ok, true);
    const snakesCode = snakesCreate.room.roomCode;

    const snakesJoin = await emitAck(ss2, 'snakes:room:join', { token: p2.token, code: snakesCode });
    assert.equal(snakesJoin.ok, true);
    const snakesStart = await emitAck(ss1, 'snakes:room:start', { token: p1.token, roomCode: snakesCode });
    assert.equal(snakesStart.ok, true);
    await wait(30);

    const snakesPlayerEvents = [];
    ss1.onAny((ev, data) => snakesPlayerEvents.push({ ev, data }));

    const snakesWatchRes = await emitAck(adminSock, 'admin:watch:join', {
      token: adminAuth.token,
      game: 'snakes',
      code: snakesCode
    });
    assert.equal(snakesWatchRes.ok, true);
    assert.equal(snakesWatchRes.state.status, 'playing');
    await wait(80);
    assert.equal(snakesPlayerEvents.length, 0);

    const snakesRollWatch = onceEvent(adminSock, 'admin:watch:state');
    const rollAck = await emitAck(ss1, 'snakes:roll', { token: p1.token, roomCode: snakesCode });
    assert.equal(rollAck.ok, true);
    const snakesStateUpdate = await snakesRollWatch;
    assert.ok(snakesStateUpdate.state.turnNumber >= 1);

    const snakesChatWatch = onceEvent(adminSock, 'admin:watch:chat');
    const snakesChatAck = await emitAck(ss1, 'snakes:chat', { token: p1.token, roomCode: snakesCode, text: 'Naik tangga!' });
    assert.equal(snakesChatAck.ok, true);
    const snakesChatEvt = await snakesChatWatch;
    assert.equal(snakesChatEvt.message.text, 'Naik tangga!');

    snakesEngine.adminCloseRoom(snakesCode, 'Selesai uji stealth snakes');

    // 5. Monster Quiz: admin memantau live chat & menerima event admin:watch:closed saat room ditutup
    const qs1 = await connectSocket();
    const quizCreate = await emitAck(qs1, 'quiz:room:create', { token: p1.token, monsterId: 'emberon' });
    assert.equal(quizCreate.ok, true);
    const quizCode = quizCreate.code || quizCreate.room?.code;
    assert.ok(quizCode);

    const quizWatchRes = await emitAck(adminSock, 'admin:watch:join', {
      token: adminAuth.token,
      game: 'quiz',
      code: quizCode
    });
    assert.equal(quizWatchRes.ok, true);
    assert.equal(quizWatchRes.state.code, quizCode);

    const quizChatWatch = onceEvent(adminSock, 'admin:watch:chat');
    const quizChatAck = await emitAck(qs1, 'quiz:chat', { token: p1.token, code: quizCode, text: 'Siap duel kuis' });
    assert.equal(quizChatAck.ok, true);
    const quizChatEvt = await quizChatWatch;
    assert.equal(quizChatEvt.message.text, 'Siap duel kuis');

    const closedWatchPromise = onceEvent(adminSock, 'admin:watch:closed');
    const closeApiRes = await apiJson(`/api/admin/rooms/quiz/${quizCode}/close`, {
      method: 'POST',
      token: adminAuth.token,
      body: { reason: 'Tutup setelah inspeksi live' }
    });
    assert.equal(closeApiRes.status, 200);
    const closedWatchEvt = await closedWatchPromise;
    assert.equal(closedWatchEvt.game, 'quiz');
    assert.equal(closedWatchEvt.code, quizCode);
    assert.equal(closedWatchEvt.reason, 'Tutup setelah inspeksi live');
  } finally {
    for (const s of sockets) {
      try {
        s.close();
      } catch {}
    }
  }
});
