import React from 'react';
import Dice3D from '../../Dice3D';
import TurnTimer from './TurnTimer';
import Icon from '../Icon';
import PlayerAvatar from '../PlayerAvatar';
import { sound } from '../../sound';

const REACTIONS = ['🎲', '🔥', '👏', '😂', '😭', '👑'];

// Status giliran yang dibacakan pembaca layar dan ditampilkan di bawah dadu
function turnStatus({ room, isTurn, currentTurnPlayer, movablePawns }) {
  const name = currentTurnPlayer?.name || 'pemain';
  if (room.pendingShield) {
    const owner = room.players.find(p => p.id === room.pendingShield.playerId);
    return `Menunggu ${owner?.name || 'pemain'} memutuskan memakai perisai...`;
  }
  if (room.animatingMove) return isTurn ? 'Bidakmu sedang melangkah...' : `${name} sedang melangkah...`;
  if (room.rolling) return isTurn ? 'Mengocok dadu...' : `${name} mengocok dadu...`;
  if (!isTurn) return `Giliran ${name}`;
  if (room.dice === null) return 'Giliranmu. Lempar dadu!';
  if (movablePawns.length === 0) return `Dapat ${room.dice}, tidak ada langkah. Giliran berpindah...`;
  if (room.dice === 6) return 'Dapat 6, ketuk bidak di papan. Setelah ini kamu lempar lagi.';
  return `Dapat ${room.dice}. Ketuk bidak di papan yang mau jalan.`;
}

// Panel giliran: dadu, aksi utama, mode menonton saat OUT, reaksi, serta tombol chat & skor. Bidak dipilih langsung di papan.
export default function TurnPanel({ room, me = null, isTurn, canAct, currentTurnPlayer, movablePawns, moveHints = null, unreadChats, actions, onOpenChat, onOpenScores }) {
  const status = turnStatus({ room, isTurn, currentTurnPlayer, movablePawns });
  const hintItems = moveHints?.active && !room.animatingMove ? (moveHints.displayList || []) : [];

  return (
    <section className={`turn-panel card ${isTurn ? 'is-my-turn card--focus' : ''}`} aria-label="Giliran">
      {me?.isOut && (
        <p className="alert" role="status" style={{ background: 'rgba(14, 165, 233, 0.14)', color: 'var(--text)', marginBottom: '10px' }}>
          👀 <strong>Mode Menonton</strong> — Kamu telah dinyatakan OUT, namun tetap bisa menonton pertandingan dan mengobrol di room.
        </p>
      )}
      <div className="turn-panel__main">
        <Dice3D
          value={room.dice}
          isRolling={room.rolling}
          canRoll={canAct}
          onRoll={actions.rollDice}
          disabled={!canAct}
          playerColor={currentTurnPlayer?.color}
        />
        <div className="turn-panel__side">
          <p className={`turn-panel__who color-${currentTurnPlayer?.color}`}>
            <PlayerAvatar
              avatar={currentTurnPlayer?.avatar}
              name={currentTurnPlayer?.name || ''}
              size={28}
              className="avatar avatar--sm turn-panel__avatar"
              fallback={
                currentTurnPlayer?.isBot ? (
                  <Icon name="bot" size={14} />
                ) : (
                  currentTurnPlayer?.name?.charAt(0).toUpperCase() || '?'
                )
              }
            />
            <span className="dot" style={{ background: 'var(--pc)' }} aria-hidden="true" />
            <span className="turn-panel__who-name">
              {isTurn ? 'Giliranmu' : currentTurnPlayer?.name}
            </span>
          </p>
          <p className="turn-panel__status" aria-live="polite">{status}</p>
          <TurnTimer clock={room.turnClock} isMine={isTurn} />
          {room.blackHoleShiftIn && (
            <p className="turn-panel__hint muted">
              🕳️ Black Hole pindah {room.blackHoleShiftIn === 1 ? 'setelah giliran ini' : `${room.blackHoleShiftIn} giliran lagi`}
            </p>
          )}

          {canAct && (
            <button type="button" className="btn btn--primary btn--lg btn--block" onClick={actions.rollDice}>
              Lempar dadu
            </button>
          )}
        </div>
      </div>

      {hintItems.length > 0 && (
        <div className="ocean-hint-box" aria-label="Hint langkah terbaik Ocean Blue">
          <div className="ocean-hint-box__head">
            <span className="ocean-hint-box__title">🌊 Hint Ocean Blue</span>
            <span className="ocean-hint-box__sub">
              {hintItems.length > 1 ? 'Urutan peluang terbaik' : 'Peluang terbaik'}
            </span>
          </div>
          <div className="ocean-hint-list" role="list">
            {hintItems.map(item => (
              <button
                key={`${item.rank}-${item.pawnIdx}`}
                type="button"
                role="listitem"
                className={`ocean-hint-chip ocean-hint-chip--rank-${Math.min(item.rank, 3)}`}
                onClick={() => {
                  sound.playClick();
                  actions.movePawn(item.pawnIdx);
                }}
              >
                <span className="ocean-hint-chip__rank">#{item.rank}</span>
                <strong className="ocean-hint-chip__pawn">{item.label}</strong>
                <span className="ocean-hint-chip__reason">{item.reason}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="turn-panel__toolbar">
        <div className="reaction-row" role="group" aria-label="Kirim reaksi">
          {REACTIONS.map(emoji => (
            <button key={emoji} type="button" className="icon-btn icon-btn--plain" aria-label={`Kirim reaksi ${emoji}`} onClick={() => actions.sendReaction(emoji)}>
              <span aria-hidden="true">{emoji}</span>
            </button>
          ))}
        </div>
        <div className="turn-panel__tools">
          <button type="button" className="icon-btn hide-desktop" aria-label={`Buka obrolan${unreadChats ? `, ${unreadChats} pesan baru` : ''}`} onClick={onOpenChat}>
            <span aria-hidden="true">💬</span>
            {unreadChats > 0 && <span className="count-badge" aria-hidden="true">{unreadChats}</span>}
          </button>
          <button type="button" className="icon-btn" aria-label="Skor dan log permainan" onClick={onOpenScores}>
            <span aria-hidden="true">📊</span>
          </button>
        </div>
      </div>
    </section>
  );
}
