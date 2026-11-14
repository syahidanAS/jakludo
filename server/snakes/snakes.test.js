'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jakludo-snakes-test-'));
process.env.JAKLUDO_DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';

const { io: ioClient } = require('socket.io-client');
const { server, shutdown } = require('../index');
const db = require('../db');
const snakesConfig = require('./config');
const snakesRules = require('./rules');
const snakesStore = require('./store');
const snakesEngine = require('./engine');

let url;
const clients = [];

test.before(async () => {
  await new Promise(resolve => server.listen(0, resolve));
  url = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  clients.forEach(c => c.close());
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

function emitAck(c, event, payload) {
  return new Promise(resolve => {
    c.emit(event, payload, res => resolve(res));
  });
}

let userCounter = 0;
async function registerUser(prefix = 'sl') {
  userCounter += 1;
  const username = `${prefix}_${userCounter}_${Date.now().toString(36).slice(-3)}`.slice(0, 20);
  const res = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password: 'Password#123',
      name: `SnakesPlayer ${userCounter}`
    })
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.token);
  return body;
}

// ==========================================
// 1. GAME RULES & BOARD CONFIGURATION TESTS
// ==========================================

test('1. Game Rules: board configuration, zig-zag coordinates, ladders, snakes, exact 100, overshoot, extra turn on 6 & 3x6 skip', () => {
  // Board configuration validation
  const validation = snakesConfig.validateBoardConfiguration();
  assert.equal(validation.valid, true, `Board config errors: ${validation.errors.join(', ')}`);

  // Verify zig-zag coordinates (1 at bottom-left, 10 at bottom-right, 11 at row 1 right, 100 at top-left)
  const sq1 = snakesConfig.squareToBoardCoords(1);
  assert.equal(sq1.rowFromBottom, 0);
  assert.equal(sq1.col, 0);
  assert.equal(sq1.visualRow, 9);

  const sq10 = snakesConfig.squareToBoardCoords(10);
  assert.equal(sq10.rowFromBottom, 0);
  assert.equal(sq10.col, 9);

  const sq11 = snakesConfig.squareToBoardCoords(11);
  assert.equal(sq11.rowFromBottom, 1);
  assert.equal(sq11.col, 9);

  const sq100 = snakesConfig.squareToBoardCoords(100);
  assert.equal(sq100.rowFromBottom, 9);
  assert.equal(sq100.col, 0);
  assert.equal(sq100.visualRow, 0);

  // Rule 1, 2, 3: Start from 0 and move according to dice
  const firstMove = snakesRules.calculateTurnOutcome({ currentPosition: 0, dice: 5 });
  assert.equal(firstMove.from, 0);
  assert.equal(firstMove.finalPosition, 5);
  assert.equal(firstMove.moved, true);
  assert.equal(firstMove.isWin, false);
  assert.equal(firstMove.extraTurn, false);

  // Rule 4: Climb ladder (4 -> 14, 28 -> 84)
  const ladderMove = snakesRules.calculateTurnOutcome({ currentPosition: 0, dice: 4 });
  assert.equal(ladderMove.stepTo, 4);
  assert.equal(ladderMove.finalPosition, 14);
  assert.deepEqual(ladderMove.ladder, { from: 4, to: 14 });
  assert.equal(ladderMove.snake, null);

  const bigLadder = snakesRules.calculateTurnOutcome({ currentPosition: 25, dice: 3 });
  assert.equal(bigLadder.stepTo, 28);
  assert.equal(bigLadder.finalPosition, 84);
  assert.deepEqual(bigLadder.ladder, { from: 28, to: 84 });

  // Rule 5: Slide down snake (17 -> 7, 99 -> 78)
  const snakeMove = snakesRules.calculateTurnOutcome({ currentPosition: 14, dice: 3 });
  assert.equal(snakeMove.stepTo, 17);
  assert.equal(snakeMove.finalPosition, 7);
  assert.deepEqual(snakeMove.snake, { from: 17, to: 7 });
  assert.equal(snakeMove.ladder, null);

  // Example from specification: Player at 96
  // - Roll 3 -> moves to 99 -> hits snake 99->78
  const at96Roll3 = snakesRules.calculateTurnOutcome({ currentPosition: 96, dice: 3 });
  assert.equal(at96Roll3.overshoot, false);
  assert.equal(at96Roll3.stepTo, 99);
  assert.equal(at96Roll3.finalPosition, 78);
  assert.deepEqual(at96Roll3.snake, { from: 99, to: 78 });

  // - Roll 4 at 96 -> exact 100 -> WINS!
  const at96Roll4 = snakesRules.calculateTurnOutcome({ currentPosition: 96, dice: 4 });
  assert.equal(at96Roll4.overshoot, false);
  assert.equal(at96Roll4.finalPosition, 100);
  assert.equal(at96Roll4.isWin, true);

  // - Roll 6 at 96 -> exceeds 100 -> stays at 96 (overshoot)
  const at96Roll6 = snakesRules.calculateTurnOutcome({ currentPosition: 96, dice: 6 });
  assert.equal(at96Roll6.overshoot, true);
  assert.equal(at96Roll6.moved, false);
  assert.equal(at96Roll6.finalPosition, 96);
  assert.equal(at96Roll6.isWin, false);
  assert.deepEqual(at96Roll6.stepPath, []);

  // - At 98, rolling 4 -> exceeds 100 -> stays at 98
  const at98Roll4 = snakesRules.calculateTurnOutcome({ currentPosition: 98, dice: 4 });
  assert.equal(at98Roll4.overshoot, true);
  assert.equal(at98Roll4.finalPosition, 98);

  // Rule 8: Rolling 6 grants an extra turn (1st & 2nd), but 3 consecutive 6s skip turn to opponent
  const rollSix1 = snakesRules.calculateTurnOutcome({ currentPosition: 10, dice: 6, consecutiveSixes: 0 });
  assert.equal(rollSix1.dice, 6);
  assert.equal(rollSix1.finalPosition, 16);
  assert.equal(rollSix1.extraTurn, true);
  assert.equal(rollSix1.consecutiveSixes, 1);

  const rollSix2 = snakesRules.calculateTurnOutcome({ currentPosition: 16, dice: 6, consecutiveSixes: 1 });
  assert.equal(rollSix2.finalPosition, 22);
  assert.equal(rollSix2.extraTurn, true);
  assert.equal(rollSix2.consecutiveSixes, 2);

  const rollSix3 = snakesRules.calculateTurnOutcome({ currentPosition: 22, dice: 6, consecutiveSixes: 2 });
  assert.equal(rollSix3.finalPosition, 22);
  assert.equal(rollSix3.moved, false);
  assert.equal(rollSix3.threeSixesSkip, true);
  assert.equal(rollSix3.extraTurn, false);
  assert.equal(rollSix3.consecutiveSixes, 0);

  // Turn advancement
  assert.equal(snakesRules.getNextTurnIndex(0, 2), 1);
  assert.equal(snakesRules.getNextTurnIndex(1, 2), 0);
});

