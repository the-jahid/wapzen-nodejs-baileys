import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
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
import { ChatMemoryService } from '../chat-memory/chat-memory.service';
import {
  gapNote,
  rowMessages,
  threadIdFor,
  type Transcript,
} from '../chat-memory/transcript';
import {
  appendMessage,
  chatTranscript,
  ensureConversation,
  messagesBetween,
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
  withoutOrderRecords,
  type OrderField,
} from '../orders/order-tool';
import { orderNotice } from '../orders/order-notice';
import { OrdersService, type OrderResult } from '../orders/orders.service';
import { toE164 } from '../orders/orders.types';
import { PrismaService, TX_OPTIONS } from '../prisma/prisma.service';
import type { ChatWebsite } from '../tools/chat-toolbox';
import { readWebsitePage, siteRoot } from '../website/website-reader';
import { isGroupJid } from './group-chat';
import {
  type ChatHumanHelp,
  HumanAlertLog,
  humanAlertNotice,
} from './human-alert';
import { LoopGuard } from './loop-guard';
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
  CHAT_TRANSCRIPT_MESSAGES,
  createConfirmationCheck,
  createReplyAgent,
  REPLY_RULES,
  type ReplyContext,
} from './reply-agent';
import {
  type ChatOwnerSends,
  createOwnerSendLookup,
  detailsKey,
  ownerSendNotice,
} from './owner-send';
import { createLanguageGuard } from './reply-language';
import { toWhatsAppFormat } from './whatsapp-format';

// People often send one thought as several quick messages. Each waits this
// long for the next before the agent answers them all as one, so two replies
// never cross. MAX_BURST_WAIT_MS caps the wait for someone who keeps typing.
const BURST_QUIET_MS = 2_000;
const MAX_BURST_WAIT_MS = 8_000;

// The most saved messages read at once for a chat whose memory is far behind.
const MAX_OLDER_MESSAGES = 400;
// Added to the owner's prompt in a group only: there, several people share one
// chat, and the agent only hears from them when they tag it.
const GROUP_CHAT_NOTE =
  "This chat is a WhatsApp group. Each message starts with the name of the person who wrote it, and you only see the messages that tag you or reply to you. Answer the person who wrote to you, by name when it's clear who you're talking to.";

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
  // Sends a text from the same number to someone else, by phone number (E.164),
  // such as the owner's order alerts. Absent in groups, which take no orders.
  sendTo?: (phone: string, text: string) => Promise<unknown>;
  sendFile: (file: OutgoingFile) => Promise<unknown>;
  setTyping: (typing: boolean) => Promise<unknown>;
  // When it reached this server (set by respond), for the loop guard's speed
  // rule: how fast it came after the agent's reply.
  receivedAt?: number;
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
// on, through a LangChain agent (reply-agent.ts). What was said is read from
// chat_messages, the readable record of every thread; the agent's own short-term
// memory (chat-memory) keeps each chat's latest messages and a summary of the
// older ones, so it survives a restart.
@Injectable()
export class ChatResponderService {
  private readonly logger = new Logger(ChatResponderService.name);
  private readonly bursts = new Map<string, Burst>();
  // Catches an agent caught replying to another bot (loop-guard.ts).
  private readonly loops = new LoopGuard();
  // When each chat last asked for a person (human-alert.ts).
  private readonly humanAlerts = new HumanAlertLog();
  // What each chat had sent to the owner's numbers (owner-send.ts).
  private readonly ownerSendLog = new HumanAlertLog();
  // Chats whose order the owner's number was alerted to lately.
  private readonly orderAlerts = new HumanAlertLog();
  private ownerSendLookup?: ReturnType<typeof createOwnerSendLookup>;
  // The agent with its memory, and the one that answers without any. The first
  // is made again if the store changes: it is ready a moment after the start.
  private agent?: ReturnType<typeof createReplyAgent>;
  private agentSaver?: ChatMemoryService['saver'];
  private memorylessAgent?: ReturnType<typeof createReplyAgent>;
  private confirmationCheck?: ReturnType<typeof createConfirmationCheck>;
  private languageGuard?: ReturnType<typeof createLanguageGuard>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly indexer: IndexerService,
    private readonly orders: OrdersService,
    private readonly files: AgentFilesService,
    @Optional() private readonly memory?: ChatMemoryService,
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
    burst.waiting.push({ ...chat, receivedAt: chat.receivedAt ?? now });
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

