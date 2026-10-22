// Sub-agent runs on a card. The SubagentStart and SubagentStop hooks record a run on the card named in the
// Agent call's description ("[c24] fix the tax rounding"); the board reads the run's transcript through
// runActivity. Imports only state.mjs, config.mjs and sessions.mjs, so a hook can load it quickly.
//
// A run can also stand for one turn of a thread that does the work of a card (thread_start with card): a "linked" run. It has no agent id and
// no transcript; its steps are the thread turn's activity file, and the runner closes it when the turn is recorded (openLinkedRun, closeLinkedRun).
//
// Claude Code writes a sub-agent's transcript to <projects>/<project folder>/<session id>/subagents/agent-<id>.jsonl
// next to agent-<id>.meta.json. That layout is not documented: it is read, never written, and a future
// Claude Code version may change it.
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { PRIVATE_FILE, envValue, legacyStoreOf, mkdirPrivateSync, now, projectPaths, readState, runInStore, storePinned, updateState } from './state.mjs';
import { collapse, SESSION_ID_RE } from './sessions.mjs';
import { CARD_ID_RE, CARD_ID_SRC, cardById, claudeCard, threadById } from './fields.mjs';
import { readConfig } from './config.mjs';

export const MAX_RUNS = 50;                   // runs kept on one card; the oldest go first
export const MAX_TEXT = 4000;                 // one text step, as in a thread's activity
export const MAX_EVENTS = 1000;               // events in a thread's activity file
export const MAX_RUN_EVENTS = 2000;           // events a run's snapshot or live view keeps: the newest ones
const PREVIEW = 300;                          // the part of a prompt or report kept in the state file
const MAX_PROMPT = 100000;                    // the full text, kept in the logs folder
const MAX_REPORT = 100000;
const META_RETRY_MS = 400;                    // how long startRun waits for the meta file when it is called directly
export const META_WAIT_MS = 5000;             // how long the background worker waits: Claude Code writes the meta file only after the SubagentStart hooks have returned
const TRANSCRIPT_WAIT_MS = 300;               // a moment more for the transcript, which lands after the meta file
const META_STEP_MS = 50;
const READ_CHUNK = 1024 * 1024;               // the most one request reads from a transcript
const MAX_LINE = 8 * 1024 * 1024;             // a longer transcript line is skipped
const MAX_SCAN = 256 * 1024 * 1024;           // a transcript this big is not scanned at all
const MAX_RESPONSE_EVENTS = 500;
const MAX_SNAPSHOT = 8 * 1024 * 1024;
const SETTLE_MS = 500;                        // the last transcript line lands about 130 ms after SubagentStop
const SUMMARY_KEYS = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'description', 'prompt'];
const MARKER_RE = new RegExp(`^\\s*\\[(${CARD_ID_SRC})\\]`);
const AGENT_ID_RE = /^[0-9a-f]{6,64}$/i;
const AGENT_FILE_RE = /^agent-([0-9a-f]{6,64})\.jsonl$/i;

const clip = (s, n) => {
  const t = collapse(s);
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);   // keeps line breaks
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- what a transcript line shows

export function summarize(input) {
  const src = input && typeof input === 'object' ? input : {};
  const key = SUMMARY_KEYS.find((k) => typeof src[k] === 'string' && src[k].trim());
  return key ? clip(src[key], 300) : clip(JSON.stringify(src), 200);
}

export function resultText(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join(' ') : '';
}

// The activity events of one transcript line, in the format of a thread's activity file. A response is
// written as one line per content block, so a line holds one block (or a few).
export function eventsOfLine(v) {
  const out = [];
  const blocks = v && v.message && Array.isArray(v.message.content) ? v.message.content : [];
  const at = typeof v.timestamp === 'string' ? { at: v.timestamp } : {};
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (v.type === 'assistant' && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      out.push({ ...at, kind: 'text', text: cut(b.text, MAX_TEXT) });
    } else if (v.type === 'assistant' && b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
      out.push({ ...at, kind: 'tool', id: b.id, name: clip(b.name, 60), summary: summarize(b.input) });
    } else if (v.type === 'user' && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      out.push({ ...at, kind: 'tool_result', id: b.tool_use_id, ok: b.is_error !== true, preview: clip(resultText(b.content), 300) });
    }
  }
  return out;
}

// The prompt: the first line of a sub-agent's transcript, a user message whose content is a string.
function promptOfLine(v) {
  const c = v && v.type === 'user' && v.message ? v.message.content : null;
  return typeof c === 'string' && c.trim() ? cut(c, MAX_PROMPT) : null;
}