// ==========================================
// 2. SMART MATCHMAKING TESTS (HUMAN FIRST, BOT FALLBACK)
// ==========================================

test('2. Matchmaking: queue entry, cancel, human pairing before timeout, active game guard, and bot fallback after timeout', async () => {
  const u1 = await registerUser('mm1');
  const u2 = await registerUser('mm2');
  const u3 = await registerUser('mm3');

  const c1 = await connect();
  const c2 = await connect();
  const c3 = await connect();

  await emitAck(c1, 'social:identify', { token: u1.token });
  await emitAck(c2, 'social:identify', { token: u2.token });
  await emitAck(c3, 'social:identify', { token: u3.token });

  // Use normal 15s search timeout for human pairing tests first
  snakesEngine.setTimings({
    humanSearchTimeoutMs: 15000,
    botActionDelayMinMs: 80,
    botActionDelayMaxMs: 120
  });

  // 2.1 Player 1 starts Quick Match -> enters queue (`searching`), NOT immediately given a bot
  const q1 = await emitAck(c1, 'snakes:matchmaking:join', { token: u1.token });
  assert.equal(q1.ok, true);
  assert.equal(q1.searching, true);
  assert.equal(q1.matched, false);
  assert.ok(q1.queueId);

  // 2.2 Calling matchmaking:join again for the same user returns existing queue entry (no duplicate queue)
  const q1Dup = await emitAck(c1, 'snakes:matchmaking:join', { token: u1.token });
  assert.equal(q1Dup.ok, true);
  assert.equal(q1Dup.searching, true);
  assert.equal(q1Dup.alreadyQueued, true);
  assert.equal(q1Dup.queueId, q1.queueId);

  // 2.3 Cancel matchmaking works cleanly and removes player from queue
  const cancelRes = await emitAck(c1, 'snakes:matchmaking:cancel', { token: u1.token });
  assert.equal(cancelRes.ok, true);
  assert.equal(cancelRes.cancelled, true);
  assert.equal(snakesEngine.matchmakingQueue.has(u1.user.id), false);

  // 2.4 Human-first pairing: Player 1 searches, then Player 2 searches -> both matched into 1 human room
  const searchAgain = await emitAck(c1, 'snakes:matchmaking:join', { token: u1.token });
  assert.equal(searchAgain.searching, true);

  const humanFoundPromise = new Promise(resolve => {
    c1.once('matchmaking.human_found', data => resolve(data));
  });

  const q2 = await emitAck(c2, 'snakes:matchmaking:join', { token: u2.token });
  assert.equal(q2.ok, true);
  assert.equal(q2.matched, true);
  assert.equal(q2.opponentType, 'human');
  assert.ok(q2.room);
  assert.equal(q2.room.opponentType, 'human');
  assert.equal(q2.room.players.length, 2);
  assert.equal(q2.room.players.every(p => p.playerType === 'human'), true);

  const hfEvent = await humanFoundPromise;
  assert.equal(hfEvent.roomCode, q2.room.roomCode);

  // 2.5 Active playing player cannot enter matchmaking queue
  const blockedRes = await emitAck(c1, 'snakes:matchmaking:join', { token: u1.token });
  assert.equal(blockedRes.ok, false);
  assert.equal(blockedRes.code, 'ALREADY_IN_GAME');

  // Clean up human room
  await emitAck(c1, 'snakes:room:leave', { token: u1.token, roomCode: q2.room.roomCode });

  // 2.6 Bot fallback after timeout when no human opponent is available
  snakesEngine.setTimings({
    humanSearchTimeoutMs: 120,
    botActionDelayMinMs: 80,
    botActionDelayMaxMs: 120
  });

  const botFallbackPromise = new Promise(resolve => {
    c3.once('matchmaking.bot_fallback', data => resolve(data));
  });

  const q3 = await emitAck(c3, 'snakes:matchmaking:join', { token: u3.token });
  assert.equal(q3.ok, true);
  assert.equal(q3.searching, true);

  const bfEvent = await botFallbackPromise;
  assert.ok(bfEvent.roomCode);
  assert.ok(snakesConfig.ORGANIC_BOT_USERNAMES.includes(bfEvent.opponent.display_name));
  assert.equal(bfEvent.opponent.player_type, 'bot');
  assert.equal(bfEvent.opponent.user_id, null);

  await emitAck(c3, 'snakes:room:leave', { token: u3.token, roomCode: bfEvent.roomCode });
});

