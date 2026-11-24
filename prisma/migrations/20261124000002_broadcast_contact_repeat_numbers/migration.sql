-- The same phone number may be added to a broadcast any number of times; each
-- one is its own contact and gets its own call. Only the unique rule goes: no
-- rows change. A plain index keeps lookups by number fast.
CREATE INDEX IF NOT EXISTS "idx_broadcast_contacts_broadcast_phone" ON "broadcast_contacts"("broadcast_id", "phone_number");
DROP INDEX IF EXISTS "broadcast_contacts_broadcast_phone_key";
