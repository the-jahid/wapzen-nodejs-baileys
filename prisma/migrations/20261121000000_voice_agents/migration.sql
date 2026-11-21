-- The Go voice server (server/) now uses this database too, and this schema is
-- the only one: the Go server no longer runs its own goose migrations. This
-- adds the tables it needs, copied from its goose chain (00001–00062).
--
-- Voice is kept wholly apart from chat. Every table here is the voice
-- server's own, and the only thing it shares with chat is users.id: no voice
-- table references a chat table (phone_numbers, whatsapp_auth, tools,
-- knowledge_bases, chat_*), and nothing here alters one. Where chat has a
-- table of the same kind, voice has its own copy:
--
--   voice_phone_numbers           WhatsApp numbers paired by QR / pairing code
--                                 through whatsmeow (chat's phone_numbers are
--                                 Baileys logins with keys in whatsapp_auth)
--   voice_tools                   tools a voice agent can call mid-call
--   voice_knowledge_bases         knowledge bases a voice agent answers from
--   voice_knowledge_base_sources  their sources
--
-- The whatsmeow session itself (device, keys, sessions) lives in whatsmeow's
-- own whatsmeow_* tables, which whatsmeow creates and versions itself, so they
-- are not here; voice_phone_numbers.wa_jid is the whatsmeow_device.jid of the
-- paired companion. meowcaller (the calling layer on top of whatsmeow) keeps
-- no tables of its own.
--
-- Additive only, and every statement is IF NOT EXISTS / OR REPLACE, so it is
-- safe while the previous instance still serves.

-- Voice WhatsApp numbers. A row is written only once a scan has paired a
-- whatsmeow device (an unscanned QR is not a number); wa_jid is that device.
CREATE TABLE IF NOT EXISTS "voice_phone_numbers" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "phone_number" TEXT,
    "label" TEXT,
    "wa_jid" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending_qr',
    "qr_code" TEXT,
    "last_connected_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "voice_phone_numbers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "voice_phone_numbers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "voice_phone_numbers_status_check" CHECK ("status" IN ('pending_qr', 'connected', 'disconnected')),
    CONSTRAINT "voice_phone_numbers_phone_number_check" CHECK ("phone_number" IS NULL OR "phone_number" ~ '^\+[1-9][0-9]{1,14}$'),
    CONSTRAINT "voice_phone_numbers_label_check" CHECK ("label" IS NULL OR char_length("label") <= 80)
);
CREATE UNIQUE INDEX IF NOT EXISTS "voice_phone_numbers_wa_jid_key" ON "voice_phone_numbers"("wa_jid");
CREATE UNIQUE INDEX IF NOT EXISTS "voice_phone_numbers_user_id_phone_number_key" ON "voice_phone_numbers"("user_id", "phone_number");
CREATE INDEX IF NOT EXISTS "voice_phone_numbers_user_id_idx" ON "voice_phone_numbers"("user_id");
CREATE INDEX IF NOT EXISTS "voice_phone_numbers_status_idx" ON "voice_phone_numbers"("status");

