import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { KnowledgeBase } from '../generated/prisma/client';
import { chunkText } from './chunk';
import { CHUNK_ID_SEPARATOR } from './knowledge-bases.types';

// Pinned so a server-side default moving on can't change these calls.
const PINECONE_API_VERSION = '2025-04';
// Pinecone caps a request at 2 MB; a 3072-dim vector is ~40 KB of JSON.
const UPSERT_BATCH = 32;
// Pinecone's documented limit of ids per delete.
const DELETE_BATCH = 1000;
const EMBED_BATCH = 64;
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-large';
const DEFAULT_DIMENSION = 3072;

type StoredSource = {
  id: string;
  type: string;
  title: string;
  content: string;
};

type Vector = {
  id: string;
  values: number[];
  metadata: Record<string, string | number>;
};

// Turns stored sources into vectors in a knowledge base's Pinecone namespace:
// chunk with the knowledge base's own sizes, embed each chunk with OpenAI,
// upsert under the namespace. Ported from the Go server's
// internal/knowledgebases/indexer.go plus its pinecone and embeddings clients,
// writing into the same index, so ids and metadata have the same shape.
@Injectable()
export class IndexerService {
  private readonly logger = new Logger(IndexerService.name);
  private readonly openaiKey: string;
  private readonly model: string;
  private readonly pineconeKey: string;
  private readonly pineconeHost: string;
  private readonly dimension: number;

  constructor(config: ConfigService) {
    this.openaiKey = config.get<string>('OPENAI_API_KEY', '').trim();
    this.model = config.get<string>(
      'OPENAI_EMBEDDING_MODEL',
      DEFAULT_EMBEDDING_MODEL,
    );
    this.pineconeKey = config.get<string>('PINECONE_API_KEY', '').trim();
    const host = config.get<string>('PINECONE_INDEX_HOST', '').trim();
    this.pineconeHost = !host
      ? ''
      : (/^https?:\/\//.test(host) ? host : `https://${host}`).replace(
          /\/+$/,
          '',
        );
    this.dimension =
      Number(config.get('PINECONE_INDEX_DIMENSION')) || DEFAULT_DIMENSION;
  }

  // False when a key or the index host is missing. Every other knowledge base
  // endpoint keeps working; only indexing answers 503.
  get enabled(): boolean {
    return Boolean(this.openaiKey && this.pineconeKey && this.pineconeHost);
  }

  // Indexes freshly stored sources, then hands record() each one's chunk
  // count, in order, to save on the rows. All-or-nothing: if anything fails,
  // record() included, the vectors this call wrote are deleted again before
  // the error is rethrown. The rows are the caller's to clean up.
  async indexSources(
    kb: KnowledgeBase,
    sources: StoredSource[],
    record: (chunkCounts: number[]) => Promise<void>,
  ) {
    const namespace = this.namespaceOf(kb);
    const written: string[] = [];
    const counts: number[] = [];
    try {
      for (const source of sources) {
        const chunks = chunkText(
          source.content,
          kb.minChunkSize,
          kb.maxChunkSize,
        );
        counts.push(chunks.length);
        if (!chunks.length) continue;

        const embeddings = await this.embed(chunks);
        const ids = chunks.map((_, i) => vectorId(source.title, i));
        // Added before the upsert: it runs in batches, so a failure can leave
        // part of this source written.
        written.push(...ids);
        await this.upsert(
          namespace,
          chunks.map((text, i) => ({
            id: ids[i],
            values: embeddings[i],
            // The chunk text rides along so a retrieval hit can go straight
            // into a prompt without reading Postgres again.
            metadata: {
              knowledge_base_id: kb.id,
              source_id: source.id,
              type: source.type,
              title: source.title,
              chunk_index: i,
              text,
            },
          })),
        );
      }
      await record(counts);
    } catch (err) {
      if (written.length) {
        await this.deleteIds(namespace, written).catch((cleanup: Error) =>
          this.logger.error(
            `rolling back ${written.length} vectors in ${namespace} failed: ${cleanup.message}`,
          ),
        );
      }
      throw err;
    }
  }

