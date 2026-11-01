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
import { BulkMessagesService } from './bulk-messages.service';
import {
  parseCampaign,
  parseRecipientQuery,
  parseTemplate,
} from './bulk-messages.types';
import { MessageTemplatesService } from './message-templates.service';

// /v1/dashboard/... is what the dashboard calls with its Clerk session; the
// /v1/... paths share the same handlers.
@ApiExcludeController()
@UseGuards(ClerkAuthGuard)
@Controller(['v1/bulk-messages', 'v1/dashboard/bulk-messages'])
export class BulkMessagesController {
  constructor(private readonly bulk: BulkMessagesService) {}

  @Get()
  async list(@CurrentUser() user: User) {
    return {
      success: true,
      message: 'Bulk messages retrieved successfully',
      data: await this.bulk.list(user.id),
    };
  }

  @Post()
  async create(@CurrentUser() user: User, @Body() body: unknown) {
    const input = parseCampaign(body);
    return {
      success: true,
      message: 'Bulk message started',
      data: await this.bulk.create(user.id, input),
      meta: { duplicates_removed: input.duplicates },
    };
  }

  @Get(':id')
  async get(@CurrentUser() user: User, @Param('id') id: string) {
    return {
      success: true,
      message: 'Bulk message retrieved successfully',
      data: await this.bulk.get(user.id, id.trim()),
    };
  }

  @Get(':id/recipients')
  async recipients(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Query() query: Record<string, string | undefined>,
  ) {
    const { page, limit, status } = parseRecipientQuery(query);
    const { recipients, total } = await this.bulk.recipients(
      user.id,
      id.trim(),
      page,
      limit,
      status,
    );
    return {
      success: true,
      message: 'Recipients retrieved successfully',
      data: recipients,
      meta: { pagination: { page, limit, total_items: total } },
    };
  }

  @Post(':id/pause')
  @HttpCode(200)
  async pause(@CurrentUser() user: User, @Param('id') id: string) {
    return {
      success: true,
      message: 'Bulk message paused',
      data: await this.bulk.pause(user.id, id.trim()),
    };
  }

  @Post(':id/resume')
  @HttpCode(200)
  async resume(@CurrentUser() user: User, @Param('id') id: string) {
    return {
      success: true,
      message: 'Bulk message resumed',
      data: await this.bulk.resume(user.id, id.trim()),
    };
  }

  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@CurrentUser() user: User, @Param('id') id: string) {
    return {
      success: true,
      message: 'Bulk message cancelled',
      data: await this.bulk.cancel(user.id, id.trim()),
    };
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@CurrentUser() user: User, @Param('id') id: string) {
    id = id.trim();
    await this.bulk.remove(user.id, id);
    return {
      success: true,
      message: 'Bulk message deleted',
      data: { id, deleted: true },
    };
  }
}

@ApiExcludeController()
@UseGuards(ClerkAuthGuard)
@Controller(['v1/message-templates', 'v1/dashboard/message-templates'])
export class MessageTemplatesController {
  constructor(private readonly templates: MessageTemplatesService) {}

  @Get()
  async list(@CurrentUser() user: User) {
    return {
      success: true,
      message: 'Templates retrieved successfully',
      data: await this.templates.list(user.id),
    };
  }

  @Post()
  async create(@CurrentUser() user: User, @Body() body: unknown) {
    return {
      success: true,
      message: 'Template created',
      data: await this.templates.create(user.id, parseTemplate(body, false)),
    };
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return {
      success: true,
      message: 'Template updated',
      data: await this.templates.update(
        user.id,
        id.trim(),
        parseTemplate(body, true),
      ),
    };
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@CurrentUser() user: User, @Param('id') id: string) {
    id = id.trim();
    await this.templates.remove(user.id, id);
    return {
      success: true,
      message: 'Template deleted',
      data: { id, deleted: true },
    };
  }
}
