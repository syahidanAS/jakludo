import React, { useCallback, useEffect, useState } from 'react';
import Modal from './components/Modal';
import Icon from './components/Icon';
import { isAvatarUrl } from './social/media';
import { sound } from './sound';

const MEDAL_ICONS = { 1: 'medal-1', 2: 'medal-2', 3: 'medal-3' };

function Avatar({ value, name }) {
  if (isAvatarUrl(value)) return <img src={value} alt="" width="36" height="36" className="lb-avatar" />;
  return (
    <span className="lb-avatar" aria-hidden="true">
      {name?.slice(0, 1).toUpperCase() || <Icon name="pawn" size={16} />}
    </span>
  );
}

export default function LeaderboardModal({
  isOpen,
  onClose,
  asPage = false,
  currentUser,
  socket,
  onViewProfile,
  initialTab = 'ludo'
}) {
  const [tab, setTab] = useState(initialTab === 'quiz' ? 'quiz' : 'ludo'); // 'ludo' | 'quiz'
  const [ludoState, setLudoState] = useState({ status: 'idle', list: [] });
  const [quizState, setQuizState] = useState({ status: 'idle', list: [] });

  useEffect(() => {
    if (isOpen) {
      setTab(initialTab === 'quiz' ? 'quiz' : 'ludo');
    }
  }, [isOpen, initialTab]);

  const loadLudo = useCallback(async () => {
    setLudoState(s => ({ ...s, status: 'loading' }));
    try {
      const res = await fetch('/api/leaderboard');
      const data = res.ok ? await res.json() : null;
      if (!data?.success) throw new Error('bad response');
      setLudoState({ status: 'ready', list: data.leaderboard || [] });
    } catch {
      setLudoState(s => ({ ...s, status: 'error' }));
    }
  }, []);

  const loadQuiz = useCallback(async () => {
    setQuizState(s => ({ ...s, status: 'loading' }));
    try {
      const res = await fetch('/api/quiz/leaderboard');
      const data = res.ok ? await res.json() : null;
      if (!data?.success) throw new Error('bad response');
      setQuizState({ status: 'ready', list: data.leaderboard || [] });
    } catch {
      setQuizState(s => ({ ...s, status: 'error' }));
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      loadLudo();
      loadQuiz();
    }
  }, [isOpen, loadLudo, loadQuiz]);

  // Peringkat diperbarui realtime setiap ada pertandingan selesai (Ludo maupun Monster Quiz)
  useEffect(() => {
    if (!socket) return undefined;
    const onLudoUpdate = list => setLudoState({ status: 'ready', list: list || [] });
    const onQuizUpdate = list => setQuizState({ status: 'ready', list: list || [] });
    socket.on('leaderboard:update', onLudoUpdate);
    socket.on('quiz:leaderboard:update', onQuizUpdate);
    return () => {
      socket.off('leaderboard:update', onLudoUpdate);
      socket.off('quiz:leaderboard:update', onQuizUpdate);
    };
  }, [socket]);

  const isQuizTab = tab === 'quiz';
  const activeState = isQuizTab ? quizState : ludoState;
  const { status, list } = activeState;
  const retryLoad = isQuizTab ? loadQuiz : loadLudo;

  const topChampion = isQuizTab
    ? list[0]?.wins > 0
      ? list[0]
      : null
    : list[0]?.isLudoKing
    ? list[0]
    : null;

  const mine = currentUser ? list.find(p => p.userId === currentUser.id) : null;

  const switchTab = nextTab => {
    if (nextTab === tab) return;
    sound.playClick();
    setTab(nextTab);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      asPage={asPage}
      size="lg"
      icon="🏆"
      title="Peringkat Global PlayGo"
      subtitle={
        isQuizTab
          ? 'Peringkat Monster Quiz Battle: diurutkan dari jumlah menang, rasio kemenangan (win rate), dan jumlah pertandingan.'
          : 'Peringkat JakLudo: diurutkan dari jumlah menang, lalu Coins. Pemain peringkat 1 dengan minimal satu kemenangan bergelar Ludo King.'
      }
      footer={
        currentUser && status === 'ready' ? (
          <p className="lb-mine">
            {mine
              ? isQuizTab
                ? `Posisimu di Monster Quiz: #${mine.rank} · ${mine.wins} menang, ${mine.losses} kalah dari ${mine.matchesPlayed} duel (Win Rate ${mine.winRate}%)`
                : `Posisimu di JakLudo: #${mine.rank} · ${mine.wins} menang dari ${mine.matchesPlayed} main · ${mine.points} Coins`
              : isQuizTab
              ? 'Kamu belum masuk peringkat Monster Quiz Battle. Selesaikan satu duel untuk tercatat di peringkat!'
              : 'Kamu belum masuk peringkat JakLudo. Selesaikan satu pertandingan bersama pemain lain.'}
            {!isQuizTab && mine?.isLudoKing && <strong> Kamu Ludo King saat ini 👑</strong>}
          </p>
        ) : null
      }
    >
      {/* Tab Pemisah Leaderboard Global: JakLudo vs Monster Quiz Battle */}
      <div className="tabs" role="tablist" aria-label="Pilih game untuk melihat peringkat global">
        <button
          type="button"
          role="tab"
          aria-selected={!isQuizTab}
          className="tabs__tab"
          onClick={() => switchTab('ludo')}
        >
          <Icon name="pawn" size={16} />
          <span>JakLudo</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={isQuizTab}
          className="tabs__tab"
          onClick={() => switchTab('quiz')}
        >
          <Icon name="swords" size={16} />
          <span>Monster Quiz Battle</span>
        </button>
      </div>

      {status === 'loading' && list.length === 0 && (
        <p className="state-msg" role="status">
          <span className="spinner" aria-hidden="true" /> Memuat peringkat {isQuizTab ? 'Monster Quiz Battle' : 'JakLudo'}...
        </p>
      )}

      {status === 'error' && (
        <div className="state-msg" role="alert">
          <p>Peringkat gagal dimuat. Periksa koneksimu lalu coba lagi.</p>
          <button type="button" className="btn btn--secondary" onClick={retryLoad}>
            Coba lagi
          </button>
        </div>
      )}

      {status === 'ready' && list.length === 0 && (
        <p className="state-msg">
          {isQuizTab
            ? 'Belum ada pemain di peringkat Monster Quiz Battle. Jadilah juara duel pertama!'
            : 'Belum ada pemain di peringkat JakLudo. Jadilah yang pertama menang!'}
        </p>
      )}

      {list.length > 0 && (
        <>
          {topChampion && (
            <div className="lb-king">
              <span className="lb-king__crown" aria-hidden="true">
                <Icon name={isQuizTab ? 'trophy' : 'crown'} size={28} />
              </span>
              <div>
                <p className="muted">
                  {isQuizTab ? 'Juara Monster Quiz Battle saat ini' : 'Ludo King saat ini'}
                </p>
                {onViewProfile ? (
                  <button
                    type="button"
                    className="user-link"
                    onClick={() => onViewProfile(topChampion.userId)}
                  >
                    <strong>{topChampion.name}</strong>
                  </button>
                ) : (
                  <strong>{topChampion.name}</strong>
                )}{' '}
                <span className="muted">@{topChampion.username}</span>
              </div>
            </div>
          )}

          <ol className="lb-list">
            {list.map(p => {
              const isMe = currentUser && p.userId === currentUser.id;
              return (
                <li
                  key={p.userId}
                  className={`lb-row ${isMe ? 'is-me' : ''} ${p.rank <= 3 ? 'is-top' : ''} ${
                    onViewProfile ? 'lb-row--clickable' : ''
                  }`}
                  onClick={onViewProfile ? () => onViewProfile(p.userId) : undefined}
                >
                  <span className="lb-row__rank">
                    {MEDAL_ICONS[p.rank] ? <Icon name={MEDAL_ICONS[p.rank]} size={22} /> : `#${p.rank}`}
                  </span>
                  <Avatar value={p.avatar} name={p.name} />
                  <span className="lb-row__who">
                    <strong>
                      {p.name} {isMe && <span className="badge">Kamu</span>}
                    </strong>
                    <span className="muted">
                      @{p.username} · {p.matchesPlayed} main · menang {p.winRate}% · Klik lihat profil
                    </span>
                  </span>
                  <span className="lb-row__stats">
                    <strong>{p.wins}</strong> <span className="muted">menang</span>
                    <span className="lb-row__points">
                      {isQuizTab ? `${p.losses || 0} kalah · ${p.winRate}%` : `${p.points} Coins`}
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </Modal>
  );
}