const parseLine = (s) => {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- where a transcript may be

// Claude Code's projects folder: <CLAUDE_CONFIG_DIR>/projects when that is set, else ~/.claude/projects.
// THREAD_CLAUDE_PROJECTS_DIR points it elsewhere and exists for tests and demos only.
export function projectsRoot() {
  const test = envValue('THREAD_CLAUDE_PROJECTS_DIR');
  if (test) return test;
  const cfg = envValue('CLAUDE_CONFIG_DIR');
  return cfg && isAbsolute(cfg) ? join(cfg, 'projects') : join(homedir(), '.claude', 'projects');
}

// The file `p` names when it is <projects>/<folder>/<session id>/subagents/agent-<hex>.jsonl and, with
// mustExist, a plain file that no symlink leads to; else null. Returns the path below the real projects folder.
export function safeTranscript(p, { mustExist = true } = {}) {
  if (typeof p !== 'string' || !p || p.includes('\0') || !isAbsolute(p)) return null;
  let realRoot;
  try { realRoot = realpathSync(projectsRoot()); } catch { return null; }
  const given = resolve(p);
  let rel = relative(realRoot, given);
  if (rel.startsWith('..') || isAbsolute(rel)) rel = relative(resolve(projectsRoot()), given);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  const seg = rel.split(sep);
  if (seg.length !== 4 || !seg[0] || seg[2] !== 'subagents' || !SESSION_ID_RE.test(seg[1]) || !AGENT_FILE_RE.test(seg[3])) return null;
  const file = join(realRoot, rel);
  if (!mustExist) return file;
  try {
    if (realpathSync(file) !== file) return null;
    if (!lstatSync(file).isFile()) return null;
  } catch {
    return null;
  }
  return file;
}

// A run's transcript, only when the file is the one its agent id names.
function runTranscript(run) {
  const file = safeTranscript(run && run.transcript);
  return file && basename(file).toLowerCase() === `agent-${String(run.agentId).toLowerCase()}.jsonl` ? file : null;
}

// ---------------------------------------------------------------- reading a transcript

// Every line of a file, one chunk at a time. false when the file is too big to scan.
function eachLine(file, onLine) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size > MAX_SCAN) return false;
    const buf = Buffer.allocUnsafe(READ_CHUNK);
    const dec = new StringDecoder('utf8');
    let carry = '';
    let skipping = false;   // inside a line longer than MAX_LINE
    for (let pos = 0; pos < size;) {
      const n = readSync(fd, buf, 0, Math.min(READ_CHUNK, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      let text = dec.write(buf.subarray(0, n));
      if (skipping) {
        const nl = text.indexOf('\n');
        if (nl < 0) continue;
        text = text.slice(nl + 1);
        skipping = false;
      }
      const parts = (carry + text).split('\n');
      carry = parts.pop();
      for (const part of parts) onLine(part);
      if (carry.length > MAX_LINE) { carry = ''; skipping = true; }
    }
    if (carry && !skipping) onLine(carry);
    return true;
  } finally {
    closeSync(fd);
  }
}

// What a whole transcript shows: events (at most MAX_EVENTS), the number of tool calls, tokens and the prompt.
// A response is split into one line per content block and each line repeats the response's usage, with a
// partial output count on the earlier ones: each message id counts once, by its last line.
export function scanTranscript(file) {
  let events = [];
  const usageById = new Map();
  let steps = 0, prompt = null, dropped = 0, anon = 0, lines = 0;
  const ok = eachLine(file, (line) => {
    const v = parseLine(line);
    if (!v) return;
    lines += 1;
    if (prompt == null && lines === 1) prompt = promptOfLine(v);
    for (const e of eventsOfLine(v)) {
      if (e.kind === 'tool') steps += 1;
      events.push(e);
    }
    // the newest events are the ones kept; trimming in blocks keeps this cheap
    if (events.length > 2 * MAX_RUN_EVENTS) { dropped += events.length - MAX_RUN_EVENTS; events = events.slice(-MAX_RUN_EVENTS); }
    const m = v.type === 'assistant' ? v.message : null;
    if (m && m.usage && typeof m.usage === 'object') usageById.set(typeof m.id === 'string' ? m.id : `line:${anon++}`, m.usage);
  });
  if (!ok) return null;
  if (events.length > MAX_RUN_EVENTS) { dropped += events.length - MAX_RUN_EVENTS; events = events.slice(-MAX_RUN_EVENTS); }
  if (dropped) events.unshift({ kind: 'earlier', dropped });
  let usage = null;
  if (usageById.size) {
    const n = (x) => (Number.isFinite(x) && x >= 0 ? x : 0);
    usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    for (const u of usageById.values()) {
      usage.input += n(u.input_tokens);
      usage.cacheRead += n(u.cache_read_input_tokens);
      usage.cacheWrite += n(u.cache_creation_input_tokens);
      usage.output += n(u.output_tokens);
    }
  }
  return { events, steps, usage, prompt };
}

// Where the last complete line of the first `got` bytes of `buf` ends (the index of its line feed), or -1. With nothing read
// there is no line: lastIndexOf with a negative index would look at the end of the buffer, which may hold memory that was never written.
export function lineEnd(buf, got) {
  return got > 0 ? buf.lastIndexOf(0x0a, got - 1) : -1;
}

