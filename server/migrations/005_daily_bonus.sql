-- Migrasi 005: tanggal (WIB, YYYY-MM-DD) terakhir pemain menerima bonus harian
ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS last_daily_bonus TEXT;
