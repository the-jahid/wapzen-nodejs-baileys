import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { User } from '../generated/prisma/client';
import { ClerkAuthGuard, CurrentUser } from '../auth/auth.guard';
import { parseLoginRequest, parseLogoutRequest } from './phone-number.types';
import { WhatsAppService } from './whatsapp.service';

// The Go server's phone-number API, documented in docs/openapi.json (so the
// controller is kept out of the generated docs). Every route is scoped to the
// signed-in user.
@ApiExcludeController()
@UseGuards(ClerkAuthGuard)
@Controller('v1/phone-number')
export class WhatsAppController {
  constructor(private readonly whatsapp: WhatsAppService) {}

  @Get()
  async list(@CurrentUser() user: User) {
    return {
      success: true,
      message: 'Phone numbers retrieved successfully',
      data: await this.whatsapp.list(user.id),
    };
  }

  // Starts a QR (or pairing-code) login. With phone_number_id it reissues a
  // code for that number instead; force_repair also unlinks its current
  // device first.
  @Post('login')
  @HttpCode(200)
  async login(@CurrentUser() user: User, @Body() body: unknown) {
    const req = parseLoginRequest(body);
    if (req.phoneNumberId) {
      const data = await this.whatsapp.restartLogin(
        user.id,
        req.phoneNumberId,
        req.forceRepair,
        user.email,
      );
      return {
        success: true,
        message: req.forceRepair
          ? 'Phone number re-pairing started successfully'
          : 'Phone number login restarted successfully',
        data,
        links: { self: `/v1/phone-number/${data.id}` },
      };
    }
    const data = await this.whatsapp.startLogin(user.id, user.email, req);
    return {
      success: true,
      message: 'Phone number login started successfully',
      data,
      links: { self: `/v1/phone-number/${data.id}` },
    };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@CurrentUser() user: User, @Body() body: unknown) {
    const id = parseLogoutRequest(body);
    await this.whatsapp.logout(user.id, id);
    return {
      success: true,
      message: 'Phone number logged out and deleted successfully',
      data: { id, disconnected: true, deleted: true },
    };
  }

  // Poll this during a login: the QR code refreshes, and status becomes
  // connected once the phone links.
  @Get(':phone_number_id')
  async get(@CurrentUser() user: User, @Param('phone_number_id') id: string) {
    const data = await this.whatsapp.get(user.id, id.trim());
    return {
      success: true,
      message: 'Phone number retrieved successfully',
      data,
      links: { self: `/v1/phone-number/${data.id}` },
    };
  }
}
