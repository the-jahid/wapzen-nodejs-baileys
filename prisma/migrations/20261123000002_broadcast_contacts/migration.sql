-- Broadcast contacts (2026-11-23): the people a broadcast calls. Phone number
-- is required (E.164, "+" and 8-15 digits, normalised by the Go server) and
-- unique within a broadcast; every other field is optional. Deleting the
-- broadcast deletes its contacts.
CREATE TABLE IF NOT EXISTS "broadcast_contacts" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "broadcast_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "email" TEXT,
    "address" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "broadcast_contacts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "broadcast_contacts_broadcast_id_fkey" FOREIGN KEY ("broadcast_id") REFERENCES "broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "broadcast_contacts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "broadcast_contacts_phone_check" CHECK ("phone_number" ~ '^\+[0-9]{8,15}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS "broadcast_contacts_broadcast_phone_key" ON "broadcast_contacts"("broadcast_id", "phone_number");
CREATE INDEX IF NOT EXISTS "idx_broadcast_contacts_broadcast" ON "broadcast_contacts"("broadcast_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_broadcast_contacts_user_id" ON "broadcast_contacts"("user_id");
