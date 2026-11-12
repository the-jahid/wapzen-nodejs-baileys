-- Lets one account hold more chat agents than the default
-- MAX_CHAT_AGENTS_PER_USER, set by hand
-- (UPDATE users SET max_chat_agents = 2 WHERE email = ...). Null = the default.
--
-- Safe while the previous instance still serves: it never reads this column.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "max_chat_agents" INTEGER;
