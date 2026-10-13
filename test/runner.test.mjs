import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  setupThreadEnv, waitFor, sleep, isAlive, cleanAmbientEnv, writeStateFile, emptyState, threadCard,
  PARENT_SESSION, THREAD_SESSION,
} from './helpers.mjs';
import * as core from '../server/core.mjs';

cleanAmbientEnv();

const TASK = 'investigate-the-zebra-crossing-bug';
const thread = (dir, id = 'c1') => core.readState(dir).cards.find((c) => c.id === id)?.thread;
const card = (dir, id = 'c1') => core.readState(dir).cards.find((c) => c.id === id);
const start = (e, over = {}) => core.startThread(e.projectDir, { title: 'Side job', task: TASK, sessionId: PARENT_SESSION, ...over });
const untilState = (e, runState, id = 'c1', timeout = 8000) =>
  waitFor(() => thread(e.projectDir, id)?.runState === runState, { timeout });

test('startThread returns a running thread card, then the turn finishes idle with status review and the digest', async (t) => {
  const e = setupThreadEnv(t);
  const c = await start(e);
  assert.equal(c.id, 'c1');
  assert.equal(c.kind, 'thread');
  assert.equal(c.status, 'in_progress');
  assert.equal(c.thread.runState, 'running');
  assert.equal(c.thread.parentSessionId, PARENT_SESSION);
  assert.equal(c.thread.mode, 'read');
  assert.equal(c.thread.sessionId, null);
  assert.equal(c.thread.turns.length, 1);

  await untilState(e, 'idle');
  const done = card(e.projectDir);
  assert.equal(done.status, 'review');
  assert.equal(done.thread.sessionId, THREAD_SESSION);
  assert.ok(done.thread.lastResult.includes('## Happened'));
  assert.equal(done.thread.pid, null);
  assert.equal(done.thread.turns[0].ok, true);
  assert.ok(done.thread.turns[0].finishedAt);
  assert.equal(done.thread.reported, false);
  assert.equal(done.thread.announced, false);
});

test('first turn argv, stdin prompt, depth and cwd match the contract (read mode, full context)', async (t) => {
  const e = setupThreadEnv(t);
  await start(e, { context: 'full' });
  await untilState(e, 'idle');
  const log = e.readLog();
  assert.equal(log.length, 1);
  const { argv, prompt, cwd, depth } = log[0];
  assert.ok(argv.includes('-p'));
  const ri = argv.indexOf('--resume');
  assert.ok(ri >= 0 && argv[ri + 1] === PARENT_SESSION, `--resume <parent id> in ${argv}`);
  assert.ok(argv.includes('--fork-session'));
  assert.equal(argv[0], '-p');
  const oi = argv.indexOf('--output-format');
  assert.ok(oi >= 0 && argv[oi + 1] === 'stream-json');
  assert.ok(argv.includes('--verbose'), '--verbose is required with stream-json in print mode');
  const di = argv.indexOf('--disallowedTools');
  assert.ok(di >= 0 && argv.slice(di + 1, di + 4).join(' ') === 'Edit Write NotebookEdit', `disallowedTools in ${argv}`);
  assert.ok(prompt.includes(TASK), 'prompt on stdin has the task');
  for (const h of ['## Happened', '## Decided', '## Changed', '## Open']) assert.ok(prompt.includes(h), h);
  assert.ok(prompt.includes('[side thread c1: Side job]'));
  assert.ok(!argv.some((a) => a.includes(TASK)), 'prompt must not appear in argv');
  assert.equal(depth, '1');
  assert.equal(fs.realpathSync(cwd), fs.realpathSync(e.projectDir));
});

test('mode write uses --permission-mode acceptEdits and no --disallowedTools', async (t) => {
  const e = setupThreadEnv(t);
  const c = await start(e, { mode: 'write' });
  assert.equal(c.thread.mode, 'write');
  await untilState(e, 'idle');
  const { argv } = e.readLog()[0];
  const pi = argv.indexOf('--permission-mode');
  assert.ok(pi >= 0 && argv[pi + 1] === 'acceptEdits', `permission mode in ${argv}`);
  assert.ok(!argv.includes('--disallowedTools'));
});