// ==========================================
// 3. TRANSPARENT BOT IDENTITY & GAMEPLAY TESTS
// ==========================================

test('3. Bot Identity & Behavior: transparent identity, user_id is null, no fake user in DB, auto-rolls on bot turn', async () => {
  const uBotTester = await registerUser('bottest');
  const cBotTester = await connect();
  await emitAck(cBotTester, 'social:identify', { token: uBotTester.token });

  snakesEngine.setTimings({
    humanSearchTimeoutMs: 100,
    botActionDelayMinMs: 60,
    botActionDelayMaxMs: 90
  });

  const usersCountBefore = db.getStatus().users;

  const botFallbackPromise = new Promise(resolve => {
    cBotTester.once('matchmaking.bot_fallback', data => resolve(data));
  });

  const q = await emitAck(cBotTester, 'snakes:matchmaking:join', { token: uBotTester.token });
  assert.equal(q.searching, true);

  const bfEvent = await botFallbackPromise;
  const botRoom = snakesEngine.getRoomStateForUser(bfEvent.roomCode, uBotTester.user.id);
  assert.ok(botRoom);

  const botPlayer = botRoom.players.find(p => p.player_type === 'bot');
  const humanPlayer = botRoom.players.find(p => p.player_type === 'human');

  assert.ok(botPlayer, 'Room must contain a bot player');
  assert.ok(humanPlayer, 'Room must contain the human player');

  // Verify strict bot transparency rules (Section 6)
  assert.equal(botPlayer.user_id, null);
  assert.equal(botPlayer.userId, null);
  assert.equal(botPlayer.player_type, 'bot');
  assert.equal(botPlayer.playerType, 'bot');
  assert.equal(botPlayer.bot_id, 'default-bot');
  assert.ok(snakesConfig.ORGANIC_BOT_USERNAMES.includes(botPlayer.display_name));
  assert.equal(botPlayer.avatar, null);

  // Verify no fake user was added to users store
  const usersCountAfter = db.getStatus().users;
  assert.equal(usersCountAfter, usersCountBefore, 'Bot must NOT create a fake user account');
  assert.equal(db.getUserById(botPlayer.id), null);
  assert.equal(db.getUserById('default-bot'), null);

  // Wait for or trigger bot roll
  const botMovedPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Bot did not roll in time')), 2000);
    cBotTester.on('game.dice_rolled', payload => {
      if (payload.playerType === 'bot') {
        clearTimeout(timer);
        resolve(payload);
      }
    });
  });

  // If it is human's turn first, human rolls until it becomes bot's turn (handles roll-6 extra turn)
  if (botRoom.isMyTurn) {
    let keepRolling = true;
    let safety = 0;
    while (keepRolling && safety < 5) {
      safety += 1;
      const rollRes = await emitAck(cBotTester, 'snakes:roll', {
        token: uBotTester.token,
        roomCode: botRoom.roomCode
      });
      assert.equal(rollRes.ok, true);
      keepRolling = Boolean(rollRes?.roll?.extraTurn);
    }
  }

  const botRollPayload = await botMovedPromise;
  assert.equal(botRollPayload.playerType, 'bot');
  assert.equal(botRollPayload.displayName, botPlayer.display_name);
  assert.ok(botRollPayload.dice >= 1 && botRollPayload.dice <= 6);

  await emitAck(cBotTester, 'snakes:room:leave', {
    token: uBotTester.token,
    roomCode: botRoom.roomCode
  });
});

