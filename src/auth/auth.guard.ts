import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { signInFailed, userSignedIn, userSignedUp } from '../activity/activity';
import { createStarterAgent } from '../chat-agents/starter-agent';
import type { User } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { primaryEmail } from '../webhooks/webhooks.service';
import { ClerkClient } from './clerk';

type AuthedRequest = Request & { user?: User };

// Mirrors the Go server's RequireUser: the dashboard sends its Clerk session
// token as "Authorization: Bearer <token>". The token's Clerk user is mapped
// to the users row, which is created on the spot when the first request beats
// the Clerk webhook. Blocked accounts get a 403 the dashboard recognises by
// its X-Account-Blocked header. Generated API keys (wcai_...) are not
// supported here yet.
@Injectable()
export class ClerkAuthGuard implements CanActivate {
  private readonly logger = new Logger(ClerkAuthGuard.name);
  private readonly clerk: ClerkClient;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.clerk = new ClerkClient(config.getOrThrow<string>('CLERK_SECRET_KEY'));
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = bearerToken(req);
    if (!token) throw unauthorized();

    let clerkId: string;
    try {
      clerkId = await this.clerk.verifySessionToken(token);
    } catch (err) {
      this.logger.warn(
        `token rejected: ${(err as Error).message} on ${req.method} ${req.path} (${req.headers['user-agent'] ?? 'no user agent'})`,
      );
      throw unauthorized();
    }

    let user: User;
    try {
      user = await this.resolveUser(clerkId);
    } catch (err) {
      this.logger.error(
        `resolving user for clerk id ${clerkId} failed: ${(err as Error).message}`,
      );
      signInFailed(clerkId, (err as Error).message);
      throw new HttpException(
        fail('failed to resolve the authenticated user'),
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    if (user.blockedAt) {
      context
        .switchToHttp()
        .getResponse<Response>()
        .setHeader('X-Account-Blocked', 'true');
      throw new HttpException(
        fail('This account has been blocked'),
        HttpStatus.FORBIDDEN,
      );
    }

    userSignedIn(clerkId, user.email);
    req.user = user;
    return true;
  }

  private async resolveUser(clerkId: string): Promise<User> {
    const existing = await this.prisma.user.findUnique({
      where: { oauthId: clerkId },
    });
    if (existing) return existing;

    const clerkUser = await this.clerk.getUser(clerkId);
    const email = primaryEmail(clerkUser);
    if (!email) throw new Error(`clerk user ${clerkId} has no email address`);
    const username = clerkUser.username ?? null;
    const user = await this.prisma.user
      .upsert({
        where: { oauthId: clerkId },
        create: { oauthId: clerkId, email, username },
        update: { email, username },
      })
      .catch((err: Error & { code?: string }) => {
        throw err.code === 'P2002'
          ? new Error(`${email} already belongs to another account`)
          : err;
      });
    userSignedUp(clerkId, email);
    await createStarterAgent(this.prisma, user.id, email, username);
    return user;
  }
}

// The users row the guard resolved. Only valid behind ClerkAuthGuard.
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): User =>
    context.switchToHttp().getRequest<AuthedRequest>().user!,
);

function bearerToken(req: Request): string {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.trim().split(/\s+/, 2);
  return scheme?.toLowerCase() === 'bearer' && token ? token : '';
}

function unauthorized() {
  return new HttpException(
    fail(
      'Authentication required: send a valid Clerk session token in the Authorization header',
    ),
    HttpStatus.UNAUTHORIZED,
  );
}

function fail(message: string) {
  return { success: false, message };
}
