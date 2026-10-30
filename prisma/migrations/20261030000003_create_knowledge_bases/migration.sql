-- Knowledge bases and their sources, ported from the Go server's migrations
-- 00031–00035. Postgres holds the container, its indexing status and each
-- source's text; the embeddings live in Pinecone under pinecone_namespace.
-- Unlike Go, no agent column: attaching a knowledge base to a chat agent is
-- not built on this server yet.

-- CreateTable
CREATE TABLE "knowledge_bases" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "knowledge_base_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "enable_auto_refresh" BOOLEAN NOT NULL DEFAULT false,
    "last_refreshed_at" TIMESTAMPTZ,
    "max_chunk_size" INTEGER NOT NULL DEFAULT 2000,
    "min_chunk_size" INTEGER NOT NULL DEFAULT 400,
    "pinecone_namespace" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_bases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_base_sources" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "knowledge_base_id" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'text',
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_base_sources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_bases_pinecone_namespace_key" ON "knowledge_bases"("pinecone_namespace");

-- CreateIndex
CREATE INDEX "knowledge_bases_user_id_idx" ON "knowledge_bases"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_bases_user_id_knowledge_base_name_key" ON "knowledge_bases"("user_id", "knowledge_base_name");

-- CreateIndex
CREATE INDEX "knowledge_base_sources_knowledge_base_id_created_at_idx" ON "knowledge_base_sources"("knowledge_base_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_base_sources_knowledge_base_id_title_key" ON "knowledge_base_sources"("knowledge_base_id", "title");

-- AddForeignKey
ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_base_sources" ADD CONSTRAINT "knowledge_base_sources_knowledge_base_id_fkey" FOREIGN KEY ("knowledge_base_id") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written below: Prisma's schema can't express these.

-- CHECK constraints from the Go server. The chunk-size bounds and name length
-- are the documented Create Knowledge Base contract; a chunk floor above the
-- ceiling would merge every chunk into one.
ALTER TABLE "knowledge_bases"
    ADD CONSTRAINT "knowledge_bases_name_check" CHECK (char_length("knowledge_base_name") BETWEEN 1 AND 40),
    ADD CONSTRAINT "knowledge_bases_status_check" CHECK ("status" IN ('in_progress', 'complete', 'error', 'refreshing_in_progress')),
    ADD CONSTRAINT "knowledge_bases_max_chunk_size_check" CHECK ("max_chunk_size" BETWEEN 600 AND 6000),
    ADD CONSTRAINT "knowledge_bases_min_chunk_size_check" CHECK ("min_chunk_size" BETWEEN 200 AND 2000),
    ADD CONSTRAINT "knowledge_bases_chunk_size_order_check" CHECK ("min_chunk_size" <= "max_chunk_size");
ALTER TABLE "knowledge_base_sources"
    ADD CONSTRAINT "knowledge_base_sources_type_check" CHECK ("type" IN ('text', 'file')),
    ADD CONSTRAINT "knowledge_base_sources_title_check" CHECK (char_length("title") BETWEEN 1 AND 200),
    ADD CONSTRAINT "knowledge_base_sources_content_check" CHECK (char_length("content") > 0),
    ADD CONSTRAINT "knowledge_base_sources_chunk_count_check" CHECK ("chunk_count" >= 0);