// The complete lines of `file` from byte `offset`, at most one chunk and MAX_RESPONSE_EVENTS events:
// { events, next, more, prompt, reset, quietMs }. `next` is where the next read starts; `more` says there is already more to read.
// An offset past the end of the file (it shrank or was replaced) starts over from 0 and says `reset`, so the reader drops what it had.
// `quietMs` is how long ago the file last changed. `toEvents` turns a parsed line into events: a thread turn's activity file already holds events.
export function readRunActivity(file, offset, toEvents = eventsOfLine) {
  const fd = openSync(file, 'r');
  try {
    const st = fstatSync(fd);
    const size = st.size;
    const quietMs = Math.max(0, Date.now() - st.mtimeMs);
    const reset = Number.isInteger(offset) && offset > size;
    const from = Number.isInteger(offset) && offset > 0 && offset <= size ? offset : 0;
    const want = Math.min(READ_CHUNK, size - from);
    if (want <= 0) return { events: [], next: from, more: false, prompt: null, reset, quietMs };
    const buf = Buffer.allocUnsafe(want);
    const got = readSync(fd, buf, 0, want, from);
    const end = lineEnd(buf, got);
    if (end < 0) {
      // no complete line: a line still being written, or one longer than a chunk, which is skipped
      return got === READ_CHUNK ? { events: [], next: from + got, more: true, prompt: null, reset, quietMs } : { events: [], next: from, more: false, prompt: null, reset, quietMs };
    }
    const events = [];
    let prompt = null, p = 0, capped = false;
    while (p <= end) {
      const nl = buf.indexOf(0x0a, p);
      const v = parseLine(buf.toString('utf8', p, nl));
      if (v) {
        if (from + p === 0) prompt = promptOfLine(v);
        for (const e of toEvents(v)) events.push(e);
      }
      p = nl + 1;
      if (events.length >= MAX_RESPONSE_EVENTS) { capped = true; break; }
    }
    const next = from + p;
    return { events, next, more: next < size && (capped || got === READ_CHUNK), prompt, reset, quietMs };
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------- what is kept outside the state file

export function snapshotPath(projectDirArg, cardId, n) {
  if (!CARD_ID_RE.test(String(cardId)) || !Number.isInteger(n) || n < 1) throw new Error('invalid run');
  return join(projectPaths(projectDirArg).logs, `${cardId}.r${n}.activity.jsonl`);
}

// A run's full prompt or report: the state file keeps only a preview of each.
export function textPath(projectDirArg, cardId, n, part) {
  if (part !== 'prompt' && part !== 'report') throw new Error('invalid part');
  return snapshotPath(projectDirArg, cardId, n).replace(/activity\.jsonl$/, `${part}.txt`);
}

function writeSnapshot(projectDirArg, cardId, n, events) {
  const file = snapshotPath(projectDirArg, cardId, n);
  mkdirPrivateSync(dirname(file));
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''), { mode: PRIVATE_FILE });
}

function readSnapshot(projectDirArg, cardId, n) {
  try {
    const file = snapshotPath(projectDirArg, cardId, n);
    if (statSync(file).size > MAX_SNAPSHOT) return null;
    const events = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const v = parseLine(line);
      if (v) events.push(v);
    }
    return events;
  } catch {
    return null;
  }
}

// Keeps the full text in the logs folder and returns what the state file holds: the preview, and whether a file was written.
function keepText(projectDirArg, cardId, n, part, text) {
  const preview = cut(text, PREVIEW);
  try {
    const file = textPath(projectDirArg, cardId, n, part);
    mkdirPrivateSync(dirname(file));
    writeFileSync(file, text, { mode: PRIVATE_FILE });
    return { preview, kept: true };
  } catch {
    return { preview, kept: false };
  }
}

// The full prompt or report of a run: the file in the logs folder, else the preview the state holds. { text, full }.
export function readRunText(projectDirArg, cardId, run, part) {
  const flag = part === 'prompt' ? run.promptFile : run.reportFile;
  const preview = typeof (part === 'prompt' ? run.prompt : run.result) === 'string' ? (part === 'prompt' ? run.prompt : run.result) : '';
  if (flag === true) {
    try {
      const file = textPath(projectDirArg, cardId, run.n, part);
      if (statSync(file).size <= 2 * MAX_REPORT * 4) return { text: readFileSync(file, 'utf8'), full: true };
    } catch { /* the preview is all there is */ }
  }
  return { text: preview, full: false };
}

// ---------------------------------------------------------------- the hooks

const isWorkCard = (c) => !!c && c.kind !== 'thread' && c.kind !== 'milestone';

function readMeta(file) {
  try {
    if (statSync(file).size > 65536) return null;
    const m = JSON.parse(readFileSync(file, 'utf8'));
    return m && typeof m === 'object' && !Array.isArray(m) ? m : null;
  } catch {
    return null;
  }
}

