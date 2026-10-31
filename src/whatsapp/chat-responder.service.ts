import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { activity } from '../activity/activity';
import {
  latestChatMessages,
  recordChatTurn,
  resolvePeerPhones,
} from '../chat-conversations/chat-conversations.store';
import type { ChatAgent, Tool } from '../generated/prisma/client';
import {
  CHAT_KNOWLEDGE_TOP_K,
  chatKnowledgePrompt,
  chatKnowledgeQuery,
} from '../knowledge-bases/chat-knowledge';
import { IndexerService } from '../knowledge-bases/indexer.service';
import {
  ORDER_FUNCTION,
  requiredDetails,
  type OrderField,
  ORDERS_OFF_PROMPT,
  orderPrompt,
} from '../orders/order-tool';
import { OrdersService } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ChatToolbox,
  dateContext,
  zoneForPhone,
  type ChatOrders,
} from '../tools/chat-toolbox';
import {
  CHAT_REMEMBER_MESSAGES,
  CHAT_SUMMARY_AT,
  createConfirmationCheck,
  createReplyAgent,
  isChatSummary,
  type ReplyContext,
} from './reply-agent';

// Follows every agent's own prompt (same wording as the Go server). Reply time
// is almost all the model writing, so a WhatsApp answer defaults to texting
// length; the agent's prompt can still ask for more.
const CHAT_REPLY_STYLE =
  'You are replying in a WhatsApp chat. Write the way a person texts: ' +
  'usually one to three short sentences, about 60 words at most, with no headings or long lists. ' +
  'Give a longer answer only when the person asks for detail or your instructions above call for it.';

// The model fills gaps in a thin prompt with plausible facts (in a live test it
// gave a delivery time the shop never set, and said it would check stock with
// no way to). Placed with the style, ahead of what changes, so it caches.
const CHAT_FACTS_RULE =
  'Only state facts about this business, such as prices, stock, sizes, colours, delivery times, payment, policies and opening hours, ' +
  'when they are in your instructions above, the retrieved knowledge, or a tool result. ' +
  'When you do not have a fact, say plainly that you do not have that information; never guess or give a typical answer. ' +
  'Never say you will do something later, such as checking stock or calling back, unless one of your tools does it now.';

// People often send one thought as several quick messages. Each waits this
// long for the next before the agent answers them all as one, so two replies
// never cross. MAX_BURST_WAIT_MS caps the wait for someone who keeps typing.
const BURST_QUIET_MS = 2_000;
const MAX_BURST_WAIT_MS = 8_000;

// The most a chat keeps word for word. The summary middleware sums a chat up
// before it gets here, so this only stops a chat whose summaries keep failing
// from growing. Keep it even, or trimming to the person's message loses one
// more.
const MAX_HISTORY = CHAT_SUMMARY_AT;
// Chats kept in memory across every number; past this the one idle longest
// is forgotten, so memory stays flat however many people write in.
const MAX_CONVERSATIONS = 5_000;

// Same wording as the dashboard's free limit notice (frontend
// components/nav/FreeLimitNotice.tsx), plus the plan's price. No apostrophe in the prefilled text: an
// unescaped one can end the link WhatsApp makes out of the URL.
const LIMIT_WHATSAPP_URL = `https://wa.me/8801701750469?text=${encodeURIComponent(
  'Hi, I have reached my free limit on Wapzen and would like to buy a paid plan.',
)}`;
const LIMIT_REACHED_MESSAGE =
  'You have reached your free limit on Wapzen, so your AI agent has stopped replying.\n\n' +
  'You need a paid plan to keep your agent replying. The plan is $20 per month with unlimited messages.\n\n' +
  `To buy one, message us on WhatsApp: ${LIMIT_WHATSAPP_URL}`;

type Turn = { role: 'user' | 'assistant'; text: string };

// One chat's messages waiting to be answered together. Only one reply per chat
// runs at a time; what arrives meanwhile waits for the next.
type Burst = {
  waiting: IncomingChat[];
  firstAt: number;
  lastAt: number;
  timer?: NodeJS.Timeout;
  replying: boolean;
};

// The agent with what a reply needs: its attached tools, in attachment
// order, the knowledge bases it reads, and its number, whose country dates the
// conversation.
type ReplyingAgent = ChatAgent & {
  tools: { tool: Tool }[];
  knowledgeBases: { knowledgeBase: { pineconeNamespace: string | null } }[];
  phoneNumber: { phoneNumber: string | null } | null;
  user: { email: string };
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
  // Writes to the number's own WhatsApp, not to the person who messaged it.
  messageOwner: (text: string) => Promise<unknown>;
};

