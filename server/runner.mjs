// thread plugin: detached process that runs one thread turn.
// usage: node runner.mjs <projectDir> <cardId>
import { spawn } from 'node:child_process';
import { appendFileSync, createWriteStream, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UUID_RE, activityPath, buildClaudeArgs, buildPrompt, clip, findThread, isThread, projectPaths, readStateLocked, setRunState, tail, updateState } from './core.mjs';

const [projectDir, cardId] = process.argv.slice(2);
const bin = process.env.THREAD_CLAUDE_BIN || 'claude';
const MAX_EVENTS = 1000;
const MAX_TEXT = 4000;
const OUT_TAIL = 2000;
const SUMMARY_KEYS = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'description', 'prompt'];
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

// Heartbeat: core treats the runner as alive only while this file is fresh and
// names our pid, so a reused pid is never mistaken for a live runner.
function startHeartbeat(logsDir) {
  const file = join(logsDir, `${cardId}.alive`);
  const beat = () => {
    try { writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() })); } catch { /* ignore */ }
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
    }, 3000);
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

function summarize(input) {
  const src = input && typeof input === 'object' ? input : {};
  const key = SUMMARY_KEYS.find((k) => typeof src[k] === 'string' && src[k].trim());
  return key ? clip(src[key], 300) : clip(JSON.stringify(src), 200);
}

function resultText(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join(' ') : '';
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

function computeOutcome(crash) {
  if (crash) return { ok: false, error: `runner error: ${tail(crash && crash.message ? crash.message : crash, 300)}` };
  if (userEnded) return { ok: false, error: 'ended by user' };
  if (missingDir) return { ok: false, error: `project folder not found: ${projectDir}` };
  if (spawnError) {
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
      const usage = usageOf(resultLine);
      if (usage) turn.usage = usage;
    }
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
    mkdirSync(paths.logs, { recursive: true });
    startHeartbeat(paths.logs);
    outStream = createWriteStream(join(paths.logs, `${cardId}.out`), { flags: 'a' });
    errStream = createWriteStream(join(paths.logs, `${cardId}.err`), { flags: 'a' });
    outStream.on('error', () => {});
    errStream.on('error', () => {});
    const activity = activityPath(projectDir, cardId, card.thread.turns.length);
    writeFileSync(activity, ''); // a rerun of this turn starts clean
    activityFile = activity;
    const header = `--- turn ${card.thread.turns.length} ${new Date().toISOString()} ---\n`;
    outStream.write(header);
    errStream.write(header);
  } catch { /* logging is best effort */ }

  const args = buildClaudeArgs(card);
  const prompt = buildPrompt(card);

  if (userEnded) return finish();

  // spawn reports a missing cwd as ENOENT, which would read as "claude CLI not found".
  let dirOk = false;
  try { dirOk = statSync(projectDir).isDirectory(); } catch { /* missing */ }
  if (!dirOk) {
    missingDir = true;
    return finish();
  }

  try {
    child = spawn(bin, args, {
      cwd: projectDir,
      env: { ...process.env, THREAD_DEPTH: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
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
  child.stdin.on('error', () => {}); // EPIPE if the child exits before reading
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', onStdout);
  child.stderr.on('data', (d) => { stderr += d; if (errStream) errStream.write(d); });
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
    clearTimeout(killTimer);
    // 'close' normally follows; if a grandchild holds the pipes open, stop waiting.
    finishFallback = setTimeout(() => { finish(); }, 1000);
  });
  child.on('close', () => { finish(); });

  try {
    child.stdin.end(prompt);
  } catch { /* EPIPE handled by the error listener */ }

  timeoutTimer = setTimeout(() => {
    timedOut = true;
    killChild();
  }, timeoutMs);

  if (userEnded) killChild();
}

main().catch((e) => { finish(e); });
