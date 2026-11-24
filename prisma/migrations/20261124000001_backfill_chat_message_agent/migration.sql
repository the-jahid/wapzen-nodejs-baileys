-- Messages saved before chat_agent_id go to the agent that answered their thread
-- last, so live agents keep their memory, except those older than that agent:
-- they can only be an earlier one's. Separate from the migration adding the
-- column, so its lock isn't held while this runs.
UPDATE chat_messages m
SET chat_agent_id = a.id
FROM chat_conversations c
JOIN chat_agents a ON a.id = c.chat_agent_id
WHERE m.conversation_id = c.id
  AND m.chat_agent_id IS NULL
  AND m.created_at >= a.created_at;
