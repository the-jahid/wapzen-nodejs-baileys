import { Logger } from '@nestjs/common';
import type { PrismaClient } from '../generated/prisma/client';
import { AUTO_AGENT_NAME } from './auto-agent';
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_STATUS,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_TEMPERATURE,
} from './chat-agents.types';

const logger = new Logger('StarterAgent');

// createStarterAgent gives a brand-new account its first chat agent (user
// request 2026-11-21), so the dashboard opens with an agent instead of a
// setup-only page. It has no number and stays inactive; linking a number later
// hands the number to it and takes it live (ensureAgentForNumber).
//
// Both sign-up paths call it — the Clerk webhook and the auth guard, whichever
// sees the user first — so it only creates when the account has no agent yet,
// under the same user-row lock agent creates take. A failure is logged and
// swallowed: linking a number still creates an agent.
export async function createStarterAgent(
  prisma: PrismaClient,
  userId: string,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${userId} FOR UPDATE`;
      if ((await tx.chatAgent.count({ where: { userId } })) > 0) return;
      await tx.chatAgent.create({
        data: {
          userId,
          agentName: AUTO_AGENT_NAME,
          status: DEFAULT_STATUS,
          modelProvider: DEFAULT_PROVIDER,
          modelName: DEFAULT_MODEL,
          temperature: DEFAULT_TEMPERATURE,
          systemPrompt: DEFAULT_SYSTEM_PROMPT,
        },
      });
    });
  } catch (err) {
    logger.error(
      `creating the starter agent for user ${userId} failed: ${(err as Error).message}`,
    );
  }
}
