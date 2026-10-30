import { HttpException, HttpStatus } from '@nestjs/common';
import type {
  KnowledgeBase,
  KnowledgeBaseSource,
} from '../generated/prisma/client';

// Wire types and validation for /v1/knowledge-base, ported from the Go
// server's handlers/knowledge_base_handler.go and knowledge_base_sources.go
// so both servers accept and answer the same.

export const DEFAULT_MAX_CHUNK_SIZE = 2000;
export const DEFAULT_MIN_CHUNK_SIZE = 400;
const MAX_CHUNK_SIZE_RANGE = [600, 6000] as const;
const MIN_CHUNK_SIZE_RANGE = [200, 2000] as const;
const MAX_NAME_LENGTH = 40;

const MAX_TITLE_LENGTH = 200;
const MAX_TEXTS_PER_REQUEST = 25;
export const MAX_FILES_PER_REQUEST = 10;
export const MAX_FILE_BYTES = 10 << 20; // 10 MiB
export const MAX_SOURCE_TEXT_LENGTH = 300_000;

// Divides a source title from the chunk number in a Pinecone record id, which
// is why titles may not contain it.
export const CHUNK_ID_SEPARATOR = '#';

export const LIST_PATH = '/v1/knowledge-base';

// One source to store and index. A file has been extracted into text by the
// time it becomes one of these, so both kinds index the same way.
export type NewSource = { type: 'text' | 'file'; title: string; text: string };

export type CreateInput = {
  name: string;
  enableAutoRefresh?: boolean;
  maxChunkSize?: number;
  minChunkSize?: number;
  texts: NewSource[];
};

export type UpdateInput = {
  name?: string;
  enableAutoRefresh?: boolean;
  maxChunkSize?: number;
  minChunkSize?: number;
};

type FieldError = { field: string; message: string };

type SourceSummary = Pick<
  KnowledgeBaseSource,
  'id' | 'type' | 'title' | 'chunkCount'
>;

// KnowledgeBaseResource in the contract. Sources and the refresh time are
// left out when there are none, like the Go server's omitempty.
export function toResource(row: KnowledgeBase & { sources?: SourceSummary[] }) {
  return {
    knowledge_base_id: row.id,
    knowledge_base_name: row.name,
    status: row.status,
    ...(row.pineconeNamespace ? { namespace_id: row.pineconeNamespace } : {}),
    ...(row.sources?.length
      ? {
          knowledge_base_sources: row.sources.map((s) => ({
            type: s.type,
            source_id: s.id,
            title: s.title,
            chunk_count: s.chunkCount,
          })),
        }
      : {}),
    enable_auto_refresh: row.enableAutoRefresh,
    ...(row.lastRefreshedAt
      ? { last_refreshed_timestamp: row.lastRefreshedAt.getTime() }
      : {}),
    max_chunk_size: row.maxChunkSize,
    min_chunk_size: row.minChunkSize,
  };
}

// An error in the { success, message } envelope the dashboard reads.
export function apiError(status: HttpStatus, message: string) {
  return new HttpException({ success: false, message }, status);
}

// A 400 listing what is wrong with each field, which the dashboard maps back
// onto the offending input.
export function invalidFields(
  errors: FieldError[],
  message = 'Invalid request body',
) {
  return new HttpException(
    { success: false, message, errors },
    HttpStatus.BAD_REQUEST,
  );
}