test('continueThread resumes the thread session without fork, resets announced, clears reported once the new turn succeeds, records a second turn', async (t) => {
  const e = setupThreadEnv(t);
  await start(e);
  await untilState(e, 'idle');
  const rep = await core.reportThread(e.projectDir, 'c1');
  assert.equal(rep.card.thread.reported, true);
  const ann = await core.pendingAnnouncements(e.projectDir, PARENT_SESSION);
  assert.equal(ann.length, 1);
  assert.equal(thread(e.projectDir).announced, true);

  const c = await core.continueThread(e.projectDir, 'c1', 'please also check the follow-up question');
  assert.equal(c.thread.runState, 'running');
  assert.equal(c.thread.reported, true, 'still reported while the follow-up runs: nothing new exists yet');
  assert.equal(c.thread.announced, false);

  await waitFor(() => { const th = thread(e.projectDir); return th.runState === 'idle' && th.turns.length === 2 && th.turns[1].ok === true; });
  assert.equal(thread(e.projectDir).reported, false, 'a new result is not reported yet');
  const log = e.readLog();
  assert.equal(log.length, 2);
  const { argv, prompt } = log[1];
  const ri = argv.indexOf('--resume');
  assert.ok(ri >= 0 && argv[ri + 1] === THREAD_SESSION, `--resume <thread id> in ${argv}`);
  assert.ok(!argv.includes('--fork-session'));
  assert.ok(prompt.includes('please also check the follow-up question'));
  assert.ok(prompt.includes('[side thread c1: follow-up]'));
  assert.equal(card(e.projectDir).status, 'review');
});

test('continueThread throws while a turn is running', async (t) => {
  const e = setupThreadEnv(t);
  await start(e);
  await untilState(e, 'idle');
  e.setEnv('FAKE_CLAUDE_MODE', 'slow');
  e.setEnv('FAKE_CLAUDE_DELAY_MS', '1500');
  await core.continueThread(e.projectDir, 'c1', 'second');
  await assert.rejects(() => core.continueThread(e.projectDir, 'c1', 'third'), /running|still/i);
  await untilState(e, 'idle');
  assert.equal(thread(e.projectDir).turns.length, 2, 'rejected continue must not add a turn');
});

test('continueThread throws on an ended thread', async (t) => {
  const e = setupThreadEnv(t);
  await start(e);
  await untilState(e, 'idle');
  const { card: ended } = await core.endThread(e.projectDir, 'c1');
  assert.equal(ended.thread.runState, 'ended');
  await assert.rejects(() => core.continueThread(e.projectDir, 'c1', 'more'), /ended/i);
});

test('removeCard throws for a thread that is still running', async (t) => {
  const e = setupThreadEnv(t, { FAKE_CLAUDE_MODE: 'hang' });
  await start(e);
  await assert.rejects(() => core.removeCard(e.projectDir, 'c1'), Error);
  assert.ok(card(e.projectDir), 'card must still exist');
  await core.endThread(e.projectDir, 'c1');
});

test('a CLI that exits non-zero marks the thread failed and blocked with the exit code or stderr', async (t) => {
  const e = setupThreadEnv(t, { FAKE_CLAUDE_MODE: 'fail' });
  await start(e);
  await untilState(e, 'failed');
  const c = card(e.projectDir);
  assert.equal(c.status, 'blocked');
  assert.equal(c.thread.pid, null);
  const turn = c.thread.turns.at(-1);
  assert.equal(turn.ok, false);
  assert.match(turn.error, /exit|\b3\b|boom/i);
  assert.equal(c.thread.lastResult, null);
});

test('non-JSON output marks the thread failed', async (t) => {
  const e = setupThreadEnv(t, { FAKE_CLAUDE_MODE: 'garbage' });
  await start(e);
  await untilState(e, 'failed');
  const turn = thread(e.projectDir).turns.at(-1);
  assert.equal(turn.ok, false);
  assert.ok(turn.error && turn.error.length > 0);
  assert.equal(card(e.projectDir).status, 'blocked');
});

test('a result with is_error true marks the thread failed', async (t) => {
  const e = setupThreadEnv(t, { FAKE_CLAUDE_MODE: 'error' });
  await start(e);
  await untilState(e, 'failed');
  const th = thread(e.projectDir);
  assert.equal(th.turns.at(-1).ok, false);
  assert.equal(th.lastResult, null);
  assert.equal(card(e.projectDir).status, 'blocked');
});

test('a nonexistent THREAD_CLAUDE_BIN fails with a clear error instead of staying running', async (t) => {
  const e = setupThreadEnv(t, { THREAD_CLAUDE_BIN: '/nonexistent/dir/claude-does-not-exist' });
  await start(e);
  await untilState(e, 'failed', 'c1', 6000);
  const turn = thread(e.projectDir).turns.at(-1);
  assert.match(turn.error, /not found|ENOENT/i);
  assert.equal(card(e.projectDir).status, 'blocked');
});

