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
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { User } from '../generated/prisma/client';
import { ClerkAuthGuard, CurrentUser } from '../auth/auth.guard';
import { ChatAgentsService } from './chat-agents.service';
import {
  apiError,
  parseInput,
  validateCreate,
  validateUpdate,
} from './chat-agents.types';

// The Go server's chat-agent API. /v1/dashboard/chat-agents is the path the
// dashboard calls with its Clerk session; /v1/chat-agents is the public one
// in docs/openapi.json (documented there, so the controller is kept out of the
// generated docs). Both are served by the same handlers.
@ApiExcludeController()
@UseGuards(ClerkAuthGuard)
@Controller(['v1/chat-agents', 'v1/dashboard/chat-agents'])
export class ChatAgentsController {
  constructor(private readonly chatAgents: ChatAgentsService) {}

  @Get()
  async list(
    @CurrentUser() user: User,
    @Query('page') rawPage?: string,
    @Query('limit') rawLimit?: string,
  ) {
    const page = parsePositive(rawPage, 1);
    if (page === null) {
      throw apiError(HttpStatus.BAD_REQUEST, 'page must be a positive integer');
    }
    const limit = parsePositive(rawLimit, 20);
    if (limit === null || limit > 100) {
      throw apiError(HttpStatus.BAD_REQUEST, 'limit must be between 1 and 100');
    }
    const { agents, total } = await this.chatAgents.list(user.id, page, limit);
    return {
      success: true,
      message: 'Chat agents retrieved successfully',
      data: agents,
      meta: { page, limit, total_items: total },
    };
  }

  @Post()
  async create(@CurrentUser() user: User, @Body() body: unknown) {
    const req = parseInput(body);
    validateCreate(req);
    return {
      success: true,
      message: 'Chat agent created successfully',
      data: await this.chatAgents.create(user.id, req),
    };
  }

  @Get(':chat_agent_id')
  async get(@CurrentUser() user: User, @Param('chat_agent_id') id: string) {
    return {
      success: true,
      message: 'Chat agent retrieved successfully',
      data: await this.chatAgents.get(user.id, id.trim()),
    };
  }

  @Patch(':chat_agent_id')
  async update(
    @CurrentUser() user: User,
    @Param('chat_agent_id') id: string,
    @Body() body: unknown,
  ) {
    const req = parseInput(body);
    validateUpdate(req);
    return {
      success: true,
      message: 'Chat agent updated successfully',
      data: await this.chatAgents.update(user.id, id.trim(), req),
    };
  }

  @Delete(':chat_agent_id')
  @HttpCode(200)
  async remove(@CurrentUser() user: User, @Param('chat_agent_id') id: string) {
    id = id.trim();
    await this.chatAgents.remove(user.id, id);
    return {
      success: true,
      message: 'Chat agent deleted successfully',
      data: { id, deleted: true },
    };
  }
}

// The query value as a positive integer, fallback when absent, null when it
// isn't one.
function parsePositive(raw: string | undefined, fallback: number) {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : null;
}
