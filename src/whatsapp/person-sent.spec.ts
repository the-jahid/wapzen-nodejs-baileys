import type { ConfigService } from '@nestjs/config';
import type { IndexerService } from '../knowledge-bases/indexer.service';
import type { OrdersService } from '../orders/orders.service';
import type { PrismaService } from '../prisma/prisma.service';
import { ChatResponderService } from './chat-responder.service';

// Only what personSent touches is real; these modules don't load under Jest.
jest.mock('./reply-agent', () => ({}));
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('../knowledge-bases/indexer.service', () => ({
  IndexerService: class {},
}));
jest.mock('../orders/orders.service', () => ({ OrdersService: class {} }));

const SENT = {
  phoneNumberId: 'number-1',
  peerJids: ['111@lid'],
  peerJid: '111@lid',
  peerPhone: '+111',
  messageId: 'WA1',
  text: 'sent from the phone',
};

function setup(chatAgent: { id: string; status: string } | null) {
  const prisma = {
    phoneNumber: {
      findUnique: jest.fn().mockResolvedValue({ userId: 'user-1', chatAgent }),
    },
    chatConversation: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'thread-1', peerJid: '111@lid' }),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'thread-1', seq: 0 }]),
  };
  const responder = new ChatResponderService(
    prisma as unknown as PrismaService,
    { get: jest.fn() } as unknown as ConfigService,
    {} as IndexerService,
    {} as OrdersService,
  );
  return { prisma, responder };
}

describe('messages sent from the phone', () => {
  it.each([
    ['an inactive agent', { id: 'agent-1', status: 'inactive' }],
    ['no agent', null],
  ])('saves nothing on a number with %s', async (_name, chatAgent) => {
    const { prisma, responder } = setup(chatAgent);
    await responder.personSent(SENT);
    expect(prisma.chatConversation.findFirst).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('saves on the thread while the agent is active', async () => {
    const { prisma, responder } = setup({ id: 'agent-1', status: 'active' });
    await responder.personSent(SENT);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