-- Voice agents. Every column, default and CHECK as the Go server has them.
CREATE TABLE IF NOT EXISTS "agents" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "agent_name" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en-US',
    "timezone" TEXT,
    "call_direction" TEXT NOT NULL DEFAULT 'outbound',
    "status" TEXT NOT NULL DEFAULT 'active',
    "model_provider" TEXT NOT NULL DEFAULT 'openai',
    "model_name" TEXT NOT NULL DEFAULT 'gpt-4.1-mini',
    "model_temperature" DOUBLE PRECISION DEFAULT 0.3,
    "prompt_begin_message_mode" TEXT NOT NULL DEFAULT 'agent_speaks_first',
    "prompt_begin_message" TEXT DEFAULT 'Hello! How can I help you today?',
    "prompt_begin_message_delay_ms" INTEGER DEFAULT 1000,
    "prompt_system_prompt" TEXT DEFAULT 'You are a helpful, friendly voice assistant on a phone call. Keep responses clear and concise, speak naturally, and stay polite and professional at all times.',
    "voice_provider" TEXT DEFAULT 'openai_realtime',
    "voice_elevenlabs_voice_id" TEXT NOT NULL DEFAULT 'DODLEQrClDo8wCz460ld',
    "voice_elevenlabs_voice_name" TEXT NOT NULL DEFAULT 'Lauren',
    "voice_elevenlabs_voice_model" TEXT NOT NULL DEFAULT 'eleven_flash_v2_5',
    "voice_openai_voice_id" TEXT NOT NULL DEFAULT 'alloy',
    "voice_openai_voice_name" TEXT NOT NULL DEFAULT 'Alloy',
    "voice_openai_voice_model" TEXT NOT NULL DEFAULT 'tts-1',
    "voice_openai_instructions" TEXT,
    "transcriber_provider" TEXT NOT NULL DEFAULT 'openai',
    "transcriber_language" TEXT NOT NULL DEFAULT 'en',
    "transcriber_openai_model" TEXT NOT NULL DEFAULT 'gpt-4o-transcribe',
    "transcriber_elevenlabs_model" TEXT NOT NULL DEFAULT 'scribe_v1',
    "post_call_analysis_provider" TEXT NOT NULL DEFAULT 'openai',
    "post_call_analysis_model" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "phone_number_id" TEXT,
    "voice_openai_speed" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "voice_openai_volume" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "voice_openai_realtime_model" TEXT NOT NULL DEFAULT 'gpt-realtime-2.1-mini',
    CONSTRAINT "agents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agents_user_id_agent_name_key" UNIQUE ("user_id", "agent_name"),
    CONSTRAINT "agents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "agents_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "voice_phone_numbers"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "agents_call_direction_check" CHECK ("call_direction" IN ('inbound', 'outbound', 'both')),
    CONSTRAINT "agents_model_provider_check" CHECK ("model_provider" IN ('openai', 'anthropic')),
    CONSTRAINT "agents_model_temperature_check" CHECK ("model_temperature" >= 0.1 AND "model_temperature" <= 1),
    CONSTRAINT "agents_post_call_analysis_provider_check" CHECK ("post_call_analysis_provider" IN ('openai', 'anthropic')),
    CONSTRAINT "agents_prompt_begin_message_delay_ms_check" CHECK ("prompt_begin_message_delay_ms" >= 0 AND "prompt_begin_message_delay_ms" <= 5000),
    CONSTRAINT "agents_prompt_begin_message_mode_check" CHECK ("prompt_begin_message_mode" IN ('agent_speaks_first', 'agent_waits_for_user', 'agent_speaks_first_with_model_generated_message')),
    CONSTRAINT "agents_status_check" CHECK ("status" IN ('active', 'inactive')),
    CONSTRAINT "agents_transcriber_elevenlabs_model_check" CHECK ("transcriber_elevenlabs_model" IN ('scribe_v1', 'scribe_v2', 'scribe_v2_realtime')),
    CONSTRAINT "agents_transcriber_openai_model_check" CHECK ("transcriber_openai_model" IN ('gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe-diarize', 'whisper-1')),
    CONSTRAINT "agents_transcriber_provider_check" CHECK ("transcriber_provider" IN ('openai', '11labs')),
    CONSTRAINT "agents_voice_elevenlabs_voice_model_check" CHECK ("voice_elevenlabs_voice_model" IN ('eleven_multilingual_v2', 'eleven_turbo_v2', 'eleven_turbo_v2_5', 'eleven_flash_v2', 'eleven_flash_v2_5', 'eleven_monolingual_v1', 'eleven_v3')),
    CONSTRAINT "agents_voice_openai_realtime_model_check" CHECK ("voice_openai_realtime_model" IN ('gpt-realtime', 'gpt-realtime-1.5', 'gpt-realtime-mini', 'gpt-realtime-2', 'gpt-realtime-2.1', 'gpt-realtime-2.1-mini')),
    CONSTRAINT "agents_voice_openai_speed_check" CHECK ("voice_openai_speed" >= 0.25 AND "voice_openai_speed" <= 1.5),
    CONSTRAINT "agents_voice_openai_voice_id_check" CHECK ("voice_openai_voice_id" IN ('alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar', 'fable', 'nova', 'onyx')),
    CONSTRAINT "agents_voice_openai_voice_model_check" CHECK ("voice_openai_voice_model" IN ('tts-1', 'tts-1-hd', 'gpt-4o-mini-tts')),
    CONSTRAINT "agents_voice_openai_volume_check" CHECK ("voice_openai_volume" >= 0 AND "voice_openai_volume" <= 2),
    CONSTRAINT "agents_voice_provider_check" CHECK ("voice_provider" IN ('openai_realtime', 'openai', '11labs'))
);
CREATE INDEX IF NOT EXISTS "idx_agents_user_id" ON "agents"("user_id");
CREATE INDEX IF NOT EXISTS "idx_agents_phone_number_id" ON "agents"("phone_number_id") WHERE "phone_number_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_agents_phone_number_direction" ON "agents"("phone_number_id", "call_direction") WHERE "phone_number_id" IS NOT NULL;

