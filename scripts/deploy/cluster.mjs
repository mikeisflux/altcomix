// AltComix process launcher, run by PM2 (see ecosystem.config.cjs).
//
// Starts N copies of `node api/src/server.ts` sharing one port through
// node:cluster. Exactly one of them runs the background jobs (email queue,
// settlement, cleanup, scheduled publishing ...); the others get NO_JOBS=1.
//
// Why not PM2's own cluster mode: PM2 loads the script inside its own
// container module, so `import.meta.main` in server.ts is false and the
// server never starts listening.
//
// Signals:
//   SIGHUP           rolling reload: workers are replaced one at a time, so
//                    new code goes live without dropping requests
//   SIGINT / SIGTERM stop everything (PM2 stop / restart)
import cluster from 'node:cluster';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const apiDir = fileURLToPath(new URL('../../api/', import.meta.url));
const entry = fileURLToPath(new URL('../../api/src/server.ts', import.meta.url));
const count = Math.max(1, Number(process.env.WEB_CONCURRENCY) || Math.min(os.availableParallelism(), 4));
const READY_TIMEOUT_MS = 90_000; // includes migrations on first boot
const STOP_TIMEOUT_MS = 20_000;

const log = (msg) => console.log(`${new Date().toISOString()} [launcher] ${msg}`);

cluster.setupPrimary({ exec: entry, cwd: apiDir });

/** worker.id -> { role: 'jobs' | 'web', startedAt, retiring } */
const meta = new Map();
let stopping = false;
let reloading = false;
let quickDeaths = 0;

function start(role) {
  // An empty NO_JOBS is falsy in server.ts, and overrides anything inherited.
  const worker = cluster.fork({ NO_JOBS: role === 'jobs' ? '' : '1', ALTCOMIX_ROLE: role });
  meta.set(worker.id, { role, startedAt: Date.now(), retiring: false });
  log(`started ${role} worker ${worker.process.pid}`);
  return worker;
}

function ready(worker) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('did not start listening in time')), READY_TIMEOUT_MS);
    worker.once('listening', () => {
      clearTimeout(timer);
      resolve(worker);
    });
    worker.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`exited with code ${code} before listening`));
    });
  });
}

function stop(worker) {
  return new Promise((resolve) => {
    const m = meta.get(worker.id);
    if (m) m.retiring = true;
    if (worker.isDead()) return resolve();
    const timer = setTimeout(() => worker.process.kill('SIGKILL'), STOP_TIMEOUT_MS);
    worker.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    worker.process.kill('SIGTERM'); // server.ts closes connections and exits
  });
}

cluster.on('exit', (worker, code, signal) => {
  const m = meta.get(worker.id);
  meta.delete(worker.id);
  if (stopping || !m || m.retiring) return;
  // A worker died on its own: replace it, slowing down if it keeps dying at boot
  // so a broken build cannot spin the machine.
  quickDeaths = Date.now() - m.startedAt < 15_000 ? quickDeaths + 1 : 0;
  const delay = Math.min(30_000, 1000 * 2 ** Math.min(quickDeaths, 5));
  log(`${m.role} worker ${worker.process.pid} exited (${signal ?? code}); restarting in ${delay / 1000}s`);
  setTimeout(() => {
    if (!stopping) start(m.role);
  }, delay);
});

async function reload() {
  if (reloading || stopping) return;
  reloading = true;
  log('rolling reload started');
  let pending = null;
  try {
    const current = Object.values(cluster.workers).filter((w) => w && !meta.get(w.id)?.retiring);
    const web = current.filter((w) => meta.get(w.id)?.role === 'web');
    const jobs = current.filter((w) => meta.get(w.id)?.role === 'jobs');
    // Web workers first: start the replacement, wait until it serves, then retire the old one.
    for (const old of web) {
      const next = (pending = start('web'));
      meta.get(next.id).retiring = true; // not auto-restarted if the new code cannot boot
      await ready(next);
      meta.get(next.id).retiring = false;
      pending = null;
      await stop(old);
    }
    // The jobs worker is stopped before its replacement starts, so two never run at once.
    for (const old of jobs) {
      await stop(old);
      await ready(start('jobs'));
    }
    log('rolling reload finished');
  } catch (e) {
    // The new code could not boot. The workers still running keep serving the old code.
    log(`rolling reload ABORTED: ${e.message}`);
    if (pending && !pending.isDead()) pending.process.kill('SIGKILL');
  } finally {
    reloading = false;
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`${signal}: stopping ${Object.keys(cluster.workers).length} workers`);
  await Promise.all(Object.values(cluster.workers).map((w) => stop(w)));
  process.exit(0);
}

process.on('SIGHUP', reload);
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

log(`starting ${count} workers of ${entry}`);
start('jobs');
for (let i = 1; i < count; i++) start('web');
