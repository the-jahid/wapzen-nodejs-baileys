-- Voice agents run on OpenAI Realtime only (2026-11-21). The request-based
-- OpenAI pipeline (transcriber -> text model -> text-to-speech) and the
-- ElevenLabs pipeline are gone from the Go server and the dashboard, so the
-- agent columns only they read are dropped:
--
--   model_provider, model_name, model_temperature     their text model
--   voice_provider                                    the engine choice
--   voice_elevenlabs_voice_id/_name/_model            ElevenLabs voice
--   voice_openai_voice_model, voice_openai_instructions  OpenAI text-to-speech
--   transcriber_provider/_language/_openai_model/_elevenlabs_model
--
-- Kept: voice_openai_voice_id/_name, voice_openai_realtime_model and
-- voice_openai_speed/_volume, which the Realtime session uses. Dropping a column
-- also drops the CHECK constraints on it.

-- Three text-to-speech voices are not Realtime voices. Move any agent on one to
-- the Realtime voice the Go server already substituted for it on calls, before
-- the voice CHECK narrows.
UPDATE "agents" SET "voice_openai_voice_id" = 'ballad',  "voice_openai_voice_name" = 'Ballad'  WHERE "voice_openai_voice_id" = 'fable';
UPDATE "agents" SET "voice_openai_voice_id" = 'shimmer', "voice_openai_voice_name" = 'Shimmer' WHERE "voice_openai_voice_id" = 'nova';
UPDATE "agents" SET "voice_openai_voice_id" = 'ash',     "voice_openai_voice_name" = 'Ash'     WHERE "voice_openai_voice_id" = 'onyx';

ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_voice_openai_voice_id_check";
ALTER TABLE "agents" ADD CONSTRAINT "agents_voice_openai_voice_id_check"
    CHECK ("voice_openai_voice_id" IN ('alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'));

ALTER TABLE "agents"
    DROP COLUMN IF EXISTS "model_provider",
    DROP COLUMN IF EXISTS "model_name",
    DROP COLUMN IF EXISTS "model_temperature",
    DROP COLUMN IF EXISTS "voice_provider",
    DROP COLUMN IF EXISTS "voice_elevenlabs_voice_id",
    DROP COLUMN IF EXISTS "voice_elevenlabs_voice_name",
    DROP COLUMN IF EXISTS "voice_elevenlabs_voice_model",
    DROP COLUMN IF EXISTS "voice_openai_voice_model",
    DROP COLUMN IF EXISTS "voice_openai_instructions",
    DROP COLUMN IF EXISTS "transcriber_provider",
    DROP COLUMN IF EXISTS "transcriber_language",
    DROP COLUMN IF EXISTS "transcriber_openai_model",
    DROP COLUMN IF EXISTS "transcriber_elevenlabs_model";