  // Removes one source's vectors, rebuilding the ids from its title and
  // stored chunk count. Nothing to do for a source that was never indexed.
  async deleteSourceVectors(
    kb: KnowledgeBase,
    source: { title: string; chunkCount: number },
  ) {
    if (source.chunkCount <= 0) return;
    const ids = Array.from({ length: source.chunkCount }, (_, i) =>
      vectorId(source.title, i),
    );
    await this.deleteIds(this.namespaceOf(kb), ids);
  }

  // Removes every vector of a knowledge base. Pinecone answers 404 for a
  // namespace that holds nothing, which is the state wanted.
  async purgeNamespace(kb: KnowledgeBase) {
    if (!kb.pineconeNamespace) return;
    try {
      await this.pinecone('/vectors/delete', {
        namespace: kb.pineconeNamespace,
        deleteAll: true,
      });
    } catch (err) {
      if (!(err instanceof UpstreamError && err.status === 404)) throw err;
    }
  }

  private namespaceOf(kb: KnowledgeBase): string {
    if (!kb.pineconeNamespace) {
      throw new Error(`knowledge base ${kb.id} has no vector-store namespace`);
    }
    return kb.pineconeNamespace;
  }

  // One vector per input, in input order.
  private async embed(inputs: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let start = 0; start < inputs.length; start += EMBED_BATCH) {
      const batch = inputs.slice(start, start + EMBED_BATCH);
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.openaiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input: batch,
          dimensions: this.dimension,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      const body = (await res.json().catch(() => null)) as {
        data?: { index: number; embedding: number[] }[];
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        throw new UpstreamError(
          'openai embeddings',
          res.status,
          body?.error?.message ?? res.statusText,
        );
      }
      const data = [...(body?.data ?? [])].sort((a, b) => a.index - b.index);
      if (data.length !== batch.length) {
        throw new Error(
          `openai embeddings: got ${data.length} vectors for ${batch.length} inputs`,
        );
      }
      out.push(...data.map((d) => d.embedding));
    }
    return out;
  }

  private async upsert(namespace: string, vectors: Vector[]) {
    for (const v of vectors) {
      if (v.values.length !== this.dimension) {
        throw new Error(
          `pinecone: vector ${v.id} has ${v.values.length} dimensions, index expects ${this.dimension}`,
        );
      }
    }
    for (let start = 0; start < vectors.length; start += UPSERT_BATCH) {
      await this.pinecone('/vectors/upsert', {
        namespace,
        vectors: vectors.slice(start, start + UPSERT_BATCH),
      });
    }
  }

  // Ids that aren't there are ignored, so this is safe as a rollback.
  private async deleteIds(namespace: string, ids: string[]) {
    for (let start = 0; start < ids.length; start += DELETE_BATCH) {
      await this.pinecone('/vectors/delete', {
        namespace,
        ids: ids.slice(start, start + DELETE_BATCH),
      });
    }
  }

  private async pinecone(path: string, payload: unknown) {
    const res = await fetch(this.pineconeHost + path, {
      method: 'POST',
      headers: {
        'Api-Key': this.pineconeKey,
        'Content-Type': 'application/json',
        'X-Pinecone-API-Version': PINECONE_API_VERSION,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new UpstreamError(
        'pinecone',
        res.status,
        (await res.text().catch(() => '')).trim(),
      );
    }
  }
}

class UpstreamError extends Error {
  constructor(
    service: string,
    readonly status: number,
    detail: string,
  ) {
    super(`${service}: request failed (${status}): ${detail}`);
  }
}

// A chunk's Pinecone record id: the source title verbatim, so the console
// lists content by name; chunks after the first get "#2", "#3", ... Unique
// because titles are unique per knowledge base and may not contain "#".
function vectorId(title: string, chunkIndex: number): string {
  return chunkIndex === 0
    ? title
    : `${title}${CHUNK_ID_SEPARATOR}${chunkIndex + 1}`;
}
