// State file, project paths and the lock that serialises writes. Imports only repo.mjs (the board kept in the repo) and fields.mjs behind it.
import { createHash, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, rename, rm, rmdir, stat, writeFile, unlink } from 'node:fs/promises';
import { closeSync, constants, copyFileSync, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { cardsSignature, commitState, driftOf, ensureGitignore, importDrift, importOnce, mainCheckout, mergeState, newCardId, repoRootOf, resumeCopy, runCopy, storeRoot, worktreesOf } from './repo.mjs';

export { RepoConflictError, cardsFolder, enableRepo, mainCheckout, repoConfigPath, repoFolder, repoRefusal, repoRootOf, resetRepoCache, storeRoot, testHooks as repoTestHooks } from './repo.mjs';

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

// The key of the project's local store: its folder's key, or for a repo-backed project the key of the main checkout's real path (a
// worktree, a sub-folder and a symlinked checkout then share one store, one lock and one board). A project that is not repo-backed keeps
// the key it always had.
//
// A store can be pinned: the runner of a thread works in the store the thread lives in (the thread record names it), and the board shows
// an older per-path store (see legacyStores) as the store it is, whatever the repo now says. A pinned store is read and written as a
// plain local store, with no repo cards joined in.
const storeAls = new AsyncLocalStorage();
let pinnedKey = null;
const pinned = () => storeAls.getStore() ?? pinnedKey;
/** Pins the store for the rest of this process (the runner). */
export function pinStore(key) { pinnedKey = typeof key === 'string' && /^[0-9a-f]{12}$/.test(key) ? key : null; }
/** Runs `fn` with the store `key` pinned, for that call and what it awaits (the board's view of an older store). */
export function runInStore(key, fn) { return storeAls.run(key, fn); }

/** True while a store is pinned (the runner of a thread; the board's view of an older store). */
export const storePinned = () => pinned() != null;

export function storeKey(projectDirArg) {
  return pinned() ?? projectKey(storeRoot(projectDirArg));
}

export function projectPaths(projectDirArg) {
  const dir = join(dataDir(), 'projects', storeKey(projectDirArg));
  return { dir, state: join(dir, 'state.json'), repo: join(dir, 'repo.json'), lock: join(dir, 'state.lock'), logs: join(dir, 'logs') };
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

// The local store's state file as it is, with no repo cards joined in.
export function readLocalState(projectDirArg) {
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

// What a repo-backed project keeps on this machine besides state.json: repo.json, which holds the record of the one-time copy, the old-id
// map and the overlay of local fields on the repo's cards (see repo.mjs). It is a file of its own so that state.json stays what an older
// plugin version wrote. {} when there is none or it cannot be read. A read-only caller gets a parsed copy that is kept for the process
// while the file is unchanged, and must not change it; `fresh` parses it anew (a write works on that).
const markCache = new Map();   // path -> { sig, mark }
export function readRepoMark(projectDirArg, { fresh = false } = {}) {
  const p = projectPaths(projectDirArg).repo;
  try {
    const st = statSync(p);
    const sig = `${st.mtimeMs}:${st.size}:${st.ino}`;
    const hit = markCache.get(p);
    if (!fresh && hit && hit.sig === sig) return hit.mark;
    const m = JSON.parse(readFileSync(p, 'utf8'));
    const mark = m && typeof m === 'object' && !Array.isArray(m) ? m : {};
    if (!fresh) markCache.set(p, { sig, mark });
    return mark;
  } catch {
    return {};
  }
}

// The state a project's cards are read from. A repo-backed project: the cards in `.claude/thread/cards/` joined with this machine's overlay
// and its thread cards (see repo.mjs); anything else (and a pinned store): the state file.
export function readState(projectDirArg) {
  const root = pinned() ? null : repoRootOf(projectDirArg);
  if (!root) return readLocalState(projectDirArg);
  const local = readLocalState(root);
  local.repo = readRepoMark(root);
  return mergeState(root, local, { mainKey: projectKey(root) });
}

// ---------------------------------------------------------------- the older stores of a repo-backed project

const scanCache = new Map();   // state file -> { sig, projectDir }
const realOf = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const isUnder = (p, dir) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/**
 * The older per-path stores that belong to a repo-backed project: stores of this machine's data directory (other than the project's own)
 * whose project folder is inside the main checkout or is one of its worktrees. An older plugin version, or this one before the project
 * became repo-backed, kept one store per folder, so a worktree or a sub-folder has a store of its own with cards and threads in it. Returns
 * [{ key, projectDir, file, state }], read now. Never changes a store.
 */
export function legacyStores(projectDirArg) {
  const root = repoRootOf(projectDirArg);
  if (!root) return [];
  const own = projectKey(root);
  const trees = worktreesOf(root);
  const projects = join(dataDir(), 'projects');
  let names;
  try { names = readdirSync(projects); } catch { return []; }
  const out = [];
  for (const key of names) {
    if (key === own || !/^[0-9a-f]{12}$/.test(key)) continue;
    const file = join(projects, key, 'state.json');
    let dirOfStore;
    try {
      const st = statSync(file);
      const sig = `${st.mtimeMs}:${st.size}:${st.ino}`;
      const hit = scanCache.get(file);
      if (hit && hit.sig === sig) dirOfStore = hit.projectDir;
      else {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        dirOfStore = parsed && typeof parsed.projectDir === 'string' ? parsed.projectDir : '';
        scanCache.set(file, { sig, projectDir: dirOfStore });
      }
    } catch { continue; }
    if (!dirOfStore || projectKey(dirOfStore) !== key) continue;
    const at = realOf(resolve(dirOfStore));
    if (!(isUnder(at, root) || trees.some((t) => isUnder(at, t)))) continue;
    if (at !== root && !trees.includes(at) && existsSync(at) && mainCheckout(at) !== root) continue;   // a repo of its own inside this one
    try {
      const state = JSON.parse(readFileSync(file, 'utf8'));
      if (state && Array.isArray(state.cards)) out.push({ key, projectDir: dirOfStore, file, state });
    } catch { /* not readable now */ }
  }
  return out;
}

/**
 * The older per-path store of this very folder (not the repo's own store), when the project is repo-backed and the folder had a store of its
 * own before: a session working in a worktree or sub-folder that has one still names its cards by the ids that store gave. { key, state } or null.
 */
export function legacyStoreOf(projectDirArg) {
  const at = realOf(resolve(String(projectDirArg)));
  const hit = legacyStores(projectDirArg).find((s) => realOf(resolve(s.projectDir)) === at);
  return hit ? { key: hit.key, state: hit.state } : null;
}

/** The stores a copy takes cards from: the project's own local store, then its older per-path ones. */
function copySources(root, localCards) {
  const own = projectKey(root);
  return [
    { key: own, label: null, cards: localCards },
    // the project's own folder spelled another way (a symlink) is its own old store, not another folder's
    ...legacyStores(root).map((s) => ({ key: s.key, label: realOf(resolve(s.projectDir)) === root ? null : s.projectDir, cards: s.state.cards })),
  ];
}

// Carries the run files of a copied card over to its new id: every file the old store's logs folder holds for one of its runs (the activity
// snapshot, the full prompt and report, anything else named <id>.r<n>.<part>) is named by card id. Copies only (never over a file there, never a
// link); the store they come from keeps its own.
function snapshotCopier(logsTo) {
  const projects = join(dataDir(), 'projects');
  return (item, old) => {
    const from = join(projects, item.src, 'logs');
    let names;
    try { names = readdirSync(from); } catch { return; }
    const prefix = `${old.id}.`;
    for (const name of names) {
      const m = name.startsWith(prefix) ? /^(r[0-9]+\..+)$/.exec(name.slice(prefix.length)) : null;
      if (!m) continue;
      try {
        if (!lstatSync(join(from, name)).isFile()) continue;
        mkdirPrivateSync(logsTo);
        copyFileSync(join(from, name), join(logsTo, `${item.id}.${m[1]}`), constants.COPYFILE_EXCL);
      } catch { /* it is there already, or cannot be read */ }
    }
  };
}

/** What an older plugin version did to the older stores' cards since the copy: see repo.driftOf. */
export function repoDrift(projectDirArg, state) {
  const root = state.base && state.base.root;
  if (!root || !state.repo) return [];
  return driftOf(state.repo, copySources(root, state.base.localCards));
}

/** `board_import` on the joined state of an update (see repo.importDrift): the project's old cards and its older stores' cards. */
export async function repoImport(projectDirArg, state, { dismiss = false } = {}) {
  const root = state.base.root;
  const sources = copySources(root, state.base.localCards);
  return importDrift(root, state, sources, { dismiss, save: state.saveRepoMark, copySnapshots: snapshotCopier(projectPaths(projectDirArg).logs) });
}

/** A new card id for `state`: random in a repo-backed project (two devices never clash), else c<seq>. A thread card takes the next c<seq> that is free. */
export function nextCardId(state, { thread = false } = {}) {
  if (state.repoBacked && !thread) {
    const id = newCardId(state.takenIds);
    state.takenIds.add(id);
    return id;
  }
  do state.seq += 1; while (state.repoBacked && state.takenIds.has(`c${state.seq}`));
  if (state.repoBacked) state.takenIds.add(`c${state.seq}`);
  return `c${state.seq}`;
}

/** A fingerprint of the files a project's cards are read from besides the state file (empty for a project that is not repo-backed). */
export function repoSignature(projectDirArg) {
  const root = repoRootOf(projectDirArg);
  return root ? cardsSignature(root) : '';
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

// The write of a repo-backed project: the first write also makes the one-time copy of the local cards into the repo; `fn` works on the
// joined state; the shared part of each card goes to its file in the repo, the rest to the local state file and the overlay.
// The copy's plan (new ids for the old cards) is saved before a card is written, so that a copy that is interrupted (a crash, a kill) is
// finished by the next call; a card of it is done when its file exists.
async function updateRepoState(root, paths, fn) {
  const existed = existsSync(paths.state);
  const local = readLocalState(root);
  if (!local.projectDir) local.projectDir = root;
  const before = JSON.stringify(local);
  local.repo = readRepoMark(root, { fresh: true });
  let markSaved = JSON.stringify(local.repo);
  const saveMark = async () => {
    const text = JSON.stringify(local.repo || {});
    if (text !== markSaved) { await writeStateFile(paths.repo, text); markSaved = text; }
  };
  ensureGitignore(root);
  const copy = { copySnapshots: snapshotCopier(paths.logs) };
  if (local.repo.copy) {
    resumeCopy(root, local.repo, copySources(root, local.cards), copy);
    await saveMark();
  }
  const mark = importOnce(root, local, paths.state, local.repo && typeof local.repo.importedAt === 'string' ? [] : copySources(root, local.cards));
  if (mark) {
    await saveMark();   // the plan, before any card is written
    if (mark.copy) runCopy(root, mark, copySources(root, local.cards), copy);
    // The copy has written the card files: its record is saved at once, so a call that is refused below (a card that is not found, say) does not lose it.
    await saveMark();
  }
  const state = mergeState(root, local, { forWrite: true, mainKey: projectKey(root) });
  hiddenProp(state, 'saveRepoMark', saveMark);
  const result = await fn(state);
  const { repo, ...rest } = commitState(state);
  const after = JSON.stringify(rest);
  if (!existed || before !== after) await writeStateFile(paths.state, after);
  if (repo) local.repo = repo;
  await saveMark();
  return result;
}

const hiddenProp = (obj, k, v) => Object.defineProperty(obj, k, { value: v, enumerable: false, writable: true, configurable: true });

async function writeStateFile(file, text) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, text, { encoding: 'utf8', mode: PRIVATE_FILE });
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

export async function updateState(projectDirArg, fn) {
  const root = pinned() ? null : repoRootOf(projectDirArg);
  if (root) return withLock(projectDirArg, (paths) => updateRepoState(root, paths, fn));
  return updateLocalState(projectDirArg, fn);
}

/**
 * The same under the same lock, but on the local state file alone: no repo cards are joined in, so `state.cards` are the local cards (the
 * threads of a repo-backed project, and a project's older cards). For a change that touches only what is local: sessions, threads. It is
 * much cheaper than updateState when there are many repo cards, and for a project that is not repo-backed it is updateState.
 */
export async function updateLocalState(projectDirArg, fn) {
  return withLock(projectDirArg, async (paths) => {
    const existed = existsSync(paths.state);
    const state = readLocalState(projectDirArg);
    if (!state.projectDir) state.projectDir = projectDirArg;
    const before = JSON.stringify(state);
    const result = await fn(state);
    const after = JSON.stringify(state);
    if (!existed || before !== after) await writeStateFile(paths.state, after);
    return result;
  });
}

export const now = () => new Date().toISOString();
