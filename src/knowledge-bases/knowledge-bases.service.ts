import { randomUUID } from 'node:crypto';
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { KnowledgeBase, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IndexerService } from './indexer.service';
import {
  apiError,
  checkChunkOrder,
  CreateInput,
  NewSource,
  toResource,
  UpdateInput,
} from './knowledge-bases.types';

type StoredSource = {
  id: string;
  type: string;
  title: string;
  content: string;
};

// What a resource lists per source. The content is stored to be re-chunked,
// never returned.
const SOURCES = {
  select: { id: true, type: true, title: true, chunkCount: true },
  orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
};

// The Go server's knowledge base rules (handlers/knowledge_base_handler.go,
// knowledge_base_sources.go). Indexing runs inside the request, so a write
// answers with the finished knowledge base rather than one to poll, and it is
// all-or-nothing: a failed index leaves no half-written source behind.
@Injectable()
export class KnowledgeBasesService {
  private readonly logger = new Logger(KnowledgeBasesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly indexer: IndexerService,
  ) {}

  async list(userId: string, page: number, limit: number) {
    const [total, rows] = await Promise.all([
      this.prisma.knowledgeBase.count({ where: { userId } }),
      this.prisma.knowledgeBase.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: { sources: SOURCES },
      }),
    ]);
    return { total, knowledgeBases: rows.map(toResource) };
  }

  async get(userId: string, id: string) {
    return toResource(await this.load(userId, id, true));
  }

  async create(userId: string, input: CreateInput) {
    // Refused before the insert: a knowledge base whose content can't be
    // indexed is exactly what this endpoint must not produce.
    if (input.texts.length && !this.indexer.enabled) {
      throw apiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'knowledge base indexing is not configured, so sources cannot be indexed',
      );
    }

    // The namespace comes from the id, so it is stable from the start and
    // traceable back to its knowledge base.
    const id = randomUUID();
    let kb: KnowledgeBase;
    try {
      kb = await this.prisma.knowledgeBase.create({
        data: {
          id,
          userId,
          name: input.name,
          pineconeNamespace: `kb_${id.replace(/-/g, '')}`,
          enableAutoRefresh: input.enableAutoRefresh,
          maxChunkSize: input.maxChunkSize,
          minChunkSize: input.minChunkSize,
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw this.failure('failed to create knowledge base', err);
    }
    if (!input.texts.length) return toResource(kb);

    // From here a failure takes the new knowledge base back out, so the same
    // request can be retried, name included. (Add Sources instead leaves an
    // existing knowledge base at status error: that one isn't its to delete.)
    try {
      const sources = await this.insertSources(kb.id, input.texts);
      await this.indexer.indexSources(kb, sources, (counts) =>
        this.saveChunkCounts(sources, counts),
      );
    } catch (err) {
      await this.discard(kb);
      if (isUniqueViolation(err)) {
        throw apiError(
          HttpStatus.CONFLICT,
          'two sources in this request share a title; titles must be unique within a knowledge base',
        );
      }
      this.logger.error(
        `knowledge base ${kb.id}: indexing during create failed: ${(err as Error).message}`,
      );
      throw apiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'failed to index knowledge base sources; the knowledge base was not created',
      );
    }
    await this.setStatus(kb, 'complete');
    return toResource(await this.load(userId, kb.id, true));
  }

  async update(userId: string, id: string, input: UpdateInput) {
    // Supplies whichever chunk size the body left out, and is the ownership
    // check.
    const current = await this.load(userId, id, false);
    checkChunkOrder(
      input.minChunkSize ?? current.minChunkSize,
      input.maxChunkSize ?? current.maxChunkSize,
    );
    try {
      const row = await this.prisma.knowledgeBase.update({
        where: { id: current.id },
        data: input,
        include: { sources: SOURCES },
      });
      return toResource(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw this.failure('failed to update knowledge base', err);
    }
  }

  // The source rows cascade; the Pinecone namespace is purged after the row
  // is gone, best effort. An orphaned namespace is recoverable, vectors
  // deleted under a knowledge base that then failed to delete are not.
  async remove(userId: string, id: string) {
    const kb = await this.prisma.knowledgeBase.findFirst({
      where: { id, userId },
    });
    const { count } = await this.prisma.knowledgeBase.deleteMany({
      where: { id, userId },
    });
    if (count === 0) throw notFound();
    if (kb && this.indexer.enabled) {
      await this.indexer
        .purgeNamespace(kb)
        .catch((err: Error) =>
          this.logger.error(
            `knowledge base ${id}: purging vector namespace failed: ${err.message}`,
          ),
        );
    }
  }

  // The knowledge base a sources request is about. Checked before the body is
  // read, so an upload isn't read when nothing can be done with it.
  async loadForSources(userId: string, id: string) {
    if (!this.indexer.enabled) {
      throw apiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'knowledge base indexing is not configured',
      );
    }
    const kb = await this.load(userId, id, false);
    if (!kb.pineconeNamespace) {
      throw apiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'knowledge base has no vector-store namespace',
      );
    }
    return kb;
  }

  async addSources(kb: KnowledgeBase, entries: NewSource[]) {
    // Moved first so a client polling mid-request sees indexing in progress.
    await this.setStatus(kb, 'in_progress');

    let sources: StoredSource[];
    try {
      sources = await this.insertSources(kb.id, entries);
    } catch (err) {
      // A duplicate title wrote nothing, so the old status stands.
      if (isUniqueViolation(err)) {
        await this.setStatus(kb, kb.status);
        throw apiError(
          HttpStatus.CONFLICT,
          'a source with this title already exists in this knowledge base',
        );
      }
      await this.setStatus(kb, 'error');
      throw this.failure('failed to store knowledge base sources', err);
    }

    try {
      await this.indexer.indexSources(kb, sources, (counts) =>
        this.saveChunkCounts(sources, counts),
      );
    } catch (err) {
      this.logger.error(
        `knowledge base ${kb.id}: indexing sources failed: ${(err as Error).message}`,
      );
      // The indexer already removed its vectors; the rows go too, so a retry
      // with the same body can't hit its own titles.
      await this.prisma.knowledgeBaseSource
        .deleteMany({ where: { id: { in: sources.map((s) => s.id) } } })
        .catch((cleanup: Error) =>
          this.logger.error(
            `knowledge base ${kb.id}: rolling back source rows failed: ${cleanup.message}`,
          ),
        );
      await this.setStatus(kb, 'error');
      throw apiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'failed to index knowledge base sources',
      );
    }

    await this.setStatus(kb, 'complete');
    return toResource(await this.load(kb.userId, kb.id, true));
  }

  // Vectors first, row second: the row is what the vector ids are rebuilt
  // from, so dropping it first and then failing would strand chunks agents
  // keep quoting. This way a failure leaves the source intact to retry.
  async deleteSource(
    userId: string,
    knowledgeBaseId: string,
    sourceId: string,
  ) {
    const kb = await this.load(userId, knowledgeBaseId, false);
    const source = await this.prisma.knowledgeBaseSource.findFirst({
      where: { id: sourceId, knowledgeBaseId: kb.id },
      select: { title: true, chunkCount: true },
    });
    if (!source) throw sourceNotFound();

    // A source that was never indexed has nothing in Pinecone, so it stays
    // deletable on a server without the keys.
    if (source.chunkCount > 0) {
      if (!this.indexer.enabled) {
        throw apiError(
          HttpStatus.SERVICE_UNAVAILABLE,
          "knowledge base indexing is not configured, so this source's vectors cannot be removed",
        );
      }
      try {
        await this.indexer.deleteSourceVectors(kb, source);
      } catch (err) {
        this.logger.error(
          `knowledge base ${kb.id}: deleting vectors of source ${sourceId} failed: ${(err as Error).message}`,
        );
        throw apiError(
          HttpStatus.BAD_GATEWAY,
          "failed to remove the source's vectors; the source was left in place",
        );
      }
    }

    const { count } = await this.prisma.knowledgeBaseSource.deleteMany({
      where: { id: sourceId, knowledgeBaseId: kb.id },
    });
    if (count === 0) throw sourceNotFound();
    return kb.id;
  }

  // One knowledge base of the user's, or 404 (somebody else's reads as
  // missing).
  private async load(userId: string, id: string, withSources: boolean) {
    const kb = await this.prisma.knowledgeBase.findFirst({
      where: { id, userId },
      include: withSources ? { sources: SOURCES } : undefined,
    });
    if (!kb) throw notFound();
    return kb;
  }

  // Stores the sources in one statement, so a failure (a duplicate title)
  // leaves none of them. chunk_count stays 0 until the vectors are written.
  private async insertSources(
    knowledgeBaseId: string,
    entries: NewSource[],
  ): Promise<StoredSource[]> {
    const sources = entries.map((e) => ({
      id: randomUUID(),
      type: e.type,
      title: e.title,
      content: e.text,
    }));
    await this.prisma.knowledgeBaseSource.createMany({
      data: sources.map((s) => ({ ...s, knowledgeBaseId })),
    });
    return sources;
  }

  private async saveChunkCounts(sources: { id: string }[], counts: number[]) {
    const ids = sources.map((s) => s.id);
    await this.prisma.$executeRaw`
      UPDATE knowledge_base_sources AS s
      SET chunk_count = c.n, updated_at = now()
      FROM unnest(${ids}::text[], ${counts}::int[]) AS c(id, n)
      WHERE s.id = c.id`;
  }

  // Removes a knowledge base whose create failed, with anything written to
  // its namespace. Best effort: the request already failed, and a cleanup
  // error mustn't replace the one the caller needs to see.
  private async discard(kb: KnowledgeBase) {
    await this.indexer
      .purgeNamespace(kb)
      .catch((err: Error) =>
        this.logger.error(
          `knowledge base ${kb.id}: purging a failed create failed: ${err.message}`,
        ),
      );
    await this.prisma.knowledgeBase
      .deleteMany({ where: { id: kb.id } })
      .catch((err: Error) =>
        this.logger.error(
          `knowledge base ${kb.id}: removing a failed create failed: ${err.message}`,
        ),
      );
  }

  // The status only reports progress, so failing to write it is logged
  // rather than failing a request whose work succeeded.
  private async setStatus(kb: KnowledgeBase, status: string) {
    await this.prisma.knowledgeBase
      .updateMany({ where: { id: kb.id, userId: kb.userId }, data: { status } })
      .catch((err: Error) =>
        this.logger.error(
          `knowledge base ${kb.id}: setting status ${status} failed: ${err.message}`,
        ),
      );
  }

  private failure(message: string, err: unknown): HttpException {
    if (err instanceof HttpException) return err;
    this.logger.error(`${message}: ${(err as Error).message}`);
    return apiError(HttpStatus.INTERNAL_SERVER_ERROR, message);
  }
}

function isUniqueViolation(err: unknown) {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

function notFound() {
  return apiError(HttpStatus.NOT_FOUND, 'knowledge base not found');
}

function sourceNotFound() {
  return apiError(HttpStatus.NOT_FOUND, 'knowledge base source not found');
}

function nameTaken() {
  return apiError(
    HttpStatus.CONFLICT,
    'a knowledge base with this name already exists',
  );
}