// ==========================================
// 4. MULTIPLAYER, RECONNECTION & ANTI-CHEAT TESTS
// ==========================================

test('4. Multiplayer & Security: private room flow, anti-cheat payload rejection, out-of-turn rejection, reconnection, chat & reactions', async () => {
  snakesEngine.setTimings({
    humanSearchTimeoutMs: 15000,
    turnTimeoutMs: 30000
  });

  const host = await registerUser('host');
  const guest = await registerUser('guest');
  const outsider = await registerUser('out');

  const cHost = await connect();
  const cGuest = await connect();
  const cOutsider = await connect();

  await emitAck(cHost, 'social:identify', { token: host.token });
  await emitAck(cGuest, 'social:identify', { token: guest.token });
  await emitAck(cOutsider, 'social:identify', { token: outsider.token });

  // Create private room via REST API
  const createRes = await fetch(`${url}/api/games/snakes-and-ladders/rooms`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${host.token}`
    },
    body: JSON.stringify({ maxPlayers: 2 })
  });
  const createBody = await createRes.json();
  assert.equal(createRes.status, 200);
  assert.equal(createBody.ok, true);
  const roomCode = createBody.room.roomCode;
  const roomId = createBody.room.id;

  // Guest joins private room via REST API
  const joinRes = await fetch(`${url}/api/games/snakes-and-ladders/rooms/join`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${guest.token}`
    },
    body: JSON.stringify({ code: roomCode })
  });
  const joinBody = await joinRes.json();
  assert.equal(joinRes.status, 200);
  assert.equal(joinBody.room.players.length, 2);

  // Outsider cannot view private room they are not part of
  const outsiderGet = await fetch(`${url}/api/games/snakes-and-ladders/rooms/${roomId}`, {
    headers: { Authorization: `Bearer ${outsider.token}` }
  });
  assert.equal(outsiderGet.status, 403);

  // Host starts the private room via Socket.IO
  const startAck = await emitAck(cHost, 'snakes:room:start', {
    token: host.token,
    roomCode
  });
  assert.equal(startAck.ok, true);
  assert.equal(startAck.room.status, 'playing');

  const activeTurnIndex = startAck.room.turnIndex;
  const currentTurnPlayer = startAck.room.players[activeTurnIndex];
  const isHostTurn = currentTurnPlayer.user_id === host.user.id;
  const activeToken = isHostTurn ? host.token : guest.token;
  const inactiveToken = isHostTurn ? guest.token : host.token;

  // Anti-cheat 1: Client attempting to send dice_result or position is blocked
  const cheatRes = await fetch(`${url}/api/games/snakes-and-ladders/rooms/${roomId}/roll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${activeToken}`
    },
    body: JSON.stringify({ dice_result: 6, position: 100 })
  });
  const cheatBody = await cheatRes.json();
  assert.equal(cheatRes.status, 400);
  assert.match(cheatBody.error, /Manipulasi hasil dadu/i);

  // Anti-cheat 2: Rolling out of turn is rejected
  const wrongTurnRes = await fetch(`${url}/api/games/snakes-and-ladders/rooms/${roomId}/roll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${inactiveToken}`
    },
    body: JSON.stringify({})
  });
  const wrongTurnBody = await wrongTurnRes.json();
  assert.equal(wrongTurnRes.status, 400);
  assert.match(wrongTurnBody.error, /Bukan giliranmu/i);

  // Valid roll by active player succeeds (seed dice to 4 so player lands on ladder 4->14)
  snakesEngine.setTestDiceSequence([4]);
  const validRollRes = await fetch(`${url}/api/games/snakes-and-ladders/rooms/${roomId}/roll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${activeToken}`
    },
    body: JSON.stringify({})
  });
  const validRollBody = await validRollRes.json();
  assert.equal(validRollRes.status, 200);
  assert.equal(validRollBody.ok, true);
  assert.equal(validRollBody.roll.dice, 4);
  assert.equal(validRollBody.roll.stepTo, 4);
  assert.equal(validRollBody.roll.to, 14);
  assert.deepEqual(validRollBody.roll.ladder, { from: 4, to: 14 });

  // Chat & Reaction in room work properly
  const chatRes = await emitAck(cHost, 'snakes:chat', {
    token: host.token,
    roomCode,
    text: 'Semangat naik tangga!'
  });
  assert.equal(chatRes.ok, true);
  assert.equal(chatRes.message.text, 'Semangat naik tangga!');

  const reactRes = await emitAck(cGuest, 'snakes:reaction', {
    token: guest.token,
    roomCode,
    emoji: '🔥'
  });
  assert.equal(reactRes.ok, true);

  // Reconnection via snakes:room:join restores full state
  const reconnectAck = await emitAck(cHost, 'snakes:room:join', {
    token: host.token,
    code: roomCode
  });
  assert.equal(reconnectAck.ok, true);
  assert.equal(reconnectAck.reconnected, true);
  assert.equal(reconnectAck.room.roomCode, roomCode);
  assert.equal(reconnectAck.room.moveLog.length, 1);

  // Leave room finishes the match and awards win to the remaining human player
  const leaveAck = await emitAck(cGuest, 'snakes:room:leave', {
    token: guest.token,
    roomCode
  });
  assert.equal(leaveAck.ok, true);
});

