-- Migrasi 025: Normalisasi email dan buat unique index case-insensitive pada users(LOWER(email))
UPDATE users
SET email = NULL
WHERE email IS NOT NULL AND BTRIM(email) = '';

UPDATE users
SET email = LOWER(BTRIM(email))
WHERE email IS NOT NULL AND email <> LOWER(BTRIM(email));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT LOWER(email)
    FROM users
    WHERE email IS NOT NULL
    GROUP BY LOWER(email)
    HAVING COUNT(*) > 1
  ) THEN
    DROP INDEX IF EXISTS users_email_lower_idx;
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique_idx
      ON users (LOWER(email))
      WHERE email IS NOT NULL;
  END IF;
END $$;
