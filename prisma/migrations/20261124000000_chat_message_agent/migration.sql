-- The chat agent each message was sent to or by. A thread belongs to the number
-- and outlives a change of agent, so an agent put on a number used to pick up
-- what an earlier (even deleted) agent had said there. No foreign key: a deleted
-- agent's messages keep its id, which no later agent ever has.

-- AlterTable
ALTER TABLE "chat_messages" ADD COLUMN "chat_agent_id" TEXT;
