// Utilitas SEO dinamis untuk memperbarui judul halaman, meta description, Open Graph,
// serta sinkronisasi URL parameter (?game=jakludo | ?game=monster-quiz) di PlayGo.

const SEO_CONFIGS = {
  hub: {
    title: 'PlayGo · Platform Game Multiplayer Online Gratis (JakLudo & Monster Quiz Battle)',
    description:
      'PlayGo adalah platform game multiplayer realtime gratis di browser. Mainkan JakLudo (Ludo online 2–4 pemain) dan Monster Quiz Battle (duel kuis RPG 2–3 pemain) bersama teman & grup!',
    image: '/playgo-logo.jpg',
    query: ''
  },
  ludo: {
    title: 'Main JakLudo Online (2–4 Pemain) · PlayGo Multiplayer',
    description:
      'Mainkan JakLudo di PlayGo! Game Ludo multiplayer realtime 2–4 pemain dengan petak Black Hole, item strategi (Force Return & Perisai), obrolan grup, dan papan peringkat global.',
    image: '/playgo-logo.jpg',
    query: '?game=jakludo'
  },
  quiz: {
    title: 'Monster Quiz Battle (Duel Kuis RPG 2–3 Pemain) · PlayGo Multiplayer',
    description:
      'Adu cepat pengetahuan umum & matematika di Monster Quiz Battle PlayGo! Pilih monster andalanmu, gunakan Hints Jawaban (50:50), serang monster lawan, dan raih +10 Coins setiap menang!',
    image: '/playgo-logo.jpg',
    query: '?game=monster-quiz'
  },
  chess: {
    title: 'Chess Master (Catur Online Multiplayer) · PlayGo Strategy',
    description:
      'Master the Board. Rule the Game. Challenge your friends in classic online chess di PlayGo! Rating Elo resmi, Bullet, Blitz, Rapid, Private Room, dan analisis PGN.',
    image: '/playgo-logo.jpg',
    query: '?game=chess-master'
  },
  snakes: {
    title: 'Ular Tangga (Snakes and Ladders Online Multiplayer) · PlayGo Board Game',
    description:
      'Mainkan Ular Tangga (Snakes and Ladders) multiplayer realtime di PlayGo! Lempar dadu menuju kotak 100, panjat tangga, hindari ular, dengan Smart Matchmaking & Private Room!',
    image: '/playgo-logo.jpg',
    query: '?game=snakes-and-ladders'
  },
  shop: {
    title: 'Toko Item & Hints Jawaban · PlayGo Multiplayer',
    description:
      'Tukarkan Coins kemenanganmu di Toko Item PlayGo! Beli Hints Jawaban (50:50) untuk Monster Quiz Battle serta Perisai dan Force Return untuk JakLudo.',
    image: '/playgo-logo.jpg'
  },
  leaderboard: {
    title: 'Peringkat Global JakLudo & Monster Quiz Battle · PlayGo',
    description:
      'Lihat papan peringkat global pemain terbaik JakLudo dan Monster Quiz Battle di platform PlayGo.',
    image: '/playgo-logo.jpg'
  },
  friends: {
    title: 'Teman & Chat Private · PlayGo Multiplayer',
    description:
      'Tambah teman, kirim pesan private, dan undang temanmu bermain JakLudo atau Monster Quiz Battle secara realtime di PlayGo.',
    image: '/playgo-logo.jpg'
  },
  groups: {
    title: 'Grup & Chat Mabar · PlayGo Multiplayer',
    description:
      'Buat grup mabar di PlayGo, mengobrol lewat pesan teks/suara/foto, dan mulai match grup JakLudo maupun Monster Quiz Battle.',
    image: '/playgo-logo.jpg'
  }
};

function setMetaTag(selector, attr, value) {
  if (typeof document === 'undefined' || !value) return;
  const el = document.querySelector(selector);
  if (el) el.setAttribute(attr, value);
}

export function getInitialGameModeFromUrl() {
  if (typeof window === 'undefined') return 'hub';
  const params = new URLSearchParams(window.location.search);
  const game = String(params.get('game') || '').toLowerCase();
  if (game === 'jakludo' || game === 'ludo') return 'ludo';
  if (game === 'monster-quiz' || game === 'quiz') return 'quiz';
  if (game === 'chess-master' || game === 'chess') return 'chess';
  if (game === 'snakes-and-ladders' || game === 'snakes' || game === 'ular-tangga') return 'snakes';
  return 'hub';
}

// URL halaman untuk mode game tertentu (dipakai riwayat navigasi agar tombol Back browser bekerja)
export function gameModeUrl(gameMode = 'hub') {
  const cfg = SEO_CONFIGS[gameMode] || SEO_CONFIGS.hub;
  return `${window.location.pathname}${cfg.query || ''}${window.location.hash || ''}`;
}

export function applySeo({ gameMode = 'hub', modal = null, roomCode = null }) {
  if (typeof document === 'undefined') return;

  const key = modal && SEO_CONFIGS[modal] ? modal : SEO_CONFIGS[gameMode] ? gameMode : 'hub';
  const cfg = SEO_CONFIGS[key] || SEO_CONFIGS.hub;

  let title = cfg.title;
  if (roomCode && (gameMode === 'ludo' || gameMode === 'quiz' || gameMode === 'chess' || gameMode === 'snakes')) {
    const gameLabel =
      gameMode === 'quiz'
        ? 'Monster Quiz Battle'
        : gameMode === 'chess'
        ? 'Chess Master'
        : gameMode === 'snakes'
        ? 'Ular Tangga'
        : 'JakLudo';
    title = `Room ${roomCode} · ${gameLabel} — PlayGo`;
  }

  document.title = title;
  setMetaTag('meta[name="description"]', 'content', cfg.description);
  setMetaTag('meta[property="og:title"]', 'content', title);
  setMetaTag('meta[property="og:description"]', 'content', cfg.description);
  setMetaTag('meta[name="twitter:title"]', 'content', title);
  setMetaTag('meta[name="twitter:description"]', 'content', cfg.description);

  if (typeof window !== 'undefined' && window.history?.replaceState) {
    const modeCfg = SEO_CONFIGS[gameMode] || SEO_CONFIGS.hub;
    const targetSearch = modeCfg.query || '';
    const currentSearch = window.location.search || '';
    if (
      (currentSearch === '' || currentSearch.startsWith('?game=')) &&
      currentSearch !== targetSearch
    ) {
      const nextUrl = `${window.location.pathname}${targetSearch}${window.location.hash || ''}`;
      window.history.replaceState(window.history.state, '', nextUrl);
    }
    const canonicalUrl = `${window.location.origin}${window.location.pathname}${targetSearch}`;
    setMetaTag('link[rel="canonical"]', 'href', canonicalUrl);
    setMetaTag('meta[property="og:url"]', 'content', canonicalUrl);
  }
}

