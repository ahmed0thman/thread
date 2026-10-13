// Shared library for the MCP server, the board, the runner and the hook: cards, the thread lifecycle,
// hand-back parsing and the project listing. State and sessions live in state.mjs and sessions.mjs and
// are re-exported here. Zero dependencies, node: built-ins only.
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir, envValue, now, projectKey, projectPaths, readState, updateState, withLock } from './state.mjs';
import { cleanEffort, cleanModel, collapse, sameSession, sessionModel } from './sessions.mjs';

export * from './state.mjs';
export * from './sessions.mjs';

export const STATUSES = ['idea', 'new', 'in_progress', 'review', 'blocked', 'done'];

export const KINDS = ['task', 'idea'];
export const MODES = ['read', 'write'];
export const CONTEXTS = ['brief', 'full'];
export const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MAX_BRIEF = 50000;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const KEY_RE = /^[0-9a-f]{12}$/;
const CARD_ID_RE = /^c[0-9]+$/;
export const VERSION = (() => {
  try {
    const v = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8')).version;
    return typeof v === 'string' && v ? v : 'unknown';
  } catch {
    return 'unknown';
  }
})();
const RUNNER_PATH = fileURLToPath(new URL('./runner.mjs', import.meta.url));
const HEARTBEAT_STALE_MS = 15000;

// ---------------------------------------------------------------- project listing

export function dirExists(p) {
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
    const busy = state.cards.find((c) => isThread(c) && c.thread.runState === 'running' && runnerAlive(again.projectDir, c));
    if (busy) throw new Error(`thread ${busy.id} is still running; end it before forgetting the project`);
    await rm(target, { recursive: true, force: true });
    return true;
  });
}

// ---------------------------------------------------------------- cards and run state

