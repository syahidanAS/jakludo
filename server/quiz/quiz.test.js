'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jakludo-quiz-test-'));
process.env.JAKLUDO_DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';

const { io: ioClient } = require('socket.io-client');
const { server, shutdown } = require('../index');
const db = require('../db');
const quizEngine = require('./engine');
const { SEED_QUESTIONS, buildRoundQuestionPayload } = require('./questions');
const { MONSTERS: QUIZ_MONSTERS, INITIAL_HP, ATTACK_DAMAGE } = require('./monsters');

let url;
const clients = [];

test.before(async () => {
  quizEngine.setTimings({
    countdownMs: 30,
    questionDurationMs: 250,
    roundTransitionMs: 40,
    disconnectGraceMs: 2000,
    maxRounds: 20
  });
  await new Promise(resolve => server.listen(0, resolve));
  url = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  clients.forEach(c => c.close());
  quizEngine.stopAllTimers();
  shutdown();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function connect() {
  const c = ioClient(url, { forceNew: true, transports: ['websocket'] });
  clients.push(c);
  return new Promise(resolve => c.on('connect', () => resolve(c)));
}

function once(c, event, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for event ${event}`)), timeoutMs);
    c.once(event, payload => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function emitAck(c, event, payload) {
  return new Promise(resolve => {
    c.emit(event, payload, res => resolve(res));
  });
}

let userCounter = 0;
async function registerUser(prefix = 'qp') {
  userCounter += 1;
  const username = `${prefix}_${userCounter}_${Date.now().toString(36).slice(-3)}`.slice(0, 20);
  const res = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      email: `${username}@playgo.test`,
      password: 'Password#123',
      name: `Player ${userCounter}`
    })
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.token);
  return body;
}

test('Bank Soal & Katalog Monster: minimal 180 soal tervalidasi (120 umum & 60 matematika) dan 6 monster 100 HP', () => {
  assert.equal(QUIZ_MONSTERS.length, 6);
  for (const m of QUIZ_MONSTERS) {
    assert.equal(m.baseHp, 100);
    assert.ok(m.id && m.name && m.description);
  }
  assert.ok(SEED_QUESTIONS.length >= 180, `Expected >=180 questions, got ${SEED_QUESTIONS.length}`);
  const generalCount = SEED_QUESTIONS.filter(q => q.category === 'general').length;
  const mathCount = SEED_QUESTIONS.filter(q => q.category === 'math').length;
  assert.ok(generalCount >= 120, `Expected >=120 general questions, got ${generalCount}`);
  assert.ok(mathCount >= 60, `Expected >=60 math questions, got ${mathCount}`);

  for (const q of SEED_QUESTIONS) {
    const roundQ = buildRoundQuestionPayload(q, 1, 20, Date.now(), Date.now() + 15000);
    assert.equal(roundQ.clientQuestion.options.length, 4);
    assert.equal(roundQ.clientQuestion.correctIndex, undefined, 'correctIndex tidak boleh bocor ke clientQuestion');
    assert.equal(roundQ.clientQuestion.options[roundQ.shuffledCorrectIndex], q.options[q.correctIndex]);
  }
});

test('Skenario 1, 2, 3, 4: Pembuatan room, join room, hingga maksimal 3 pemain dalam 1 room (pemain ke-4 ditolak), dan pemilihan monster', async () => {
  const u1 = await registerUser('host');
  const u2 = await registerUser('guest');
  const u3 = await registerUser('third');
  const u4 = await registerUser('extra');

  const s1 = await connect();
  const s2 = await connect();
  const s3 = await connect();
  const s4 = await connect();

  const createdPromise = once(s1, 'room.created');
  const createAck = await emitAck(s1, 'quiz:room:create', { token: u1.token, monsterId: 'emberon' });
  const created = await createdPromise;

  assert.equal(createAck.ok, true);
  assert.equal(created.roomCode.length, 5);
  assert.equal(created.room.players.length, 1);
  assert.equal(created.room.players[0].monsterId, 'emberon');
  assert.equal(created.room.players[0].hp, INITIAL_HP);

  const code = created.roomCode;
  const joinedPromise = once(s2, 'room.joined');
  const joinAck = await emitAck(s2, 'quiz:room:join', { token: u2.token, code, monsterId: 'aquaris' });
  const joined = await joinedPromise;

  assert.equal(joinAck.ok, true);
  assert.equal(joined.roomCode, code);
  assert.equal(joined.room.players.length, 2);

  // Pemain ke-3 dapat bergabung (maksimal 3 pemain)
  const join3Ack = await emitAck(s3, 'quiz:room:join', { token: u3.token, code, monsterId: 'terragon' });
  assert.equal(join3Ack.ok, true);
  assert.equal(join3Ack.room.players.length, 3);

  // Pemain ke-4 ditolak karena kapasitas maksimal 3 pemain
  const join4Ack = await emitAck(s4, 'quiz:room:join', { token: u4.token, code });
  assert.equal(join4Ack.ok, false);
  assert.match(join4Ack.error, /penuh/i);

  // Pemilihan monster valid & invalid
  const statePromise = once(s1, 'quiz:room:state');
  const selectAck = await emitAck(s1, 'quiz:monster:select', { token: u1.token, code, monsterId: 'voltix' });
  assert.equal(selectAck.ok, true);
  const updatedState = await statePromise;
  const p1 = updatedState.players.find(p => p.slot === 0);
  assert.equal(p1.monsterId, 'voltix');

  const badMonsterAck = await emitAck(s1, 'quiz:monster:select', { token: u1.token, code, monsterId: 'unknown_monster' });
  assert.equal(badMonsterAck.ok, false);
  assert.match(badMonsterAck.error, /monster/i);

  await emitAck(s1, 'quiz:room:leave', { token: u1.token, code });
  await emitAck(s2, 'quiz:room:leave', { token: u2.token, code });
  await emitAck(s3, 'quiz:room:leave', { token: u3.token, code });
});

test('Skenario 6, 7, 8, 9, 10, 11, 12: Evaluasi aturan battle (1 benar 1 salah, keduanya benar, keduanya salah, timeout 1 pemain, timeout 2 pemain, damage 10 HP, HP tidak pernah negatif)', () => {
  // Skenario 6: A benar, B salah -> A serang B (-10 HP)
  const r6 = quizEngine.evaluateRoundOutcome({
    p0Correct: true,
    p1Correct: false,
    p0Hp: 100,
    p1Hp: 100,
    p0UserId: 'u0',
    p1UserId: 'u1'
  });
  assert.equal(r6.outcome, 'p0_attack');
  assert.equal(r6.attackerUserId, 'u0');
  assert.equal(r6.targetUserId, 'u1');
  assert.equal(r6.damage, ATTACK_DAMAGE);
  assert.equal(r6.damage, 10);
  assert.equal(r6.p0HpAfter, 100);
  assert.equal(r6.p1HpAfter, 90);

  // A salah, B benar -> B serang A (-10 HP)
  const r6b = quizEngine.evaluateRoundOutcome({
    p0Correct: false,
    p1Correct: true,
    p0Hp: 100,
    p1Hp: 100,
    p0UserId: 'u0',
    p1UserId: 'u1'
  });
  assert.equal(r6b.outcome, 'p1_attack');
  assert.equal(r6b.attackerUserId, 'u1');
  assert.equal(r6b.targetUserId, 'u0');
  assert.equal(r6b.damage, 10);
  assert.equal(r6b.p0HpAfter, 90);
  assert.equal(r6b.p1HpAfter, 100);

  // Skenario 7: Keduanya salah -> tidak ada serangan (0 damage)
  const r7 = quizEngine.evaluateRoundOutcome({
    p0Correct: false,
    p1Correct: false,
    p0Hp: 80,
    p1Hp: 70,
    p0UserId: 'u0',
    p1UserId: 'u1'
  });
  assert.equal(r7.outcome, 'both_wrong');
  assert.equal(r7.attackerUserId, null);
  assert.equal(r7.targetUserId, null);
  assert.equal(r7.damage, 0);
  assert.equal(r7.p0HpAfter, 80);
  assert.equal(r7.p1HpAfter, 70);

  // Skenario 8: Keduanya benar -> tidak ada serangan (0 damage)
  const r8 = quizEngine.evaluateRoundOutcome({
    p0Correct: true,
    p1Correct: true,
    p0Hp: 80,
    p1Hp: 70,
    p0UserId: 'u0',
    p1UserId: 'u1'
  });
  assert.equal(r8.outcome, 'both_correct');
  assert.equal(r8.attackerUserId, null);
  assert.equal(r8.targetUserId, null);
  assert.equal(r8.damage, 0);
  assert.equal(r8.p0HpAfter, 80);
  assert.equal(r8.p1HpAfter, 70);

  // Skenario 12: HP tidak pernah negatif (clamped di 0)
  const r12 = quizEngine.evaluateRoundOutcome({
    p0Correct: true,
    p1Correct: false,
    p0Hp: 50,
    p1Hp: 5,
    p0UserId: 'u0',
    p1UserId: 'u1'
  });
  assert.equal(r12.p1HpAfter, 0);
});

test('Skenario 5, 6, 7, 8, 9, 10, 13, 15, 16: Full realtime match, soal identik, anti-duplikat jawaban, timeout, hingga HP mencapai 0 dan isolasi leaderboard Ludo vs Quiz', async () => {
  const u1 = await registerUser('duelistA');
  const u2 = await registerUser('duelistB');
  const s1 = await connect();
  const s2 = await connect();

  const createAck = await emitAck(s1, 'quiz:room:create', { token: u1.token, monsterId: 'emberon' });
  const code = createAck.code;
  await emitAck(s2, 'quiz:room:join', { token: u2.token, code, monsterId: 'frostbite' });

  const qStarted1P = once(s1, 'question.started');
  const qStarted2P = once(s2, 'question.started');
  await emitAck(s1, 'quiz:player:ready', { token: u1.token, code, ready: true });
  await emitAck(s2, 'quiz:player:ready', { token: u2.token, code, ready: true });

  const [q1A, q1B] = await Promise.all([qStarted1P, qStarted2P]);

  // Skenario 5: Kedua pemain menerima soal yang persis sama dan tanpa jawaban benar
  assert.equal(q1A.roundNo, 1);
  assert.equal(q1A.question.id, q1B.question.id);
  assert.deepEqual(q1A.question.options, q1B.question.options);
  assert.equal(q1A.question.correctIndex, undefined);

  const internalRoom = quizEngine.quizRooms.get(code);
  assert.ok(internalRoom);
  const round1Correct = internalRoom.match.currentRound.shuffledCorrectIndex;
  const round1Wrong = (round1Correct + 1) % 4;

  // Skenario 15: Anti-duplikat submit jawaban pada ronde yang sama
  const sub1Ack = await emitAck(s1, 'quiz:answer:submit', {
    token: u1.token,
    code,
    roundNo: 1,
    selectedIndex: round1Correct
  });
  assert.equal(sub1Ack.ok, true);

  const dupAck = await emitAck(s1, 'quiz:answer:submit', {
    token: u1.token,
    code,
    roundNo: 1,
    selectedIndex: round1Wrong
  });
  assert.equal(dupAck.ok, false);
  assert.match(dupAck.error, /sudah dikirim/i);

  // Skenario 6: Pemain 1 benar, Pemain 2 salah -> monster.attacked & monster.damaged (-10 HP)
  const attackP = once(s1, 'monster.attacked');
  const damageP = once(s1, 'monster.damaged');
  const result1P = once(s1, 'answer.result');
  const q2P = once(s1, 'question.started');

  await emitAck(s2, 'quiz:answer:submit', {
    token: u2.token,
    code,
    roundNo: 1,
    selectedIndex: round1Wrong
  });

  const [attackEv, damageEv, res1] = await Promise.all([attackP, damageP, result1P]);
  assert.equal(attackEv.attackerSlot, 0);
  assert.equal(damageEv.targetSlot, 1);
  assert.equal(damageEv.damage, 10);
  assert.equal(damageEv.hpAfter, 90);
  assert.equal(res1.hp[u1.user.id], 100);
  assert.equal(res1.hp[u2.user.id], 90);

  // Ronde 2: Skenario 8 (Keduanya benar -> 0 damage)
  const q2 = await q2P;
  assert.equal(q2.roundNo, 2);
  assert.notEqual(q2.question.id, q1A.question.id, 'Pertanyaan tidak boleh berulang dalam 1 match');
  const round2Correct = internalRoom.match.currentRound.shuffledCorrectIndex;

  const res2P = once(s1, 'answer.result');
  const q3P = once(s1, 'question.started');
  await emitAck(s1, 'quiz:answer:submit', { token: u1.token, code, roundNo: 2, selectedIndex: round2Correct });
  await emitAck(s2, 'quiz:answer:submit', { token: u2.token, code, roundNo: 2, selectedIndex: round2Correct });
  const res2 = await res2P;
  assert.equal(res2.damage, 0);
  assert.equal(res2.hp[u1.user.id], 100);
  assert.equal(res2.hp[u2.user.id], 90);

  // Ronde 3: Skenario 7 (Keduanya salah -> 0 damage)
  await q3P;
  const round3Wrong = (internalRoom.match.currentRound.shuffledCorrectIndex + 1) % 4;
  const res3P = once(s1, 'answer.result');
  const q4P = once(s1, 'question.started');
  await emitAck(s1, 'quiz:answer:submit', { token: u1.token, code, roundNo: 3, selectedIndex: round3Wrong });
  await emitAck(s2, 'quiz:answer:submit', { token: u2.token, code, roundNo: 3, selectedIndex: round3Wrong });
  const res3 = await res3P;
  assert.equal(res3.damage, 0);
  assert.equal(res3.hp[u1.user.id], 100);
  assert.equal(res3.hp[u2.user.id], 90);

  // Ronde 4: Skenario 9 (Timeout satu pemain: Pemain 1 benar, Pemain 2 timeout -> Pemain 2 -10 HP jadi 80 HP)
  await q4P;
  const round4Correct = internalRoom.match.currentRound.shuffledCorrectIndex;
  const res4P = once(s1, 'answer.result');
  const q5P = once(s1, 'question.started');
  await emitAck(s1, 'quiz:answer:submit', { token: u1.token, code, roundNo: 4, selectedIndex: round4Correct });
  const res4 = await res4P;
  assert.equal(res4.answers[u2.user.id].timedOut, true);
  assert.equal(res4.damage, 10);
  assert.equal(res4.hp[u2.user.id], 80);

  // Ronde 5: Skenario 10 (Timeout kedua pemain -> 0 damage, HP tetap 100 vs 80)
  await q5P;
  const res5P = once(s1, 'answer.result');
  const q6P = once(s1, 'question.started');
  const res5 = await res5P;
  assert.equal(res5.answers[u1.user.id].timedOut, true);
  assert.equal(res5.answers[u2.user.id].timedOut, true);
  assert.equal(res5.damage, 0);
  assert.equal(res5.hp[u1.user.id], 100);
  assert.equal(res5.hp[u2.user.id], 80);

  // Skenario 13: Lanjutkan sampai HP Pemain 2 mencapai 0 (set HP P2 ke 10 untuk ronde terakhir)
  await q6P;
  internalRoom.players[1].hp = 10;
  const round6Correct = internalRoom.match.currentRound.shuffledCorrectIndex;
  const round6Wrong = (round6Correct + 1) % 4;

  const finishedP = once(s1, 'game.finished');
  await emitAck(s1, 'quiz:answer:submit', { token: u1.token, code, roundNo: 6, selectedIndex: round6Correct });
  await emitAck(s2, 'quiz:answer:submit', { token: u2.token, code, roundNo: 6, selectedIndex: round6Wrong });

  const finished = await finishedP;
  assert.equal(finished.winnerUserId, u1.user.id);
  assert.equal(finished.rewardPoints, quizEngine.WIN_REWARD_POINTS);
  assert.equal(quizEngine.WIN_REWARD_POINTS, 10);
  assert.equal(finished.winnerReward?.points, 10);
  assert.equal(finished.winnerReward?.totalPoints, u1.user.points + 10);
  assert.equal(finished.endReason, 'knockout');
  const finalP2 = finished.players.find(p => p.userId === u2.user.id);
  assert.equal(finalP2.currentHp, 0);

  // Skenario 16: Isolasi data & statistik antara Ludo dan Monster Quiz Battle
  const ludoBoard = await db.getLeaderboard();
  const ludoP1 = ludoBoard.find(u => u.id === u1.user.id);
  assert.equal(ludoP1 ? ludoP1.wins : 0, 0, 'Kemenangan Monster Quiz tidak boleh menambah wins Ludo');

  const statsRes = await fetch(`${url}/api/quiz/stats`, {
    headers: { Authorization: `Bearer ${u1.token}` }
  });
  const statsBody = await statsRes.json();
  assert.equal(statsBody.stats.matchesPlayed, 1);
  assert.equal(statsBody.stats.wins, 1);
  assert.equal(statsBody.stats.losses, 0);
  assert.equal(statsBody.stats.winRate, 100);

  const lbRes = await fetch(`${url}/api/quiz/leaderboard`);
  const lbBody = await lbRes.json();
  assert.ok(Array.isArray(lbBody.leaderboard));
  assert.equal(lbBody.leaderboard[0].userId, u1.user.id);
  assert.equal(lbBody.leaderboard[0].wins, 1);
});

test('Skenario 14: Reconnect saat pertandingan berlangsung memulihkan state tanpa merestart match', async () => {
  quizEngine.setTimings({
    countdownMs: 30,
    questionDurationMs: 5000,
    roundTransitionMs: 40,
    disconnectGraceMs: 2000,
    maxRounds: 20
  });

  const u1 = await registerUser('reconA');
  const u2 = await registerUser('reconB');
  const s1 = await connect();
  const s2 = await connect();

  const createAck = await emitAck(s1, 'quiz:room:create', { token: u1.token, monsterId: 'terragon' });
  const code = createAck.code;
  await emitAck(s2, 'quiz:room:join', { token: u2.token, code, monsterId: 'sylvara' });

  const qStartedP = once(s1, 'question.started');
  await emitAck(s1, 'quiz:player:ready', { token: u1.token, code, ready: true });
  await emitAck(s2, 'quiz:player:ready', { token: u2.token, code, ready: true });
  await qStartedP;

  // Putuskan koneksi s2
  const discEventP = once(s1, 'player.disconnected');
  s2.close();
  const discEv = await discEventP;
  assert.equal(discEv.userId, u2.user.id);

  // Sambungkan kembali menggunakan socket baru dalam masa tenggang
  const s2New = await connect();
  const reconnectedOnS1 = once(s1, 'player.reconnected');
  const stateOnS2New = once(s2New, 'quiz:room:state');
  const rejoinAck = await emitAck(s2New, 'quiz:room:join', { token: u2.token, code });

  const [reconEv, restoredState] = await Promise.all([reconnectedOnS1, stateOnS2New]);
  assert.equal(rejoinAck.ok, true);
  assert.equal(rejoinAck.reconnected, true);
  assert.equal(reconEv.userId, u2.user.id);
  assert.equal(restoredState.code, code);
  assert.equal(restoredState.phase, 'question');
  assert.equal(restoredState.match.roundNo, 1);
  assert.ok(restoredState.match.question);
});

test('Skenario 15: Cari Lawan Cepat bermain dengan bot jika tidak menemukan pemain sungguhan', async () => {
  quizEngine.setTimings({
    countdownMs: 30,
    questionDurationMs: 250,
    roundTransitionMs: 40,
    disconnectGraceMs: 2000,
    botMatchmakingDelayMs: 80,
    maxRounds: 5
  });

  const u = await registerUser('botSeeker');
  const s = await connect();

  const joinedEventP = once(s, 'room.joined');
  const ack = await emitAck(s, 'quiz:matchmaking:join', { token: u.token, monsterId: 'emberon' });
  assert.equal(ack.ok, true);
  assert.equal(ack.matched, false);
  assert.equal(ack.searching, true);

  // Tunggu bot matchmaking memicu pembuatan room
  const joinedPayload = await joinedEventP;
  assert.equal(joinedPayload.matched, true);
  assert.ok(joinedPayload.roomCode);

  const room = quizEngine.quizRooms.get(joinedPayload.roomCode);
  assert.ok(room);
  assert.equal(room.players.length, 2);
  assert.equal(room.players[0].userId, u.user.id);
  assert.ok(room.players[1].isBot);
  assert.equal(room.players[1].ready, true);
  assert.ok(room.players[1].userId.startsWith('bot_'));
  assert.ok(!room.players[1].name.toLowerCase().includes('bot'), 'Nama pemain bot harus organik tanpa kata bot');
});

test('Skenario 16: Cari Lawan Cepat membatalkan pencarian sebelum dipasangkan dengan bot', async () => {
  quizEngine.setTimings({
    botMatchmakingDelayMs: 300
  });

  const u = await registerUser('canceller');
  const s = await connect();

  const ackJoin = await emitAck(s, 'quiz:matchmaking:join', { token: u.token, monsterId: 'emberon' });
  assert.equal(ackJoin.ok, true);
  assert.equal(ackJoin.searching, true);

  const ackLeave = await emitAck(s, 'quiz:matchmaking:leave', { token: u.token });
  assert.equal(ackLeave.ok, true);

  // Tunggu lebih lama dari delay bot
  await new Promise(r => setTimeout(r, 350));
  assert.equal(quizEngine.getActiveRoomForUser(u.user.id), null);
});

test('Skenario 17: Pertandingan melawan bot berjalan otomatis hingga ronde dievaluasi', async () => {
  quizEngine.setTimings({
    countdownMs: 30,
    questionDurationMs: 200,
    roundTransitionMs: 40,
    botMatchmakingDelayMs: 50,
    maxRounds: 3
  });

  const u = await registerUser('botPlayer');
  const s = await connect();

  const joinedEventP = once(s, 'room.joined');
  await emitAck(s, 'quiz:matchmaking:join', { token: u.token, monsterId: 'aquaris' });
  const joinedPayload = await joinedEventP;
  const code = joinedPayload.roomCode;

  // Pemain manusia klik siap -> langsung mulai karena bot sudah siap
  const questionP = once(s, 'question.started');
  await emitAck(s, 'quiz:player:ready', { token: u.token, code, ready: true });
  const qPayload = await questionP;
  assert.equal(qPayload.roundNo, 1);

  // Hasil ronde diterima baik setelah submit atau setelah timeout bot
  const ansResultP = once(s, 'answer.result');
  // Pemain submit jawaban index 0
  await emitAck(s, 'quiz:answer:submit', { token: u.token, code, roundId: qPayload.roundId, selectedIndex: 0 });

  const result = await ansResultP;
  assert.equal(result.roundNo, 1);
  assert.ok(result.answers);
  const botUserId = Object.keys(result.answers).find(id => id.startsWith('bot_'));
  assert.ok(botUserId, 'Bot harus tercatat pada hasil ronde');
});

// ---------- Anti-curang & aturan poin ----------

test('Pemain tidak bisa mengeluarkan lawan dari room lewat userId palsu', async () => {
  const u1 = await registerUser('host');
  const u2 = await registerUser('korban');
  const s1 = await connect();
  const s2 = await connect();
  const sAnon = await connect();

  const createAck = await emitAck(s1, 'quiz:room:create', { token: u1.token, monsterId: 'emberon' });
  const code = createAck.code;
  await emitAck(s2, 'quiz:room:join', { token: u2.token, code, monsterId: 'aquaris' });

  // Socket tanpa login mencoba mengeluarkan korban
  await emitAck(sAnon, 'quiz:room:leave', { code, userId: u2.user.id });
  // Lawan yang login mencoba mengeluarkan korban: yang keluar hanya dirinya sendiri
  await emitAck(s1, 'quiz:room:leave', { token: u1.token, code, userId: u2.user.id });

  const room = quizEngine.quizRooms.get(code);
  assert.ok(room, 'room tetap ada karena korban masih di dalam');
  assert.deepEqual(room.players.map(p => p.userId), [u2.user.id]);
});

test('Menang karena lawan keluar (forfeit) di 1 vs 1 tidak memberi poin', async () => {
  quizEngine.setTimings({ countdownMs: 30, questionDurationMs: 2000, roundTransitionMs: 40, maxRounds: 3 });
  const u1 = await registerUser('bertahan');
  const u2 = await registerUser('kabur');
  const s1 = await connect();
  const s2 = await connect();

  const createAck = await emitAck(s1, 'quiz:room:create', { token: u1.token, monsterId: 'emberon' });
  const code = createAck.code;
  await emitAck(s2, 'quiz:room:join', { token: u2.token, code, monsterId: 'aquaris' });
  const startedP = once(s1, 'question.started');
  await emitAck(s1, 'quiz:player:ready', { token: u1.token, code, ready: true });
  await emitAck(s2, 'quiz:player:ready', { token: u2.token, code, ready: true });
  await startedP;

  const pointsBefore = db.getUserById(u1.user.id) && db.sanitizeUser(db.getUserById(u1.user.id)).points;
  const finishedP = once(s1, 'game.finished');
  await emitAck(s2, 'quiz:room:leave', { token: u2.token, code });
  const finished = await finishedP;

  assert.equal(finished.endReason, 'forfeit');
  assert.equal(finished.winnerUserId, u1.user.id);
  assert.equal(finished.rewardPoints, 0);
  assert.equal(finished.winnerReward, null);
  assert.equal(db.sanitizeUser(db.getUserById(u1.user.id)).points, pointsBefore);
});

test('Aturan poin bersama: minimal 2 pemain asli dan bukan forfeit', () => {
  const { canAwardPoints } = require('../lib/rewards');
  const human = id => ({ userId: id });
  const bot = id => ({ userId: `bot_${id}`, isBot: true });
  assert.equal(canAwardPoints([human('a'), bot('x')]), false, 'hanya melawan bot');
  assert.equal(canAwardPoints([human('a'), bot('x'), bot('y')]), false);
  assert.equal(canAwardPoints([human('a'), human('b')]), true);
  assert.equal(canAwardPoints([human('a'), human('b'), bot('x')]), true, 'bot boleh ikut selama ada lawan asli');
  assert.equal(canAwardPoints([human('a'), human('b')], { endReason: 'forfeit' }), false);
  assert.equal(canAwardPoints([{ id: 'bot', isBot: true }, { id: 'p1' }, { id: 'p2' }]), true, 'format pemain Ludo');
});

test('Rotasi soal: soal yang sudah muncul jarang keluar lagi dan siklus di-reset setelah semua muncul', () => {
  const quizStore = require('./store');
  const general = () => quizStore.listQuestions({ category: 'general' });

  // Tuntaskan siklus yang mungkin sedang berjalan dari test lain: soal terakhir memicu reset
  for (const q of general().filter(q => !q.cycleSeen)) quizStore.markQuestionShown(q.id);
  assert.ok(general().every(q => !q.cycleSeen), 'siklus di-reset setelah semua soal muncul');

  // Semua soal umum sudah muncul kecuali 3 soal
  const all = general();
  const fresh = all.slice(0, 3).map(q => q.id);
  for (const q of all.slice(3)) quizStore.markQuestionShown(q.id);

  const N = 400;
  let freshHits = 0;
  for (let i = 0; i < N; i++) {
    if (fresh.includes(quizStore.selectRandomUnusedQuestion(new Set(), 'general').id)) freshHits++;
  }
  // Tanpa rotasi peluangnya 3/n (~2%); dengan bobot 20:1 sekitar 33%
  assert.ok(freshHits / N > 0.2, `soal yang belum muncul harus diutamakan, dapat ${freshHits}/${N}`);

  // Soal yang sudah dipakai di pertandingan yang sama tetap tidak boleh keluar lagi
  const onlyLeft = all[5].id;
  const used = new Set(all.map(q => q.id).filter(id => id !== onlyLeft));
  assert.equal(quizStore.selectRandomUnusedQuestion(used, 'general').id, onlyLeft);

  // Begitu 3 soal sisanya muncul, semua soal kembali berpeluang sama
  fresh.forEach(id => quizStore.markQuestionShown(id));
  assert.ok(general().every(q => !q.cycleSeen));
  assert.ok(general().every(q => q.shownCount >= 1));
});

test('Mode 3 pemain: pemain yang keluar duluan tetap tercatat kalah saat match selesai', async () => {
  quizEngine.setTimings({ countdownMs: 30, questionDurationMs: 2000, roundTransitionMs: 40, maxRounds: 3 });
  const quizStore = require('./store');
  const [u1, u2, u3] = [await registerUser('tiga_a'), await registerUser('tiga_b'), await registerUser('tiga_c')];
  const [s1, s2, s3] = [await connect(), await connect(), await connect()];

  const code = (await emitAck(s1, 'quiz:room:create', { token: u1.token, monsterId: 'emberon' })).code;
  await emitAck(s2, 'quiz:room:join', { token: u2.token, code, monsterId: 'aquaris' });
  await emitAck(s3, 'quiz:room:join', { token: u3.token, code, monsterId: 'terragon' });
  const startedP = once(s1, 'question.started');
  for (const [s, u] of [[s1, u1], [s2, u2], [s3, u3]]) {
    await emitAck(s, 'quiz:player:ready', { token: u.token, code, ready: true });
  }
  await startedP;

  // Pemain ketiga kabur: match masih lanjut antara dua pemain lain
  await emitAck(s3, 'quiz:room:leave', { token: u3.token, code });
  assert.equal(quizEngine.quizRooms.get(code).match.finished, false);

  const finishedP = once(s1, 'game.finished');
  await emitAck(s2, 'quiz:room:leave', { token: u2.token, code });
  const finished = await finishedP;

  assert.equal(finished.winnerUserId, u1.user.id);
  const result = id => finished.players.find(p => p.userId === id)?.result;
  assert.equal(result(u3.user.id), 'lose', 'pemain yang keluar duluan ikut tercatat');
  assert.equal(result(u2.user.id), 'lose');
  assert.equal(quizStore.getPlayerStats(u3.user.id).losses, 1);
  assert.equal(quizStore.getPlayerStats(u3.user.id).matchesPlayed, 1);
});

test('Spam event kuis dari satu socket ditolak rate limiter', async () => {
  const u = await registerUser('spam');
  const s = await connect();
  const results = await Promise.all(
    Array.from({ length: 30 }, () => emitAck(s, 'quiz:answer:submit', { token: u.token, code: 'XXXXX', selectedIndex: 0 }))
  );
  const limited = results.filter(r => r?.error === 'Terlalu banyak aksi dalam waktu singkat.').length;
  assert.equal(limited, 15, 'hanya 15 aksi per 3 detik yang diproses');
  // Keluar room tetap bisa walau sedang kena batas
  const leave = await emitAck(s, 'quiz:room:leave', { token: u.token });
  assert.equal(leave.ok, true);
});

test('Stok hint lawan tidak dikirim ke pemain lain', async () => {
  const u1 = await registerUser('hint_a');
  const u2 = await registerUser('hint_b');
  const s1 = await connect();
  const s2 = await connect();
  const code = (await emitAck(s1, 'quiz:room:create', { token: u1.token, monsterId: 'emberon' })).code;
  await emitAck(s2, 'quiz:room:join', { token: u2.token, code, monsterId: 'aquaris' });

  const state = quizEngine.serializeRoomForUser(quizEngine.quizRooms.get(code), u1.user.id);
  const me = state.players.find(p => p.userId === u1.user.id);
  const rival = state.players.find(p => p.userId === u2.user.id);
  assert.equal(typeof me.hintCount, 'number');
  assert.equal(rival.hintCount, null);
  await emitAck(s1, 'quiz:room:leave', { token: u1.token, code });
  await emitAck(s2, 'quiz:room:leave', { token: u2.token, code });
});

test('Server dimatikan: pemain kuis diberi tahu dan room dihapus', async () => {
  const u = await registerUser('restart');
  const s = await connect();
  const code = (await emitAck(s, 'quiz:room:create', { token: u.token, monsterId: 'emberon' })).code;
  const closedP = once(s, 'quiz:room:closed');
  quizEngine.closeAllRoomsForShutdown();
  const closed = await closedP;
  assert.equal(closed.roomCode, code);
  assert.match(closed.reason, /Server sedang diperbarui/);
  assert.equal(quizEngine.quizRooms.has(code), false);
  assert.equal(quizEngine.getActiveRoomForUser(u.user.id), null);
});

test('Soal yang temanya mirip tidak muncul di pertandingan yang sama', () => {
  const quizStore = require('./store');
  const { RELATED_QUESTION_GROUPS } = require('./questions');
  const allIds = quizStore.listQuestions().map(q => q.id);
  for (const group of RELATED_QUESTION_GROUPS) {
    const [first, ...others] = group;
    for (let i = 0; i < 200; i++) {
      const picked = quizStore.selectRandomUnusedQuestion(new Set([first]), 'general');
      assert.ok(!others.includes(picked.id), `${picked.id} segrup dengan ${first}`);
    }
  }
  // Bila hanya tersisa soal segrup (semua kategori), soal itu tetap boleh dipakai daripada match berhenti
  const [a, b] = RELATED_QUESTION_GROUPS[1];
  const used = new Set(allIds.filter(id => id !== b));
  assert.equal(used.has(a), true);
  assert.equal(quizStore.selectRandomUnusedQuestion(used, 'general').id, b);
});

