// Regression tests for defects found in review: lock stealing, liveness by pid
// alone, reports after a failed turn, and thread tools inside a side thread.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CORE_PATH, FAKE_CLAUDE, PARENT_SESSION, waitFor, isAlive } from './helpers.mjs';

delete process.env.THREAD_DEPTH;
delete process.env.CLAUDE_CODE_SESSION_ID;
const core = await import(CORE_PATH);

function setup(t, extra = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-regress-'));
  const dataDir = path.join(base, 'data');
  const projectDir = path.join(base, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  const keys = ['THREAD_DATA_DIR', 'THREAD_CLAUDE_BIN', 'THREAD_LOCK_WAIT_MS', 'THREAD_DEPTH', 'FAKE_CLAUDE_MODE', 'FAKE_CLAUDE_DELAY_MS', 'THREAD_TIMEOUT_MS', ...Object.keys(extra)];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { THREAD_DATA_DIR: dataDir, THREAD_CLAUDE_BIN: FAKE_CLAUDE, ...extra });
  t.after(() => {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { dataDir, projectDir, paths: core.projectPaths(projectDir) };
}

function plantStaleLock(paths, { nonEmpty = false } = {}) {
  fs.mkdirSync(paths.lock, { recursive: true });
  if (nonEmpty) fs.writeFileSync(path.join(paths.lock, 'owner-dead'), '');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(paths.lock, old, old);
}

function runAddCard(env, projectDir) {
  return new Promise((resolve, reject) => {
    const code = `import(${JSON.stringify(CORE_PATH)}).then((m) => m.addCard(${JSON.stringify(projectDir)}, { title: 'x' })).then((c) => console.log(c.id)).catch((e) => { console.error(e.message); process.exit(1); });`;
    const p = spawn(process.execPath, ['-e', code], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (c) => (c === 0 ? resolve(out.trim()) : reject(new Error(err || `exit ${c}`))));
  });
}

test('a stale lock that still holds an owner file does not block updateState', async (t) => {
  const { projectDir, paths } = setup(t);
  fs.mkdirSync(paths.dir, { recursive: true });
  plantStaleLock(paths, { nonEmpty: true });
  const t0 = Date.now();
  const card = await core.addCard(projectDir, { title: 'after stale lock' });
  assert.equal(card.id, 'c1');
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  assert.equal(fs.existsSync(paths.lock), false, 'lock is released');
});

test('a fresh lock held by someone else makes updateState fail at the deadline instead of spinning', async (t) => {
  const { projectDir, paths } = setup(t, { THREAD_LOCK_WAIT_MS: '300' });
  fs.mkdirSync(paths.lock, { recursive: true });
  fs.writeFileSync(path.join(paths.lock, 'owner-other'), '');
  const t0 = Date.now();
  await assert.rejects(core.addCard(projectDir, { title: 'x' }), /could not acquire state lock/);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  assert.equal(fs.existsSync(path.join(paths.lock, 'owner-other')), true, 'the other holder keeps its lock');
});

test('many processes racing to steal a stale lock never lose a card or reuse an id', async (t) => {
  const { dataDir, projectDir, paths } = setup(t);
  fs.mkdirSync(paths.dir, { recursive: true });
  const env = { ...process.env, THREAD_DATA_DIR: dataDir };
  let expected = 0;
  for (let trial = 0; trial < 8; trial++) {
    plantStaleLock(paths, { nonEmpty: trial % 2 === 0 });
    const ids = await Promise.all(Array.from({ length: 12 }, () => runAddCard(env, projectDir)));
    expected += 12;
    assert.equal(new Set(ids).size, 12, `trial ${trial}: duplicate ids ${ids.join(',')}`);
    assert.equal(core.readState(projectDir).cards.length, expected, `trial ${trial}: a card was lost`);
  }
});

function runningThreadState(projectDir, pid, startedAt) {
  const ts = new Date().toISOString();
  return {
    version: 1, projectDir, seq: 1,
    cards: [{
      id: 'c1', kind: 'thread', title: 'orphan', note: '', status: 'in_progress', source: 'claude', seenByClaude: true,
      createdAt: ts, updatedAt: ts,
      thread: {
        parentSessionId: PARENT_SESSION, sessionId: null, mode: 'read', runState: 'running', pid,
        turns: [{ prompt: 'p', startedAt, finishedAt: null, ok: null, result: null, error: null }],
        lastResult: null, reported: false, announced: false,
      },
    }],
  };
}

test('a running thread whose pid now belongs to an unrelated process is failed, and endThread does not kill that process', async (t) => {
  const { projectDir, paths } = setup(t);
  const bystander = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => { try { bystander.kill('SIGKILL'); } catch { /* gone */ } });
  fs.mkdirSync(paths.dir, { recursive: true });
  const old = new Date(Date.now() - 120000).toISOString();

  fs.writeFileSync(paths.state, JSON.stringify(runningThreadState(projectDir, bystander.pid, old)));
  const state = await core.reconcile(projectDir);
  assert.equal(state.cards[0].thread.runState, 'failed');

  fs.writeFileSync(paths.state, JSON.stringify(runningThreadState(projectDir, bystander.pid, old)));
  const card = await core.endThread(projectDir, 'c1');
  assert.equal(card.thread.runState, 'ended');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(isAlive(bystander.pid), true, 'the unrelated process must survive');
});

test('the runner writes a heartbeat naming its pid, and a long turn stays running past the grace period check', async (t) => {
  const { projectDir, paths } = setup(t, { FAKE_CLAUDE_MODE: 'slow', FAKE_CLAUDE_DELAY_MS: '1500' });
  const card = await core.startThread(projectDir, { title: 'hb', task: 'do it', sessionId: PARENT_SESSION });
  const file = path.join(paths.logs, `${card.id}.alive`);
  await waitFor(() => fs.existsSync(file));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, card.thread.pid);
  const mid = await core.reconcile(projectDir);
  assert.equal(mid.cards[0].thread.runState, 'running');
  await waitFor(() => core.readState(projectDir).cards[0].thread.runState === 'idle');
});

test('reportThread after a failed follow-up says the newest turn failed', async (t) => {
  const { projectDir } = setup(t);
  const card = await core.startThread(projectDir, { title: 'r', task: 'do it', sessionId: PARENT_SESSION });
  await waitFor(() => core.readState(projectDir).cards[0].thread.runState === 'idle');
  process.env.FAKE_CLAUDE_MODE = 'fail';
  await core.continueThread(projectDir, card.id, 'again');
  await waitFor(() => core.readState(projectDir).cards[0].thread.runState === 'failed');
  const { text } = await core.reportThread(projectDir, card.id);
  assert.match(text, /newest turn of thread c1 failed/);
  assert.match(text, /## Happened/);
});

test('inside a side thread, continueThread and endThread are refused', async (t) => {
  const { projectDir } = setup(t);
  const card = await core.startThread(projectDir, { title: 'd', task: 'do it', sessionId: PARENT_SESSION });
  await waitFor(() => core.readState(projectDir).cards[0].thread.runState === 'idle');
  process.env.THREAD_DEPTH = '1';
  await assert.rejects(core.continueThread(projectDir, card.id, 'more'), /side thread cannot/);
  await assert.rejects(core.endThread(projectDir, card.id), /side thread cannot/);
});