export function parseCreate(body: unknown): CreateInput {
  const b = requireObject(body);
  const name = optional(b, 'knowledge_base_name', 'string')?.trim() ?? '';
  const input: CreateInput = {
    name,
    enableAutoRefresh: optional(b, 'enable_auto_refresh', 'boolean'),
    maxChunkSize: optional(b, 'max_chunk_size', 'integer'),
    minChunkSize: optional(b, 'min_chunk_size', 'integer'),
    texts: [],
  };

  const errors: FieldError[] = [];
  if (!name) {
    errors.push({
      field: 'knowledge_base_name',
      message: 'knowledge_base_name is required',
    });
  } else if (name.length > MAX_NAME_LENGTH) {
    errors.push(nameTooLong());
  }
  errors.push(...chunkSizeErrors(input.maxChunkSize, input.minChunkSize));
  // Compared only once both are in range, so an out-of-range value reports
  // its own bound rather than the ordering.
  if (
    errors.length === 0 &&
    (input.minChunkSize ?? DEFAULT_MIN_CHUNK_SIZE) >
      (input.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE)
  ) {
    errors.push(minAboveMax());
  }

  // The texts are indexed by the create itself, so a repeated title is
  // refused here rather than by the unique index once the row exists.
  const texts = parseTexts(b, errors, true);
  input.texts = texts;
  errors.push(...unsupportedSourceErrors(b, 'create'));

  if (errors.length) throw invalidFields(errors);
  return input;
}

export function parseUpdate(body: unknown): UpdateInput {
  const b = requireObject(body);
  const input: UpdateInput = {
    name: optional(b, 'knowledge_base_name', 'string')?.trim(),
    enableAutoRefresh: optional(b, 'enable_auto_refresh', 'boolean'),
    maxChunkSize: optional(b, 'max_chunk_size', 'integer'),
    minChunkSize: optional(b, 'min_chunk_size', 'integer'),
  };
  if (Object.values(input).every((v) => v === undefined)) {
    throw invalidFields([
      {
        field: 'body',
        message:
          'supply at least one of knowledge_base_name, enable_auto_refresh, max_chunk_size or min_chunk_size',
      },
    ]);
  }

  const errors: FieldError[] = [];
  if (input.name === '') {
    errors.push({
      field: 'knowledge_base_name',
      message: 'knowledge_base_name must not be empty',
    });
  } else if (input.name !== undefined && input.name.length > MAX_NAME_LENGTH) {
    errors.push(nameTooLong());
  }
  errors.push(...chunkSizeErrors(input.maxChunkSize, input.minChunkSize));
  if (errors.length) throw invalidFields(errors);
  return input;
}

// The min <= max check against the stored row, for an update that may carry
// only one of the two sizes.
export function checkChunkOrder(min: number, max: number) {
  if (min > max) throw invalidFields([minAboveMax()]);
}

// The JSON form of Add Sources: raw texts only.
export function parseAddSources(body: unknown): NewSource[] {
  const b = requireObject(body);
  const errors = unsupportedSourceErrors(b, 'add');
  if (
    !Array.isArray(b.knowledge_base_texts) ||
    !b.knowledge_base_texts.length
  ) {
    errors.push({
      field: 'knowledge_base_texts',
      message: 'supply at least one text entry',
    });
    throw invalidFields(errors);
  }
  const texts = parseTexts(b, errors, false);
  if (errors.length) throw invalidFields(errors);
  return texts;
}

function parseTexts(
  b: Record<string, unknown>,
  errors: FieldError[],
  uniqueTitles: boolean,
): NewSource[] {
  const raw = b.knowledge_base_texts;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw invalidBody();
  if (raw.length > MAX_TEXTS_PER_REQUEST) {
    errors.push({
      field: 'knowledge_base_texts',
      message: `at most ${MAX_TEXTS_PER_REQUEST} text entries may be supplied`,
    });
  }

  const seen = new Map<string, number>();
  return raw.map((entry: unknown, i): NewSource => {
    const e = isObject(entry) ? entry : {};
    if (
      (e.title !== undefined && typeof e.title !== 'string') ||
      (e.text !== undefined && typeof e.text !== 'string')
    ) {
      throw invalidBody();
    }
    const title = ((e.title as string) ?? '').trim();
    const text = ((e.text as string) ?? '').trim();
    const field = `knowledge_base_texts[${i}]`;

    if (!title || !text) {
      errors.push({ field, message: 'title and text are both required' });
    } else {
      const problem = titleProblem(title);
      if (problem) {
        errors.push({ field: `${field}.title`, message: problem });
      } else if (uniqueTitles && seen.has(title)) {
        errors.push({
          field: `${field}.title`,
          message: `duplicate title; it is already used by knowledge_base_texts[${seen.get(title)}]`,
        });
      } else {
        seen.set(title, i);
      }
    }
    return { type: 'text', title, text };
  });
}

