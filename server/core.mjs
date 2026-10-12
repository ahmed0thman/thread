// thread plugin: state + thread lifecycle (library). Zero dependencies, node: built-ins only.
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rename, rm, rmdir, stat, writeFile, unlink } from 'node:fs/promises';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STATUSES = ['idea', 'new', 'in_progress', 'review', 'blocked', 'done'];

const KINDS = ['task', 'idea'];
const MODES = ['read', 'write'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUNNER_PATH = fileURLToPath(new URL('./runner.mjs', import.meta.url));

const LOCK_RETRY_MS = 25;
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 10000;
const HEARTBEAT_STALE_MS = 15000;

// ---------------------------------------------------------------- paths

function envValue(name) {
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

// ---------------------------------------------------------------- project listing

const KEY_RE = /^[0-9a-f]{12}$/;

function dirExists(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

// One listing entry for the folder `key`, or null when it must not be listed.
// Reads the state file without a lock and never writes.
function listedProject(key) {
  try {
    if (!KEY_RE.test(key)) return null;
    const file = join(dataDir(), 'projects', key, 'state.json');
    const st = statSync(file);
    const s = JSON.parse(readFileSync(file, 'utf8'));
    if (!s || typeof s !== 'object' || Array.isArray(s) || !Array.isArray(s.cards)) return null;
    if (typeof s.projectDir !== 'string' || !s.projectDir || projectKey(s.projectDir) !== key) return null;
    let newest = NaN;
    let threads = 0;
    let running = 0;
    for (const c of s.cards) {
      if (!c || typeof c !== 'object') continue;
      const t = Date.parse(c.updatedAt);
      if (Number.isFinite(t) && !(t <= newest)) newest = t;
      if (c.kind === 'thread') {
        threads += 1;
        if (c.thread && c.thread.runState === 'running') running += 1;
      }
    }
    const parts = s.projectDir.split(/[\\/]+/).filter(Boolean);
    return {
      key,
      projectDir: s.projectDir,
      name: parts.length ? parts[parts.length - 1] : s.projectDir,
      exists: dirExists(s.projectDir),
      cards: s.cards.length,
      threads,
      running,
      lastActivity: new Date(Number.isFinite(newest) ? newest : st.mtimeMs).toISOString(),
    };
  } catch {
    return null;
  }
}

export function listProjects() {
  let names;
  try { names = readdirSync(join(dataDir(), 'projects')); } catch { return []; }
  const out = [];
  for (const n of names) {
    const p = listedProject(n);
    if (p) out.push(p);
  }
  out.sort((a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity));
  return out;
}

export function projectDirForKey(key) {
  const p = typeof key === 'string' ? listedProject(key) : null;
  return p ? p.projectDir : null;
}

// Remove the data folder of a project whose own folder is gone. Never touches
// anything outside <data dir>/projects/<key>.
export async function forgetProject(key) {
  const entry = typeof key === 'string' ? listedProject(key) : null;
  if (!entry) throw new Error('unknown project');
  if (entry.exists) throw new Error(`project folder still exists: ${entry.projectDir}`);
  const root = join(dataDir(), 'projects');
  const target = join(root, key);
  if (!KEY_RE.test(key) || resolve(target) !== target) throw new Error('unknown project');
  return withLock(entry.projectDir, async () => {
    const again = listedProject(key);
    if (!again) throw new Error('unknown project');
    if (again.exists) throw new Error(`project folder still exists: ${again.projectDir}`);
    const state = readState(again.projectDir);
    const busy = state.cards.find((c) => c && c.kind === 'thread' && c.thread && c.thread.runState === 'running' && runnerAlive(again.projectDir, c));
    if (busy) throw new Error(`thread ${busy.id} is still running; end it before forgetting the project`);
    await rm(target, { recursive: true, force: true });
    return true;
  });
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
    await mkdir(guard);
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
      await mkdir(lockPath);
      await writeFile(owner, '');
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

async function withLock(projectDirArg, fn) {
  const paths = projectPaths(projectDirArg);
  await mkdir(paths.dir, { recursive: true });
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
        await writeFile(tmp, after, 'utf8');
        await rename(tmp, paths.state);
      } catch (e) {
        await unlink(tmp).catch(() => {});
        throw e;
      }
    }
    return result;
  });
}

