import React, { useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import { adminApi } from '../api';
import AdminIcon from './AdminIcons';
import AdminModal from './AdminModal';
import Badge, { gameBadgeTone, statusBadgeTone } from './Badge';
import {
  COLORS,
  COLOR_INFO,
  SAFE_TRACK_INDICES,
  START_TILES,
  TRACK_COORDS,
  getPawnCoord
} from '../../boardConstants';

const DEFAULT_CHESS_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const CHESS_FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const CHESS_RANKS = ['8', '7', '6', '5', '4', '3', '2', '1'];
const UNICODE_CHESS_PIECES = {
  wp: '♙',
  wr: '♖',
  wn: '♘',
  wb: '♗',
  wq: '♕',
  wk: '♔',
  bp: '♟',
  br: '♜',
  bn: '♞',
  bb: '♝',
  bq: '♛',
  bk: '♚'
};

const TRACK_CELL_INDEX = new Map(TRACK_COORDS.map(([r, c], idx) => [`${r},${c}`, idx]));
const START_CELL_COLOR = new Map(Object.entries(START_TILES).map(([color, [r, c]]) => [`${r},${c}`, color]));

function formatClock(ms) {
  const safe = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatSecondsLeft(deadlineAt, serverOffsetMs, nowMs) {
  if (!deadlineAt) return null;
  const approxServerNow = nowMs + serverOffsetMs;
  return Math.max(0, Math.ceil((deadlineAt - approxServerNow) / 1000));
}

function parseFenBoard(fenStr) {
  const boardPart = String(fenStr || DEFAULT_CHESS_FEN).split(' ')[0];
  const rows = boardPart.split('/');
  const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (let r = 0; r < 8 && r < rows.length; r++) {
    let col = 0;
    for (const ch of rows[r]) {
      if (col >= 8) break;
      const num = Number(ch);
      if (Number.isInteger(num) && num >= 1 && num <= 8) {
        col += num;
      } else {
        const isWhite = ch === ch.toUpperCase();
        grid[r][col] = {
          color: isWhite ? 'w' : 'b',
          type: ch.toLowerCase()
        };
        col += 1;
      }
    }
  }
  return grid;
}

function getYardColorForCell(r, c) {
  if (r <= 3 && c <= 3) return 'green';
  if (r <= 3 && c >= 7) return 'yellow';
  if (r >= 7 && c <= 3) return 'red';
  if (r >= 7 && c >= 7) return 'blue';
  return null;
}

function getRunwayColorForCell(r, c) {
  if (r === 5 && c >= 1 && c <= 4) return 'green';
  if (c === 5 && r >= 1 && r <= 4) return 'yellow';
  if (r === 5 && c >= 6 && c <= 9) return 'blue';
  if (c === 5 && r >= 6 && r <= 9) return 'red';
  return null;
}

function LudoLiveBoard({ state, nowMs, serverOffsetMs }) {
  const players = state.players || [];
  const currentTurn = players[state.turn] || null;
  const blackHoleSet = new Set(state.blackHoles || []);
  const safeZonesActive = state.settings?.safeZones !== false;

  // Hitung posisi bidak aktif pada grid 11x11 (val > 0) dan bidak di markas (val === 0)
  const cellPawns = useMemo(() => {
    const map = new Map();
    for (const p of players) {
      if (!p.color) continue;
      const values = state.pawns?.[p.id] || [0, 0, 0, 0];
      values.forEach((val, pawnIdx) => {
        if (val <= 0) return;
        const coord = getPawnCoord(p.color, val);
        if (!coord) return;
        const key = `${coord[0]},${coord[1]}`;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({ color: p.color, pawnIdx, playerName: p.name, isOut: p.isOut });
      });
    }
    return map;
  }, [players, state.pawns]);

  const homePawnsByColor = useMemo(() => {
    const out = { red: [], green: [], yellow: [], blue: [] };
    for (const p of players) {
      if (!p.color || !out[p.color]) continue;
      const values = state.pawns?.[p.id] || [0, 0, 0, 0];
      values.forEach((val, pawnIdx) => {
        if (val <= 0) out[p.color].push({ pawnIdx, player: p });
      });
    }
    return out;
  }, [players, state.pawns]);

  const turnRemainSec = state.turnClock
    ? Math.max(
        0,
        Math.ceil(
          (state.turnClock.remainingMs - Math.max(0, nowMs + serverOffsetMs - (state.serverNow || nowMs + serverOffsetMs))) /
            1000
        )
      )
    : null;

  const yardPlayersByColor = Object.fromEntries(COLORS.map(c => [c, players.find(p => p.color === c) || null]));

  return (
    <div className="adm-live-board-wrap">
      <div className="adm-live-hud">
        <div className="adm-live-hud__item">
          <span className="adm-muted">Status:</span>{' '}
          <strong>
            {state.winner
              ? `Selesai — Pemenang: ${state.winner}`
              : state.started
              ? `Giliran: ${currentTurn?.name || '-'}`
              : 'Menunggu di Lobby'}
          </strong>
        </div>
        {state.started && !state.winner && (
          <div className="adm-live-hud__chips">
            {currentTurn?.color && (
              <span className="adm-color-pill" style={{ '--pill-color': COLOR_INFO[currentTurn.color]?.hex }}>
                {COLOR_INFO[currentTurn.color]?.name || currentTurn.color}
              </span>
            )}
            <Badge tone="brand">
              Dadu: {state.rolling ? 'Mengocok...' : state.dice ?? '-'}
            </Badge>
            {turnRemainSec !== null && <Badge tone="info">{turnRemainSec}d</Badge>}
            {state.pendingShield && <Badge tone="warning">Menunggu Perisai</Badge>}
          </div>
        )}
      </div>

      {state.message && <div className="adm-live-notice">{state.message}</div>}

      <div className="adm-ludo-board" role="img" aria-label="Papan JakLudo Realtime">
        {Array.from({ length: 11 * 11 }, (_, idx) => {
          const r = Math.floor(idx / 11);
          const c = idx % 11;
          const key = `${r},${c}`;
          const trackIdx = TRACK_CELL_INDEX.get(key);
          const runwayColor = getRunwayColorForCell(r, c);
          const startColor = START_CELL_COLOR.get(key);
          const isCenter = r === 5 && c === 5;
          const yardColor = getYardColorForCell(r, c);

          // Render markas 4x4 sebagai overlay blok tunggal pada sudut kiri atas tiap kuadran
          if (yardColor) {
            const isTopLeftCorner =
              (r === 0 && c === 0) ||
              (r === 0 && c === 7) ||
              (r === 7 && c === 0) ||
              (r === 7 && c === 7);
            if (!isTopLeftCorner) return null;
            const owner = yardPlayersByColor[yardColor];
            const homePawns = homePawnsByColor[yardColor] || [];
            return (
              <div
                key={`yard-${yardColor}`}
                className={`adm-ludo-yard adm-ludo-yard--${yardColor}`}
                style={{
                  gridRow: `${r + 1} / span 4`,
                  gridColumn: `${c + 1} / span 4`
                }}
              >
                <div className="adm-ludo-yard__label">
                  <span>{owner ? owner.name : COLOR_INFO[yardColor]?.name}</span>
                  {owner && !owner.connected && <small>(DC)</small>}
                </div>
                <div className="adm-ludo-yard__slots">
                  {[0, 1, 2, 3].map(slot => {
                    const hasPawn = homePawns.some(hp => hp.pawnIdx === slot);
                    return (
                      <span key={slot} className="adm-ludo-yard__slot">
                        {hasPawn && <span className={`adm-ludo-pawn adm-ludo-pawn--${yardColor}`} />}
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          }

          const isSafe = safeZonesActive && trackIdx !== undefined && SAFE_TRACK_INDICES.includes(trackIdx);
          const isBlackHole = trackIdx !== undefined && blackHoleSet.has(trackIdx);
          const pawnsHere = cellPawns.get(key) || [];

          return (
            <div
              key={key}
              className={[
                'adm-ludo-cell',
                isCenter ? 'is-center' : '',
                runwayColor ? `is-runway is-runway--${runwayColor}` : '',
                startColor ? `is-start is-start--${startColor}` : '',
                isSafe ? 'is-safe' : '',
                isBlackHole ? 'is-blackhole' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ gridRow: r + 1, gridColumn: c + 1 }}
            >
              {isCenter && <span className="adm-ludo-symbol">👑</span>}
              {!isCenter && isBlackHole && <span className="adm-ludo-symbol">🕳️</span>}
              {!isCenter && !isBlackHole && startColor && <span className="adm-ludo-symbol">★</span>}
              {!isCenter && !isBlackHole && !startColor && isSafe && <span className="adm-ludo-symbol">☆</span>}
              {pawnsHere.length > 0 && (
                <div className={`adm-ludo-pawns ${pawnsHere.length > 1 ? 'is-stacked' : ''}`}>
                  {pawnsHere.map((pw, i) => (
                    <span
                      key={`${pw.color}-${pw.pawnIdx}-${i}`}
                      className={`adm-ludo-pawn adm-ludo-pawn--${pw.color}`}
                      title={`${pw.playerName} (Bidak #${pw.pawnIdx + 1})`}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChessLiveBoard({ state, nowMs, serverOffsetMs }) {
  const match = state.match;
  const grid = useMemo(() => parseFenBoard(match?.currentFen), [match?.currentFen]);
  const whitePlayer = match?.whitePlayer || state.players?.find(p => p.color === 'w');
  const blackPlayer = match?.blackPlayer || state.players?.find(p => p.color === 'b');

  const approxServerNow = nowMs + serverOffsetMs;
  const elapsedSinceSync =
    state.phase === 'playing' && match?.status === 'active'
      ? Math.max(0, approxServerNow - (state.serverNow || approxServerNow))
      : 0;

  const whiteMs =
    (match?.whiteRemainingTimeMs ?? 0) - (match?.currentTurn === 'w' ? elapsedSinceSync : 0);
  const blackMs =
    (match?.blackRemainingTimeMs ?? 0) - (match?.currentTurn === 'b' ? elapsedSinceSync : 0);

  const lastFrom = match?.lastMove?.from || null;
  const lastTo = match?.lastMove?.to || null;

  const moves = match?.moves || [];
  const movePairs = [];
  for (let i = 0; i < moves.length; i += 2) {
    movePairs.push({
      no: Math.floor(i / 2) + 1,
      white: moves[i]?.san || '',
      black: moves[i + 1]?.san || ''
    });
  }

  return (
    <div className="adm-live-board-wrap">
      <div className="adm-chess-bar">
        <div className={`adm-chess-player ${match?.currentTurn === 'b' && state.phase === 'playing' ? 'is-turn' : ''}`}>
          <span className="adm-chess-dot is-black" />
          <strong>{blackPlayer?.name || 'Menunggu Hitam'}</strong>
          {blackPlayer?.rating && <span className="adm-muted">({blackPlayer.rating})</span>}
        </div>
        <span className="adm-chess-clock">{formatClock(blackMs)}</span>
      </div>

      <div className="adm-chess-board" role="img" aria-label="Papan Catur Realtime">
        {CHESS_RANKS.map((rank, rIdx) =>
          CHESS_FILES.map((file, cIdx) => {
            const square = `${file}${rank}`;
            const piece = grid[rIdx][cIdx];
            const isLight = (rIdx + cIdx) % 2 === 0;
            const isLast = square === lastFrom || square === lastTo;
            const isCheckedKing =
              Boolean(match?.inCheck) && piece && piece.type === 'k' && piece.color === match.currentTurn;
            const symbol = piece ? UNICODE_CHESS_PIECES[`${piece.color}${piece.type}`] : '';
            return (
              <div
                key={square}
                className={[
                  'adm-chess-sq',
                  isLight ? 'is-light' : 'is-dark',
                  isLast ? 'is-last' : '',
                  isCheckedKing ? 'is-check' : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {cIdx === 0 && <span className="adm-chess-coord adm-chess-coord--rank">{rank}</span>}
                {rIdx === 7 && <span className="adm-chess-coord adm-chess-coord--file">{file}</span>}
                {symbol && (
                  <span className={`adm-chess-piece adm-chess-piece--${piece.color}`}>{symbol}</span>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="adm-chess-bar">
        <div className={`adm-chess-player ${match?.currentTurn === 'w' && state.phase === 'playing' ? 'is-turn' : ''}`}>
          <span className="adm-chess-dot is-white" />
          <strong>{whitePlayer?.name || 'Menunggu Putih'}</strong>
          {whitePlayer?.rating && <span className="adm-muted">({whitePlayer.rating})</span>}
        </div>
        <span className="adm-chess-clock">{formatClock(whiteMs)}</span>
      </div>

      {match?.result && match.result !== '*' && (
        <div className="adm-live-notice">
          Hasil: <strong>{match.result}</strong> · {match.terminationReason || 'Selesai'}
        </div>
      )}

      {movePairs.length > 0 && (
        <div className="adm-chess-moves">
          {movePairs.slice(-14).map(pair => (
            <span key={pair.no} className="adm-chess-move-pair">
              <span className="adm-muted">{pair.no}.</span> {pair.white} {pair.black}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function snakesSquareCoord(square) {
  const num = Number(square);
  if (!Number.isInteger(num) || num < 1 || num > 100) return null;
  const zeroBased = num - 1;
  const rowFromBottom = Math.floor(zeroBased / 10);
  const offset = zeroBased % 10;
  const col = rowFromBottom % 2 === 0 ? offset : 9 - offset;
  const visualRow = 9 - rowFromBottom;
  return { x: col * 10 + 5, y: visualRow * 10 + 5 };
}

function SnakesLiveBoard({ state, nowMs, serverOffsetMs }) {
  const ladders = state.boardConfig?.ladders || {};
  const snakes = state.boardConfig?.snakes || {};
  const players = state.players || [];

  const boardCells = useMemo(() => {
    const cells = [];
    for (let visualRow = 0; visualRow < 10; visualRow++) {
      const rowFromBottom = 9 - visualRow;
      for (let col = 0; col < 10; col++) {
        const offset = rowFromBottom % 2 === 0 ? col : 9 - col;
        const sq = rowFromBottom * 10 + offset + 1;
        cells.push({ sq, isAlt: (visualRow + col) % 2 === 1 });
      }
    }
    return cells;
  }, []);

  const turnRemainSec = state.turnClock?.deadlineAt
    ? formatSecondsLeft(state.turnClock.deadlineAt, serverOffsetMs, nowMs)
    : null;

  const atStart = players.filter(p => Number(p.position || 0) <= 0);
  const onBoard = players.filter(p => Number(p.position || 0) > 0);

  return (
    <div className="adm-live-board-wrap">
      <div className="adm-live-hud">
        <div className="adm-live-hud__item">
          <span className="adm-muted">Giliran #{state.turnNumber || 0}:</span>{' '}
          <strong>
            {state.status === 'finished'
              ? `Pemenang: ${state.winner || '-'}`
              : state.currentTurnPlayer?.display_name || state.currentTurnPlayer?.name || 'Lobby'}
          </strong>
        </div>
        <div className="adm-live-hud__chips">
          {state.lastRoll && (
            <Badge tone="brand">
              Dadu {state.lastRoll.dice}: {state.lastRoll.from}→{state.lastRoll.to}
            </Badge>
          )}
          {turnRemainSec !== null && <Badge tone="info">{turnRemainSec}d</Badge>}
        </div>
      </div>

      <div className="adm-snakes-wrap">
        <div className="adm-snakes-grid" role="img" aria-label="Papan Ular Tangga Realtime">
          {boardCells.map(({ sq, isAlt }) => {
            const ladderTo = ladders[sq];
            const snakeTo = snakes[sq];
            return (
              <div
                key={sq}
                className={[
                  'adm-snakes-cell',
                  isAlt ? 'is-alt' : '',
                  sq === 100 ? 'is-finish' : '',
                  sq === 1 ? 'is-start' : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <span className="adm-snakes-num">{sq}</span>
                {ladderTo && <span className="adm-snakes-tag is-ladder">↑{ladderTo}</span>}
                {snakeTo && <span className="adm-snakes-tag is-snake">↓{snakeTo}</span>}
              </div>
            );
          })}
        </div>

        <svg className="adm-snakes-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {Object.entries(ladders).map(([fromStr, toVal]) => {
            const a = snakesSquareCoord(Number(fromStr));
            const b = snakesSquareCoord(Number(toVal));
            if (!a || !b) return null;
            return (
              <line
                key={`l-${fromStr}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="rgba(34, 197, 94, 0.55)"
                strokeWidth="1.4"
                strokeDasharray="1.8 1.2"
                strokeLinecap="round"
              />
            );
          })}
          {Object.entries(snakes).map(([fromStr, toVal]) => {
            const a = snakesSquareCoord(Number(fromStr));
            const b = snakesSquareCoord(Number(toVal));
            if (!a || !b) return null;
            const mx = (a.x + b.x) / 2 + 4;
            const my = (a.y + b.y) / 2;
            return (
              <path
                key={`s-${fromStr}`}
                d={`M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`}
                fill="none"
                stroke="rgba(239, 68, 68, 0.6)"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            );
          })}
        </svg>

        <div className="adm-snakes-tokens">
          {onBoard.map((p, idx) => {
            const coord = snakesSquareCoord(p.position);
            if (!coord) return null;
            const sameCell = onBoard.filter(other => Number(other.position) === Number(p.position));
            const cellIdx = sameCell.findIndex(o => o.id === p.id);
            const offset = sameCell.length > 1 ? (cellIdx - (sameCell.length - 1) / 2) * 2.2 : 0;
            return (
              <span
                key={p.id || idx}
                className={`adm-snakes-pawn adm-snakes-pawn--${p.color || 'red'}`}
                style={{ left: `${coord.x + offset}%`, top: `${coord.y}%` }}
                title={`${p.display_name || p.name} (Kotak ${p.position})`}
              >
                {(p.display_name || p.name || 'P').slice(0, 1).toUpperCase()}
              </span>
            );
          })}
        </div>
      </div>

      {atStart.length > 0 && (
        <div className="adm-live-notice">
          Di Start (0):{' '}
          {atStart.map(p => `${p.display_name || p.name} (${p.color || '-'})`).join(' · ')}
        </div>
      )}
    </div>
  );
}

function QuizLiveArena({ state, nowMs, serverOffsetMs }) {
  const match = state.match;
  const players = state.players || [];
  const question = match?.question || null;
  const adminRound = match?.adminRound || null;
  const lastResult = match?.lastRoundResult || null;
  const answersByUser = adminRound?.answers || lastResult?.answers || {};
  const correctIndex =
    adminRound?.correctIndex ?? lastResult?.correctIndex ?? null;

  const countdownSec =
    state.phase === 'countdown' && state.countdownEndsAt
      ? formatSecondsLeft(state.countdownEndsAt, serverOffsetMs, nowMs)
      : state.phase === 'question' && (adminRound?.deadlineAt || question?.deadlineAt)
      ? formatSecondsLeft(adminRound?.deadlineAt || question?.deadlineAt, serverOffsetMs, nowMs)
      : null;

  return (
    <div className="adm-quiz-arena">
      <div className="adm-live-hud">
        <div className="adm-live-hud__item">
          <Badge tone={statusBadgeTone(state.phase === 'finished' ? 'finished' : state.phase === 'lobby' ? 'lobby' : 'playing')}>
            {String(state.phase || 'lobby').toUpperCase()}
          </Badge>
          {match && (
            <strong>
              Ronde {match.roundNo || 0} / {match.maxRounds || 0}
            </strong>
          )}
        </div>
        {countdownSec !== null && <Badge tone="warning">Sisa Waktu: {countdownSec}d</Badge>}
      </div>

      <div className="adm-quiz-players">
        {players.map(p => {
          const hp = Number(p.hp ?? 100);
          const maxHp = Number(p.maxHp || 100);
          const pct = Math.max(0, Math.min(100, Math.round((hp / maxHp) * 100)));
          const ans = answersByUser[p.userId];
          const optLetter =
            ans && Number.isInteger(ans.selectedIndex) && ans.selectedIndex >= 0
              ? String.fromCharCode(65 + ans.selectedIndex)
              : null;
          return (
            <div key={p.userId} className="adm-quiz-card">
              <div className="adm-quiz-card__head">
                <strong>
                  {p.name} {p.isBot && <small className="adm-muted">(BOT)</small>}
                </strong>
                <span className="adm-muted">{p.monster?.name || p.monsterId}</span>
              </div>
              <div className="adm-hp-track">
                <div className="adm-hp-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="adm-quiz-card__meta">
                <span>
                  HP {hp}/{maxHp}
                </span>
                <span>Benar: {p.correctAnswers || 0}</span>
              </div>
              {state.phase !== 'lobby' && (
                <div className="adm-quiz-card__ans">
                  {ans ? (
                    <Badge tone={ans.isCorrect ? 'success' : 'danger'}>
                      {optLetter ? `Opsi ${optLetter}` : 'Timeout'} ·{' '}
                      {ans.isCorrect ? 'Benar' : 'Salah'} (
                      {((Number(ans.responseMs) || 0) / 1000).toFixed(1)}d)
                    </Badge>
                  ) : p.answeredCurrentRound ? (
                    <Badge tone="info">Sudah menjawab</Badge>
                  ) : (
                    <span className="adm-muted">Menunggu jawaban...</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {question ? (
        <div className="adm-quiz-question">
          <div className="adm-quiz-question__meta">
            <Badge tone="info">{question.categoryLabel || question.category}</Badge>
            <span>{question.topic}</span>
            <span className="adm-muted">({question.difficulty})</span>
          </div>
          <p className="adm-quiz-question__prompt">{question.prompt}</p>
          <div className="adm-quiz-options">
            {(question.options || []).map((opt, idx) => {
              const letter = String.fromCharCode(65 + idx);
              const isCorrectOpt = correctIndex === idx;
              const pickedBy = players.filter(p => answersByUser[p.userId]?.selectedIndex === idx);
              return (
                <div key={idx} className={`adm-quiz-opt ${isCorrectOpt ? 'is-correct' : ''}`}>
                  <div className="adm-quiz-opt__label">
                    <strong>{letter}.</strong> {opt}
                    {isCorrectOpt && <Badge tone="success">Kunci Jawaban</Badge>}
                  </div>
                  {pickedBy.length > 0 && (
                    <div className="adm-quiz-opt__picks">
                      {pickedBy.map(p => (
                        <Badge key={p.userId} tone="neutral">
                          {p.name}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="adm-live-notice">
          {state.phase === 'finished'
            ? `Pertandingan selesai (${match?.endReason || '-'})`
            : 'Pertanyaan aktif belum dimulai (di lobby / jeda ronde).'}
        </div>
      )}

      {lastResult && state.phase === 'round_result' && (
        <div className="adm-live-notice">
          Hasil Ronde #{lastResult.roundNo}: <strong>{lastResult.outcome}</strong>
          {lastResult.damage > 0 ? ` · Damage: ${lastResult.damage} HP` : ''}
        </div>
      )}
    </div>
  );
}

export default function LiveRoomSpectatorModal({ room, onClose, onToast, onRequestCloseRoom }) {
  const [connStatus, setConnStatus] = useState('connecting'); // 'connecting' | 'live' | 'reconnecting' | 'closed' | 'error'
  const [connError, setConnError] = useState('');
  const [liveState, setLiveState] = useState(null);
  const [liveChats, setLiveChats] = useState([]);
  const [reactions, setReactions] = useState([]);
  const [closedReason, setClosedReason] = useState('');
  const [lastUpdateAt, setLastUpdateAt] = useState(null);
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!room) return undefined;
    const timer = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(timer);
  }, [room]);

  useEffect(() => {
    if (!room) {
      setLiveState(null);
      setLiveChats([]);
      setReactions([]);
      setClosedReason('');
      setConnError('');
      return undefined;
    }

    let active = true;
    const game = room.game;
    const code = String(room.code || '').toUpperCase();

    setConnStatus('connecting');
    setConnError('');
    setClosedReason('');
    setLiveState(null);
    setLiveChats([]);
    setReactions([]);

    const socket = io({
      autoConnect: true,
      transports: ['websocket', 'polling'],
      tryAllTransports: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000
    });

    const joinStealth = () => {
      const token = adminApi.getToken();
      socket.emit('admin:watch:join', { token, game, code }, res => {
        if (!active) return;
        if (!res?.ok) {
          setConnStatus('error');
          setConnError(res?.error || 'Gagal memasuki room dalam mode senyap.');
          return;
        }
        setConnStatus('live');
        setConnError('');
        setLiveState(res.state);
        setLiveChats(Array.isArray(res.state?.chats) ? res.state.chats : []);
        setLastUpdateAt(Date.now());
        if (res.serverNow) setServerOffsetMs(res.serverNow - Date.now());
      });
    };

    socket.on('connect', joinStealth);
    socket.on('disconnect', () => {
      if (!active) return;
      setConnStatus(prev => (prev === 'closed' || prev === 'error' ? prev : 'reconnecting'));
    });

    socket.on('admin:watch:state', payload => {
      if (!active || payload?.game !== game || payload?.code !== code) return;
      setLiveState(payload.state);
      if (Array.isArray(payload.state?.chats)) {
        setLiveChats(payload.state.chats);
      }
      setLastUpdateAt(Date.now());
      if (payload.serverNow) setServerOffsetMs(payload.serverNow - Date.now());
    });

    socket.on('admin:watch:chat', payload => {
      if (!active || payload?.game !== game || payload?.code !== code || !payload.message) return;
      setLiveChats(prev => {
        if (prev.some(m => String(m.id) === String(payload.message.id))) return prev;
        return [...prev.slice(-49), payload.message];
      });
      setLastUpdateAt(Date.now());
    });

    socket.on('admin:watch:reaction', payload => {
      if (!active || payload?.game !== game || payload?.code !== code || !payload.reaction) return;
      setReactions(prev => [...prev.slice(-7), { ...payload.reaction, receivedAt: Date.now() }]);
      setLastUpdateAt(Date.now());
    });

    socket.on('admin:watch:closed', payload => {
      if (!active || payload?.game !== game || payload?.code !== code) return;
      setConnStatus('closed');
      setClosedReason(payload.reason || 'Room telah ditutup.');
      onToast?.('info', `Room ${game.toUpperCase()} #${code} ditutup.`);
    });

    return () => {
      active = false;
      try {
        socket.emit('admin:watch:leave');
      } catch {}
      socket.disconnect();
    };
  }, [room?.game, room?.code, onToast]);

  const players = liveState?.players || room?.players || [];

  const activityLog = useMemo(() => {
    if (!liveState || !room) return [];
    if (room.game === 'ludo') {
      return (liveState.history || []).slice(0, 20).map(h => ({
        id: h.id || `${h.time}-${h.text}`,
        text: h.text,
        time: h.time
      }));
    }
    if (room.game === 'snakes') {
      return (liveState.moveLog || [])
        .slice()
        .reverse()
        .slice(0, 20)
        .map(m => ({
          id: m.id,
          text: `${m.displayName}: Dadu ${m.dice} (${m.from} → ${m.to})${m.ladder ? ' [Tangga]' : ''}${m.snake ? ' [Ular]' : ''}`,
          time: m.extraTurn ? 'Bonus 6' : ''
        }));
    }
    if (room.game === 'chess') {
      return (liveState.match?.moves || [])
        .slice()
        .reverse()
        .slice(0, 20)
        .map(m => ({
          id: m.moveNumber,
          text: `#${m.moveNumber} (${m.color === 'w' ? 'Putih' : 'Hitam'}): ${m.san}`,
          time: ''
        }));
    }
    if (room.game === 'quiz' && liveState.match?.lastRoundResult) {
      const r = liveState.match.lastRoundResult;
      return [
        {
          id: r.roundId,
          text: `Ronde #${r.roundNo}: ${r.outcome}${r.damage ? ` (-${r.damage} HP)` : ''}`,
          time: ''
        }
      ];
    }
    return [];
  }, [liveState, room]);

  return (
    <AdminModal
      isOpen={Boolean(room)}
      onClose={onClose}
      title={`Pantau Live (Mode Senyap) · ${room?.gameLabel || ''} #${room?.code || ''}`}
      subtitle="Streaming realtime state permainan langsung dari server (read-only)."
      size="xl"
    >
      {room && (
        <div className="adm-stack">
          {/* Banner Mode Senyap */}
          <div className={`adm-live-banner is-${connStatus}`}>
            <div className="adm-live-banner__left">
              <span className={`adm-live-pill is-${connStatus}`}>
                <span className="adm-live-pulse" />
                {connStatus === 'live'
                  ? 'LIVE · MODE SENYAP'
                  : connStatus === 'connecting'
                  ? 'MENGHUBUNGKAN...'
                  : connStatus === 'reconnecting'
                  ? 'TERHUBUNG ULANG...'
                  : connStatus === 'closed'
                  ? 'ROOM DITUTUP'
                  : 'GAGAL TERHUBUNG'}
              </span>
              <span className="adm-live-banner__desc">
                {connStatus === 'closed'
                  ? closedReason
                  : 'Pemain tidak diberitahu bahwa Anda sedang memantau room ini.'}
              </span>
            </div>
            <div className="adm-row-actions">
              <Badge tone={gameBadgeTone(room.game)}>{room.gameLabel}</Badge>
              {lastUpdateAt && (
                <span className="adm-muted" style={{ fontSize: 12 }}>
                  Update {new Date(lastUpdateAt).toLocaleTimeString('id-ID')}
                </span>
              )}
              {connStatus !== 'closed' && (
                <button
                  type="button"
                  className="adm-btn adm-btn--danger-ghost adm-btn--sm"
                  onClick={() => onRequestCloseRoom?.(room)}
                >
                  <AdminIcon name="stop" size={14} />
                  <span>Tutup Paksa</span>
                </button>
              )}
            </div>
          </div>

          {connError ? (
            <div className="adm-alert adm-alert--danger">{connError}</div>
          ) : !liveState ? (
            <div className="adm-loading-box" role="status">
              <span className="adm-spinner" /> Mengambil snapshot live room...
            </div>
          ) : (
            <div className="adm-live-layout">
              {/* Kiri: Visual Papan Game Realtime */}
              <div className="adm-live-stage">
                {room.game === 'ludo' && (
                  <LudoLiveBoard state={liveState} nowMs={nowMs} serverOffsetMs={serverOffsetMs} />
                )}
                {room.game === 'chess' && (
                  <ChessLiveBoard state={liveState} nowMs={nowMs} serverOffsetMs={serverOffsetMs} />
                )}
                {room.game === 'snakes' && (
                  <SnakesLiveBoard state={liveState} nowMs={nowMs} serverOffsetMs={serverOffsetMs} />
                )}
                {room.game === 'quiz' && (
                  <QuizLiveArena state={liveState} nowMs={nowMs} serverOffsetMs={serverOffsetMs} />
                )}
              </div>

              {/* Kanan: Telemetri Pemain, Chat, & Log */}
              <aside className="adm-live-sidebar">
                <section className="adm-live-panel">
                  <div className="adm-live-panel__head">
                    <h4>Pemain di Meja ({players.length})</h4>
                    <span className="adm-muted">Realtime</span>
                  </div>
                  <div className="adm-live-players">
                    {players.map((p, idx) => {
                      const isConnected = p.isBot || p.connected !== false;
                      return (
                        <div key={`${p.id || p.userId || idx}`} className="adm-live-player-row">
                          <div className="adm-live-player-row__name">
                            <span className={`adm-dot ${isConnected ? 'adm-dot--online' : ''}`} />
                            <strong>{p.display_name || p.name}</strong>
                            {p.isBot && <Badge tone="neutral">BOT</Badge>}
                          </div>
                          <div className="adm-muted" style={{ fontSize: 12 }}>
                            {p.color && `${p.color} `}
                            {p.hp !== undefined && `HP ${p.hp} `}
                            {p.position !== undefined && `Petak ${p.position} `}
                            {p.rating && `Elo ${p.rating}`}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section className="adm-live-panel">
                  <div className="adm-live-panel__head">
                    <h4>Chat &amp; Reaksi Live</h4>
                    <Badge tone="neutral">Read-only</Badge>
                  </div>
                  {reactions.length > 0 && (
                    <div className="adm-live-reactions">
                      {reactions.map((rx, i) => (
                        <span key={rx.id || i} className="adm-live-rx-chip">
                          {rx.emoji} {rx.playerName}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="adm-live-feed">
                    {liveChats.length === 0 ? (
                      <div className="adm-muted" style={{ fontSize: 12 }}>
                        Belum ada obrolan di room ini.
                      </div>
                    ) : (
                      liveChats.map((msg, i) => (
                        <div key={msg.id || i} className="adm-live-chat-msg">
                          <div className="adm-live-chat-msg__top">
                            <strong>{msg.senderName}</strong>
                            <span className="adm-muted">{msg.time}</span>
                          </div>
                          <div>{msg.text}</div>
                        </div>
                      ))
                    )}
                  </div>
                </section>

                <section className="adm-live-panel">
                  <div className="adm-live-panel__head">
                    <h4>Log Aktivitas ({activityLog.length})</h4>
                  </div>
                  <div className="adm-live-feed adm-live-feed--sm">
                    {activityLog.length === 0 ? (
                      <div className="adm-muted" style={{ fontSize: 12 }}>
                        Belum ada aktivitas pertandingan.
                      </div>
                    ) : (
                      activityLog.map((item, i) => (
                        <div key={item.id || i} className="adm-live-log-item">
                          <span>{item.text}</span>
                          {item.time && <span className="adm-muted">{item.time}</span>}
                        </div>
                      ))
                    )}
                  </div>
                </section>
              </aside>
            </div>
          )}
        </div>
      )}
    </AdminModal>
  );
}
