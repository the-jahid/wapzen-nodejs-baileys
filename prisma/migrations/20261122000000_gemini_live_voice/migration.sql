-- Gemini Live joins OpenAI Realtime as a voice-call engine (2026-11-22). The Go
-- server picks the engine from the agent's realtime model: a model starting with
-- "gemini" runs on Google Gemini Live, everything else on OpenAI Realtime. No new
-- column is needed — the two CHECK lists just widen to take Gemini's models and
-- voices. Voice ids are stored lowercase, like the OpenAI ones.

ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_voice_openai_realtime_model_check";
ALTER TABLE "agents" ADD CONSTRAINT "agents_voice_openai_realtime_model_check"
    CHECK ("voice_openai_realtime_model" IN (
        'gpt-realtime', 'gpt-realtime-1.5', 'gpt-realtime-mini', 'gpt-realtime-2', 'gpt-realtime-2.1', 'gpt-realtime-2.1-mini',
        'gemini-3.1-flash-live-preview', 'gemini-3.8-live', 'gemini-2.5-flash-native-audio-latest'
    ));

ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_voice_openai_voice_id_check";
ALTER TABLE "agents" ADD CONSTRAINT "agents_voice_openai_voice_id_check"
    CHECK ("voice_openai_voice_id" IN (
        'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar',
        'puck', 'charon', 'kore', 'fenrir', 'aoede', 'leda', 'orus', 'zephyr'
    ));
