// thread plugin: detached process that runs one thread turn.
// usage: node runner.mjs <projectDir> <cardId>
import { spawn } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UUID_RE, activityPath, buildClaudeArgs, buildPrompt, buildRelayArgs, clip, findThread, isThread, projectPaths, readStateLocked, setRunState, tail, updateState } from './core.mjs';
import { relayPath, resumeIdOf, unusableLane } from './lanes.mjs';
import { MAX_EVENTS, MAX_TEXT, resultText, summarize } from './runs.mjs';
import { PRIVATE_FILE, mkdirPrivateSync } from './state.mjs';

const [projectDir, cardId] = process.argv.slice(2);
const bin = process.env.THREAD_CLAUDE_BIN || 'claude';
const LANE_GRACE_MS = Number(process.env.THREAD_LANE_GRACE_MS) > 0 ? Number(process.env.THREAD_LANE_GRACE_MS) : 20000;   // the runner's own limit comes this long after the relay's --timeout
const LANE_KILL_MS = 15000;    // a relay told to stop gets this long to stop its child and write its result
const MAX_LANE_EVENTS = 50 * 1024 * 1024;
const OUT_TAIL = 2000;
const timeoutMs = (() => {
  const n = Number(process.env.THREAD_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 1200000;
})();

let child = null;
let childPid = null;
let stderr = '';
let partialLine = '';   // the end of a chunk that is not a whole line yet
let outTail = '';       // bounded: only for error messages
let resultLine = null;  // newest object with a `result` field
let activityFile = null;
let events = 0;
let steps = 0;
let exitInfo = null;
let spawnError = null;
let timedOut = false;
let userEnded = false;
let missingDir = false;
let finished = false;
let finishFallback = null;
let killTimer = null;
let timeoutTimer = null;
let outStream = null;
let errStream = null;
let lane = null;        // the thread's lane while this turn runs on one: { implementer, ... }
let laneOut = null;     // that turn's relay output folder
let laneMode = 'read';   // the thread's access, for the note about files
let laneBad = '';       // why the thread's lane record cannot run (then nothing runs at all)
let laneRead = null;    // result.json, read once: { result: object or null }

// Heartbeat: core treats the runner as alive only while this file is fresh and
// names our pid, so a reused pid is never mistaken for a live runner.
function startHeartbeat(logsDir) {
  const file = join(logsDir, `${cardId}.alive`);
  const beat = () => {
    try { writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: PRIVATE_FILE }); } catch { /* ignore */ }
  };
  beat();
  setInterval(beat, 3000);
}

