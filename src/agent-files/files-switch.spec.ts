import type { ConfigService } from '@nestjs/config';
import { parseInput, validateUpdate } from '../chat-agents/chat-agents.types';
import type { IndexerService } from '../knowledge-bases/indexer.service';
import type { OrdersService } from '../orders/orders.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  ChatResponderService,
  type IncomingChat,
} from '../whatsapp/chat-responder.service';
import type { AgentFilesService } from './agent-files.service';

// The Images & Files switch: off, the agent is offered none of the files.

jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('../knowledge-bases/indexer.service', () => ({
  IndexerService: class {},
}));
jest.mock('../orders/orders.service', () => ({ OrdersService: class {} }));
jest.mock('../activity/activity');
// No language set: the reply language guard never rewrites here.
jest.mock('../whatsapp/reply-language', () => ({
  createLanguageGuard: () => ({
    languageOf: () => Promise.resolve(''),
    inLanguage: (text: string) => Promise.resolve({ text, rewritten: false }),
  }),
}));
jest.mock('../whatsapp/reply-agent', () => ({
  CHAT_REMEMBER_MESSAGES: 40,
  CHAT_SUMMARY_AT: 50,
  isChatSummary: () => false,
  createConfirmationCheck: () => () => Promise.resolve(undefined),
  createReplyAgent: () => ({}),
}));

describe('the Images & Files switch', () => {
  it('is accepted on the API as its own section', () => {
    const input = parseInput({ files: { files_enabled: false } });
    expect(input.files).toEqual({ files_enabled: false });
    expect(() => validateUpdate(input)).not.toThrow();
    expect(() => parseInput({ files: { files_enabled: 'no' } })).toThrow();
  });

  async function filesFor(filesEnabled: boolean | undefined) {
    const listForReply = jest.fn(() =>
      Promise.resolve([
        {
          id: 'f1',
          file_name: 'menu.pdf',
          mime_type: 'application/pdf',
          description: 'when asked for the menu',
        },
      ]),
    );
    const responder = new ChatResponderService(
      {} as PrismaService,
      { get: () => 'key' } as unknown as ConfigService,
      { enabled: false } as unknown as IndexerService,
      {} as OrdersService,
      { listForReply } as unknown as AgentFilesService,
    );
    const files = await (
      responder as unknown as {
        filesFor(a: unknown, c: IncomingChat): Promise<unknown[]>;
      }
    ).filesFor({ id: 'agent-1', filesEnabled }, {} as IncomingChat);
    return { files, listForReply };
  }

  it('offers no files when off, without even reading them', async () => {
    const { files, listForReply } = await filesFor(false);
    expect(files).toEqual([]);
    expect(listForReply).not.toHaveBeenCalled();
  });

  it('offers them when on, and on a row from before the switch', async () => {
    expect((await filesFor(true)).files).toHaveLength(1);
    expect((await filesFor(undefined)).files).toHaveLength(1);
  });
});
