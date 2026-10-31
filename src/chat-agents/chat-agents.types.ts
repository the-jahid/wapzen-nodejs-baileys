import { HttpException, HttpStatus } from '@nestjs/common';
import type { ChatAgent, Prisma } from '../generated/prisma/client';

// Wire types and validation for /v1/chat-agents, ported from the Go server's
// internal/chatagents/types.go so both servers accept and answer the same.

// DEFAULT_PROVIDER and DEFAULT_MODEL are not just defaults: they are the only
// model a chat agent may use. Temperature is still stored and returned for
// the contract, but this model takes none, so it no longer changes a reply.
export const DEFAULT_STATUS = 'inactive';
export const DEFAULT_PROVIDER = 'openai';
export const DEFAULT_MODEL = 'gpt-5-nano';
export const DEFAULT_TEMPERATURE = 0.3;
export const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful, friendly WhatsApp chat assistant.';

// Account limit, enforced but never advertised: the dashboard learns about it
// only once it is reached. The reply allowance is per account, in
// users.ai_reply_limit.
export const MAX_CHAT_AGENTS_PER_USER = 1;

// The prompt is resent with every reply, so its length is capped (Go
// MaxSystemPromptChars). Counted in code points after trimming, as stored.
export const MAX_SYSTEM_PROMPT_CHARS = 8000;

export const PHONE_NUMBER_REQUIRED =
  'assign a phone number before activating the chat agent';

// A request body after parsing. A field that was omitted is undefined; only
// agent.phone_number_id can be null, which clears the number.
export type ChatAgentInput = {
  agent?: { name?: string; phone_number_id?: string | null; status?: string };
  model?: { provider?: string; name?: string; temperature?: number };
  prompt?: { system_prompt?: string };
  knowledge_base?: { knowledge_base_ids?: string[] };
  tools?: { tool_ids?: string[] };
};

// One chat agent as the API returns it (ChatAgentResource in the contract).
export type ChatAgentResource = {
  id: string;
  created_at: string;
  updated_at: string;
  agent: { name: string; phone_number_id: string | null; status: string };
  model: { provider: string; name: string; temperature: number };
  prompt: { system_prompt: string };
  knowledge_base: { knowledge_base_ids: string[] };
  tools: { tool_ids: string[] };
  // True once the account has sent every reply it is allowed. Read-only.
  reply_limit_reached: boolean;
};

// What a resource needs beyond the row: attached tools, in the order they were
// attached, and the owner's reply allowance.
export const resourceInclude = {
  tools: {
    select: { toolId: true },
    orderBy: [{ createdAt: 'asc' }, { toolId: 'asc' }],
  },
  user: { select: { aiReplyCount: true, aiReplyLimit: true } },
} satisfies Prisma.ChatAgentInclude;

export function toResource(
  row: ChatAgent & {
    tools: { toolId: string }[];
    user: { aiReplyCount: number; aiReplyLimit: number };
  },
): ChatAgentResource {
  return {
    id: row.id,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    agent: {
      name: row.agentName,
      phone_number_id: row.phoneNumberId,
      status: row.status,
    },
    model: {
      provider: row.modelProvider,
      name: row.modelName,
      temperature: row.temperature,
    },
    prompt: { system_prompt: row.systemPrompt },
    // Knowledge bases can't be attached to a chat agent on this server yet.
    knowledge_base: { knowledge_base_ids: [] },
    tools: { tool_ids: row.tools.map((t) => t.toolId) },
    reply_limit_reached: row.user.aiReplyCount >= row.user.aiReplyLimit,
  };
}

// An error in the { success, message } envelope the dashboard reads. code is
// a machine-readable reason, such as "chat_agent_limit".
export function apiError(status: HttpStatus, message: string, code?: string) {
  return new HttpException(
    { success: false, message, ...(code ? { data: { code } } : {}) },
    status,
  );
}

// Which fields each section takes and their JSON types. Unknown fields are
// refused, like the Go decoder's DisallowUnknownFields.
const SECTIONS: Record<string, Record<string, 'string' | 'number' | 'ids'>> = {
  agent: { name: 'string', phone_number_id: 'string', status: 'string' },
  model: { provider: 'string', name: 'string', temperature: 'number' },
  prompt: { system_prompt: 'string' },
  knowledge_base: { knowledge_base_ids: 'ids' },
  tools: { tool_ids: 'ids' },
};