function killChild() {
  if (!child || exitInfo) return;
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  if (!killTimer) {
    killTimer = setTimeout(() => {
      if (child && !exitInfo) {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }, lane ? LANE_KILL_MS : 3000);
  }
}

function onTerminate() {
  userEnded = true;
  killChild();
}
process.on('SIGTERM', onTerminate);
process.on('SIGINT', onTerminate);

function writeActivity(event) {
  if (!activityFile || events > MAX_EVENTS) return;
  events += 1;
  const line = events > MAX_EVENTS ? { kind: 'truncated' } : event;
  try { appendFileSync(activityFile, JSON.stringify({ at: new Date().toISOString(), ...line }) + '\n'); } catch { /* the board's view is not worth failing the turn */ }
}

// One line of the CLI's event stream: remember a result, note what the turn did.
function onStreamLine(line) {
  let v;
  try { v = JSON.parse(line); } catch { return; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return;
  if ('result' in v) resultLine = v;
  const blocks = v.message && Array.isArray(v.message.content) ? v.message.content : [];
  const nested = v.parent_tool_use_id ? { nested: true } : {};
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (v.type === 'assistant' && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      writeActivity({ kind: 'text', text: b.text.length > MAX_TEXT ? b.text.slice(0, MAX_TEXT - 1) + '…' : b.text, ...nested });
    } else if (v.type === 'assistant' && b.type === 'tool_use') {
      steps += 1;
      writeActivity({ kind: 'tool', id: b.id, name: b.name, summary: summarize(b.input), ...nested });
    } else if (v.type === 'user' && b.type === 'tool_result') {
      writeActivity({ kind: 'tool_result', id: b.tool_use_id, ok: b.is_error !== true, preview: clip(resultText(b.content), 300), ...nested });
    }
  }
}

// Token counts from the result event; null when it carries none.
function usageOf(v) {
  const u = v && v.usage;
  if (!u || typeof u !== 'object') return null;
  const n = (x) => (Number.isFinite(x) && x >= 0 ? x : 0);
  return { input: n(u.input_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens), output: n(u.output_tokens) };
}

function onStdout(chunk) {
  if (outStream) outStream.write(chunk);
  outTail = (outTail + chunk).slice(-OUT_TAIL);
  const lines = (partialLine + chunk).split('\n');
  partialLine = lines.pop();
  for (const l of lines) onStreamLine(l);
}

// What a lane turn left in its folder: result.json, parsed once; null when it is missing or unreadable.
function laneResult() {
  if (laneRead) return laneRead.result;
  let result = null;
  try {
    const v = JSON.parse(readFileSync(join(laneOut, 'result.json'), 'utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) result = v;
  } catch { /* no result: the relay stopped before it wrote one */ }
  laneRead = { result };
  return result;
}

const firstLine = (text) => (String(text).split('\n').map((l) => l.trim()).find(Boolean) || '');
const lastLine = (lines) => (Array.isArray(lines) ? lines.map((l) => String(l).trim()).filter(Boolean).pop() || '' : '');
const MAX_FILES = 8;

// The file names in a relay's touchedFiles (git porcelain lines such as " M a.txt" or "?? b.txt"), capped.
function touchedNames(r) {
  if (!Array.isArray(r.touchedFiles)) return [];
  return r.touchedFiles.filter((l) => typeof l === 'string' && l.trim()).map((l) => clip(l.trim().replace(/^\S+\s+/, ''), 80));
}
const fileList = (names) => names.slice(0, MAX_FILES).join(', ') + (names.length > MAX_FILES ? ` and ${names.length - MAX_FILES} more` : '');

// The relays fill touchedFiles from `git status` after the run: everything uncommitted in the working tree, not only what this turn did.
const treeChanges = (names) => `Uncommitted changes in the working tree after this turn (from the relay): ${fileList(names)}.`;

// One plain line about files, from what the relay reported: a read-only turn that may have changed files (true, or null for a
// provider whose read-only mode is only a tripwire), or the working tree's uncommitted files after a write turn. '' when there is nothing to say.
function filesNote(r, who) {
  const names = touchedNames(r);
  if (laneMode === 'read') {
    if (r.readOnlyViolation === true || (r.readOnlyViolation === null && 'readOnlyViolation' in r)) {
      return `Note: ${who} reported that it may have changed files during this read-only turn.${names.length ? ' ' + treeChanges(names) : ''} Check the working tree.`;
    }
    return '';
  }
  return names.length ? treeChanges(names) : '';
}

// The last failure message a provider wrote into its events.jsonl, for a result that gives no reason of its own (a codex run with a bad
// model has no error and an empty stderrTail). codex: turn.failed, else the last top-level error event; opencode: an error event;
// claude: a result event with is_error. A message that is itself a JSON error body is reduced to its inner message. '' when there is none.
function eventsFailure(who) {
  try {
    const file = join(laneOut, 'events.jsonl');
    if (statSync(file).size > MAX_LANE_EVENTS) return '';
    let failed = '', errored = '';
    for (const l of readFileSync(file, 'utf8').split('\n')) {
      let e;
      try { e = JSON.parse(l); } catch { continue; }
      if (!e || typeof e !== 'object') continue;
      if (who === 'codex') {
        if (e.type === 'turn.failed') failed = eventMessage(e.error) || failed;
        else if (e.type === 'error') errored = eventMessage(e) || errored;
      } else if (who === 'opencode') {
        if (e.type === 'error') errored = eventMessage(e.error && e.error.data) || eventMessage(e.error) || eventMessage(e) || (e.error && typeof e.error.name === 'string' ? e.error.name : '') || errored;
      } else if (who === 'claude') {
        if (e.type === 'result' && e.is_error === true) failed = eventMessage({ message: e.result }) || (typeof e.subtype === 'string' ? e.subtype : '') || failed;
      }
    }
    return firstLine(failed || errored);
  } catch { return ''; }
}

// A message string from an event object; a JSON error body ({"error":{"message":...}}) gives its inner message.
function eventMessage(o) {
  let m = o && typeof o === 'object' && typeof o.message === 'string' ? o.message : '';
  if (!m.trim()) return '';
  try {
    const j = JSON.parse(m);
    const inner = j && typeof j === 'object' ? (j.error && typeof j.error.message === 'string' ? j.error.message : typeof j.message === 'string' ? j.message : '') : '';
    if (inner.trim()) m = inner;
  } catch { /* plain text */ }
  return m.trim();
}

// A turn's error from a result that is not "completed": its status, then the relay's own error, else the last line of the provider's
// stderr tail, else the last failure the provider wrote into its events, else the first line the relay itself printed.
// Never anything from the provider's log file.
function failureError(r, who, detail) {
  const status = typeof r.status === 'string' ? r.status : 'unknown';
  const why = typeof r.error === 'string' && r.error.trim() ? firstLine(r.error) : lastLine(r.stderrTail) || eventsFailure(who) || detail;
  return status === 'timeout' ? `${who} timed out${why ? ': ' + tail(why, 300) : ''}` : `${who} ${status}${why ? ': ' + tail(why, 300) : ''}`;
}

// A claude lane's events.jsonl is the stream the plugin already reads: it gives the turn its steps and token use.
function feedLaneEvents() {
  try {
    const file = join(laneOut, 'events.jsonl');
    if (statSync(file).size > MAX_LANE_EVENTS) return;
    for (const l of readFileSync(file, 'utf8').split('\n')) onStreamLine(l);
  } catch { /* no events: the turn has no trace */ }
}

// Tokens of the turn: the result event's usage, else the relay's own result.json. Never both.
function turnUsage() {
  const fromEvents = usageOf(resultLine);
  if (fromEvents || !lane || lane.implementer !== 'claude') return fromEvents;
  return usageOf({ usage: (laneResult() || {}).usage });
}

function laneOutcome() {
  const r = laneResult();
  const who = lane.implementer;
  const detail = firstLine(stderr);
  if (!r) return { ok: false, error: `the ${who} relay exited with code ${exitInfo.code}${exitInfo.signal ? ` (${exitInfo.signal})` : ''} and wrote no result${detail ? ': ' + tail(detail, 300) : ''}` };
  const note = filesNote(r, who);
  if (r.status === 'completed') {
    const text = typeof r.finalMessage === 'string' ? r.finalMessage.trim() : '';
    // A provider may finish without a written report (agy can): the turn still succeeded.
    const body = text || `${who} finished the turn without a written report.`;
    return { ok: true, result: note ? `${note}\n\n${body}` : body };
  }
  const error = failureError(r, who, detail);
  return { ok: false, error: note ? `${error} ${note}` : error };
}

// The relay's own summary: kept in the log, and its end for an error message. Lane events are read from the folder, not from here.
function onRelayStdout(chunk) {
  if (outStream) outStream.write(chunk);
  outTail = (outTail + chunk).slice(-OUT_TAIL);
}

function computeOutcome(crash) {
  if (crash) return { ok: false, error: `runner error: ${tail(crash && crash.message ? crash.message : crash, 300)}` };
  if (userEnded) return { ok: false, error: 'ended by user' };
  if (missingDir) return { ok: false, error: `project folder not found: ${projectDir}` };
  if (laneBad) return { ok: false, error: `this thread's lane cannot run: ${laneBad}. Start a new thread instead.` };
  if (spawnError) {
    if (lane) return { ok: false, error: `could not start the ${lane.implementer} relay: ${tail(spawnError.message, 300)}` };
    if (spawnError.code === 'ENOENT') {
      return {
        ok: false,
        error: bin === 'claude' ? 'claude CLI not found on PATH' : `claude CLI not found: ${bin}`,
      };
    }
    return { ok: false, error: `could not start ${bin}: ${tail(spawnError.message, 300)}` };
  }
  if (timedOut) return { ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s` };
  if (!exitInfo) return { ok: false, error: 'runner stopped before the child exited' };
  if (lane) return laneOutcome();
  const detail = tail(stderr) || tail(outTail);
  if (exitInfo.signal) {
    return { ok: false, error: `killed by signal ${exitInfo.signal}${detail ? ': ' + detail : ''}` };
  }
  if (exitInfo.code !== 0) {
    return { ok: false, error: `exit code ${exitInfo.code}${detail ? ': ' + detail : ''}` };
  }
  const parsed = resultLine;
  if (!parsed) return { ok: false, error: `could not parse output as JSON: ${tail(outTail) || '(empty)'}` };
  if (parsed.is_error === true) {
    return { ok: false, error: `claude reported an error: ${tail(typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed))}` };
  }
  if (typeof parsed.result !== 'string' || !parsed.result.trim()) {
    return { ok: false, error: 'claude returned an empty result' };
  }
  return {
    ok: true,
    result: parsed.result,
    sessionId: typeof parsed.session_id === 'string' && UUID_RE.test(parsed.session_id) ? parsed.session_id : null,
  };
}

function endStream(s) {
  return new Promise((resolve) => {
    if (!s) return resolve();
    s.on('error', () => resolve());
    try { s.end(resolve); } catch { resolve(); }
  });
}

async function record(outcome) {
  const apply = (state) => {
    const card = state.cards.find((c) => c.id === cardId);
    if (!isThread(card)) return;
    const th = card.thread;
    const turn = th.turns[th.turns.length - 1];
    const ts = new Date().toISOString();
    const ended = th.runState === 'ended';
    if (turn) {
      turn.finishedAt = ts;
      turn.ok = outcome.ok;
      turn.result = outcome.ok ? outcome.result : null;
      turn.error = outcome.ok ? null : outcome.error;
      turn.steps = steps;
      const usage = turnUsage();
      if (usage) turn.usage = usage;
    }
    // The provider's id to continue with, kept on a failed turn too.
    const session = lane ? resumeIdOf(lane.implementer, laneResult()) : null;
    if (session && th.lane) th.lane.session = session;
    if (outcome.ok) {
      if (outcome.sessionId) th.sessionId = outcome.sessionId;
      th.lastResult = outcome.result;
      th.reported = false;
    }
    th.pid = null;
    if (ended) card.updatedAt = ts;
    else setRunState(projectDir, card, outcome.ok ? 'idle' : 'failed');
  };
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await updateState(projectDir, apply);
      return true;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  process.stderr.write(`thread runner: could not record result for ${cardId}: ${lastErr && lastErr.message}\n`);
  return false;
}

async function finish(crash) {
  if (finished) return;
  finished = true;
  clearTimeout(timeoutTimer);
  clearTimeout(killTimer);
  clearTimeout(finishFallback);
  let recorded = false;
  try {
    onStreamLine(partialLine); // a result line the CLI did not end with a newline
    if (lane && lane.implementer === 'claude') feedLaneEvents();
    recorded = await record(computeOutcome(crash));
  } catch (e) {
    process.stderr.write(`thread runner: ${e && e.message}\n`);
  }
  try {
    await Promise.race([
      Promise.all([endStream(outStream), endStream(errStream)]),
      new Promise((r) => setTimeout(r, 1000)),
    ]);
  } catch { /* ignore */ }
  process.exit(recorded ? 0 : 1);
}

process.on('uncaughtException', (e) => { finish(e); });
process.on('unhandledRejection', (e) => { finish(e instanceof Error ? e : new Error(String(e))); });

async function main() {
  if (!projectDir || !cardId) {
    process.stderr.write('usage: runner.mjs <projectDir> <cardId>\n');
    process.exit(2);
  }
  let card;
  try {
    card = findThread(await readStateLocked(projectDir), cardId);
  } catch (e) {
    process.stderr.write(`thread runner: ${e.message}\n`);
    process.exit(1);
  }
  if (card.thread.runState !== 'running') process.exit(0); // ended before it began

  const paths = projectPaths(projectDir);
  try {
    mkdirPrivateSync(paths.logs);
    startHeartbeat(paths.logs);
    outStream = createWriteStream(join(paths.logs, `${cardId}.out`), { flags: 'a', mode: PRIVATE_FILE });
    errStream = createWriteStream(join(paths.logs, `${cardId}.err`), { flags: 'a', mode: PRIVATE_FILE });
    outStream.on('error', () => {});
    errStream.on('error', () => {});
    const activity = activityPath(projectDir, cardId, card.thread.turns.length);
    writeFileSync(activity, '', { mode: PRIVATE_FILE }); // a rerun of this turn starts clean
    activityFile = activity;
    const header = `--- turn ${card.thread.turns.length} ${new Date().toISOString()} ---\n`;
    outStream.write(header);
    errStream.write(header);
  } catch { /* logging is best effort */ }

  const prompt = buildPrompt(card);
  // A lane record that is present but unusable must never fall through to running claude.
  const tl = card.thread.lane;
  if (tl != null) {
    laneBad = unusableLane(tl);
    if (laneBad) return finish();
    lane = tl;
    laneMode = card.thread.mode === 'write' ? 'write' : 'read';
  }
  let cmd = bin;
  let args;
  if (lane) {
    // The prompt goes to the relay in a file next to the logs, so it never shows in a process list.
    const turnNo = card.thread.turns.length;
    laneOut = join(paths.logs, `${cardId}.t${turnNo}.lane`);
    const briefFile = join(paths.logs, `${cardId}.t${turnNo}.brief.txt`);
    try {
      rmSync(laneOut, { recursive: true, force: true });
      mkdirPrivateSync(laneOut);
      writeFileSync(briefFile, prompt, { mode: PRIVATE_FILE });
    } catch (e) {
      spawnError = e;
      return finish();
    }
    cmd = process.execPath;
    args = [relayPath(lane.implementer), ...buildRelayArgs(projectDir, card, { brief: briefFile, outDir: laneOut, timeoutMs })];
    if (!existsSync(args[0])) {
      spawnError = new Error(`${args[0]} was not found`);
      return finish();
    }
  } else args = buildClaudeArgs(card);

  if (userEnded) return finish();

  // spawn reports a missing cwd as ENOENT, which would read as "claude CLI not found".
  let dirOk = false;
  try { dirOk = statSync(projectDir).isDirectory(); } catch { /* missing */ }
  if (!dirOk) {
    missingDir = true;
    return finish();
  }

  try {
    // THREAD_DEPTH marks a thread's own process; the relay passes it on to a claude child, so this plugin's hooks leave that session alone.
    child = spawn(cmd, args, {
      cwd: projectDir,
      env: { ...process.env, THREAD_DEPTH: '1' },
      stdio: [lane ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    spawnError = e;
    return finish();
  }
  childPid = child.pid ?? null;

  child.on('error', (e) => {
    if (childPid == null) {
      spawnError = e; // never started
      finish();
    }
  });
  if (child.stdin) child.stdin.on('error', () => {}); // EPIPE if the child exits before reading
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', lane ? onRelayStdout : onStdout);
  child.stderr.on('data', (d) => { stderr += d; if (errStream) errStream.write(d); });
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
    clearTimeout(killTimer);
    // 'close' normally follows; if a grandchild holds the pipes open, stop waiting.
    finishFallback = setTimeout(() => { finish(); }, 1000);
  });
  child.on('close', () => { finish(); });

  if (!lane) {
    try {
      child.stdin.end(prompt);
    } catch { /* EPIPE handled by the error listener */ }
  }

  timeoutTimer = setTimeout(() => {
    timedOut = true;
    killChild();
  }, lane ? timeoutMs + LANE_GRACE_MS : timeoutMs);

  if (userEnded) killChild();
}

main().catch((e) => { finish(e); });