// The sub-agent's transcript path, built from the main session's: <folder>/<session id>/subagents/agent-<id>.jsonl.
function agentTranscript(input) {
  const id = input && input.agent_id;
  const main = input && input.transcript_path;
  if (typeof id !== 'string' || !AGENT_ID_RE.test(id) || typeof main !== 'string' || !isAbsolute(main) || !main.endsWith('.jsonl')) return null;
  return safeTranscript(join(dirname(main), basename(main, '.jsonl'), 'subagents', `agent-${id}.jsonl`), { mustExist: false });
}

const lower = (s) => String(s).toLowerCase();

// The meta file of the agent, when its description starts with [cN] (or [c8k2x1]), it is not a nested agent, the project is not chat-only
// and N is a task or idea of this project: { transcript, meta, cardId, store }; else null. `store` is the key of an older per-path store when
// the card is only there (see olderStoreCard); the run is then kept in that store. The meta file can land a moment after
// SubagentStart, so with retryMs a file that is not there yet is waited for, in short steps.
async function trackedAgent(projectDirArg, input, retryMs) {
  const transcript = agentTranscript(input);
  if (!transcript) return null;
  const metaFile = transcript.replace(/\.jsonl$/, '.meta.json');
  const until = Date.now() + retryMs;
  while (!existsSync(metaFile) && Date.now() < until) await sleep(META_STEP_MS);
  const meta = readMeta(metaFile);
  const marker = meta && typeof meta.description === 'string' ? MARKER_RE.exec(meta.description) : null;
  if (!marker) return null;
  if (Number(meta.spawnDepth) > 1) return null;
  if (readConfig(projectDirArg).mode === 'chat') return null;
  const state = readState(projectDirArg);
  let cardId = marker[1];
  // a card that was copied into the repo under a new id is still found by the id it was given before (the marker was written then); the
  // marker is Claude's word for the card, so it is resolved as Claude's other calls are (fields.claudeCard)
  // an id that names two cards (fields.claudeCard throws) records nothing rather than guess
  let named;
  try { named = claudeCard(state, cardId); } catch { return null; }
  if (isWorkCard(named)) cardId = named.id;
  if (!isWorkCard(named)) {
    const older = olderStoreCard(projectDirArg, cardId);
    return older ? { transcript, meta, cardId, store: older.key } : null;
  }
  return { transcript, meta, cardId };
}

// A session that works in a worktree or sub-folder which had a board store of its own before the project was kept in the repo may still name
// cards by the ids that store gave, and a card that was not copied is only there. Its runs go to that store (the one its board shows), never to
// the repo's cards. { key } when this folder's older store has that task or idea.
function olderStoreCard(projectDirArg, cardId) {
  if (storePinned()) return null;
  try {
    const store = legacyStoreOf(projectDirArg);
    return store && store.state.cards.some((c) => isWorkCard(c) && c.id === cardId) ? { key: store.key } : null;
  } catch {
    return null;
  }
}

// Add the run for this agent to the card, or reopen the one it has. Inside updateState. `dropped` collects the numbers of runs pushed out.
function openRun(card, input, { transcript, meta, prompt, dropped, eventAt }) {
  if (!Array.isArray(card.runs)) card.runs = [];
  const known = card.runs.find((r) => r && r.agentId === input.agent_id);
  if (known) {
    // a start event that was recorded late must not reopen a run its own stop has closed since
    if (eventAt && known.finishedAt && Date.parse(known.finishedAt) >= eventAt) return null;
    // the same agent started again (it was sent a message): the run is open again
    known.state = 'running';
    known.finishedAt = null;
    known.ok = null;
    delete known.note;
    known.transcript = transcript;
    return known;
  }
  const n = card.runs.reduce((top, r) => Math.max(top, Number(r && r.n) || 0), 0) + 1;
  const run = {
    n,
    agentId: input.agent_id,
    agentType: clip(typeof input.agent_type === 'string' && input.agent_type ? input.agent_type : meta.agentType, 60),
    mode: meta.requestShape === 'background' ? 'background' : 'foreground',
    description: clip(meta.description, 300),
    state: 'running',
    sessionId: typeof input.session_id === 'string' ? lower(input.session_id) : '',
    startedAt: now(),
    finishedAt: null,
    ok: null,
    prompt: null,
    result: null,
    transcript,
  };
  card.runs.push(run);
  while (card.runs.length > MAX_RUNS) dropped.push(card.runs.shift().n);
  return run;
}

function dropFiles(projectDirArg, cardId, numbers) {
  for (const n of numbers) {
    for (const f of [snapshotPath(projectDirArg, cardId, n), textPath(projectDirArg, cardId, n, 'prompt'), textPath(projectDirArg, cardId, n, 'report')]) {
      try { unlinkSync(f); } catch { /* none was kept */ }
    }
  }
}

