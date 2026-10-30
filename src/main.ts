import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { applyMigrations } from './migrate';

// libsignal (under Baileys) prints whole sessions straight to the console,
// private keys included, and no logger setting reaches it. Nest and the
// activity lines write to stdout directly, so they aren't affected.
const silent = () => undefined;
console.info = silent;
console.warn = silent;
console.debug = silent;
if (process.env.VERBOSE_LOGS !== 'true') {
  console.log = silent;
  console.error = silent;
}

async function bootstrap() {
  applyMigrations();

  // rawBody: the Clerk webhook verifies its signature over the exact bytes
  // Clerk sent (req.rawBody), not the parsed JSON.
  // Only src/activity lines are printed unless VERBOSE_LOGS=true.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: process.env.VERBOSE_LOGS === 'true' ? undefined : false,
  });
  // Knowledge base texts are sent as JSON and can be long; Express's default
  // 100 KB limit would refuse them.
  app.useBodyParser('json', { limit: '10mb' });
  app.enableShutdownHooks();
  // The dashboard (frontend, another origin) calls this API from the browser.
  // It reads X-Account-Blocked to show its blocked-account screen.
  // CORS_ALLOWED_ORIGINS is a comma-separated list; unset allows any origin.
  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
    exposedHeaders: ['X-Account-Blocked'],
  });

  const port = process.env.PORT ?? 3000;

  // The API contract is the Go server's (chat side only), copied into
  // docs/openapi.json by scripts/sync-openapi.mjs — not generated from these
  // controllers. UI at /docs, raw spec at /docs-json.
  const document = JSON.parse(
    readFileSync(join(__dirname, '..', 'docs', 'openapi.json'), 'utf8'),
  ) as OpenAPIObject;
  // Relative, so "Try it out" calls whichever host serves /docs.
  document.servers = [{ url: '/' }];
  SwaggerModule.setup('docs', app, document);

  await app.listen(port);
}
void bootstrap();
