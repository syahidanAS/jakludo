// Entry point server PlayGo: menyambungkan HTTP, Socket.IO, dan state permainan (JakLudo & Monster Quiz).
//   server/http/routes.js     REST API
//   server/realtime/socket.js event Socket.IO
//   server/game/              state room, engine permainan, aturan, inventaris item
//   server/items/             definisi item toko (tambah item baru di sini)
//   server/db.js              database PostgreSQL (cadangan file lokal untuk dev/test)
const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { Server } = require('socket.io');
const { loadDotEnv } = require('./migrate');
loadDotEnv();
const db = require('./db');
const store = require('./game/store');
const engine = require('./game/engine');
const quizEngine = require('./quiz/engine');
const chessEngine = require('./chess/engine');
const snakesEngine = require('./snakes/engine');
const adminSpectator = require('./admin/spectator');
const { createApiRouter } = require('./http/routes');
const { registerSocketHandlers } = require('./realtime/socket');

const app = express();
// Set TRUST_PROXY=1 jika server berada di belakang Nginx / Cloudflare Tunnel agar req.ip memakai IP asli
if (process.env.TRUST_PROXY && process.env.TRUST_PROXY !== '0') {
  app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
}
// Klien dilayani dari origin yang sama (Vite dev memakai proxy). CORS hanya dibuka bila diminta.
const corsOrigin = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(s => s.trim()) : null;
if (corsOrigin) app.use(cors({ origin: corsOrigin }));

// Security Headers (Proteksi Clickjacking, MIME-Sniffing, dan XSS)
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '20kb' }));

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 16 * 1024,
  // Lebih toleran terhadap jeda jaringan HP / tunnel: koneksi baru dianggap putus
  // setelah tidak ada balasan ping selama pingInterval + pingTimeout (25 + 30 detik).
  pingInterval: 25000,
  pingTimeout: 30000,
  ...(corsOrigin ? { cors: { origin: corsOrigin } } : {})
});

store.init(io);
quizEngine.init(io);
chessEngine.init(io);
snakesEngine.init(io);
adminSpectator.init(io);
registerSocketHandlers(io);

app.get('/health', (_, res) => res.json({
  ok: true,
  rooms: store.rooms.size,
  quizRooms: quizEngine.quizRooms.size,
  chessRooms: chessEngine.chessRooms.size,
  snakesRooms: snakesEngine.snakesRooms.size,
  db: db.getStatus().engine
}));
app.use('/api', createApiRouter());

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large' || err instanceof SyntaxError) {
    return res.status(400).json({ success: false, error: 'Permintaan tidak valid.' });
  }
  console.error('[http]', err);
  res.status(500).json({ success: false, error: 'Terjadi kesalahan pada server.' });
});

const dist = path.join(__dirname, '../dist');

// Escape untuk nilai yang disisipkan ke HTML/XML (atribut & teks)
const escapeHtml = value =>
  String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// Origin publik untuk canonical/og:url/sitemap. Di production set PUBLIC_URL (mis. https://playgo.example.com).
// Tanpa PUBLIC_URL, header Host/X-Forwarded-* dipakai tapi divalidasi: hanya http/https dan host
// berformat nama domain/IP + port, supaya header palsu tidak bisa menyisipkan HTML.
function getPublicOrigin(req) {
  if (process.env.PUBLIC_URL) {
    return String(process.env.PUBLIC_URL).replace(/\/+$/, '');
  }
  const rawProto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim().toLowerCase();
  const proto = rawProto === 'https' ? 'https' : 'http';
  const rawHost = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
  const host = /^[a-z0-9.-]+(:\d{1,5})?$/i.test(rawHost) ? rawHost : 'localhost:5172';
  return `${proto}://${host}`;
}

const GAME_CANONICAL_PATHS = [
  { key: 'hub', query: '', priority: '1.0' },
  { key: 'jakludo', query: '?game=jakludo', priority: '0.9' },
  { key: 'chess-master', query: '?game=chess-master', priority: '0.9' },
  { key: 'snakes-and-ladders', query: '?game=snakes-and-ladders', priority: '0.9' },
  { key: 'monster-quiz', query: '?game=monster-quiz', priority: '0.9' }
];

