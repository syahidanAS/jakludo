import React from 'react';
import Icon from '../components/Icon';
import jakludoLogo from '../assets/jakludo-logo.webp';
import monsterQuizLogo from '../assets/monster-quiz-logo.webp';
import chessMasterLogo from '../assets/chess-master-logo.webp';
import { isAvatarUrl } from '../social/media';

const COLORS = ['red', 'green', 'yellow', 'blue'];

function ActiveRoomCard({ room, onJoin }) {
  const humans = room.players.filter(p => !p.isBot);
  const bots = room.players.length - humans.length;
  const online = humans.filter(p => p.connected).length;
  return (
    <article className="active-room card">
      <div className="active-room__info">
        <span className={`dot color-${room.myColor}`} style={{ background: 'var(--pc)' }} aria-hidden="true" />
        <div>
          <strong>JakLudo · {room.started ? 'Permainan masih berjalan' : 'Ruang tunggu masih terbuka'}</strong>
          <p className="muted">
            Room <span className="code-text">{room.code}</span>
            {room.isCreator ? ' · buatanmu' : ''} · {humans.length} pemain{bots ? ` + ${bots} bot` : ''} · {online} online
          </p>
        </div>
      </div>
      <button type="button" className="btn btn--primary" onClick={() => onJoin(room.code)}>
        {room.started ? 'Lanjutkan main' : 'Masuk lagi'}
      </button>
    </article>
  );
}