    // A one-to-one chat that looks like two bots answering each other stops
    // here, mid-loop: no reply, and the AI goes off for that contact, the
    // same switch a person flips in the dashboard, so the owner sees it and
    // can turn it back on. Groups have their own reply limit. The speed rule
    // times the burst by its last message, and only when all of it was typed.
    const loopKey = `${phoneNumberId}|${peerJid}`;
    const loop =
      !aiOff && !isGroupJid(peerJid)
        ? this.loops.incoming(loopKey, chat.text, Date.now(), {
            sentAt: Math.max(...chats.map((c) => c.receivedAt ?? Date.now())),
            typed: chats.every((c) => !c.media),
          })
        : undefined;

    let reply = '';
    if (loop) {
      this.logger.warn(
        `chat agent ${agent.id} stopped an AI loop (${loop}) with ${peerJid}`,
      );
      activity(
        `AI loop stopped (${loop}): ${agent.user.email} - ${agent.agentName} on ${agent.phoneNumber?.phoneNumber} with ${chat.peerPhone ?? peerJid}`,
      );
    } else if (!aiOff) {
      reply = await this.replyAs(agent, chat);
      if (reply) this.loops.replied(loopKey, reply);
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
    // After the turn is saved, so the thread exists to switch off.
    if (loop) {
      await this.prisma.chatConversation
        .updateMany({
          where: { phoneNumberId, peerJid },
          data: { aiReplyEnabled: false },
        })
        .catch((err: Error) =>
          this.logger.error(
            `switching off AI for a loop with ${peerJid} failed: ${err.message}`,
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
      chatAgentId,
    ).catch((err: Error) => {
      if (!/unique/i.test(err.message)) {
        this.logger.error(
          `saving a message sent from the phone failed: ${err.message}`,
        );
      }
    });
  }

  // Answers as the agent and returns what was sent, or '' when nothing was.
  private async replyAs(agent: ReplyingAgent, chat: ReadChat) {
    // Replies come from Claude; OpenAI is only used to transcribe voice notes.
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey) {
      this.logger.warn(
        `ANTHROPIC_API_KEY is not set; chat agent ${agent.id} can't reply`,
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

    let sent = false;
    try {
      await chat.setTyping(true).catch(() => undefined);

      const [orders, files, website, ownerSends, transcript] =
        await Promise.all([
          this.ordersFor(agent, chat),
          this.filesFor(agent, chat),
          websiteFor(agent),
          this.ownerSendsFor(apiKey, agent, chat),
          this.transcriptFor(agent, chat),
        ]);
      const humanHelp = this.humanHelpFor(agent, chat);
      const toolbox = ChatToolbox.for(
        agent.tools.map((t) => t.tool),
        agent.id,
        chat.send,
        orders,
        files,
        website,
        humanHelp,
        ownerSends,
      );
      // The language the owner set, read from the prompt once and remembered:
      // it runs alongside everything up to the reply, so it adds no wait.
      const language = this.replyLanguage(apiKey, agent);
      // Both ask a different service before the reply can start, so they run
      // together.
      const [knowledge, check] = await Promise.all([
        this.knowledgeFor(agent, transcript, chat.text),
        !!toolbox?.takesOrders &&
          this.orderConfirmed(
            apiKey,
            transcript,
            chat.text,
            agent,
            toolbox.orderFields,
          ),
      ]);
      // What the owner set up: the agent's prompt, their order instructions
      // with order taking on, and passages from attached knowledge bases. The
      // one line added for every agent is the date and time, in the zone of
      // the agent's number. A group gets a note on how to read it. The date
      // and the passages change with every message, so they don't go in the
      // prompt, which Claude caches: they go after the new message
      // (turnNotes), leaving the prompt and the chat before it cached.
      const prompt = [
        agent.systemPrompt.trim(),
        toolbox?.takesOrders ? agent.orderInstructions.trim() : '',
        toolbox?.orderRecordPrompt ?? '',
        toolbox?.filesPrompt ?? '',
        toolbox?.websitePrompt ?? '',
        toolbox?.humanHelpPrompt ?? '',
        toolbox?.ownerSendPrompt ?? '',
        isGroupJid(chat.peerJid) ? GROUP_CHAT_NOTE : '',
        REPLY_RULES,
      ]
        .filter(Boolean)
        .join('\n\n');
      const now = new Date();
      const turnNotes = [
        dateContext(now, zoneForPhone(agent.phoneNumber?.phoneNumber)),
        gapNote(transcript.rows.at(-1)?.at, now),
        knowledge,
      ]
        .filter(Boolean)
        .join('\n\n');
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
      const messages = [...rowMessages(transcript.rows), incoming];
      if (check) {
        if (check.confirmed) toolbox!.confirmOrder();
        toolbox!.noteMissing(check.missing);
      }
      const generated = await this.generate(
        apiKey,
        agent,
        transcript,
        messages,
        {
          prompt,
          turnNotes,
          incomingId: incoming.id,
          toolbox,
          requiredTool: check && check.confirmed ? ORDER_FUNCTION : undefined,
        },
      );
      // An order must never be placed in silence.
      const orderNumber = await toolbox?.placedOrderNumber();
      const reply = toWhatsAppFormat(
        await this.inOwnerLanguage(
          apiKey,
          agent,
          (toolbox?.withoutFileMarks(generated) ?? generated) ||
            (orderNumber ? `Your order #${orderNumber} is placed.` : ''),
          await language,
        ),
      );
      const sentFiles = toolbox?.sentFiles ?? [];
      if (!reply && !sentFiles.length) {
        this.logger.warn(`chat agent ${agent.id} answered with no text`);
        activity(
          `AI reply empty: ${agent.user.email} - ${agent.agentName} on ${agent.phoneNumber?.phoneNumber}`,
        );
        return '';
      }

      await chat.setTyping(false).catch(() => undefined);
      if (reply) await chat.send(reply);
      sent = true;
      // The trial's last reply went out: the agent stops now, so the
      // dashboard says so before the next message comes.
      if (trialCount === FREE_TRIAL_REPLIES) await this.endTrial(agent);
      // The record says which files went out, what was passed to the team and
      // which order was placed, or the agent would forget, and send or place
      // them again or take them back. The customer already has the files, and
      // gets none of these lines.
      const record = [
        ...sentFiles.map((name) => `${FILE_SENT_MARK} ${name}`),
        ...(toolbox?.doneRecords ?? []),
        reply,
      ]
        .filter(Boolean)
        .join('\n');
      this.logger.log(`chat agent ${agent.id} replied to ${chat.peerJid}`);
      activity(
        `AI replied: ${agent.user.email} - ${agent.agentName} on ${agent.phoneNumber?.phoneNumber}`,
      );
      return record;
    } catch (err) {
      this.logger.error(
        `chat agent ${agent.id} reply failed: ${(err as Error).message}`,
      );
      // An unanswered customer is what the owner notices, so the reason goes
      // in the activity log, the part of the log that's always printed.
      activity(
        `AI reply failed: ${agent.user.email} - ${agent.agentName} on ${agent.phoneNumber?.phoneNumber}: ${(err as Error).message}`,
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
      const [stamped] = await this.prisma.$transaction(
        [
          this.prisma.user.updateMany({
            where: { id: agent.userId, trialEndedAt: null },
            data: { trialEndedAt: new Date() },
          }),
          this.prisma.chatAgent.updateMany({
            where: { userId: agent.userId, status: 'active' },
            data: { status: 'inactive', updatedAt: new Date() },
          }),
        ],
        TX_OPTIONS,
      );
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
      place: async (args, fields) => {
        const result = await this.orders.place(
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
        );
        this.alertOwner(agent, chat, result);
        return result;
      },
    };
  }

  // Tells the owner's order-alert number about an order just placed or
  // changed, from the agent's own number. It runs beside the reply, so the
  // customer never waits for it, and a failure is only logged: the order
  // stands either way and is on the dashboard. An order the chat already had
  // (already_placed) changed nothing, so it isn't sent again.
  private alertOwner(
    agent: ReplyingAgent,
    chat: IncomingChat,
    result: OrderResult,
  ) {
    if (!result.success || result.already_placed || !chat.sendTo) return;
    if (!agent.orderNotifyPhone.trim()) return;
    const to = toE164(agent.orderNotifyPhone, agent.phoneNumber?.phoneNumber);
    const label = `${agent.user.email} - #${result.order_number} by ${agent.agentName}`;
    if (!to) {
      activity(`order alert skipped (not a phone number): ${label}`);
      return;
    }
    const key = `${agent.id}|${chat.phoneNumberId}|${chat.peerJid}|${to}`;
    this.orderAlerts.claim(key);
    const sendTo = chat.sendTo;
    void (async () => {
      const order = await this.orders.get(agent.userId, result.order_id);
      await sendTo(
        to,
        orderNotice(order, {
          updated: !!result.updated,
          agentName: agent.agentName,
        }),
      );
      activity(`order alert sent: ${label}`);
    })().catch((err: Error) => {
      this.orderAlerts.release(key);
      activity(`order alert failed: ${label}: ${err.message}`);
    });
  }

  // What call_human does in this chat, when the owner switched it on and
  // described when to bring a person in. It messages their number when they
  // gave one and turns the AI off when they asked; with neither there's nothing
  // to do. Not in groups: a group isn't one customer to hand over.
  private humanHelpFor(
    agent: ReplyingAgent,
    chat: IncomingChat,
  ): ChatHumanHelp | undefined {
    // A row read before the columns existed has none of them.
    if (agent.humanInterventionEnabled !== true) return undefined;
    const when = (agent.humanInterventionDescription ?? '').trim();
    const raw = (agent.humanInterventionPhone ?? '').trim();
    if (!when || isGroupJid(chat.peerJid)) return undefined;
    const to = raw ? toE164(raw, agent.phoneNumber?.phoneNumber) : null;
    const sendTo = to ? chat.sendTo : undefined;
    const pausesAi = agent.humanInterventionPauseAi === true;
    if (!sendTo && !pausesAi) return undefined;
    return {
      when,
      pausesAi,
      call: async (reason, details) => {
        const key = `${agent.id}|${chat.phoneNumberId}|${chat.peerJid}`;
        const content = detailsKey(details);
        if (!this.humanAlerts.claim(key, Date.now(), content)) return 'recent';
        const label = `${agent.user.email} - ${agent.agentName}`;
        if (!sendTo || !to) {
          // No number: the red flag on the dashboard is the call.
          await this.pauseForHuman(agent, chat, label);
          return 'sent';
        }
        try {
          const [{ peerPhone }] = await resolvePeerPhones(this.prisma, [
            {
              phoneNumberId: chat.phoneNumberId,
              peerJid: chat.peerJid,
              peerPhone: chat.peerPhone ?? null,
            },
          ]);
          await sendTo(
            to,
            humanAlertNotice({
              agentName: agent.agentName,
              customerName: chat.peerName,
              customerPhone: peerPhone,
              reason,
              details,
              lastMessage: chat.text,
              aiPaused: pausesAi,
            }),
          );
        } catch (err) {
          this.humanAlerts.release(key, content);
          activity(`human alert failed: ${label}: ${(err as Error).message}`);
          throw err;
        }
        activity(`human alert sent: ${label}`);
        // The same details to the same number needn't go by send_to_team too.
        if (content) {
          this.ownerSendLog.claim(`${key}|${to}`, Date.now(), content);
        }
        if (pausesAi) await this.pauseForHuman(agent, chat, label);
        return 'sent';
      },
    };
  }

  // What send_to_team does in this chat, when the owner's text asks for
  // information to be sent to a number (owner-send.ts). "My WhatsApp" with no
  // number written is the one saved on the Human Intervention card, or else the
  // order-alert number. A chat whose order was just placed already went to that
  // one, and changes to it go there too, so it isn't sent there twice. Not in groups. A failed lookup is logged and
  // the agent answers without it.
  private async ownerSendsFor(
    apiKey: string,
    agent: ReplyingAgent,
    chat: IncomingChat,
  ): Promise<ChatOwnerSends | undefined> {
    const { sendTo } = chat;
    if (!sendTo || isGroupJid(chat.peerJid)) return undefined;
    const agentPhone = agent.phoneNumber?.phoneNumber;
    const takesOrders =
      agent.orderEnabled && agent.tools.some((t) => t.tool.type === 'order');
    const humanPhone =
      agent.humanInterventionEnabled === true
        ? (agent.humanInterventionPhone ?? '').trim()
        : '';
    const orderPhone = takesOrders ? (agent.orderNotifyPhone ?? '').trim() : '';
    const ordersTo = orderPhone ? toE164(orderPhone, agentPhone) : null;
    try {
      this.ownerSendLookup ??= createOwnerSendLookup(apiKey);
      const list = await this.ownerSendLookup(
        [agent.systemPrompt, takesOrders ? agent.orderInstructions : '']
          .filter(Boolean)
          .join('\n\n'),
        {
          agentPhone,
          savedPhone: humanPhone ? toE164(humanPhone, agentPhone) : ordersTo,
        },
      );
      if (!list.length) return undefined;
      return {
        list,
        send: async (to, details, note) => {
          const key = `${agent.id}|${chat.phoneNumberId}|${chat.peerJid}|${to.phone}`;
          const content = detailsKey(details) || note;
          const label = `${agent.user.email} - ${agent.agentName}`;
          if (this.orderAlerts.isOpen(key)) return 'already';
          if (!this.ownerSendLog.claim(key, Date.now(), content)) {
            if (this.ownerSendLog.has(key, content)) return 'already';
            activity(`info send skipped (too many in this chat): ${label}`);
            throw new Error('too many sends in this chat');
          }
          try {
            const [{ peerPhone }] = await resolvePeerPhones(this.prisma, [
              {
                phoneNumberId: chat.phoneNumberId,
                peerJid: chat.peerJid,
                peerPhone: chat.peerPhone ?? null,
              },
            ]);
            await sendTo(
              to.phone,
              ownerSendNotice({
                agentName: agent.agentName,
                customerName: chat.peerName,
                customerPhone: peerPhone,
                details,
                note,
              }),
            );
          } catch (err) {
            this.ownerSendLog.release(key, content);
            activity(`info send failed: ${label}: ${(err as Error).message}`);
            throw err;
          }
          activity(`info sent to the owner's number: ${label}`);
          return 'sent';
        },
      };
    } catch (err) {
      this.logger.warn(
        `reading what chat agent ${agent.id} sends on failed: ${(err as Error).message}`,
      );
      return undefined;
    }
  }

  // After a sent alert, with the owner's say-so: the AI stops replying to this
  // customer, exactly as the Conversations page switch does, so a person takes
  // over, and the conversation is flagged red ("Human needed") until the AI is
  // switched back on. The reply being written now still goes out. The thread is made if
  // it's the customer's first message, since the turn is saved only after the
  // reply. A failure is logged and the AI simply stays on.
  private async pauseForHuman(
    agent: ReplyingAgent,
    chat: IncomingChat,
    label: string,
  ) {
    try {
      const id = await ensureConversation(this.prisma, {
        userId: agent.userId,
        phoneNumberId: chat.phoneNumberId,
        chatAgentId: agent.id,
        peerJid: chat.peerJid,
        peerPhone: chat.peerPhone,
        peerName: chat.peerName,
      });
      await this.prisma.chatConversation.update({
        where: { id },
        data: { aiReplyEnabled: false, needsAttention: true },
      });
      activity(`AI handed a chat to a person: ${label}`);
    } catch (err) {
      this.logger.error(
        `turning AI off for ${chat.peerJid} after a human alert failed: ${(err as Error).message}`,
      );
    }
  }

  // The files this agent can send in this chat. Trouble reading them is logged
  // and the agent answers without them.
  private async filesFor(
    agent: ReplyingAgent,
    chat: IncomingChat,
  ): Promise<ChatFile[]> {
    // Switched off on the Images & Files card. A row read before the column
    // existed has none, which means on.
    if (agent.filesEnabled === false) return [];
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

  // The language every reply of this agent must be in, or '' when its owner
  // set none or the lookup failed: a failed lookup must never stop a reply.
  private async replyLanguage(apiKey: string, agent: ReplyingAgent) {
    try {
      this.languageGuard ??= createLanguageGuard(apiKey);
      return await this.languageGuard.languageOf(agent.systemPrompt);
    } catch (err) {
      this.logger.warn(
        `reading chat agent ${agent.id}'s reply language failed: ${(err as Error).message}`,
      );
      return '';
    }
  }

  // The reply, rewritten in the owner's language when it came out in another
  // one. A failed rewrite sends the reply as it was.
  private async inOwnerLanguage(
    apiKey: string,
    agent: ReplyingAgent,
    reply: string,
    language: string,
  ) {
    if (!reply || !language) return reply;
    try {
      this.languageGuard ??= createLanguageGuard(apiKey);
      const fixed = await this.languageGuard.inLanguage(reply, language);
      if (fixed.rewritten) {
        this.logger.log(
          `chat agent ${agent.id} replied outside ${language}; rewritten`,
        );
      }
      return fixed.text;
    } catch (err) {
      this.logger.warn(
        `rewriting chat agent ${agent.id}'s reply in ${language} failed: ${(err as Error).message}`,
      );
      return reply;
    }
  }

  // Whether this message agrees to an order the agent has set out, which has
  // to have happened in an earlier reply. If the check fails the reply carries
  // on without it, and the customer's next message gets another chance.
  private async orderConfirmed(
    apiKey: string,
    { rows: turns }: Transcript,
    text: string,
    agent: ReplyingAgent,
    fields: OrderField[],
  ) {
    if (!turns.some((turn) => turn.role === 'assistant')) return undefined;
    this.confirmationCheck ??= createConfirmationCheck(apiKey);
    try {
      return await this.confirmationCheck(
        // The check reads a line with an order number as nothing waiting for a
        // yes, so the record lines stay out of it.
        turns.map((turn) => ({
          ...turn,
          text: withoutOrderRecords(turn.text),
        })),
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
  private async knowledgeFor(
    agent: ReplyingAgent,
    { rows }: Transcript,
    text: string,
  ) {
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
      const query = chatKnowledgeQuery(rows, text);
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

  // Asks the agent for the reply, on the chat's own memory thread when there is
  // a store to keep it in. A contact's first message has no thread yet, and
  // nothing to remember either.
  private async generate(
    apiKey: string,
    agent: ReplyingAgent,
    { conversationId, rows }: Transcript,
    messages: BaseMessage[],
    context: ReplyContext,
  ) {
    const saver = this.memory?.saver;
    if (!saver || !conversationId) {
      this.memorylessAgent ??= createReplyAgent(apiKey);
      const result = await this.memorylessAgent.invoke(
        { messages },
        { context },
      );
      return result.reply;
    }
    if (!this.agent || this.agentSaver !== saver) {
      this.agent = createReplyAgent(apiKey, saver);
      this.agentSaver = saver;
    }
    const result = await this.agent.invoke(
      { messages },
      {
        configurable: { thread_id: threadIdFor(conversationId, agent.id) },
        // Saved once, when the reply is written: a run is never resumed.
        durability: 'exit',
        context: {
          ...context,
          // Only a saved memory can be far behind and worth catching up.
          older:
            !this.memory?.saved || rows.length < CHAT_TRANSCRIPT_MESSAGES
              ? undefined
              : {
                  beforeSeq: rows[0].seq,
                  load: (afterSeq) =>
                    messagesBetween(
                      this.prisma,
                      conversationId,
                      agent.id,
                      afterSeq,
                      rows[0].seq,
                      MAX_OLDER_MESSAGES,
                    ),
                },
        },
      },
    );
    return result.reply;
  }

  // The chat so far, as saved: only this agent's own, so an agent newly put on a
  // number starts every chat fresh. A failed read is logged and the reply goes
  // ahead without it.
  private async transcriptFor(
    agent: ReplyingAgent,
    chat: IncomingChat,
  ): Promise<Transcript> {
    try {
      return await chatTranscript(
        this.prisma,
        chat.phoneNumberId,
        chat.peerJid,
        agent.id,
        this.memory?.saved ? CHAT_TRANSCRIPT_MESSAGES : CHAT_REMEMBER_MESSAGES,
      );
    } catch (err) {
      this.logger.error(
        `loading the chat with ${chat.peerJid} failed: ${(err as Error).message}`,
      );
      return { rows: [] };
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