// ---------------------------------------------------------------- helpers

const now = () => new Date().toISOString();

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!e && e.code === 'EPERM';
  }
}

// A runner is alive only if its pid exists and it has written a recent
// heartbeat naming that pid. The pid alone is not enough: after a crash the
// number can be reused by an unrelated process.
export function runnerAlive(projectDirArg, card) {
  const th = card && card.thread;
  if (!th || !isAlive(th.pid)) return false;
  const turn = th.turns[th.turns.length - 1];
  const started = turn ? Date.parse(turn.startedAt) : NaN;
  // Grace period: a runner that has only just been launched has no heartbeat yet.
  if (Number.isFinite(started) && Date.now() - started < HEARTBEAT_STALE_MS) return true;
  try {
    const hb = JSON.parse(readFileSync(join(projectPaths(projectDirArg).logs, `${card.id}.alive`), 'utf8'));
    return hb.pid === th.pid && Date.now() - hb.at < HEARTBEAT_STALE_MS;
  } catch {
    return false;
  }
}

function findCard(state, id) {
  const card = state.cards.find((c) => c.id === id);
  if (!card) throw new Error(`unknown card id: ${id}`);
  return card;
}

function findThread(state, id) {
  const card = state.cards.find((c) => c.id === id);
  if (!card || card.kind !== 'thread' || !card.thread) throw new Error(`thread not found: ${id}`);
  return card;
}

function checkStatus(status) {
  if (!STATUSES.includes(status)) {
    throw new Error(`invalid status "${status}" (use one of: ${STATUSES.join(', ')})`);
  }
}

function statusForRunState(runState) {
  switch (runState) {
    case 'running': return 'in_progress';
    case 'idle': return 'review';
    case 'failed': return 'blocked';
    case 'ended': return 'done';
    default: return 'in_progress';
  }
}

function setRunState(card, runState) {
  card.thread.runState = runState;
  card.status = statusForRunState(runState);
  card.updatedAt = now();
}

function oneLine(s, max = 300) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(-max) : t;
}

// ---------------------------------------------------------------- sessions

const SESSION_ID_RE = /^[0-9A-Za-z-]{8,64}$/;
const TRANSCRIPT_CHUNK = 256 * 1024;
const SESSION_THROTTLE_MS = 60000;
const NAME_MAX = 120;
const FIRST_MESSAGE_MAX = 60;
const NAME_RANK = { none: 0, 'first-message': 1, 'ai-title': 2, title: 3 };

const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function validTranscriptPath(p) {
  return typeof p === 'string' && p.length > 0 && isAbsolute(p) && p.endsWith('.jsonl');
}

function parseJsonLine(line) {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

async function readAt(fh, position, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead).toString('utf8');
}

// The first usable user text in one transcript line, or ''.
function userTextOf(obj) {
  const content = obj && obj.message && obj.message.content;
  const blocks = typeof content === 'string'
    ? [content]
    : Array.isArray(content)
      ? content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text)
      : [];
  for (const raw of blocks) {
    const t = collapse(raw);
    if (t && !t.startsWith('<')) return t;
  }
  return '';
}