// Set a run's prompt (the preview in state, the full text in a file) unless it has one.
function givePrompt(projectDirArg, cardId, run, text) {
  if (run.prompt || !text) return;
  const k = keepText(projectDirArg, cardId, run.n, 'prompt', text);
  run.prompt = k.preview;
  if (k.kept) run.promptFile = true;
}

// Whether a SubagentStart could mean anything for this project: it is not chat-only and has a task or idea. The hook asks before it
// starts a background worker, so a project without a board costs nothing.
export function canTrack(projectDirArg) {
  try {
    if (readConfig(projectDirArg).mode === 'chat') return false;
    return readState(projectDirArg).cards.some(isWorkCard) || (!storePinned() && !!legacyStoreOf(projectDirArg));
  } catch {
    return false;
  }
}

// SubagentStart: when the Agent call's description starts with [cN] and N is a task or idea of this project,
// add a run to it, or reopen the run this agent already has. Returns true when a run was recorded.
// Claude Code writes the agent's meta file (its description) only after the SubagentStart hooks have returned, so the hook itself
// cannot wait for it: it starts a worker that calls this with a long retryMs. `eventAt` (ms) is when the event happened.
// The caller sets THREAD_LOCK_WAIT_MS so a busy lock never holds anything up for long.
export async function startRun(projectDirArg, input, opts = {}) {
  const tracked = await trackedAgent(projectDirArg, input, opts.retryMs ?? META_RETRY_MS);
  if (!tracked) return false;
  return tracked.store ? runInStore(tracked.store, () => recordStart(projectDirArg, input, tracked, opts)) : recordStart(projectDirArg, input, tracked, opts);
}

async function recordStart(projectDirArg, input, { transcript, meta, cardId }, { retryMs = META_RETRY_MS, eventAt = 0 }) {
  if (retryMs) {
    const until = Date.now() + TRANSCRIPT_WAIT_MS;
    while (!existsSync(transcript) && Date.now() < until) await sleep(META_STEP_MS);
  }
  let prompt = null;
  try { prompt = readRunActivity(transcript, 0).prompt; } catch { /* the file is not written yet */ }
  const dropped = [];
  const recorded = await updateState(projectDirArg, (state) => {
    const card = cardById(state.cards, cardId);
    if (!isWorkCard(card)) return false;
    const run = openRun(card, input, { transcript, meta, dropped, eventAt });
    if (!run) return false;
    givePrompt(projectDirArg, cardId, run, prompt);
    return true;
  });
  dropFiles(projectDirArg, cardId, dropped);
  return recorded;
}

// SubagentStop: close the run of this agent, with its report, and keep a snapshot of its activity. An agent that has no run yet
// (its start was missed, for example because its meta file was not there) gets one now, from its meta file, which exists by then.
export async function stopRun(projectDirArg, input, { settleMs = SETTLE_MS } = {}) {
  const id = input && input.agent_id;
  if (typeof id !== 'string' || !AGENT_ID_RE.test(id)) return false;
  const find = (state) => {
    for (const card of state.cards) {
      if (!isWorkCard(card) || !Array.isArray(card.runs)) continue;
      const run = card.runs.find((r) => r && r.agentId === id);
      if (run) return { card, run };
    }
    return null;
  };
  const found = find(readState(projectDirArg));
  let late = null;   // the meta of an agent whose start was not recorded (or whose run is in an older store: see olderStoreCard)
  if (found) {
    if (readConfig(projectDirArg).mode === 'chat') return false;
  } else {
    late = await trackedAgent(projectDirArg, input, 0);
    if (!late) return false;
  }
  return late && late.store ? runInStore(late.store, () => recordStop(projectDirArg, input, { found, late, id, find, settleMs })) : recordStop(projectDirArg, input, { found, late, id, find, settleMs });
}

async function recordStop(projectDirArg, input, { found, late, id, find, settleMs }) {
  await sleep(settleMs);

  const transcriptOf = found ? found.run.transcript : late.transcript;
  const cardId = found ? found.card.id : late.cardId;
  const file = runTranscript({ transcript: transcriptOf, agentId: id });
  let scan = null;
  try { scan = file ? scanTranscript(file) : null; } catch { /* unreadable: the run still closes */ }
  const report = typeof input.last_assistant_message === 'string' && input.last_assistant_message.trim() ? cut(input.last_assistant_message, MAX_REPORT) : null;
  const dropped = [];
  const closed = await updateState(projectDirArg, (state) => {
    let target = find(state);
    if (!target) {
      if (!late) return false;
      const card = cardById(state.cards, cardId);
      if (!isWorkCard(card)) return false;
      target = { card, run: openRun(card, input, { transcript: late.transcript, meta: late.meta, dropped }) };
    }
    const { card, run } = target;
    run.state = 'done';
    run.finishedAt = now();
    run.ok = true;
    delete run.note;
    if (report != null) {
      const k = keepText(projectDirArg, card.id, run.n, 'report', report);
      run.result = k.preview;
      if (k.kept) run.reportFile = true;
    }
    if (scan) {
      run.steps = scan.steps;
      if (scan.usage) run.usage = scan.usage;
      givePrompt(projectDirArg, card.id, run, scan.prompt);
      try { writeSnapshot(projectDirArg, card.id, run.n, scan.events); run.snapshot = true; } catch { /* the board then reads the transcript while it exists */ }
    }
    return true;
  });
  dropFiles(projectDirArg, cardId, dropped);
  return closed;
}

