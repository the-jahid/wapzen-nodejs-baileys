import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ClerkAuthGuard, CurrentUser } from '../auth/auth.guard';
import { apiError } from '../chat-agents/chat-agents.types';
import type { User } from '../generated/prisma/client';
import { FollowUpsService } from './follow-ups.service';

@ApiExcludeController()
@UseGuards(ClerkAuthGuard)
@Controller('v1/dashboard/follow-ups/:phoneNumberId')
export class FollowUpsController {
  constructor(private readonly followUps: FollowUpsService) {}

  @Get()
  async get(
    @CurrentUser() user: User,
    @Param('phoneNumberId') id: string,
    @Query('page') query?: string,
  ) {
    const page = Number(query ?? 1);
    if (!Number.isInteger(page) || page < 1 || page > 1_000_000)
      throw apiError(HttpStatus.BAD_REQUEST, 'Invalid result page');
    return { success: true, data: await this.followUps.get(user.id, id, page) };
  }

  @Put()
  async save(
    @CurrentUser() user: User,
    @Param('phoneNumberId') id: string,
    @Body() body: unknown,
  ) {
    const input = (body ?? {}) as Record<string, unknown>;
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    const interval = input.interval_hours;
    if (!prompt || prompt.length > 8000)
      throw apiError(
        HttpStatus.BAD_REQUEST,
        'Enter follow-up instructions of up to 8,000 characters',
      );
    if (
      typeof interval !== 'number' ||
      !Number.isInteger(interval) ||
      interval < 1 ||
      interval > 8760
    ) {
      throw apiError(
        HttpStatus.BAD_REQUEST,
        'Enter a recheck interval from 1 to 8,760 hours',
      );
    }
    if (typeof input.enabled !== 'boolean')
      throw apiError(HttpStatus.BAD_REQUEST, 'enabled must be true or false');
    return {
      success: true,
      data: await this.followUps.save(user.id, id, {
        prompt,
        intervalHours: interval,
        enabled: input.enabled,
      }),
    };
  }

  @Post('review')
  @HttpCode(202)
  async review(@CurrentUser() user: User, @Param('phoneNumberId') id: string) {
    return {
      success: true,
      data: await this.followUps.requestReview(user.id, id),
    };
  }
}
