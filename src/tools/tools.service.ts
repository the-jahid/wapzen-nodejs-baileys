import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  apiError,
  configFor,
  nameTaken,
  normalizeApiRequest,
  notFound,
  resolve,
  toResource,
  type ApiRequestConfig,
  type ToolInput,
} from './tools.types';
import { testApiRequest } from './runner';

// Attachments come back in the order they were made.
const withAttachments = {
  attachments: {
    select: { chatAgentId: true },
    orderBy: [{ createdAt: 'asc' }, { chatAgentId: 'asc' }],
  },
} satisfies Prisma.ToolInclude;

// The tool rules of the Go server's internal/tools/repository.go: tools are
// owned per user with a name unique per user, a tool someone else owns reads
// as missing, and the attachments are read-only here (a chat agent's
// tools.tool_ids writes them).
@Injectable()
export class ToolsService {
  private readonly logger = new Logger(ToolsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, type: string, page: number, limit: number) {
    const where = { userId, ...(type ? { type } : {}) };
    const [total, rows] = await Promise.all([
      this.prisma.tool.count({ where }),
      this.prisma.tool.findMany({
        where,
        include: withAttachments,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return { total, tools: rows.map(toResource) };
  }

  async get(userId: string, id: string) {
    return toResource(await this.load(userId, id));
  }

  // The stored row with its config decoded, for checks that depend on it.
  async resolved(userId: string, id: string) {
    return resolve(await this.load(userId, id));
  }

  async create(userId: string, input: ToolInput) {
    const type = input.type!.trim();
    return this.write('failed to create tool', async () => {
      const row = await this.prisma.tool.create({
        data: {
          userId,
          type,
          name: input.name!.trim(),
          description: input.description!.trim(),
          // Only the block for this type is stored, so a tool never carries
          // settings it doesn't read.
          config: configFor(type, input) ?? {},
        },
        include: withAttachments,
      });
      return toResource(row);
    });
  }

  // storedType is the tool's type as read before validating the input.
  async update(
    userId: string,
    id: string,
    storedType: string,
    input: ToolInput,
  ) {
    const data: Prisma.ToolUpdateManyMutationInput = { updatedAt: new Date() };
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.description !== undefined) {
      data.description = input.description.trim();
    }
    const config = configFor(storedType, input);
    if (config) data.config = config;

    return this.write('failed to update tool', async () => {
      const { count } = await this.prisma.tool.updateMany({
        where: { id, userId },
        data,
      });
      if (count === 0) throw notFound();
      return this.get(userId, id);
    });
  }

  async remove(userId: string, id: string) {
    // The attachment rows cascade, so every chat agent using it loses it.
    const { count } = await this.prisma.tool.deleteMany({
      where: { id, userId },
    });
    if (count === 0) throw notFound();
  }

  // Runs an api_request tool once; draft, when sent, is tested in place of
  // the stored configuration so an edit can be tried before it is saved.
  async test(
    userId: string,
    id: string,
    args: Record<string, unknown>,
    draft?: ApiRequestConfig,
  ) {
    const tool = await this.resolved(userId, id);
    if (tool.type !== 'api_request') {
      throw new HttpException(
        {
          success: false,
          message: 'Validation failed',
          errors: [
            {
              field: 'type',
              message:
                'only api_request tools send a request that can be tested',
            },
          ],
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    const cfg = draft ? normalizeApiRequest(draft) : tool.apiRequest!;
    return testApiRequest(cfg, args);
  }

  private async load(userId: string, id: string) {
    const row = await this.prisma.tool.findFirst({
      where: { id, userId },
      include: withAttachments,
    });
    if (!row) throw notFound();
    return row;
  }

  // Turns a name clash into a 409 and anything unexpected into a logged 500.
  private async write<T>(fallback: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpException) throw err;
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw nameTaken();
      }
      this.logger.error(`${fallback}: ${(err as Error).message}`);
      throw apiError(HttpStatus.INTERNAL_SERVER_ERROR, fallback);
    }
  }
}