-- Go migration 00061 (maintenance pause, still in force): every voice agent is
-- kept inactive at the database, whatever the API writes.
CREATE OR REPLACE FUNCTION force_agent_paused() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	NEW.status := 'inactive';
	RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "agents_force_paused" ON "agents";
CREATE TRIGGER "agents_force_paused" BEFORE INSERT OR UPDATE ON "agents"
    FOR EACH ROW EXECUTE FUNCTION force_agent_paused();

-- Voice tools: an action a voice agent can take mid-call. Shared between the
-- owner's voice agents through agent_tools; the type's settings are one JSON
-- block in config, replaced wholesale on update.
CREATE TABLE IF NOT EXISTS "voice_tools" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "voice_tools_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "voice_tools_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "voice_tools_type_check" CHECK ("type" IN ('api_request', 'transfer_call', 'end_call', 'send_text')),
    CONSTRAINT "voice_tools_tool_name_check" CHECK ("tool_name" ~ '^[a-z][a-z0-9_]{0,63}$'),
    CONSTRAINT "voice_tools_description_check" CHECK (char_length("description") BETWEEN 1 AND 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS "voice_tools_user_id_tool_name_key" ON "voice_tools"("user_id", "tool_name");
CREATE INDEX IF NOT EXISTS "voice_tools_user_id_idx" ON "voice_tools"("user_id");

-- Which voice tools a voice agent offers.
CREATE TABLE IF NOT EXISTS "agent_tools" (
    "agent_id" TEXT NOT NULL,
    "tool_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "agent_tools_pkey" PRIMARY KEY ("agent_id", "tool_id"),
    CONSTRAINT "agent_tools_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "agent_tools_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "voice_tools"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_agent_tools_tool_id" ON "agent_tools"("tool_id");

-- Voice knowledge bases. Each is attached to at most one voice agent through
-- agent_id, and has its own vector-store namespace ('kb_' + id without
-- dashes). Deleting the agent detaches its knowledge bases rather than
-- deleting them, so their indexed sources are never orphaned in the vector
-- store.
CREATE TABLE IF NOT EXISTS "voice_knowledge_bases" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "agent_id" TEXT,
    "knowledge_base_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "enable_auto_refresh" BOOLEAN NOT NULL DEFAULT false,
    "last_refreshed_at" TIMESTAMPTZ,
    "max_chunk_size" INTEGER NOT NULL DEFAULT 2000,
    "min_chunk_size" INTEGER NOT NULL DEFAULT 400,
    "pinecone_namespace" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "voice_knowledge_bases_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "voice_knowledge_bases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "voice_knowledge_bases_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "voice_knowledge_bases_name_check" CHECK (char_length("knowledge_base_name") BETWEEN 1 AND 40),
    CONSTRAINT "voice_knowledge_bases_status_check" CHECK ("status" IN ('in_progress', 'complete', 'error', 'refreshing_in_progress')),
    CONSTRAINT "voice_knowledge_bases_max_chunk_size_check" CHECK ("max_chunk_size" BETWEEN 600 AND 6000),
    CONSTRAINT "voice_knowledge_bases_min_chunk_size_check" CHECK ("min_chunk_size" BETWEEN 200 AND 2000),
    CONSTRAINT "voice_knowledge_bases_chunk_size_order_check" CHECK ("min_chunk_size" <= "max_chunk_size")
);
CREATE UNIQUE INDEX IF NOT EXISTS "voice_knowledge_bases_user_id_knowledge_base_name_key" ON "voice_knowledge_bases"("user_id", "knowledge_base_name");
CREATE UNIQUE INDEX IF NOT EXISTS "voice_knowledge_bases_pinecone_namespace_key" ON "voice_knowledge_bases"("pinecone_namespace");
CREATE INDEX IF NOT EXISTS "voice_knowledge_bases_user_id_idx" ON "voice_knowledge_bases"("user_id");
CREATE INDEX IF NOT EXISTS "voice_knowledge_bases_agent_id_idx" ON "voice_knowledge_bases"("agent_id") WHERE "agent_id" IS NOT NULL;

-- A voice knowledge base's sources. The title is the source's vector record
-- id, hence unique per knowledge base; content is kept to re-chunk later.
CREATE TABLE IF NOT EXISTS "voice_knowledge_base_sources" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "knowledge_base_id" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'text',
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "voice_knowledge_base_sources_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "voice_knowledge_base_sources_knowledge_base_id_fkey" FOREIGN KEY ("knowledge_base_id") REFERENCES "voice_knowledge_bases"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "voice_knowledge_base_sources_type_check" CHECK ("type" IN ('text', 'file')),
    CONSTRAINT "voice_knowledge_base_sources_title_check" CHECK (char_length("title") BETWEEN 1 AND 200),
    CONSTRAINT "voice_knowledge_base_sources_content_check" CHECK (char_length("content") > 0),
    CONSTRAINT "voice_knowledge_base_sources_chunk_count_check" CHECK ("chunk_count" >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "voice_knowledge_base_sources_knowledge_base_id_title_key" ON "voice_knowledge_base_sources"("knowledge_base_id", "title");
CREATE INDEX IF NOT EXISTS "voice_knowledge_base_sources_knowledge_base_id_created_at_idx" ON "voice_knowledge_base_sources"("knowledge_base_id", "created_at");

-- Public API keys.
CREATE TABLE IF NOT EXISTS "api_keys" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Default',
    "key_hash" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "last_used_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "api_keys_key_hash_key" UNIQUE ("key_hash"),
    CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "api_keys_name_check" CHECK (char_length(btrim("name")) > 0 AND char_length("name") <= 80)
);
CREATE INDEX IF NOT EXISTS "idx_api_keys_user_id" ON "api_keys"("user_id");
CREATE INDEX IF NOT EXISTS "idx_api_keys_user_active" ON "api_keys"("user_id", "created_at" DESC) WHERE "revoked_at" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "idx_api_keys_one_active_default_per_user" ON "api_keys"("user_id") WHERE "revoked_at" IS NULL AND "is_default";

-- Outbound campaigns and their leads.
CREATE TABLE IF NOT EXISTS "outbound_campaigns" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "campaign_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "leads_count" INTEGER NOT NULL DEFAULT 0,
    "calls_placed" INTEGER NOT NULL DEFAULT 0,
    "answered_calls" INTEGER NOT NULL DEFAULT 0,
    "successful_calls" INTEGER NOT NULL DEFAULT 0,
    "today_calls" INTEGER NOT NULL DEFAULT 0,
    "total_usage_seconds" INTEGER NOT NULL DEFAULT 0,
    "budget_usd" NUMERIC(12,2),
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "agent_id" TEXT,
    CONSTRAINT "outbound_campaigns_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "outbound_campaigns_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "outbound_campaigns_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "outbound_campaigns_answered_calls_check" CHECK ("answered_calls" >= 0),
    CONSTRAINT "outbound_campaigns_budget_usd_check" CHECK ("budget_usd" IS NULL OR "budget_usd" >= 0),
    CONSTRAINT "outbound_campaigns_calls_placed_check" CHECK ("calls_placed" >= 0),
    CONSTRAINT "outbound_campaigns_campaign_name_check" CHECK (char_length("campaign_name") >= 1 AND char_length("campaign_name") <= 80),
    CONSTRAINT "outbound_campaigns_check" CHECK ("answered_calls" <= "calls_placed"),
    CONSTRAINT "outbound_campaigns_check1" CHECK ("successful_calls" <= "calls_placed"),
    CONSTRAINT "outbound_campaigns_leads_count_check" CHECK ("leads_count" >= 0),
    CONSTRAINT "outbound_campaigns_status_check" CHECK ("status" IN ('draft', 'running', 'paused', 'completed', 'failed')),
    CONSTRAINT "outbound_campaigns_successful_calls_check" CHECK ("successful_calls" >= 0),
    CONSTRAINT "outbound_campaigns_today_calls_check" CHECK ("today_calls" >= 0),
    CONSTRAINT "outbound_campaigns_total_usage_seconds_check" CHECK ("total_usage_seconds" >= 0)
);
CREATE INDEX IF NOT EXISTS "idx_outbound_campaigns_user_id" ON "outbound_campaigns"("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_outbound_campaigns_user_name_unique" ON "outbound_campaigns"("user_id", "campaign_name");
CREATE INDEX IF NOT EXISTS "idx_outbound_campaigns_agent_id" ON "outbound_campaigns"("agent_id") WHERE "agent_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "campaign_leads" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "campaign_id" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "email" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "campaign_leads_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "campaign_leads_campaign_id_phone_number_key" UNIQUE ("campaign_id", "phone_number"),
    CONSTRAINT "campaign_leads_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "outbound_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "campaign_leads_attempts_check" CHECK ("attempts" >= 0),
    CONSTRAINT "campaign_leads_first_name_check" CHECK ("first_name" IS NULL OR char_length("first_name") <= 80),
    CONSTRAINT "campaign_leads_last_name_check" CHECK ("last_name" IS NULL OR char_length("last_name") <= 80),
    CONSTRAINT "campaign_leads_phone_number_check" CHECK ("phone_number" ~ '^\+[1-9][0-9]{7,14}$'),
    CONSTRAINT "campaign_leads_status_check" CHECK ("status" IN ('pending', 'calling', 'called', 'failed'))
);
CREATE INDEX IF NOT EXISTS "idx_campaign_leads_campaign_id" ON "campaign_leads"("campaign_id");
CREATE INDEX IF NOT EXISTS "idx_campaign_leads_campaign_status" ON "campaign_leads"("campaign_id", "status");