function GlobalLeaderboardSection({ onOpenLeaderboard }) {
  const [tab, setTab] = React.useState('ludo');
  const [ludoList, setLudoList] = React.useState([]);
  const [quizList, setQuizList] = React.useState([]);
  const [chessList, setChessList] = React.useState([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let active = true;
    Promise.all([
      fetch('/api/leaderboard').then(r => r.json()).catch(() => ({})),
      fetch('/api/quiz/leaderboard').then(r => r.json()).catch(() => ({})),
      fetch('/api/chess/leaderboard?page=1&limit=10').then(r => r.json()).catch(() => ({}))
    ]).then(([ludoData, quizData, chessData]) => {
      if (!active) return;
      if (ludoData?.success) setLudoList(ludoData.leaderboard || []);
      if (quizData?.success) setQuizList(quizData.leaderboard || []);
      if (chessData?.success) setChessList(chessData.entries || chessData.leaderboard || []);
      setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const isQuiz = tab === 'quiz';
  const isChess = tab === 'chess';
  const list = isChess ? chessList : isQuiz ? quizList : ludoList;
  const topList = list.slice(0, 5);

  return (
    <section className="home__leaderboard card" aria-label="Peringkat Global PlayGo">
      <div className="home__leaderboard-header">
        <div className="home__leaderboard-title">
          <span
            className="link-card__icon"
            aria-hidden="true"
            style={{ background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b' }}
          >
            <Icon name="trophy" size={24} />
          </span>
          <div>
            <h3 style={{ margin: 0, fontSize: 'var(--fs-lg)' }}>Peringkat Global PlayGo</h3>
            <p className="muted" style={{ margin: '2px 0 0', fontSize: 'var(--fs-xs)' }}>
              Pemain terbaik dengan kemenangan dan Coins terbanyak
            </p>
          </div>
        </div>

        <div className="home__leaderboard-actions">
          <div className="tabs" role="tablist" style={{ margin: 0 }}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'ludo'}
              className="tabs__tab"
              onClick={() => setTab('ludo')}
            >
              <Icon name="pawn" size={14} />
              <span>JakLudo</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={isQuiz}
              className="tabs__tab"
              onClick={() => setTab('quiz')}
            >
              <Icon name="swords" size={14} />
              <span>Monster Quiz</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={isChess}
              className="tabs__tab"
              onClick={() => setTab('chess')}
            >
              <Icon name="chess" size={14} />
              <span>Chess Master</span>
            </button>
          </div>
          {onOpenLeaderboard && (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={onOpenLeaderboard}
            >
              Buka Penuh
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <p className="state-msg" style={{ padding: 'var(--space-4) 0' }}>
          <span className="spinner" aria-hidden="true" /> Memuat peringkat global...
        </p>
      ) : topList.length === 0 ? (
        <p className="muted" style={{ textAlign: 'center', padding: 'var(--space-4) 0' }}>
          Belum ada data peringkat. Jadilah pemenang pertama!
        </p>
      ) : (
        <ol className="lb-list" style={{ marginTop: 'var(--space-2)' }}>
          {topList.map(player => (
            <li key={player.userId || player.id} className={`lb-row ${player.rank === 1 ? 'is-top' : ''}`}>
              <span className="lb-row__rank">
                {player.rank === 1 ? '🥇' : player.rank === 2 ? '🥈' : player.rank === 3 ? '🥉' : `#${player.rank}`}
              </span>
              <span className="lb-avatar">
                {player.avatar && isAvatarUrl(player.avatar) ? (
                  <img src={player.avatar} alt="" width="36" height="36" className="lb-avatar" />
                ) : (
                  player.name?.slice(0, 1).toUpperCase() || '🎯'
                )}
              </span>
              <div className="lb-row__who">
                <strong>{player.name}</strong>
                <span className="muted">@{player.username}</span>
              </div>
              <div className="lb-row__stats">
                {isChess ? (
                  <>
                    <span><strong>{player.rating}</strong> Elo</span>
                    <span className="muted">({player.winRate || 0}% menang)</span>
                  </>
                ) : isQuiz ? (
                  <>
                    <span><strong>{player.wins}</strong> menang</span>
                    <span className="muted">({player.winRate || 0}%)</span>
                  </>
                ) : (
                  <>
                    <span><strong>{player.wins}</strong> menang</span>
                    <span className="lb-row__points">
                      <Icon name="coin" size={14} /> {player.points}
                    </span>
                  </>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      {onOpenLeaderboard && (
        <div className="home__leaderboard-footer">
          <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
            Diperbarui realtime setiap pertandingan selesai
          </span>
          <button
            type="button"
            className="btn btn--link"
            style={{ fontSize: 'var(--fs-xs)', padding: 0 }}
            onClick={onOpenLeaderboard}
          >
            Lihat Peringkat Lengkap (Top 100) →
          </button>
        </div>
      )}
    </section>
  );
}

function PlatformLinks({ onOpenLeaderboard, isInstalled, onInstall }) {
  const showInstall = !isInstalled && onInstall;
  if (!onOpenLeaderboard && !showInstall) return null;
  return (
    <div className="home__links">
      {onOpenLeaderboard && (
        <button type="button" className="link-card card" data-tour="leaderboard" onClick={onOpenLeaderboard}>
          <span className="link-card__icon" aria-hidden="true">
            <Icon name="trophy" size={24} />
          </span>
          <span>
            <strong>Peringkat pemain</strong>
            <span className="muted">Lihat peringkat pemain terbaik di PlayGo</span>
          </span>
        </button>
      )}
      {showInstall && (
        <button type="button" className="link-card card" onClick={onInstall}>
          <span className="link-card__icon" aria-hidden="true">
            <Icon name="install" size={24} />
          </span>
          <span>
            <strong>Pasang di layar utama</strong>
            <span className="muted">Buka PlayGo layar penuh tanpa bilah browser</span>
          </span>
        </button>
      )}
    </div>
  );
}

export default function HomeScreen({
  user,
  checkingAuth,
  gameMode = 'hub',
  code,
  error,
  activeRooms = [],
  activeQuizRoom,
  activeChessRoom,
  isInstalled,
  actions,
  friendBadgeCount = 0,
  groupBadgeCount = 0,
  onSelectGame,
  onBackToHub,
  onOpenFriends,
  onOpenGroups,
  onOpenAuth,
  onOpenLeaderboard,
  onOpenMonsterQuiz,
  onInstall
}) {
  const selectLudo = () => {
    if (onSelectGame) onSelectGame('ludo');
  };
  const selectQuiz = () => {
    if (onSelectGame) onSelectGame('quiz');
    else if (onOpenMonsterQuiz) onOpenMonsterQuiz();
  };
  const selectChess = () => {
    if (onSelectGame) onSelectGame('chess');
  };

  // ==========================================
  // VIEW A: HALAMAN GAME JAKLUDO (SETELAH MEMILIH JAKLUDO DARI HUB)
  // ==========================================
  if (gameMode === 'ludo') {
    return (
      <main className="home" id="main">
        {onBackToHub && (
          <div className="playgo-subnav">
            <button type="button" className="btn btn--secondary" onClick={onBackToHub}>
              <Icon name="arrow-left" size={18} />
              <span>Daftar Game PlayGo</span>
            </button>
            <span className="badge badge--brand">PlayGo · JakLudo (2–4 Pemain)</span>
          </div>
        )}

        <section className="home__hero">
          <div className="home__intro">
            <span className="playgo-eyebrow">BAGIAN DARI PLAYGO · BOARD GAME</span>
            <h1 className="home__title">
              JakLudo: Main Ludo bareng teman, <span className="home__title-accent">langsung dari HP.</span>
            </h1>
            <p className="home__lead">
              Buat room, bagikan kodenya, dan main sampai empat orang secara realtime. Ada zona aman, mode Black Hole, item toko, dan perebutan gelar Ludo King.
            </p>
            <ul className="color-strip" aria-hidden="true">
              {COLORS.map(c => <li key={c} className={`color-${c}`} />)}
            </ul>
          </div>
          <figure className="home__art">
            <img src={jakludoLogo} alt="Logo JakLudo: dadu, bidak Ludo, dan Monas" width="720" height="480" fetchpriority="high" />
          </figure>
        </section>

        <section className="home__play" aria-label="Mulai bermain JakLudo">
          {activeRooms.length > 0 && (
            <div className="active-rooms">
              {activeRooms.map(r => <ActiveRoomCard key={r.code} room={r} onJoin={actions.joinRoom} />)}
            </div>
          )}

          <div className="play-card card card--focus">
            {checkingAuth ? (
              <p className="play-card__loading" role="status">
                <span className="spinner" aria-hidden="true" /> Memeriksa sesi login...
              </p>
            ) : user ? (
              <>
                <h2 className="play-card__title">Mulai permainan JakLudo</h2>
                <button type="button" className="btn btn--primary btn--lg btn--block" onClick={actions.createRoom}>
                  Buat room baru
                </button>
                <div className="divider"><span>atau gabung pakai kode</span></div>
                <form
                  className="join-form"
                  onSubmit={e => {
                    e.preventDefault();
                    actions.joinRoom();
                  }}
                >
                  <label htmlFor="room-code" className="sr-only">Kode room</label>
                  <input
                    id="room-code"
                    className="input code-input"
                    value={code}
                    onChange={e => actions.setCode(e.target.value.toUpperCase())}
                    placeholder="Kode room, mis. AB12C"
                    maxLength={5}
                    autoComplete="off"
                    autoCapitalize="characters"
                  />
                  <button type="submit" className="btn btn--secondary">Gabung</button>
                </form>
              </>
            ) : (
              <>
                <h2 className="play-card__title">Masuk ke PlayGo untuk bermain</h2>
                <p className="muted">Akun dipakai untuk menyimpan Coins, item toko, dan posisimu di peringkat.</p>
                <button type="button" className="btn btn--primary btn--lg btn--block" onClick={onOpenAuth}>
                  Masuk atau daftar
                </button>
              </>
            )}
            {error && <p className="alert alert--error" role="alert">{error}</p>}
          </div>

          <PlatformLinks
            onOpenLeaderboard={onOpenLeaderboard}
            isInstalled={isInstalled}
            onInstall={onInstall}
          />
        </section>
      </main>
    );
  }

  // ==========================================
  // VIEW B: HALAMAN DEPAN / LANDING PAGE PLAYGO (DAFTAR GAME)
  // ==========================================
  return (
    <main className="playgo-hub" id="main">
      {!checkingAuth && !user && (
        <section className="playgo-auth-box card card--focus" aria-label="Masuk ke PlayGo">
          <h2 className="play-card__title">Masuk ke PlayGo</h2>
          <p className="muted">
            Masuk atau daftar akun PlayGo untuk mengakses seluruh daftar game, menyimpan Coins, item toko, teman, grup, dan papan peringkat.
          </p>
          <button type="button" className="btn btn--primary btn--lg btn--block" onClick={onOpenAuth}>
            Masuk atau Daftar Akun
          </button>
        </section>
      )}

      {/* Sesi Permainan yang Masih Aktif */}
      {user && (activeRooms.length > 0 || activeQuizRoom?.code || activeChessRoom?.code) && (
        <section className="active-rooms" aria-label="Permainan yang sedang berlangsung">
          {activeRooms.map(r => (
            <ActiveRoomCard key={r.code} room={r} onJoin={actions.joinRoom} />
          ))}
          {activeQuizRoom?.code && (
            <article className="active-room card">
              <div className="active-room__info">
                <span className="dot" style={{ background: 'var(--brand)' }} aria-hidden="true" />
                <div>
                  <strong>Monster Quiz Battle · Pertandingan aktif</strong>
                  <p className="muted">
                    Room <span className="code-text">{activeQuizRoom.code}</span> · Duel kuis 2–3 pemain
                  </p>
                </div>
              </div>
              <button type="button" className="btn btn--primary" onClick={selectQuiz}>
                Lanjutkan Duel
              </button>
            </article>
          )}
          {activeChessRoom?.code && (
            <article className="active-room card">
              <div className="active-room__info">
                <span className="dot" style={{ background: '#f59e0b' }} aria-hidden="true" />
                <div>
                  <strong>Chess Master · Pertandingan aktif</strong>
                  <p className="muted">
                    Room <span className="code-text">{activeChessRoom.code}</span> · Catur Online ({activeChessRoom.timeControl || '5+0'})
                  </p>
                </div>
              </div>
              <button type="button" className="btn btn--primary" onClick={selectChess}>
                Lanjutkan Catur
              </button>
            </article>
          )}
        </section>
      )}

      {/* DAFTAR GAME PLAYGO */}
      <section className="playgo-catalog" aria-label="Daftar Game PlayGo">
        <div className="playgo-catalog__head">
          <div>
            <span className="playgo-eyebrow">KOLEKSI GAME PLAYGO</span>
            <h1 className="playgo-catalog__title">
              {user ? 'Pilih Game untuk Dimainkan' : 'Daftar Game di PlayGo'}
            </h1>
          </div>
          <span className="muted">Pilih salah satu game untuk mulai bermain</span>
        </div>

        <div className="playgo-games-grid">
          {/* GAME 1: JAKLUDO */}
          <article className="playgo-game-card card card--focus">
            <div className="playgo-game-card__visual playgo-game-card__visual--ludo">
              <img
                src={jakludoLogo}
                alt="Ilustrasi game JakLudo"
                width="360"
                height="240"
                className="playgo-game-card__img"
              />
              <ul className="color-strip playgo-game-card__pawns" aria-hidden="true">
                {COLORS.map(c => <li key={c} className={`color-${c}`} />)}
              </ul>
            </div>

            <div className="playgo-game-card__body">
              <div className="playgo-game-card__tags">
                <span className="badge badge--brand">Board Game</span>
                <span className="badge">2–4 Pemain</span>
                <span className="badge badge--success">Game PlayGo</span>
              </div>

              <h3 className="playgo-game-card__name">JakLudo</h3>
              <p className="playgo-game-card__desc muted">
                Permainan papan Ludo klasik bersama teman atau bot pintar secara realtime. Dilengkapi zona aman, mode Black Hole, toko dadu &amp; bidak tematik, serta perebutan gelar Ludo King!
              </p>

              <div className="playgo-game-card__actions">
                <button
                  type="button"
                  className="btn btn--primary btn--lg btn--block"
                  onClick={user ? selectLudo : onOpenAuth}
                >
                  <Icon name="pawn" size={18} />
                  <span>{user ? 'Mainkan JakLudo' : 'Masuk untuk Main JakLudo'}</span>
                </button>
                {user && (
                  <button
                    type="button"
                    className="btn btn--secondary btn--block"
                    onClick={actions.createRoom}
                  >
                    Buat Room JakLudo Cepat
                  </button>
                )}
              </div>
            </div>
          </article>

          {/* GAME 2: MONSTER QUIZ BATTLE */}
          <article className="playgo-game-card card card--focus">
            <div className="playgo-game-card__visual playgo-game-card__visual--quiz">
              <img
                src={monsterQuizLogo}
                alt="Logo Monster Quiz Battle"
                width="360"
                height="240"
                className="playgo-game-card__img"
              />
            </div>

            <div className="playgo-game-card__body">
              <div className="playgo-game-card__tags">
                <span className="badge badge--brand">RPG Trivia</span>
                <span className="badge">2–3 Pemain (Maks 3 Orang)</span>
                <span className="badge badge--success">Game PlayGo</span>
              </div>

              <h3 className="playgo-game-card__name">Monster Quiz Battle</h3>
              <p className="playgo-game-card__desc muted">
                Pilih 1 dari 6 monster elemen (100 HP) dan adu cepat menjawab soal pengetahuan umum &amp; matematika dalam 15 detik. Jawaban tepat membuat monstermu menyerang lawan sebesar −10 HP!
              </p>

              <div className="playgo-game-card__actions">
                <button
                  type="button"
                  className="btn btn--primary btn--lg btn--block"
                  onClick={user ? selectQuiz : onOpenAuth}
                >
                  <Icon name="swords" size={18} />
                  <span>
                    {activeQuizRoom?.code
                      ? `Lanjutkan Duel (${activeQuizRoom.code})`
                      : user
                      ? 'Mainkan Monster Quiz Battle'
                      : 'Masuk untuk Main Monster Quiz'}
                  </span>
                </button>
                {user && (
                  <button
                    type="button"
                    className="btn btn--secondary btn--block"
                    onClick={selectQuiz}
                  >
                    Pilih Monster &amp; Cari Lawan
                  </button>
                )}
              </div>
            </div>
          </article>

          {/* GAME 3: CHESS MASTER */}
          <article className="playgo-game-card card card--focus">
            <div className="playgo-game-card__visual playgo-game-card__visual--chess">
              <img
                src={chessMasterLogo}
                alt="Logo Chess Master PlayGo"
                width="360"
                height="240"
                className="playgo-game-card__img"
              />
            </div>

            <div className="playgo-game-card__body">
              <div className="playgo-game-card__tags">
                <span className="badge badge--brand">Strategy</span>
                <span className="badge">Board Game · 1v1</span>
                <span className="badge badge--success">Available</span>
              </div>

              <h3 className="playgo-game-card__name">Chess Master</h3>
              <p className="playgo-game-card__desc muted">
                <strong>Master the Board. Rule the Game.</strong> Challenge your friends in classic online chess.
                Dilengkapi sistem rating Elo resmi, mode Bullet/Blitz/Rapid, Private Room, dan ekspor PGN!
              </p>

              <div className="playgo-game-card__actions">
                <button
                  type="button"
                  className="btn btn--primary btn--lg btn--block"
                  onClick={user ? selectChess : onOpenAuth}
                >
                  <Icon name="chess" size={18} />
                  <span>
                    {activeChessRoom?.code
                      ? `Continue Match (${activeChessRoom.code})`
                      : 'Play Now'}
                  </span>
                </button>
                {user && (
                  <button
                    type="button"
                    className="btn btn--secondary btn--block"
                    onClick={selectChess}
                  >
                    Create / Join Private Room
                  </button>
                )}
              </div>
            </div>
          </article>
        </div>
      </section>

      {error && <p className="alert alert--error" role="alert">{error}</p>}

      {/* Papan Peringkat Global PlayGo */}
      <GlobalLeaderboardSection onOpenLeaderboard={onOpenLeaderboard} />

      <section aria-label="Akses Peringkat & PWA">
        <PlatformLinks
          onOpenLeaderboard={onOpenLeaderboard}
          isInstalled={isInstalled}
          onInstall={onInstall}
        />
      </section>
    </main>
  );
}
