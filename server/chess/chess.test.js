'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jakludo-chess-test-'));
process.env.JAKLUDO_DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';

const { io: ioClient } = require('socket.io-client');
const { Chess } = require('chess.js');
const { server, shutdown } = require('../index');
const chessEngine = require('./engine');
const chessStore = require('./store');

let url;
const clients = [];

test.before(async () => {
  await new Promise(resolve => server.listen(0, resolve));
  url = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  clients.forEach(c => c.close());
  chessEngine.stopAllTimers();
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
async function registerUser(prefix = 'cp') {
  userCounter += 1;
  const username = `${prefix}_${userCounter}_${Date.now().toString(36).slice(-3)}`.slice(0, 20);
  const res = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password: 'Password#123',
      name: `ChessPlayer ${userCounter}`
    })
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.token);
  return body;
}

// ==========================================
// 1. CHESS ENGINE & OFFICIAL RULES TESTS
// ==========================================

test('Chess Engine Rules: castling, en passant, promotion, check, checkmate, stalemate, insufficient material', () => {
  // 1. Kingside & Queenside Castling
  const castlingBoard = new Chess('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1');
  const ks = castlingBoard.move({ from: 'e1', to: 'g1' });
  assert.equal(ks.san, 'O-O');

  const qsBoard = new Chess('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R b KQkq - 0 1');
  const qs = qsBoard.move({ from: 'e8', to: 'c8' });
  assert.equal(qs.san, 'O-O-O');

  // 2. En Passant
  const epBoard = new Chess();
  epBoard.move('e4');
  epBoard.move('a6');
  epBoard.move('e5');
  epBoard.move('d5');
  const epMove = epBoard.move({ from: 'e5', to: 'd6' });
  assert.ok(epMove);
  assert.equal(epMove.san, 'exd6');

  // 3. Pawn Promotion to Queen, Rook, Bishop, Knight
  for (const promo of ['q', 'r', 'b', 'n']) {
    const promoBoard = new Chess('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
    const mv = promoBoard.move({ from: 'a7', to: 'a8', promotion: promo });
    assert.ok(mv);
    assert.equal(mv.promotion, promo);
  }

  // 4. Stalemate Detection
  const stalemateBoard = new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  assert.equal(stalemateBoard.isStalemate(), true);
  assert.equal(stalemateBoard.isGameOver(), true);

  // 5. Insufficient Material Detection (K vs K)
  const insuffBoard = new Chess('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
  assert.equal(insuffBoard.isInsufficientMaterial(), true);
});

// ==========================================
// 2. ELO RATING CALCULATION TESTS
// ==========================================

test('Elo Rating System: default 1200, K=32 win/loss/draw calculation', () => {
  assert.equal(chessStore.DEFAULT_RATING, 1200);
  assert.equal(chessStore.ELO_K_FACTOR, 32);

  // Equal 1200 vs 1200 -> White wins (+16 / -16)
  const winCalc = chessStore.calculateEloChanges(1200, 1200, '1-0', 32);
  assert.equal(winCalc.whiteChange, 16);
  assert.equal(winCalc.blackChange, -16);
  assert.equal(winCalc.whiteAfter, 1216);
  assert.equal(winCalc.blackAfter, 1184);

  // Equal 1200 vs 1200 -> Draw (0 / 0)
  const drawCalc = chessStore.calculateEloChanges(1200, 1200, '1/2-1/2', 32);
  assert.equal(drawCalc.whiteChange, 0);
  assert.equal(drawCalc.blackChange, 0);

  // Underdog win (1000 vs 1400) -> gains more than 16
  const upsetCalc = chessStore.calculateEloChanges(1000, 1400, '1-0', 32);
  assert.ok(upsetCalc.whiteChange > 25);
  assert.equal(upsetCalc.whiteChange, -upsetCalc.blackChange);
});

// ==========================================
// 3. MULTIPLAYER PRIVATE ROOM, SERVER MOVE VALIDATION & FOOL'S MATE
// ==========================================

test('Private Room: create, join, block 3rd player, enforce turns, reject illegal/duplicate moves, Fool\'s Mate & PGN', async () => {
  const u1 = await registerUser('w');
  const u2 = await registerUser('b');
  const u3 = await registerUser('third');

  const c1 = await connect();
  const c2 = await connect();
  const c3 = await connect();

  // Host creates private room preferring White ('w') and 5+0 time control
  const createRes = await emitAck(c1, 'chess:room:create', {
    token: u1.token,
    timeControl: '5+0',
    preferredSide: 'w'
  });
  assert.equal(createRes.ok, true);
  const code = createRes.room.code;
  assert.equal(createRes.room.preferredSide, 'w');

  // Player 2 joins
  const joinRes = await emitAck(c2, 'chess:room:join', {
    code,
    token: u2.token
  });
  assert.equal(joinRes.ok, true);
  assert.equal(joinRes.room.players.length, 2);

  // Third player must be rejected
  const thirdRes = await emitAck(c3, 'chess:room:join', {
    code,
    token: u3.token
  });
  assert.equal(thirdRes.ok, false);

  // Both players ready -> match starts automatically
  await emitAck(c1, 'chess:player:ready', { code, token: u1.token, ready: true });
  const startRes = await emitAck(c2, 'chess:player:ready', { code, token: u2.token, ready: true });
  assert.equal(startRes.ok, true);

  const activeRoom = chessEngine.chessRooms.get(code);
  assert.equal(activeRoom.phase, 'playing');
  const matchId = activeRoom.match.id;
  assert.equal(activeRoom.match.whitePlayer.userId, u1.user.id);
  assert.equal(activeRoom.match.blackPlayer.userId, u2.user.id);

  // Out-of-turn move by Black on move 1 -> rejected
  const outOfTurn = await emitAck(c2, 'chess:move', {
    code,
    matchId,
    token: u2.token,
    from: 'e7',
    to: 'e5'
  });
  assert.equal(outOfTurn.ok, false);

  // Unauthorized move by 3rd player -> rejected
  const unauthMove = await emitAck(c3, 'chess:move', {
    code,
    matchId,
    token: u3.token,
    from: 'e2',
    to: 'e4'
  });
  assert.equal(unauthMove.ok, false);

  // Illegal move by White (e2 to e5) -> rejected
  const illegalMove = await emitAck(c1, 'chess:move', {
    code,
    matchId,
    token: u1.token,
    from: 'e2',
    to: 'e5'
  });
  assert.equal(illegalMove.ok, false);

  // Fool's Mate sequence: 1. f3 e5 2. g4 Qh4#
  const m1 = await emitAck(c1, 'chess:move', {
    code,
    matchId,
    token: u1.token,
    from: 'f2',
    to: 'f3',
    moveVersion: 0
  });
  assert.equal(m1.ok, true);
  assert.equal(m1.move.san, 'f3');

  // Stale moveVersion replay/duplicate protection -> rejected
  const dupMove = await emitAck(c2, 'chess:move', {
    code,
    matchId,
    token: u2.token,
    from: 'e7',
    to: 'e5',
    moveVersion: 0 // stale version (current is 1)
  });
  assert.equal(dupMove.ok, false);

  const m2 = await emitAck(c2, 'chess:move', {
    code,
    matchId,
    token: u2.token,
    from: 'e7',
    to: 'e5',
    moveVersion: 1
  });
  assert.equal(m2.ok, true);
  assert.equal(m2.move.san, 'e5');

  const m3 = await emitAck(c1, 'chess:move', {
    code,
    matchId,
    token: u1.token,
    from: 'g2',
    to: 'g4',
    moveVersion: 2
  });
  assert.equal(m3.ok, true);

  const m4 = await emitAck(c2, 'chess:move', {
    code,
    matchId,
    token: u2.token,
    from: 'd8',
    to: 'h4',
    moveVersion: 3
  });
  assert.equal(m4.ok, true);
  assert.equal(m4.move.san, 'Qh4#');
  assert.equal(m4.move.isCheckmate, true);

  // Match should now be completed with Black as winner
  assert.equal(activeRoom.phase, 'completed');
  assert.equal(activeRoom.match.result, '0-1');
  assert.equal(activeRoom.match.resultReason, 'checkmate');
  assert.equal(activeRoom.match.winnerId, u2.user.id);

  // Verify Elo ratings updated
  const p1Prof = chessStore.getPlayerProfile(u1.user.id);
  const p2Prof = chessStore.getPlayerProfile(u2.user.id);
  assert.equal(p1Prof.rating, 1184);
  assert.equal(p2Prof.rating, 1216);
  assert.equal(p2Prof.wins, 1);
  assert.equal(p1Prof.losses, 1);

  // Verify PGN export endpoint
  const pgnRes = await fetch(`${url}/api/chess/matches/${matchId}/pgn`);
  assert.equal(pgnRes.status, 200);
  const pgnText = await pgnRes.text();
  assert.ok(pgnText.includes('1. f3 e5 2. g4 Qh4# 0-1'));
});

// ==========================================
// 4. QUICK MATCHMAKING, DRAW OFFER, RESIGN & REMATCH TESTS
// ==========================================

test('Quick Matchmaking, Draw Offer/Accept, Resign & Rematch flow', async () => {
  const u1 = await registerUser('mm1');
  const u2 = await registerUser('mm2');
  const c1 = await connect();
  const c2 = await connect();

  // Player 1 enters queue and cancels
  const q1 = await emitAck(c1, 'chess:matchmaking:join', { token: u1.token, timeControl: '10+0' });
  assert.equal(q1.ok, true);
  assert.equal(q1.searching, true);

  const cancelRes = await emitAck(c1, 'chess:matchmaking:leave', { token: u1.token });
  assert.equal(cancelRes.ok, true);

  // Now both join 5+0 queue -> matched!
  await emitAck(c1, 'chess:matchmaking:join', { token: u1.token, timeControl: '5+0' });
  const matchRes = await emitAck(c2, 'chess:matchmaking:join', { token: u2.token, timeControl: '5+0' });
  assert.equal(matchRes.ok, true);
  assert.equal(matchRes.matched, true);
  assert.ok(matchRes.room?.code);

  const code = matchRes.room.code;
  const firstMatchId = matchRes.room.match.id;

  // Player 1 offers draw, Player 2 accepts draw
  const offerRes = await emitAck(c1, 'chess:draw:offer', { code, token: u1.token });
  assert.equal(offerRes.ok, true);

  // Duplicate draw offer while one is active -> rejected
  const dupOffer = await emitAck(c2, 'chess:draw:offer', { code, token: u2.token });
  assert.equal(dupOffer.ok, false);

  const acceptRes = await emitAck(c2, 'chess:draw:accept', { code, token: u2.token });
  assert.equal(acceptRes.ok, true);

  const roomObj = chessEngine.chessRooms.get(code);
  assert.equal(roomObj.phase, 'completed');
  assert.equal(roomObj.match.result, '1/2-1/2');
  assert.equal(roomObj.match.resultReason, 'draw_agreement');

  // Mutual Rematch -> creates a brand new match ID with swapped colors
  const rem1 = await emitAck(c1, 'chess:rematch', { code, token: u1.token });
  assert.equal(rem1.ok, true);
  assert.equal(rem1.started, false);

  const rem2 = await emitAck(c2, 'chess:rematch', { code, token: u2.token });
  assert.equal(rem2.ok, true);
  assert.equal(rem2.started, true);
  assert.notEqual(rem2.room.match.id, firstMatchId);
  assert.equal(rem2.room.phase, 'playing');

  // Resign in the rematch
  const resignRes = await emitAck(c1, 'chess:resign', { code, token: u1.token });
  assert.equal(resignRes.ok, true);
  assert.equal(roomObj.phase, 'completed');
  assert.equal(roomObj.match.resultReason, 'resigned');
  assert.equal(roomObj.match.winnerId, u2.user.id);
});

