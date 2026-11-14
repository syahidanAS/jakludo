-- Migrasi 018: Chess Master (game strategi ketiga di ekosistem PlayGo)
-- Semua tabel menggunakan prefix chess_ agar terpisah bersih dari JakLudo dan Monster Quiz Battle.
-- Tabel users PlayGo digunakan kembali melalui foreign key.

-- 1. Profil & Rating Elo pemain Chess Master (Default Rating = 1200)
CREATE TABLE IF NOT EXISTS chess_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL DEFAULT 1200 CHECK (rating >= 100),
  highest_rating INTEGER NOT NULL DEFAULT 1200 CHECK (highest_rating >= 100),
  total_games INTEGER NOT NULL DEFAULT 0 CHECK (total_games >= 0),
  wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
  losses INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),
  draws INTEGER NOT NULL DEFAULT 0 CHECK (draws >= 0),
  current_streak INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS chess_profiles_rating_idx
  ON chess_profiles (rating DESC, wins DESC, total_games DESC);

-- 2. Tabel Pertandingan Chess Master (menyimpan FEN, kontrol waktu, hasil, PGN, dan perubahan Elo)
CREATE TABLE IF NOT EXISTS chess_matches (
  id TEXT PRIMARY KEY,
  white_player_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  black_player_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  room_code TEXT,
  group_id TEXT,
  match_type TEXT NOT NULL DEFAULT 'quick' CHECK (match_type IN ('quick', 'private', 'rematch')),
  time_control TEXT NOT NULL DEFAULT '5+0',
  initial_fen TEXT NOT NULL,
  current_fen TEXT NOT NULL,
  current_turn TEXT NOT NULL DEFAULT 'w' CHECK (current_turn IN ('w', 'b')),
  white_remaining_time_ms INTEGER NOT NULL CHECK (white_remaining_time_ms >= 0),
  black_remaining_time_ms INTEGER NOT NULL CHECK (black_remaining_time_ms >= 0),
  increment_seconds INTEGER NOT NULL DEFAULT 0 CHECK (increment_seconds >= 0),
  last_move_at BIGINT,
  move_version INTEGER NOT NULL DEFAULT 0 CHECK (move_version >= 0),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'active', 'completed', 'cancelled')),
  result TEXT CHECK (result IN ('1-0', '0-1', '1/2-1/2', '*')),
  winner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  termination_reason TEXT,
  pgn TEXT,
  white_rating_before INTEGER,
  white_rating_after INTEGER,
  white_rating_change INTEGER DEFAULT 0,
  black_rating_before INTEGER,
  black_rating_after INTEGER,
  black_rating_change INTEGER DEFAULT 0,
  started_at BIGINT,
  finished_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS chess_matches_white_idx ON chess_matches (white_player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS chess_matches_black_idx ON chess_matches (black_player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS chess_matches_status_idx ON chess_matches (status);
CREATE INDEX IF NOT EXISTS chess_matches_room_code_idx ON chess_matches (room_code);

-- 3. Riwayat Langkah (Moves) per Pertandingan untuk Replay & PGN Export
CREATE TABLE IF NOT EXISTS chess_moves (
  id BIGSERIAL PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES chess_matches(id) ON DELETE CASCADE,
  move_number INTEGER NOT NULL CHECK (move_number > 0),
  player_id TEXT NOT NULL,
  color TEXT NOT NULL CHECK (color IN ('w', 'b')),
  from_square TEXT NOT NULL,
  to_square TEXT NOT NULL,
  promotion TEXT,
  piece TEXT,
  captured TEXT,
  flags TEXT,
  san TEXT NOT NULL,
  fen_after TEXT NOT NULL,
  elapsed_time_ms INTEGER NOT NULL DEFAULT 0 CHECK (elapsed_time_ms >= 0),
  white_remaining_ms INTEGER,
  black_remaining_ms INTEGER,
  created_at BIGINT NOT NULL,
  UNIQUE (match_id, move_number)
);

CREATE INDEX IF NOT EXISTS chess_moves_match_idx ON chess_moves (match_id, move_number ASC);

-- 4. Riwayat Perubahan Rating Elo Pemain
CREATE TABLE IF NOT EXISTS chess_rating_histories (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_id TEXT NOT NULL REFERENCES chess_matches(id) ON DELETE CASCADE,
  rating_before INTEGER NOT NULL,
  rating_after INTEGER NOT NULL,
  rating_change INTEGER NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS chess_rating_histories_user_idx
  ON chess_rating_histories (user_id, created_at DESC);