-- Calls and their transcripts.
CREATE TABLE IF NOT EXISTS "calls" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "call_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "phone_number_id" TEXT,
    "peer" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "end_reason" TEXT,
    "answered_at" TIMESTAMPTZ,
    "ended_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "call_type" TEXT NOT NULL DEFAULT 'inbound',
    "agent_id" TEXT,
    "duration_seconds" INTEGER,
    "campaign_id" TEXT,
    "lead_id" TEXT,
    CONSTRAINT "calls_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "calls_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "calls_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "voice_phone_numbers"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "calls_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "calls_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "outbound_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "calls_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "campaign_leads"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "calls_call_type_check" CHECK ("call_type" IN ('inbound', 'outbound')),
    CONSTRAINT "calls_duration_seconds_check" CHECK ("duration_seconds" IS NULL OR "duration_seconds" >= 0),
    CONSTRAINT "calls_status_check" CHECK ("status" IN ('received', 'answered', 'ended', 'declined', 'failed'))
);
CREATE INDEX IF NOT EXISTS "idx_calls_call_id" ON "calls"("call_id");
CREATE INDEX IF NOT EXISTS "idx_calls_user_id" ON "calls"("user_id");
CREATE INDEX IF NOT EXISTS "idx_calls_phone_number_id" ON "calls"("phone_number_id");
CREATE INDEX IF NOT EXISTS "idx_calls_agent_id" ON "calls"("agent_id") WHERE "agent_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_calls_campaign_created" ON "calls"("campaign_id", "created_at" DESC) WHERE "campaign_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_calls_lead_id" ON "calls"("lead_id") WHERE "lead_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "call_messages" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "call_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "call_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "call_messages_call_id_seq_key" UNIQUE ("call_id", "seq"),
    CONSTRAINT "call_messages_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "call_messages_role_check" CHECK ("role" IN ('user', 'assistant')),
    CONSTRAINT "call_messages_seq_check" CHECK ("seq" >= 0)
);

