import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// The CLI (migrate, db pull, studio) needs a session connection, so it uses
// DIRECT_URL. The running app uses the transaction pooler (DATABASE_URL).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DIRECT_URL'),
  },
});
