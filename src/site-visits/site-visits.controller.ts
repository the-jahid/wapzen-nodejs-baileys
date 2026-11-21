import { timingSafeEqual } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { validationFailed } from '../tools/tools.types';
import { SiteVisitsService } from './site-visits.service';

// The website (frontend /api/visit) hashes each visitor and posts it here with
// this shared secret, so nobody else can add visits. Unset = visits refused.
function secretMatches(sent: string | undefined): boolean {
  const expected = process.env.SITE_VISITS_SECRET ?? '';
  if (!expected || !sent) return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const VISITOR = /^[0-9a-f]{64}$/;
const COUNTRY = /^[A-Z]{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Public: the numbers on wapzen.io/status. No sign-in.
@ApiExcludeController()
@Controller('v1/site-visits')
export class SiteVisitsController {
  constructor(private readonly visits: SiteVisitsService) {}

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  async record(
    @Headers('x-site-visits-secret') secret: string | undefined,
    @Body() body: { visitor?: unknown; country?: unknown },
  ) {
    if (!secretMatches(secret)) {
      throw new HttpException(
        { success: false, message: 'Not allowed' },
        HttpStatus.FORBIDDEN,
      );
    }
    const visitor = typeof body?.visitor === 'string' ? body.visitor : '';
    if (!VISITOR.test(visitor)) {
      throw validationFailed([
        { field: 'visitor', message: 'must be 64 hex characters' },
      ]);
    }
    const country =
      typeof body.country === 'string' && COUNTRY.test(body.country)
        ? body.country
        : null;
    await this.visits.record(visitor, country);
  }

  @Get('stats')
  @Header('Cache-Control', 'public, max-age=30')
  async stats(@Query('date') date?: string) {
    if (date !== undefined && (!DATE.test(date) || isNaN(Date.parse(date)))) {
      throw validationFailed([
        { field: 'date', message: 'must be a date like 2026-11-16' },
      ]);
    }
    return {
      success: true,
      message: 'Visitor stats retrieved successfully',
      data: await this.visits.stats(date ?? null),
    };
  }
}
