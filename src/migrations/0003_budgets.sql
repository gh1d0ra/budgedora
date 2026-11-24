-- Per-month expected amounts (override the bucket's default monthly_budget for one month).
CREATE TABLE IF NOT EXISTS budgets (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bucket_id INTEGER NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  month TEXT NOT NULL,          -- YYYY-MM
  amount INTEGER NOT NULL,      -- cents (0 = nothing expected this month)
  PRIMARY KEY (user_id, bucket_id, month)
);
