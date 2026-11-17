import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// The CLI (migrate, db pull, studio) and the running app use the same
// connection string: DATABASE_URL.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