-- Campaign counters follow their leads and calls (Go migrations 00038–00040).
CREATE OR REPLACE FUNCTION sync_outbound_campaign_leads_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		UPDATE outbound_campaigns SET leads_count = leads_count + 1, updated_at = now() WHERE id = NEW.campaign_id;
	ELSIF TG_OP = 'DELETE' THEN
		UPDATE outbound_campaigns SET leads_count = GREATEST(leads_count - 1, 0), updated_at = now() WHERE id = OLD.campaign_id;
	ELSIF NEW.campaign_id IS DISTINCT FROM OLD.campaign_id THEN
		UPDATE outbound_campaigns SET leads_count = GREATEST(leads_count - 1, 0), updated_at = now() WHERE id = OLD.campaign_id;
		UPDATE outbound_campaigns SET leads_count = leads_count + 1, updated_at = now() WHERE id = NEW.campaign_id;
	END IF;
	-- This is an AFTER trigger, so its return value is ignored.
	RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS "campaign_leads_sync_count" ON "campaign_leads";
CREATE TRIGGER "campaign_leads_sync_count" AFTER INSERT OR DELETE OR UPDATE OF "campaign_id" ON "campaign_leads"
    FOR EACH ROW EXECUTE FUNCTION sync_outbound_campaign_leads_count();

