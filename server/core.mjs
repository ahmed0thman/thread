// thread plugin: state + thread lifecycle (library). Zero dependencies, node: built-ins only.
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, rmdir, stat, writeFile, unlink } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
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

export function projectPaths(projectDirArg) {
  const hash = createHash('sha1').update(resolve(String(projectDirArg))).digest('hex').slice(0, 12);
  const dir = join(dataDir(), 'projects', hash);
  return { dir, state: join(dir, 'state.json'), lock: join(dir, 'state.lock'), logs: join(dir, 'logs') };
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

export function buildClaudeArgs(card) {
  const t = card.thread;
  const modeArgs = t.mode === 'write'
    ? ['--permission-mode', 'acceptEdits']
    : ['--disallowedTools', 'Edit', 'Write', 'NotebookEdit'];
  if (!t.sessionId) {
    return ['-p', '--resume', t.parentSessionId, '--fork-session', '--output-format', 'json', ...modeArgs];
  }
  return ['-p', '--resume', t.sessionId, '--output-format', 'json', ...modeArgs];
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

// Called inside updateState so the runner (which reads under the same lock)
// never sees the card before its pid is recorded.
function launchRunner(projectDirArg, card) {
  let child;
  try {
    child = spawn(process.execPath, [RUNNER_PATH, projectDirArg, card.id], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
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

export async function startThread(projectDirArg, { title, task, sessionId, mode = 'read' } = {}) {
  if (process.env.THREAD_DEPTH) throw new Error('threads cannot start threads');
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
    throw new Error('session_id must be a UUID (the main session id)');
  }
  const t = typeof title === 'string' ? title.trim() : '';
  const k = typeof task === 'string' ? task.trim() : '';
  if (!t) throw new Error('title must not be empty');
  if (!k) throw new Error('task must not be empty');
  if (!MODES.includes(mode)) throw new Error(`invalid mode "${mode}" (use read or write)`);
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

export async function continueThread(projectDirArg, id, message) {
  if (process.env.THREAD_DEPTH) throw new Error('a side thread cannot continue threads');
  const m = typeof message === 'string' ? message.trim() : '';
  if (!m) throw new Error('message must not be empty');
  return updateState(projectDirArg, (state) => {
    const card = findThread(state, id);
    const th = card.thread;
    if (th.runState === 'running') throw new Error(`thread ${id} is still running`);
    if (th.runState === 'ended') throw new Error(`thread ${id} has ended`);
    if (!th.sessionId) throw new Error(`thread ${id} has no session yet (its first turn did not finish); start a new thread instead`);
    th.turns.push({ prompt: m, startedAt: now(), finishedAt: null, ok: null, result: null, error: null });
    th.reported = false;
    th.announced = false;
    th.pid = null;
    setRunState(card, 'running');
    launchRunner(projectDirArg, card);
    return card;
  });
}

export async function reportThread(projectDirArg, id) {
  return updateState(projectDirArg, (state) => {
    const card = findThread(state, id);
    const th = card.thread;
    if (th.lastResult == null) {
      throw new Error(`thread ${id} has no successful turn yet (state: ${th.runState})`);
    }
    th.reported = true;
    const last = th.turns[th.turns.length - 1];
    const digest = stripMap(th.lastResult);
    let text = digest;
    if (th.runState === 'running') {
      text = `(a newer turn of thread ${id} is still running; this is the previous result)\n${digest}`;
    } else if (last && last.ok === false) {
      text = `(the newest turn of thread ${id} failed: ${last.error || 'unknown error'}; this is the last successful result)\n${digest}`;
    }
    return { card, text };
  });
}

export async function endThread(projectDirArg, id) {
  if (process.env.THREAD_DEPTH) throw new Error('a side thread cannot end threads');
  let pidToKill = null;
  const card = await updateState(projectDirArg, (state) => {
    const c = findThread(state, id);
    const th = c.thread;
    if (th.runState === 'ended') return c;
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
  return card;
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