export function parseInput(body: unknown): ChatAgentInput {
  const invalid = (reason: string) =>
    apiError(HttpStatus.BAD_REQUEST, `Invalid request body: ${reason}`);
  if (!isObject(body)) throw invalid('expected a JSON object');

  const input: Record<string, Record<string, unknown>> = {};
  for (const [section, value] of Object.entries(body)) {
    const fields = SECTIONS[section];
    if (!fields) throw invalid(`unknown field "${section}"`);
    if (value === null) continue;
    if (!isObject(value)) throw invalid(`${section} must be an object`);

    const parsed: Record<string, unknown> = {};
    for (const [field, raw] of Object.entries(value)) {
      const type = fields[field];
      if (!type) throw invalid(`unknown field "${section}.${field}"`);
      if (raw === null) {
        // null clears the phone number; anywhere else it means "not sent".
        if (field === 'phone_number_id') parsed[field] = null;
        continue;
      }
      const ok =
        type === 'ids'
          ? Array.isArray(raw) && raw.every((id) => typeof id === 'string')
          : typeof raw === type;
      if (!ok) {
        const expected = type === 'ids' ? 'an array of strings' : `a ${type}`;
        throw invalid(`${section}.${field} must be ${expected}`);
      }
      parsed[field] = raw;
    }
    input[section] = parsed;
  }
  return input;
}

export function validateCreate(req: ChatAgentInput): void {
  const a = req.agent;
  if (!a || !a.name?.trim()) throw badRequest('agent.name is required');
  validateStatus(a.status);
  if (
    (a.status || DEFAULT_STATUS) === 'active' &&
    !normalizeNullable(a.phone_number_id)
  ) {
    throw badRequest(PHONE_NUMBER_REQUIRED);
  }
  if (req.model) validateModel(req.model);
  const system = req.prompt?.system_prompt;
  if (system && !system.trim()) {
    throw badRequest('prompt.system_prompt cannot be empty');
  }
  validatePromptLength(system);
}

export function validateUpdate(req: ChatAgentInput): void {
  const { agent: a, model: m } = req;
  const hasChanges =
    (a &&
      (a.name !== undefined ||
        a.phone_number_id !== undefined ||
        a.status !== undefined)) ||
    (m &&
      (m.provider !== undefined ||
        m.name !== undefined ||
        m.temperature !== undefined)) ||
    req.prompt?.system_prompt !== undefined ||
    req.knowledge_base?.knowledge_base_ids !== undefined ||
    req.tools?.tool_ids !== undefined;
  if (!hasChanges) throw badRequest('at least one setting is required');

  if (a?.name !== undefined && !a.name.trim()) {
    throw badRequest('agent.name cannot be empty');
  }
  validateStatus(a?.status);
  if (m) validateModel(m);
  // Unlike create, where "" means "use the default", an update can't blank it.
  const system = req.prompt?.system_prompt;
  if (system !== undefined && !system.trim()) {
    throw badRequest('prompt.system_prompt cannot be empty');
  }
  validatePromptLength(system);
}

function validatePromptLength(system: string | undefined) {
  if (system && [...system.trim()].length > MAX_SYSTEM_PROMPT_CHARS) {
    throw badRequest(
      `prompt.system_prompt must be at most ${MAX_SYSTEM_PROMPT_CHARS} characters`,
    );
  }
}

function validateStatus(status: string | undefined) {
  if (status && status !== 'active' && status !== 'inactive') {
    throw badRequest('agent.status must be active or inactive');
  }
}

// Only the fixed model is accepted; provider and name may be omitted but
// cannot name anything else.
function validateModel(m: NonNullable<ChatAgentInput['model']>) {
  if (m.provider && m.provider !== DEFAULT_PROVIDER) {
    throw badRequest(`model.provider must be ${DEFAULT_PROVIDER}`);
  }
  if (m.name && m.name.trim() !== DEFAULT_MODEL) {
    throw badRequest(`model.name must be ${DEFAULT_MODEL}`);
  }
  if (
    m.temperature !== undefined &&
    (m.temperature < 0.1 || m.temperature > 1)
  ) {
    throw badRequest('model.temperature must be between 0.1 and 1');
  }
}

// Trimmed id, or null for a missing or blank one.
export function normalizeNullable(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

// Trimmed, de-duplicated ids with blanks dropped.
export function normalizeIds(ids: string[] | undefined): string[] {
  return [...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean))];
}

function badRequest(message: string) {
  return apiError(HttpStatus.BAD_REQUEST, message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
