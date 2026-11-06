import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import multer from 'multer';
import { ClerkAuthGuard, CurrentUser } from '../auth/auth.guard';
import { apiError } from '../chat-agents/chat-agents.types';
import type { User } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AgentFilesService } from './agent-files.service';
import {
  ALLOWED_EXTENSIONS,
  cleanFileName,
  detectMimeType,
  MAX_DESCRIPTION_CHARS,
  MAX_FILE_BYTES,
  MAX_FILES_PER_AGENT,
} from './agent-files.types';

// defParamCharset keeps a name like "মেনু.pdf" intact: multer reads names as
// latin1 unless told otherwise.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  defParamCharset: 'utf8',
}).single('file');

// An agent's images and documents. The upload is multipart/form-data: one "file"
// part, and a "description" saying when the agent should send it.
@ApiExcludeController()
@UseGuards(ClerkAuthGuard)
@Controller([
  'v1/chat-agents/:chat_agent_id/files',
  'v1/dashboard/chat-agents/:chat_agent_id/files',
])
export class AgentFilesController {
  private readonly logger = new Logger(AgentFilesController.name);

  constructor(
    private readonly files: AgentFilesService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async list(@CurrentUser() user: User, @Param('chat_agent_id') id: string) {
    const agentId = await this.ownedAgent(user, id);
    return {
      success: true,
      message: 'Files retrieved successfully',
      data: await this.available(() => this.files.list(agentId)),
    };
  }

  @Post()
  async upload(
    @CurrentUser() user: User,
    @Param('chat_agent_id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const agentId = await this.ownedAgent(user, id);
    if (!req.is('multipart/form-data')) {
      throw apiError(
        HttpStatus.BAD_REQUEST,
        'send the file as multipart/form-data',
      );
    }
    const failure = await new Promise<unknown>((resolve) =>
      upload(req, res, resolve),
    );
    if (failure) throw uploadError(failure);

    const { file } = req;
    const body = (req.body ?? {}) as { description?: unknown };
    if (!file) {
      throw apiError(
        HttpStatus.BAD_REQUEST,
        'attach the file in a "file" part',
      );
    }
    const description = cleanDescription(body.description);
    const fileName = cleanFileName(file.originalname);
    const mimeType = detectMimeType(fileName, file.buffer);
    if (!mimeType) {
      throw apiError(
        HttpStatus.BAD_REQUEST,
        `${fileName || 'This file'} isn't a file the agent can send. Use one of: ${ALLOWED_EXTENSIONS.join(', ')}`,
      );
    }

    const added = await this.available(async () => {
      if ((await this.files.count(agentId)) >= MAX_FILES_PER_AGENT) {
        throw apiError(
          HttpStatus.CONFLICT,
          `An agent can hold at most ${MAX_FILES_PER_AGENT} files. Delete one first.`,
        );
      }
      return this.files.add({
        userId: user.id,
        agentId,
        fileName,
        mimeType,
        description,
        data: file.buffer,
      });
    });
    return {
      success: true,
      message: 'File uploaded successfully',
      data: added,
    };
  }

  // Only the note can change. A different file is a new upload.
  @Patch(':file_id')
  async update(
    @CurrentUser() user: User,
    @Param('chat_agent_id') id: string,
    @Param('file_id') fileId: string,
    @Body() body: { description?: unknown } | undefined,
  ) {
    const agentId = await this.ownedAgent(user, id);
    const description = cleanDescription(body?.description);
    const updated = await this.available(() =>
      this.files.updateDescription(agentId, fileId.trim(), description),
    );
    if (!updated) throw apiError(HttpStatus.NOT_FOUND, 'file not found');
    return {
      success: true,
      message: 'File updated successfully',
      data: updated,
    };
  }

  @Delete(':file_id')
  @HttpCode(200)
  async remove(
    @CurrentUser() user: User,
    @Param('chat_agent_id') id: string,
    @Param('file_id') fileId: string,
  ) {
    const agentId = await this.ownedAgent(user, id);
    fileId = fileId.trim();
    const removed = await this.available(() =>
      this.files.remove(agentId, fileId),
    );
    if (!removed) throw apiError(HttpStatus.NOT_FOUND, 'file not found');
    return {
      success: true,
      message: 'File deleted successfully',
      data: { id: fileId, deleted: true },
    };
  }

  // Files have no link to agents in their own database, so this is the check
  // that one user can't reach another's.
  private async ownedAgent(user: User, rawId: string) {
    const id = rawId.trim();
    const found = await this.prisma.chatAgent.count({
      where: { id, userId: user.id },
    });
    if (!found) throw apiError(HttpStatus.NOT_FOUND, 'chat agent not found');
    return id;
  }

  // Runs a call to the files database, whose trouble is a 503, not a 500: the
  // rest of the agent still works.
  private async available<T>(call: () => Promise<T>): Promise<T> {
    if (!this.files.enabled) {
      throw apiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'File storage is not set up on this server',
      );
    }
    try {
      return await call();
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(`files database: ${(err as Error).message}`);
      throw apiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        "File storage can't be reached right now. Try again in a moment.",
      );
    }
  }
}

function cleanDescription(raw: unknown) {
  const description =
    typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!description) {
    throw apiError(
      HttpStatus.BAD_REQUEST,
      'say when the agent should send this file',
    );
  }
  if (Array.from(description).length > MAX_DESCRIPTION_CHARS) {
    throw apiError(
      HttpStatus.BAD_REQUEST,
      `the description must be at most ${MAX_DESCRIPTION_CHARS} characters`,
    );
  }
  return description;
}

function uploadError(err: unknown) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return apiError(
        HttpStatus.BAD_REQUEST,
        `A file can be at most ${MAX_FILE_BYTES >> 20} MB`,
      );
    }
    if (
      err.code === 'LIMIT_UNEXPECTED_FILE' ||
      err.code === 'LIMIT_FILE_COUNT'
    ) {
      return apiError(
        HttpStatus.BAD_REQUEST,
        'send one file, in a "file" part',
      );
    }
  }
  return apiError(
    HttpStatus.BAD_REQUEST,
    'the upload could not be read as multipart/form-data',
  );
}
