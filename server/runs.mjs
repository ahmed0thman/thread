// Sub-agent runs on a card. The SubagentStart and SubagentStop hooks record a run on the card named in the
// Agent call's description ("[c24] fix the tax rounding"); the board reads the run's transcript through
// runActivity. Imports only state.mjs, config.mjs and sessions.mjs, so a hook can load it quickly.
//
// Claude Code writes a sub-agent's transcript to <projects>/<project folder>/<session id>/subagents/agent-<id>.jsonl
// next to agent-<id>.meta.json. That layout is not documented: it is read, never written, and a future
// Claude Code version may change it.
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { PRIVATE_FILE, envValue, mkdirPrivateSync, now, projectPaths, readState, updateState } from './state.mjs';
import { collapse, SESSION_ID_RE } from './sessions.mjs';
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
const MARKER_RE = /^\s*\[c([0-9]{1,9})\]/;
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
// `quietMs` is how long ago the file last changed.
export function readRunActivity(file, offset) {
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
        for (const e of eventsOfLine(v)) events.push(e);
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
  if (!/^c[0-9]+$/.test(String(cardId)) || !Number.isInteger(n) || n < 1) throw new Error('invalid run');
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

// The meta file of the agent, when its description starts with [cN], it is not a nested agent, the project is not chat-only
// and N is a task or idea of this project: { transcript, meta, cardId }; else null. The meta file can land a moment after
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
  const cardId = `c${marker[1]}`;
  if (readConfig(projectDirArg).mode === 'chat') return null;
  if (!isWorkCard(readState(projectDirArg).cards.find((c) => c.id === cardId))) return null;
  return { transcript, meta, cardId };
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
    return readConfig(projectDirArg).mode !== 'chat' && readState(projectDirArg).cards.some(isWorkCard);
  } catch {
    return false;
  }
}

// SubagentStart: when the Agent call's description starts with [cN] and N is a task or idea of this project,
// add a run to it, or reopen the run this agent already has. Returns true when a run was recorded.
// Claude Code writes the agent's meta file (its description) only after the SubagentStart hooks have returned, so the hook itself
// cannot wait for it: it starts a worker that calls this with a long retryMs. `eventAt` (ms) is when the event happened.
// The caller sets THREAD_LOCK_WAIT_MS so a busy lock never holds anything up for long.
export async function startRun(projectDirArg, input, { retryMs = META_RETRY_MS, eventAt = 0 } = {}) {
  const tracked = await trackedAgent(projectDirArg, input, retryMs);
  if (!tracked) return false;
  const { transcript, meta, cardId } = tracked;
  if (retryMs) {
    const until = Date.now() + TRANSCRIPT_WAIT_MS;
    while (!existsSync(transcript) && Date.now() < until) await sleep(META_STEP_MS);
  }
  let prompt = null;
  try { prompt = readRunActivity(transcript, 0).prompt; } catch { /* the file is not written yet */ }
  const dropped = [];
  const recorded = await updateState(projectDirArg, (state) => {
    const card = state.cards.find((c) => c.id === cardId);
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
  let late = null;   // the meta of an agent whose start was not recorded
  if (found) {
    if (readConfig(projectDirArg).mode === 'chat') return false;
  } else {
    late = await trackedAgent(projectDirArg, input, 0);
    if (!late) return false;
  }
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
      const card = state.cards.find((c) => c.id === cardId);
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

// The board's "Mark as stopped": a run that is still running and will never be closed (its session ended, or its stop event was lost).
// Only this run's state fields are written.
export async function markRunStopped(projectDirArg, cardId, n) {
  return updateState(projectDirArg, (state) => {
    const card = state.cards.find((c) => c.id === cardId);
    if (!isWorkCard(card)) throw new Error(`card ${cardId} is not a task or idea`);
    const run = Array.isArray(card.runs) ? card.runs.find((r) => r && r.n === n) : null;
    if (!run) throw new Error(`card ${cardId} has no run ${n}`);
    if (run.state !== 'running') throw new Error(`run ${n} of ${cardId} is not running`);
    run.state = 'stopped';
    run.ok = false;
    run.finishedAt = now();
    run.note = 'Marked as stopped on the board: no stop was reported for this run.';
    return { ...run, transcript: undefined };
  });
}

// ---------------------------------------------------------------- the board's reader

// What the board route returns for a run: { run, running, events, next, more, prompt?, reset?, quietMs?, gone? }. A finished run is
// read from its snapshot; a running one (or a finished one without a snapshot) from its transcript, from byte `offset`.
// The only path ever read is the one recorded on the run, and only after safeTranscript accepts it.
export function runActivity(projectDirArg, cardId, run, offset = 0) {
  const running = run.state === 'running';
  if (!running && run.snapshot === true) {
    const events = readSnapshot(projectDirArg, cardId, run.n);
    if (events) return { run: run.n, running, events, next: null, more: false };
  }
  const gone = { run: run.n, running, events: [], next: null, more: false, gone: true, quietMs: Math.max(0, Date.now() - (Date.parse(run.startedAt) || Date.now())) };
  let file = null;
  try { file = runTranscript(run); } catch { /* treated as gone */ }
  if (!file) return gone;
  try {
    return { run: run.n, running, ...readRunActivity(file, offset) };
  } catch {
    return gone;
  }
}
