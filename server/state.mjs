// State file, project paths and the lock that serialises writes. Imports nothing local.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rename, rm, rmdir, stat, writeFile, unlink } from 'node:fs/promises';
import { closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const LOCK_RETRY_MS = 25;
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 10000;

// ---------------------------------------------------------------- paths

export function envValue(name) {
  const v = process.env[name];
  if (typeof v !== 'string') return '';
  const t = v.trim();
  if (!t || t.startsWith('${')) return '';
  return t;
}

export function dataDir() {
  return envValue('THREAD_DATA_DIR') || envValue('CLAUDE_PLUGIN_DATA') || join(homedir(), '.claude', 'thread-data');
}

export function projectDir() {
  return resolve(envValue('THREAD_PROJECT_DIR') || envValue('CLAUDE_PROJECT_DIR') || process.cwd());
}

export function projectKey(projectDirArg) {
  return createHash('sha1').update(resolve(String(projectDirArg))).digest('hex').slice(0, 12);
}

export function projectPaths(projectDirArg) {
  const dir = join(dataDir(), 'projects', projectKey(projectDirArg));
  return { dir, state: join(dir, 'state.json'), lock: join(dir, 'state.lock'), logs: join(dir, 'logs') };
}

// ---------------------------------------------------------------- private files

// Everything the plugin keeps (the state, logs, briefs, run reports) is for its owner only: folders 0700, files 0600. A folder the
// plugin creates and a file it writes get these modes at once; tightenDataDir() fixes what an older version made with the default
// modes, once per process. A mode is a POSIX idea, so on Windows none of this does anything.
export const PRIVATE_DIR = 0o700;
export const PRIVATE_FILE = 0o600;
const POSIX = process.platform !== 'win32';

export function mkdirPrivateSync(dir) { mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR }); }
export async function mkdirPrivate(dir) { await mkdir(dir, { recursive: true, mode: PRIVATE_DIR }); }

// Clears the group and other bits of one folder or file the current user owns. It opens the path without following a symlink
// (a link, or a path that changed to a link meanwhile, is skipped) and changes the open handle, never the path.
function tightenOne(path, isDir) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (isDir ? constants.O_DIRECTORY : 0));
    const st = fstatSync(fd);
    if (st.uid !== process.getuid() || (isDir ? !st.isDirectory() : !st.isFile())) return false;
    if (!isDir && st.nlink > 1) return false;   // a hard link: the same file lives somewhere else too

    const want = isDir ? PRIVATE_DIR : ((st.mode & 0o700) | PRIVATE_FILE);
    if ((st.mode & 0o777) !== want) fchmodSync(fd, want);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

function tightenTree(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { if (tightenOne(full, true)) tightenTree(full); } else if (e.isFile()) tightenOne(full, false);
  }
}

