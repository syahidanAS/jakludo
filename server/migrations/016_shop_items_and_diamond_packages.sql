-- Migrasi 016: Tabel Master Shop Items & Diamond Packages untuk Keamanan Transaksi Database
-- Menyimpan katalog item toko dan price list diamond langsung di database PostgreSQL
-- sebagai Single Source of Truth agar tidak bisa dimanipulasi dari sisi client.

-- 1. Tabel Price List Topup Diamond
CREATE TABLE IF NOT EXISTS diamond_packages (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  diamonds INTEGER NOT NULL,
  price INTEGER NOT NULL, -- Harga dalam Rupiah (IDR)
  formatted_price VARCHAR(50) NOT NULL,
  description TEXT,
  subtitle VARCHAR(100),
  badge VARCHAR(50),
  icon VARCHAR(50) DEFAULT 'diamond',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS diamond_packages_active_idx ON diamond_packages(is_active, sort_order);

-- 2. Tabel Katalog Item Toko (JakLudo & Monster Quiz)
CREATE TABLE IF NOT EXISTS shop_items (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  price INTEGER NOT NULL, -- Harga dalam diamond / poin
  game VARCHAR(50) NOT NULL DEFAULT 'ludo', -- 'ludo' atau 'quiz'
  icon VARCHAR(50) NOT NULL,
  description TEXT NOT NULL,
  kind VARCHAR(50) NOT NULL DEFAULT 'active', -- 'active', 'passive', 'reactive'
  badge VARCHAR(50),
  badge_color VARCHAR(50),
  highlight TEXT,
  target VARCHAR(50),
  sound VARCHAR(50) DEFAULT 'chime',
  protects JSONB DEFAULT '[]'::jsonb,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS shop_items_active_idx ON shop_items(is_active, sort_order);
CREATE INDEX IF NOT EXISTS shop_items_game_idx ON shop_items(game);

-- Seed Data Awal Diamond Packages (Price List Top Up)
INSERT INTO diamond_packages (id, name, diamonds, price, formatted_price, description, subtitle, badge, icon, sort_order, is_active)
VALUES
  ('diamond_50', '50 Diamond', 50, 5000, 'Rp 5.000', 'Paket pemula untuk mencoba item & avatar baru.', 'Paket pemula', NULL, 'diamond', 1, TRUE),
  ('diamond_120', '120 Diamond', 120, 10000, 'Rp 10.000', 'Paket hemat paling diminati pemain!', 'Paket hemat', 'Populer', 'diamond', 2, TRUE),
  ('diamond_260', '260 Diamond', 260, 20000, 'Rp 20.000', 'Cukup untuk beli dice, emote, dan skin spesial.', 'Paket reguler', NULL, 'diamond', 3, TRUE),
  ('diamond_700', '700 Diamond', 700, 50000, 'Rp 50.000', 'Dapatkan 600 + Bonus 100 Diamond.', 'Paket premium', 'Bonus 100', 'diamond', 4, TRUE),
  ('diamond_1500', '1.500 Diamond', 1500, 100000, 'Rp 100.000', 'Dapatkan 1.250 + Bonus 250 Diamond.', 'Paket besar', 'Bonus 250', 'diamond', 5, TRUE),
  ('diamond_3250', '3.250 Diamond', 3250, 200000, 'Rp 200.000', 'Paket Sultan! Dapatkan 2.500 + Bonus 750 Diamond.', 'Paket sultan', 'Bonus 750', 'crown', 6, TRUE)
ON CONFLICT (id) DO UPDATE SET
  diamonds = EXCLUDED.diamonds,
  price = EXCLUDED.price,
  formatted_price = EXCLUDED.formatted_price,
  description = EXCLUDED.description,
  subtitle = EXCLUDED.subtitle,
  badge = EXCLUDED.badge,
  icon = EXCLUDED.icon,
  sort_order = EXCLUDED.sort_order,
  updated_at = NOW();

-- Seed Data Awal Shop Items (Item Toko Poin)
INSERT INTO shop_items (id, name, price, game, icon, description, kind, badge, badge_color, highlight, target, sound, protects, sort_order, is_active)
VALUES
  (
    'blackholeShield',
    'Blackhole Shield',
    50,
    'ludo',
    '🛡️',
    'Melindungi bidakmu dari sedotan Black Hole. Saat bidakmu mendarat di petak Black Hole, perisai otomatis aktif sehingga bidakmu tidak kembali ke markas.',
    'passive',
    'Perisai Pasif Otomatis',
    '#3b82f6',
    'Otomatis aktif saat terkena Black Hole',
    NULL,
    'chime',
    '["blackHole"]'::jsonb,
    1,
    TRUE
  ),
  (
    'universalShield',
    'Universal Shield',
    100,
    'ludo',
    '🔰',
    'Menahan Force Return dari lawan dan sedotan Black Hole. Saat bidakmu jadi target Force Return atau mendarat di Black Hole, muncul pilihan untuk memakai perisai ini atau menyimpannya.',
    'reactive',
    'Perisai Pilihan',
    '#7c3aed',
    'Menahan Force Return & Black Hole, kamu yang memilih',
    NULL,
    'chime',
    '["forceReturn", "blackHole"]'::jsonb,
    2,
    TRUE
  ),
  (
    'forceReturn',
    'Force Return',
    100,
    'ludo',
    '⚡',
    'Pulangkan 1 bidak lawan di lintasan langsung ke markas. Dipakai di giliranmu sebelum melempar dadu, dan hanya jika minimal 1 bidakmu sudah keluar dari markas. Lawan yang punya Universal Shield bisa memilih menahannya.',
    'active',
    'Eliminasi Instan',
    '#f59e0b',
    'Dipakai di giliranmu sebelum melempar dadu',
    'opponentPawn',
    'thunder',
    '[]'::jsonb,
    3,
    TRUE
  ),
  (
    'quizHint',
    'Hints Jawaban',
    25,
    'quiz',
    '💡',
    'Bantuan pintar saat ragu menjawab soal di Monster Quiz Battle! Menghilangkan 2 pilihan jawaban yang salah (50:50) pada ronde yang sedang berlangsung sehingga peluang benar meningkat tajam. Maksimal 1 Hint per ronde.',
    'active',
    'Monster Quiz',
    '#3b82f6',
    'Eliminasi 2 opsi jawaban salah (50:50) saat duel Monster Quiz Battle',
    NULL,
    'chime',
    '[]'::jsonb,
    4,
    TRUE
  )
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  price = EXCLUDED.price,
  game = EXCLUDED.game,
  icon = EXCLUDED.icon,
  description = EXCLUDED.description,
  kind = EXCLUDED.kind,
  badge = EXCLUDED.badge,
  badge_color = EXCLUDED.badge_color,
  highlight = EXCLUDED.highlight,
  target = EXCLUDED.target,
  sound = EXCLUDED.sound,
  protects = EXCLUDED.protects,
  sort_order = EXCLUDED.sort_order,
  updated_at = NOW();

