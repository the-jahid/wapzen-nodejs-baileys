import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_STATUS,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_TEMPERATURE,
} from './chat-agents.types';

const logger = new Logger('StarterAgent');

// createStarterAgent gives a brand-new account its first chat agent, named
// after the username or, without one, the email's local part, so the
// dashboard opens on an agent ready for a number instead of an empty list.
//
// Both sign-up paths call it — the Clerk webhook and the auth guard, whichever
// sees the user first — so it only creates when the account has no agent yet,
// under the same user-row lock agent creates take. A failure is logged and
// swallowed: the user can still create one by hand.
export async function createStarterAgent(
  prisma: PrismaService,
  userId: string,
  email: string,
  username: string | null,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${userId} FOR UPDATE`;
      if ((await tx.chatAgent.count({ where: { userId } })) > 0) return;
      await tx.chatAgent.create({
        data: {
          userId,
          agentName: starterAgentName(email, username),
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

// "jahid" -> "jahid's agent"; "jahid.hasan@gmail.com" -> "jahid.hasan's agent".
export function starterAgentName(
  email: string,
  username: string | null,
): string {
  const base = (username?.trim() || email.split('@')[0]?.trim() || '').slice(
    0,
    60,
  );
  return base ? `${base}'s agent` : 'My chat agent';
}