// Reads at most the last 256 KB for an ai-title line and at most the first
// 256 KB for the first user message. Never throws; null when nothing is found.
async function nameFromTranscript(file) {
  if (!validTranscriptPath(file)) return null;
  let fh;
  try {
    fh = await open(file, 'r');
    const { size } = await fh.stat();
    if (!size) return null;
    const len = Math.min(size, TRANSCRIPT_CHUNK);
    const tailStart = size - len;
    const tailLines = (await readAt(fh, tailStart, len)).split('\n');
    if (tailStart > 0) tailLines.shift(); // partial first line
    for (let i = tailLines.length - 1; i >= 0; i--) {
      if (!tailLines[i].includes('ai-title')) continue;
      const o = parseJsonLine(tailLines[i]);
      if (o && o.type === 'ai-title' && typeof o.aiTitle === 'string' && collapse(o.aiTitle)) {
        return { name: collapse(o.aiTitle).slice(0, NAME_MAX), source: 'ai-title' };
      }
    }
    const headLines = (tailStart === 0 ? tailLines : (await readAt(fh, 0, len)).split('\n'));
    if (size > len) headLines.pop(); // partial last line
    for (const line of headLines) {
      if (!line.includes('"user"')) continue;
      const o = parseJsonLine(line);
      if (!o || o.type !== 'user') continue;
      const t = userTextOf(o);
      if (t) {
        return { name: t.length > FIRST_MESSAGE_MAX ? t.slice(0, FIRST_MESSAGE_MAX - 1) + '…' : t, source: 'first-message' };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

function sessionsOf(state) {
  return state && state.sessions && typeof state.sessions === 'object' && !Array.isArray(state.sessions) ? state.sessions : {};
}

function recentlyNamed(rec) {
  if (!rec || (rec.nameSource !== 'title' && rec.nameSource !== 'ai-title') || !rec.name) return false;
  const seen = Date.parse(rec.lastSeenAt);
  return Number.isFinite(seen) && Date.now() - seen < SESSION_THROTTLE_MS;
}

export async function touchSession(projectDirArg, sessionId, { transcriptPath, sessionTitle } = {}) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null;
  const key = sessionId.toLowerCase();
  const tp = validTranscriptPath(transcriptPath) ? transcriptPath : '';
  let prev;
  try { prev = sessionsOf(readState(projectDirArg))[key]; } catch { prev = undefined; }
  if (recentlyNamed(prev)) return prev;

  let found = null;
  const title = typeof sessionTitle === 'string' ? collapse(sessionTitle) : '';
  if (title) found = { name: title.slice(0, NAME_MAX), source: 'title' };
  else found = await nameFromTranscript(tp || (prev && prev.transcriptPath));

  return updateState(projectDirArg, (state) => {
    if (!state.sessions || typeof state.sessions !== 'object' || Array.isArray(state.sessions)) state.sessions = {};
    const ts = now();
    let rec = state.sessions[key];
    if (!rec || typeof rec !== 'object') {
      rec = { name: '', nameSource: 'none', transcriptPath: '', firstSeenAt: ts, lastSeenAt: ts };
      state.sessions[key] = rec;
    }
    // A found name replaces the old one unless it is a weaker source.
    if (found && (NAME_RANK[found.source] ?? 0) >= (NAME_RANK[rec.nameSource] ?? 0)) {
      rec.name = found.name;
      rec.nameSource = found.source;
    }
    if (tp) rec.transcriptPath = tp;
    rec.lastSeenAt = ts;
    return JSON.parse(JSON.stringify(rec));
  });
}

export function sessionLabel(state, sessionId) {
  const id = String(sessionId ?? '');
  const short = id.slice(0, 8);
  const rec = sessionsOf(state)[id.toLowerCase()];
  return rec && typeof rec.name === 'string' && rec.name ? `${rec.name} · ${short}` : `session ${short}`;
}

// ---------------------------------------------------------------- board cards

export async function addCard(projectDirArg, { title, note = '', status = 'new', kind = 'task', source = 'claude' } = {}) {
  const t = typeof title === 'string' ? title.trim() : '';
  if (!t) throw new Error('title must not be empty');
  checkStatus(status);
  if (kind === 'thread') throw new Error('thread cards are created with thread_start');
  if (!KINDS.includes(kind)) throw new Error(`invalid kind "${kind}" (use task or idea)`);
  if (source !== 'claude' && source !== 'user') throw new Error(`invalid source "${source}"`);
  return updateState(projectDirArg, (state) => {
    state.seq += 1;
    const ts = now();
    const card = {
      id: `c${state.seq}`,
      kind,
      title: t,
      note: note == null ? '' : String(note),
      status,
      source,
      seenByClaude: source !== 'user',
      createdAt: ts,
      updatedAt: ts,
    };
    state.cards.push(card);
    return card;
  });
}

export async function updateCard(projectDirArg, id, { title, note, status } = {}, { source = 'claude' } = {}) {
  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) throw new Error('title must not be empty');
  }
  if (status !== undefined) checkStatus(status);
  return updateState(projectDirArg, (state) => {
    const card = findCard(state, id);
    if (card.kind === 'thread' && status !== undefined && status !== card.status) {
      throw new Error('thread status follows the thread');
    }
    let changed = false;
    if (title !== undefined && title.trim() !== card.title) { card.title = title.trim(); changed = true; }
    if (note !== undefined && String(note) !== card.note) { card.note = String(note ?? ''); changed = true; }
    if (status !== undefined && status !== card.status) { card.status = status; changed = true; }
    if (changed) {
      card.updatedAt = now();
      if (source === 'user') card.seenByClaude = false;
    }
    return card;
  });
}

export async function removeCard(projectDirArg, id) {
  return updateState(projectDirArg, (state) => {
    const card = findCard(state, id);
    if (card.kind === 'thread' && card.thread && card.thread.runState === 'running' && isAlive(card.thread.pid)) {
      throw new Error(`thread ${id} is still running; end it before removing the card`);
    }
    state.cards = state.cards.filter((c) => c.id !== id);
    return true;
  });
}

export async function markSeen(projectDirArg) {
  return updateState(projectDirArg, (state) => {
    const unseen = [];
    for (const card of state.cards) {
      if (card.seenByClaude === false) {
        unseen.push(JSON.parse(JSON.stringify(card)));
        card.seenByClaude = true;
      }
    }
    return unseen;
  });
}

// ---------------------------------------------------------------- threads

const MAP_INSTRUCTION = 'After the digest, add a fenced code block tagged thread-map holding a JSON array of at most 12 steps in the order they happened, each {"kind":"did|found|decided|changed|open","text":"one short sentence","ref":"optional path:line"}.';
const MAP_BLOCK_RE = /```thread-map[^\n]*\n([\s\S]*?)```/i;
const MAP_KINDS = ['did', 'found', 'decided', 'changed', 'open'];
const SECTION_KEYS = ['happened', 'decided', 'changed', 'open'];

// Split a thread reply into its free text, the four digest sections and the
// ordered step map. Tolerant by design: a reply that follows none of the format
// comes back as body only.
export function parseHandback(text) {
  const out = { body: '', sections: { happened: '', decided: '', changed: '', open: '' }, map: [] };
  if (typeof text !== 'string') return out;
  let rest = text;
  const block = MAP_BLOCK_RE.exec(rest);
  if (block) {
    rest = rest.replace(MAP_BLOCK_RE, '');
    try {
      const arr = JSON.parse(block[1]);
      if (Array.isArray(arr)) {
        for (const item of arr.slice(0, 20)) {
          if (!item || typeof item !== 'object' || typeof item.text !== 'string' || !item.text.trim()) continue;
          const step = { kind: MAP_KINDS.includes(item.kind) ? item.kind : 'did', text: item.text.trim().slice(0, 400) };
          if (typeof item.ref === 'string' && item.ref.trim()) step.ref = item.ref.trim().slice(0, 200);
          out.map.push(step);
        }
      }
    } catch { /* not valid JSON: ignore the block */ }
  }
  const re = /^##\s+(Happened|Decided|Changed|Open)\s*$/gim;
  const marks = [];
  let m;
  while ((m = re.exec(rest)) !== null) marks.push({ key: m[1].toLowerCase(), start: m.index, end: re.lastIndex });
  if (!marks.length) {
    out.body = rest.trim();
    return out;
  }
  out.body = rest.slice(0, marks[0].start).trim();
  marks.forEach((mk, i) => {
    const chunk = rest.slice(mk.end, i + 1 < marks.length ? marks[i + 1].start : rest.length).trim();
    if (SECTION_KEYS.includes(mk.key)) out.sections[mk.key] = chunk;
  });
  return out;
}

function stripMap(text) {
  return typeof text === 'string' ? text.replace(MAP_BLOCK_RE, '').trimEnd() : text;
}

// A thread runs headless, so it cannot answer a permission prompt: any tool that
// would prompt is refused. These tools are pre-approved so research threads can
// reach the web. THREAD_ALLOW_TOOLS replaces the list (comma separated); "none"
// turns pre-approval off.
const DEFAULT_ALLOW_TOOLS = ['WebSearch', 'WebFetch'];
const MAX_EXTRA_DIRS = 5;

export function allowedTools() {
  const raw = envValue('THREAD_ALLOW_TOOLS');
  if (!raw) return DEFAULT_ALLOW_TOOLS;
  if (/^(none|off)$/i.test(raw)) return [];
  // An entry is passed as one argv item, never through a shell; a leading dash
  // is still refused so it cannot be read as another CLI flag.
  return raw.split(',').map((x) => x.trim()).filter((x) => x && !x.startsWith('-')).slice(0, 30);
}

// Folders outside the project that a thread may read. Each must be an existing
// absolute directory; anything else is an error the caller can show.
function normalizeDirs(dirs) {
  if (dirs == null) return [];
  if (!Array.isArray(dirs)) throw new Error('extra_dirs must be a list of folder paths');
  const out = [];
  for (const d of dirs) {
    const p = typeof d === 'string' ? d.trim() : '';
    if (!p) continue;
    if (p.startsWith('-') || !isAbsolute(p)) throw new Error(`extra_dirs entries must be absolute paths: ${p}`);
    let st;
    try { st = statSync(p); } catch { throw new Error(`extra_dirs folder not found: ${p}`); }
    if (!st.isDirectory()) throw new Error(`extra_dirs entry is not a folder: ${p}`);
    const r = resolve(p);
    if (!out.includes(r)) out.push(r);
  }
  if (out.length > MAX_EXTRA_DIRS) throw new Error(`at most ${MAX_EXTRA_DIRS} extra_dirs are allowed`);
  return out;
}

export function buildClaudeArgs(card) {
  const t = card.thread;
  const modeArgs = t.mode === 'write'
    ? ['--permission-mode', 'acceptEdits']
    : ['--disallowedTools', 'Edit', 'Write', 'NotebookEdit'];
  const allow = allowedTools();
  const allowArgs = allow.length ? ['--allowedTools', ...allow] : [];
  const dirs = Array.isArray(t.dirs) ? t.dirs.filter((d) => typeof d === 'string' && isAbsolute(d)) : [];
  const dirArgs = dirs.length ? ['--add-dir', ...dirs] : [];
  const base = t.sessionId
    ? ['-p', '--resume', t.sessionId]
    : ['-p', '--resume', t.parentSessionId, '--fork-session'];
  // The prompt goes in on stdin, so the variadic flags at the end cannot swallow it.
  return [...base, '--output-format', 'json', ...modeArgs, ...allowArgs, ...dirArgs];
}

export function buildPrompt(card) {
  const t = card.thread;
  const turn = t.turns[t.turns.length - 1];
  const text = turn ? turn.prompt : '';
  if (!t.sessionId) {
    return [
      `[side thread ${card.id}: ${card.title}]`,
      'You are now a side thread copied from the main session. The main session continues separately and cannot see anything you do here unless it asks for your report.',
      `Task: ${text}`,
      t.mode === 'write'
        ? 'You may edit files. Keep changes limited to this task.'
        : 'Do not modify any files. Read, search and analyse only.',
      'End your reply with a hand-back digest using exactly these headings: "## Happened", "## Decided", "## Changed", "## Open".',
      MAP_INSTRUCTION,
    ].join('\n');
  }
  return [
    `[side thread ${card.id}: follow-up]`,
    text,
    'End your reply with the same four-heading hand-back digest.',
    MAP_INSTRUCTION,
  ].join('\n');
}

function closeOpenTurn(card, error) {
  const turn = card.thread.turns[card.thread.turns.length - 1];
  if (turn && turn.finishedAt == null) {
    turn.finishedAt = now();
    turn.ok = false;
    turn.error = error;
  }
}

function markFailed(card, error) {
  closeOpenTurn(card, error);
  card.thread.pid = null;
  setRunState(card, 'failed');
}

// A shared board server may launch a turn for a project other than its own,
// so the child must not inherit this process's project variables.
function childEnv() {
  const env = { ...process.env };
  delete env.THREAD_PROJECT_DIR;
  delete env.CLAUDE_PROJECT_DIR;
  return env;
}

// Called inside updateState so the runner (which reads under the same lock)
// never sees the card before its pid is recorded.
function launchRunner(projectDirArg, card) {
  let child;
  try {
    child = spawn(process.execPath, [RUNNER_PATH, projectDirArg, card.id], {
      detached: true,
      stdio: 'ignore',
      env: childEnv(),
    });
  } catch (e) {
    markFailed(card, `could not start runner: ${oneLine(e.message)}`);
    return;
  }
  const pid = child.pid ?? null;
  card.thread.pid = pid;
  child.on('error', (e) => {
    // Async spawn failure: record it unless the runner already took over.
    updateState(projectDirArg, (state) => {
      const c = state.cards.find((x) => x.id === card.id);
      if (c && c.kind === 'thread' && c.thread.runState === 'running' && (c.thread.pid === pid || c.thread.pid == null)) {
        markFailed(c, `could not start runner: ${oneLine(e.message)}`);
      }
    }).catch(() => {});
  });
  child.unref();
}

export async function startThread(projectDirArg, { title, task, sessionId, mode = 'read', dirs } = {}) {
  if (process.env.THREAD_DEPTH) throw new Error('threads cannot start threads');
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
    throw new Error('session_id must be a UUID (the main session id)');
  }
  const t = typeof title === 'string' ? title.trim() : '';
  const k = typeof task === 'string' ? task.trim() : '';
  if (!t) throw new Error('title must not be empty');
  if (!k) throw new Error('task must not be empty');
  if (!MODES.includes(mode)) throw new Error(`invalid mode "${mode}" (use read or write)`);
  const extraDirs = normalizeDirs(dirs);
  return updateState(projectDirArg, (state) => {
    state.seq += 1;
    const ts = now();
    const card = {
      id: `c${state.seq}`,
      kind: 'thread',
      title: t,
      note: '',
      status: 'in_progress',
      source: 'claude',
      seenByClaude: true,
      createdAt: ts,
      updatedAt: ts,
      thread: {
        parentSessionId: sessionId.toLowerCase(),
        sessionId: null,
        mode,
        dirs: extraDirs,
        runState: 'running',
        pid: null,
        turns: [{ prompt: k, startedAt: ts, finishedAt: null, ok: null, result: null, error: null }],
        lastResult: null,
        reported: false,
        announced: false,
      },
    };
    state.cards.push(card);
    launchRunner(projectDirArg, card);
    return card;
  });
}

