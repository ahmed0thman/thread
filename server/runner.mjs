// thread plugin: detached process that runs one thread turn.
// usage: node runner.mjs <projectDir> <cardId>
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildClaudeArgs, buildPrompt, projectPaths, readStateLocked, updateState } from './core.mjs';

const [projectDir, cardId] = process.argv.slice(2);
const bin = process.env.THREAD_CLAUDE_BIN || 'claude';
const timeoutMs = (() => {
  const n = Number(process.env.THREAD_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 1200000;
})();

let child = null;
let childPid = null;
let stdout = '';
let stderr = '';
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const tail = (s, n = 500) => {
  const t = oneLine(s);
  return t.length > n ? t.slice(-n) : t;
};

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

function parseResult(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const tryParse = (s) => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === 'object' && !Array.isArray(v) && 'result' in v ? v : null;
    } catch {
      return null;
    }
  };
  for (let i = lines.length - 1; i >= 0; i--) {
    const v = tryParse(lines[i]);
    if (v) return v;
  }
  return tryParse(text.trim()); // pretty-printed multi-line JSON
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
  const detail = tail(stderr) || tail(stdout);
  if (exitInfo.signal) {
    return { ok: false, error: `killed by signal ${exitInfo.signal}${detail ? ': ' + detail : ''}` };
  }
  if (exitInfo.code !== 0) {
    return { ok: false, error: `exit code ${exitInfo.code}${detail ? ': ' + detail : ''}` };
  }
  const parsed = parseResult(stdout);
  if (!parsed) return { ok: false, error: `could not parse output as JSON: ${tail(stdout) || '(empty)'}` };
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
    if (!card || card.kind !== 'thread' || !card.thread) return;
    const th = card.thread;
    const turn = th.turns[th.turns.length - 1];
    const ts = new Date().toISOString();
    const ended = th.runState === 'ended';
    if (turn) {
      turn.finishedAt = ts;
      turn.ok = outcome.ok;
      turn.result = outcome.ok ? outcome.result : null;
      turn.error = outcome.ok ? null : outcome.error;
    }
    if (outcome.ok) {
      if (outcome.sessionId) th.sessionId = outcome.sessionId;
      th.lastResult = outcome.result;
      th.reported = false;
    }
    th.pid = null;
    if (!ended) {
      th.runState = outcome.ok ? 'idle' : 'failed';
      card.status = outcome.ok ? 'review' : 'blocked';
    }
    card.updatedAt = ts;
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
  const state = await readStateLocked(projectDir);
  const card = state.cards.find((c) => c.id === cardId);
  if (!card || card.kind !== 'thread' || !card.thread) {
    process.stderr.write(`thread runner: no thread card ${cardId}\n`);
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
  child.stdout.on('data', (d) => { stdout += d; if (outStream) outStream.write(d); });
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
