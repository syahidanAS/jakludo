import React, { useMemo, useState } from 'react';
import Icon from '../components/Icon';
import Modal from '../components/Modal';
import PlayerAvatar from '../components/PlayerAvatar';
import Dice3D from '../Dice3D';
import TurnTimer from '../components/game/TurnTimer';
import ChatPanel from '../components/game/ChatPanel';
import { DEFAULT_LADDERS, DEFAULT_SNAKES } from '../hooks/useSnakesLadders';
import snakesLogo from '../assets/snakes-ladders-logo.webp';
import { sound } from '../sound';

const REACTIONS = ['🎲', '🔥', '👏', '😂', '😭', '👑'];
const SNAKES_QUICK_CHATS = [
  'Semoga beruntung! 🎲',
  'Asyik dapat tangga! 🪜',
  'Aduh kena ular! 🐍',
  'Dikit lagi kotak 100! 🏁',
  'Ayo lempar dadunya! ⏳',
  'GG! Main lagi yuk! 🔥'
];

// Konversi nomor kotak (1..100) ke koordinat visual 10x10 zig-zag
// Nomor 1 di kiri bawah (visualRow = 9, col = 0)
// Nomor 100 di kiri atas (visualRow = 0, col = 0)
export function getSquareCoords(square) {
  const num = Number(square);
  if (!Number.isInteger(num) || num < 1 || num > 100) return null;
  const zeroBased = num - 1;
  const rowFromBottom = Math.floor(zeroBased / 10);
  const offsetInRow = zeroBased % 10;
  const col = rowFromBottom % 2 === 0 ? offsetInRow : 9 - offsetInRow;
  const visualRow = 9 - rowFromBottom;
  return {
    square: num,
    visualRow,
    col,
    xPercent: col * 10 + 5,
    yPercent: visualRow * 10 + 5,
    svgX: col * 100 + 50,
    svgY: visualRow * 100 + 50
  };
}

function buildBoardRows() {
  const rows = [];
  for (let visualRow = 0; visualRow < 10; visualRow++) {
    const rowFromBottom = 9 - visualRow;
    const base = rowFromBottom * 10;
    const cells = [];
    for (let col = 0; col < 10; col++) {
      const sq = rowFromBottom % 2 === 0 ? base + col + 1 : base + (10 - col);
      cells.push(sq);
    }
    rows.push({ visualRow, cells });
  }
  return rows;
}

const BOARD_ROWS = buildBoardRows();

const SNAKE_PALETTES = [
  { body: '#ef4444', stripe: '#fecaca', head: '#dc2626' },
  { body: '#8b5cf6', stripe: '#ddd6fe', head: '#7c3aed' },
  { body: '#10b981', stripe: '#a7f3d0', head: '#059669' },
  { body: '#f97316', stripe: '#fed7aa', head: '#ea580c' },
  { body: '#ec4899', stripe: '#fbcfe8', head: '#db2777' },
  { body: '#06b6d4', stripe: '#cffafe', head: '#0891b2' },
  { body: '#eab308', stripe: '#fef08a', head: '#ca8a04' },
  { body: '#6366f1', stripe: '#e0e7ff', head: '#4f46e5' }
];

function SnakesAndLaddersSvgOverlay({ ladders = DEFAULT_LADDERS, snakes = DEFAULT_SNAKES }) {
  const ladderItems = useMemo(() => {
    return Object.entries(ladders)
      .map(([fromStr, toVal]) => {
        const start = getSquareCoords(Number(fromStr));
        const end = getSquareCoords(Number(toVal));
        if (!start || !end) return null;
        const dx = end.svgX - start.svgX;
        const dy = end.svgY - start.svgY;
        const len = Math.hypot(dx, dy) || 1;
        const nx = (-dy / len) * 15;
        const ny = (dx / len) * 15;
        const stepsCount = Math.max(3, Math.floor(len / 48));
        const rungs = [];
        for (let i = 1; i < stepsCount; i++) {
          const t = i / stepsCount;
          const cx = start.svgX + dx * t;
          const cy = start.svgY + dy * t;
          rungs.push({
            x1: cx - nx,
            y1: cy - ny,
            x2: cx + nx,
            y2: cy + ny
          });
        }
        return {
          key: `${fromStr}-${toVal}`,
          from: Number(fromStr),
          to: Number(toVal),
          leftRail: { x1: start.svgX - nx, y1: start.svgY - ny, x2: end.svgX - nx, y2: end.svgY - ny },
          rightRail: { x1: start.svgX + nx, y1: start.svgY + ny, x2: end.svgX + nx, y2: end.svgY + ny },
          rungs
        };
      })
      .filter(Boolean);
  }, [ladders]);

  const snakeItems = useMemo(() => {
    return Object.entries(snakes)
      .map(([headStr, tailVal], idx) => {
        const head = getSquareCoords(Number(headStr));
        const tail = getSquareCoords(Number(tailVal));
        if (!head || !tail) return null;
        const dx = tail.svgX - head.svgX;
        const dy = tail.svgY - head.svgY;
        const len = Math.hypot(dx, dy) || 1;
        const perpX = (-dy / len) * 44 * (idx % 2 === 0 ? 1 : -1);
        const perpY = (dx / len) * 44 * (idx % 2 === 0 ? 1 : -1);

        const c1x = head.svgX + dx * 0.33 + perpX;
        const c1y = head.svgY + dy * 0.33 + perpY;
        const c2x = head.svgX + dx * 0.66 - perpX;
        const c2y = head.svgY + dy * 0.66 - perpY;

        const pathD = `M ${head.svgX} ${head.svgY} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${tail.svgX} ${tail.svgY}`;
        const palette = SNAKE_PALETTES[idx % SNAKE_PALETTES.length];
        return {
          key: `${headStr}-${tailVal}`,
          head,
          tail,
          pathD,
          palette
        };
      })
      .filter(Boolean);
  }, [snakes]);

  return (
    <svg
      className="snakes-board__svg"
      viewBox="0 0 1000 1000"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <filter id="snk-shadow" x="-15%" y="-15%" width="130%" height="130%">
          <feDropShadow dx="0" dy="4" stdDeviation="4" floodColor="#0f172a" floodOpacity="0.38" />
        </filter>
      </defs>

      {/* Gambar Tangga (Ladders) */}
      <g filter="url(#snk-shadow)">
        {ladderItems.map(item => (
          <g key={item.key} className="snakes-svg-ladder">
            <line
              x1={item.leftRail.x1}
              y1={item.leftRail.y1}
              x2={item.leftRail.x2}
              y2={item.leftRail.y2}
              stroke="#b45309"
              strokeWidth="9"
              strokeLinecap="round"
            />
            <line
              x1={item.rightRail.x1}
              y1={item.rightRail.y1}
              x2={item.rightRail.x2}
              y2={item.rightRail.y2}
              stroke="#b45309"
              strokeWidth="9"
              strokeLinecap="round"
            />
            <line
              x1={item.leftRail.x1}
              y1={item.leftRail.y1}
              x2={item.leftRail.x2}
              y2={item.leftRail.y2}
              stroke="#facc15"
              strokeWidth="4.5"
              strokeLinecap="round"
            />
            <line
              x1={item.rightRail.x1}
              y1={item.rightRail.y1}
              x2={item.rightRail.x2}
              y2={item.rightRail.y2}
              stroke="#facc15"
              strokeWidth="4.5"
              strokeLinecap="round"
            />
            {item.rungs.map((r, rIdx) => (
              <line
                key={rIdx}
                x1={r.x1}
                y1={r.y1}
                x2={r.x2}
                y2={r.y2}
                stroke="#fde047"
                strokeWidth="6"
                strokeLinecap="round"
              />
            ))}
          </g>
        ))}
      </g>

      {/* Gambar Ular (Snakes) */}
      <g filter="url(#snk-shadow)">
        {snakeItems.map(s => (
          <g key={s.key} className="snakes-svg-snake">
            <path
              d={s.pathD}
              fill="none"
              stroke={s.palette.body}
              strokeWidth="20"
              strokeLinecap="round"
            />
            <path
              d={s.pathD}
              fill="none"
              stroke={s.palette.stripe}
              strokeWidth="8"
              strokeDasharray="10 14"
              strokeLinecap="round"
            />
            {/* Ekor ular */}
            <circle cx={s.tail.svgX} cy={s.tail.svgY} r="7" fill={s.palette.body} />
            {/* Kepala ular */}
            <circle cx={s.head.svgX} cy={s.head.svgY} r="16" fill={s.palette.head} />
            <circle cx={s.head.svgX - 5} cy={s.head.svgY - 4} r="3.8" fill="#ffffff" />
            <circle cx={s.head.svgX + 5} cy={s.head.svgY - 4} r="3.8" fill="#ffffff" />
            <circle cx={s.head.svgX - 5} cy={s.head.svgY - 4} r="1.8" fill="#0f172a" />
            <circle cx={s.head.svgX + 5} cy={s.head.svgY - 4} r="1.8" fill="#0f172a" />
          </g>
        ))}
      </g>
    </svg>
  );
}

