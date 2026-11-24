import { activity } from './activity/activity';

// The most memory (resident set) the server may hold before it restarts itself,
// so that it can never take the whole machine, and Postgres on it, down.
// MEMORY_LIMIT_MB changes it; 0 switches the guard off.
const DEFAULT_LIMIT_MB = 5_000;
const CHECK_MS = 15_000;
// Readings in a row over the limit: a spike that's gone again needs no restart.
const READINGS = 2;
// How long a restart may take to close its sockets.
const SHUTDOWN_MS = 20_000;

// The limit in MB, or undefined for none. Without MEMORY_LIMIT_MB it only guards
// a server pm2 started (it sets pm_id), because pm2 starts it again.
export function memoryLimitMb(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const set = env.MEMORY_LIMIT_MB?.trim();
  if (set) {
    const limit = Number(set);
    if (Number.isFinite(limit)) return limit > 0 ? limit : undefined;
  }
  return env.pm_id === undefined ? undefined : DEFAULT_LIMIT_MB;
}

// Calls restart once memory has been over the limit for READINGS checks.
export function watchMemory(
  limitMb: number,
  restart: () => void = restartServer,
  rssMb: () => number = () => process.memoryUsage.rss() / 1048576,
) {
  let over = 0;
  const timer = setInterval(() => {
    const used = rssMb();
    over = used > limitMb ? over + 1 : 0;
    if (over < READINGS) return;
    clearInterval(timer);
    activity(
      `memory: rss ${Math.round(used)} MB is over the ${limitMb} MB limit, restarting`,
    );
    restart();
  }, CHECK_MS);
  timer.unref();
  return timer;
}

// SIGTERM runs Nest's shutdown hooks, which close the WhatsApp sockets; the
// process ends either way.
function restartServer() {
  setTimeout(() => process.exit(1), SHUTDOWN_MS).unref();
  process.kill(process.pid, 'SIGTERM');
}
