-- Every new agent starts on Google Gemini Live (2026-11-22): Gemini 3.8 Live
-- speaking in Zephyr. Needs 20261122000000_gemini_live_voice first (its CHECKs
-- accept these values). Existing agents keep whatever they have saved.

ALTER TABLE "agents" ALTER COLUMN "voice_openai_realtime_model" SET DEFAULT 'gemini-3.8-live';
ALTER TABLE "agents" ALTER COLUMN "voice_openai_voice_id" SET DEFAULT 'zephyr';
ALTER TABLE "agents" ALTER COLUMN "voice_openai_voice_name" SET DEFAULT 'Zephyr';
