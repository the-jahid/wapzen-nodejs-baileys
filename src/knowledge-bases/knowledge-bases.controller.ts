import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import multer from 'multer';
import type { User } from '../generated/prisma/client';
import { ClerkAuthGuard, CurrentUser } from '../auth/auth.guard';
import { ExtractionError, extractText } from './extract';
import { KnowledgeBasesService } from './knowledge-bases.service';
import {
  apiError,
  invalidFields,
  LIST_PATH,
  MAX_FILE_BYTES,
  MAX_FILES_PER_REQUEST,
  NewSource,
  parseAddSources,
  parseCreate,
  parseUpdate,
  titleFromFilename,
  titleProblem,
} from './knowledge-bases.types';

// Files are held in memory: a PDF and a .docx can only be read whole.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES_PER_REQUEST },
}).array('files');

// The Go server's knowledge base API. /v1/dashboard/knowledge-base is what the
// dashboard calls with its Clerk session; /v1/knowledge-base is the public
// path documented in docs/openapi.json. Both share these handlers.
@ApiExcludeController()
@UseGuards(ClerkAuthGuard)
@Controller(['v1/knowledge-base', 'v1/dashboard/knowledge-base'])
export class KnowledgeBasesController {
  constructor(private readonly knowledgeBases: KnowledgeBasesService) {}

  @Get()
  async list(
    @CurrentUser() user: User,
    @Query('page') rawPage?: string,
    @Query('limit') rawLimit?: string,
  ) {
    const page = parsePositive(rawPage, 1);
    const limit = parsePositive(rawLimit, 20);
    const errors: { field: string; message: string }[] = [];
    if (page === null) {
      errors.push({
        field: 'page',
        message: 'page must be a positive integer',
      });
    }
    if (limit === null || limit > 100) {
      errors.push({
        field: 'limit',
        message: 'limit must be between 1 and 100',
      });
    }
    if (page === null || limit === null || errors.length) {
      throw invalidFields(errors, 'Invalid query parameters');
    }

    const { knowledgeBases, total } = await this.knowledgeBases.list(
      user.id,
      page,
      limit,
    );
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const at = (p: number) => `${LIST_PATH}?page=${p}&limit=${limit}`;
    return {
      success: true,
      message: 'Knowledge bases retrieved successfully',
      data: knowledgeBases,
      meta: {
        pagination: {
          page,
          limit,
          total_items: total,
          total_pages: totalPages,
          has_next_page: page < totalPages,
          has_previous_page: page > 1,
        },
      },
      links: {
        self: at(page),
        first: at(1),
        previous: page > 1 ? at(page - 1) : null,
        next: page < totalPages ? at(page + 1) : null,
        last: at(totalPages),
      },
    };
  }

  @Post()
  async create(@CurrentUser() user: User, @Body() body: unknown) {
    const data = await this.knowledgeBases.create(user.id, parseCreate(body));
    return envelope('Knowledge base created successfully', data);
  }

  @Get(':knowledge_base_id')
  async get(@CurrentUser() user: User, @Param('knowledge_base_id') id: string) {
    const data = await this.knowledgeBases.get(user.id, id.trim());
    return envelope('Knowledge base retrieved successfully', data);
  }

  @Patch(':knowledge_base_id')
  async update(
    @CurrentUser() user: User,
    @Param('knowledge_base_id') id: string,
    @Body() body: unknown,
  ) {
    const input = parseUpdate(body);
    const data = await this.knowledgeBases.update(user.id, id.trim(), input);
    return envelope('Knowledge base updated successfully', data);
  }

  @Delete(':knowledge_base_id')
  @HttpCode(200)
  async remove(
    @CurrentUser() user: User,
    @Param('knowledge_base_id') id: string,
  ) {
    id = id.trim();
    await this.knowledgeBases.remove(user.id, id);
    return {
      success: true,
      message: 'Knowledge base deleted successfully',
      data: { id, deleted: true },
    };
  }