function isAlive(pid) {
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
function runnerAlive(projectDirArg, card) {
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

export const isThread = (card) => !!card && card.kind === 'thread' && !!card.thread;

function findCard(state, id) {
  const card = state.cards.find((c) => c.id === id);
  if (!card) throw new Error(`card not found: ${id}`);
  return card;
}

export function findThread(state, id) {
  const card = findCard(state, id);
  if (!isThread(card)) throw new Error(`card ${id} is not a thread`);
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

export function setRunState(card, runState) {
  card.thread.runState = runState;
  card.status = statusForRunState(runState);
  card.updatedAt = now();
}

// The first n characters of a collapsed text, with an ellipsis when cut.
export function clip(s, n) {
  const t = collapse(s);
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// The last n characters of a collapsed text: for error text, where the end matters.
export const tail = (s, n = 500) => collapse(s).slice(-n);

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
  await updateState(projectDirArg, (state) => {
    const card = findCard(state, id);
    if (isThread(card) && card.thread.runState === 'running' && isAlive(card.thread.pid)) {
      throw new Error(`thread ${id} is still running; end it before removing the card`);
    }
    state.cards = state.cards.filter((c) => c.id !== id);
    return true;
  });
  // Logs and activity files would otherwise outlive the card. Best effort. The dot
  // keeps c1 from matching the files of c10.
  const { logs } = projectPaths(projectDirArg);
  try {
    for (const name of await readdir(logs)) {
      if (name.startsWith(`${id}.`)) await rm(join(logs, name), { force: true });
    }
  } catch { /* no logs folder, or a file that cannot be removed */ }
  return true;
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

function allowedTools() {
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
  if (!Array.isArray(dirs)) throw new Error('extra folders must be a list of paths');
  const out = [];
  for (const d of dirs) {
    const p = typeof d === 'string' ? d.trim() : '';
    if (!p) continue;
    if (p.startsWith('-') || !isAbsolute(p)) throw new Error(`extra folders must be absolute paths: ${p}`);
    let st;
    try { st = statSync(p); } catch { throw new Error(`extra folder not found: ${p}`); }
    if (!st.isDirectory()) throw new Error(`extra folder is not a folder: ${p}`);
    const r = resolve(p);
    if (!out.includes(r)) out.push(r);
  }
  if (out.length > MAX_EXTRA_DIRS) throw new Error(`at most ${MAX_EXTRA_DIRS} extra folders are allowed`);
  return out;
}

// A thread stored before contexts existed was a full copy.
export const threadContext = (t) => (t.context === 'brief' ? 'brief' : 'full');

// ---------------------------------------------------------------- agents

const frontmatterValue = (head, key) => {
  const m = new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, 'm').exec(head);
  return m ? m[1].replace(/^(["'])(.*)\1$/, '$2').trim() : '';
};

function agentsIn(dir, scope) {
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { return []; }
  const out = [];
  for (const f of files) {
    let head;
    try { head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    if (!head) continue;
    const name = frontmatterValue(head[1], 'name') || f.slice(0, -3);
    if (!AGENT_RE.test(name)) continue;
    out.push({
      name,
      description: clip(frontmatterValue(head[1], 'description'), 300),
      model: cleanModel(frontmatterValue(head[1], 'model')),
      // Shown on the board only, never passed to the CLI, so the agent file's own wording is kept.
      effort: clip(frontmatterValue(head[1], 'effort'), 20) || null,
      scope,
    });
  }
  return out;
}

// Sub-agents a thread can run as: <project>/.claude/agents and the user folder, top level only.
// The project's definition wins when both have the same name.
export function listAgents(projectDirArg, userDir = join(homedir(), '.claude', 'agents')) {
  const out = agentsIn(join(projectDirArg, '.claude', 'agents'), 'project');
  for (const a of agentsIn(userDir, 'user')) {
    if (!out.some((x) => x.name === a.name)) out.push(a);
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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
  // A brief thread starts a fresh session; a full one forks the main session. Follow-ups resume the thread's own.
  const base = t.sessionId
    ? ['-p', '--resume', t.sessionId]
    : threadContext(t) === 'brief' ? ['-p'] : ['-p', '--resume', t.parentSessionId, '--fork-session'];
  const model = cleanModel(t.model);
  const effort = cleanEffort(t.effort);
  const who = typeof t.agent === 'string' && AGENT_RE.test(t.agent)
    ? ['--agent', t.agent]
    : [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])];
  // The prompt goes in on stdin, so the variadic flags at the end cannot swallow it.
  return [...base, '--output-format', 'stream-json', '--verbose', ...who, ...modeArgs, ...allowArgs, ...dirArgs];
}

// One turn's activity file. Shared by the runner (writes) and readActivity (reads).
export function activityPath(projectDirArg, cardId, turnNumber) {
  if (!CARD_ID_RE.test(String(cardId))) throw new Error(`invalid card id: ${cardId}`);
  if (!Number.isInteger(turnNumber) || turnNumber < 1) throw new Error(`invalid turn number: ${turnNumber}`);
  return join(projectPaths(projectDirArg).logs, `${cardId}.t${turnNumber}.activity.jsonl`);
}

// What a turn did, from its activity file. A line that does not parse (the
// runner may be mid-write) is skipped.
export function readActivity(projectDirArg, cardId, turnNumber) {
  let text;
  try { text = readFileSync(activityPath(projectDirArg, cardId, turnNumber), 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
  const events = [];
  for (const line of text.split('\n')) {
    try { events.push(JSON.parse(line)); } catch { /* partial or empty line */ }
  }
  return events;
}

export function buildPrompt(card) {
  const t = card.thread;
  const turn = t.turns[t.turns.length - 1];
  const text = turn ? turn.prompt : '';
  if (!t.sessionId) {
    const brief = threadContext(t) === 'brief';
    const context = brief && typeof t.brief === 'string' && t.brief.trim() ? ['## Context', t.brief.trim()] : [];
    return [
      `[side thread ${card.id}: ${card.title}]`,
      brief
        ? 'You are a side thread started from a main session. You have not been given that session\'s conversation; everything you know about it is in the brief below. The main session continues separately and cannot see anything you do here unless it asks for your report.'
        : 'You are now a side thread copied from the main session. The main session continues separately and cannot see anything you do here unless it asks for your report.',
      ...context,
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

// A side thread runs with THREAD_DEPTH set and must not manage threads itself.
function refuseInsideThread(verb) {
  if (process.env.THREAD_DEPTH) throw new Error(`a side thread cannot ${verb} threads`);
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
    markFailed(card, `could not start runner: ${tail(e.message, 300)}`);
    return;
  }
  const pid = child.pid ?? null;
  card.thread.pid = pid;
  child.on('error', (e) => {
    // Async spawn failure: record it unless the runner already took over.
    updateState(projectDirArg, (state) => {
      const c = state.cards.find((x) => x.id === card.id);
      if (isThread(c) && c.thread.runState === 'running' && (c.thread.pid === pid || c.thread.pid == null)) {
        markFailed(c, `could not start runner: ${tail(e.message, 300)}`);
      }
    }).catch(() => {});
  });
  child.unref();
}

// The checks both ways of starting a thread share. Returns what beginThread stores.
async function launchOptions(projectDirArg, { sessionId, mode, extraDirs, context = 'brief', brief, agent }) {
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
    throw new Error('session_id must be a UUID (the main session id)');
  }
  if (!MODES.includes(mode)) throw new Error(`invalid mode "${mode}" (use read or write)`);
  if (!CONTEXTS.includes(context)) throw new Error(`invalid context "${context}" (use brief or full)`);
  const text = context === 'brief' && typeof brief === 'string' ? brief.trim() : '';
  if (text.length > MAX_BRIEF) {
    throw new Error(`brief is too long (${text.length} characters, the limit is ${MAX_BRIEF}); shorten it, or use context "full" to copy the whole conversation`);
  }
  const dirs = normalizeDirs(extraDirs);
  const name = typeof agent === 'string' ? agent.trim() : '';
  if (name) {
    const known = listAgents(projectDirArg).map((a) => a.name);
    if (!known.includes(name)) {
      throw new Error(`Unknown agent "${clip(name, 60)}". ${known.length ? `Available: ${known.join(', ')}.` : 'No agents are defined in .claude/agents.'}`);
    }
  }
  // An agent brings its own model; otherwise the thread runs as the main session does.
  const { model, effort } = name ? { model: null, effort: null } : await sessionModel(projectDirArg, sessionId);
  return { context, brief: text, dirs, agent: name || null, model, effort };
}

// Gives `card` its thread and launches the first turn. Called inside updateState.
function beginThread(projectDirArg, card, { sessionId, mode, prompt, ...opts }) {
  card.thread = {
    parentSessionId: sessionId.toLowerCase(),
    sessionId: null,
    ...opts,
    mode,
    runState: 'running',
    pid: null,
    turns: [{ prompt, startedAt: now(), finishedAt: null, ok: null, result: null, error: null }],
    lastResult: null,
    reported: false,
    announced: false,
  };
  setRunState(card, 'running');
  launchRunner(projectDirArg, card);
}

export async function startThread(projectDirArg, { title, task, sessionId, mode = 'read', extraDirs, context, brief, agent } = {}) {
  refuseInsideThread('start');
  const t = typeof title === 'string' ? title.trim() : '';
  const k = typeof task === 'string' ? task.trim() : '';
  const opts = await launchOptions(projectDirArg, { sessionId, mode, extraDirs, context, brief, agent });
  if (!t) throw new Error('title must not be empty');
  if (!k) throw new Error('task must not be empty');
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
    };
    state.cards.push(card);
    beginThread(projectDirArg, card, { sessionId, mode, prompt: k, ...opts });
    return card;
  });
}

// Turns a task or idea card into a thread in place: same id, title, note and source.
// Nobody writes a brief on the board, so in brief mode the card's note is the brief.
export async function startThreadFromCard(projectDirArg, cardId, { sessionId, mode = 'read', extraDirs, context, agent } = {}) {
  refuseInsideThread('start');
  const existing = readState(projectDirArg).cards.find((c) => c.id === cardId);
  const opts = await launchOptions(projectDirArg, { sessionId, mode, extraDirs, context, brief: existing && existing.note, agent });
  return updateState(projectDirArg, (state) => {
    const card = findCard(state, cardId);
    if (card.kind === 'thread') throw new Error(`card ${cardId} is already a thread`);
    const text = typeof card.note === 'string' ? card.note.trim() : '';
    card.kind = 'thread';
    // In brief mode the note already travels as the brief, so the task is the title alone.
    const prompt = text && opts.context === 'full' ? `${card.title}\n\n${text}` : card.title;
    beginThread(projectDirArg, card, { sessionId, mode, prompt, ...opts });
    return card;
  });
}

export async function continueThread(projectDirArg, id, message, { sessionId } = {}) {
  refuseInsideThread('continue');
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
  refuseInsideThread('report');
  return updateState(projectDirArg, (state) => {
    const card = findThread(state, id);
    const th = card.thread;
    if (th.lastResult == null) {
      throw new Error(`thread ${id} has no successful turn yet (state: ${th.runState})`);
    }
    let otherSession = false;
    if (sessionId != null) {
      const g = checkCaller(th, 'report', sessionId, confirmCode);
      if (!g.ok) return { card, needsConfirm: true, action: 'report', code: g.code };
      otherSession = g.other;
    }
    if (otherSession) {
      if (!Array.isArray(th.reports)) th.reports = [];
      th.reports.push({ sessionId: String(sessionId).toLowerCase(), at: now() });
    } else {
      th.reported = true;
      delete th.reportRequestedAt;
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
  refuseInsideThread('end');
  let pidToKill = null;
  const result = await updateState(projectDirArg, (state) => {
    const c = findThread(state, id);
    const th = c.thread;
    if (th.runState === 'ended') return { card: c };
    if (sessionId != null) {
      const g = checkCaller(th, 'end', sessionId, confirmCode);
      if (!g.ok) return { card: c, needsConfirm: true, action: 'end', code: g.code };
    }
    const wasRunning = th.runState === 'running';
    const pid = th.pid;
    if (wasRunning) {
      if (runnerAlive(projectDirArg, c)) pidToKill = pid; // runner records the turn when it exits
      else closeOpenTurn(c, 'ended by user');
    }
    th.pid = null;
    delete th.reportRequestedAt;
    setRunState(c, 'ended');
    return { card: c };
  });
  if (pidToKill) {
    try { process.kill(pidToKill, 'SIGTERM'); } catch { /* already gone */ }
  }
  return result;
}

// The board cannot write into a session, so "Report to main session" only stores
// a request; the hook tells the parent session on its next prompt.
export async function requestReport(projectDirArg, id) {
  return updateState(projectDirArg, (state) => {
    const card = findThread(state, id);
    if (card.thread.lastResult == null) throw new Error(`thread ${id} has nothing to report yet`);
    if (card.thread.reported) throw new Error(`thread ${id} is already reported`);
    card.thread.reportRequestedAt = now();
    return card;
  });
}

export async function cancelReportRequest(projectDirArg, id) {
  return updateState(projectDirArg, (state) => {
    const card = findThread(state, id);
    delete card.thread.reportRequestedAt;
    return card;
  });
}

// Read-only: the request stays until the report is made, so the hook repeats it on each prompt.
export async function pendingReportRequests(projectDirArg, sessionId) {
  return readState(projectDirArg).cards.filter((c) => {
    const th = isThread(c) && c.thread;
    return th && th.reportRequestedAt && th.lastResult != null && !th.reported && sameSession(th.parentSessionId, sessionId);
  });
}

// Finished threads with a result nobody has pulled yet, split by whether the
// given session started them.
export async function pickReportable(projectDirArg, sessionId) {
  const state = readState(projectDirArg);
  const mine = [];
  const others = [];
  for (const card of state.cards) {
    if (!isThread(card)) continue;
    const th = card.thread;
    if (th.lastResult == null || th.reported || th.runState === 'running') continue;
    (sameSession(sessionId, th.parentSessionId) ? mine : others).push(card);
  }
  return { mine, others };
}

export async function reconcile(projectDirArg) {
  return updateState(projectDirArg, (state) => {
    for (const card of state.cards) {
      if (!isThread(card)) continue;
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
      if (!isThread(card)) continue;
      const th = card.thread;
      if (!sameSession(th.parentSessionId, sessionId)) continue;
      if ((th.runState === 'idle' || th.runState === 'failed') && th.announced === false) {
        th.announced = true;
        out.push(JSON.parse(JSON.stringify(card)));
      }
    }
    return out;
  });
}
