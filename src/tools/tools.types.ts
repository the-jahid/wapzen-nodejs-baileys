import { HttpException, HttpStatus } from '@nestjs/common';
import type { Tool } from '../generated/prisma/client';
import { DEFAULT_ORDER_FIELDS, type OrderField } from '../orders/order-tool';

// Wire types and validation for /v1/tools, ported from the Go server's
// handlers/tool_handler.go and models/tool.go so both servers accept and
// answer the same. Chat only: end_call and transfer_call release a phone
// call, so the only types are the two a chat can run. The third type stored,
// 'order', is the built-in Take Order tool: it can be listed but not created.

export const TOOL_TYPES = ['api_request', 'send_text'] as const;
export type ToolType = (typeof TOOL_TYPES)[number];
export const LISTED_TOOL_TYPES = [...TOOL_TYPES, 'order'];

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
export const PARAMETER_TYPES = ['string', 'number', 'boolean'];

export const LIST_PATH = '/v1/tools';
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

export const MAX_DESCRIPTION_LENGTH = 1000;
export const DEFAULT_TIMEOUT_SECONDS = 20;
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 60;
const MAX_HEADERS = 20;
const MAX_PARAMETERS = 20;
const MAX_PARAMETER_NAME_LENGTH = 64;
const MAX_URL_LENGTH = 2000;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_ORDER_FIELDS = 20;
const MAX_ORDER_FIELD_LABEL_LENGTH = 60;
const MAX_ORDER_FIELD_KEY_LENGTH = 40;

// Mirrors the tools.tool_name CHECK: what both OpenAI and Anthropic accept as
// a function name. Checked here so a bad name is a field error, not a 500.
const NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
// The function the built-in Take Order tool reaches the model as.
const RESERVED_NAME = 'create_order';
// What the model sees an order field as, so it must suit a parameter name.
const ORDER_FIELD_KEY = /^[a-z][a-z0-9_]*$/;

export type ToolParameter = {
  name: string;
  type: string;
  description: string;
  required: boolean;
};

export type ToolHeader = { key: string; value: string };

export type ApiRequestConfig = {
  method: string;
  url: string;
  timeout_seconds: number;
  async: boolean;
  headers: ToolHeader[];
  parameters: ToolParameter[];
};

export type SendTextConfig = { body: string };

export type FieldError = { field: string; message: string };

// A request body after parsing. A field that was omitted is undefined.
export type ToolInput = {
  type?: string;
  name?: string;
  description?: string;
  api_request?: ApiRequestConfig;
  send_text?: SendTextConfig;
};

// A stored tool with its configuration decoded onto the block for its type.
export type ResolvedTool = {
  id: string;
  type: string;
  name: string;
  description: string;
  isSystem: boolean;
  apiRequest?: ApiRequestConfig;
  sendText?: SendTextConfig;
  orderFields?: OrderField[];
};

