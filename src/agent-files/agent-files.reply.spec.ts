import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ConfigService } from '@nestjs/config';
import type { IndexerService } from '../knowledge-bases/indexer.service';
import type { OrdersService } from '../orders/orders.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ChatToolbox } from '../tools/chat-toolbox';
import {
  ChatResponderService,
  type IncomingChat,
} from '../whatsapp/chat-responder.service';
import type { AgentFilesService } from './agent-files.service';

// A whole reply with the model scripted: what the person receives, and what the
// thread and the agent's memory keep.

jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('../knowledge-bases/indexer.service', () => ({
  IndexerService: class {},
}));
jest.mock('../orders/orders.service', () => ({ OrdersService: class {} }));
jest.mock('../activity/activity');

// What the model does next: which file_ids it asks for, and the text it writes.
const script = { fileIds: [] as string[], text: '' };
const modelCalls: { prompt: string; messages: BaseMessage[] }[] = [];
jest.mock('../whatsapp/reply-agent', () => ({
  CHAT_REMEMBER_MESSAGES: 40,
  CHAT_SUMMARY_AT: 50,
  isChatSummary: () => false,
  createConfirmationCheck: () => () =>
    Promise.resolve({ confirmed: false, missing: '' }),
  createReplyAgent: () => ({
    invoke: async (
      { messages }: { messages: BaseMessage[] },
      { context }: { context: { prompt: string; toolbox: ChatToolbox | null } },
    ) => {
      modelCalls.push({ prompt: context.prompt, messages });
      for (const file_id of script.fileIds) {
        await context.toolbox!.run('send_file', { file_id });
      }
      return { messages: [...messages, new AIMessage(script.text)] };
    },
  }),
}));

const recordChatTurn = jest.fn(() => Promise.resolve());
jest.mock('../chat-conversations/chat-conversations.store', () => ({
  recordChatTurn: (...args: unknown[]) =>
    (recordChatTurn as (...a: unknown[]) => Promise<void>)(...args),
  latestChatMessages: () => Promise.resolve([]),
  resolvePeerPhones: (_: unknown, rows: unknown[]) => Promise.resolve(rows),
  appendMessage: () => Promise.resolve(),
  ensureConversation: () => Promise.resolve('thread'),
}));

const MENU = {
  id: 'row-1',
  file_name: 'menu.pdf',
  mime_type: 'application/pdf',
  size_bytes: 9,
  description: 'When someone asks for the menu',
  created_at: '2026-11-06T00:00:00Z',
};
const BYTES = Buffer.from('%PDF-1.7');

function setup(files: Partial<AgentFilesService>) {
  const prisma = {
    chatAgent: {
      findFirst: () =>
        Promise.resolve({
          id: 'agent-1',
          userId: 'user-1',
          agentName: 'Sales',
          systemPrompt: 'You sell burgers.',
          orderEnabled: false,
          orderInstructions: '',
          tools: [],
          knowledgeBases: [],
          phoneNumber: { phoneNumber: '+8801700000000' },
          user: { email: 'owner@example.com' },
        }),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    chatConversation: { count: () => Promise.resolve(0) },
    $queryRaw: () => Promise.resolve([{ count: 1, group_count: 0 }]),
  };
  const responder = new ChatResponderService(
    prisma as unknown as PrismaService,
    { get: () => 'key' } as unknown as ConfigService,
    { enabled: false } as unknown as IndexerService,
    {} as OrdersService,
    files as AgentFilesService,
  );
  const send = jest.fn(() => Promise.resolve());
  const sendFile = jest.fn(() => Promise.resolve());
  const chat: IncomingChat = {
    phoneNumberId: 'number-1',
    peerJid: '111@lid',
    text: 'send the menu',
    send,
    sendFile,
    setTyping: () => Promise.resolve(),
  };
  // The burst wait is someone else's concern here.
  const answer = (message = chat) =>
    (
      responder as unknown as { answer(c: IncomingChat[]): Promise<void> }
    ).answer([message]);
  return { prisma, send, sendFile, chat, answer };
}

const withMenu = () => ({
  listForReply: jest.fn(() => Promise.resolve([MENU])),
  content: jest.fn(() =>
    Promise.resolve({
      fileName: 'menu.pdf',
      mimeType: 'application/pdf',
      data: BYTES,
    }),
  ),
});

describe('an agent sending a file', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    modelCalls.length = 0;
    script.fileIds = [];
    script.text = '';
  });

  it('delivers the file and the text; only the record says which file', async () => {
    const files = withMenu();
    const { send, sendFile, answer } = setup(files);
    script.fileIds = ['file_1'];
    script.text = '📎 Here is our menu!';
    await answer();

    expect(files.content).toHaveBeenCalledWith('agent-1', 'row-1');
    expect(sendFile).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'menu.pdf', data: BYTES }),
    );
    expect(send).toHaveBeenCalledWith('Here is our menu!');
    expect(recordChatTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userMessage: 'send the menu',
        assistantMessage: '📎 menu.pdf\nHere is our menu!',
      }),
    );
    expect(modelCalls[0].prompt).toContain('- file_1 (menu.pdf): When someone');
  });

  it('remembers on the next reply that the file went out', async () => {
    const { answer, chat } = setup(withMenu());
    script.fileIds = ['file_1'];
    script.text = 'Here it is';
    await answer();
    script.fileIds = [];
    script.text = 'You are welcome';
    await answer({ ...chat, text: 'thanks' });
    const history = modelCalls[1].messages.map((m) => m.text);
    expect(history).toContain('📎 menu.pdf\nHere it is');
  });

  it('counts a file with no words as a reply', async () => {
    const { prisma, send, sendFile, answer } = setup(withMenu());
    script.fileIds = ['file_1'];
    await answer();
    expect(sendFile).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(prisma.chatAgent.updateMany).not.toHaveBeenCalled();
    expect(recordChatTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ assistantMessage: '📎 menu.pdf' }),
    );
  });

  it('records no file when the send failed', async () => {
    const { send, sendFile, answer } = setup(withMenu());
    sendFile.mockRejectedValueOnce(new Error('offline'));
    script.fileIds = ['file_1'];
    script.text = 'Sorry, I could not send it right now.';
    await answer();
    expect(send).toHaveBeenCalledTimes(1);
    expect(recordChatTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        assistantMessage: 'Sorry, I could not send it right now.',
      }),
    );
  });

  it('still answers when the files database is down', async () => {
    const { send, sendFile, answer } = setup({
      listForReply: () => Promise.reject(new Error('connection refused')),
    });
    script.text = 'Hello!';
    await answer();
    expect(send).toHaveBeenCalledWith('Hello!');
    expect(sendFile).not.toHaveBeenCalled();
    expect(modelCalls[0].prompt).not.toContain('send_file');
  });

  it('adds nothing to the prompt of an agent with no files', async () => {
    const { send, answer } = setup({
      listForReply: () => Promise.resolve([]),
    });
    script.text = 'Hello!';
    await answer();
    expect(send).toHaveBeenCalledWith('Hello!');
    expect(modelCalls[0].prompt).not.toContain('send_file');
  });
});
