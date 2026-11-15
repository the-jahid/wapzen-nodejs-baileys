import type { PrismaClient } from '../generated/prisma/client';
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_TEMPERATURE,
  freeTrialEnded,
  MAX_CHAT_AGENTS_PER_USER,
} from './chat-agents.types';

// The name a number's agent gets when linking it creates one. The owner can
// rename it later; a second one on the same account gets " 2", and so on.
export const AUTO_AGENT_NAME = 'WhatsApp Agent';

export type AutoAgentResult =
  | { kind: 'existing' | 'assigned' | 'created'; agentId: string }
  | { kind: 'at_limit' };

// Linking a number is all it takes to have an agent (user request 2026-11-15):
// there is no separate naming step. The number goes to an agent of the
// account's that has none yet; otherwise a new agent is made for it, as long
// as the account has room for one more. Either way the agent goes live, unless
// the free trial is over. Runs in one transaction with the user row locked,
// like a dashboard create, so two numbers linked at once can't both get past
// the agent limit.
export async function ensureAgentForNumber(
  prisma: PrismaClient,
  userId: string,
  phoneNumberId: string,
): Promise<AutoAgentResult> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${userId} FOR UPDATE`;

    const holder = await tx.chatAgent.findFirst({
      where: { phoneNumberId },
      select: { id: true },
    });
    if (holder) return { kind: 'existing', agentId: holder.id };

    const owner = await tx.user.findUnique({
      where: { id: userId },
      select: {
        maxChatAgents: true,
        noReplyLimitUntil: true,
        trialEndedAt: true,
      },
    });
    if (!owner) return { kind: 'at_limit' };
    const status = freeTrialEnded(owner) ? 'inactive' : 'active';

    const numberless = await tx.chatAgent.findFirst({
      where: { userId, phoneNumberId: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (numberless) {
      await tx.chatAgent.update({
        where: { id: numberless.id },
        data: { phoneNumberId, status },
      });
      return { kind: 'assigned', agentId: numberless.id };
    }

    const names = await tx.chatAgent.findMany({
      where: { userId },
      select: { agentName: true },
    });
    if (names.length >= (owner.maxChatAgents ?? MAX_CHAT_AGENTS_PER_USER)) {
      return { kind: 'at_limit' };
    }
    const taken = new Set(names.map((n) => n.agentName));
    let agentName = AUTO_AGENT_NAME;
    for (let i = 2; taken.has(agentName); i++) {
      agentName = `${AUTO_AGENT_NAME} ${i}`;
    }

    const row = await tx.chatAgent.create({
      data: {
        userId,
        agentName,
        phoneNumberId,
        status,
        modelProvider: DEFAULT_PROVIDER,
        modelName: DEFAULT_MODEL,
        temperature: DEFAULT_TEMPERATURE,
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
      },
      select: { id: true },
    });
    return { kind: 'created', agentId: row.id };
  });
}
