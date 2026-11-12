import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { activity } from '../activity/activity';
import { AgentFilesService } from '../agent-files/agent-files.service';
import type { OutgoingFile } from '../agent-files/agent-files.types';
import {
  FREE_TRIAL_REPLIES,
  GROUP_HOURLY_REPLY_LIMIT,
  HOURLY_LIMITS_ON,
  HOURLY_REPLY_LIMIT,
  onPaidPlan,
} from '../chat-agents/chat-agents.types';
import {
  appendMessage,
  ensureConversation,
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
} from '../orders/order-tool';
import { OrdersService } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import type { ChatWebsite } from '../tools/chat-toolbox';
import { readWebsitePage, siteRoot } from '../website/website-reader';
import { isGroupJid } from './group-chat';
import {
  imageDataUrl,
  type IncomingMedia,
  MAX_IMAGE_BYTES,
  MAX_VOICE_BYTES,
  MAX_VOICE_SECONDS,
  smallerPhoto,
  transcribe,
} from './media';
import {
  ChatToolbox,
  dateContext,
  FILE_SENT_MARK,
  zoneForPhone,
  type ChatFile,
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
// Added to the owner's prompt in a group only: there, several people share one
// chat, and the agent only hears from them when they tag it.
const GROUP_CHAT_NOTE =
  "This chat is a WhatsApp group. Each message starts with the name of the person who wrote it, and you only see the messages that tag you or reply to you. Answer the person who wrote to you, by name when it's clear who you're talking to.";

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
  knowledgeBases: {
    knowledgeBase: { id: string; pineconeNamespace: string | null };
  }[];
  phoneNumber: { phoneNumber: string | null } | null;
  user: { email: string; noReplyLimitUntil: Date | null };
};

export type IncomingChat = {
  phoneNumberId: string;
  // The WhatsApp chat the message came from; the reply goes back to it.
  peerJid: string;
  // The contact's number (E.164) and WhatsApp display name, when known.
  peerPhone?: string;
  peerName?: string;
  // In a group, the WhatsApp name of the person who wrote this. peerJid is then
  // the group.
  sender?: string;
  // The WhatsApp message id, so a redelivery isn't saved twice.
  messageId?: string;
  // What the person typed, or a photo's caption; '' for a bare voice message
  // or photo.
  text: string;
  media?: IncomingMedia;
  send: (text: string) => Promise<unknown>;
  sendFile: (file: OutgoingFile) => Promise<unknown>;
  setTyping: (typing: boolean) => Promise<unknown>;
};

// A message a person sent from the number's own WhatsApp.
export type PersonSent = {
  phoneNumberId: string;
  // Every JID the customer is known by (their "@lid" and their number).
  peerJids: string[];
  // The one to open a thread on when there's none yet.
  peerJid: string;
  peerPhone?: string;
  messageId?: string;
  text: string;
};