// A run of a thread cannot be marked as stopped while the thread is running its turn (the board answers 409).
export class RunLiveError extends Error {
  constructor(message) { super(message); this.status = 409; }
}

// The board's "Mark as stopped": a run that is still running and will never be closed (its session ended, or its stop event was lost).
// Only this run's state fields are written.
export async function markRunStopped(projectDirArg, cardId, n) {
  return updateState(projectDirArg, (state) => {
    const card = cardById(state.cards, cardId);
    if (!isWorkCard(card)) throw new Error(`card ${cardId} is not a task or idea`);
    const run = Array.isArray(card.runs) ? card.runs.find((r) => r && r.n === n) : null;
    if (!run) throw new Error(`card ${cardId} has no run ${n}`);
    if (run.state !== 'running') throw new Error(`run ${n} of ${cardId} is not running`);
    if (isLinkedRun(run) && linkedAlive(run, state.cards)) throw new RunLiveError(`run ${n} of ${cardId} is still going: its thread is running that turn. End the thread to stop it.`);
    run.state = 'stopped';
    run.ok = false;
    run.finishedAt = now();
    run.note = 'Marked as stopped on the board: no stop was reported for this run.';
    return { ...run, transcript: undefined };
  });
}

// ---------------------------------------------------------------- runs of a thread that does a card's work

// One turn's activity file of a thread (core.activityPath is this function: runs.mjs cannot import core.mjs).
export function turnActivityPath(projectDirArg, cardId, turnNumber) {
  if (!CARD_ID_RE.test(String(cardId))) throw new Error(`invalid card id: ${cardId}`);
  if (!Number.isInteger(turnNumber) || turnNumber < 1) throw new Error(`invalid turn number: ${turnNumber}`);
  return join(projectPaths(projectDirArg).logs, `${cardId}.t${turnNumber}.activity.jsonl`);
}

// A run that stands for a thread's turn: it names the thread and the turn and has no agent id. An older plugin version ignores both fields.
export const isLinkedRun = (r) => !!r && typeof r === 'object' && typeof r.thread === 'string' && CARD_ID_RE.test(r.thread) && Number.isInteger(r.turn) && r.turn >= 1 && r.agentId === undefined;

// Whether the thread is running the turn a linked run stands for. A thread that is gone, or a turn that is not the newest, is not.
export function linkedAlive(run, cards) {
  const th = threadById(cards, run.thread);
  return !!th && th.thread.runState === 'running' && Array.isArray(th.thread.turns) && th.thread.turns.length === run.turn;
}

// The task or idea a thread does the work of (its forCard), when it still is one.
function forCardOf(state, threadCard) {
  const id = threadCard && threadCard.thread && threadCard.thread.forCard;
  const card = typeof id === 'string' ? cardById(state.cards, id) : null;
  return isWorkCard(card) ? card : null;
}

// Opens the run for turn `turnNo` of a thread on the card it works for, or returns the one it already has. Inside updateState, which the caller
// holds. `prompt` is what the provider is given. null when the thread does the work of no card (any more).
export function openLinkedRun(projectDirArg, state, threadCard, turnNo, prompt, { startedAt } = {}) {
  const card = forCardOf(state, threadCard);
  if (!card) return null;
  const th = threadCard.thread;
  if (!Array.isArray(card.runs)) card.runs = [];
  const known = card.runs.find((r) => isLinkedRun(r) && r.thread === threadCard.id && r.turn === turnNo);
  if (known) return known;
  const n = card.runs.reduce((top, r) => Math.max(top, Number(r && r.n) || 0), 0) + 1;
  const lane = th.lane && typeof th.lane.name === 'string' ? th.lane.name : '';
  const run = {
    n,
    thread: threadCard.id,
    turn: turnNo,
    ...(lane ? { lane: clip(lane, 60) } : {}),
    agentType: clip((typeof th.agent === 'string' && th.agent) || lane || 'thread', 60),
    mode: 'background',
    description: clip(threadCard.title, 300),
    state: 'running',
    sessionId: typeof th.parentSessionId === 'string' ? th.parentSessionId : '',
    startedAt: typeof startedAt === 'string' && Number.isFinite(Date.parse(startedAt)) ? startedAt : now(),
    finishedAt: null,
    ok: null,
    prompt: null,
    result: null,
  };
  card.runs.push(run);
  const dropped = [];
  while (card.runs.length > MAX_RUNS) dropped.push(card.runs.shift().n);
  givePrompt(projectDirArg, card.id, run, typeof prompt === 'string' ? cut(prompt, MAX_PROMPT) : '');
  dropFiles(projectDirArg, card.id, dropped);
  return run;
}