function SnakesPlayerBadge({ player, isCurrentTurn, isMe, animatedPos, turnClock, onViewProfile }) {
  const isBot = player.player_type === 'bot' || player.isBot;
  const pos = animatedPos !== undefined ? animatedPos : Number(player.position) || 0;

  return (
    <div
      className={`snk-player-card card color-${player.color || 'red'} ${
        isCurrentTurn ? 'is-active-turn card--focus' : ''
      }`}
    >
      <div className="snk-player-card__head">
        <div className="snk-player-card__avatar-wrap">
          {isBot ? (
            <span className="avatar snk-bot-avatar" aria-label="Ikon Pemain Komputer">
              <Icon name="bot" size={20} />
            </span>
          ) : (
            <PlayerAvatar
              avatar={player.avatar}
              name={player.display_name || player.name || 'Pemain'}
              size={38}
              className="avatar"
            />
          )}
          <span className={`snk-color-dot color-${player.color || 'red'}`} aria-hidden="true" />
        </div>

        <div className="snk-player-card__identity">
          <div className="snk-player-card__name-row">
            {!isBot && player.user_id && onViewProfile ? (
              <button
                type="button"
                className="user-link"
                onClick={() => onViewProfile(player.user_id)}
              >
                <strong>{player.display_name || player.name}</strong>
              </button>
            ) : (
              <strong>{isBot ? 'Pemain Komputer' : player.display_name || player.name}</strong>
            )}
            {isMe && <span className="badge badge--brand">Kamu</span>}
            {isBot && (
              <span className="badge snk-bot-badge" title="Lawan otomatis komputer">
                <Icon name="bot" size={12} /> Bot
              </span>
            )}
          </div>
          <span className="muted snk-player-card__sub">
            {isBot ? 'Lawan Komputer Otomatis' : `@${player.username || 'pemain'}`}
            {!isBot && !player.connected ? ' · Terputus...' : ''}
          </span>
        </div>

        <div className="snk-player-card__pos">
          <span className="snk-player-card__pos-label muted">Posisi</span>
          <strong className="snk-player-card__pos-value">
            {pos === 0 ? 'Start (0)' : `Kotak ${pos}`}
          </strong>
        </div>
      </div>

      {isCurrentTurn && (
        <div className="snk-player-card__turn-bar">
          <span className="snk-turn-pill">
            {isMe ? '🎲 Giliranmu Sekarang!' : isBot ? '🤖 Komputer sedang melempar dadu...' : `⏳ Giliran ${player.display_name}`}
          </span>
          {turnClock && <TurnTimer clock={turnClock} isMine={isMe} />}
        </div>
      )}
    </div>
  );
}