// ==========================================
// 5. LEADERBOARD & MATCH HISTORY SEPARATION TESTS
// ==========================================

test('5. Leaderboard & History: bots never appear on leaderboard, bot wins separated from human wins', async () => {
  const humanWinner = await registerUser('champ');
  const humanLoser = await registerUser('runnerup');
  const botPracticer = await registerUser('solo');

  // 1. Create and complete a Human vs Human match where humanWinner wins
  const cWinner = await connect();
  const cLoser = await connect();
  await emitAck(cWinner, 'social:identify', { token: humanWinner.token });
  await emitAck(cLoser, 'social:identify', { token: humanLoser.token });

  const privRoom = await emitAck(cWinner, 'snakes:room:create', { token: humanWinner.token });
  assert.equal(privRoom.ok, true);
  await emitAck(cLoser, 'snakes:room:join', {
    token: humanLoser.token,
    code: privRoom.roomCode
  });
  await emitAck(cWinner, 'snakes:room:start', {
    token: humanWinner.token,
    roomCode: privRoom.roomCode
  });

  // Loser leaves -> humanWinner wins human match
  await emitAck(cLoser, 'snakes:room:leave', {
    token: humanLoser.token,
    roomCode: privRoom.roomCode
  });

  // 2. Simulate a completed Human vs Bot match where botPracticer wins
  const fakeBotRoom = {
    id: `snk_room_bottest_${Date.now()}`,
    code: 'BOT99',
    roomType: 'quick',
    status: 'finished',
    turnIndex: 0,
    turnNumber: 18,
    startedAt: Date.now() - 35000,
    finishedAt: Date.now(),
    winnerPlayerId: 'hp_solo',
    winnerUserId: botPracticer.user.id,
    historyRecorded: false,
    players: [
      {
        id: 'hp_solo',
        player_type: 'human',
        user_id: botPracticer.user.id,
        bot_id: null,
        display_name: botPracticer.user.name,
        avatar: botPracticer.user.avatar,
        player_order: 0,
        position: 100,
        color: 'red',
        status: 'active'
      },
      {
        id: 'bp_comp',
        player_type: 'bot',
        user_id: null,
        bot_id: 'default-bot',
        display_name: 'rizky_p',
        avatar: null,
        player_order: 1,
        position: 64,
        color: 'blue',
        status: 'active'
      }
    ]
  };
  snakesStore.recordCompletedMatch(fakeBotRoom);

  // Verify Leaderboard via REST API
  const lbRes = await fetch(`${url}/api/games/snakes-and-ladders/leaderboard`);
  const lbBody = await lbRes.json();
  assert.equal(lbRes.status, 200);
  assert.equal(lbBody.success, true);

  // Rule A: No entry in leaderboard has playerType === 'bot' or userId === null or organic bot name
  for (const entry of lbBody.leaderboard) {
    assert.ok(entry.userId, 'Every leaderboard entry must have a real userId');
    assert.equal(entry.playerType, 'human');
    assert.notEqual(entry.name, 'rizky_p', 'Bot must never appear on leaderboard');
  }

  // Rule B: humanWinner IS on the competitive leaderboard with 1 win
  const champEntry = lbBody.leaderboard.find(e => e.userId === humanWinner.user.id);
  assert.ok(champEntry, 'Human match winner must appear on leaderboard');
  assert.equal(champEntry.wins, 1);

  // Rule C: botPracticer (who only beat a bot) does NOT appear on competitive human leaderboard
  const botPracticerEntry = lbBody.leaderboard.find(e => e.userId === botPracticer.user.id);
  assert.equal(botPracticerEntry, undefined, 'Bot match wins must not inflate competitive human leaderboard');

  // Rule D: Verify botPracticer's history & stats via /api/games/snakes-and-ladders/history
  const histRes = await fetch(`${url}/api/games/snakes-and-ladders/history`, {
    headers: { Authorization: `Bearer ${botPracticer.token}` }
  });
  const histBody = await histRes.json();
  assert.equal(histRes.status, 200);
  assert.equal(histBody.stats.wins, 0, 'Competitive human wins should be 0');
  assert.equal(histBody.stats.botStats.wins, 1, 'Bot practice wins should be 1');
  assert.equal(histBody.history[0].opponentType, 'bot');
  assert.equal(histBody.history[0].opponentName, 'rizky_p');
});

