-- New knowledge bases all write into one Pinecone namespace, 'kb_shared',
-- because the Pinecone plan caps the index at 100 namespaces and one per
-- knowledge base had reached it (every create with text failed). So many rows
-- now share a pinecone_namespace and the unique index has to go. Existing rows
-- keep their own namespaces.
--
-- Safe while the previous instance still serves (see src/migrate.ts): it only
-- ever writes distinct kb_<uuid> values.
DROP INDEX IF EXISTS "knowledge_bases_pinecone_namespace_key";
