import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  apiError,
  ChatAgentInput,
  ChatAgentResource,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_STATUS,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_TEMPERATURE,
  MAX_CHAT_AGENTS_PER_USER,
  normalizeIds,
  normalizeNullable,
  PHONE_NUMBER_REQUIRED,
  toResource,
  withTools,
} from './chat-agents.types';

type Tx = Prisma.TransactionClient;

// The chat-agent rules of the Go server's internal/chatagents/repository.go:
// a per-account agent limit, a number owned by the caller and held by at most
// one agent, giving an agent a number takes it live, and an active agent
// always has a number.
@Injectable()
export class ChatAgentsService {
  private readonly logger = new Logger(ChatAgentsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, page: number, limit: number) {
    const [total, rows] = await Promise.all([
      this.prisma.chatAgent.count({ where: { userId } }),
      this.prisma.chatAgent.findMany({
        where: { userId },
        include: withTools,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return { total, agents: rows.map(toResource) };
  }

  async get(userId: string, id: string): Promise<ChatAgentResource> {
    const row = await this.prisma.chatAgent.findFirst({
      where: { id, userId },
      include: withTools,
    });
    if (!row) throw notFound();
    return toResource(row);
  }

  create(userId: string, req: ChatAgentInput): Promise<ChatAgentResource> {
    const a = req.agent!;
    return this.run('failed to create chat agent', async (tx) => {
      // Lock the user row so two concurrent creates can't both see room for
      // one more agent.
      await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${userId} FOR UPDATE`;
      if (
        (await tx.chatAgent.count({ where: { userId } })) >=
        MAX_CHAT_AGENTS_PER_USER
      ) {
        throw apiError(
          HttpStatus.FORBIDDEN,
          'you have reached the maximum number of chat agents for your account',
          'chat_agent_limit',
        );
      }

      const name = a.name!.trim();
      const phoneNumberId = normalizeNullable(a.phone_number_id);
      // An agent created with a number starts live unless the request says
      // otherwise: connecting a number is the activation.
      const status = a.status || (phoneNumberId ? 'active' : DEFAULT_STATUS);
      await ensureNameFree(tx, userId, name);
      await ensurePhoneNumberFree(tx, userId, phoneNumberId);
      ensureNoKnowledgeBases(req);
      const toolIds = await ownedToolIds(tx, userId, req.tools?.tool_ids);

      const row = await tx.chatAgent.create({
        data: {
          userId,
          agentName: name,
          phoneNumberId,
          status,
          modelProvider: DEFAULT_PROVIDER,
          modelName: DEFAULT_MODEL,
          temperature: req.model?.temperature ?? DEFAULT_TEMPERATURE,
          systemPrompt:
            req.prompt?.system_prompt?.trim() || DEFAULT_SYSTEM_PROMPT,
          tools: { create: attachmentRows(toolIds) },
        },
        include: withTools,
      });
      return toResource(row);
    });
  }

  update(
    userId: string,
    id: string,
    req: ChatAgentInput,
  ): Promise<ChatAgentResource> {
    return this.run('failed to update chat agent', async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM chat_agents WHERE id = ${id} AND user_id = ${userId} FOR UPDATE`;
      if (locked.length === 0) throw notFound();
      const current = await tx.chatAgent.findUniqueOrThrow({ where: { id } });

      const data: Prisma.ChatAgentUncheckedUpdateInput = {};
      const { agent: a, model: m } = req;

      // Check the state the agent ends up in, not just the fields sent: this
      // catches both activating an agent without a number and taking the
      // number away from an active one.
      let nextStatus = a?.status ?? current.status;
      let nextPhoneNumberId = current.phoneNumberId;
      if (a?.phone_number_id !== undefined) {
        nextPhoneNumberId = normalizeNullable(a.phone_number_id);
        // Giving the agent a number it didn't have takes it live; a status
        // sent in the same request still wins.
        if (
          !a.status &&
          nextPhoneNumberId &&
          nextPhoneNumberId !== current.phoneNumberId
        ) {
          nextStatus = 'active';
        }
      }
      if (nextStatus === 'active' && !nextPhoneNumberId) {
        throw apiError(HttpStatus.CONFLICT, PHONE_NUMBER_REQUIRED);
      }

      if (a?.name !== undefined) {
        data.agentName = a.name.trim();
        await ensureNameFree(tx, userId, data.agentName, id);
      }
      if (a?.phone_number_id !== undefined) {
        await ensurePhoneNumberFree(tx, userId, nextPhoneNumberId, id);
        data.phoneNumberId = nextPhoneNumberId;
      }
      if (nextStatus !== current.status) data.status = nextStatus;
      if (m?.provider !== undefined || m?.name !== undefined) {
        data.modelProvider = DEFAULT_PROVIDER;
        data.modelName = DEFAULT_MODEL;
      }
      if (m?.temperature !== undefined) data.temperature = m.temperature;
      if (req.prompt?.system_prompt !== undefined) {
        data.systemPrompt = req.prompt.system_prompt.trim();
      }
      ensureNoKnowledgeBases(req);
      // A tool_ids list replaces the attached set wholesale; leaving it out
      // keeps the set as it is.
      if (req.tools?.tool_ids !== undefined) {
        const toolIds = await ownedToolIds(tx, userId, req.tools.tool_ids);
        data.tools = { deleteMany: {}, create: attachmentRows(toolIds) };
      }

      // Always written, so updated_at moves even when only the attachment
      // lists were sent.
      data.updatedAt = new Date();
      const row = await tx.chatAgent.update({
        where: { id },
        data,
        include: withTools,
      });
      return toResource(row);
    });
  }

  async remove(userId: string, id: string) {
    const { count } = await this.prisma.chatAgent.deleteMany({
      where: { id, userId },
    });
    if (count === 0) throw notFound();
  }

  // Runs fn in a transaction and turns anything that isn't already an API
  // error into one: unique-index races into 409, the rest into a logged 500.
  private async run<T>(
    fallback: string,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(fn);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const detail = `${err.message} ${JSON.stringify(err.meta ?? {})}`;
        throw detail.includes('phone_number') ? phoneTaken() : nameTaken();
      }
      this.logger.error(`${fallback}: ${(err as Error).message}`);
      throw apiError(HttpStatus.INTERNAL_SERVER_ERROR, fallback);
    }
  }
}

// The checks below run inside the transaction so the API can name the
// problem; the unique indexes are still what guarantees it under a race.

async function ensureNameFree(
  tx: Tx,
  userId: string,
  name: string,
  selfId = '',
) {
  const taken = await tx.chatAgent.findFirst({
    where: { userId, agentName: name, NOT: { id: selfId } },
    select: { id: true },
  });
  if (taken) throw nameTaken();
}

// A number must belong to the caller (the foreign key alone would accept an
// id from another account) and can serve only one chat agent.
async function ensurePhoneNumberFree(
  tx: Tx,
  userId: string,
  phoneNumberId: string | null,
  selfId = '',
) {
  if (!phoneNumberId) return;
  const owned = await tx.phoneNumber.findFirst({
    where: { id: phoneNumberId, userId },
    select: { id: true },
  });
  if (!owned) throw apiError(HttpStatus.NOT_FOUND, 'phone number not found');
  const holder = await tx.chatAgent.findFirst({
    where: { phoneNumberId, NOT: { id: selfId } },
    select: { id: true },
  });
  if (holder) throw phoneTaken();
}

// Knowledge bases can't be attached to a chat agent on this server yet, so
// any id sent can't be found. An empty list just says "nothing attached".
function ensureNoKnowledgeBases(req: ChatAgentInput) {
  if (normalizeIds(req.knowledge_base?.knowledge_base_ids).length > 0) {
    throw apiError(HttpStatus.NOT_FOUND, 'knowledge base not found');
  }
}

// The requested tool ids, checked to all belong to the caller: the foreign
// key alone would accept another account's tool. One that isn't theirs reads
// the same as one that doesn't exist.
async function ownedToolIds(tx: Tx, userId: string, ids: string[] | undefined) {
  const wanted = normalizeIds(ids);
  if (!wanted.length) return wanted;
  const owned = await tx.tool.count({ where: { id: { in: wanted }, userId } });
  if (owned !== wanted.length) {
    throw apiError(HttpStatus.NOT_FOUND, 'tool not found');
  }
  return wanted;
}

// Join rows a millisecond apart, so the attachment order is the order sent.
function attachmentRows(toolIds: string[]) {
  const start = Date.now();
  return toolIds.map((toolId, i) => ({
    toolId,
    createdAt: new Date(start + i),
  }));
}

function notFound() {
  return apiError(HttpStatus.NOT_FOUND, 'chat agent not found');
}

function nameTaken() {
  return apiError(
    HttpStatus.CONFLICT,
    'a chat agent with this name already exists',
  );
}

function phoneTaken() {
  return apiError(
    HttpStatus.CONFLICT,
    'phone number is already assigned to another chat agent',
  );
}
