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
    rows.push({ visualRow, rowFromBottom, cells });
  }
  return rows;
}

const BOARD_ROWS = buildBoardRows();

const SNAKE_PALETTES = [
  { body: '#ef4444', stripe: '#fecaca', head: '#b91c1c' },
  { body: '#8b5cf6', stripe: '#ddd6fe', head: '#6d28d9' },
  { body: '#10b981', stripe: '#a7f3d0', head: '#047857' },
  { body: '#f97316', stripe: '#fed7aa', head: '#c2410c' },
  { body: '#ec4899', stripe: '#fbcfe8', head: '#be185d' },
  { body: '#06b6d4', stripe: '#cffafe', head: '#0e7490' },
  { body: '#eab308', stripe: '#fef08a', head: '#a16207' },
  { body: '#6366f1', stripe: '#e0e7ff', head: '#4338ca' }
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
        const nx = (-dy / len) * 12.5;
        const ny = (dx / len) * 12.5;
        const stepsCount = Math.max(4, Math.floor(len / 44));
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
        const wave = Math.min(42, Math.max(24, len * 0.14));
        const perpX = (-dy / len) * wave * (idx % 2 === 0 ? 1 : -1);
        const perpY = (dx / len) * wave * (idx % 2 === 0 ? 1 : -1);

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
        <filter id="snk-soft-shadow" x="-15%" y="-15%" width="130%" height="130%">
          <feDropShadow dx="0" dy="2.5" stdDeviation="2.5" floodColor="#0f172a" floodOpacity="0.26" />
        </filter>
      </defs>

      {/* Gambar Tangga (Ladders) */}
      <g filter="url(#snk-soft-shadow)" opacity="0.88">
        {ladderItems.map(item => (
          <g key={item.key} className="snakes-svg-ladder">
            {item.rungs.map((r, rIdx) => (
              <line
                key={rIdx}
                x1={r.x1}
                y1={r.y1}
                x2={r.x2}
                y2={r.y2}
                stroke="#d97706"
                strokeWidth="5"
                strokeLinecap="round"
              />
            ))}
            <line
              x1={item.leftRail.x1}
              y1={item.leftRail.y1}
              x2={item.leftRail.x2}
              y2={item.leftRail.y2}
              stroke="#92400e"
              strokeWidth="7"
              strokeLinecap="round"
            />
            <line
              x1={item.rightRail.x1}
              y1={item.rightRail.y1}
              x2={item.rightRail.x2}
              y2={item.rightRail.y2}
              stroke="#92400e"
              strokeWidth="7"
              strokeLinecap="round"
            />
            <line
              x1={item.leftRail.x1}
              y1={item.leftRail.y1}
              x2={item.leftRail.x2}
              y2={item.leftRail.y2}
              stroke="#fbbf24"
              strokeWidth="3.2"
              strokeLinecap="round"
            />
            <line
              x1={item.rightRail.x1}
              y1={item.rightRail.y1}
              x2={item.rightRail.x2}
              y2={item.rightRail.y2}
              stroke="#fbbf24"
              strokeWidth="3.2"
              strokeLinecap="round"
            />
          </g>
        ))}
      </g>

      {/* Gambar Ular (Snakes) */}
      <g filter="url(#snk-soft-shadow)" opacity="0.88">
        {snakeItems.map(s => (
          <g key={s.key} className="snakes-svg-snake">
            <path
              d={s.pathD}
              fill="none"
              stroke={s.palette.body}
              strokeWidth="13.5"
              strokeLinecap="round"
            />
            <path
              d={s.pathD}
              fill="none"
              stroke={s.palette.stripe}
              strokeWidth="5.5"
              strokeDasharray="8 11"
              strokeLinecap="round"
            />
            {/* Ekor ular */}
            <circle cx={s.tail.svgX} cy={s.tail.svgY} r="5" fill={s.palette.body} />
            {/* Kepala ular */}
            <circle cx={s.head.svgX} cy={s.head.svgY} r="12" fill={s.palette.head} />
            <circle cx={s.head.svgX - 4} cy={s.head.svgY - 3} r="3" fill="#ffffff" />
            <circle cx={s.head.svgX + 4} cy={s.head.svgY - 3} r="3" fill="#ffffff" />
            <circle cx={s.head.svgX - 4} cy={s.head.svgY - 3} r="1.4" fill="#0f172a" />
            <circle cx={s.head.svgX + 4} cy={s.head.svgY - 3} r="1.4" fill="#0f172a" />
          </g>
        ))}
      </g>
    </svg>
  );
}