// Urls have no fetcher, and a file is uploaded as multipart rather than
// linked, so both are refused instead of being accepted and dropped.
function unsupportedSourceErrors(
  b: Record<string, unknown>,
  endpoint: 'create' | 'add',
): FieldError[] {
  const errors: FieldError[] = [];
  if (Array.isArray(b.knowledge_base_urls) && b.knowledge_base_urls.length) {
    errors.push({
      field: 'knowledge_base_urls',
      message: 'url sources are not supported yet; supply knowledge_base_texts',
    });
  }
  if (Array.isArray(b.knowledge_base_files) && b.knowledge_base_files.length) {
    errors.push({
      field: 'knowledge_base_files',
      message:
        endpoint === 'create'
          ? 'files are uploaded, not linked; create the knowledge base first, then send the documents as multipart/form-data "files" parts to its sources endpoint'
          : 'files are uploaded, not linked; send them as multipart/form-data "files" parts instead of file_url references',
    });
  }
  return errors;
}

// Why a title can't be stored, or '' when it's fine. Uniqueness within the
// knowledge base is left to the unique index.
export function titleProblem(title: string): string {
  if (!title) {
    return 'a title is required, and none could be derived from the filename';
  }
  if ([...title].length > MAX_TITLE_LENGTH) {
    return `title must be at most ${MAX_TITLE_LENGTH} characters`;
  }
  // Pinecone rejects non-ASCII record ids, and a title holding the separator
  // could collide with another source's second chunk.
  if (!/^[\x20-\x7e]*$/.test(title) || title.includes(CHUNK_ID_SEPARATOR)) {
    return `title is used verbatim as the vector store record id, so it must be printable ASCII and must not contain "${CHUNK_ID_SEPARATOR}"`;
  }
  return '';
}

// A title from an uploaded filename: the last path element, with whatever a
// record id can't carry turned into dashes. The extension is kept, so a
// document can't collide with a pasted text of the same name. Same algorithm
// as the Go server and the dashboard, which prefills it.
export function titleFromFilename(filename: string): string {
  const name = filename.trim().split(/[/\\]/).pop() ?? '';
  const replaced = [...name]
    .map((ch) => (ch === CHUNK_ID_SEPARATOR || ch < ' ' || ch > '~' ? '-' : ch))
    .join('');
  const title = replaced
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .replace(/-{2,}/g, '-')
    .replace(/^[- ]+|[- ]+$/g, '');
  return title.slice(0, MAX_TITLE_LENGTH).trim();
}

function chunkSizeErrors(max?: number, min?: number): FieldError[] {
  const errors: FieldError[] = [];
  const [maxLo, maxHi] = MAX_CHUNK_SIZE_RANGE;
  const [minLo, minHi] = MIN_CHUNK_SIZE_RANGE;
  if (max !== undefined && (max < maxLo || max > maxHi)) {
    errors.push({
      field: 'max_chunk_size',
      message: `max_chunk_size must be between ${maxLo} and ${maxHi}`,
    });
  }
  if (min !== undefined && (min < minLo || min > minHi)) {
    errors.push({
      field: 'min_chunk_size',
      message: `min_chunk_size must be between ${minLo} and ${minHi}`,
    });
  }
  return errors;
}

function minAboveMax(): FieldError {
  return {
    field: 'min_chunk_size',
    message: 'min_chunk_size must not be greater than max_chunk_size',
  };
}

function nameTooLong(): FieldError {
  return {
    field: 'knowledge_base_name',
    message: `knowledge_base_name must be at most ${MAX_NAME_LENGTH} characters`,
  };
}

// The field's value when present, undefined when absent or null, and a 400
// when it has the wrong JSON type (Go's decoder fails the same way).
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

function requireObject(body: unknown): Record<string, unknown> {
  if (!isObject(body)) {
    throw apiError(HttpStatus.BAD_REQUEST, 'request body is required');
  }
  return body;
}

function invalidBody() {
  return apiError(HttpStatus.BAD_REQUEST, 'Invalid request body');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
