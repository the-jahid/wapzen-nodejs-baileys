-- Values for the fields an owner adds to Take Order. Additive, like every
-- migration here (see src/migrate.ts). Which fields an account collects lives
-- in tools.config, which needs no change.

-- AlterTable
ALTER TABLE "orders" ADD COLUMN "custom_fields" JSONB NOT NULL DEFAULT '[]'::jsonb;