CREATE OR REPLACE FUNCTION sync_campaign_call_progress() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.campaign_id IS NOT NULL THEN
			UPDATE outbound_campaigns
			SET calls_placed = calls_placed + 1,
				today_calls = (
					SELECT count(*)::integer
					FROM calls
					WHERE campaign_id = NEW.campaign_id
						AND created_at >= current_date
						AND created_at < current_date + interval '1 day'
				),
				updated_at = now()
			WHERE id = NEW.campaign_id;
		END IF;
		IF NEW.lead_id IS NOT NULL THEN
			UPDATE campaign_leads
			SET attempts = attempts + 1,
				last_attempted_at = now(),
				status = 'calling',
				updated_at = now()
			WHERE id = NEW.lead_id;
		END IF;
		RETURN NULL;
	END IF;
	IF NEW.campaign_id IS NOT NULL THEN
		UPDATE outbound_campaigns
		SET answered_calls = answered_calls
				+ CASE WHEN NEW.status = 'answered' THEN 1 ELSE 0 END,
			successful_calls = successful_calls
				+ CASE WHEN NEW.status = 'ended' AND NEW.answered_at IS NOT NULL THEN 1 ELSE 0 END,
			total_usage_seconds = total_usage_seconds
				+ CASE WHEN NEW.status = 'ended' THEN COALESCE(NEW.duration_seconds, 0) ELSE 0 END,
			updated_at = now()
		WHERE id = NEW.campaign_id;
	END IF;
	IF NEW.lead_id IS NOT NULL THEN
		UPDATE campaign_leads
		SET status = CASE
				WHEN NEW.status IN ('answered', 'ended') AND NEW.answered_at IS NOT NULL THEN 'called'
				WHEN NEW.status IN ('ended', 'declined', 'failed') THEN 'failed'
				ELSE status
			END,
			updated_at = now()
		WHERE id = NEW.lead_id;
	END IF;
	RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS "calls_sync_campaign_progress_insert" ON "calls";
CREATE TRIGGER "calls_sync_campaign_progress_insert" AFTER INSERT ON "calls"
    FOR EACH ROW WHEN (NEW.campaign_id IS NOT NULL OR NEW.lead_id IS NOT NULL)
    EXECUTE FUNCTION sync_campaign_call_progress();
DROP TRIGGER IF EXISTS "calls_sync_campaign_progress_update" ON "calls";
CREATE TRIGGER "calls_sync_campaign_progress_update" AFTER UPDATE OF "status" ON "calls"
    FOR EACH ROW WHEN ((NEW.campaign_id IS NOT NULL OR NEW.lead_id IS NOT NULL) AND NEW.status IS DISTINCT FROM OLD.status)
    EXECUTE FUNCTION sync_campaign_call_progress();

-- The Go server's activity log (sign-ins, QR outcomes) and QR scan attempts.
CREATE TABLE IF NOT EXISTS "activity_logs" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "detail" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "activity_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "activity_logs_event_check" CHECK (char_length("event") > 0)
);
CREATE INDEX IF NOT EXISTS "idx_activity_logs_user_created" ON "activity_logs"("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_activity_logs_event_created" ON "activity_logs"("event", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "qr_scan_attempts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone_number_id" TEXT,
    "agent_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'started',
    "phone_number" TEXT,
    "failure_reason" TEXT,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "finished_at" TIMESTAMPTZ,
    "method" TEXT NOT NULL DEFAULT 'qr',
    "user_agent" TEXT,
    CONSTRAINT "qr_scan_attempts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "qr_scan_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "qr_scan_attempts_method_check" CHECK ("method" IN ('qr', 'phone_code')),
    CONSTRAINT "qr_scan_attempts_status_check" CHECK ("status" IN ('started', 'worked', 'failed', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS "idx_qr_scan_attempts_user_started" ON "qr_scan_attempts"("user_id", "started_at" DESC);

CREATE OR REPLACE VIEW "qr_scan_attempt_summary" AS
 SELECT user_id,
    max(email) AS email,
    count(*) AS attempts,
    count(*) FILTER (WHERE status = 'worked') AS worked,
    count(*) FILTER (WHERE status = 'failed') AS failed,
    count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
    count(*) FILTER (WHERE status = 'started') AS no_outcome,
    min(started_at) AS first_attempt_at,
    max(started_at) AS last_attempt_at
   FROM qr_scan_attempts
  GROUP BY user_id;
