import React, { useEffect, useState } from 'react';
import Icon from '../components/Icon';
import Modal from '../components/Modal';
import PlayerAvatar from '../components/PlayerAvatar';
import ChatPanel from '../components/game/ChatPanel';
import MonsterSprite from '../quiz/MonsterSprite';
import { QUIZ_MONSTERS, getClientMonster } from '../quiz/monsters';
import { sound } from '../sound';
import monsterQuizLogo from '../assets/monster-quiz-logo.webp';

const OPTION_LABELS = ['A', 'B', 'C', 'D'];
const REACTIONS = ['🎲', '🔥', '👏', '😂', '😭', '👑'];
const QUIZ_QUICK_CHATS = ['Semangat! 🔥', 'GG! 👏', 'Soalnya susah! 😂', 'Jangan serang aku! 😭', 'Ayo cepat jawab! ⚡'];

function hpTone(hp) {
  if (hp > 50) return 'high';
  if (hp > 20) return 'mid';
  return 'low';
}

function formatPlayerRoundStatus(player, phase, roundResult) {
  if (!player) return { label: 'Menunggu lawan...', shortLabel: 'Menunggu', tone: 'muted' };
  if (!player.connected) return { label: 'Terputus (30d)...', shortLabel: 'Offline', tone: 'danger' };

  if (phase === 'round_result' && roundResult?.answers?.[player.userId]) {
    const ans = roundResult.answers[player.userId];
    if (ans.timedOut) return { label: 'Waktu Habis', shortLabel: 'Waktu Habis', tone: 'danger' };
    if (ans.isCorrect) return { label: 'Benar!', shortLabel: 'Benar!', tone: 'success' };
    return { label: 'Salah', shortLabel: 'Salah', tone: 'danger' };
  }

  if (phase === 'question') {
    if (player.answeredCurrentRound) {
      return { label: 'Sudah Menjawab', shortLabel: 'Terjawab', tone: 'info' };
    }
    return { label: 'Menjawab...', shortLabel: 'Menjawab', tone: 'warning' };
  }

  if (phase === 'lobby') {
    return player.ready
      ? { label: 'Siap Bertarung', shortLabel: 'Siap', tone: 'success' }
      : { label: 'Memilih Monster', shortLabel: 'Memilih', tone: 'muted' };
  }

  return { label: 'Siaga', shortLabel: 'Siaga', tone: 'muted' };
}