// The events of a thread turn's activity file, the newest MAX_RUN_EVENTS; null when there is no file.
function turnEvents(projectDirArg, threadId, turnNo) {
  try {
    const file = turnActivityPath(projectDirArg, threadId, turnNo);
    if (statSync(file).size > MAX_SNAPSHOT) return null;
    const events = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const v = parseLine(line);
      if (v && typeof v.kind === 'string') events.push(v);
    }
    return events.length > MAX_RUN_EVENTS ? [{ kind: 'earlier', dropped: events.length - MAX_RUN_EVENTS }, ...events.slice(-MAX_RUN_EVENTS)] : events;
  } catch {
    return null;
  }
}

function finishLinked(projectDirArg, card, run, { ok, result, error, steps, usage }) {
  run.state = ok ? 'done' : 'stopped';
  run.finishedAt = now();
  run.ok = !!ok;
  if (ok) delete run.note;
  else run.note = clip(typeof error === 'string' && error ? error : 'the thread\'s turn ended without a result', 300);
  if (ok && typeof result === 'string' && result.trim()) {
    const k = keepText(projectDirArg, card.id, run.n, 'report', cut(result, MAX_REPORT));
    run.result = k.preview;
    if (k.kept) run.reportFile = true;
  }
  if (Number.isInteger(steps) && steps >= 0) run.steps = steps;
  if (usage && typeof usage === 'object') run.usage = usage;
  // the trace is kept apart from the thread card, which can be removed
  const events = turnEvents(projectDirArg, run.thread, run.turn);
  if (events) {
    try { writeSnapshot(projectDirArg, card.id, run.n, events); run.snapshot = true; } catch { /* the board then reads the thread's activity file while it exists */ }
  }
}

// Closes the run for turn `turnNo` of a thread: done with the report, or stopped with the error. Inside updateState. false when there is none
// to close. A run the sweep closed early (stopped, and with no report) is updated too: the turn's own record is the authority on how it ended.
export function closeLinkedRun(projectDirArg, state, threadCardId, turnNo, outcome) {
  const card = forCardOf(state, threadById(state.cards, threadCardId));
  const early = (r) => r.state === 'stopped' && r.result == null && r.reportFile === undefined;
  const run = card && Array.isArray(card.runs) ? card.runs.find((r) => isLinkedRun(r) && r.thread === threadCardId && r.turn === turnNo && (r.state === 'running' || early(r))) : null;
  if (!run) return false;
  finishLinked(projectDirArg, card, run, outcome || {});
  return true;
}

// Closes a run from how its thread's turn ended (the thread's record of it): done with the report, else stopped with the turn's error, else
// with a note that the user ended the thread, or that the turn ended without a result.
function closeFromTurn(projectDirArg, state, card, run) {
  const th = threadById(state.cards, run.thread);
  const turn = th && Array.isArray(th.thread.turns) ? th.thread.turns[run.turn - 1] : null;
  if (turn && turn.ok === true) return finishLinked(projectDirArg, card, run, { ok: true, result: turn.result, steps: turn.steps, usage: turn.usage });
  const own = turn && turn.finishedAt && typeof turn.error === 'string' ? turn.error : '';
  finishLinked(projectDirArg, card, run, { ok: false, error: own || (th && th.thread.runState === 'ended' ? 'ended by the user' : ''), steps: turn ? turn.steps : undefined, usage: turn ? turn.usage : undefined });
}

// Removing a thread: closes the running runs it has on its card from the turn's stored result, steps and usage, before the thread and its
// files are gone. Inside updateState. Returns how many it closed.
export function closeThreadRuns(projectDirArg, state, threadCard) {
  const card = forCardOf(state, threadCard);
  if (!card || !Array.isArray(card.runs)) return 0;
  let closed = 0;
  for (const run of card.runs) {
    if (!isLinkedRun(run) || run.thread !== threadCard.id || run.state !== 'running') continue;
    closeFromTurn(projectDirArg, state, card, run);
    closed += 1;
  }
  return closed;
}

// The running linked runs whose thread is not running their turn any more: [{ card, run }]. A thread whose runner is still writing
// (`busy(threadCard)`: it was ended and has not stopped yet) is left alone; its runner records the turn and closes the run.
export function staleLinkedRuns(cards, busy = () => false) {
  const out = [];
  for (const card of cards) {
    if (!isWorkCard(card) || !Array.isArray(card.runs)) continue;
    for (const run of card.runs) {
      if (!isLinkedRun(run) || run.state !== 'running' || linkedAlive(run, cards)) continue;
      const th = threadById(cards, run.thread);
      if (th && busy(th)) continue;
      out.push({ card, run });
    }
  }
  return out;
}