function buildPageUrl(origin, query, hl = null, forXml = false) {
  const base = `${origin}/${query || ''}`;
  if (!hl) return base;
  const sep = query ? (forXml ? '&amp;' : '&') : '?';
  return `${base}${sep}hl=${hl}`;
}

app.get('/robots.txt', (req, res) => {
  const origin = escapeHtml(getPublicOrigin(req));
  res.type('text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(
    [
      'User-agent: *',
      'Allow: /',
      ...GAME_CANONICAL_PATHS.filter(p => p.query).map(p => `Allow: /${p.query}`),
      'Allow: /?hl=en',
      'Allow: /?hl=id',
      'Disallow: /api/',
      'Disallow: /socket.io/',
      'Disallow: /admin',
      'Disallow: /admin.html',
      '',
      `Sitemap: ${origin}/sitemap.xml`,
      ''
    ].join('\n')
  );
});

app.get('/ads.txt', (req, res) => {
  res.type('text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send('google.com, pub-9965100396262528, DIRECT, f08c47fec0942fa0\n');
});

app.get('/sitemap.xml', (req, res) => {
  const origin = escapeHtml(getPublicOrigin(req));
  const today = new Date().toISOString().slice(0, 10);
  res.type('application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  const urlNodes = GAME_CANONICAL_PATHS.map(({ query, priority }) => {
    const loc = buildPageUrl(origin, query, null, true);
    const hrefEn = buildPageUrl(origin, query, 'en', true);
    const hrefId = buildPageUrl(origin, query, 'id', true);
    return `  <url>
    <loc>${loc}</loc>
    <xhtml:link rel="alternate" hreflang="x-default" href="${loc}" />
    <xhtml:link rel="alternate" hreflang="en" href="${hrefEn}" />
    <xhtml:link rel="alternate" hreflang="id" href="${hrefId}" />
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>${priority}</priority>
  </url>`;
  }).join('\n');

  res.send(
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urlNodes}
</urlset>`
  );
});

// File di /assets punya hash di namanya, jadi aman di-cache selamanya. HTML, sw.js, dan manifest
// harus selalu dicek ulang agar update langsung sampai; file publik lain (musik, ikon) cukup sehari.
app.use('/assets', express.static(path.join(dist, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false }));

// Panel Admin CMS terpisah (Vite MPA entry: dist/admin.html)
app.get(['/admin', '/admin/*', '/admin.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  const adminHtmlPath = path.join(dist, 'admin.html');
  if (!fs.existsSync(adminHtmlPath)) {
    return res.status(404).send('Build Admin CMS belum tersedia.');
  }
  res.sendFile(adminHtmlPath);
});

app.use(express.static(dist, {
  index: false,
  setHeaders(res, filePath) {
    const noCache = /\.(html|webmanifest|json)$/.test(filePath) || filePath.endsWith('sw.js');
    res.setHeader('Cache-Control', noCache ? 'no-cache' : 'public, max-age=86400');
  }
}));

const GAME_SSR_META = {
  hub: {
    query: '',
    en: {
      title: 'PlayGo · Free Online Multiplayer Browser Games (JakLudo, Chess Master, Snakes & Ladders, Monster Quiz)',
      description:
        'Play free real-time multiplayer browser games with friends worldwide on PlayGo! Enjoy JakLudo (2–4 players), Chess Master (Elo rated online chess), Snakes and Ladders, and Monster Quiz Battle RPG instantly with no download.'
    },
    id: {
      title: 'PlayGo · Game Multiplayer Online Gratis (JakLudo, Chess Master, Ular Tangga & Monster Quiz)',
      description:
        'Mainkan game multiplayer realtime gratis di browser bersama teman seluruh dunia di PlayGo! Tersedia JakLudo (2–4 pemain), Chess Master (catur Elo), Ular Tangga 100 kotak, dan Monster Quiz Battle RPG tanpa unduh.'
    }
  },
  jakludo: {
    query: '?game=jakludo',
    en: {
      title: 'Play JakLudo Online (2–4 Player Multiplayer Ludo) · PlayGo',
      description:
        'Play real-time 2–4 player Ludo online free in your browser on PlayGo! Enjoy Black Hole traps, strategic items (Force Return & Shield), custom skins, friend rooms, and global leaderboards.'
    },
    id: {
      title: 'Main JakLudo Online (Ludo 2–4 Pemain Realtime) · PlayGo Multiplayer',
      description:
        'Mainkan JakLudo di PlayGo! Game Ludo multiplayer realtime 2–4 pemain dengan petak Black Hole, item strategi (Force Return & Perisai), skin bidak eksklusif, obrolan grup, dan papan peringkat global.'
    }
  },
  'monster-quiz': {
    query: '?game=monster-quiz',
    en: {
      title: 'Monster Quiz Battle (2–3 Player Online RPG Trivia) · PlayGo',
      description:
        'Challenge friends worldwide in Monster Quiz Battle on PlayGo! Answer general knowledge and math trivia in 15 seconds, use 50:50 Answer Hints, battle elemental monsters, and earn PlayGo Coins.'
    },
    id: {
      title: 'Monster Quiz Battle (Duel Kuis RPG 2–3 Pemain) · PlayGo Multiplayer',
      description:
        'Adu cepat pengetahuan umum & matematika di Monster Quiz Battle PlayGo! Pilih monster berelemen, gunakan Hints Jawaban (50:50), serang monster lawan, dan raih +10 Coins setiap menang!'
    }
  },
  'chess-master': {
    query: '?game=chess-master',
    en: {
      title: 'Chess Master (Play Online Multiplayer Chess & Elo Rating) · PlayGo',
      description:
        'Master the board and play free online multiplayer chess worldwide on PlayGo! Official Elo ratings, Bullet, Blitz & Rapid clocks, Private Rooms, AI Bot practice, and PGN move analysis.'
    },
    id: {
      title: 'Chess Master (Catur Online Multiplayer & Rating Elo) · PlayGo Strategy',
      description:
        'Mainkan catur online multiplayer gratis di PlayGo! Sistem rating Elo resmi, mode Bullet, Blitz, Rapid, Private Room bersama teman, latihan melawan AI Bot, dan analisis notasi PGN.'
    }
  },
  'snakes-and-ladders': {
    query: '?game=snakes-and-ladders',
    en: {
      title: 'Snakes and Ladders Online Multiplayer (Ular Tangga 100 Tiles) · PlayGo',
      description:
        'Play classic Snakes and Ladders (Ular Tangga) online multiplayer for free on PlayGo! Roll the dice across 100 tiles with Smart Matchmaking, Private Rooms, AI opponents, and global rankings.'
    },
    id: {
      title: 'Ular Tangga Online (Snakes and Ladders Multiplayer) · PlayGo Board Game',
      description:
        'Mainkan Ular Tangga (Snakes and Ladders) multiplayer realtime gratis di PlayGo! Lempar dadu menuju kotak 100, panjat tangga, hindari ular, lengkap dengan Smart Matchmaking & Private Room.'
    }
  }
};

function resolveGameKey(rawGame) {
  const g = String(rawGame || '').toLowerCase();
  if (g === 'jakludo' || g === 'ludo') return 'jakludo';
  if (g === 'monster-quiz' || g === 'quiz') return 'monster-quiz';
  if (g === 'chess-master' || g === 'chess') return 'chess-master';
  if (g === 'snakes-and-ladders' || g === 'snakes' || g === 'ular-tangga') return 'snakes-and-ladders';
  return 'hub';
}

function resolveLangParam(query) {
  const raw = String(query?.hl || query?.lang || '').toLowerCase().trim();
  if (raw === 'id' || raw === 'id-id' || raw === 'ind') return 'id';
  if (raw === 'en' || raw.startsWith('en-')) return 'en';
  return null;
}

app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  const htmlPath = path.join(dist, 'index.html');
  if (!fs.existsSync(htmlPath)) {
    return res.status(404).send('Build belum tersedia.');
  }

  let html = fs.readFileSync(htmlPath, 'utf8');
  const origin = getPublicOrigin(req);
  const safeOrigin = escapeHtml(origin);
  const gameKey = resolveGameKey(req.query?.game);
  const explicitLang = resolveLangParam(req.query);
  const htmlLang = explicitLang || 'en';
  const ogLocale = htmlLang === 'id' ? 'id_ID' : 'en_US';
  const gameEntry = GAME_SSR_META[gameKey] || GAME_SSR_META.hub;
  const localizedMeta = gameEntry[htmlLang] || gameEntry.en;
  const gameQuery = gameEntry.query;

  const xDefaultUrl = escapeHtml(buildPageUrl(origin, gameQuery, null, false));
  const enUrl = escapeHtml(buildPageUrl(origin, gameQuery, 'en', false));
  const idUrl = escapeHtml(buildPageUrl(origin, gameQuery, 'id', false));
  const canonicalUrl = explicitLang === 'id' ? idUrl : explicitLang === 'en' ? enUrl : xDefaultUrl;

  const metaTitle = escapeHtml(localizedMeta.title);
  const metaDescription = escapeHtml(localizedMeta.description);

  html = html
    .replace(/<html lang="[^"]*"/, `<html lang="${htmlLang}"`)
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${metaTitle}</title>`)
    .replace(/<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${metaDescription}" />`)
    .replace(/<meta property="og:locale" content="[^"]*"\s*\/?>/, `<meta property="og:locale" content="${ogLocale}" />`)
    .replace(/<meta property="og:title" content="[^"]*"\s*\/?>/, `<meta property="og:title" content="${metaTitle}" />`)
    .replace(/<meta property="og:description" content="[^"]*"\s*\/?>/, `<meta property="og:description" content="${metaDescription}" />`)
    .replace(/<meta name="twitter:title" content="[^"]*"\s*\/?>/, `<meta name="twitter:title" content="${metaTitle}" />`)
    .replace(/<meta name="twitter:description" content="[^"]*"\s*\/?>/, `<meta name="twitter:description" content="${metaDescription}" />`)
    .replace(/<link rel="canonical" href="[^"]*"\s*\/?>/, `<link rel="canonical" href="${canonicalUrl}" />`)
    .replace(/<link rel="alternate" hreflang="x-default" href="[^"]*"\s*\/?>/, `<link rel="alternate" hreflang="x-default" href="${xDefaultUrl}" />`)
    .replace(/<link rel="alternate" hreflang="en" href="[^"]*"\s*\/?>/, `<link rel="alternate" hreflang="en" href="${enUrl}" />`)
    .replace(/<link rel="alternate" hreflang="id" href="[^"]*"\s*\/?>/, `<link rel="alternate" hreflang="id" href="${idUrl}" />`)
    .replace(/<meta property="og:url" content="[^"]*"\s*\/?>/, `<meta property="og:url" content="${canonicalUrl}" />`)
    .replace(/<meta property="og:image" content="\/playgo-logo\.jpg"\s*\/?>/, `<meta property="og:image" content="${safeOrigin}/playgo-logo.jpg" />`)
    .replace(/<meta name="twitter:image" content="\/playgo-logo\.jpg"\s*\/?>/, `<meta name="twitter:image" content="${safeOrigin}/playgo-logo.jpg" />`);

  // URL dan aset di data terstruktur (JSON-LD) harus absolut
  html = html.replace(/"(url|logo|image)": "\//g, `"$1": "${safeOrigin}/`);

  res.type('text/html; charset=utf-8').send(html);
});

// ==========================================
// PROSES: simpan room saat berhenti, jangan mati karena satu error
// ==========================================

process.on('uncaughtException', err => {
  console.error('[uncaughtException]', err);
  store.flushRooms();
});
process.on('unhandledRejection', err => {
  console.error('[unhandledRejection]', err);
});
// Simpan snapshot semua room lalu tutup koneksi database. Room dipulihkan saat server start lagi.
function shutdown() {
  store.stopAllTimers();
  quizEngine.closeAllRoomsForShutdown();
  quizEngine.stopAllTimers();
  chessEngine.closeAllRoomsForShutdown();
  chessEngine.stopAllTimers();
  require('./chess/botPool').shutdownBotPool();
  snakesEngine.closeAllRoomsForShutdown();
  snakesEngine.stopAllTimers();
  store.flushRooms();
  return db.close();
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    await shutdown();
    process.exit(0);
  });
}

const PORT = process.env.PORT || 5172;
if (require.main === module) {
  db.init()
    .then(() => {
      store.restoreRooms({ onResume: engine.triggerTurn });
      server.listen(PORT, () => console.log(`JakLudo server listening on ${server.address().port}`));
    })
    .catch(err => {
      console.error('[FATAL] Gagal menginisialisasi database:', err);
      process.exit(1);
    });
} else {
  store.restoreRooms({ onResume: engine.triggerTurn });
}

module.exports = { server, io, rooms: store.rooms, shutdown };
