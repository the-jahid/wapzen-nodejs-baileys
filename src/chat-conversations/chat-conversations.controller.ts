import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { User } from '../generated/prisma/client';
import { ClerkAuthGuard, CurrentUser } from '../auth/auth.guard';
import { ChatConversationsService } from './chat-conversations.service';
import {
  ConversationFilter,
  parseListQuery,
  parseSend,
  parseUpdate,
} from './chat-conversations.types';

const LIST_PATH = '/v1/chat-conversations';

// The Go server's chat-conversation API, at both the public /v1 paths in
// docs/openapi.json and the /v1/dashboard ones the dashboard calls with its
// Clerk session. Kept out of the generated docs like the other controllers.
@ApiExcludeController()
@UseGuards(ClerkAuthGuard)
@Controller()
export class ChatConversationsController {
  constructor(private readonly conversations: ChatConversationsService) {}

  @Get(['v1/chat-conversations', 'v1/dashboard/chat-conversations'])
  list(
    @CurrentUser() user: User,
    @Query() query: Record<string, string | undefined>,
  ) {
    const { page, limit, filter } = parseListQuery(query);
    return this.page(user.id, filter, page, limit, LIST_PATH);
  }

  // The same listing narrowed to one agent: what the chat agent editor's
  // Conversation tab reads. Another user's agent id just matches nothing.
  @Get([
    'v1/chat-agents/:chat_agent_id/conversations',
    'v1/dashboard/chat-agents/:chat_agent_id/conversations',
  ])
  listByChatAgent(
    @CurrentUser() user: User,
    @Param('chat_agent_id') chatAgentId: string,
    @Query() query: Record<string, string | undefined>,
  ) {
    const { page, limit, filter } = parseListQuery(query);
    chatAgentId = chatAgentId.trim();
    filter.chatAgentId = chatAgentId;
    return this.page(
      user.id,
      filter,
      page,
      limit,
      `/v1/chat-agents/${chatAgentId}/conversations`,
    );
  }

  @Get([
    'v1/chat-conversations/:conversation_id',
    'v1/dashboard/chat-conversations/:conversation_id',
  ])
  async get(@CurrentUser() user: User, @Param('conversation_id') id: string) {
    const data = await this.conversations.get(user.id, id.trim());
    return {
      success: true,
      message: 'Conversation retrieved successfully',
      data,
      links: { self: `${LIST_PATH}/${data.id}` },
    };
  }

  // Closes or reopens a thread; nothing else about it is editable.
  @Patch([
    'v1/chat-conversations/:conversation_id',
    'v1/dashboard/chat-conversations/:conversation_id',
  ])
  async update(
    @CurrentUser() user: User,
    @Param('conversation_id') id: string,
    @Body() body: unknown,
  ) {
    const status = parseUpdate(body);
    const data = await this.conversations.updateStatus(
      user.id,
      id.trim(),
      status,
    );
    return {
      success: true,
      message: 'Conversation updated successfully',
      data,
      links: { self: `${LIST_PATH}/${data.id}` },
    };
  }

  @Post([
    'v1/chat-conversations/:conversation_id/messages',
    'v1/dashboard/chat-conversations/:conversation_id/messages',
  ])
  async send(
    @CurrentUser() user: User,
    @Param('conversation_id') id: string,
    @Body() body: unknown,
  ) {
    const content = parseSend(body);
    id = id.trim();
    return {
      success: true,
      message: 'Message sent successfully',
      data: await this.conversations.send(user.id, id, content),
      links: { self: `${LIST_PATH}/${id}` },
    };
  }

  @Delete([
    'v1/chat-conversations/:conversation_id',
    'v1/dashboard/chat-conversations/:conversation_id',
  ])
  @HttpCode(200)
  async remove(
    @CurrentUser() user: User,
    @Param('conversation_id') id: string,
  ) {
    id = id.trim();
    await this.conversations.remove(user.id, id);
    return {
      success: true,
      message: 'Conversation deleted successfully',
      data: { id, deleted: true },
    };
  }

  private async page(
    userId: string,
    filter: ConversationFilter,
    page: number,
    limit: number,
    basePath: string,
  ) {
    const { conversations, total } = await this.conversations.list(
      userId,
      filter,
      page,
      limit,
    );
    const pages = Math.ceil(total / limit);
    const url = (p: number) => `${basePath}?page=${p}&limit=${limit}`;
    return {
      success: true,
      message: 'Conversations retrieved successfully',
      data: conversations,
      meta: {
        pagination: {
          page,
          limit,
          total_items: total,
          total_pages: pages,
          has_next_page: page < pages,
          has_previous_page: page > 1,
        },
      },
      links: {
        self: url(page),
        first: url(1),
        previous: page > 1 ? url(page - 1) : null,
        next: page < pages ? url(page + 1) : null,
        last: url(Math.max(pages, 1)),
      },
    };
  }
}
