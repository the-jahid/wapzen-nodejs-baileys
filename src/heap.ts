import { spawn } from 'node:child_process';
import { getHeapStatistics } from 'node:v8';

// The heap the server needs on Render's 2 GB plan, the same flags as
// render.yaml's startCommand and start:prod. Prod crashed on 2026-11-16 with
// "JavaScript heap out of memory" at ~1,047 MB, so Render was not starting it
// with those flags (its dashboard start command wins over render.yaml), and the
// heap was V8's default instead.
const HEAP_MB = 1536;
const SEMI_SPACE_MB = 32;
const RELAUNCHED = 'WHISKEY_HEAP_RELAUNCHED';

export function heapLimitMb() {
  return Math.round(getHeapStatistics().heap_size_limit / 1048576);
}

// On Render, a server started without the heap flags starts itself again as a
// child process with them, and this process only passes signals and the exit
// code through. Returns true when it did, so the caller starts nothing itself.
// V8 can't raise the limit of a heap already running, so a child it has to be.
export function relaunchedWithBiggerHeap(): boolean {
  if (!process.env.RENDER || process.env[RELAUNCHED]) return false;
  const limit = heapLimitMb();
  if (limit >= HEAP_MB) return false;

  process.stdout.write(
    `heap limit was ${limit} MB, restarting the server with ${HEAP_MB} MB\n`,
  );
  const child = spawn(
    process.execPath,
    [
      ...process.execArgv,
      `--max-old-space-size=${HEAP_MB}`,
      `--max-semi-space-size=${SEMI_SPACE_MB}`,
      ...process.argv.slice(1),
    ],
    { stdio: 'inherit', env: { ...process.env, [RELAUNCHED]: '1' } },
  );
  // Render stops a deploy's old instance with SIGTERM: the server has to get
  // it to close its sockets (enableShutdownHooks).
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  child.on('error', (err) => {
    process.stdout.write(`starting the server failed: ${err.message}\n`);
    process.exit(1);
  });
  return true;
}
