import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// Render never ran the preDeployCommand from render.yaml, so new code went live
// without its migration and every signed-in request failed. The server applies
// pending migrations itself, before it starts serving: if one fails the boot
// fails, and Render keeps the old instance. Only on Render, because local dev
// shares this database and an unfinished migration must not reach it.
export function applyMigrations() {
  if (!process.env.RENDER) return;
  const root = join(__dirname, '..');
  execFileSync(
    process.execPath,
    [join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] },
  );
}
