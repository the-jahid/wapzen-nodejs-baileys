import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatAnthropic } from '@langchain/anthropic';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import {
  DEFAULT_MODEL,
  MAX_REPLIES_PER_AGENT,
} from '../chat-agents/chat-agents.types';
import { recordChatTurn } from '../chat-conversations/chat-conversations.store';
import type { ChatAgent, Tool } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ChatToolbox, dateContext, zoneForPhone } from '../tools/chat-toolbox';

// Follows every agent's own prompt (same wording as the Go server). Reply time
// is almost all the model writing, so a WhatsApp answer defaults to texting
// length; the agent's prompt can still ask for more.
const CHAT_REPLY_STYLE =
  'You are replying in a WhatsApp chat. Write the way a person texts: ' +
  'usually one to three short sentences, about 60 words at most, with no headings or long lists. ' +
  'Give a longer answer only when the person asks for detail or your instructions above call for it.';

const REPLY_MAX_TOKENS = 500;
// How many times one reply may call tools. The last round is asked for text
// only, so a model that keeps calling tools still ends up answering.
const MAX_TOOL_ROUNDS = 3;
// Messages kept per conversation: enough for the model to follow the thread.
const MAX_HISTORY = 5;
// Chats kept in memory across every number; past this the one idle longest
// is forgotten, so memory stays flat however many people write in.
const MAX_CONVERSATIONS = 5_000;

type Turn = { role: 'user' | 'assistant'; text: string };

// The agent with what a reply needs: its attached tools, in attachment
// order, and its number, whose country dates the conversation.
type ReplyingAgent = ChatAgent & {
  tools: { tool: Tool }[];
  phoneNumber: { phoneNumber: string | null } | null;
};

export type IncomingChat = {
  phoneNumberId: string;
  // The WhatsApp chat the message came from; the reply goes back to it.
  peerJid: string;
  // The contact's number (E.164) and WhatsApp display name, when known.
  peerPhone?: string;
  peerName?: string;
  // The WhatsApp message id, so a redelivery isn't saved twice.
  messageId?: string;
  text: string;
  send: (text: string) => Promise<unknown>;
  setTyping: (typing: boolean) => Promise<unknown>;
};