// Tool in the contract. Only the block matching the type is present, so a
// resource never advertises settings that have no effect on it.
export function toResource(
  row: Tool & { attachments?: { chatAgentId: string }[] },
) {
  const tool = resolve(row);
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    description: row.description,
    key: row.key,
    is_system: row.isSystem,
    chat_agent_ids: (row.attachments ?? []).map((a) => a.chatAgentId),
    ...(tool.apiRequest ? { api_request: tool.apiRequest } : {}),
    ...(tool.sendText ? { send_text: tool.sendText } : {}),
    ...(tool.orderFields ? { order: { fields: tool.orderFields } } : {}),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

// Decodes the config column onto the block matching the row's type. Arrays
// and the timeout are defaulted so an older or partial block still runs.
export function resolve(row: Tool): ResolvedTool {
  const config = (isObject(row.config) ? row.config : {}) as Record<
    string,
    unknown
  >;
  const tool: ResolvedTool = {
    id: row.id,
    type: row.type,
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
  };
  if (row.type === 'api_request') {
    tool.apiRequest = {
      method: normalizeMethod(config.method as string),
      url: (config.url as string) ?? '',
      timeout_seconds:
        (config.timeout_seconds as number) > 0
          ? (config.timeout_seconds as number)
          : DEFAULT_TIMEOUT_SECONDS,
      async: config.async === true,
      headers: (config.headers as ToolHeader[]) ?? [],
      parameters: (config.parameters as ToolParameter[]) ?? [],
    };
  } else if (row.type === 'send_text') {
    tool.sendText = { body: (config.body as string) ?? '' };
  } else if (row.type === 'order') {
    tool.orderFields =
      (config.fields as OrderField[] | undefined) ?? DEFAULT_ORDER_FIELDS;
  }
  return tool;
}

// An error in the { success, message } envelope the dashboard reads.
export function apiError(status: HttpStatus, message: string) {
  return new HttpException({ success: false, message }, status);
}

// A 400 listing what is wrong with each field.
export function validationFailed(
  errors: FieldError[],
  message = 'Validation failed',
) {
  return new HttpException(
    { success: false, message, errors },
    HttpStatus.BAD_REQUEST,
  );
}

export function notFound() {
  return apiError(HttpStatus.NOT_FOUND, 'tool not found');
}

export function nameTaken() {
  return apiError(HttpStatus.CONFLICT, 'a tool with this name already exists');
}

export function systemTool() {
  return apiError(
    HttpStatus.FORBIDDEN,
    "this is a built-in tool: it can't be edited or deleted. Set its order instructions on the agent",
  );
}

// The body of PUT /:tool_id/order-fields: the whole list, in order. A field
// without a key is new and gets one from its label, so typing a built-in
// field's name back in restores that field.
export function parseOrderFields(body: unknown): OrderField[] {
  const raw = requireObject(body).fields;
  if (!Array.isArray(raw)) throw invalidBody();
  const fields = raw.map((f: unknown) => {
    if (!isObject(f)) throw invalidBody();
    return {
      key: optional(f, 'key', 'string')?.trim() ?? '',
      label: (optional(f, 'label', 'string') ?? '').replace(/\s+/g, ' ').trim(),
      required: optional(f, 'required', 'boolean') ?? false,
    };
  });

  const errors: FieldError[] = [];
  if (!fields.length || fields.length > MAX_ORDER_FIELDS) {
    errors.push({
      field: 'fields',
      message: `keep between 1 and ${MAX_ORDER_FIELDS} fields`,
    });
  }
  const labels = new Set<string>();
  const keys = new Set<string>();
  fields.forEach((f, i) => {
    const field = `fields[${i}]`;
    if (!f.label || f.label.length > MAX_ORDER_FIELD_LABEL_LENGTH) {
      errors.push({
        field: `${field}.label`,
        message: `a field needs a name of at most ${MAX_ORDER_FIELD_LABEL_LENGTH} characters`,
      });
    } else if (labels.has(f.label.toLowerCase())) {
      errors.push({
        field: `${field}.label`,
        message: `there are two fields named ${f.label}`,
      });
    }
    labels.add(f.label.toLowerCase());
    if (!f.key) return;
    if (
      !ORDER_FIELD_KEY.test(f.key) ||
      f.key.length > MAX_ORDER_FIELD_KEY_LENGTH ||
      keys.has(f.key)
    ) {
      errors.push({ field: `${field}.key`, message: 'invalid field key' });
    }
    keys.add(f.key);
  });
  if (errors.length) throw validationFailed(errors);

  return fields.map((f) => {
    if (f.key) return f;
    const key = keyForLabel(f.label, keys);
    keys.add(key);
    return { ...f, key };
  });
}

// Latin labels read well as parameter names. Any other script, Bangla say,
// leaves nothing to go on, and the model has the label in the description.
function keyForLabel(label: string, taken: Set<string>) {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[_0-9]+|_+$/g, '')
    .slice(0, MAX_ORDER_FIELD_KEY_LENGTH - 3);
  const base = slug || 'field';
  if (slug && !taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

// The JSON body of Create and Update. Unknown fields are ignored, like Go's
// decoder; a known field of the wrong JSON type is a 400, like a failed
// decode there.
export function parseInput(body: unknown): ToolInput {
  const b = requireObject(body);
  return {
    type: optional(b, 'type', 'string'),
    name: optional(b, 'name', 'string'),
    description: optional(b, 'description', 'string'),
    api_request:
      b.api_request == null ? undefined : parseApiRequest(b.api_request),
    send_text: b.send_text == null ? undefined : parseSendText(b.send_text),
  };
}

export function parseApiRequest(raw: unknown): ApiRequestConfig {
  if (!isObject(raw)) throw invalidBody();
  const headers = optionalArray(raw, 'headers').map((h) => {
    if (!isObject(h)) throw invalidBody();
    return {
      key: optional(h, 'key', 'string') ?? '',
      value: optional(h, 'value', 'string') ?? '',
    };
  });
  const parameters = optionalArray(raw, 'parameters').map((p) => {
    if (!isObject(p)) throw invalidBody();
    return {
      name: optional(p, 'name', 'string') ?? '',
      type: optional(p, 'type', 'string') ?? '',
      description: optional(p, 'description', 'string') ?? '',
      required: optional(p, 'required', 'boolean') ?? false,
    };
  });
  return {
    method: optional(raw, 'method', 'string') ?? '',
    url: optional(raw, 'url', 'string') ?? '',
    timeout_seconds: optional(raw, 'timeout_seconds', 'integer') ?? 0,
    async: optional(raw, 'async', 'boolean') ?? false,
    headers,
    parameters,
  };
}

function parseSendText(raw: unknown): SendTextConfig {
  if (!isObject(raw)) throw invalidBody();
  return { body: optional(raw, 'body', 'string') ?? '' };
}

export function validateCreate(input: ToolInput): FieldError[] {
  const errors: FieldError[] = [];
  const type = input.type?.trim() ?? '';
  if (!isToolType(type)) {
    errors.push({
      field: 'type',
      message: `type must be one of ${TOOL_TYPES.join(', ')}`,
    });
  }
  errors.push(...nameErrors(input.name?.trim() ?? ''));
  errors.push(...descriptionErrors(input.description?.trim() ?? ''));
  // Which block is required, and which ones this type would never read, both
  // follow from the type, so they are only judged once it is known.
  if (isToolType(type)) {
    errors.push(...foreignConfigErrors(type, input));
    errors.push(...configErrors(type, input, true));
  }
  return errors;
}

export function validateUpdate(
  input: ToolInput,
  storedType: string,
  storedName: string,
) {
  const errors: FieldError[] = [];
  if (input.type !== undefined && input.type.trim() !== storedType) {
    errors.push({
      field: 'type',
      message:
        'type cannot be changed after creation; delete the tool and create it again',
    });
  }
  // The dashboard resends the name on every save, so an old tool that already
  // has a name now reserved can still be edited.
  if (input.name !== undefined && input.name.trim() !== storedName) {
    errors.push(...nameErrors(input.name.trim()));
  }
  if (input.description !== undefined) {
    errors.push(...descriptionErrors(input.description.trim()));
  }
  // A block for a type this tool isn't would silently do nothing, so it is
  // refused: whoever sent it believes it took effect.
  errors.push(...foreignConfigErrors(storedType, input));
  errors.push(...configErrors(storedType, input, false));

  const empty =
    input.name === undefined &&
    input.description === undefined &&
    configFor(storedType, input) === undefined;
  if (!errors.length && empty) {
    errors.push({
      field: 'body',
      message: 'supply at least one field to update',
    });
  }
  return errors;
}

// The block of input that a tool of this type stores, normalized, or
// undefined when the input carries none.
export function configFor(type: string, input: ToolInput) {
  if (type === 'api_request' && input.api_request) {
    return normalizeApiRequest(input.api_request);
  }
  if (type === 'send_text' && input.send_text) return input.send_text;
  return undefined;
}

export function apiRequestErrors(cfg: ApiRequestConfig): FieldError[] {
  const errors: FieldError[] = [];
  if (!HTTP_METHODS.includes(normalizeMethod(cfg.method))) {
    errors.push({
      field: 'api_request.method',
      message: `method must be one of ${HTTP_METHODS.join(', ')}`,
    });
  }
  errors.push(...urlErrors(cfg.url));
  if (
    cfg.timeout_seconds !== 0 &&
    (cfg.timeout_seconds < MIN_TIMEOUT_SECONDS ||
      cfg.timeout_seconds > MAX_TIMEOUT_SECONDS)
  ) {
    errors.push({
      field: 'api_request.timeout_seconds',
      message: `timeout_seconds must be between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS}`,
    });
  }

  if (cfg.headers.length > MAX_HEADERS) {
    errors.push({
      field: 'api_request.headers',
      message: `at most ${MAX_HEADERS} headers are allowed`,
    });
  }
  cfg.headers.forEach((h, i) => {
    if (!h.key.trim()) {
      errors.push({
        field: `api_request.headers[${i}].key`,
        message: 'header key is required',
      });
    }
  });

  if (cfg.parameters.length > MAX_PARAMETERS) {
    errors.push({
      field: 'api_request.parameters',
      message: `at most ${MAX_PARAMETERS} parameters are allowed`,
    });
  }
  const seen = new Set<string>();
  cfg.parameters.forEach((p, i) => {
    const field = `api_request.parameters[${i}]`;
    const name = p.name.trim();
    if (!name) {
      errors.push({
        field: `${field}.name`,
        message: 'parameter name is required',
      });
    } else if (name.length > MAX_PARAMETER_NAME_LENGTH) {
      errors.push({
        field: `${field}.name`,
        message: `parameter name must be at most ${MAX_PARAMETER_NAME_LENGTH} characters`,
      });
    } else {
      if (seen.has(name)) {
        errors.push({
          field: `${field}.name`,
          message: 'parameter names must be unique within a tool',
        });
      }
      seen.add(name);
    }
    // An empty type is filled in as "string", the documented default.
    const type = p.type.trim();
    if (type && !PARAMETER_TYPES.includes(type)) {
      errors.push({
        field: `${field}.type`,
        message: `type must be one of ${PARAMETER_TYPES.join(', ')}`,
      });
    }
    if (!p.description.trim()) {
      errors.push({
        field: `${field}.description`,
        message:
          'description is required — it is the only thing telling the model what to put here',
      });
    }
  });
  return errors;
}

// Fills in the documented defaults so the stored block is complete: what is
// read back later runs the same request without re-applying defaults.
export function normalizeApiRequest(cfg: ApiRequestConfig): ApiRequestConfig {
  return {
    method: normalizeMethod(cfg.method),
    url: cfg.url.trim(),
    timeout_seconds:
      cfg.timeout_seconds > 0 ? cfg.timeout_seconds : DEFAULT_TIMEOUT_SECONDS,
    async: cfg.async,
    headers: cfg.headers
      .filter((h) => h.key.trim())
      .map((h) => ({ key: h.key.trim(), value: h.value.trim() })),
    parameters: cfg.parameters.map((p) => ({
      name: p.name.trim(),
      type: p.type.trim() || 'string',
      description: p.description.trim(),
      required: p.required,
    })),
  };
}

// Upper-cased, with POST as the documented default.
export function normalizeMethod(method: string | undefined) {
  return method?.trim().toUpperCase() || 'POST';
}

export function isToolType(type: string): type is ToolType {
  return (TOOL_TYPES as readonly string[]).includes(type);
}

function nameErrors(name: string): FieldError[] {
  if (!name) return [{ field: 'name', message: 'name is required' }];
  if (name === RESERVED_NAME) {
    return [{ field: 'name', message: `${name} is reserved for Take Order` }];
  }
  if (!NAME_PATTERN.test(name)) {
    return [
      {
        field: 'name',
        message:
          'name must start with a lowercase letter and contain only lowercase letters, digits and underscores (at most 64 characters)',
      },
    ];
  }
  return [];
}

function descriptionErrors(description: string): FieldError[] {
  if (!description) {
    return [
      {
        field: 'description',
        message:
          'description is required — it is what the model reads when deciding whether to call this tool',
      },
    ];
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return [
      {
        field: 'description',
        message: `description must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
      },
    ];
  }
  return [];
}

function foreignConfigErrors(type: string, input: ToolInput): FieldError[] {
  const errors: FieldError[] = [];
  if (input.api_request && type !== 'api_request') {
    errors.push({
      field: 'api_request',
      message: `api_request is not read by a ${type} tool`,
    });
  }
  if (input.send_text && type !== 'send_text') {
    errors.push({
      field: 'send_text',
      message: `send_text is not read by a ${type} tool`,
    });
  }
  return errors;
}

// required says whether the block must be present: it must on create for
// api_request, which can't act without one, while an update may leave the
// stored block alone.
function configErrors(
  type: string,
  input: ToolInput,
  required: boolean,
): FieldError[] {
  if (type === 'api_request') {
    if (!input.api_request) {
      return required
        ? [
            {
              field: 'api_request',
              message: 'api_request is required when type is api_request',
            },
          ]
        : [];
    }
    return apiRequestErrors(input.api_request);
  }
  if (
    type === 'send_text' &&
    input.send_text &&
    input.send_text.body.length > MAX_MESSAGE_LENGTH
  ) {
    return [
      {
        field: 'send_text.body',
        message: `body must be at most ${MAX_MESSAGE_LENGTH} characters`,
      },
    ];
  }
  return [];
}

// Only absolute http/https URLs with a host. Whether that host may be reached
// is decided when the request is sent, once DNS has answered (see runner.ts).
function urlErrors(raw: string): FieldError[] {
  const field = 'api_request.url';
  const trimmed = raw.trim();
  if (!trimmed) return [{ field, message: 'url is required' }];
  if (trimmed.length > MAX_URL_LENGTH) {
    return [
      { field, message: `url must be at most ${MAX_URL_LENGTH} characters` },
    ];
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return [{ field, message: 'url must be an absolute URL' }];
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return [{ field, message: 'url must use http or https' }];
  }
  if (!parsed.hostname)
    return [{ field, message: 'url must be an absolute URL' }];
  return [];
}

// The field's value when present, undefined when absent or null, and a 400
// when it has the wrong JSON type.
function optional<T extends 'string' | 'boolean' | 'integer'>(
  b: Record<string, unknown>,
  field: string,
  type: T,
):
  | (T extends 'string' ? string : T extends 'boolean' ? boolean : number)
  | undefined {
  const value = b[field];
  if (value === undefined || value === null) return undefined;
  const ok =
    type === 'integer' ? Number.isInteger(value) : typeof value === type;
  if (!ok) throw invalidBody();
  return value as never;
}

function optionalArray(b: Record<string, unknown>, field: string): unknown[] {
  const value = b[field];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalidBody();
  return value;
}

export function requireObject(body: unknown): Record<string, unknown> {
  if (!isObject(body)) throw invalidBody();
  return body;
}

export function invalidBody() {
  return apiError(HttpStatus.BAD_REQUEST, 'Invalid request body');
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
