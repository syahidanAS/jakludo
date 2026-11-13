-- Migrasi 017: Ubah Istilah Diamond / Poin Menjadi Coins dan Ikon Coin
-- Memperbarui data katalog paket top-up dan deskripsi di tabel diamond_packages dan shop_items

-- 1. Perbarui nama paket, deskripsi, dan ikon pada diamond_packages
UPDATE diamond_packages
SET
  name = REPLACE(name, 'Diamond', 'Coins'),
  description = REPLACE(description, 'Diamond', 'Coins'),
  icon = CASE WHEN icon = 'diamond' THEN 'coin' ELSE icon END,
  updated_at = NOW();

-- 2. Pastikan paket yang sudah ada tersinkronisasi dengan label Coins
UPDATE diamond_packages
SET
  name = '50 Coins',
  icon = 'coin',
  updated_at = NOW()
WHERE id = 'diamond_50';

UPDATE diamond_packages
SET
  name = '120 Coins',
  icon = 'coin',
  updated_at = NOW()
WHERE id = 'diamond_120';

UPDATE diamond_packages
SET
  name = '260 Coins',
  icon = 'coin',
  updated_at = NOW()
WHERE id = 'diamond_260';

UPDATE diamond_packages
SET
  name = '700 Coins',
  icon = 'coin',
  description = 'Dapatkan 600 + Bonus 100 Coins.',
  updated_at = NOW()
WHERE id = 'diamond_700';

UPDATE diamond_packages
SET
  name = '1.500 Coins',
  icon = 'coin',
  description = 'Dapatkan 1.250 + Bonus 250 Coins.',
  updated_at = NOW()
WHERE id = 'diamond_1500';

UPDATE diamond_packages
SET
  name = '3.250 Coins',
  description = 'Paket Sultan! Dapatkan 2.500 + Bonus 750 Coins.',
  updated_at = NOW()
WHERE id = 'diamond_3250';

