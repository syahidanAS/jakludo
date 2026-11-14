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
registerSocketHandlers(io);

app.get('/health', (_, res) => res.json({
  ok: true,
  rooms: store.rooms.size,
  quizRooms: quizEngine.quizRooms.size,
  chessRooms: chessEngine.chessRooms.size,
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

app.get('/robots.txt', (req, res) => {
  const origin = escapeHtml(getPublicOrigin(req));
  res.type('text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(
    [
      'User-agent: *',
      'Allow: /',
      'Allow: /?game=jakludo',
      'Allow: /?game=monster-quiz',
      'Allow: /?game=chess-master',
      'Disallow: /api/',
      'Disallow: /socket.io/',
      '',
      `Sitemap: ${origin}/sitemap.xml`,
      ''
    ].join('\n')
  );
});

app.get('/sitemap.xml', (req, res) => {
  const origin = escapeHtml(getPublicOrigin(req));
  const today = new Date().toISOString().slice(0, 10);
  res.type('application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${origin}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${origin}/?game=jakludo</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${origin}/?game=monster-quiz</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${origin}/?game=chess-master</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>
</urlset>`
  );
});

// File di /assets punya hash di namanya, jadi aman di-cache selamanya. HTML, sw.js, dan manifest
// harus selalu dicek ulang agar update langsung sampai; file publik lain (musik, ikon) cukup sehari.
app.use('/assets', express.static(path.join(dist, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false }));
app.use(express.static(dist, {
  index: false,
  setHeaders(res, filePath) {
    const noCache = /\.(html|webmanifest|json)$/.test(filePath) || filePath.endsWith('sw.js');
    res.setHeader('Cache-Control', noCache ? 'no-cache' : 'public, max-age=86400');
  }
}));

const GAME_SSR_META = {
  jakludo: {
    title: 'Main JakLudo Online (2–4 Pemain) · PlayGo Multiplayer',
    description:
      'Mainkan JakLudo di PlayGo! Game Ludo multiplayer realtime 2–4 pemain dengan petak Black Hole, item strategi (Force Return & Perisai), obrolan grup, dan papan peringkat global.',
    query: '?game=jakludo'
  },
  'monster-quiz': {
    title: 'Monster Quiz Battle (Duel Kuis RPG 2–3 Pemain) · PlayGo Multiplayer',
    description:
      'Adu cepat pengetahuan umum & matematika di Monster Quiz Battle PlayGo! Pilih monster andalanmu, gunakan Hints Jawaban (50:50), serang monster lawan, dan raih +10 Coins setiap menang!',
    query: '?game=monster-quiz'
  },
  'chess-master': {
    title: 'Chess Master (Catur Online Multiplayer) · PlayGo Strategy',
    description:
      'Master the Board. Rule the Game. Challenge your friends in classic online chess di PlayGo! Rating Elo resmi, Bullet, Blitz, Rapid, Private Room, dan analisis PGN.',
    query: '?game=chess-master'
  }
};

app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  const htmlPath = path.join(dist, 'index.html');
  if (!fs.existsSync(htmlPath)) {
    return res.status(404).send('Build belum tersedia.');
  }

  let html = fs.readFileSync(htmlPath, 'utf8');
  const origin = getPublicOrigin(req);
  const rawGame = String(req.query?.game || '').toLowerCase();
  const gameKey =
    rawGame === 'jakludo' || rawGame === 'ludo'
      ? 'jakludo'
      : rawGame === 'monster-quiz' || rawGame === 'quiz'
      ? 'monster-quiz'
      : rawGame === 'chess-master' || rawGame === 'chess'
      ? 'chess-master'
      : null;
  const gameMeta = gameKey ? GAME_SSR_META[gameKey] : null;
  const canonicalUrl = escapeHtml(`${origin}/${gameMeta ? gameMeta.query : ''}`);
  const safeOrigin = escapeHtml(origin);
  const metaTitle = gameMeta ? escapeHtml(gameMeta.title) : '';
  const metaDescription = gameMeta ? escapeHtml(gameMeta.description) : '';

  if (gameMeta) {
    html = html
      .replace(/<title>[\s\S]*?<\/title>/, `<title>${metaTitle}</title>`)
      .replace(
        /<meta name="description" content="[^"]*" \/>/,
        `<meta name="description" content="${metaDescription}" />`
      )
      .replace(
        /<meta property="og:title" content="[^"]*" \/>/,
        `<meta property="og:title" content="${metaTitle}" />`
      )
      .replace(
        /<meta property="og:description" content="[^"]*" \/>/,
        `<meta property="og:description" content="${metaDescription}" />`
      )
      .replace(
        /<meta name="twitter:title" content="[^"]*" \/>/,
        `<meta name="twitter:title" content="${metaTitle}" />`
      )
      .replace(
        /<meta name="twitter:description" content="[^"]*" \/>/,
        `<meta name="twitter:description" content="${metaDescription}" />`
      );
  }

  html = html
    .replace('<link rel="canonical" href="/" />', `<link rel="canonical" href="${canonicalUrl}" />`)
    .replace('<meta property="og:url" content="/" />', `<meta property="og:url" content="${canonicalUrl}" />`)
    .replace('<meta property="og:image" content="/playgo-logo.jpg" />', `<meta property="og:image" content="${safeOrigin}/playgo-logo.jpg" />`)
    .replace('<meta name="twitter:image" content="/playgo-logo.jpg" />', `<meta name="twitter:image" content="${safeOrigin}/playgo-logo.jpg" />`);

  // URL di data terstruktur (JSON-LD) harus absolut
  html = html.replace(/"url": "\//g, `"url": "${safeOrigin}/`);

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