export async function continueThread(projectDirArg, id, message, { sessionId } = {}) {
  if (process.env.THREAD_DEPTH) throw new Error('a side thread cannot continue threads');
  const m = typeof message === 'string' ? message.trim() : '';
  if (!m) throw new Error('message must not be empty');
  return updateState(projectDirArg, (state) => {
    const card = findThread(state, id);
    const th = card.thread;
    if (th.runState === 'running') throw new Error(`thread ${id} is still running`);
    if (th.runState === 'ended') throw new Error(`thread ${id} has ended`);
    if (!th.sessionId) throw new Error(`thread ${id} has no session yet (its first turn did not finish); start a new thread instead`);
    const turn = { prompt: m, startedAt: now(), finishedAt: null, ok: null, result: null, error: null };
    if (typeof sessionId === 'string' && sessionId && !sameSession(sessionId, th.parentSessionId)) turn.sentBy = sessionId.toLowerCase();
    th.turns.push(turn);
    // `reported` is about the newest successful result, so it is left alone here:
    // the runner clears it only when this turn produces a new result. A follow-up
    // that fails leaves an already-reported thread reported.
    th.announced = false;
    th.pid = null;
    setRunState(card, 'running');
    launchRunner(projectDirArg, card);
    return card;
  });
}

const CONFIRM_TTL_MS = 10 * 60 * 1000;

