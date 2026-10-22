// How a user learns that thread has a new version. Two files in the data directory, both per machine and owner-only:
//   seen-version.json  the plugin version this machine last announced (and the "is out" version it last announced), so the note
//                      "thread was updated to X" is said once, by the first session after an update; a first install records silently.
//   update-check.json  the opt-in check (setting `updateCheck`): when GitHub was last asked and the latest release it named.
// Older plugin versions never read either file, and none of them wrote seen-version.json: a machine with no record but with the data an
// earlier run leaves behind (see ranBefore) was updated from a version it cannot name. A version lower than the recorded one is never
// announced and never recorded; the record is read, compared and written under a lock, so sessions starting together announce once.
// The one network call thread makes besides the optional tunnel is here: a plain GET of the latest release, at most once a day, only
// when `updateCheck` is on. Imports only state.mjs.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRIVATE_FILE, dataDir, envValue, mkdirPrivateSync } from './state.mjs';

export const REPO = 'ahmed0thman/thread';
// Built from pieces, never a template with a placeholder next to an address (the plugin directory's validator flags that).
export const RELEASES_URL = 'https://github.com/' + REPO + '/releases';
const LATEST_URL = 'https://' + 'api.github.com' + '/repos/' + REPO + '/releases/latest';
export const UPDATE_COMMANDS = ['claude plugin marketplace update thread-marketplace', 'claude plugin update thread@thread-marketplace'];
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 5000;
const MAX_RESPONSE = 1024 * 1024;
const MAX_NOTES = 20000;
const CHANGELOG = new URL('../CHANGELOG.md', import.meta.url);

// ---------------------------------------------------------------- versions

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
/** The version when it is exactly x.y.z, else null. */
export const cleanVersion = (v) => (typeof v === 'string' && VERSION_RE.test(v) ? v : null);
const parts = (v) => { const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v)); return m ? m.slice(1).map(Number) : null; };

/** True when plugin version `a` is lower than `b`; false when either is not x.y.z. */
export function olderVersion(a, b) {
  const x = parts(a), y = parts(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

// ---------------------------------------------------------------- the two files

const seenPath = () => join(dataDir(), 'seen-version.json');
const checkPath = () => join(dataDir(), 'update-check.json');

function readJson(path) {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// True when the file was written. A file that cannot be written leaves the record as it was.
function writeJson(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirPrivateSync(dataDir());
    writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: PRIVATE_FILE });
    renameSync(tmp, path);
    return true;
  } catch {
    try { unlinkSync(tmp); } catch { /* nothing to remove */ }
    return false;
  }
}

/** { version, previous, latestAnnounced, fromUnknown }: each version an x.y.z string or null; fromUnknown true when it was an update from a version with no record. */
export function readSeen() {
  const o = readJson(seenPath());
  return { version: cleanVersion(o.version), previous: cleanVersion(o.previous), latestAnnounced: cleanVersion(o.latestAnnounced), fromUnknown: o.fromUnknown === true };
}

// What an earlier run of the plugin leaves in the data directory: a config file, the setup hint's marker, or a project's state or repo
// record. board.token is not counted: a first session's MCP server may make it before the hook asks (the hook asks before it registers
// the session, which makes the project's state file).
function ranBefore() {
  try {
    if (existsSync(join(dataDir(), 'config.json')) || existsSync(join(dataDir(), 'setup-hint'))) return true;
    const projects = join(dataDir(), 'projects');
    return readdirSync(projects).some((k) => existsSync(join(projects, k, 'state.json')) || existsSync(join(projects, k, 'repo.json')));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the lock

// A lock file made with flag 'wx' next to the record. It is held for a read and one small write, so a lock older than LOCK_STALE_MS was
// left by a process that died inside it: it is moved aside (the move is atomic, one waiter wins it) and removed. Waits synchronously
// (announce is called by a hook that does not wait on anything else); nothing is recorded or announced when the lock is not had.
const LOCK_STALE_MS = 10000;
const LOCK_WAIT_MS = 3000;
const pause = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait: the loop spins */ } };

function withSeenLock(fn) {
  const lock = seenPath() + '.lock';
  const deadline = Date.now() + LOCK_WAIT_MS;
  try { mkdirPrivateSync(dataDir()); } catch { return null; }
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx', PRIVATE_FILE));
      break;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return null;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          const aside = `${lock}.${process.pid}.stale`;
          renameSync(lock, aside);
          unlinkSync(aside);
          continue;
        }
      } catch { /* gone already, or taken by another waiter: try again */ }
      if (Date.now() >= deadline) return null;
      pause(5 + Math.floor(Math.random() * 10));
    }
  }
  try {
    return fn();
  } finally {
    try { unlinkSync(lock); } catch { /* none */ }
  }
}

/** { at, latest }: when GitHub was last asked (ms since 1970, or 0) and the latest release it named (or null). */
export function readCheck() {
  const o = readJson(checkPath());
  return { at: Number.isFinite(o.at) && o.at > 0 ? o.at : 0, latest: cleanVersion(o.latest) };
}

// ---------------------------------------------------------------- announcing (SessionStart)

