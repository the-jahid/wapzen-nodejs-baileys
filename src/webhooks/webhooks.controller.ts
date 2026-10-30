import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  InternalServerErrorException,
  Logger,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { verifySvix } from './svix';
import { ClerkEvent, WebhooksService } from './webhooks.service';

// Errors use the Go server's { success, message } envelope rather than Nest's
// default error body, matching docs/openapi.json. Documented there, so the
// controller is kept out of the generated docs.
@ApiExcludeController()
@Controller('api/webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly webhooks: WebhooksService,
    private readonly config: ConfigService,
  ) {}

  @Post('clerk')
  @HttpCode(200)
  async clerk(
    @Req() req: RawBodyRequest<Request>,
    @Headers('svix-id') id?: string,
    @Headers('svix-timestamp') timestamp?: string,
    @Headers('svix-signature') signature?: string,
  ) {
    const secret = this.config.get<string>('CLERK_WEBHOOK_SIGNING_SECRET');
    if (!secret) {
      throw new InternalServerErrorException(
        fail('Clerk webhook signing secret is not configured'),
      );
    }
    // The signature covers the exact bytes Clerk sent, so verify against the
    // raw body (main.ts turns rawBody on), never re-serialized JSON.
    if (!req.rawBody) {
      throw new BadRequestException(fail('Invalid webhook body'));
    }

    try {
      verifySvix(secret, req.rawBody, { id, timestamp, signature });
    } catch (err) {
      this.logger.warn(`clerk webhook rejected: ${(err as Error).message}`);
      throw new BadRequestException(fail('Invalid webhook signature'));
    }

    let event: ClerkEvent;
    try {
      event = JSON.parse(req.rawBody.toString('utf8')) as ClerkEvent;
    } catch {
      throw new BadRequestException(fail('Invalid webhook payload'));
    }

    let problem: string | null;
    try {
      problem = await this.webhooks.handleClerkEvent(event);
    } catch (err) {
      // e.g. a new Clerk user whose email another account already has
      problem = `sync webhook user: ${(err as Error).message}`;
    }
    if (problem) throw new BadRequestException(fail(problem));

    return { success: true, message: 'Webhook processed' };
  }
}

function fail(message: string) {
  return { success: false, message };
}
