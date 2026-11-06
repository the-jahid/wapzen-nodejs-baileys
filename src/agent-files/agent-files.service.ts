import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, Pool } from 'pg';
import type { AgentFile, OutgoingFile } from './agent-files.types';

// Uploads are few and the database is far away, so a small pool is plenty.
const POOL_SIZE = 3;
const IDLE_MS = 5 * 60_000;
const CONNECT_TIMEOUT_MS = 20_000;
// This database is a long way from the server (Seoul from Frankfurt), and every
// reply asks what files its agent has. An upload or delete clears the entry, and
// this only limits how long another instance's change can go unseen.
const LIST_CACHE_MS = 60_000;

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS agent_files (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id text NOT NULL,
    chat_agent_id text NOT NULL,
    file_name text NOT NULL,
    mime_type text NOT NULL,
    size_bytes integer NOT NULL,
    description text NOT NULL,
    data bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS agent_files_agent_idx
    ON agent_files (chat_agent_id, created_at);
  CREATE INDEX IF NOT EXISTS agent_files_user_idx ON agent_files (user_id);
  ALTER TABLE agent_files ENABLE ROW LEVEL SECURITY;
`;

const LIST_COLUMNS = `id, file_name, mime_type, size_bytes, description,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at`;

// Supabase's pooler has its own certificate authority, which Node doesn't know,
// so the connection is encrypted without checking who signed the certificate.
function connection(connectionString: string) {
  return {
    connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    ssl: connectionString.includes('.supabase.com')
      ? { rejectUnauthorized: false }
      : undefined,
  };
}

// Images and documents agents can send. They live in their own database
// (FILES_DATABASE_URL), beside the main one (DATABASE_URL) and holding nothing
// else. Nothing here can join the main database: who owns an agent is checked
// there, and removing an agent or user has to remove its files here by hand.
// Without the setting the feature is off and everything else works as before.
@Injectable()
export class AgentFilesService implements OnModuleDestroy {
  private readonly logger = new Logger(AgentFilesService.name);
  private readonly pool?: Pool;
  private readonly setupUrl?: string;
  private tableReady?: Promise<void>;
  private readonly listed = new Map<
    string,
    { files: AgentFile[]; at: number }
  >();

  constructor(config: ConfigService) {
    const url = config.get<string>('FILES_DATABASE_URL');
    if (!url) return;
    this.setupUrl = config.get<string>('FILES_DIRECT_URL') || url;
    this.pool = new Pool({
      ...connection(url),
      max: POOL_SIZE,
      idleTimeoutMillis: IDLE_MS,
      keepAlive: true,
    });
    // Without a listener a dropped idle connection would take the server down.
    this.pool.on('error', (err) =>
      this.logger.warn(`files database connection lost: ${err.message}`),
    );
  }

  get enabled() {
    return !!this.pool;
  }

  async onModuleDestroy() {
    await this.pool?.end();
  }

  // The table is made on first use, over the session connection, and tried again
  // next time if that fails, so a database that's down at boot can't stop the
  // server or leave the feature broken until a restart.
  private async db() {
    if (!this.pool) throw new Error('FILES_DATABASE_URL is not set');
    this.tableReady ??= this.createTable().catch((err: Error) => {
      this.tableReady = undefined;
      throw err;
    });
    await this.tableReady;
    return this.pool;
  }

  private async createTable() {
    const client = new Client(connection(this.setupUrl!));
    await client.connect();
    try {
      await client.query(CREATE_TABLE);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async list(agentId: string): Promise<AgentFile[]> {
    const db = await this.db();
    const { rows } = await db.query<AgentFile>(
      `SELECT ${LIST_COLUMNS} FROM agent_files
        WHERE chat_agent_id = $1 ORDER BY agent_files.created_at, id`,
      [agentId],
    );
    return rows;
  }

  // The list for a reply, which is asked for far more often than it changes.
  async listForReply(agentId: string): Promise<AgentFile[]> {
    if (!this.pool) return [];
    const hit = this.listed.get(agentId);
    if (hit && Date.now() - hit.at < LIST_CACHE_MS) return hit.files;
    const files = await this.list(agentId);
    this.listed.set(agentId, { files, at: Date.now() });
    return files;
  }

  async count(agentId: string) {
    const db = await this.db();
    const { rows } = await db.query<{ count: string }>(
      'SELECT count(*) FROM agent_files WHERE chat_agent_id = $1',
      [agentId],
    );
    return Number(rows[0].count);
  }

  async add(file: {
    userId: string;
    agentId: string;
    fileName: string;
    mimeType: string;
    description: string;
    data: Buffer;
  }): Promise<AgentFile> {
    const db = await this.db();
    const { rows } = await db.query<AgentFile>(
      `INSERT INTO agent_files
         (user_id, chat_agent_id, file_name, mime_type, size_bytes, description, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${LIST_COLUMNS}`,
      [
        file.userId,
        file.agentId,
        file.fileName,
        file.mimeType,
        file.data.length,
        file.description,
        file.data,
      ],
    );
    this.listed.delete(file.agentId);
    return rows[0];
  }

  // The file with its new note, or undefined when it isn't this agent's.
  async updateDescription(
    agentId: string,
    id: string,
    description: string,
  ): Promise<AgentFile | undefined> {
    const db = await this.db();
    const { rows } = await db.query<AgentFile>(
      `UPDATE agent_files SET description = $1
        WHERE id = $2 AND chat_agent_id = $3
        RETURNING ${LIST_COLUMNS}`,
      [description, id, agentId],
    );
    this.listed.delete(agentId);
    return rows[0];
  }

  // Whether the file was there to remove.
  async remove(agentId: string, id: string) {
    const db = await this.db();
    const { rowCount } = await db.query(
      'DELETE FROM agent_files WHERE id = $1 AND chat_agent_id = $2',
      [id, agentId],
    );
    this.listed.delete(agentId);
    return !!rowCount;
  }

  async content(agentId: string, id: string): Promise<OutgoingFile> {
    const db = await this.db();
    const { rows } = await db.query<{
      file_name: string;
      mime_type: string;
      data: Buffer;
    }>(
      `SELECT file_name, mime_type, data FROM agent_files
        WHERE id = $1 AND chat_agent_id = $2`,
      [id, agentId],
    );
    if (!rows[0]) throw new Error(`file ${id} is gone`);
    return {
      fileName: rows[0].file_name,
      mimeType: rows[0].mime_type,
      data: rows[0].data,
    };
  }

  // The agent or user is already gone by the time these run, so a failure here
  // can only be logged: it leaves files behind, it doesn't bring anything back.
  async removeForAgent(agentId: string) {
    if (!this.pool) return;
    this.listed.delete(agentId);
    await this.purge('chat_agent_id', agentId);
  }

  async removeForUser(userId: string) {
    if (!this.pool) return;
    this.listed.clear();
    await this.purge('user_id', userId);
  }

  private async purge(column: 'chat_agent_id' | 'user_id', id: string) {
    try {
      const db = await this.db();
      await db.query(`DELETE FROM agent_files WHERE ${column} = $1`, [id]);
    } catch (err) {
      this.logger.error(
        `removing files for ${column} ${id} failed: ${(err as Error).message}`,
      );
    }
  }
}