function sameSession(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length > 0 && a.toLowerCase() === b.toLowerCase();
}

// Guard for a call made by a session other than the one that started the thread.
// Returns null when the call may go ahead (the caller is the parent, or the
// confirm code is valid and has been used up); otherwise issues a fresh code.
// `other` tells the caller which of the two cases it is.
function checkCaller(th, action, sessionId, confirmCode) {
  if (sameSession(sessionId, th.parentSessionId)) return { ok: true, other: false };
  const p = th.pendingConfirm;
  const given = typeof confirmCode === 'string' ? confirmCode.trim().toLowerCase() : '';
  const valid = !!p && !!given && p.code === given && p.action === action
    && sameSession(p.sessionId, sessionId) && Date.parse(p.expiresAt) > Date.now();
  if (valid) {
    delete th.pendingConfirm;
    return { ok: true, other: true };
  }
  const code = randomBytes(4).toString('hex');
  th.pendingConfirm = { code, action, sessionId: String(sessionId).toLowerCase(), expiresAt: new Date(Date.now() + CONFIRM_TTL_MS).toISOString() };
  return { ok: false, code };
}

export async function reportThread(projectDirArg, id, { sessionId, confirmCode } = {}) {
  if (process.env.THREAD_DEPTH) throw new Error('a side thread cannot report threads');
  return updateState(projectDirArg, (state) => {
    const card = findThread(state, id);
    const th = card.thread;
    if (th.lastResult == null) {
      throw new Error(`thread ${id} has no successful turn yet (state: ${th.runState})`);
    }
    let otherSession = false;
    if (sessionId != null) {
      const g = checkCaller(th, 'report', sessionId, confirmCode);
      if (!g.ok) return { needsConfirm: true, action: 'report', code: g.code, card };
      otherSession = g.other;
    }
    if (otherSession) {
      if (!Array.isArray(th.reports)) th.reports = [];
      th.reports.push({ sessionId: String(sessionId).toLowerCase(), at: now() });
    } else {
      th.reported = true;
    }
    const last = th.turns[th.turns.length - 1];
    const digest = stripMap(th.lastResult);
    let text = digest;
    if (th.runState === 'running') {
      text = `(a newer turn of thread ${id} is still running; this is the previous result)\n${digest}`;
    } else if (last && last.ok === false) {
      text = `(the newest turn of thread ${id} failed: ${last.error || 'unknown error'}; this is the last successful result)\n${digest}`;
    }
    return otherSession ? { card, text, otherSession: true } : { card, text };
  });
}