export default function SnakesLaddersScreen({
  snakes,
  currentUser,
  onBackToMenu,
  onOpenAuth,
  onOpenLeaderboard,
  onViewProfile
}) {
  const {
    room,
    joinCode,
    searching,
    searchElapsedSec,
    searchTimeoutSec,
    matchAnnouncement,
    rolling,
    diceValue,
    animatingMove,
    animatedPositions,
    boardEffect,
    error,
    notice,
    matchResult,
    stats,
    history,
    leaderboard,
    loadingMeta,
    chats,
    unreadChats,
    chatOpen,
    actions
  } = snakes;

  const [copiedCode, setCopiedCode] = useState(false);
  const [showMobileHistory, setShowMobileHistory] = useState(false);

  const ladders = room?.boardConfig?.ladders || DEFAULT_LADDERS;
  const snakesMap = room?.boardConfig?.snakes || DEFAULT_SNAKES;

  const copyRoomCode = code => {
    if (!code) return;
    sound.playClick?.();
    navigator.clipboard?.writeText(code).catch(() => {});
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const shareRoomCode = code => {
    if (!code) return;
    sound.playClick?.();
    const shareText = `Ayo main Ular Tangga (Snakes and Ladders) bareng aku di PlayGo! Masukkan kode room: ${code}`;
    if (navigator.share) {
      navigator.share({ title: 'PlayGo · Ular Tangga', text: shareText, url: window.location.origin + '/?game=snakes-and-ladders' }).catch(() => {});
    } else {
      copyRoomCode(code);
    }
  };

  // ==========================================
  // VIEW 1: PRIVATE ROOM WAITING LOBBY
  // ==========================================
  if (room && room.status === 'waiting') {
    const isHost = currentUser && room.hostUserId === currentUser.id;
    const canStart = isHost && (room.players?.length || 0) >= 2;

    return (
      <main className="snk-screen" id="main">
        <div className="playgo-subnav">
          <button type="button" className="btn btn--secondary" onClick={actions.leaveRoom}>
            <Icon name="arrow-left" size={18} />
            <span>Keluar Room</span>
          </button>
          <span className="badge badge--brand">Private Room · Ular Tangga</span>
        </div>

        {error && <p className="alert alert--error" role="alert">{error}</p>}
        {notice && <p className="alert" role="status">{notice}</p>}

        <section className="snk-waiting-card card card--focus">
          <div className="snk-waiting-card__head">
            <span className="playgo-eyebrow">RUANG TUNGGU PRIVATE</span>
            <h2>Kode Room: <span className="code-text">{room.code}</span></h2>
            <p className="muted">
              Bagikan kode room ini kepada temanmu. Permainan hanya dapat diikuti oleh pemain yang memiliki kode ini.
            </p>
            <div className="snk-waiting-card__code-actions">
              <button type="button" className="btn btn--secondary" onClick={() => copyRoomCode(room.code)}>
                {copiedCode ? '✓ Kode Disalin!' : '📋 Salin Kode Room'}
              </button>
              <button type="button" className="btn btn--secondary" onClick={() => shareRoomCode(room.code)}>
                🔗 Bagikan Kode
              </button>
            </div>
          </div>

          <div className="snk-waiting-players">
            <h3>Daftar Pemain ({room.players.length} / {room.maxPlayers || 2})</h3>
            <div className="snk-waiting-players__grid">
              {room.players.map((p, idx) => (
                <div key={p.id} className={`snk-waiting-slot card color-${p.color}`}>
                  <PlayerAvatar avatar={p.avatar} name={p.display_name} size={42} className="avatar" />
                  <div>
                    <strong>{p.display_name}</strong>
                    <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-xs)' }}>
                      {p.user_id === room.hostUserId ? '👑 Host Room' : `Pemain #${idx + 1}`} · Siap
                    </p>
                  </div>
                </div>
              ))}
              {Array.from({ length: Math.max(0, (room.maxPlayers || 2) - room.players.length) }).map((_, i) => (
                <div key={`empty-${i}`} className="snk-waiting-slot snk-waiting-slot--empty card">
                  <span className="spinner" aria-hidden="true" />
                  <span className="muted">Menunggu teman bergabung dengan kode <strong>{room.code}</strong>...</span>
                </div>
              ))}
            </div>
          </div>

          {/* Bar Emoticon & Tombol Chat di Ruang Tunggu */}
          <div className="turn-panel__toolbar" style={{ marginTop: 'var(--space-3)' }}>
            <div className="reaction-row" role="group" aria-label="Kirim reaksi">
              {REACTIONS.map(emoji => (
                <button
                  key={emoji}
                  type="button"
                  className="icon-btn icon-btn--plain"
                  aria-label={`Kirim reaksi ${emoji}`}
                  onClick={() => actions.sendReaction(emoji)}
                >
                  <span aria-hidden="true">{emoji}</span>
                </button>
              ))}
            </div>
            <div className="turn-panel__tools">
              <button
                type="button"
                className="icon-btn"
                aria-label={`Buka obrolan${unreadChats ? `, ${unreadChats} pesan baru` : ''}`}
                onClick={() => actions.setChatOpen(true)}
              >
                <span aria-hidden="true">💬</span>
                {unreadChats > 0 && <span className="count-badge" aria-hidden="true">{unreadChats}</span>}
              </button>
            </div>
          </div>

          <div className="snk-waiting-card__footer">
            {isHost ? (
              <button
                type="button"
                className="btn btn--primary btn--lg btn--block"
                disabled={!canStart}
                onClick={actions.startPrivateRoom}
              >
                {canStart ? '🎲 Mulai Permainan Sekarang' : 'Menunggu Minimal 2 Pemain...'}
              </button>
            ) : (
              <p className="muted" style={{ textAlign: 'center', margin: 0 }}>
                Menunggu Host memulai permainan...
              </p>
            )}
          </div>
        </section>

        <Modal
          isOpen={chatOpen}
          onClose={() => actions.setChatOpen(false)}
          variant="sheet"
          size="md"
          icon="💬"
          title="Obrolan Room Ular Tangga"
          subtitle={`Room ${room.code}`}
        >
          <ChatPanel
            chats={chats}
            playerId={currentUser?.id}
            onSend={actions.sendChat}
            quickChats={SNAKES_QUICK_CHATS}
          />
        </Modal>
      </main>
    );
  }

  // ==========================================
  // VIEW 2: ACTIVE / FINISHED GAME SCREEN
  // ==========================================
  if (room && (room.status === 'playing' || room.status === 'finished')) {
    const players = room.players || [];
    const currentTurnPlayer = players[room.turnIndex] || null;
    const canRoll = Boolean(
      room.status === 'playing' &&
      room.isMyTurn &&
      !rolling &&
      !animatingMove
    );

    const startDockPlayers = players.filter(p => {
      const pos = animatedPositions[p.id] !== undefined ? animatedPositions[p.id] : Number(p.position) || 0;
      return pos === 0;
    });

    const boardPlayers = players.filter(p => {
      const pos = animatedPositions[p.id] !== undefined ? animatedPositions[p.id] : Number(p.position) || 0;
      return pos >= 1 && pos <= 100;
    });

    const myPlayer = players.find(p => p.player_type === 'human' && p.user_id === currentUser?.id);
    const opponentPlayer = players.find(p => p.id !== myPlayer?.id) || players[1] || null;
    const isBotMatch = room.opponentType === 'bot' || players.some(p => p.player_type === 'bot');
    const didIWin = Boolean(
      matchResult &&
      ((currentUser?.id && matchResult.winnerUserId === currentUser.id) ||
        (myPlayer && matchResult.winnerPlayerId === myPlayer.id))
    );

    return (
      <main className="snk-game-layout" id="main">
        {/* Top Bar Pertandingan */}
        <header className="snk-game-topbar card">
          <div className="snk-game-topbar__left">
            <button type="button" className="btn btn--secondary btn--sm" onClick={actions.leaveRoom}>
              <Icon name="arrow-left" size={16} />
              <span>Keluar</span>
            </button>
            <div>
              <strong className="snk-game-topbar__title">Ular Tangga · Room {room.code}</strong>
              <span className="muted snk-game-topbar__sub">
                {isBotMatch ? '🤖 Melawan Pemain Komputer' : '👥 Pertandingan Multiplayer Manusia'} · Giliran #{room.turnNumber || 1}
              </span>
            </div>
          </div>
          <div className="snk-game-topbar__right">
            <button
              type="button"
              className="btn btn--secondary btn--sm hide-desktop"
              onClick={() => setShowMobileHistory(true)}
            >
              📜 Log ({room.moveLog?.length || 0})
            </button>
          </div>
        </header>

        {matchAnnouncement && (
          <div
            className={`snk-match-banner card ${
              matchAnnouncement.type === 'bot' ? 'snk-match-banner--bot' : 'snk-match-banner--human'
            }`}
            role="status"
          >
            {matchAnnouncement.type === 'bot' ? (
              <>
                <span className="snk-bot-avatar"><Icon name="bot" size={20} /></span>
                <div>
                  <strong>{matchAnnouncement.message}</strong>
                  <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-xs)' }}>
                    Lawan: <strong>Pemain Komputer</strong> (Bot Otomatis)
                  </p>
                </div>
              </>
            ) : (
              <>
                <PlayerAvatar
                  avatar={matchAnnouncement.opponent?.avatar}
                  name={matchAnnouncement.opponent?.display_name || 'Lawan'}
                  size={36}
                  className="avatar"
                />
                <div>
                  <strong>🎉 {matchAnnouncement.message}</strong>
                  <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-xs)' }}>
                    Melawan <strong>{matchAnnouncement.opponent?.display_name}</strong> (@{matchAnnouncement.opponent?.username})
                  </p>
                </div>
              </>
            )}
          </div>
        )}

        {error && <p className="alert alert--error" role="alert">{error}</p>}
        {notice && <p className="alert" role="status">{notice}</p>}

        <div className="snk-game-grid">
          {/* AREA UTAMA: PAPAN ULAR TANGGA 10x10 */}
          <section className="snk-board-column" aria-label="Papan Permainan Ular Tangga 100 Kotak">
            {/* Kartu Pemain di Mobile (Atas Papan: Lawan) */}
            <div className="snk-mobile-players hide-desktop">
              {players.map(p => (
                <SnakesPlayerBadge
                  key={p.id}
                  player={p}
                  isCurrentTurn={currentTurnPlayer?.id === p.id && room.status === 'playing'}
                  isMe={p.player_type === 'human' && p.user_id === currentUser?.id}
                  animatedPos={animatedPositions[p.id]}
                  turnClock={room.turnClock}
                  onViewProfile={onViewProfile}
                />
              ))}
            </div>

            <div className="snk-board-frame card">
              <div className="snakes-board">
                {BOARD_ROWS.map(row => (
                  <div key={row.visualRow} className="snakes-board__row">
                    {row.cells.map(sq => {
                      const ladderTo = ladders[sq];
                      const snakeTo = snakesMap[sq];
                      const isStart = sq === 1;
                      const isFinish = sq === 100;
                      const isAlt = (row.visualRow + (sq % 2)) % 2 === 0;

                      return (
                        <div
                          key={sq}
                          data-square={sq}
                          className={`snakes-cell ${isAlt ? 'snakes-cell--alt' : ''} ${
                            ladderTo ? 'snakes-cell--ladder' : ''
                          } ${snakeTo ? 'snakes-cell--snake' : ''} ${
                            isFinish ? 'snakes-cell--finish' : ''
                          } ${isStart ? 'snakes-cell--start' : ''}`}
                        >
                          <span className="snakes-cell__num">{sq}</span>
                          {isFinish && <span className="snakes-cell__tag snakes-cell__tag--finish" title="Kotak 100 Kemenangan">👑</span>}
                          {isStart && <span className="snakes-cell__tag snakes-cell__tag--start">START</span>}
                          {ladderTo && (
                            <span className="snakes-cell__tag snakes-cell__tag--ladder" title={`Tangga naik ke ${ladderTo}`}>
                              🪜{ladderTo}
                            </span>
                          )}
                          {snakeTo && (
                            <span className="snakes-cell__tag snakes-cell__tag--snake" title={`Ular turun ke ${snakeTo}`}>
                              🐍{snakeTo}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}

                {/* Overlay SVG Ular & Tangga */}
                <SnakesAndLaddersSvgOverlay ladders={ladders} snakes={snakesMap} />

                {/* Bidak Pemain yang Sudah Berada di Papan (Kotak 1..100) */}
                <div className="snakes-board__tokens" aria-live="polite">
                  {boardPlayers.map((p, idx) => {
                    const pos = animatedPositions[p.id] !== undefined ? animatedPositions[p.id] : Number(p.position) || 0;
                    const coords = getSquareCoords(pos);
                    if (!coords) return null;

                    // Offset kecil bila dua bidak berada di kotak yang sama
                    const sameSquarePlayers = boardPlayers.filter(other => {
                      const oPos = animatedPositions[other.id] !== undefined ? animatedPositions[other.id] : Number(other.position) || 0;
                      return oPos === pos;
                    });
                    const offsetIdx = sameSquarePlayers.findIndex(o => o.id === p.id);
                    const shiftX = sameSquarePlayers.length > 1 ? (offsetIdx === 0 ? -1.8 : 1.8) : 0;
                    const shiftY = sameSquarePlayers.length > 1 ? (offsetIdx === 0 ? -1.4 : 1.4) : 0;

                    return (
                      <div
                        key={p.id}
                        className={`snk-token color-${p.color || 'red'} ${
                          currentTurnPlayer?.id === p.id ? 'is-turn' : ''
                        }`}
                        style={{
                          left: `${coords.xPercent + shiftX}%`,
                          top: `${coords.yPercent + shiftY}%`
                        }}
                        title={`${p.display_name} — Kotak ${pos}`}
                      >
                        <span className="snk-token__inner">
                          {p.player_type === 'bot' ? '🤖' : p.display_name?.slice(0, 1).toUpperCase() || (idx + 1)}
                        </span>
                      </div>
                    );
                  })}
                </div>

                {/* Efek Visual Tangga / Ular / Pantulan 100 */}
                {boardEffect && (
                  <div className={`snk-board-effect snk-board-effect--${boardEffect.type}`} role="status">
                    {boardEffect.type === 'ladder' && (
                      <>
                        <span className="snk-board-effect__icon">🪜✨</span>
                        <div>
                          <strong>Naik Tangga! ({boardEffect.from} → {boardEffect.to})</strong>
                          <p>{boardEffect.playerName} melesat naik ke kotak {boardEffect.to}!</p>
                        </div>
                      </>
                    )}
                    {boardEffect.type === 'snake' && (
                      <>
                        <span className="snk-board-effect__icon">🐍💨</span>
                        <div>
                          <strong>Terkena Ular! ({boardEffect.from} → {boardEffect.to})</strong>
                          <p>{boardEffect.playerName} meluncur turun ke kotak {boardEffect.to}!</p>
                        </div>
                      </>
                    )}
                    {boardEffect.type === 'overshoot' && (
                      <>
                        <span className="snk-board-effect__icon">🎯</span>
                        <div>
                          <strong>Melewati Kotak 100!</strong>
                          <p>{boardEffect.playerName} tetap di kotak {boardEffect.from} (butuh angka pas ke 100).</p>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Area Start (Posisi 0 - Belum Masuk Papan) */}
              <div className="snk-start-dock">
                <span className="snk-start-dock__label muted">Posisi Awal (Kotak 0):</span>
                {startDockPlayers.length === 0 ? (
                  <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>Semua bidak sudah berada di atas papan</span>
                ) : (
                  <div className="snk-start-dock__tokens">
                    {startDockPlayers.map(p => (
                      <span key={p.id} className={`snk-dock-chip color-${p.color}`}>
                        <span className="snk-dock-chip__dot" />
                        <span>{p.display_name} (Kotak 0)</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* PANEL SAMPING (INFORMASI PEMAIN, GILIRAN, DADU, RIWAYAT, CHAT) */}
          <aside className="snk-side-column">
            {/* Daftar Pemain (Desktop) */}
            <div className="snk-desktop-players show-desktop">
              {players.map(p => (
                <SnakesPlayerBadge
                  key={p.id}
                  player={p}
                  isCurrentTurn={currentTurnPlayer?.id === p.id && room.status === 'playing'}
                  isMe={p.player_type === 'human' && p.user_id === currentUser?.id}
                  animatedPos={animatedPositions[p.id]}
                  turnClock={room.turnClock}
                  onViewProfile={onViewProfile}
                />
              ))}
            </div>

            {/* Panel Giliran & Dadu 3D */}
            <section className={`turn-panel card ${room.isMyTurn ? 'is-my-turn card--focus' : ''}`} aria-label="Kontrol Dadu dan Giliran">
              <div className="turn-panel__main">
                <Dice3D
                  value={diceValue || room.lastRoll?.dice || 1}
                  isRolling={rolling}
                  canRoll={canRoll}
                  onRoll={actions.rollDice}
                  disabled={!canRoll}
                  playerColor={currentTurnPlayer?.color || 'red'}
                />

                <div className="turn-panel__side">
                  <p className={`turn-panel__who color-${currentTurnPlayer?.color || 'red'}`}>
                    <span className="dot" style={{ background: 'var(--pc)' }} aria-hidden="true" />
                    <span className="turn-panel__who-name">
                      {room.status === 'finished'
                        ? `🏆 Pemenang: ${room.winner?.display_name || 'Pemain'}`
                        : room.isMyTurn
                        ? 'Giliranmu!'
                        : currentTurnPlayer?.player_type === 'bot'
                        ? 'Giliran Pemain Komputer'
                        : `Giliran ${currentTurnPlayer?.display_name || 'Lawan'}`}
                    </span>
                  </p>

                  <p className="turn-panel__status" aria-live="polite">
                    {rolling
                      ? 'Mengocok dadu...'
                      : animatingMove
                      ? 'Bidak sedang bergerak di papan...'
                      : room.lastRoll
                      ? `${room.lastRoll.displayName} dapat dadu ${room.lastRoll.dice}: kotak ${room.lastRoll.from} → ${room.lastRoll.to}${
                          room.lastRoll.ladder
                            ? ` (🪜 Naik tangga!)`
                            : room.lastRoll.snake
                            ? ` (🐍 Turun ular!)`
                            : room.lastRoll.overshoot
                            ? ` (Melewati 100, tetap di ${room.lastRoll.from})`
                            : ''
                        }`
                      : 'Lempar dadu untuk mulai melangkah dari posisi 0!'}
                  </p>

                  {canRoll && (
                    <button
                      type="button"
                      className="btn btn--primary btn--lg btn--block"
                      onClick={actions.rollDice}
                    >
                      🎲 Lempar Dadu
                    </button>
                  )}
                </div>
              </div>

              {/* Bar Emoticon Reaction & Tombol Chat */}
              <div className="turn-panel__toolbar">
                <div className="reaction-row" role="group" aria-label="Kirim reaksi">
                  {REACTIONS.map(emoji => (
                    <button
                      key={emoji}
                      type="button"
                      className="icon-btn icon-btn--plain"
                      aria-label={`Kirim reaksi ${emoji}`}
                      onClick={() => actions.sendReaction(emoji)}
                    >
                      <span aria-hidden="true">{emoji}</span>
                    </button>
                  ))}
                </div>
                <div className="turn-panel__tools">
                  <button
                    type="button"
                    className="icon-btn hide-desktop"
                    aria-label={`Buka obrolan${unreadChats ? `, ${unreadChats} pesan baru` : ''}`}
                    onClick={() => actions.setChatOpen(true)}
                  >
                    <span aria-hidden="true">💬</span>
                    {unreadChats > 0 && <span className="count-badge" aria-hidden="true">{unreadChats}</span>}
                  </button>
                </div>
              </div>
            </section>

            {/* Riwayat Langkah Permainan (Desktop) */}
            <section className="snk-log-card card show-desktop" aria-label="Riwayat Lemparan Dadu">
              <h3 className="panel-section__title">📜 Riwayat Langkah ({room.moveLog?.length || 0})</h3>
              {(!room.moveLog || room.moveLog.length === 0) ? (
                <p className="muted" style={{ fontSize: 'var(--fs-xs)', margin: 0 }}>
                  Belum ada lemparan dadu.
                </p>
              ) : (
                <ol className="snk-log-list">
                  {[...room.moveLog].reverse().slice(0, 12).map(item => (
                    <li key={item.id} className="snk-log-item">
                      <span className={`snk-color-dot color-${item.color}`} />
                      <span className="snk-log-item__text">
                        <strong>{item.displayName}</strong> lempar <strong>🎲 {item.dice}</strong>:{' '}
                        {item.overshoot ? (
                          <span>tetap di kotak {item.from} (&gt;100)</span>
                        ) : (
                          <span>
                            {item.from} → {item.stepTo}
                            {item.ladder ? ` 🪜 naik ke ${item.to}` : item.snake ? ` 🐍 turun ke ${item.to}` : ''}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            {/* Chat Panel Langsung di Kolom Kanan Desktop */}
            <section className="snk-chat-card card show-desktop" aria-label="Obrolan Ruangan">
              <h3 className="panel-section__title" style={{ marginBottom: 'var(--space-2)' }}>
                💬 Chat Ruangan
              </h3>
              <ChatPanel
                chats={chats}
                playerId={currentUser?.id}
                onSend={actions.sendChat}
                quickChats={SNAKES_QUICK_CHATS}
              />
            </section>
          </aside>
        </div>

        {/* Modal Riwayat Langkah di Mobile */}
        <Modal
          isOpen={showMobileHistory}
          onClose={() => setShowMobileHistory(false)}
          variant="sheet"
          size="md"
          icon="📜"
          title="Riwayat Langkah Permainan"
          subtitle={`Room ${room.code}`}
        >
          {(!room.moveLog || room.moveLog.length === 0) ? (
            <p className="muted">Belum ada lemparan dadu.</p>
          ) : (
            <ol className="snk-log-list">
              {[...room.moveLog].reverse().map(item => (
                <li key={item.id} className="snk-log-item">
                  <span className={`snk-color-dot color-${item.color}`} />
                  <span className="snk-log-item__text">
                    <strong>{item.displayName}</strong> lempar <strong>🎲 {item.dice}</strong>:{' '}
                    {item.overshoot ? (
                      <span>tetap di kotak {item.from} (&gt;100)</span>
                    ) : (
                      <span>
                        {item.from} → {item.stepTo}
                        {item.ladder ? ` 🪜 naik ke ${item.to}` : item.snake ? ` 🐍 turun ke ${item.to}` : ''}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Modal>

        {/* Modal Chat di Mobile */}
        <Modal
          isOpen={chatOpen}
          onClose={() => actions.setChatOpen(false)}
          variant="sheet"
          size="md"
          icon="💬"
          title="Obrolan Room Ular Tangga"
          subtitle={`Room ${room.code}`}
        >
          <ChatPanel
            chats={chats}
            playerId={currentUser?.id}
            onSend={actions.sendChat}
            quickChats={SNAKES_QUICK_CHATS}
          />
        </Modal>

        {/* Modal Hasil Pertandingan (Game Result) */}
        <Modal
          isOpen={Boolean(matchResult)}
          onClose={() => {}}
          size="md"
          icon={didIWin ? '🏆' : '🎲'}
          title={didIWin ? 'Selamat! Kamu Menang!' : 'Pertandingan Selesai'}
          subtitle={
            didIWin
              ? 'Bidakmu berhasil mencapai kotak 100 terlebih dahulu!'
              : `${matchResult?.winner?.display_name || 'Lawan'} mencapai kotak 100 terlebih dahulu.`
          }
        >
          {matchResult && (
            <div className="snk-result-modal">
              <div className={`snk-result-banner ${didIWin ? 'is-win' : 'is-loss'}`}>
                <strong>{didIWin ? '🎉 KEMENANGAN (WIN)' : '💪 KALAH (LOSS)'}</strong>
                {didIWin && matchResult.rewardCoins > 0 && (
                  <span className="badge badge--success">+{matchResult.rewardCoins} Coins PlayGo</span>
                )}
              </div>

              <div className="snk-result-details card">
                <div className="snk-result-row">
                  <span className="muted">Lawan</span>
                  <strong>
                    {opponentPlayer?.player_type === 'bot'
                      ? '🤖 Pemain Komputer'
                      : opponentPlayer?.display_name || 'Pemain'}
                  </strong>
                </div>
                <div className="snk-result-row">
                  <span className="muted">Tipe Lawan</span>
                  <span className="badge">
                    {matchResult.opponentType === 'bot' ? 'Bot (Pemain Komputer)' : 'Manusia (Kompetitif)'}
                  </span>
                </div>
                <div className="snk-result-row">
                  <span className="muted">Durasi Pertandingan</span>
                  <strong>{matchResult.durationSeconds || room.durationSeconds || 1} detik</strong>
                </div>
                <div className="snk-result-row">
                  <span className="muted">Total Giliran</span>
                  <strong>{matchResult.totalTurns || room.turnNumber || 1} giliran</strong>
                </div>
              </div>

              {matchResult.opponentType === 'bot' && (
                <p className="muted" style={{ fontSize: 'var(--fs-xs)', textAlign: 'center', margin: 0 }}>
                  Pertandingan melawan Pemain Komputer dicatat pada riwayat latihan dan tidak dihitung sebagai kemenangan kompetitif melawan manusia di Leaderboard.
                </p>
              )}

              <div className="snk-result-actions">
                <button
                  type="button"
                  className="btn btn--primary btn--lg btn--block"
                  onClick={actions.requestRematch}
                >
                  🔄 Main Lagi (Play Again)
                </button>
                <button
                  type="button"
                  className="btn btn--secondary btn--block"
                  onClick={actions.leaveRoom}
                >
                  Kembali ke Lobby
                </button>
              </div>
            </div>
          )}
        </Modal>
      </main>
    );
  }

  // ==========================================
  // VIEW 3: GAME LOBBY & MATCHMAKING SCREEN
  // ==========================================
  return (
    <main className="snk-screen" id="main">
      <div className="playgo-subnav">
        <button type="button" className="btn btn--secondary" onClick={onBackToMenu}>
          <Icon name="arrow-left" size={18} />
          <span>Daftar Game PlayGo</span>
        </button>
        <span className="badge badge--brand">PlayGo · Ular Tangga (Snakes and Ladders)</span>
      </div>

      {/* Hero Lobby Ular Tangga */}
      <section className="home__hero snk-lobby-hero card">
        <div className="home__intro">
          <span className="playgo-eyebrow">BOARD GAME KLASIK · 100 KOTAK</span>
          <h1 className="home__title">
            Ular Tangga: <span className="home__title-accent">Balapan Dadu Menuju Kotak 100!</span>
          </h1>
          <p className="home__lead">
            Lempar dadu, panjat 8 tangga emas untuk melesat naik, dan hindari 8 kepala ular!
            Sistem Smart Matchmaking otomatis mencarikan lawan pemain online terlebih dahulu.
          </p>
          <div className="playgo-game-card__tags" style={{ marginTop: 'var(--space-2)' }}>
            <span className="badge badge--brand">2 Pemain (Quick Match)</span>
            <span className="badge">2–4 Pemain (Private Room)</span>
            <span className="badge badge--success">+15 Coins Menang Kompetitif</span>
          </div>
        </div>
        <figure className="home__art">
          <img
            src={snakesLogo}
            alt="Logo Ular Tangga (Snakes and Ladders) PlayGo"
            width="720"
            height="480"
            fetchpriority="high"
          />
        </figure>
      </section>

      {error && <p className="alert alert--error" role="alert">{error}</p>}
      {notice && <p className="alert" role="status">{notice}</p>}

      <div className="snk-lobby-grid">
        {/* KARTU UTAMA: QUICK MATCH & PRIVATE ROOM */}
        <section className="snk-action-card card card--focus" aria-label="Mulai Bermain Ular Tangga">
          {!currentUser ? (
            <div className="snk-auth-prompt">
              <h2>Masuk ke PlayGo untuk Bermain</h2>
              <p className="muted">
                Gunakan akun PlayGo untuk mencari lawan secara realtime, membuat Private Room, dan menyimpan statistik kemenanganmu.
              </p>
              <button type="button" className="btn btn--primary btn--lg btn--block" onClick={onOpenAuth}>
                Masuk atau Daftar Akun
              </button>
            </div>
          ) : searching ? (
            /* LAYAR MATCHMAKING (HUMAN FIRST, 15s BOT FALLBACK) */
            <div className="snk-matchmaking-box" role="status" aria-live="polite">
              <div className="snk-matchmaking-radar" aria-hidden="true">
                <span className="spinner snk-matchmaking-spinner" />
                <span className="snk-matchmaking-icon">🎲</span>
              </div>
              <h2 className="snk-matchmaking-title">Mencari lawan...</h2>
              <p className="snk-matchmaking-priority">
                <span className="dot" style={{ background: '#22c55e' }} /> Memprioritaskan pemain online
              </p>
              <div className="snk-matchmaking-timer">
                <span>Waktu pencarian: <strong>{searchElapsedSec} dtk</strong> / {searchTimeoutSec} dtk</span>
              </div>
              <p className="muted" style={{ fontSize: 'var(--fs-xs)', margin: '4px 0 16px' }}>
                Jika belum ada pemain online setelah {searchTimeoutSec} detik, pertandingan otomatis dimulai melawan <strong>Pemain Komputer</strong>.
              </p>
              <button
                type="button"
                className="btn btn--secondary btn--block"
                onClick={actions.cancelMatchmaking}
              >
                ✕ Batalkan Pencarian (Cancel)
              </button>
            </div>
          ) : (
            <>
              <div className="snk-mode-block">
                <div className="snk-mode-block__head">
                  <h3>⚡ Quick Match (2 Pemain)</h3>
                  <span className="badge badge--success">Prioritas Pemain Online</span>
                </div>
                <p className="muted" style={{ fontSize: 'var(--fs-sm)', marginBottom: 'var(--space-3)' }}>
                  Cari lawan manusia yang sedang online. Bila tidak ditemukan dalam 15 detik, otomatis bertanding melawan Pemain Komputer.
                </p>
                <button
                  type="button"
                  className="btn btn--primary btn--lg btn--block"
                  onClick={actions.startQuickMatch}
                >
                  🎲 Quick Match — Cari Lawan Sekarang
                </button>
              </div>

              <div className="divider"><span>atau main bareng teman di Private Room</span></div>

              <div className="snk-mode-block">
                <h3>🔒 Private Room (Kode Undangan)</h3>
                <p className="muted" style={{ fontSize: 'var(--fs-sm)', marginBottom: 'var(--space-3)' }}>
                  Buat room privat lalu bagikan kodenya ke temanmu, atau masukkan kode room milik teman.
                </p>
                <button
                  type="button"
                  className="btn btn--secondary btn--block"
                  onClick={() => actions.createPrivateRoom({ maxPlayers: 2 })}
                  style={{ marginBottom: 'var(--space-3)' }}
                >
                  ➕ Buat Private Room Baru
                </button>

                <form
                  className="join-form"
                  onSubmit={e => {
                    e.preventDefault();
                    actions.joinRoomByCode();
                  }}
                >
                  <label htmlFor="snk-room-code" className="sr-only">Kode Private Room</label>
                  <input
                    id="snk-room-code"
                    className="input code-input"
                    value={joinCode}
                    onChange={e => actions.setJoinCode(e.target.value.toUpperCase())}
                    placeholder="Kode room, mis. AB12C"
                    maxLength={5}
                    autoComplete="off"
                    autoCapitalize="characters"
                  />
                  <button type="submit" className="btn btn--secondary">
                    Gabung Room
                  </button>
                </form>
              </div>
            </>
          )}
        </section>

        {/* KARTU ATURAN & STATISTIK PEMAIN */}
        <section className="snk-info-column">
          {currentUser && stats && (
            <article className="card snk-stats-card" aria-label="Statistik Ular Tangga Kamu">
              <div className="snk-stats-card__head">
                <PlayerAvatar avatar={currentUser.avatar} name={currentUser.name} size={40} className="avatar" />
                <div>
                  <strong>Statistik Ular Tangga — {currentUser.name}</strong>
                  <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-xs)' }}>
                    Peringkat Kompetitif: {stats.rank ? `#${stats.rank}` : 'Belum berperingkat'}
                  </p>
                </div>
              </div>
              <div className="profile-stats" style={{ marginTop: 'var(--space-3)' }}>
                <div className="profile-stat card">
                  <span className="profile-stat__label muted">Vs Manusia</span>
                  <strong className="profile-stat__value">{stats.wins}M / {stats.losses}K</strong>
                  <span className="profile-stat__sub muted">{stats.totalMatches} match ({stats.winRate}%)</span>
                </div>
                <div className="profile-stat card">
                  <span className="profile-stat__label muted">Vs Komputer</span>
                  <strong className="profile-stat__value">{stats.botStats?.wins || 0}M / {stats.botStats?.losses || 0}K</strong>
                  <span className="profile-stat__sub muted">{stats.botStats?.totalMatches || 0} latihan</span>
                </div>
              </div>
            </article>
          )}

          <article className="card snk-rules-card" aria-label="Aturan Permainan Ular Tangga">
            <h3>📖 Aturan Klasik Ular Tangga</h3>
            <ul className="snk-rules-list">
              <li><strong>Posisi Awal 0:</strong> Semua pemain memulai dari posisi 0 di luar papan dan melempar dadu untuk masuk ke papan.</li>
              <li><strong>8 Tangga &amp; 8 Ular:</strong> Berhenti di pangkal tangga otomatis naik ke kotak atas; berhenti di kepala ular otomatis turun ke ekor.</li>
              <li><strong>Tepat Kotak 100:</strong> Harus mendapatkan angka dadu yang pas untuk mencapai kotak 100. Jika melewati 100, bidak tetap di tempat.</li>
              <li><strong>Tanpa Giliran Ekstra:</strong> Mendapatkan angka 6 tidak memberikan lemparan tambahan — giliran selalu bergantian secara adil.</li>
            </ul>
          </article>
        </section>
      </div>

      {/* RIWAYAT PERTANDINGAN & LEADERBOARD KOMPETITIF */}
      <div className="snk-bottom-grid">
        <section className="card" aria-label="Riwayat Pertandingan Terakhir">
          <h3 className="panel-section__title">🕓 Riwayat Pertandingan Kamu</h3>
          {!currentUser ? (
            <p className="muted">Masuk untuk melihat riwayat pertandinganmu.</p>
          ) : loadingMeta && history.length === 0 ? (
            <p className="muted"><span className="spinner" aria-hidden="true" /> Memuat riwayat...</p>
          ) : history.length === 0 ? (
            <p className="muted">Belum ada riwayat pertandingan Ular Tangga.</p>
          ) : (
            <ol className="lb-list">
              {history.slice(0, 8).map(item => (
                <li key={item.id} className="lb-row">
                  <span className="lb-row__rank">{item.result === 'win' ? '🏆' : '🎲'}</span>
                  <div className="lb-row__who">
                    <strong>
                      {item.result === 'win' ? 'Menang' : 'Kalah'} vs {item.opponentName}
                    </strong>
                    <span className="muted">
                      {item.opponentType === 'bot' ? '🤖 Lawan: Pemain Komputer (Bot)' : '👥 Lawan: Pemain Manusia'} · {item.duration} dtk · {item.totalTurns} giliran
                    </span>
                  </div>
                  <div className="lb-row__stats">
                    {item.rewardCoins > 0 ? (
                      <span className="badge badge--success">+{item.rewardCoins} Coins</span>
                    ) : (
                      <span className="badge">{item.opponentType === 'bot' ? 'Latihan Bot' : 'Kompetitif'}</span>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="card" aria-label="Leaderboard Ular Tangga">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-2)' }}>
            <h3 className="panel-section__title" style={{ margin: 0 }}>🏆 Leaderboard Kompetitif (Vs Manusia)</h3>
            {onOpenLeaderboard && (
              <button type="button" className="btn btn--secondary btn--sm" onClick={onOpenLeaderboard}>
                Buka Penuh
              </button>
            )}
          </div>
          <p className="muted" style={{ fontSize: 'var(--fs-xs)', marginTop: 0 }}>
            Hanya mencatat kemenangan melawan sesama pemain manusia. Pemain Komputer tidak pernah masuk ke Leaderboard.
          </p>
          {leaderboard.length === 0 ? (
            <p className="muted">Belum ada pemain di peringkat kompetitif. Jadilah pemenang pertama!</p>
          ) : (
            <ol className="lb-list">
              {leaderboard.slice(0, 8).map(p => (
                <li key={p.userId} className={`lb-row ${p.rank === 1 ? 'is-top' : ''}`}>
                  <span className="lb-row__rank">
                    {p.rank === 1 ? '🥇' : p.rank === 2 ? '🥈' : p.rank === 3 ? '🥉' : `#${p.rank}`}
                  </span>
                  <PlayerAvatar avatar={p.avatar} name={p.name} size={34} className="lb-avatar" />
                  <div className="lb-row__who">
                    <strong>{p.name}</strong>
                    <span className="muted">@{p.username} · {p.totalMatches} match</span>
                  </div>
                  <div className="lb-row__stats">
                    <strong>{p.wins} menang</strong>
                    <span className="muted">({p.winRate}%)</span>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </main>
  );
}

