-- Account lockout, soft delete and password reset (run once on databases created before v1.2).
ALTER TABLE users ADD COLUMN failed_logins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until INTEGER;
ALTER TABLE users ADD COLUMN deleted_at TEXT;
CREATE TABLE IF NOT EXISTS reset_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