export async function endThread(projectDirArg, id, { sessionId, confirmCode } = {}) {
  if (process.env.THREAD_DEPTH) throw new Error('a side thread cannot end threads');
  let pidToKill = null;
  const result = await updateState(projectDirArg, (state) => {
    const c = findThread(state, id);
    const th = c.thread;
    if (th.runState === 'ended') return c;
    if (sessionId != null) {
      const g = checkCaller(th, 'end', sessionId, confirmCode);
      if (!g.ok) return { needsConfirm: true, action: 'end', code: g.code, card: c };
    }
    const wasRunning = th.runState === 'running';
    const pid = th.pid;
    if (wasRunning) {
      if (runnerAlive(projectDirArg, c)) pidToKill = pid; // runner records the turn when it exits
      else closeOpenTurn(c, 'ended by user');
    }
    th.pid = null;
    setRunState(c, 'ended');
    return c;
  });
  if (pidToKill) {
    try { process.kill(pidToKill, 'SIGTERM'); } catch { /* already gone */ }
  }
  return result;
}

// Finished threads with a result nobody has pulled yet, split by whether the
// given session started them.
export async function pickReportable(projectDirArg, sessionId) {
  const state = readState(projectDirArg);
  const mine = [];
  const others = [];
  for (const card of state.cards) {
    if (card.kind !== 'thread' || !card.thread) continue;
    const th = card.thread;
    if (th.lastResult == null || th.reported || th.runState === 'running') continue;
    (sameSession(sessionId, th.parentSessionId) ? mine : others).push(card);
  }
  return { mine, others };
}

export async function reconcile(projectDirArg) {
  return updateState(projectDirArg, (state) => {
    for (const card of state.cards) {
      if (card.kind !== 'thread' || !card.thread) continue;
      if (card.thread.runState === 'running' && !runnerAlive(projectDirArg, card)) {
        markFailed(card, 'runner exited without a result');
      }
    }
    return state;
  });
}

export async function pendingAnnouncements(projectDirArg, sessionId) {
  return updateState(projectDirArg, (state) => {
    const out = [];
    for (const card of state.cards) {
      if (card.kind !== 'thread' || !card.thread) continue;
      const th = card.thread;
      if (th.parentSessionId !== sessionId) continue;
      if ((th.runState === 'idle' || th.runState === 'failed') && th.announced === false) {
        th.announced = true;
        out.push(JSON.parse(JSON.stringify(card)));
      }
    }
    return out;
  });
}
