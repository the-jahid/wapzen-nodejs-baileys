import { timingSafeEqual } from 'node:crypto';
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { validationFailed } from '../tools/tools.types';
import { parseInput } from './free-tools-prompts';
import { FreeToolLimitError, FreeToolsService } from './free-tools.service';

// The website's /api/free-tools/ai route calls this with the same shared
// secret as site visits, plus a hash of the visitor's IP and browser that the
// limits are counted on. Browsers can't call it directly, so nobody can skip
// the website or pick their own visitor id.
function secretMatches(sent: string | undefined): boolean {
  const expected = process.env.SITE_VISITS_SECRET ?? '';
  if (!expected || !sent) return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const VISITOR = /^[0-9a-f]{64}$/;

@ApiExcludeController()
@Controller('v1/free-tools')
export class FreeToolsController {
  private readonly logger = new Logger(FreeToolsController.name);

  constructor(private readonly tools: FreeToolsService) {}

  @Post('ai')
  @HttpCode(HttpStatus.OK)
  async generate(
    @Headers('x-site-visits-secret') secret: string | undefined,
    @Body() body: Record<string, unknown> | undefined,
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
    const parsed = parseInput(body);
    if ('errors' in parsed) throw validationFailed(parsed.errors);
    try {
      const options = await this.tools.generate(visitor, parsed.input);
      return { success: true, message: 'Messages written', data: { options } };
    } catch (err) {
      if (err instanceof FreeToolLimitError) {
        throw new HttpException(
          { success: false, message: err.message },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      this.logger.warn(
        `free tool failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new HttpException(
        {
          success: false,
          message: "The AI couldn't write messages just now. Please try again.",
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }
}