test('timeout: a hanging CLI is killed after THREAD_TIMEOUT_MS and the thread fails mentioning timeout', { timeout: 20000 }, async (t) => {
  const e = setupThreadEnv(t, { FAKE_CLAUDE_MODE: 'hang', THREAD_TIMEOUT_MS: '500' });
  const t0 = Date.now();
  await start(e);
  await untilState(e, 'failed', 'c1', 8000);
  assert.ok(Date.now() - t0 < 7000, `took ${Date.now() - t0} ms`);
  assert.match(thread(e.projectDir).turns.at(-1).error, /time/i);
  assert.equal(thread(e.projectDir).pid, null);
});

test('endThread on a hanging thread ends it, it stays ended, and the runner process is gone', { timeout: 20000 }, async (t) => {
  const e = setupThreadEnv(t, { FAKE_CLAUDE_MODE: 'hang' });
  await start(e);
  await waitFor(() => e.readLog().length === 1 && thread(e.projectDir).pid);
  const pid = thread(e.projectDir).pid;
  assert.ok(isAlive(pid), 'runner should be alive while the CLI hangs');

  const { card: ended } = await core.endThread(e.projectDir, 'c1');
  assert.equal(ended.thread.runState, 'ended');
  assert.equal(ended.status, 'done');

  await sleep(1500);
  const after = card(e.projectDir);
  assert.equal(after.thread.runState, 'ended');
  assert.equal(after.status, 'done');
  await waitFor(() => !isAlive(pid), { timeout: 5000 });
});

test('reportThread throws before any turn has succeeded', async (t) => {
  const e = setupThreadEnv(t, { FAKE_CLAUDE_MODE: 'fail' });
  await start(e);
  await assert.rejects(() => core.reportThread(e.projectDir, 'c1'), Error);
  await untilState(e, 'failed');
  await assert.rejects(() => core.reportThread(e.projectDir, 'c1'), Error);
});

test('reportThread after success returns the digest text and sets reported', async (t) => {
  const e = setupThreadEnv(t);
  await start(e);
  await untilState(e, 'idle');
  const r = await core.reportThread(e.projectDir, 'c1');
  assert.ok(r.text.includes('## Happened'));
  assert.equal(r.card.id, 'c1');
  assert.equal(r.card.thread.reported, true);
  assert.equal(thread(e.projectDir).reported, true);
});

test('startThread throws when THREAD_DEPTH is set', async (t) => {
  const e = setupThreadEnv(t, { THREAD_DEPTH: '1' });
  await assert.rejects(() => start(e), /thread/i);
  assert.equal(core.readState(e.projectDir).cards.length, 0);
  assert.equal(e.readLog().length, 0);
});

test('startThread throws when sessionId is not a UUID', async (t) => {
  const e = setupThreadEnv(t);
  await assert.rejects(() => start(e, { sessionId: 'not-a-uuid' }), Error);
  await assert.rejects(() => start(e, { sessionId: undefined }), Error);
  assert.equal(core.readState(e.projectDir).cards.length, 0);
});

test('startThread throws when task is empty', async (t) => {
  const e = setupThreadEnv(t);
  await assert.rejects(() => start(e, { task: '' }), /task/i);
  assert.equal(core.readState(e.projectDir).cards.length, 0);
  assert.equal(e.readLog().length, 0);
});

test('reconcile marks a running thread with a dead pid as failed', async (t) => {
  const e = setupThreadEnv(t);
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => dead.on('close', r));
  const deadPid = dead.pid;
  assert.equal(isAlive(deadPid), false);
  const c = threadCard({ status: 'in_progress' }, {
    sessionId: null, runState: 'running', pid: deadPid, lastResult: null,
    turns: [{ prompt: 'p', startedAt: new Date().toISOString(), finishedAt: null, ok: null, result: null, error: null }],
  });
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [c]));

  const st = await core.reconcile(e.projectDir);
  const got = st.cards.find((x) => x.id === 'c1');
  assert.equal(got.thread.runState, 'failed');
  const persisted = card(e.projectDir);
  assert.equal(persisted.thread.runState, 'failed');
  assert.equal(persisted.status, 'blocked');
  assert.equal(persisted.thread.pid, null);
  assert.match(persisted.thread.turns.at(-1).error, /runner exited without a result/);
});