// Answers a WhatsApp message as the chat agent live on the number it arrived
// on, through LangChain's ChatAnthropic. Like the Go server, conversation
// the model's context is kept in memory (the last MAX_HISTORY messages per
// chat), so it starts fresh after a restart; the readable record of every
// thread is saved to chat_conversations.
@Injectable()
export class ChatResponderService {
  private readonly logger = new Logger(ChatResponderService.name);
  private readonly history = new Map<string, Turn[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async respond(chat: IncomingChat): Promise<void> {
    const agent = await this.prisma.chatAgent.findFirst({
      where: { phoneNumberId: chat.phoneNumberId, status: 'active' },
      include: {
        tools: {
          include: { tool: true },
          orderBy: [{ createdAt: 'asc' }, { toolId: 'asc' }],
        },
        phoneNumber: { select: { phoneNumber: true } },
      },
    });
    if (!agent) return;

    const reply = await this.replyAs(agent, chat);
    // Saved for the dashboard whether or not a reply went out: the message
    // still arrived. Losing the copy mustn't disturb the reply path.
    await recordChatTurn(this.prisma, {
      userId: agent.userId,
      phoneNumberId: chat.phoneNumberId,
      chatAgentId: agent.id,
      peerJid: chat.peerJid,
      peerPhone: chat.peerPhone,
      peerName: chat.peerName,
      waMessageId: chat.messageId,
      userMessage: chat.text,
      assistantMessage: reply,
    }).catch((err: Error) =>
      this.logger.error(
        `saving chat agent ${agent.id}'s conversation failed: ${err.message}`,
      ),
    );
  }

  // A message a person sent from the dashboard joins the agent's history, so
  // its next reply knows what was already said.
  rememberSent(
    chatAgentId: string,
    phoneNumberId: string,
    peerJid: string,
    text: string,
  ) {
    this.remember(`${chatAgentId}|${phoneNumberId}|${peerJid}`, {
      role: 'assistant',
      text,
    });
  }

  // Answers as the agent and returns what was sent, or '' when nothing was.
  private async replyAs(agent: ReplyingAgent, chat: IncomingChat) {
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey) {
      this.logger.warn(
        `ANTHROPIC_API_KEY is not set; chat agent ${agent.id} can't reply`,
      );
      return '';
    }

    // Take one reply from the agent's allowance before asking the model, so
    // messages arriving together can't overshoot it. Handed back below if the
    // reply never goes out.
    const { count } = await this.prisma.chatAgent.updateMany({
      where: { id: agent.id, aiReplyCount: { lt: MAX_REPLIES_PER_AGENT } },
      data: { aiReplyCount: { increment: 1 } },
    });
    if (count === 0) {
      this.logger.log(`chat agent ${agent.id} has used all its replies`);
      return '';
    }

    const key = `${agent.id}|${chat.phoneNumberId}|${chat.peerJid}`;
    let sent = false;
    try {
      await chat.setTyping(true).catch(() => undefined);

      // Every chat agent answers with the same model (Go migration 00062),
      // whatever the row says.
      const model = new ChatAnthropic({
        model: DEFAULT_MODEL,
        apiKey,
        temperature: agent.temperature,
        maxTokens: REPLY_MAX_TOKENS,
        maxRetries: 2,
      });
      const toolbox = ChatToolbox.for(
        agent.tools.map((t) => t.tool),
        agent.id,
        chat.send,
      );
      // The prompt that stays the same between replies is cached, together
      // with the tool definitions ahead of it. The date changes every minute,
      // so it comes after the cache breakpoint; in front it would make every
      // reply a cache miss.
      const prompt = [
        agent.systemPrompt.trim(),
        toolbox?.instructions(),
        CHAT_REPLY_STYLE,
      ]
        .filter(Boolean)
        .join('\n\n');
      const messages: BaseMessage[] = [
        new SystemMessage({
          content: [
            {
              type: 'text',
              text: prompt,
              cache_control: { type: 'ephemeral' },
            },
            {
              type: 'text',
              text: dateContext(
                new Date(),
                zoneForPhone(agent.phoneNumber?.phoneNumber),
              ),
            },
          ],
        }),
        ...(this.history.get(key) ?? []).map((turn) =>
          turn.role === 'user'
            ? new HumanMessage(turn.text)
            : new AIMessage(turn.text),
        ),
        new HumanMessage(chat.text),
      ];
      const reply = await this.generate(model, messages, toolbox);
      if (!reply) {
        this.logger.warn(`chat agent ${agent.id} answered with no text`);
        return '';
      }

      await chat.setTyping(false).catch(() => undefined);
      await chat.send(reply);
      sent = true;
      this.remember(key, { role: 'user', text: chat.text });
      this.remember(key, { role: 'assistant', text: reply });
      this.logger.log(`chat agent ${agent.id} replied to ${chat.peerJid}`);
      return reply;
    } catch (err) {
      this.logger.error(
        `chat agent ${agent.id} reply failed: ${(err as Error).message}`,
      );
      return '';
    } finally {
      if (!sent) {
        await chat.setTyping(false).catch(() => undefined);
        await this.prisma.chatAgent
          .updateMany({
            where: { id: agent.id, aiReplyCount: { gt: 0 } },
            data: { aiReplyCount: { decrement: 1 } },
          })
          .catch(() => undefined);
      }
    }
  }

  // Asks the model for the reply, running the tools it calls between rounds.
  // The text of every round is kept, so anything said before a tool call
  // still reaches the person.
  private async generate(
    model: ChatAnthropic,
    messages: BaseMessage[],
    toolbox: ChatToolbox | null,
  ) {
    const texts: string[] = [];
    for (let round = 1; ; round++) {
      const last = round >= MAX_TOOL_ROUNDS;
      const runnable = toolbox
        ? model.bindTools(toolbox.definitions(), {
            tool_choice: last ? 'none' : 'auto',
          })
        : model;
      const response = await runnable.invoke(messages);
      const text = response.text.trim();
      if (text) texts.push(text);

      const calls = response.tool_calls ?? [];
      if (!toolbox || !calls.length || last) break;
      messages.push(response);
      for (const call of calls) {
        const result = await toolbox.run(call.name, call.args);
        messages.push(
          new ToolMessage({ tool_call_id: call.id ?? '', content: result }),
        );
      }
    }
    return texts.join('\n\n');
  }

  private remember(key: string, turn: Turn) {
    const turns = [...(this.history.get(key) ?? []), turn];
    // Re-inserting moves the chat to the end, so the Map's first key is
    // always the one idle longest.
    this.history.delete(key);
    const kept = turns.slice(-MAX_HISTORY);
    // The model's context has to open with the person's message, not a reply.
    while (kept[0]?.role === 'assistant') kept.shift();
    this.history.set(key, kept);
    if (this.history.size > MAX_CONVERSATIONS) {
      const [oldest] = this.history.keys();
      this.history.delete(oldest);
    }
  }
}