/**
 * Decides what the session note says about versions, and records it so only the first session says it.
 * `version` is the running plugin version; `latest` the newest release this machine knows of (the cache of the opt-in check) or null.
 * Returns { updated, updatedFrom, out }: whether the plugin was just updated, the version this machine had before (or null when it
 * cannot be named: no released version before 0.24 kept a record), and the newer release to announce (or null). A machine with no
 * record and no data of an earlier run is a first install: recorded, not announced. Nothing is announced that cannot be recorded, and a
 * lower version than the recorded one is neither announced nor recorded.
 */
export function announce(version, latest = null) {
  const none = { updated: false, updatedFrom: null, out: null };
  if (!cleanVersion(version)) return none;
  return withSeenLock(() => {
    const res = { ...none };
    const seen = readSeen();   // read again inside the lock: another session may have just recorded
    const next = { version: seen.version, previous: seen.previous, latestAnnounced: seen.latestAnnounced };
    if (seen.fromUnknown) next.fromUnknown = true;
    let changed = false;
    if (!seen.version) {
      next.version = version;
      if (ranBefore()) { res.updated = true; next.fromUnknown = true; }   // else a first install
      changed = true;
    } else if (olderVersion(seen.version, version)) {
      next.version = version;
      next.previous = seen.version;
      delete next.fromUnknown;
      res.updated = true;
      res.updatedFrom = seen.version;
      changed = true;
    }
    const known = cleanVersion(latest);
    if (known && olderVersion(version, known) && !(seen.latestAnnounced && !olderVersion(seen.latestAnnounced, known))) {
      next.latestAnnounced = known;
      res.out = known;
      changed = true;
    }
    if (changed && !writeJson(seenPath(), next)) return none;
    return res;
  }) || none;
}

// ---------------------------------------------------------------- the board

// A changelog entry links files of the repository by relative path (docs/board.md#…), which lead nowhere from the board's page: point
// them at that file in the release's tag on GitHub. Web addresses and in-page anchors are kept as they are.
function absoluteLinks(text, version) {
  const base = 'https://github.com/' + REPO + '/blob/v' + version + '/';
  return text.replace(/\]\(([^)\s]+)\)/g, (m, target) => (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') ? m : '](' + base + target.replace(/^\.?\//, '') + ')'));
}

/** The entry for `version` in the plugin's own CHANGELOG.md (the text after its bold version), or null. */
export function changelogEntry(version, file = CHANGELOG) {
  const v = cleanVersion(version);
  if (!v) return null;
  try {
    const lead = `- **${v}**`;
    const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith(lead));
    const text = line ? line.slice(lead.length).trim() : '';
    return text ? absoluteLinks(text, v).slice(0, MAX_NOTES) : null;
  } catch {
    return null;
  }
}

/**
 * What the board's update banners need (GET /api/update): the running version, whether this machine was just updated to it (`updated`),
 * the version it came from (else null; also null when it cannot be named), the newer release the opt-in check found (else null) and
 * the changelog entry of the running version.
 */
export function updateView(version, checkOn) {
  const seen = readSeen();
  let from = null;
  if (seen.version && !olderVersion(version, seen.version)) from = olderVersion(seen.version, version) ? seen.version : seen.previous;
  if (from && !olderVersion(from, version)) from = null;
  const updated = !!from || (seen.fromUnknown && seen.version === version);
  const known = checkOn ? readCheck().latest : null;
  return {
    version,
    from,
    updated,
    latest: known && olderVersion(version, known) ? known : null,
    notes: updated ? changelogEntry(version) : null,
    releases: RELEASES_URL,
  };
}

// ---------------------------------------------------------------- the opt-in check (MCP server)

/** False in a side thread, and under THREAD_NO_HTTP=1 unless a test points the check at its own server (THREAD_UPDATE_URL). */
export function checkAllowed() {
  if (process.env.THREAD_DEPTH) return false;
  return process.env.THREAD_NO_HTTP !== '1' || !!envValue('THREAD_UPDATE_URL');
}

/**
 * Asks GitHub for the latest release, at most once in 24 hours on this machine. A plain GET: no data about the user or the project,
 * only the User-Agent GitHub requires. One try with a 5 second limit, never a retry. Resolves to the version found, or null; it
 * never rejects (a failure is returned as `error`, for the caller's stderr). The attempt is recorded before the request, so a
 * session that starts meanwhile does not ask again.
 */
export async function runUpdateCheck(version, now = Date.now()) {
  try {
    const cache = readCheck();
    if (cache.at && cache.at <= now && now - cache.at < CHECK_EVERY_MS) return { latest: cache.latest, asked: false };
    writeJson(checkPath(), { at: now, latest: cache.latest });
    const res = await fetch(envValue('THREAD_UPDATE_URL') || LATEST_URL, {
      headers: { 'User-Agent': 'thread-plugin/' + String(version), Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_RESPONSE) throw new Error('the answer is too large');
    const tag = JSON.parse(text).tag_name;
    const latest = cleanVersion(typeof tag === 'string' ? tag.replace(/^v/, '') : '');
    if (!latest) throw new Error('no release version in the answer');
    writeJson(checkPath(), { at: now, latest });
    return { latest, asked: true };
  } catch (e) {
    return { latest: null, asked: true, error: e instanceof Error ? e.message : 'failed' };
  }
}