const tightened = new Set();
// The plugin's own entries at the top of the data directory. THREAD_DATA_DIR may name a folder that holds other things too,
// so only these and the projects tree are touched, and the folder itself only when it is the plugin's own default.
const OWN_TOP_FILES = ['config.json', 'board.token', 'board.stopped', 'setup-hint'];
// Makes the plugin's data owner-only. Only what the current user owns, is not a symlink and is not hard-linked is touched,
// and nothing outside the data directory. Never throws; a filesystem that ignores modes just keeps what it has.
export function tightenDataDir() {
  if (!POSIX) return;
  const root = dataDir();
  if (tightened.has(root)) return;
  tightened.add(root);
  try {
    if (!lstatSync(root).isDirectory()) return;   // missing, or a symlink: left alone
    if (!envValue('THREAD_DATA_DIR')) tightenOne(root, true);
    for (const name of OWN_TOP_FILES) tightenOne(join(root, name), false);
    const projects = join(root, 'projects');
    if (tightenOne(projects, true)) tightenTree(projects);
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------- state io

function emptyState(projectDirArg) {
  return { version: 1, projectDir: projectDirArg, seq: 0, cards: [] };
}

export function readState(projectDirArg) {
  const p = projectPaths(projectDirArg).state;
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return emptyState(projectDirArg);
    throw new Error(`cannot read state file ${p}: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`state file is corrupt (not valid JSON): ${p}: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.cards)) {
    throw new Error(`state file is corrupt (unexpected shape): ${p}`);
  }
  if (typeof parsed.seq !== 'number') parsed.seq = 0;
  return parsed;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lockWaitMs() {
  const n = Number(process.env.THREAD_LOCK_WAIT_MS);
  return Number.isFinite(n) && n > 0 ? n : LOCK_WAIT_MS;
}

// Remove a lock abandoned by a dead process. The removal runs under a second
// mkdir guard with a re-stat, so two waiters cannot both steal: without it the
// slower one would delete the lock the faster one had just taken.
async function stealIfStale(lockPath) {
  let st;
  try { st = await stat(lockPath); } catch { return; }
  if (Date.now() - st.mtimeMs <= LOCK_STALE_MS) return;
  const guard = `${lockPath}.steal`;
  try {
    await mkdir(guard, { mode: PRIVATE_DIR });
  } catch {
    try {
      const g = await stat(guard);
      if (Date.now() - g.mtimeMs > LOCK_STALE_MS) await rmdir(guard);
    } catch { /* guard already gone */ }
    return;
  }
  try {
    const again = await stat(lockPath);
    if (Date.now() - again.mtimeMs > LOCK_STALE_MS) await rm(lockPath, { recursive: true, force: true });
  } catch { /* lock already gone */ } finally {
    await rmdir(guard).catch(() => {});
  }
}

// The lock is a directory holding one owner file. Returns the owner file path.
async function acquireLock(lockPath) {
  const deadline = Date.now() + lockWaitMs();
  const owner = join(lockPath, `owner-${process.pid}-${randomBytes(6).toString('hex')}`);
  for (;;) {
    try {
      await mkdir(lockPath, { mode: PRIVATE_DIR });
      await writeFile(owner, '', { mode: PRIVATE_FILE });
      return owner;
    } catch (e) {
      // ENOENT: the directory vanished between mkdir and writeFile; retry.
      if (!e || (e.code !== 'EEXIST' && e.code !== 'ENOENT')) throw e;
    }
    await stealIfStale(lockPath);
    if (Date.now() >= deadline) {
      throw new Error(`could not acquire state lock within ${lockWaitMs() / 1000}s: ${lockPath}`);
    }
    await sleep(LOCK_RETRY_MS + Math.floor(Math.random() * 15));
  }
}

// Removes only our own owner file; rmdir then fails harmlessly if the lock was
// stolen and retaken by someone else in the meantime.
async function releaseLock(lockPath, owner) {
  await unlink(owner).catch(() => {});
  await rmdir(lockPath).catch(() => {});
}

export async function withLock(projectDirArg, fn) {
  const paths = projectPaths(projectDirArg);
  await mkdirPrivate(paths.dir);
  const owner = await acquireLock(paths.lock);
  try {
    return await fn(paths);
  } finally {
    await releaseLock(paths.lock, owner);
  }
}

// Read the state while holding the lock (no write). Used by the runner so it
// never sees a half-launched card.
export async function readStateLocked(projectDirArg) {
  return withLock(projectDirArg, () => readState(projectDirArg));
}

export async function updateState(projectDirArg, fn) {
  return withLock(projectDirArg, async (paths) => {
    const existed = existsSync(paths.state);
    const state = readState(projectDirArg);
    if (!state.projectDir) state.projectDir = projectDirArg;
    const before = JSON.stringify(state);
    const result = await fn(state);
    const after = JSON.stringify(state);
    if (!existed || before !== after) {
      const tmp = `${paths.state}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        await writeFile(tmp, after, { encoding: 'utf8', mode: PRIVATE_FILE });
        await rename(tmp, paths.state);
      } catch (e) {
        await unlink(tmp).catch(() => {});
        throw e;
      }
    }
    return result;
  });
}

export const now = () => new Date().toISOString();
