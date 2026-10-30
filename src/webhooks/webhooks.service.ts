import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// The parts of a Clerk user event this server reads.
export type ClerkEvent = {
  type?: string;
  data?: {
    id?: string;
    email_addresses?: { id?: string; email_address?: string }[];
    primary_email_address_id?: string;
    username?: string | null;
  };
};

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Mirrors the Go server's WebhookHandler.handleClerkEvent: created/updated
  // upsert the user by Clerk id, deleted removes it (its phone numbers and
  // chat agents cascade). Other event types are accepted and ignored.
  // Returns an error message for a payload it can't use.
  async handleClerkEvent(event: ClerkEvent): Promise<string | null> {
    const user = event.data;
    switch (event.type) {
      case 'user.created':
      case 'user.updated': {
        if (!user?.id) return 'webhook user id is required';
        const email = primaryEmail(user);
        // users.email is required, so a Clerk user without one (phone-only
        // sign-up, or Clerk's "Send Example" event) can't be stored. Accept
        // it anyway: a 400 would only make Clerk retry it for days.
        if (!email) {
          this.logger.warn(`skipping ${event.type} for ${user.id}: no email`);
          return null;
        }
        const username = user.username ?? null;
        await this.prisma.user.upsert({
          where: { oauthId: user.id },
          create: { oauthId: user.id, email, username },
          update: { email, username },
        });
        return null;
      }
      case 'user.deleted':
        if (!user?.id) return 'webhook user id is required';
        await this.prisma.user.deleteMany({ where: { oauthId: user.id } });
        return null;
      default:
        return null;
    }
  }
}

// The primary address, falling back to the first one listed. Also used by
// the auth guard, whose Clerk API user has the same shape.
export function primaryEmail(user: NonNullable<ClerkEvent['data']>): string {
  const emails = user.email_addresses ?? [];
  const primary = emails.find((e) => e.id === user.primary_email_address_id);
  return (primary ?? emails[0])?.email_address ?? '';
}