// ==========================================
// 6. AFK 3-TIMEOUT AUTO-OUT RULE TEST
// ==========================================

test('6. AFK Rule: failing to roll dice 3 times eliminates the player and declares opponent winner', async () => {
  const idlePlayer = await registerUser('afk_idle');
  const activeOpponent = await registerUser('afk_active');

  const cIdle = await connect();
  const cOpp = await connect();

  await emitAck(cIdle, 'social:identify', { token: idlePlayer.token });
  await emitAck(cOpp, 'social:identify', { token: activeOpponent.token });

  snakesEngine.setTimings({
    turnTimeoutMs: 250,
    humanSearchTimeoutMs: 12000,
    botActionDelayMinMs: 20,
    botActionDelayMaxMs: 40
  });

  const createAck = await emitAck(cIdle, 'snakes:room:create', {
    token: idlePlayer.token,
    maxPlayers: 2
  });
  assert.equal(createAck.ok, true);
  const roomCode = createAck.roomCode;

  const joinAck = await emitAck(cOpp, 'snakes:room:join', {
    token: activeOpponent.token,
    code: roomCode
  });
  assert.equal(joinAck.ok, true);

  let afkOutEvent = null;
  cOpp.on('game.player_afk_out', payload => {
    afkOutEvent = payload;
  });

  let latestRoomState = null;
  cOpp.on('snakes:room:state', state => {
    latestRoomState = state;
  });

  const finishedPromise = new Promise(resolve => {
    cOpp.once('game.finished', payload => resolve(payload));
  });

  // Whenever it's activeOpponent's turn, roll immediately over socket so only idlePlayer accumulates 3 timeouts
  const rollIfMyTurn = async userId => {
    if (userId !== activeOpponent.user.id) return;
    let keepRolling = true;
    let safety = 0;
    while (keepRolling && safety < 5) {
      safety += 1;
      const res = await emitAck(cOpp, 'snakes:roll', {
        token: activeOpponent.token,
        roomCode
      });
      keepRolling = Boolean(res?.ok && res?.roll?.extraTurn);
    }
  };

  cOpp.on('game.started', payload => {
    rollIfMyTurn(payload.currentTurnUserId);
  });
  cOpp.on('game.turn_changed', payload => {
    rollIfMyTurn(payload.currentTurnUserId);
  });

  const startAck = await emitAck(cIdle, 'snakes:room:start', {
    token: idlePlayer.token,
    roomCode
  });
  assert.equal(startAck.ok, true);

  const finished = await finishedPromise;
  assert.equal(finished.reason, 'afk_timeout_3');
  assert.equal(finished.winnerUserId, activeOpponent.user.id);
  assert.ok(afkOutEvent, 'game.player_afk_out should have been emitted');
  assert.equal(afkOutEvent.userId, idlePlayer.user.id);
  assert.equal(afkOutEvent.autoTimeoutCount, 3);

  assert.ok(latestRoomState, 'Room state should have been received');
  assert.equal(latestRoomState.finishReason, 'afk_timeout_3');
  const eliminatedPlayer = latestRoomState.players.find(p => p.userId === idlePlayer.user.id);
  assert.equal(eliminatedPlayer.status, 'eliminated');
  assert.equal(eliminatedPlayer.autoTimeoutCount, 3);

  cIdle.disconnect();
  cOpp.disconnect();
});