function FighterLifeCard({ player, monster, status, isCurrentUser, hp }) {
  const currentHp = hp ?? 100;
  return (
    <div className="mq-fighter__card">
      <div className="mq-fighter__header">
        <div className="mq-fighter__identity">
          {player && <PlayerAvatar player={player} size={28} />}
          <div className="mq-fighter__meta">
            <strong className="mq-fighter__player" title={player?.name}>
              {player?.name || 'Pemain'} {isCurrentUser ? '(Kamu)' : ''}
            </strong>
            <div className="mq-fighter__monster-row">
              <span className="mq-fighter__monster-name">{monster.name}</span>
              <span className={`mq-element-tag mq-element-tag--${monster.element}`}>
                {monster.elementLabel}
              </span>
            </div>
          </div>
        </div>
        <span className={`badge badge--${status.tone} mq-fighter__badge`}>
          <span className="mq-badge-full">{status.label}</span>
          <span className="mq-badge-short">{status.shortLabel || status.label}</span>
        </span>
      </div>

      <div className="mq-hp" role="progressbar" aria-valuenow={currentHp} aria-valuemin={0} aria-valuemax={100}>
        <div className="mq-hp__top">
          <span className="mq-hp__label">
            <Icon name="heart" size={13} />
            <span>Darah</span>
          </span>
          <strong className="mq-hp__val">
            {currentHp} <span className="mq-hp__max">/ 100</span>
          </strong>
        </div>
        <div className="mq-hp__track">
          <div
            className={`mq-hp__fill mq-hp__fill--${hpTone(currentHp)}`}
            style={{ width: `${Math.max(0, Math.min(100, currentHp))}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function buildRoundBannerText(roundResult, players = []) {
  if (!roundResult) return '';
  const { outcome, attackerUserId, targetUserId, attackerUserIds, targetUserIds, damage } = roundResult;
  const byId = uid => players.find(p => p && p.userId === uid) || null;
  const attacker = byId(attackerUserId);
  const target = byId(targetUserId);

  if (outcome === 'multi_attack') {
    const atkNames = (attackerUserIds || [])
      .map(uid => byId(uid))
      .filter(Boolean)
      .map(p => `${getClientMonster(p.monsterId).name} (${p.name})`)
      .join(' & ');
    const defNames = (targetUserIds || [])
      .map(uid => byId(uid))
      .filter(Boolean)
      .map(p => `${getClientMonster(p.monsterId).name} (${p.name})`)
      .join(' & ');
    return `${atkNames || 'Monster penyerang'} melancarkan serangan ke ${defNames || 'lawan'}! (−${damage} HP)`;
  }

  if ((outcome === 'p0_attack' || outcome === 'p1_attack') && attacker && target) {
    const atkMonster = getClientMonster(attacker.monsterId);
    const defMonster = getClientMonster(target.monsterId);
    return `${atkMonster.name} milik ${attacker.name} menyerang ${defMonster.name} milik ${target.name}! (−${damage} HP)`;
  }
  if (outcome === 'both_correct') {
    return 'Semua pemain aktif menjawab benar! Monster saling menangkis — tidak ada damage (0 HP).';
  }
  return 'Semua pemain menjawab salah atau kehabisan waktu — tidak ada serangan (0 HP).';
}

export default function MonsterQuizScreen({
  quiz,
  currentUser,
  onBackToMenu,
  onOpenAuth,
  onOpenShop,
  onOpenAudio,
  onViewProfile
}) {
  const [hubTab, setHubTab] = useState('leaderboard'); // 'leaderboard' | 'history'
  const [copied, setCopied] = useState(false);

  const {
    room,
    joinCode,
    setJoinCode,
    selectedMonsterId,
    searching,
    error,
    notice,
    roundResult,
    matchResult,
    remainingMs,
    countdownSec,
    slotAnim,
    damagePopup,
    stats,
    history,
    leaderboard,
    chats = [],
    unreadChats = 0,
    chatOpen = false,
    actions
  } = quiz;

  const ownedHints = Number(currentUser?.inventory?.quizHint || 0);

  // Dukungan tombol keyboard 1-4 / A-D saat menjawab pertanyaan
  useEffect(() => {
    if (!room || room.phase !== 'question') return undefined;
    const eliminated = room.match?.myEliminatedOptions || [];
    const onKeyDown = e => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const key = e.key.toUpperCase();
      const map = { '1': 0, '2': 1, '3': 2, '4': 3, A: 0, B: 1, C: 2, D: 3 };
      if (map[key] !== undefined && !eliminated.includes(map[key])) {
        e.preventDefault();
        actions.submitAnswer(map[key]);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [room, actions]);

  const copyRoomCode = code => {
    if (!code) return;
    sound.playClick();
    navigator.clipboard?.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ==========================================
  // VIEW 1: HUB UTAMA MONSTER QUIZ BATTLE (SEBELUM MASUK ROOM)
  // ==========================================
  if (!room) {
    const previewMonster = getClientMonster(selectedMonsterId);

    return (
      <main className="mq-page" id="main">
        <div className="mq-topbar">
          <button type="button" className="btn btn--secondary" onClick={onBackToMenu}>
            <Icon name="arrow-left" size={18} />
            <span>Daftar Game PlayGo</span>
          </button>
          <div className="mq-topbar__actions">
            {currentUser && onOpenShop && (
              <button type="button" className="btn btn--secondary" onClick={onOpenShop}>
                <Icon name="bulb" size={18} />
                <span>Hints Jawaban: {ownedHints} · Beli di Toko</span>
              </button>
            )}
            <span className="badge badge--brand">Menang +10 Coins · 2–3 Pemain</span>
          </div>
        </div>

        <section className="mq-hero card card--focus">
          <div className="mq-hero__intro">
            <div className="mq-hero__brand">
              <figure className="mq-hero__logo-frame">
                <img
                  src={monsterQuizLogo}
                  alt="Logo Monster Quiz Battle"
                  width="720"
                  height="480"
                  fetchpriority="high"
                  className="mq-hero__logo"
                />
              </figure>
              <div>
                <span className="mq-eyebrow">MONSTER QUIZ BATTLE · MAKS 3 PEMAIN · HADIAH +10 COINS</span>
                <h1 className="mq-hero__title">
                  Adu cepat pengetahuan &amp; matematika, <span className="home__title-accent">serang monster lawan!</span>
                </h1>
                <p className="mq-hero__lead">
                  2 hingga maksimal 3 pemain menerima soal yang sama selama 15 detik. Jika kamu benar dan lawan salah, monstermu melancarkan serangan sebesar <strong>10 HP</strong>. Menangkan pertandingan untuk meraih <strong>+10 Coins PlayGo</strong> (lawan pemain asli) dan gunakan item <strong>Hints Jawaban (50:50)</strong> dari Toko Item saat ragu!
                </p>
              </div>
            </div>

            {stats && (
              <div className="mq-stats-strip" aria-label="Statistik Monster Quiz kamu">
                <div className="mq-stat-pill">
                  <span className="muted">Pertandingan</span>
                  <strong>{stats.matchesPlayed}</strong>
                </div>
                <div className="mq-stat-pill">
                  <span className="muted">Menang</span>
                  <strong className="mq-text-success">{stats.wins}</strong>
                </div>
                <div className="mq-stat-pill">
                  <span className="muted">Kalah</span>
                  <strong className="mq-text-danger">{stats.losses}</strong>
                </div>
                <div className="mq-stat-pill">
                  <span className="muted">Win Rate</span>
                  <strong>{stats.winRate}%</strong>
                </div>
              </div>
            )}
          </div>

          <div className="mq-hero__showcase">
            <div className="mq-pedestal">
              <MonsterSprite monsterId={previewMonster.id} animState="idle" facing="left" size={148} />
              <div className="mq-pedestal__meta">
                <span className={`mq-element-tag mq-element-tag--${previewMonster.element}`}>
                  {previewMonster.elementLabel}
                </span>
                <strong>{previewMonster.name}</strong>
                <span className="muted">{previewMonster.title} · 100 HP</span>
              </div>
            </div>
          </div>
        </section>

        <section className="mq-hub-grid" aria-label="Mulai Monster Quiz Battle">
          {/* Panel Mulai Pertandingan */}
          <div className="card card--focus mq-play-panel">
            <h2 className="play-card__title">Mulai Pertarungan</h2>

            {!currentUser ? (
              <>
                <p className="muted">
                  Masuk ke akun PlayGo untuk memilih monster, mencatat kemenangan, dan naik ke peringkat Monster Quiz Battle.
                </p>
                <button type="button" className="btn btn--primary btn--lg btn--block" onClick={onOpenAuth}>
                  Masuk atau Daftar
                </button>
              </>
            ) : searching ? (
              <div className="mq-searching" role="status">
                <MonsterSprite monsterId={selectedMonsterId} animState="idle" facing="right" size={110} />
                <strong>Mencari lawan yang siap bertarung...</strong>
                <p className="muted">Monster pilihanmu: {previewMonster.name} ({previewMonster.elementLabel})</p>
                <button type="button" className="btn btn--secondary btn--block" onClick={actions.cancelMatchmaking}>
                  Batalkan Pencarian
                </button>
              </div>
            ) : (
              <>
                <div className="mq-action-buttons">
                  <button type="button" className="btn btn--primary btn--lg btn--block" onClick={actions.startMatchmaking}>
                    <Icon name="swords" size={20} />
                    <span>Cari Lawan Cepat</span>
                  </button>
                  <button type="button" className="btn btn--secondary btn--lg btn--block" onClick={actions.createRoom}>
                    Buat Room Pakai Kode
                  </button>
                </div>

                <div className="divider"><span>atau gabung room teman</span></div>

                <form
                  className="join-form"
                  onSubmit={e => {
                    e.preventDefault();
                    actions.joinRoomByCode();
                  }}
                >
                  <label htmlFor="quiz-room-code" className="sr-only">Kode room Monster Quiz</label>
                  <input
                    id="quiz-room-code"
                    className="input code-input"
                    value={joinCode}
                    onChange={e => setJoinCode(e.target.value.toUpperCase())}
                    placeholder="Kode room, mis. QZ89A"
                    maxLength={5}
                    autoComplete="off"
                    autoCapitalize="characters"
                  />
                  <button type="submit" className="btn btn--secondary">Gabung</button>
                </form>
              </>
            )}

            {error && <p className="alert alert--error" role="alert">{error}</p>}
          </div>

          {/* Pemilih Monster Awal */}
          <div className="card mq-roster-panel">
            <div className="mq-section-head">
              <h2>Pilih Monster Andalanmu</h2>
              <span className="muted">6 Monster · Semua 100 HP</span>
            </div>
            <div className="mq-monster-grid">
              {QUIZ_MONSTERS.map(m => {
                const isSelected = m.id === selectedMonsterId;
                return (
                  <button
                    key={m.id}
                    type="button"
                    className={`mq-monster-card ${isSelected ? 'mq-monster-card--selected' : ''}`}
                    onClick={() => actions.selectMonster(m.id)}
                    aria-pressed={isSelected}
                  >
                    <div className="mq-monster-card__avatar">
                      <MonsterSprite monsterId={m.id} animState="idle" facing="right" size={64} />
                    </div>
                    <div className="mq-monster-card__body">
                      <div className="mq-monster-card__title">
                        <strong>{m.name}</strong>
                        <span className={`mq-element-tag mq-element-tag--${m.element}`}>
                          {m.elementLabel}
                        </span>
                      </div>
                      <p className="muted">{m.description}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {/* Leaderboard & Riwayat Pertandingan */}
        <section className="card mq-records-card" aria-label="Peringkat dan Riwayat Monster Quiz Battle">
          <div className="mq-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={hubTab === 'leaderboard'}
              className={`btn ${hubTab === 'leaderboard' ? 'btn--primary' : 'btn--ghost'}`}
              onClick={() => setHubTab('leaderboard')}
            >
              <Icon name="trophy" size={18} />
              <span>Peringkat Monster Quiz</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={hubTab === 'history'}
              className={`btn ${hubTab === 'history' ? 'btn--primary' : 'btn--ghost'}`}
              onClick={() => setHubTab('history')}
            >
              <Icon name="chart" size={18} />
              <span>Riwayat Pertandingan</span>
            </button>
          </div>

          {hubTab === 'leaderboard' ? (
            leaderboard.length === 0 ? (
              <p className="muted mq-empty">Belum ada pertandingan Monster Quiz Battle yang tercatat. Jadilah juara pertama!</p>
            ) : (
              <div className="mq-table-wrap">
                <table className="mq-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Pemain</th>
                      <th>Menang</th>
                      <th>Kalah</th>
                      <th>Main</th>
                      <th>Win Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leaderboard.map(row => (
                      <tr key={row.userId} className={currentUser?.id === row.userId ? 'mq-row-me' : ''}>
                        <td><strong>{row.rank}</strong></td>
                        <td>
                          <button
                            type="button"
                            className="mq-user-cell"
                            onClick={() => onViewProfile?.(row.userId)}
                          >
                            <PlayerAvatar player={row} size={28} />
                            <span>{row.name}</span>
                          </button>
                        </td>
                        <td className="mq-text-success"><strong>{row.wins}</strong></td>
                        <td className="mq-text-danger">{row.losses}</td>
                        <td>{row.matchesPlayed}</td>
                        <td><span className="badge badge--info">{row.winRate}%</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : history.length === 0 ? (
            <p className="muted mq-empty">Belum ada riwayat pertandingan. Mulai bertarung untuk melihat catatan duelmu!</p>
          ) : (
            <ul className="mq-history-list">
              {history.map(item => {
                const badgeClass =
                  item.result === 'win'
                    ? 'badge--success'
                    : item.result === 'lose'
                    ? 'badge--danger'
                    : 'badge--warning';
                const badgeLabel =
                  item.result === 'win' ? 'MENANG' : item.result === 'lose' ? 'KALAH' : 'SERI';
                return (
                  <li key={item.id} className="mq-history-item">
                    <div className="mq-history-item__left">
                      <span className={`badge ${badgeClass}`}>{badgeLabel}</span>
                      <div>
                        <strong>
                          {item.me.monsterName} ({item.me.currentHp} HP) vs{' '}
                          {item.opponent ? `${item.opponent.name} — ${item.opponent.monsterName} (${item.opponent.currentHp} HP)` : 'Lawan'}
                        </strong>
                        <p className="muted">
                          {item.roundsPlayed} ronde · Jawaban benar: {item.me.correctAnswers}
                        </p>
                      </div>
                    </div>
                    <time className="muted">
                      {new Date(item.finishedAt).toLocaleDateString('id-ID', {
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </time>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
    );
  }

  // ==========================================
  // PEMAIN DI DALAM ROOM (LOBBY ATAU BATTLE ARENA)
  // ==========================================
  const p0 = room.players?.find(p => p.slot === 0) || null;
  const p1 = room.players?.find(p => p.slot === 1) || null;
  const p2 = room.players?.find(p => p.slot === 2) || null;
  const me = room.players?.find(p => p.userId === currentUser?.id) || null;

  // ==========================================
  // VIEW 2: LOBBY ROOM & PEMILIHAN MONSTER
  // ==========================================
  if (room.phase === 'lobby') {
    const enoughPlayers = (room.players?.length || 0) >= 2;

    return (
      <main className="mq-page" id="main">
        <div className="mq-topbar">
          <button type="button" className="btn btn--secondary" onClick={actions.leaveRoom}>
            <Icon name="arrow-left" size={18} />
            <span>Keluar Room</span>
          </button>

          <div className="mq-room-code-bar">
            {onOpenShop && (
              <button type="button" className="btn btn--secondary" onClick={onOpenShop}>
                <Icon name="bulb" size={16} />
                <span>Hints: {me?.hintCount ?? ownedHints} · Toko</span>
              </button>
            )}
            <span className="badge badge--info">{room.players?.length || 1} / 3 Pemain (Maks 3)</span>
            <span className="muted">Kode Room:</span>
            <strong className="code-text mq-code-pill">{room.code}</strong>
            <button type="button" className="btn btn--secondary" onClick={() => copyRoomCode(room.code)}>
              {copied ? 'Tersalin!' : 'Salin Kode'}
            </button>
          </div>
        </div>

        {error && <p className="alert alert--error" role="alert">{error}</p>}
        {notice && <p className="alert alert--info" role="status">{notice}</p>}

        {/* Duel Stage Preview di Lobby (Mendukung 2 hingga 3 Pemain) */}
        <section className="card card--focus mq-lobby-stage mq-lobby-stage--three" aria-label="Peserta Room">
          <div className="mq-lobby-fighter">
            {p0 ? (
              <>
                <div className="mq-lobby-fighter__user">
                  <PlayerAvatar player={p0} size={36} />
                  <div>
                    <strong>{p0.name} {p0.userId === currentUser?.id ? '(Kamu)' : ''}</strong>
                    <span className={`badge badge--${p0.ready ? 'success' : 'warning'}`}>
                      {p0.ready ? 'SIAP BERTARUNG' : 'MEMILIH MONSTER'}
                    </span>
                  </div>
                </div>
                <MonsterSprite monsterId={p0.monsterId} animState="idle" facing="right" size={132} />
                <div className="mq-lobby-fighter__monster">
                  <strong>{getClientMonster(p0.monsterId).name}</strong>
                  <span className={`mq-element-tag mq-element-tag--${getClientMonster(p0.monsterId).element}`}>
                    {getClientMonster(p0.monsterId).elementLabel} · 100 HP
                  </span>
                </div>
              </>
            ) : (
              <div className="mq-lobby-empty">Menunggu Pemain 1...</div>
            )}
          </div>

          <div className="mq-vs-badge" aria-hidden="true">VS</div>

          <div className="mq-lobby-fighter">
            {p1 ? (
              <>
                <div className="mq-lobby-fighter__user">
                  <PlayerAvatar player={p1} size={36} />
                  <div>
                    <strong>{p1.name} {p1.userId === currentUser?.id ? '(Kamu)' : ''}</strong>
                    <span className={`badge badge--${p1.ready ? 'success' : 'warning'}`}>
                      {p1.ready ? 'SIAP BERTARUNG' : 'MEMILIH MONSTER'}
                    </span>
                  </div>
                </div>
                <MonsterSprite monsterId={p1.monsterId} animState="idle" facing="left" size={132} />
                <div className="mq-lobby-fighter__monster">
                  <strong>{getClientMonster(p1.monsterId).name}</strong>
                  <span className={`mq-element-tag mq-element-tag--${getClientMonster(p1.monsterId).element}`}>
                    {getClientMonster(p1.monsterId).elementLabel} · 100 HP
                  </span>
                </div>
              </>
            ) : (
              <div className="mq-lobby-empty">
                <span className="spinner" aria-hidden="true" />
                <strong>Menunggu Pemain 2...</strong>
                <p className="muted">Bagikan kode room <strong>{room.code}</strong> kepada temanmu.</p>
              </div>
            )}
          </div>

          <div className="mq-lobby-fighter">
            {p2 ? (
              <>
                <div className="mq-lobby-fighter__user">
                  <PlayerAvatar player={p2} size={36} />
                  <div>
                    <strong>{p2.name} {p2.userId === currentUser?.id ? '(Kamu)' : ''}</strong>
                    <span className={`badge badge--${p2.ready ? 'success' : 'warning'}`}>
                      {p2.ready ? 'SIAP BERTARUNG' : 'MEMILIH MONSTER'}
                    </span>
                  </div>
                </div>
                <MonsterSprite monsterId={p2.monsterId} animState="idle" facing="left" size={132} />
                <div className="mq-lobby-fighter__monster">
                  <strong>{getClientMonster(p2.monsterId).name}</strong>
                  <span className={`mq-element-tag mq-element-tag--${getClientMonster(p2.monsterId).element}`}>
                    {getClientMonster(p2.monsterId).elementLabel} · 100 HP
                  </span>
                </div>
              </>
            ) : (
              <div className="mq-lobby-empty">
                <strong>Slot Pemain 3 (Opsional)</strong>
                <p className="muted">Maksimal 3 orang pemain. Pertandingan otomatis dimulai saat semua pemain di room klik Siap (min. 2 pemain).</p>
              </div>
            )}
          </div>
        </section>

        {/* Pilih Monster di Lobby */}
        <section className="card mq-roster-panel" aria-label="Pilih Monster">
          <div className="mq-section-head">
            <h2>Pilih Monster untuk Pertarungan</h2>
            <span className="muted">Klik monster untuk mengganti pilihanmu</span>
          </div>
          <div className="mq-monster-grid">
            {QUIZ_MONSTERS.map(m => {
              const activeId = me?.monsterId || selectedMonsterId;
              const isSelected = m.id === activeId;
              return (
                <button
                  key={m.id}
                  type="button"
                  className={`mq-monster-card ${isSelected ? 'mq-monster-card--selected' : ''}`}
                  onClick={() => actions.selectMonster(m.id)}
                  disabled={Boolean(me?.ready)}
                  aria-pressed={isSelected}
                >
                  <div className="mq-monster-card__avatar">
                    <MonsterSprite monsterId={m.id} animState="idle" facing="right" size={64} />
                  </div>
                  <div className="mq-monster-card__body">
                    <div className="mq-monster-card__title">
                      <strong>{m.name}</strong>
                      <span className={`mq-element-tag mq-element-tag--${m.element}`}>
                        {m.elementLabel}
                      </span>
                    </div>
                    <p className="muted">{m.description}</p>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="mq-lobby-footer">
            <div className="turn-panel__toolbar" style={{ width: '100%', marginBottom: '0.5rem' }}>
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
                  onClick={() => {
                    sound.playClick();
                    actions.setChatOpen(true);
                  }}
                >
                  <span aria-hidden="true">💬</span>
                  {unreadChats > 0 && <span className="count-badge" aria-hidden="true">{unreadChats}</span>}
                </button>
              </div>
            </div>

            <button
              type="button"
              className={`btn btn--lg ${me?.ready ? 'btn--secondary' : 'btn--primary'}`}
              onClick={() => actions.toggleReady(!me?.ready)}
            >
              <Icon name="swords" size={20} />
              <span>
                {me?.ready
                  ? 'Batal Siap (Ganti Monster)'
                  : enoughPlayers
                  ? 'Siap Bertarung!'
                  : 'Siap (Menunggu Lawan)'}
              </span>
            </button>
          </div>
        </section>

        <Modal
          isOpen={Boolean(chatOpen)}
          onClose={() => actions.setChatOpen(false)}
          variant="sheet"
          title="Obrolan room"
          icon="💬"
        >
          <ChatPanel
            chats={chats}
            playerId={currentUser?.id}
            onSend={actions.sendChat}
            quickChats={QUIZ_QUICK_CHATS}
          />
        </Modal>
      </main>
    );
  }

  // ==========================================
  // VIEW 3: RPG BATTLE ARENA (COUNTDOWN, QUESTION, ROUND_RESULT, FINISHED)
  // ==========================================
  const question = room.match?.question || null;
  const currentRoundResult =
    roundResult && roundResult.roundNo === room.match?.roundNo
      ? roundResult
      : room.match?.lastRoundResult && room.phase === 'round_result'
      ? room.match.lastRoundResult
      : null;

  const mySubmittedIndex = room.match?.mySubmittedIndex;
  const myEliminatedOptions = room.match?.myEliminatedOptions || [];
  const myHintCount = me?.hintCount ?? ownedHints;
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const timerPercent = question?.durationMs
    ? Math.max(0, Math.min(100, (remainingMs / question.durationMs) * 100))
    : 0;

  const status0 = formatPlayerRoundStatus(p0, room.phase, currentRoundResult);
  const status1 = formatPlayerRoundStatus(p1, room.phase, currentRoundResult);
  const status2 = p2 ? formatPlayerRoundStatus(p2, room.phase, currentRoundResult) : null;
  const monster0 = getClientMonster(p0?.monsterId);
  const monster1 = getClientMonster(p1?.monsterId);
  const monster2 = p2 ? getClientMonster(p2.monsterId) : null;
  const isSlotDamaged = slotIdx =>
    Boolean(
      damagePopup &&
        (damagePopup.targetSlot === slotIdx ||
          (Array.isArray(damagePopup.targetSlots) && damagePopup.targetSlots.includes(slotIdx)))
    );

  return (
    <main className="mq-battle" id="main">
      {/* Header Battle */}
      <header className="mq-battle__hud">
        <div className="mq-battle__hud-left">
          <span className="mq-round-pill">
            Ronde {room.match?.roundNo || 1} / {room.match?.maxRounds || 20}
          </span>
          {question && (
            <span className="badge badge--brand">
              {question.categoryLabel} · {question.topic}
            </span>
          )}
        </div>
        <div className="mq-battle__hud-right">
          <span className="badge badge--info" title="Stok item Hints Jawaban">
            <Icon name="bulb" size={14} /> Hints: {myHintCount}
          </span>
          {onOpenAudio && (
            <button type="button" className="icon-btn" onClick={onOpenAudio} aria-label="Pengaturan suara">
              <Icon name="volume-on" size={18} />
            </button>
          )}
          <button type="button" className="btn btn--secondary" onClick={actions.leaveRoom}>
            Keluar
          </button>
        </div>
      </header>

      {error && <p className="alert alert--error" role="alert">{error}</p>}
      {notice && <p className="alert alert--info" role="status">{notice}</p>}

      {/* Panggung Arena Pertarungan Monster (2–3 Pemain) */}
      <section
        className={`mq-arena card card--focus ${p2 ? 'mq-arena--three' : ''}`}
        aria-label="Arena Pertarungan Monster"
      >
        {/* Petarung Kiri (Pemain 1 - Slot 0) */}
        <div className={`mq-fighter mq-fighter--left ${slotAnim[0] === 'hurt' ? 'mq-fighter--shake' : ''}`}>
          <FighterLifeCard
            player={p0}
            monster={monster0}
            status={status0}
            isCurrentUser={p0?.userId === currentUser?.id}
            hp={p0?.hp}
          />

          <div className="mq-fighter__stage">
            {isSlotDamaged(0) && (
              <div key={damagePopup.key} className="mq-damage-pop" role="status">
                −{damagePopup.amount} HP
              </div>
            )}
            <MonsterSprite
              monsterId={monster0.id}
              animState={slotAnim[0] || 'idle'}
              facing="right"
              size={156}
            />
          </div>
        </div>

        {/* Ornamen Tengah Arena (hanya ditampilkan di mode 1 lawan 1) */}
        {!p2 && (
          <div className="mq-arena__center" aria-hidden="true">
            <div className="mq-vs-emblem">VS</div>
          </div>
        )}

        {/* Petarung Kanan (Pemain 2 - Slot 1) */}
        <div className={`mq-fighter mq-fighter--right ${slotAnim[1] === 'hurt' ? 'mq-fighter--shake' : ''}`}>
          <FighterLifeCard
            player={p1}
            monster={monster1}
            status={status1}
            isCurrentUser={p1?.userId === currentUser?.id}
            hp={p1?.hp}
          />

          <div className="mq-fighter__stage">
            {isSlotDamaged(1) && (
              <div key={damagePopup.key} className="mq-damage-pop" role="status">
                −{damagePopup.amount} HP
              </div>
            )}
            <MonsterSprite
              monsterId={monster1.id}
              animState={slotAnim[1] || 'idle'}
              facing="left"
              size={156}
            />
          </div>
        </div>

        {/* Petarung Ketiga (Pemain 3 - Slot 2, bila room berisi 3 orang) */}
        {p2 && monster2 && status2 && (
          <div className={`mq-fighter mq-fighter--third ${slotAnim[2] === 'hurt' ? 'mq-fighter--shake' : ''}`}>
            <FighterLifeCard
              player={p2}
              monster={monster2}
              status={status2}
              isCurrentUser={p2?.userId === currentUser?.id}
              hp={p2?.hp}
            />

            <div className="mq-fighter__stage">
              {isSlotDamaged(2) && (
                <div key={damagePopup.key} className="mq-damage-pop" role="status">
                  −{damagePopup.amount} HP
                </div>
              )}
              <MonsterSprite
                monsterId={monster2.id}
                animState={slotAnim[2] || 'idle'}
                facing="left"
                size={156}
              />
            </div>
          </div>
        )}
      </section>

      {/* Panel Bawah: Countdown / Pertanyaan & 4 Opsi / Hasil Akhir */}
      {room.phase === 'countdown' ? (
        <section className="card card--focus mq-command-panel mq-countdown-panel" role="status">
          <span className="mq-eyebrow">BERSIAPLAH!</span>
          <div className="mq-countdown-number">{countdownSec > 0 ? countdownSec : 'MULAI!'}</div>
          <p className="muted">Pertanyaan pertama segera dimulai. Jawab cepat dan tepat dalam 15 detik!</p>
        </section>
      ) : room.phase === 'finished' ? (
        <section className="card card--focus mq-command-panel mq-result-panel" aria-label="Hasil Pertandingan">
          {(() => {
            const winnerId = matchResult?.winnerUserId ?? room.match?.winnerUserId;
            const isWinner = winnerId && winnerId === currentUser?.id;
            const isDraw = !winnerId;
            const endReason = matchResult?.endReason || room.match?.endReason;
            const winnerPlayer = [p0, p1, p2].find(p => p && p.userId === winnerId);
            const rewardPoints = matchResult?.rewardPoints ?? room.match?.rewardPoints ?? 0;

            return (
              <>
                <span className={`badge ${isDraw ? 'badge--warning' : isWinner ? 'badge--success' : 'badge--danger'}`}>
                  {endReason === 'forfeit'
                    ? 'Lawan Meninggalkan Pertandingan'
                    : endReason === 'questions_exhausted'
                    ? 'Seluruh Pertanyaan Selesai'
                    : 'Knockout (HP 0)'}
                </span>
                <h2 className="mq-result-title">
                  {isDraw
                    ? 'Pertarungan Berakhir Seri!'
                    : isWinner
                    ? 'Kemenangan Gemilang!'
                    : `${winnerPlayer?.name || 'Lawan'} Memenangkan Pertarungan!`}
                </h2>
                <p className="muted">
                  {isDraw
                    ? 'Para monster bertahan dengan sisa HP yang sama kuat.'
                    : isWinner
                    ? 'Monstermu berhasil menaklukkan monster lawan di arena kuis!'
                    : 'Jangan menyerah! Balas kekalahanmu di pertandingan berikutnya.'}
                </p>

                {!isDraw && rewardPoints > 0 && (
                  <div className={`mq-reward-banner ${isWinner ? 'mq-reward-banner--win' : ''}`} role="status">
                    <Icon name="coin" size={18} />
                    <span>
                      {isWinner
                        ? `Selamat! Kamu mendapatkan hadiah +${rewardPoints} Coins PlayGo!`
                        : `${winnerPlayer?.name || 'Pemenang'} mendapatkan hadiah +${rewardPoints} Coins PlayGo.`}
                    </span>
                  </div>
                )}

                <div className="mq-result-summary">
                  {[p0, p1, p2].filter(Boolean).map(p => (
                    <div key={p.userId} className="mq-result-player">
                      <PlayerAvatar player={p} size={36} />
                      <div>
                        <strong>{p.name} {p.userId === currentUser?.id ? '(Kamu)' : ''}</strong>
                        <p className="muted">
                          {getClientMonster(p.monsterId).name} · Sisa {p.hp} HP · {p.correctAnswers || 0} Benar
                        </p>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mq-result-actions">
                  <button
                    type="button"
                    className="btn btn--primary btn--lg"
                    onClick={actions.playAgain}
                  >
                    <Icon name="swords" size={18} />
                    <span>{me?.ready ? 'Menunggu Lawan Siap...' : 'Main Ulang'}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn--secondary btn--lg"
                    onClick={() => {
                      actions.leaveRoom();
                      onBackToMenu();
                    }}
                  >
                    Kembali ke Menu
                  </button>
                </div>
              </>
            );
          })()}
        </section>
      ) : (
        <section className="card card--focus mq-command-panel" aria-label="Pertanyaan Kuis">
          {/* Bar Timer 15 Detik */}
          <div className="mq-timer">
            <div className="mq-timer__meta">
              <span>Waktu Menjawab</span>
              <strong className={totalSec <= 5 && room.phase === 'question' ? 'mq-timer__urgent' : ''}>
                {room.phase === 'question' ? `${totalSec} detik` : 'Evaluasi Ronde'}
              </strong>
            </div>
            <div className="mq-timer__track">
              <div
                className={`mq-timer__fill ${totalSec <= 5 ? 'mq-timer__fill--urgent' : ''}`}
                style={{ width: `${room.phase === 'question' ? timerPercent : 0}%` }}
              />
            </div>
          </div>

          {/* Banner Hasil Ronde (Serangan / Tangkisan) */}
          {currentRoundResult && (
            <div
              className={`mq-round-banner mq-round-banner--${
                currentRoundResult.damage > 0 ? 'attack' : 'neutral'
              }`}
              role="status"
            >
              <strong>{buildRoundBannerText(currentRoundResult, [p0, p1, p2])}</strong>
            </div>
          )}

          {/* Teks Pertanyaan */}
          {question && (
            <>
              <div className="mq-question-box">
                <p className="mq-question-prompt">{question.prompt}</p>
              </div>

              {/* Bar Bantuan Item Hints Jawaban (50:50) */}
              {room.phase === 'question' && (me?.hp ?? 100) > 0 && (
                <div className="mq-hint-bar" aria-label="Bantuan Hints Jawaban">
                  <div className="mq-hint-bar__info">
                    <Icon name="bulb" size={18} />
                    {myEliminatedOptions.length > 0 ? (
                      <span>Hint 50:50 Aktif! 2 pilihan jawaban salah telah dieliminasi.</span>
                    ) : (
                      <span>
                        Hints Jawaban (50:50) · Dimiliki: <strong>{myHintCount}</strong>
                      </span>
                    )}
                  </div>
                  {myEliminatedOptions.length === 0 &&
                    (mySubmittedIndex === null || mySubmittedIndex === undefined) &&
                    (myHintCount > 0 ? (
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        onClick={actions.useHint}
                      >
                        <Icon name="bulb" size={16} />
                        <span>Pakai Hint (50:50)</span>
                      </button>
                    ) : onOpenShop ? (
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        onClick={onOpenShop}
                      >
                        <Icon name="shop" size={16} />
                        <span>Beli Hint di Toko (25 Coins)</span>
                      </button>
                    ) : null)}
                </div>
              )}

              {/* 4 Tombol Opsi Jawaban Besar */}
              <div className="mq-options-grid" role="group" aria-label="Pilihan Jawaban">
                {question.options.map((optText, idx) => {
                  const isMyChoice = mySubmittedIndex === idx;
                  const isRevealed = Boolean(currentRoundResult);
                  const isEliminated = !isRevealed && myEliminatedOptions.includes(idx);
                  const isCorrectOpt = isRevealed && currentRoundResult.correctIndex === idx;
                  const isWrongChoice = isRevealed && isMyChoice && !isCorrectOpt;
                  const locked =
                    room.phase !== 'question' ||
                    isEliminated ||
                    (mySubmittedIndex !== null && mySubmittedIndex !== undefined);

                  let stateClass = '';
                  if (isCorrectOpt) stateClass = 'mq-option--correct';
                  else if (isWrongChoice) stateClass = 'mq-option--wrong';
                  else if (isMyChoice) stateClass = 'mq-option--selected';
                  else if (isEliminated) stateClass = 'mq-option--eliminated';

                  return (
                    <button
                      key={idx}
                      type="button"
                      className={`mq-option ${stateClass}`.trim()}
                      disabled={locked}
                      onClick={() => actions.submitAnswer(idx)}
                    >
                      <span className="mq-option__key">{OPTION_LABELS[idx]}</span>
                      <span className="mq-option__text">{optText}</span>
                      {isCorrectOpt && <span className="mq-option__tag">Benar</span>}
                      {isWrongChoice && <span className="mq-option__tag">Pilihanmu</span>}
                      {!isRevealed && isMyChoice && <span className="mq-option__tag">Terkunci</span>}
                      {isEliminated && <span className="mq-option__tag">Salah (Hint)</span>}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </section>
      )}

      {/* Bar Reaksi Emoticon & Tombol Obrolan (seperti JakLudo) */}
      <section className="card mq-chat-bar" aria-label="Reaksi dan Obrolan Room" style={{ padding: '0.65rem 1rem' }}>
        <div className="turn-panel__toolbar" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>
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
              onClick={() => {
                sound.playClick();
                actions.setChatOpen(true);
              }}
            >
              <span aria-hidden="true">💬</span>
              {unreadChats > 0 && <span className="count-badge" aria-hidden="true">{unreadChats}</span>}
            </button>
          </div>
        </div>
      </section>

      <Modal
        isOpen={Boolean(chatOpen)}
        onClose={() => actions.setChatOpen(false)}
        variant="sheet"
        title="Obrolan room"
        icon="💬"
      >
        <ChatPanel
          chats={chats}
          playerId={currentUser?.id}
          onSend={actions.sendChat}
          quickChats={QUIZ_QUICK_CHATS}
        />
      </Modal>
    </main>
  );
}

