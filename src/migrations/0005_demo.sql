-- Public demo accounts ("Try the demo"): flagged so they can be cleaned up and left out of backups.
ALTER TABLE users ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;