  // Raw texts as JSON, or documents as multipart/form-data: repeated "files"
  // parts plus optional "titles" parts (the nth title names the nth file).
  // A file is only another way to deliver a text source: its text is
  // extracted here and from then on both index the same way.
  @Post(':knowledge_base_id/sources')
  async addSources(
    @CurrentUser() user: User,
    @Param('knowledge_base_id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const kb = await this.knowledgeBases.loadForSources(user.id, id.trim());
    const entries = req.is('multipart/form-data')
      ? await readUpload(req, res)
      : parseAddSources(req.body);
    const data = await this.knowledgeBases.addSources(kb, entries);
    return envelope('Knowledge base sources added successfully', data);
  }

  @Delete(':knowledge_base_id/sources/:source_id')
  @HttpCode(200)
  async removeSource(
    @CurrentUser() user: User,
    @Param('knowledge_base_id') id: string,
    @Param('source_id') sourceId: string,
  ) {
    sourceId = sourceId.trim();
    const knowledgeBaseId = await this.knowledgeBases.deleteSource(
      user.id,
      id.trim(),
      sourceId,
    );
    return {
      success: true,
      message: 'Knowledge base source deleted successfully',
      data: { id: sourceId, knowledge_base_id: knowledgeBaseId, deleted: true },
    };
  }
}

// Reads the upload and turns each file into a source. Every file is extracted
// before anything is stored, so one unreadable document refuses the whole
// batch with a field error naming it, instead of four of five landing.
async function readUpload(req: Request, res: Response): Promise<NewSource[]> {
  const failure = await new Promise<unknown>((resolve) =>
    upload(req, res, resolve),
  );
  if (failure) throw uploadError(failure);

  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const body = (req.body ?? {}) as { titles?: string | string[] };
  const titles = ([] as string[]).concat(body.titles ?? []);
  if (!files.length) {
    throw invalidFields([
      { field: 'files', message: 'attach at least one file in a "files" part' },
    ]);
  }

  const entries: NewSource[] = [];
  const errors: { field: string; message: string }[] = [];
  for (const [i, file] of files.entries()) {
    const field = `files[${i}]`;
    // A supplied title wins; a blank or missing one falls back to the name.
    const title = titles[i]?.trim() || titleFromFilename(file.originalname);
    const problem = titleProblem(title);
    if (problem) {
      errors.push({ field, message: `${file.originalname}: ${problem}` });
      continue;
    }
    try {
      const text = await extractText(file.originalname, file.buffer);
      entries.push({ type: 'file', title, text });
    } catch (err) {
      if (!(err instanceof ExtractionError)) {
        throw apiError(
          HttpStatus.INTERNAL_SERVER_ERROR,
          'failed to extract text from the uploaded file',
        );
      }
      errors.push({ field, message: `${file.originalname}: ${err.message}` });
    }
  }
  if (errors.length) throw invalidFields(errors);
  return entries;
}

function uploadError(err: unknown) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return invalidFields([
        {
          field: 'files',
          message: `a file is larger than the ${MAX_FILE_BYTES >> 20} MB limit`,
        },
      ]);
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return invalidFields([
        {
          field: 'files',
          message: `at most ${MAX_FILES_PER_REQUEST} files may be uploaded in one request`,
        },
      ]);
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return invalidFields([
        {
          field: err.field ?? 'files',
          message: 'files must be sent in "files" parts',
        },
      ]);
    }
  }
  return apiError(
    HttpStatus.BAD_REQUEST,
    'the upload could not be read as multipart/form-data',
  );
}

function envelope(message: string, data: { knowledge_base_id: string }) {
  return {
    success: true,
    message,
    data,
    links: { self: `${LIST_PATH}/${data.knowledge_base_id}` },
  };
}

// The query value as a positive integer, fallback when absent, null when it
// isn't one.
function parsePositive(raw: string | undefined, fallback: number) {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : null;
}
