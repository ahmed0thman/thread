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

// ---- hand-back parsing, step map, and the board's thread endpoints

const REPLY_WITH_MAP = [
  'Intro line.',
  '## Happened', '- read the plan', '## Decided', '- use Postgres', '## Changed', 'Nothing.', '## Open', '- one question',
  '```thread-map',
  '[{"kind":"did","text":"read the plan","ref":"PLAN.md:12"},{"kind":"bogus","text":"kind falls back"},{"text":""},{"kind":"decided","text":"use Postgres"}]',
  '```',
].join('\n');

test('parseHandback splits body, the four sections and the step map', () => {
  const v = core.parseHandback(REPLY_WITH_MAP);
  assert.equal(v.body, 'Intro line.');
  assert.equal(v.sections.happened, '- read the plan');
  assert.equal(v.sections.decided, '- use Postgres');
  assert.equal(v.sections.changed, 'Nothing.');
  assert.equal(v.sections.open, '- one question');
  assert.deepEqual(v.map, [
    { kind: 'did', text: 'read the plan', ref: 'PLAN.md:12' },
    { kind: 'did', text: 'kind falls back' },
    { kind: 'decided', text: 'use Postgres' },
  ]);
});

test('parseHandback tolerates free text, a broken map block and non-strings', () => {
  assert.deepEqual(core.parseHandback('just text').map, []);
  assert.equal(core.parseHandback('just text').body, 'just text');
  const broken = core.parseHandback('a\n## Open\n- x\n```thread-map\nnot json\n```');
  assert.deepEqual(broken.map, []);
  assert.equal(broken.sections.open, '- x');
  assert.equal(core.parseHandback(undefined).body, '');
});

test('the prompt asks for the step map on first and follow-up turns', () => {
  const card = { id: 'c1', title: 't', thread: { sessionId: null, mode: 'read', turns: [{ prompt: 'do it' }] } };
  assert.match(core.buildPrompt(card), /thread-map/);
  card.thread.sessionId = '11111111-2222-4333-8444-555555555555';
  assert.match(core.buildPrompt(card), /thread-map/);
});

async function seedFinishedThread(projectDir, result) {
  const paths = core.projectPaths(projectDir);
  fs.mkdirSync(paths.dir, { recursive: true });
  const ts = new Date().toISOString();
  fs.writeFileSync(paths.state, JSON.stringify({
    version: 1, projectDir, seq: 1,
    cards: [{
      id: 'c1', kind: 'thread', title: 'done thread', note: '', status: 'review', source: 'claude', seenByClaude: true, createdAt: ts, updatedAt: ts,
      thread: {
        parentSessionId: PARENT_SESSION, sessionId: '11111111-2222-4333-8444-555555555555', mode: 'read', runState: 'idle', pid: null,
        turns: [{ prompt: 'p', startedAt: ts, finishedAt: ts, ok: true, result, error: null }],
        lastResult: result, reported: false, announced: true,
      },
    }],
  }));
}

test('reportThread leaves the step map out of the text given to the main session', async (t) => {
  const { projectDir } = setup(t);
  await seedFinishedThread(projectDir, REPLY_WITH_MAP);
  const { text } = await core.reportThread(projectDir, 'c1');
  assert.match(text, /## Decided/);
  assert.doesNotMatch(text, /thread-map/);
});

test('the board API returns parsed views, sends a follow-up turn and ends a thread', async (t) => {
  const { projectDir } = setup(t);
  await seedFinishedThread(projectDir, REPLY_WITH_MAP);
  const { startBoardServer } = await import(path.join(path.dirname(CORE_PATH), 'http.mjs'));
  const { server, url } = await startBoardServer(projectDir, { port: 0 });
  t.after(() => new Promise((r) => server.close(r)));
  const post = (p, body, headers = { 'Content-Type': 'application/json' }) => fetch(url + p, { method: 'POST', headers, body: JSON.stringify(body) });

  const state = await (await fetch(url + 'api/state')).json();
  assert.equal(state.cards[0].thread.turns[0].view.map.length, 3);
  assert.equal(state.cards[0].thread.turns[0].view.sections.decided, '- use Postgres');
  assert.equal(JSON.parse(fs.readFileSync(core.projectPaths(projectDir).state, 'utf8')).cards[0].thread.turns[0].view, undefined, 'views are not stored');

  assert.equal((await post('api/threads/c1/messages', { message: 'more' }, {})).status, 415);
  assert.equal((await post('api/threads/c1/messages', { message: '' })).status, 400);
  assert.equal((await post('api/threads/nope/messages', { message: 'x' })).status, 400);

  const sent = await post('api/threads/c1/messages', { message: 'look again' });
  assert.equal(sent.status, 200);
  const card = await sent.json();
  assert.equal(card.thread.runState, 'running');
  assert.equal(card.thread.turns.length, 2);
  assert.equal((await post('api/threads/c1/messages', { message: 'again' })).status, 400, 'refused while running');
  await waitFor(() => core.readState(projectDir).cards[0].thread.runState === 'idle');

  const ended = await post('api/threads/c1/end', {});
  assert.equal(ended.status, 200);
  assert.equal((await ended.json()).thread.runState, 'ended');
  assert.equal((await post('api/threads/c1/messages', { message: 'x' })).status, 400, 'refused after end');
});

// ---- tool pre-approval and extra folders for headless threads

function argsCard(over = {}) {
  return { id: 'c1', title: 't', thread: { parentSessionId: PARENT_SESSION, sessionId: null, mode: 'read', turns: [{ prompt: 'p' }], ...over } };
}
function flagValues(argv, flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return null;
  const out = [];
  for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) out.push(argv[j]);
  return out;
}

