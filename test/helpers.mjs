// Shared test helpers. node:* only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(TEST_DIR, '..');
export const FAKE_CLAUDE = path.join(TEST_DIR, 'fake-claude.mjs');
export const SERVER_DIR = path.join(ROOT, 'server');
export const CORE_PATH = path.join(SERVER_DIR, 'core.mjs');
export const MCP_PATH = path.join(SERVER_DIR, 'mcp.mjs');
export const HOOK_PATH = path.join(ROOT, 'scripts', 'hook.mjs');

export const PARENT_SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export const THREAD_SESSION = '11111111-2222-4333-8444-555555555555';

/** Remove environment that would change behaviour when the suite runs inside a Claude session. */
export function cleanAmbientEnv() {
  for (const k of ['THREAD_DEPTH', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_DATA', 'THREAD_PROJECT_DIR', 'THREAD_NO_HTTP', 'THREAD_TIMEOUT_MS', 'FAKE_CLAUDE_MODE', 'FAKE_CLAUDE_DELAY_MS']) {
    delete process.env[k];
  }
}

/** Fresh temp data dir and project dir. */
export function tmpEnv() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-test-'));
  const dataDir = path.join(base, 'data');
  const projectDir = path.join(base, 'project');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(projectDir);
  return { base, dataDir, projectDir, logFile: path.join(base, 'fake.log'), pidFile: path.join(base, 'fake.pids') };
}

export async function waitFor(fn, { timeout = 8000, interval = 50 } = {}) {
  const start = Date.now();
  let lastErr;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() - start > timeout) {
      throw new Error(`waitFor timed out after ${timeout}ms: ${fn.toString().slice(0, 200)}${lastErr ? ' (last error: ' + lastErr.message + ')' : ''}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function killQuiet(pid, sig = 'SIGKILL') {
  try { process.kill(pid, sig); } catch { /* already gone */ }
}

/** Kill runner pids recorded in any state file under dataDir and fake CLI pids from the pid file. */
function killLeftovers(env) {
  const projects = path.join(env.dataDir, 'projects');
  try {
    for (const d of fs.readdirSync(projects)) {
      try {
        const st = JSON.parse(fs.readFileSync(path.join(projects, d, 'state.json'), 'utf8'));
        for (const c of st.cards || []) {
          const pid = c.thread && c.thread.pid;
          if (pid && pid !== process.pid) killQuiet(pid);
        }
      } catch { /* unreadable state is fine in cleanup */ }
    }
  } catch { /* no projects dir */ }
  try {
    for (const line of fs.readFileSync(env.pidFile, 'utf8').split('\n')) {
      const pid = parseInt(line, 10);
      if (pid && pid !== process.pid) killQuiet(pid);
    }
  } catch { /* no pid file */ }
}

/**
 * Create temp dirs and set THREAD_DATA_DIR / THREAD_CLAUDE_BIN / FAKE_CLAUDE_LOG (+ pid file) in
 * process.env for the duration of the test `t`. Restores env, kills leftovers and removes the temp dirs afterwards.
 * `extra` is a map of additional env vars (undefined deletes).
 */
export function setupThreadEnv(t, extra = {}) {
  const env = tmpEnv();
  const wanted = {
    THREAD_DATA_DIR: env.dataDir,
    THREAD_CLAUDE_BIN: FAKE_CLAUDE,
    FAKE_CLAUDE_LOG: env.logFile,
    FAKE_CLAUDE_PIDFILE: env.pidFile,
    ...extra,
  };
  const saved = {};
  for (const [k, v] of Object.entries(wanted)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const out = {
    ...env,
    readLog: () => readFakeLog(env.logFile),
    /** Set or delete further env vars, restored at the end of the test. */
    setEnv(k, v) {
      if (!(k in saved)) saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    },
  };
  t.after(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    killLeftovers(env);
    await sleep(50);
    fs.rmSync(env.base, { recursive: true, force: true });
  });
  return out;
}

/** Parse the fake CLI's log: one object per invocation { argv, prompt, cwd, depth }. */
export function readFakeLog(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** State file path derived from the contract formula, independent of core.mjs. */
export function statePathFor(dataDir, projectDir) {
  const h = crypto.createHash('sha1').update(projectDir).digest('hex').slice(0, 12);
  return path.join(dataDir, 'projects', h, 'state.json');
}

export function writeStateFile(dataDir, projectDir, state) {
  const p = statePathFor(dataDir, projectDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
  return p;
}

/** A contract-shaped thread card for hand-written states. */
export function threadCard(over = {}, threadOver = {}) {
  const now = new Date().toISOString();
  return {
    id: 'c1',
    kind: 'thread',
    title: 'Side job',
    note: '',
    status: 'review',
    source: 'claude',
    seenByClaude: true,
    createdAt: now,
    updatedAt: now,
    thread: {
      parentSessionId: PARENT_SESSION,
      sessionId: THREAD_SESSION,
      mode: 'read',
      runState: 'idle',
      pid: null,
      turns: [{ prompt: 'p', startedAt: now, finishedAt: now, ok: true, result: 'done\n## Happened\nx', error: null }],
      lastResult: 'done\n## Happened\nx',
      reported: false,
      announced: false,
      ...threadOver,
    },
    ...over,
  };
}

export function emptyState(projectDir, cards = []) {
  return { version: 1, projectDir, seq: cards.length, cards };
}

/** Run `node args...` and collect output. */
export function runNode(args, { env = process.env, input, cwd, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`process timed out: node ${args.join(' ')}`));
    }, timeout);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    child.stdin.on('error', () => {});
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}