// The turns of a thread that does a card's work that have no run on the card: [{ card, thread, turn }]. An older plugin version that
// continues such a thread appends a turn and opens no run. Only the newest MAX_RUNS turns, and only while the card has room for runs: a card
// at its limit may have dropped the run of an older turn, which must not come back.
export function missingLinkedRuns(cards) {
  const out = [];
  for (const th of cards) {
    if (!th || th.kind !== 'thread' || !th.thread || typeof th.thread.forCard !== 'string' || !Array.isArray(th.thread.turns)) continue;
    const card = cardById(cards, th.thread.forCard);
    if (!isWorkCard(card)) continue;
    const runs = Array.isArray(card.runs) ? card.runs : [];
    if (runs.length >= MAX_RUNS) continue;
    const have = new Set(runs.filter((r) => isLinkedRun(r) && r.thread === th.id).map((r) => r.turn));
    for (let n = Math.max(1, th.thread.turns.length - MAX_RUNS + 1); n <= th.thread.turns.length; n++) if (!have.has(n)) out.push({ card, thread: th, turn: n });
  }
  return out;
}

// Whether the sweep has anything to do (a read, so a board poll that finds nothing writes nothing).
export const linkedRunsPending = (cards, busy) => staleLinkedRuns(cards, busy).length > 0 || missingLinkedRuns(cards).length > 0;

// The sweep: opens the runs that are missing, then closes those whose turn is over from the thread's record of it. Inside updateState.
// Returns how many it changed.
export function closeStaleLinkedRuns(projectDirArg, state, busy) {
  let changed = 0;
  for (const { card, thread, turn } of missingLinkedRuns(state.cards)) {
    if ((card.runs || []).length >= MAX_RUNS) continue;   // opening one more would drop the oldest
    const t = thread.thread.turns[turn - 1];
    if (openLinkedRun(projectDirArg, state, thread, turn, t && t.prompt, { startedAt: t && t.startedAt })) changed += 1;
  }
  for (const { card, run } of staleLinkedRuns(state.cards, busy)) {
    closeFromTurn(projectDirArg, state, card, run);
    changed += 1;
  }
  return changed;
}

// ---------------------------------------------------------------- the board's reader

// A running run with no new activity for this long may have stopped (its stop was never recorded). The card page's own
// threshold (RUN_QUIET_MS in the board's thread.js) is the same number; a test holds them equal.
export const RUN_QUIET_MS = 10 * 60 * 1000;

// Whether a running run has been quiet for RUN_QUIET_MS: its transcript has not changed that long (a run whose transcript cannot be
// read counts from its start, as the board's activity route does). The board tile shows it as `quiet`, computed per response, never stored.
export function runQuiet(run, nowMs = Date.now()) {
  if (!run || run.state !== 'running' || isLinkedRun(run)) return false;
  let last = Date.parse(run.startedAt);
  try {
    const file = runTranscript(run);
    if (file) last = statSync(file).mtimeMs;
  } catch { /* gone: from its start */ }
  return Number.isFinite(last) && nowMs - last >= RUN_QUIET_MS;
}

// What the board route returns for a run: { run, running, events, next, more, prompt?, reset?, quietMs?, gone? }. A finished run is
// read from its snapshot; a running one (or a finished one without a snapshot) from its transcript, from byte `offset`.
// The only path ever read is the one recorded on the run, and only after safeTranscript accepts it.
export function runActivity(projectDirArg, cardId, run, offset = 0) {
  const running = run.state === 'running';
  if (!running && run.snapshot === true) {
    const events = readSnapshot(projectDirArg, cardId, run.n);
    if (events) return { run: run.n, running, events, next: null, more: false };
  }
  const quietMs = Math.max(0, Date.now() - (Date.parse(run.startedAt) || Date.now()));
  const gone = { run: run.n, running, events: [], next: null, more: false, gone: true, quietMs };
  if (isLinkedRun(run)) {
    // the thread turn's activity file, built from the thread's id and the turn's number, never from a stored path
    let linked = null;
    try { linked = turnActivityPath(projectDirArg, run.thread, run.turn); } catch { return gone; }
    if (!existsSync(linked)) return running ? { run: run.n, running, events: [], next: 0, more: false, quietMs } : gone;   // the runner has not made it yet
    try {
      return { run: run.n, running, ...readRunActivity(linked, offset, (v) => (typeof v.kind === 'string' ? [v] : [])) };
    } catch {
      return gone;
    }
  }
  let file = null;
  try { file = runTranscript(run); } catch { /* treated as gone */ }
  if (!file) return gone;
  try {
    return { run: run.n, running, ...readRunActivity(file, offset) };
  } catch {
    return gone;
  }
}