test('threads pre-approve web search and fetch by default, in read and write mode', (t) => {
  setup(t);
  delete process.env.THREAD_ALLOW_TOOLS;
  assert.deepEqual(flagValues(core.buildClaudeArgs(argsCard()), '--allowedTools'), ['WebSearch', 'WebFetch']);
  assert.deepEqual(flagValues(core.buildClaudeArgs(argsCard({ mode: 'write' })), '--allowedTools'), ['WebSearch', 'WebFetch']);
  assert.deepEqual(flagValues(core.buildClaudeArgs(argsCard()), '--disallowedTools'), ['Edit', 'Write', 'NotebookEdit']);
});

test('THREAD_ALLOW_TOOLS replaces the list, "none" removes it, and a dash-led entry is dropped', (t) => {
  setup(t, { THREAD_ALLOW_TOOLS: 'none' });
  assert.equal(core.buildClaudeArgs(argsCard()).includes('--allowedTools'), false);
  process.env.THREAD_ALLOW_TOOLS = 'WebSearch, Bash(gh repo view:*) ,--dangerously-skip-permissions';
  assert.deepEqual(flagValues(core.buildClaudeArgs(argsCard()), '--allowedTools'), ['WebSearch', 'Bash(gh repo view:*)']);
  process.env.THREAD_ALLOW_TOOLS = '${user_config.allow}';
  assert.deepEqual(flagValues(core.buildClaudeArgs(argsCard()), '--allowedTools'), ['WebSearch', 'WebFetch']);
});

test('extra folders are validated at start, stored, and passed as --add-dir on every turn', async (t) => {
  const { projectDir } = setup(t);
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-extra-'));
  t.after(() => fs.rmSync(extra, { recursive: true, force: true }));
  const file = path.join(extra, 'f.txt');
  fs.writeFileSync(file, 'x');
  const start = (dirs) => core.startThread(projectDir, { title: 'd', task: 'do it', sessionId: PARENT_SESSION, dirs });
  await assert.rejects(start(['relative/path']), /absolute/);
  await assert.rejects(start(['--add-dir']), /absolute/);
  await assert.rejects(start([path.join(extra, 'missing')]), /not found/);
  await assert.rejects(start([file]), /not a folder/);
  await assert.rejects(start('not-a-list'), /list/);
  await assert.rejects(start(Array.from({ length: 6 }, (_, i) => { const d = path.join(extra, `d${i}`); fs.mkdirSync(d); return d; })), /at most 5/);
  assert.equal(core.readState(projectDir).cards.length, 0, 'a rejected start creates no card');

  const logFile = path.join(extra, 'fake.log');
  process.env.FAKE_CLAUDE_LOG = logFile;
  t.after(() => { delete process.env.FAKE_CLAUDE_LOG; });
  const card = await start([extra, extra]);
  assert.deepEqual(card.thread.dirs, [path.resolve(extra)]);
  await waitFor(() => core.readState(projectDir).cards[0].thread.runState === 'idle');
  await core.continueThread(projectDir, card.id, 'again');
  await waitFor(() => core.readState(projectDir).cards[0].thread.runState === 'idle');
  const runs = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(runs.length, 2);
  for (const r of runs) assert.deepEqual(flagValues(r.argv, '--add-dir'), [path.resolve(extra)]);
  assert.equal(runs[1].argv.includes('--fork-session'), false);
});

test('a thread started without extra folders passes no --add-dir', (t) => {
  setup(t);
  assert.equal(core.buildClaudeArgs(argsCard()).includes('--add-dir'), false);
  assert.equal(core.buildClaudeArgs(argsCard({ dirs: [] })).includes('--add-dir'), false);
});

test('a reported thread whose follow-up fails stays reported; one whose follow-up succeeds becomes not reported', async (t) => {
  const { projectDir } = setup(t);
  const card = await core.startThread(projectDir, { title: 'r', task: 'do it', sessionId: PARENT_SESSION });
  const th = () => core.readState(projectDir).cards[0].thread;
  await waitFor(() => th().runState === 'idle');
  await core.reportThread(projectDir, card.id);
  assert.equal(th().reported, true);

  process.env.FAKE_CLAUDE_MODE = 'fail';
  await core.continueThread(projectDir, card.id, 'new instruction that fails');
  await waitFor(() => th().runState === 'failed');
  assert.equal(th().reported, true, 'nothing new to report after a failed follow-up');

  delete process.env.FAKE_CLAUDE_MODE;
  await core.continueThread(projectDir, card.id, 'new instruction that works');
  await waitFor(() => th().runState === 'idle' && th().turns.length === 3);
  assert.equal(th().reported, false, 'the new result has not been reported');
  assert.equal(th().announced, false, 'and the parent session will be told it finished');
});