function SnakesPlayerBadge({ player, isCurrentTurn, isMe, animatedPos, turnClock, onViewProfile }) {
  const isBot = player.player_type === 'bot' || player.isBot;
  const pos = animatedPos !== undefined ? animatedPos : Number(player.position) || 0;
  const progressPct = Math.min(100, Math.max(0, pos));

  return (
    <div
      className={`snk-player-card card color-${player.color || 'red'} ${
        isCurrentTurn ? 'is-active-turn' : ''
      }`}
    >
      <div className="snk-player-card__head">
        <div className="snk-player-card__avatar-wrap">
          {isBot ? (
            <span className="avatar snk-bot-avatar" aria-label="Ikon Pemain Komputer">
              <Icon name="bot" size={18} />
            </span>
          ) : (
            <PlayerAvatar
              avatar={player.avatar}
              name={player.display_name || player.name || 'Pemain'}
              size={36}
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
            {isMe && <span className="snk-mini-badge snk-mini-badge--me">Kamu</span>}
            {isBot && (
              <span className="snk-mini-badge snk-mini-badge--bot" title="Lawan otomatis komputer">
                Bot
              </span>
            )}
          </div>
          <span className="muted snk-player-card__sub">
            {isCurrentTurn
              ? isMe
                ? '🎲 Giliranmu melempar!'
                : isBot
                ? '🤖 Komputer melempar...'
                : '⏳ Sedang giliran...'
              : isBot
              ? 'Komputer Otomatis'
              : !player.connected
              ? 'Terputus...'
              : `@${player.username || 'pemain'}`}
          </span>
        </div>

        <div className="snk-player-card__pos">
          <strong className="snk-player-card__pos-value">
            {pos === 0 ? 'Start' : `#${pos}`}
          </strong>
          <span className="snk-player-card__pos-label muted">
            {pos === 0 ? 'Kotak 0' : `${pos}/100`}
          </span>
        </div>
      </div>

      <div className="snk-player-card__progress" aria-hidden="true">
        <div
          className="snk-player-card__progress-fill"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {isCurrentTurn && turnClock && (
        <div className="snk-player-card__timer">
          <TurnTimer clock={turnClock} isMine={isMe} />
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
        <div className="snk-subnav">
          <button type="button" className="btn btn--secondary btn--sm" onClick={actions.leaveRoom}>
            <Icon name="arrow-left" size={16} />
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
              Bagikan kode room ini kepada temanmu. Permainan dimulai segera setelah minimal 2 pemain bergabung.
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

          <div className="turn-panel__toolbar" style={{ marginTop: 'var(--space-2)' }}>
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

    const statusDescription = rolling
      ? 'Mengocok dadu...'
      : animatingMove
      ? 'Bidak sedang melangkah...'
      : room.lastRoll
      ? `${room.lastRoll.displayName} dapat 🎲 ${room.lastRoll.dice}: kotak ${room.lastRoll.from} → ${room.lastRoll.to}${
          room.lastRoll.ladder
            ? ' (🪜 Naik tangga!)'
            : room.lastRoll.snake
            ? ' (🐍 Turun ular!)'
            : room.lastRoll.overshoot
            ? ` (Lewat 100, tetap di ${room.lastRoll.from})`
            : ''
        }`
      : 'Lempar dadu untuk mulai melangkah dari posisi 0!';

    return (
      <main className="snk-game-layout" id="main">
        {/* Top Bar Ringkas */}
        <header className="snk-game-topbar card">
          <div className="snk-game-topbar__left">
            <button type="button" className="btn btn--secondary btn--sm" onClick={actions.leaveRoom}>
              <Icon name="arrow-left" size={16} />
              <span>Keluar</span>
            </button>
            <div className="snk-game-topbar__meta">
              <strong className="snk-game-topbar__title">Ular Tangga · #{room.code}</strong>
              <span className="muted snk-game-topbar__sub">
                {isBotMatch ? '🤖 vs Pemain Komputer' : '👥 vs Pemain Manusia'} · Giliran #{room.turnNumber || 1}
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
                <span className="snk-bot-avatar"><Icon name="bot" size={18} /></span>
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
                  size={34}
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
          {/* KOLOM KIRI: PAPAN ULAR TANGGA 10x10 */}
          <section className="snk-board-column" aria-label="Papan Permainan Ular Tangga 100 Kotak">
            {/* Bar Pemain di Mobile (di atas papan agar selalu terlihat) */}
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
                    {row.cells.map((sq, colIdx) => {
                      const ladderTo = ladders[sq];
                      const snakeTo = snakesMap[sq];
                      const isStart = sq === 1;
                      const isFinish = sq === 100;
                      const isAlt = (row.visualRow + colIdx) % 2 === 1;

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
                          {isFinish && (
                            <span className="snakes-cell__tag snakes-cell__tag--finish" title="Kotak 100 Kemenangan">
                              🏆
                            </span>
                          )}
                          {isStart && (
                            <span className="snakes-cell__tag snakes-cell__tag--start">START</span>
                          )}
                          {ladderTo && (
                            <span className="snakes-cell__tag snakes-cell__tag--ladder" title={`Tangga naik ke kotak ${ladderTo}`}>
                              ↑{ladderTo}
                            </span>
                          )}
                          {snakeTo && (
                            <span className="snakes-cell__tag snakes-cell__tag--snake" title={`Ular turun ke kotak ${snakeTo}`}>
                              ↓{snakeTo}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}

                {/* Overlay SVG Ular & Tangga */}
                <SnakesAndLaddersSvgOverlay ladders={ladders} snakes={snakesMap} />

                {/* Bidak Pemain di Papan (Kotak 1..100) */}
                <div className="snakes-board__tokens" aria-live="polite">
                  {boardPlayers.map((p, idx) => {
                    const pos = animatedPositions[p.id] !== undefined ? animatedPositions[p.id] : Number(p.position) || 0;
                    const coords = getSquareCoords(pos);
                    if (!coords) return null;

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
                <span className="snk-start-dock__label muted">Posisi Start (0):</span>
                {startDockPlayers.length === 0 ? (
                  <span className="muted" style={{ fontSize: '11px' }}>Semua bidak sudah berada di atas papan</span>
                ) : (
                  <div className="snk-start-dock__tokens">
                    {startDockPlayers.map(p => (
                      <span key={p.id} className={`snk-dock-chip color-${p.color}`}>
                        <span className="snk-dock-chip__dot" />
                        <span>{p.display_name}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* KOLOM KANAN: PEMAIN, KONSOL DADU CEPAT, LOG, & CHAT */}
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

            {/* Konsol Dadu & Giliran (Cepat & Responsif) */}
            <section
              className={`snk-dice-console card ${room.isMyTurn && room.status === 'playing' ? 'is-my-turn card--focus' : ''}`}
              aria-label="Kontrol Dadu dan Giliran"
            >
              <div className="snk-dice-console__body">
                <div className="snk-dice-console__cube">
                  <Dice3D
                    value={diceValue || room.lastRoll?.dice || 1}
                    isRolling={rolling}
                    canRoll={canRoll}
                    onRoll={actions.rollDice}
                    disabled={!canRoll}
                    playerColor={currentTurnPlayer?.color || 'red'}
                  />
                </div>

                <div className="snk-dice-console__info">
                  <div className="snk-dice-console__turn-row">
                    <span className={`snk-color-dot color-${currentTurnPlayer?.color || 'red'}`} />
                    <strong className="snk-dice-console__who">
                      {room.status === 'finished'
                        ? `🏆 Pemenang: ${room.winner?.display_name || 'Pemain'}`
                        : room.isMyTurn
                        ? 'Giliranmu Sekarang!'
                        : currentTurnPlayer?.player_type === 'bot'
                        ? 'Giliran Pemain Komputer'
                        : `Giliran ${currentTurnPlayer?.display_name || 'Lawan'}`}
                    </strong>
                  </div>

                  <p className="snk-dice-console__status" aria-live="polite">
                    {statusDescription}
                  </p>

                  <button
                    type="button"
                    className={`btn ${canRoll ? 'btn--primary' : 'btn--secondary'} btn--block snk-roll-cta`}
                    disabled={!canRoll}
                    onClick={actions.rollDice}
                  >
                    {rolling
                      ? '🎲 Mengocok...'
                      : animatingMove
                      ? '🏃 Melangkah...'
                      : canRoll
                      ? '🎲 Lempar Dadu Sekarang'
                      : currentTurnPlayer?.player_type === 'bot'
                      ? '🤖 Giliran Komputer...'
                      : '⏳ Menunggu Lawan...'}
                  </button>
                </div>
              </div>

              {/* Bar Emoticon Reaction */}
              <div className="turn-panel__toolbar snk-dice-console__toolbar">
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
                <div className="turn-panel__tools hide-desktop">
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
            </section>

            {/* Riwayat Langkah Permainan (Desktop) */}
            <section className="snk-log-card card show-desktop" aria-label="Riwayat Lemparan Dadu">
              <div className="snk-card-head-inline">
                <h3 className="panel-section__title" style={{ margin: 0 }}>📜 Riwayat Langkah</h3>
                <span className="badge">{room.moveLog?.length || 0} lemparan</span>
              </div>
              {(!room.moveLog || room.moveLog.length === 0) ? (
                <p className="muted" style={{ fontSize: 'var(--fs-xs)', margin: '6px 0 0' }}>
                  Belum ada lemparan dadu.
                </p>
              ) : (
                <ol className="snk-log-list">
                  {[...room.moveLog].reverse().slice(0, 10).map(item => (
                    <li key={item.id} className="snk-log-item">
                      <span className={`snk-color-dot color-${item.color}`} />
                      <span className="snk-log-item__text">
                        <strong>{item.displayName}</strong> 🎲<strong>{item.dice}</strong>:{' '}
                        {item.overshoot ? (
                          <span>tetap di #{item.from} (&gt;100)</span>
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
            <ol className="snk-log-list" style={{ maxHeight: '340px' }}>
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
      <div className="snk-subnav">
        <button type="button" className="btn btn--secondary btn--sm" onClick={onBackToMenu}>
          <Icon name="arrow-left" size={16} />
          <span>Daftar Game PlayGo</span>
        </button>
        <span className="badge badge--brand">Board Game · Ular Tangga</span>
      </div>

      {/* Hero Card Ringkas & Modern (Setara Chess Master) */}
      <section className="snk-hero-card card">
        <figure className="snk-hero-card__art">
          <img
            src={snakesLogo}
            alt="Ular Tangga (Snakes and Ladders) PlayGo"
            width="480"
            height="320"
            fetchpriority="high"
          />
          <span className="snk-hero-card__badge">10 × 10 Klasik</span>
        </figure>

        <div className="snk-hero-card__body">
          <div>
            <span className="playgo-eyebrow">PLAYGO BOARD GAME · 100 KOTAK</span>
            <h1 className="snk-hero-card__title">Ular Tangga (Snakes and Ladders)</h1>
            <p className="snk-hero-card__desc muted">
              Lempar dadu, panjat 8 tangga emas untuk melesat naik, dan hindari 8 kepala ular!
              Prioritas lawan manusia online otomatis, dengan hadiah <strong>+15 Coins</strong> setiap menang kompetitif.
            </p>
          </div>

          {currentUser && (
            <div className="snk-hero-stats">
              <div className="snk-hero-stat">
                <span className="snk-hero-stat__label muted">Pemain</span>
                <strong className="snk-hero-stat__val">{currentUser.name}</strong>
              </div>
              <div className="snk-hero-stat">
                <span className="snk-hero-stat__label muted">Vs Manusia</span>
                <strong className="snk-hero-stat__val">
                  {stats ? `${stats.wins}M / ${stats.losses}K` : '0M / 0K'}
                </strong>
              </div>
              <div className="snk-hero-stat">
                <span className="snk-hero-stat__label muted">Win Rate</span>
                <strong className="snk-hero-stat__val">{stats ? `${stats.winRate}%` : '0%'}</strong>
              </div>
              <div className="snk-hero-stat">
                <span className="snk-hero-stat__label muted">Vs Komputer</span>
                <strong className="snk-hero-stat__val">
                  {stats?.botStats ? `${stats.botStats.wins}M / ${stats.botStats.losses}K` : '0M / 0K'}
                </strong>
              </div>
            </div>
          )}
        </div>
      </section>

      {error && <p className="alert alert--error" role="alert">{error}</p>}
      {notice && <p className="alert" role="status">{notice}</p>}

      {/* KARTU MODE PERMAINAN: QUICK MATCH & PRIVATE ROOM */}
      {!currentUser ? (
        <section className="card card--focus snk-auth-card">
          <div>
            <h2 style={{ margin: '0 0 6px' }}>Masuk ke PlayGo untuk Bermain Ular Tangga</h2>
            <p className="muted" style={{ margin: 0 }}>
              Gunakan akun PlayGo untuk mencari lawan secara realtime, membuat Private Room, dan mengumpulkan Coins.
            </p>
          </div>
          <button type="button" className="btn btn--primary btn--lg" onClick={onOpenAuth}>
            Masuk / Daftar Akun
          </button>
        </section>
      ) : searching ? (
        <section className="card card--focus snk-matchmaking-box" role="status" aria-live="polite">
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
          <p className="muted" style={{ fontSize: 'var(--fs-xs)', margin: '4px 0 12px', maxWidth: '460px' }}>
            Jika belum ada pemain online setelah {searchTimeoutSec} detik, sistem otomatis memulai pertandingan melawan <strong>Pemain Komputer</strong>.
          </p>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={actions.cancelMatchmaking}
          >
            ✕ Batalkan Pencarian (Cancel)
          </button>
        </section>
      ) : (
        <div className="snk-modes-grid">
          {/* Quick Match Card */}
          <section className="card card--focus snk-mode-card" aria-label="Mode Quick Match">
            <div className="snk-mode-card__top">
              <div className="snk-mode-block__head">
                <h3>⚡ Quick Match (2 Pemain)</h3>
                <span className="badge badge--success">Prioritas Manusia</span>
              </div>
              <p className="muted" style={{ fontSize: 'var(--fs-sm)', margin: '6px 0 0' }}>
                Langsung cari lawan pemain online. Bila tidak ditemukan dalam 15 detik, otomatis bertanding melawan Pemain Komputer tanpa perlu menunggu lama.
              </p>
            </div>
            <button
              type="button"
              className="btn btn--primary btn--lg btn--block"
              onClick={actions.startQuickMatch}
            >
              🎲 Main Sekarang (Quick Match)
            </button>
          </section>

          {/* Private Room Card */}
          <section className="card snk-mode-card" aria-label="Mode Private Room">
            <div className="snk-mode-card__top">
              <div className="snk-mode-block__head">
                <h3>🔒 Private Room (Teman)</h3>
                <span className="badge">Kode 5 Huruf</span>
              </div>
              <p className="muted" style={{ fontSize: 'var(--fs-sm)', margin: '6px 0 0' }}>
                Buat room privat untuk dimainkan bersama teman, atau masukkan kode room milik temanmu.
              </p>
            </div>

            <div className="snk-private-controls">
              <button
                type="button"
                className="btn btn--secondary btn--block"
                onClick={() => actions.createPrivateRoom({ maxPlayers: 2 })}
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
                  placeholder="Kode room (mis. AB12C)"
                  maxLength={5}
                  autoComplete="off"
                  autoCapitalize="characters"
                />
                <button type="submit" className="btn btn--secondary">
                  Gabung
                </button>
              </form>
            </div>
          </section>
        </div>
      )}

      {/* RINGKASAN ATURAN SINGKAT */}
      <section className="card snk-rules-strip" aria-label="Aturan Klasik Ular Tangga">
        <div className="snk-rules-strip__item">
          <span className="snk-rules-strip__icon">🏁</span>
          <div>
            <strong>Mulai dari Posisi 0</strong>
            <p className="muted">Lempar dadu untuk masuk ke papan menuju kotak 100.</p>
          </div>
        </div>
        <div className="snk-rules-strip__item">
          <span className="snk-rules-strip__icon">🪜</span>
          <div>
            <strong>8 Tangga &amp; 8 Ular</strong>
            <p className="muted">Berhenti di pangkal tangga otomatis naik; di kepala ular otomatis turun.</p>
          </div>
        </div>
        <div className="snk-rules-strip__item">
          <span className="snk-rules-strip__icon">🎯</span>
          <div>
            <strong>Pas di Kotak 100</strong>
            <p className="muted">Jika angka dadu melewati 100, bidak tetap di tempat. Angka 6 tidak memberi giliran ekstra.</p>
          </div>
        </div>
      </section>

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
                      {item.opponentType === 'bot' ? '🤖 Pemain Komputer (Bot)' : '👥 Pemain Manusia'} · {item.duration} dtk · {item.totalTurns} giliran
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
          <div className="snk-card-head-inline" style={{ marginBottom: 'var(--space-2)' }}>
            <h3 className="panel-section__title" style={{ margin: 0 }}>🏆 Leaderboard Kompetitif</h3>
            {onOpenLeaderboard && (
              <button type="button" className="btn btn--secondary btn--sm" onClick={onOpenLeaderboard}>
                Buka Penuh
              </button>
            )}
          </div>
          <p className="muted" style={{ fontSize: 'var(--fs-xs)', marginTop: 0 }}>
            Hanya mencatat kemenangan melawan sesama pemain manusia. Pemain Komputer tidak masuk ke Leaderboard.
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