// A message as the agent answers it: a voice message turned into its words,
// a photo the agent reads carried as an image for the model.
type ReadChat = IncomingChat & { images: string[] };

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
    private readonly files: AgentFilesService,
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
  private async answer(incoming: IncomingChat[]) {
    const { phoneNumberId, peerJid } = incoming[0];
    const [agent, aiOff, group] = await Promise.all([
      this.prisma.chatAgent.findFirst({
        where: { phoneNumberId, status: 'active' },
        include: {
          tools: {
            include: { tool: true },
            orderBy: [{ createdAt: 'asc' }, { toolId: 'asc' }],
          },
          knowledgeBases: {
            select: {
              knowledgeBase: { select: { id: true, pineconeNamespace: true } },
            },
          },
          phoneNumber: { select: { phoneNumber: true } },
          user: { select: { email: true, noReplyLimitUntil: true } },
        },
      }),
      // A person switched the AI off for this contact in the dashboard.
      this.prisma.chatConversation.count({
        where: { phoneNumberId, peerJid, aiReplyEnabled: false },
      }),
      // Asked here as well as on the socket, which only knows what this server
      // was told: a group switched off a moment ago stays off.
      isGroupJid(peerJid)
        ? this.prisma.aiGroup.findUnique({
            where: {
              phoneNumberId_groupJid: { phoneNumberId, groupJid: peerJid },
            },
          })
        : undefined,
    ]);
    if (!agent) return;
    if (isGroupJid(peerJid) && !group) return;

    // What the agent doesn't read (a voice message with the switch off, say)
    // goes unanswered and unsaved, as it did before the switches existed. In a
    // group each message says who wrote it, on the thread and to the agent, and
    // the thread is named after the group.
    const chats = (
      await Promise.all(incoming.map((c) => this.readMedia(agent, c)))
    )
      .filter((c): c is ReadChat => !!c)
      .map((c) =>
        group
          ? {
              ...c,
              peerName: group.name ?? undefined,
              text: `${c.sender}: ${c.text}`,
            }
          : c,
      );
    if (!chats.length) return;
    const chat: ReadChat = {
      ...chats[chats.length - 1],
      text: chats.map((c) => c.text).join('\n'),
      images: chats.flatMap((c) => c.images),
    };

    let reply = '';
    if (!aiOff) {
      reply = await this.replyAs(agent, chat);
    } else {
      // The agent keeps hearing the chat, so when it's switched back on it
      // knows what was said meanwhile. A chat not in memory reloads from the
      // saved messages anyway.
      const key = `${agent.id}|${phoneNumberId}|${peerJid}`;
      if (this.history.get(key)?.length) {
        this.remember(key, { role: 'user', text: chat.text });
      }
    }
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

  // A message as the agent reads it, or undefined when it doesn't. A voice
  // message becomes its words and a photo an image for the model; both are
  // marked (🎤, 📷) so the conversation record and the agent's later history
  // say what was sent. A photo that can't be read is answered by its caption.
  private async readMedia(
    agent: ReplyingAgent,
    chat: IncomingChat,
  ): Promise<ReadChat | undefined> {
    const { media } = chat;
    const plain = chat.text ? { ...chat, images: [] } : undefined;
    if (!media) return plain;
    const apiKey = this.config.get<string>('OPENAI_API_KEY');

    if (media.kind === 'voice') {
      if (!agent.voiceMessagesEnabled || !apiKey) return undefined;
      if (media.seconds > MAX_VOICE_SECONDS || media.bytes > MAX_VOICE_BYTES) {
        this.logger.warn(
          `chat agent ${agent.id} skipped a ${media.seconds}s voice message from ${chat.peerJid}`,
        );
        return undefined;
      }
      try {
        const words = await transcribe(
          apiKey,
          await media.download(),
          media.mimetype,
        );
        return words ? { ...chat, text: `🎤 ${words}`, images: [] } : undefined;
      } catch (err) {
        this.logger.error(
          `chat agent ${agent.id} couldn't transcribe a voice message: ${(err as Error).message}`,
        );
        return undefined;
      }
    }

    if (!agent.imagesEnabled || media.bytes > MAX_IMAGE_BYTES) return plain;
    try {
      const image = imageDataUrl(
        await smallerPhoto(await media.download(), media.mimetype),
        media.mimetype,
      );
      if (!image) return plain;
      return {
        ...chat,
        text: chat.text ? `📷 ${chat.text}` : '📷 Photo',
        images: [image],
      };
    } catch (err) {
      this.logger.error(
        `chat agent ${agent.id} couldn't download a photo: ${(err as Error).message}`,
      );
      return plain;
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

  // A person wrote to the customer from the number's own WhatsApp: the
  // message joins the thread, as one sent from the dashboard would, so the
  // agent's next reply knows what was said. The AI stays as it is: only the
  // conversation's switch turns it off. With no active agent on the number
  // nothing is saved: the phone is just someone's own WhatsApp then.
  async personSent(sent: PersonSent) {
    const phone = await this.prisma.phoneNumber.findUnique({
      where: { id: sent.phoneNumberId },
      select: {
        userId: true,
        chatAgent: { select: { id: true, status: true } },
      },
    });
    if (phone?.chatAgent?.status !== 'active') return;
    const chatAgentId = phone.chatAgent.id;

    const found = await this.prisma.chatConversation.findFirst({
      where: {
        phoneNumberId: sent.phoneNumberId,
        peerJid: { in: sent.peerJids },
      },
      orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
      select: { id: true, peerJid: true },
    });
    const thread = found ?? {
      id: await ensureConversation(this.prisma, {
        userId: phone.userId,
        phoneNumberId: sent.phoneNumberId,
        chatAgentId,
        peerJid: sent.peerJid,
        peerPhone: sent.peerPhone,
      }),
      peerJid: sent.peerJid,
    };

    // A redelivered message is already on the thread; the unique index says
    // so, and that's not worth a log line.
    await appendMessage(
      this.prisma,
      thread.id,
      'assistant',
      sent.text,
      sent.messageId,
    ).catch((err: Error) => {
      if (!/unique/i.test(err.message)) {
        this.logger.error(
          `saving a message sent from the phone failed: ${err.message}`,
        );
      }
    });
    this.rememberSent(
      chatAgentId,
      sent.phoneNumberId,
      thread.peerJid,
      sent.text,
    );
  }

  // Answers as the agent and returns what was sent, or '' when nothing was.
  private async replyAs(agent: ReplyingAgent, chat: ReadChat) {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      this.logger.warn(
        `OPENAI_API_KEY is not set; chat agent ${agent.id} can't reply`,
      );
      return '';
    }
    const inGroup = isGroupJid(chat.peerJid);
    const trialCount = await this.claimTrialReply(agent);
    if (trialCount === false) return '';
    if (!(await this.claimReply(agent, inGroup))) {
      await this.releaseTrialReply(agent);
      return '';
    }

    const key = `${agent.id}|${chat.phoneNumberId}|${chat.peerJid}`;
    let sent = false;
    try {
      await chat.setTyping(true).catch(() => undefined);

      const [orders, files, website] = await Promise.all([
        this.ordersFor(agent, chat),
        this.filesFor(agent, chat),
        websiteFor(agent),
      ]);
      const toolbox = ChatToolbox.for(
        agent.tools.map((t) => t.tool),
        agent.id,
        chat.send,
        orders,
        files,
        website,
      );
      await this.loadHistory(key, chat);
      // Both ask a different service before the reply can start, so they run
      // together.
      const [knowledge, check] = await Promise.all([
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
      // What the owner set up: the agent's prompt, their order instructions
      // with order taking on, and passages from attached knowledge bases. The
      // one line added for every agent is the date and time, in the zone of
      // the agent's number. The date and the passages change, so they go last
      // and the rest caches. A group gets a note on how to read it.
      const prompt = [
        agent.systemPrompt.trim(),
        toolbox?.takesOrders ? agent.orderInstructions.trim() : '',
        toolbox?.filesPrompt ?? '',
        toolbox?.websitePrompt ?? '',
        isGroupJid(chat.peerJid) ? GROUP_CHAT_NOTE : '',
        dateContext(new Date(), zoneForPhone(agent.phoneNumber?.phoneNumber)),
        knowledge,
      ]
        .filter(Boolean)
        .join('\n\n');
      const summary = this.summaries.get(key);
      // Photos go to the model only with the message they came in; history
      // keeps the 📷 line, not the image.
      const incoming = new HumanMessage({
        id: randomUUID(),
        content: chat.images.length
          ? [
              { type: 'text', text: chat.text },
              ...chat.images.map((url) => ({
                type: 'image_url',
                image_url: { url },
              })),
            ]
          : chat.text,
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
      if (check) {
        if (check.confirmed) toolbox!.confirmOrder();
        toolbox!.noteMissing(check.missing);
      }
      const generated = await this.generate(key, apiKey, messages, incoming, {
        prompt,
        toolbox,
        requiredTool: check && check.confirmed ? ORDER_FUNCTION : undefined,
      });
      // An order must never be placed in silence.
      const orderNumber = await toolbox?.placedOrderNumber();
      const reply =
        (toolbox?.withoutFileMarks(generated) ?? generated) ||
        (orderNumber ? `Your order #${orderNumber} is placed.` : '');
      const sentFiles = toolbox?.sentFiles ?? [];
      if (!reply && !sentFiles.length) {
        this.logger.warn(`chat agent ${agent.id} answered with no text`);
        return '';
      }

      await chat.setTyping(false).catch(() => undefined);
      if (reply) await chat.send(reply);
      sent = true;
      // The trial's last reply went out: the agent stops now, so the
      // dashboard says so before the next message comes.
      if (trialCount === FREE_TRIAL_REPLIES) await this.endTrial(agent);
      // The record says which files went out, or the agent would forget and
      // send them again. The customer already has the files, not this line.
      const record = [
        ...sentFiles.map((name) => `${FILE_SENT_MARK} ${name}`),
        reply,
      ]
        .filter(Boolean)
        .join('\n');
      this.remember(key, { role: 'user', text: chat.text });
      this.remember(key, { role: 'assistant', text: record });
      this.logger.log(`chat agent ${agent.id} replied to ${chat.peerJid}`);
      activity(
        `AI replied: ${agent.user.email} - ${agent.agentName} on ${agent.phoneNumber?.phoneNumber}`,
      );
      return record;
    } catch (err) {
      this.logger.error(
        `chat agent ${agent.id} reply failed: ${(err as Error).message}`,
      );
      return '';
    } finally {
      if (!sent) {
        await chat.setTyping(false).catch(() => undefined);
        await this.releaseReply(agent, inGroup);
        await this.releaseTrialReply(agent);
      }
    }
  }

  // Takes one of a free account's FREE_TRIAL_REPLIES before asking the model,
  // in one statement so replies running together can't overshoot it. Returns
  // the account's count with this reply, true when it isn't counted (paid
  // plan, or the count failed: that mustn't silence the agent), or false when
  // the trial is used up, which also stops the account's agents.
  private async claimTrialReply(
    agent: ReplyingAgent,
  ): Promise<number | boolean> {
    if (onPaidPlan(agent.user)) return true;
    try {
      const [claimed] = await this.prisma.$queryRaw<{ count: number }[]>`
        UPDATE users SET ai_reply_count = ai_reply_count + 1
        WHERE id = ${agent.userId}
          AND trial_ended_at IS NULL
          AND ai_reply_count < ${FREE_TRIAL_REPLIES}
        RETURNING ai_reply_count AS count`;
      if (claimed) return claimed.count;
    } catch (err) {
      this.logger.error(
        `counting chat agent ${agent.id}'s trial reply failed: ${(err as Error).message}`,
      );
      return true;
    }
    await this.endTrial(agent);
    return false;
  }

  // Hands back a trial reply claimed for a message that got no answer.
  private async releaseTrialReply(agent: ReplyingAgent) {
    if (onPaidPlan(agent.user)) return;
    await this.prisma.user
      .updateMany({
        where: {
          id: agent.userId,
          trialEndedAt: null,
          aiReplyCount: { gt: 0 },
        },
        data: { aiReplyCount: { decrement: 1 } },
      })
      .catch(() => undefined);
  }

  // The free trial is used up: the account is marked and all its agents go
  // inactive, which the dashboard shows with the paid-plan card. Logged once,
  // by whichever call stamped it.
  private async endTrial(agent: ReplyingAgent) {
    try {
      const [stamped] = await this.prisma.$transaction([
        this.prisma.user.updateMany({
          where: { id: agent.userId, trialEndedAt: null },
          data: { trialEndedAt: new Date() },
        }),
        this.prisma.chatAgent.updateMany({
          where: { userId: agent.userId, status: 'active' },
          data: { status: 'inactive', updatedAt: new Date() },
        }),
      ]);
      if (stamped.count) {
        activity(
          `free trial ended: ${agent.user.email} - ${agent.agentName} on ${agent.phoneNumber?.phoneNumber}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `ending ${agent.user.email}'s free trial failed: ${(err as Error).message}`,
      );
    }
  }

  // Takes one reply from the agent's hour before asking the model, so replies
  // running together (several chats, several instances) can't overshoot it. A
  // window older than an hour starts over at this reply. A reply in a group also
  // takes one from the agent's group hour, in the same statement, so it's never
  // counted in one and refused by the other. False at either limit.
  private async claimReply(agent: ReplyingAgent, inGroup: boolean) {
    // Not counted at all, so the dashboard never shows the agent paused.
    if (!HOURLY_LIMITS_ON || noReplyLimit(agent)) return true;
    try {
      const [claimed] = await this.prisma.$queryRaw<
        { count: number; group_count: number }[]
      >`
        UPDATE chat_agents SET
          hourly_reply_count = CASE
            WHEN hourly_window_started_at > now() - interval '1 hour'
            THEN hourly_reply_count + 1 ELSE 1 END,
          hourly_window_started_at = CASE
            WHEN hourly_window_started_at > now() - interval '1 hour'
            THEN hourly_window_started_at ELSE now() END,
          group_hourly_reply_count = CASE
            WHEN NOT ${inGroup}::boolean THEN group_hourly_reply_count
            WHEN group_hourly_window_started_at > now() - interval '1 hour'
            THEN group_hourly_reply_count + 1 ELSE 1 END,
          group_hourly_window_started_at = CASE
            WHEN NOT ${inGroup}::boolean THEN group_hourly_window_started_at
            WHEN group_hourly_window_started_at > now() - interval '1 hour'
            THEN group_hourly_window_started_at ELSE now() END
        WHERE id = ${agent.id}
          AND (hourly_window_started_at IS NULL
            OR hourly_window_started_at <= now() - interval '1 hour'
            OR hourly_reply_count < ${HOURLY_REPLY_LIMIT})
          AND (NOT ${inGroup}::boolean
            OR group_hourly_window_started_at IS NULL
            OR group_hourly_window_started_at <= now() - interval '1 hour'
            OR group_hourly_reply_count < ${GROUP_HOURLY_REPLY_LIMIT})
        RETURNING hourly_reply_count AS count,
          group_hourly_reply_count AS group_count`;
      if (!claimed) {
        this.logger.log(
          `chat agent ${agent.id} is at its hourly ${inGroup ? 'group ' : ''}reply limit`,
        );
        return false;
      }
      if (claimed.count === HOURLY_REPLY_LIMIT) {
        activity(
          `hourly reply limit reached: ${agent.user.email} - ${agent.agentName} on ${agent.phoneNumber?.phoneNumber}`,
        );
      }
      if (inGroup && claimed.group_count === GROUP_HOURLY_REPLY_LIMIT) {
        activity(
          `hourly group reply limit reached: ${agent.user.email} - ${agent.agentName} on ${agent.phoneNumber?.phoneNumber}`,
        );
      }
      return true;
    } catch (err) {
      // A failed count mustn't silence the agent.
      this.logger.error(
        `counting chat agent ${agent.id}'s reply failed: ${(err as Error).message}`,
      );
      return true;
    }
  }

  // Hands back a reply claimed for a message that got no answer.
  private async releaseReply(agent: ReplyingAgent, inGroup: boolean) {
    if (!HOURLY_LIMITS_ON || noReplyLimit(agent)) return;
    await this.prisma.chatAgent
      .updateMany({
        where: {
          id: agent.id,
          hourlyReplyCount: { gt: 0 },
          ...(inGroup ? { groupHourlyReplyCount: { gt: 0 } } : {}),
        },
        data: {
          hourlyReplyCount: { decrement: 1 },
          ...(inGroup ? { groupHourlyReplyCount: { decrement: 1 } } : {}),
        },
      })
      .catch(() => undefined);
  }

  // What create_order does in this chat, when the owner has ordering on. An
  // "@lid" chat often arrives with no number, which the saved LID map may know.
  // A group takes no orders: an open order belongs to the thread, so two people
  // ordering there would change each other's order.
  private async ordersFor(
    agent: ReplyingAgent,
    chat: IncomingChat,
  ): Promise<ChatOrders | undefined> {
    if (!agent.orderEnabled || isGroupJid(chat.peerJid)) return undefined;
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

  // The files this agent can send in this chat. They live in their own database,
  // so trouble there is logged and the agent answers without them.
  private async filesFor(
    agent: ReplyingAgent,
    chat: IncomingChat,
  ): Promise<ChatFile[]> {
    try {
      const files = await this.files.listForReply(agent.id);
      return files.map((file, i) => ({
        // Short keys, so the model has no long id to copy wrongly.
        key: `file_${i + 1}`,
        name: file.file_name,
        description: file.description,
        send: () =>
          chat.sendFile({
            id: file.id,
            fileName: file.file_name,
            mimeType: file.mime_type,
            load: async () =>
              (await this.files.content(agent.id, file.id)).data,
          }),
      }));
    } catch (err) {
      this.logger.error(
        `chat agent ${agent.id} files lookup failed: ${(err as Error).message}`,
      );
      return [];
    }
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
    if (!turns.some((turn) => turn.role === 'assistant')) return undefined;
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
      return undefined;
    }
  }

  // The passages for this message from the agent's knowledge bases, as prompt
  // text. A failed lookup is logged and the agent answers from its prompt
  // alone: a thinner reply beats none.
  private async knowledgeFor(agent: ReplyingAgent, key: string, text: string) {
    const knowledgeBases = agent.knowledgeBases
      .map(({ knowledgeBase }) => knowledgeBase)
      .filter((kb) => kb.pineconeNamespace);
    if (!knowledgeBases.length) return '';
    if (!this.indexer.enabled) {
      this.logger.warn(
        `chat agent ${agent.id} has knowledge bases but the vector store isn't configured`,
      );
      return '';
    }
    try {
      const query = chatKnowledgeQuery(this.recent(key), text);
      return chatKnowledgePrompt(
        await this.indexer.search(knowledgeBases, query, CHAT_KNOWLEDGE_TOP_K),
      );
    } catch (err) {
      this.logger.error(
        `chat agent ${agent.id} knowledge lookup failed: ${(err as Error).message}`,
      );
      return '';
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

// Whether the agent's account is let off the hourly reply limits right now
// (users.no_reply_limit_until, set by hand). Checked again on release, so a
// reply that wasn't counted is never handed back.
function noReplyLimit(agent: ReplyingAgent): boolean {
  return onPaidPlan(agent.user);
}

// How long a reply waits for the home page before starting without it. The
// read carries on and lands in the reader's cache for the next message, and
// the model can still ask for the page itself.
const HOME_PAGE_WAIT_MS = 4000;

// The agent's website for this reply, when reading it is on and the address
// is one. An address that isn't, or a site that is down, never stops a reply.
async function websiteFor(agent: ChatAgent): Promise<ChatWebsite | undefined> {
  if (!agent.websiteEnabled) return undefined;
  const root = siteRoot(agent.websiteUrl);
  if (!root) return undefined;
  const wait = new AbortController();
  const home = await Promise.race([
    readWebsitePage(root).catch(() => undefined),
    delay(HOME_PAGE_WAIT_MS, undefined, { signal: wait.signal }).catch(
      () => undefined,
    ),
  ]);
  wait.abort();
  return { root, home };
}