test('reconcile leaves a running thread with a live pid alone', async (t) => {
  const e = setupThreadEnv(t);
  const c = threadCard({ status: 'in_progress' }, {
    runState: 'running', pid: process.pid, lastResult: null,
    turns: [{ prompt: 'p', startedAt: new Date().toISOString(), finishedAt: null, ok: null, result: null, error: null }],
  });
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [c]));
  await core.reconcile(e.projectDir);
  assert.equal(card(e.projectDir).thread.runState, 'running');
});

test('pendingAnnouncements returns a finished thread once for the matching parent session, then nothing', async (t) => {
  const e = setupThreadEnv(t);
  await start(e);
  await untilState(e, 'idle');
  const other = await core.pendingAnnouncements(e.projectDir, '99999999-9999-4999-8999-999999999999');
  assert.deepEqual(other, [], 'nothing for another session');
  assert.equal(thread(e.projectDir).announced, false, 'another session must not consume the announcement');
  const first = await core.pendingAnnouncements(e.projectDir, PARENT_SESSION);
  assert.equal(first.length, 1);
  assert.equal(first[0].id, 'c1');
  assert.deepEqual(await core.pendingAnnouncements(e.projectDir, PARENT_SESSION), []);
});

test('pendingAnnouncements also reports failed threads and ignores running ones', async (t) => {
  const e = setupThreadEnv(t, { FAKE_CLAUDE_MODE: 'fail' });
  await start(e);
  await untilState(e, 'failed');
  const got = await core.pendingAnnouncements(e.projectDir, PARENT_SESSION);
  assert.equal(got.length, 1);

  e.setEnv('FAKE_CLAUDE_MODE', 'hang');
  await start(e, { title: 'running one' });
  await waitFor(() => thread(e.projectDir, 'c2')?.pid);
  assert.deepEqual(await core.pendingAnnouncements(e.projectDir, PARENT_SESSION), []);
  await core.endThread(e.projectDir, 'c2');
});

test('a running thread whose pid now belongs to an unrelated process is failed, and endThread does not kill that process', async (t) => {
  const e = setupThreadEnv(t);
  const bystander = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => { try { bystander.kill('SIGKILL'); } catch { /* gone */ } });
  const old = new Date(Date.now() - 120000).toISOString();
  const plant = () => writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [threadCard({ status: 'in_progress' }, {
    sessionId: null, runState: 'running', pid: bystander.pid, lastResult: null,
    turns: [{ prompt: 'p', startedAt: old, finishedAt: null, ok: null, result: null, error: null }],
  })]));

  plant();
  const state = await core.reconcile(e.projectDir);
  assert.equal(state.cards[0].thread.runState, 'failed');

  plant();
  const { card: ended } = await core.endThread(e.projectDir, 'c1');
  assert.equal(ended.thread.runState, 'ended');
  await sleep(300);
  assert.equal(isAlive(bystander.pid), true, 'the unrelated process must survive');
});

test('the runner writes a heartbeat naming its pid, and a long turn stays running past the grace period check', async (t) => {
  const e = setupThreadEnv(t, { FAKE_CLAUDE_MODE: 'slow', FAKE_CLAUDE_DELAY_MS: '1500' });
  const c = await start(e);
  const file = path.join(core.projectPaths(e.projectDir).logs, `${c.id}.alive`);
  await waitFor(() => fs.existsSync(file));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, c.thread.pid);
  const mid = await core.reconcile(e.projectDir);
  assert.equal(mid.cards[0].thread.runState, 'running');
  await untilState(e, 'idle');
});

test('reportThread after a failed follow-up says the newest turn failed', async (t) => {
  const e = setupThreadEnv(t);
  const c = await start(e);
  await untilState(e, 'idle');
  e.setEnv('FAKE_CLAUDE_MODE', 'fail');
  await core.continueThread(e.projectDir, c.id, 'again');
  await untilState(e, 'failed');
  const { text } = await core.reportThread(e.projectDir, c.id);
  assert.match(text, /newest turn of thread c1 failed/);
  assert.match(text, /## Happened/);
});

test('inside a side thread, continueThread and endThread are refused', async (t) => {
  const e = setupThreadEnv(t);
  const c = await start(e);
  await untilState(e, 'idle');
  e.setEnv('THREAD_DEPTH', '1');
  await assert.rejects(core.continueThread(e.projectDir, c.id, 'more'), /side thread cannot/);
  await assert.rejects(core.endThread(e.projectDir, c.id), /side thread cannot/);
});

test('a reported thread whose follow-up fails stays reported; one whose follow-up succeeds becomes not reported', async (t) => {
  const e = setupThreadEnv(t);
  const c = await start(e);
  await untilState(e, 'idle');
  await core.reportThread(e.projectDir, c.id);
  assert.equal(thread(e.projectDir).reported, true);

  e.setEnv('FAKE_CLAUDE_MODE', 'fail');
  await core.continueThread(e.projectDir, c.id, 'new instruction that fails');
  await untilState(e, 'failed');
  assert.equal(thread(e.projectDir).reported, true, 'nothing new to report after a failed follow-up');

  e.setEnv('FAKE_CLAUDE_MODE', undefined);
  await core.continueThread(e.projectDir, c.id, 'new instruction that works');
  await waitFor(() => thread(e.projectDir).runState === 'idle' && thread(e.projectDir).turns.length === 3);
  assert.equal(thread(e.projectDir).reported, false, 'the new result has not been reported');
  assert.equal(thread(e.projectDir).announced, false, 'and the parent session will be told it finished');
});

// ---- tool pre-approval and extra folders for headless threads

const argsCard = (over = {}) => ({ id: 'c1', title: 't', thread: { parentSessionId: PARENT_SESSION, sessionId: null, mode: 'read', turns: [{ prompt: 'p' }], ...over } });
function flagValues(argv, flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return null;
  const out = [];
  for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) out.push(argv[j]);
  return out;
}