// Answers a WhatsApp message as the chat agent live on the number it arrived
// on, through a LangChain agent (reply-agent.ts). The model's context is kept
// in memory: a summary plus the latest turns of each chat. A chat that isn't
// there (after a restart, or forgotten as idle) starts again from its last
// CHAT_REMEMBER_MESSAGES in chat_conversations, the readable record of every
// thread.
@Injectable()
export class ChatResponderService {
  private readonly logger = new Logger(ChatResponderService.name);
  private readonly history = new Map<string, Turn[]>();
  // What the summary middleware made of each long chat's older messages.
  private readonly summaries = new Map<string, BaseMessage>();
  private readonly bursts = new Map<string, Burst>();
  private agent?: ReturnType<typeof createReplyAgent>;
  private confirmationCheck?: ReturnType<typeof createConfirmationCheck>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly indexer: IndexerService,
    private readonly orders: OrdersService,
  ) {}

  // Queues a message to be answered with any others the person sends in the
  // same burst. A message lost here (a restart inside the wait) goes unanswered,
  // as one mid-reply always has.
  respond(chat: IncomingChat): Promise<void> {
    const key = `${chat.phoneNumberId}|${chat.peerJid}`;
    const now = Date.now();
    let burst = this.bursts.get(key);
    if (!burst) {
      burst = { waiting: [], firstAt: now, lastAt: now, replying: false };
      this.bursts.set(key, burst);
    }
    if (!burst.waiting.length) burst.firstAt = now;
    burst.waiting.push(chat);
    burst.lastAt = now;
    if (!burst.replying) this.schedule(key, burst);
    return Promise.resolve();
  }

  private schedule(key: string, burst: Burst) {
    clearTimeout(burst.timer);
    const due = Math.min(
      burst.lastAt + BURST_QUIET_MS,
      burst.firstAt + MAX_BURST_WAIT_MS,
    );
    burst.timer = setTimeout(
      () => void this.answerBurst(key, burst),
      Math.max(due - Date.now(), 0),
    );
  }

  private async answerBurst(key: string, burst: Burst) {
    burst.replying = true;
    const chats = burst.waiting.splice(0);
    try {
      await this.answer(chats);
    } catch (err) {
      this.logger.error(`answering ${key} failed: ${(err as Error).message}`);
    } finally {
      burst.replying = false;
      if (burst.waiting.length) this.schedule(key, burst);
      else this.bursts.delete(key);
    }
  }

  // Answers a burst as one message from the person, sent from the last one's
  // socket. Each message is still saved on its own, the reply after the last.
  private async answer(chats: IncomingChat[]) {
    const last = chats[chats.length - 1];
    const chat: IncomingChat = {
      ...last,
      text: chats.map((c) => c.text).join('\n'),
    };
    const agent = await this.prisma.chatAgent.findFirst({
      where: { phoneNumberId: chat.phoneNumberId, status: 'active' },
      include: {
        tools: {
          include: { tool: true },
          orderBy: [{ createdAt: 'asc' }, { toolId: 'asc' }],
        },
        knowledgeBases: {
          select: {
            knowledgeBase: { select: { pineconeNamespace: true } },
          },
        },
        phoneNumber: { select: { phoneNumber: true } },
        user: { select: { email: true } },
      },
    });
    if (!agent) return;

    const reply = await this.replyAs(agent, chat);
    // Saved for the dashboard whether or not a reply went out: the messages
    // still arrived. Losing the copy mustn't disturb the reply path.
    for (const [i, message] of chats.entries()) {
      await recordChatTurn(this.prisma, {
        userId: agent.userId,
        phoneNumberId: message.phoneNumberId,
        chatAgentId: agent.id,
        peerJid: message.peerJid,
        peerPhone: message.peerPhone,
        peerName: message.peerName,
        waMessageId: message.messageId,
        userMessage: message.text,
        assistantMessage: i === chats.length - 1 ? reply : undefined,
      }).catch((err: Error) =>
        this.logger.error(
          `saving chat agent ${agent.id}'s conversation failed: ${err.message}`,
        ),
      );
    }
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
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      this.logger.warn(
        `OPENAI_API_KEY is not set; chat agent ${agent.id} can't reply`,
      );
      return '';
    }

    // Take one reply from the account's allowance before asking the model, so
    // messages arriving together can't overshoot it. Handed back below if the
    // reply never goes out.
    const [owner] = await this.prisma.user.updateManyAndReturn({
      where: {
        id: agent.userId,
        aiReplyCount: { lt: this.prisma.user.fields.aiReplyLimit },
      },
      data: { aiReplyCount: { increment: 1 } },
      select: { aiReplyCount: true, aiReplyLimit: true },
    });
    if (!owner) {
      this.logger.log(`user ${agent.userId} has used all their replies`);
      await this.stopAtLimit(agent, chat);
      return '';
    }

    const key = `${agent.id}|${chat.phoneNumberId}|${chat.peerJid}`;
    let sent = false;
    try {
      await chat.setTyping(true).catch(() => undefined);

      const toolbox = ChatToolbox.for(
        agent.tools.map((t) => t.tool),
        agent.id,
        chat.send,
        await this.ordersFor(agent, chat),
      );
      await this.loadHistory(key, chat);
      // Both ask a different service before the reply can start, so they run
      // together.
      const [knowledge, confirmed] = await Promise.all([
        this.knowledgeFor(agent, key, chat.text),
        !!toolbox?.takesOrders &&
          this.orderConfirmed(
            apiKey,
            key,
            chat.text,
            agent,
            toolbox.orderFields,
          ),
      ]);
      // OpenAI caches the longest prefix it has seen before, so the part that
      // stays the same between replies goes first. The date and the passages
      // change; in front they would make every reply a cache miss.
      const prompt = [
        agent.systemPrompt.trim(),
        toolbox?.instructions(),
        toolbox?.takesOrders
          ? orderPrompt(
              agent.orderInstructions,
              toolbox.phoneKnown,
              toolbox.orderFields,
            )
          : agent.tools.some((t) => t.tool.type === 'order')
            ? ORDERS_OFF_PROMPT
            : undefined,
        CHAT_REPLY_STYLE,
        CHAT_FACTS_RULE,
        dateContext(new Date(), zoneForPhone(agent.phoneNumber?.phoneNumber)),
        knowledge,
      ]
        .filter(Boolean)
        .join('\n\n');
      const summary = this.summaries.get(key);
      const incoming = new HumanMessage({
        id: randomUUID(),
        content: chat.text,
      });
      const messages: BaseMessage[] = [
        ...(summary ? [summary] : []),
        ...this.recent(key).map((turn) =>
          turn.role === 'user'
            ? new HumanMessage(turn.text)
            : new AIMessage(turn.text),
        ),
        incoming,
      ];
      if (confirmed) toolbox!.confirmOrder();
      const generated = await this.generate(key, apiKey, messages, incoming, {
        prompt,
        toolbox,
        requiredTool: confirmed ? ORDER_FUNCTION : undefined,
      });
      // An order must never be placed in silence.
      const orderNumber = await toolbox?.placedOrderNumber();
      const reply =
        generated ||
        (orderNumber ? `Your order #${orderNumber} is placed.` : '');
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
      activity(
        `AI replied: ${agent.user.email} - ${agent.agentName} on ${agent.phoneNumber?.phoneNumber}`,
      );
      if (owner.aiReplyCount >= owner.aiReplyLimit) {
        await this.stopAtLimit(agent, chat);
      }
      return reply;
    } catch (err) {
      this.logger.error(
        `chat agent ${agent.id} reply failed: ${(err as Error).message}`,
      );
      return '';
    } finally {
      if (!sent) {
        await chat.setTyping(false).catch(() => undefined);
        await this.prisma.user
          .updateMany({
            where: { id: agent.userId, aiReplyCount: { gt: 0 } },
            data: { aiReplyCount: { decrement: 1 } },
          })
          .catch(() => undefined);
      }
    }
  }

  // What create_order does in this chat, when the owner has ordering on. An
  // "@lid" chat often arrives with no number, which the saved LID map may know.
  private async ordersFor(
    agent: ReplyingAgent,
    chat: IncomingChat,
  ): Promise<ChatOrders | undefined> {
    if (!agent.orderEnabled) return undefined;
    const [{ peerPhone }] = await resolvePeerPhones(this.prisma, [
      {
        phoneNumberId: chat.phoneNumberId,
        peerJid: chat.peerJid,
        peerPhone: chat.peerPhone ?? null,
      },
    ]);
    return {
      phoneKnown: !!peerPhone,
      place: (args, fields) =>
        this.orders.place(
          {
            userId: agent.userId,
            ownerEmail: agent.user.email,
            agentId: agent.id,
            agentName: agent.agentName,
            phoneNumberId: chat.phoneNumberId,
            peerJid: chat.peerJid,
            customerPhone: peerPhone ?? undefined,
            peerName: chat.peerName,
            agentPhone: agent.phoneNumber?.phoneNumber,
          },
          args,
          fields,
        ),
    };
  }

  // Whether this message agrees to an order the agent has set out, which has
  // to have happened in an earlier reply. If the check fails the reply carries
  // on without it, and the customer's next message gets another chance.
  private async orderConfirmed(
    apiKey: string,
    key: string,
    text: string,
    agent: ReplyingAgent,
    fields: OrderField[],
  ) {
    const turns = this.recent(key);
    if (!turns.some((turn) => turn.role === 'assistant')) return false;
    this.confirmationCheck ??= createConfirmationCheck(apiKey);
    try {
      return await this.confirmationCheck(
        turns,
        text,
        agent.orderInstructions,
        requiredDetails(fields),
      );
    } catch (err) {
      this.logger.warn(`order check failed: ${(err as Error).message}`);
      return false;
    }
  }

  // The passages for this message from the agent's knowledge bases, as prompt
  // text. A failed lookup is logged and the agent answers from its prompt
  // alone: a thinner reply beats none.
  private async knowledgeFor(agent: ReplyingAgent, key: string, text: string) {
    const namespaces = agent.knowledgeBases.flatMap(
      ({ knowledgeBase }) => knowledgeBase.pineconeNamespace ?? [],
    );
    if (!namespaces.length) return '';
    if (!this.indexer.enabled) {
      this.logger.warn(
        `chat agent ${agent.id} has knowledge bases but the vector store isn't configured`,
      );
      return '';
    }
    try {
      const query = chatKnowledgeQuery(this.recent(key), text);
      return chatKnowledgePrompt(
        await this.indexer.search(namespaces, query, CHAT_KNOWLEDGE_TOP_K),
      );
    } catch (err) {
      this.logger.error(
        `chat agent ${agent.id} knowledge lookup failed: ${(err as Error).message}`,
      );
      return '';
    }
  }

  // The account is out of replies: every agent it has stops, and the owner is
  // told how to buy a paid plan. Only the call that actually stopped an agent
  // sends the message, so the owner hears it once however many people write
  // in. A stopped agent can't go live again until ai_reply_limit is raised
  // (see allowedStatus in chat-agents.service.ts).
  private async stopAtLimit(agent: ReplyingAgent, chat: IncomingChat) {
    try {
      const { count } = await this.prisma.chatAgent.updateMany({
        where: { userId: agent.userId, status: 'active' },
        data: { status: 'inactive' },
      });
      if (count === 0) return;
      activity(
        `reply limit reached: ${agent.user.email} - ${agent.agentName} on ${agent.phoneNumber?.phoneNumber}`,
      );
      await chat.messageOwner(LIMIT_REACHED_MESSAGE);
    } catch (err) {
      this.logger.error(
        `stopping chat agent ${agent.id} at its limit failed: ${(err as Error).message}`,
      );
    }
  }

  // Asks the agent for the reply. The text of every model call is kept, so
  // anything said before a tool call still reaches the person. A summary
  // replaces the messages before it, so the reply is found by what follows the
  // incoming message, not by position.
  private async generate(
    key: string,
    apiKey: string,
    messages: BaseMessage[],
    incoming: HumanMessage,
    context: ReplyContext,
  ) {
    this.agent ??= createReplyAgent(apiKey);
    const result = await this.agent.invoke({ messages }, { context });
    const at = result.messages.findIndex((m) => m.id === incoming.id);
    const [first] = result.messages;
    if (
      at > 0 &&
      isChatSummary(first) &&
      first.text !== this.summaries.get(key)?.text
    ) {
      // A new summary: only the turns the middleware kept, the ones between it
      // and the incoming message, stay word for word.
      const kept = at - 1;
      const turns = this.history.get(key) ?? [];
      this.summaries.set(key, first);
      this.history.set(key, kept ? turns.slice(-kept) : []);
    }
    return result.messages
      .slice(at + 1 || messages.length)
      .filter((message) => AIMessage.isInstance(message))
      .map((message) => message.text.trim())
      .filter(Boolean)
      .join('\n\n');
  }

  // Picks a chat back up from its saved messages when memory has none of it.
  // A failed read is logged and the reply goes ahead without the history.
  private async loadHistory(key: string, chat: IncomingChat) {
    if (this.history.get(key)?.length) return;
    try {
      const turns = await latestChatMessages(
        this.prisma,
        chat.phoneNumberId,
        chat.peerJid,
        CHAT_REMEMBER_MESSAGES,
      );
      this.history.set(key, this.recent(key, turns));
    } catch (err) {
      this.logger.error(
        `loading the chat with ${chat.peerJid} failed: ${(err as Error).message}`,
      );
    }
  }

  // The chat's latest turns. The model's context has to open with the
  // person's message, not a reply.
  private recent(key: string, turns = this.history.get(key) ?? []) {
    const recent = turns.slice(-MAX_HISTORY);
    while (recent[0]?.role === 'assistant') recent.shift();
    // The summary goes when the chat does.
    if (!recent.length) this.summaries.delete(key);
    return recent;
  }

  private remember(key: string, turn: Turn) {
    const turns = [...(this.history.get(key) ?? []), turn];
    // Re-inserting moves the chat to the end, so the Map's first key is
    // always the one idle longest.
    this.history.delete(key);
    this.history.set(key, this.recent(key, turns));
    if (this.history.size > MAX_CONVERSATIONS) {
      const [oldest] = this.history.keys();
      this.history.delete(oldest);
      this.summaries.delete(oldest);
    }
  }
}
