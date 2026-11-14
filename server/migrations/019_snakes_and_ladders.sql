-- Migrasi 019: Snakes and Ladders / Ular Tangga (game keempat di ekosistem PlayGo)
-- Menyediakan tabel generik game_rooms, game_room_players, game_matchmaking_queue, dan game_match_history
-- sesuai spesifikasi arsitektur PlayGo. Mendukung manusia (user_id) maupun bot (user_id NULL, bot_id).

-- 1. Tabel Room Permainan (game_rooms)
CREATE TABLE IF NOT EXISTS game_rooms (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL DEFAULT 'snakes-and-ladders',
  room_code TEXT NOT NULL UNIQUE,
  room_type TEXT NOT NULL DEFAULT 'quick' CHECK (room_type IN ('quick', 'private', 'group')),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'playing', 'finished', 'cancelled')),
  current_turn TEXT,
  winner_player_id TEXT,
  game_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at BIGINT,
  finished_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS game_rooms_game_status_idx
  ON game_rooms (game_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS game_rooms_room_code_idx
  ON game_rooms (room_code);

-- 2. Tabel Pemain di Dalam Room (game_room_players)
-- user_id boleh NULL untuk bot (player_type = 'bot'), sehingga bot tidak pernah dibuat sebagai akun palsu di tabel users.
CREATE TABLE IF NOT EXISTS game_room_players (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES game_rooms(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  bot_id TEXT,
  player_type TEXT NOT NULL CHECK (player_type IN ('human', 'bot')),
  display_name TEXT NOT NULL,
  avatar TEXT,
  player_order INTEGER NOT NULL CHECK (player_order >= 0),
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0 AND position <= 100),
  color TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disconnected', 'left')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CHECK (
    (player_type = 'human') OR
    (player_type = 'bot' AND user_id IS NULL AND bot_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS game_room_players_room_idx
  ON game_room_players (room_id, player_order ASC);

CREATE INDEX IF NOT EXISTS game_room_players_user_idx
  ON game_room_players (user_id, status);

-- 3. Tabel Antrean Matchmaking (game_matchmaking_queue)
CREATE TABLE IF NOT EXISTS game_matchmaking_queue (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL DEFAULT 'snakes-and-ladders',
  status TEXT NOT NULL DEFAULT 'searching' CHECK (status IN ('searching', 'matched', 'bot_fallback', 'cancelled', 'expired')),
  queued_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS game_matchmaking_queue_search_idx
  ON game_matchmaking_queue (game_id, status, queued_at ASC);

CREATE INDEX IF NOT EXISTS game_matchmaking_queue_user_idx
  ON game_matchmaking_queue (user_id, game_id, status);

-- 4. Tabel Riwayat Pertandingan (game_match_history)
-- Mencatat hasil per pemain manusia dengan pembedaan tegas antara opponent_type = 'human' dan 'bot'.
CREATE TABLE IF NOT EXISTS game_match_history (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES game_rooms(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL DEFAULT 'snakes-and-ladders',
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opponent_type TEXT NOT NULL CHECK (opponent_type IN ('human', 'bot')),
  opponent_name TEXT,
  result TEXT NOT NULL CHECK (result IN ('win', 'loss', 'abandoned')),
  duration INTEGER NOT NULL DEFAULT 0 CHECK (duration >= 0),
  total_turns INTEGER NOT NULL DEFAULT 0 CHECK (total_turns >= 0),
  reward_coins INTEGER NOT NULL DEFAULT 0 CHECK (reward_coins >= 0),
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS game_match_history_user_game_idx
  ON game_match_history (user_id, game_id, created_at DESC);

CREATE INDEX IF NOT EXISTS game_match_history_leaderboard_idx
  ON game_match_history (game_id, opponent_type, result);