test('threads pre-approve web search and fetch by default, in read and write mode', (t) => {
  setupThreadEnv(t, { THREAD_ALLOW_TOOLS: undefined });
  assert.deepEqual(flagValues(core.buildClaudeArgs(argsCard()), '--allowedTools'), ['WebSearch', 'WebFetch']);
  assert.deepEqual(flagValues(core.buildClaudeArgs(argsCard({ mode: 'write' })), '--allowedTools'), ['WebSearch', 'WebFetch']);
  assert.deepEqual(flagValues(core.buildClaudeArgs(argsCard()), '--disallowedTools'), ['Edit', 'Write', 'NotebookEdit']);
});

test('THREAD_ALLOW_TOOLS replaces the list, "none" removes it, and a dash-led entry is dropped', (t) => {
  const e = setupThreadEnv(t, { THREAD_ALLOW_TOOLS: 'none' });
  assert.equal(core.buildClaudeArgs(argsCard()).includes('--allowedTools'), false);
  e.setEnv('THREAD_ALLOW_TOOLS', 'WebSearch, Bash(gh repo view:*) ,--dangerously-skip-permissions');
  assert.deepEqual(flagValues(core.buildClaudeArgs(argsCard()), '--allowedTools'), ['WebSearch', 'Bash(gh repo view:*)']);
  e.setEnv('THREAD_ALLOW_TOOLS', '${user_config.allow}');
  assert.deepEqual(flagValues(core.buildClaudeArgs(argsCard()), '--allowedTools'), ['WebSearch', 'WebFetch']);
});

test('extra folders are validated at start, stored, and passed as --add-dir on every turn', async (t) => {
  const e = setupThreadEnv(t);
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-extra-'));
  t.after(() => fs.rmSync(extra, { recursive: true, force: true }));
  const file = path.join(extra, 'f.txt');
  fs.writeFileSync(file, 'x');
  const startWith = (extraDirs) => start(e, { extraDirs });
  await assert.rejects(startWith(['relative/path']), /absolute/);
  await assert.rejects(startWith(['--add-dir']), /absolute/);
  await assert.rejects(startWith([path.join(extra, 'missing')]), /not found/);
  await assert.rejects(startWith([file]), /not a folder/);
  await assert.rejects(startWith('not-a-list'), /list/);
  await assert.rejects(startWith(Array.from({ length: 6 }, (_, i) => { const d = path.join(extra, `d${i}`); fs.mkdirSync(d); return d; })), /at most 5/);
  assert.equal(core.readState(e.projectDir).cards.length, 0, 'a rejected start creates no card');

  const c = await startWith([extra, extra]);
  assert.deepEqual(c.thread.dirs, [path.resolve(extra)]);
  await untilState(e, 'idle');
  await core.continueThread(e.projectDir, c.id, 'again');
  await untilState(e, 'idle');
  const runs = e.readLog();
  assert.equal(runs.length, 2);
  for (const r of runs) assert.deepEqual(flagValues(r.argv, '--add-dir'), [path.resolve(extra)]);
  assert.equal(runs[1].argv.includes('--fork-session'), false);
});

test('a thread started without extra folders passes no --add-dir', () => {
  assert.equal(core.buildClaudeArgs(argsCard()).includes('--add-dir'), false);
  assert.equal(core.buildClaudeArgs(argsCard({ dirs: [] })).includes('--add-dir'), false);
});
