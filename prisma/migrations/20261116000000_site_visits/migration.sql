-- Website visitors for the public /status page: one row per visitor per day.
-- A visitor is a hash the website makes from the day, IP address and browser,
-- so the same person visiting ten times in a day is one row, and the next day
-- is a new one. No IP address or browser string is stored. Days are Bangladesh
-- days (Asia/Dhaka), like every other per-day count.
--
-- Safe while the previous instance still serves (see src/migrate.ts): a new
-- table it never reads or writes. IF NOT EXISTS so it can be added ahead of
-- the deploy.
CREATE TABLE IF NOT EXISTS "site_visits" (
  "day"          DATE        NOT NULL,
  "visitor_hash" TEXT        NOT NULL,
  -- ISO 3166-1 alpha-2 (BD, IN, ...); NULL when the country is unknown.
  "country"      TEXT,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "site_visits_pkey" PRIMARY KEY ("day", "visitor_hash"),
  CONSTRAINT "site_visits_country_check" CHECK ("country" ~ '^[A-Z]{2}$')
);
