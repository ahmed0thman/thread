// A thread that does the work of a task or idea (thread_start with `card`): the card shows each turn as a run, like a sub-agent run.
// The relays are fakes (test/fake-delegate) and the claude CLI is the fake one; no real provider or claude is ever started.
import { test as baseTest } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setupThreadEnv, cleanAmbientEnv, waitFor, McpClient, PARENT_SESSION, FAKE_DELEGATE, writeStateFile, emptyState, threadCard } from './helpers.mjs';
import * as core from '../server/core.mjs';
import * as runs from '../server/runs.mjs';
import { clearLanesCache } from '../server/lanes.mjs';
import { startBoardServer } from '../server/http.mjs';

cleanAmbientEnv();

const HAVE_GIT = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

const test = baseTest;
const TASK = 'look-into-the-rounding-of-the-tax-line';
const card = (dir, id) => core.readState(dir).cards.find((c) => c.id === id);
const thread = (dir, id) => card(dir, id)?.thread;
const untilState = (e, id, runState, timeout = 10000) => waitFor(() => thread(e.projectDir, id)?.runState === runState, { timeout });
const logsDir = (e) => path.join(e.dataDir, 'projects', core.projectKey(e.projectDir), 'logs');

function setup(t, relayMode = 'ok', extra = {}) {
  cleanAmbientEnv();
  clearLanesCache();
  t.after(clearLanesCache);
  return setupThreadEnv(t, { THREAD_DELEGATE_DIR: FAKE_DELEGATE, FAKE_DELEGATE_MODE: 'ok', FAKE_RELAY_MODE: relayMode, ...extra });
}
const start = (e, over = {}) => core.startThread(e.projectDir, { title: 'Zebra job', task: TASK, sessionId: PARENT_SESSION, lane: 'claude-edit', card: 'c1', ...over });
const task = (e, over = {}) => core.addCard(e.projectDir, { title: 'Fix the tax rounding', criteria: ['rounds half up'], ...over });

async function boot(t, e) {
  const token = 'ab'.repeat(16);
  const b = await startBoardServer(e.projectDir, { port: 0, token });
  t.after(() => new Promise((r) => { b.server.closeAllConnections?.(); b.server.close(() => r()); }));
  const base = `http://127.0.0.1:${b.port}`;
  const key = (await (await fetch(`${base}/api/projects`, { headers: { 'X-Thread-Token': token } })).json()).projects[0].key;
  const get = async (p) => (await fetch(`${base}/api/p/${key}/${p}`, { headers: { 'X-Thread-Token': token } })).json();
  return { get, base, key, token };
}

test('thread_start with a card on a lane opens a running run; the card stays a task and the done gate holds; the turn closes it', async (t) => {
  const e = setup(t, 'slow', { FAKE_RELAY_EVENTS: '1', FAKE_RELAY_DELAY_MS: '700' });
  const c1 = await task(e);
  assert.equal(c1.id, 'c1');
  const th = await start(e);
  assert.equal(th.id, 'c2');
  assert.equal(th.thread.forCard, 'c1');

  // running
  const open = card(e.projectDir, 'c1');
  assert.equal(open.kind, 'task', 'the card stays a task');
  assert.equal(open.runs.length, 1);
  const run = open.runs[0];
  assert.equal(run.n, 1);
  assert.equal(run.thread, 'c2');
  assert.equal(run.turn, 1);
  assert.equal(run.lane, 'claude-edit');
  assert.equal(run.agentType, 'claude-edit');
  assert.equal(run.mode, 'background');
  assert.equal(run.description, 'Zebra job');
  assert.equal(run.state, 'running');
  assert.equal(run.sessionId, PARENT_SESSION);
  assert.equal(run.finishedAt, null);
  assert.equal(run.ok, null);
  assert.equal(run.agentId, undefined);
  assert.equal(run.transcript, undefined);
  assert.equal(run.promptFile, true);
  assert.ok(run.prompt.includes('[side thread c2: Zebra job]'));
  const prompt = runs.readRunText(e.projectDir, 'c1', run, 'prompt');
  assert.equal(prompt.full, true);
  assert.ok(prompt.text.includes(TASK) && prompt.text.includes('hand-back digest'), 'the prompt is what the provider got');
  assert.equal(runs.runQuiet(run, Date.now() + 3600e3), false, 'a linked run is never quiet by its clock');
  assert.deepEqual(core.workedBy(open), ['lane:claude-edit'], 'the run counts as the lane');
  // the activity of a turn that has not written anything yet is empty, not gone
  const early = runs.runActivity(e.projectDir, 'c1', run, 0);
  assert.equal(early.running, true);
  assert.notEqual(early.gone, true);
  assert.deepEqual(early.events, []);
  // the criteria still gate the card
  await assert.rejects(core.updateCard(e.projectDir, 'c1', { status: 'done' }, { source: 'claude' }), /has acceptance criteria/);

  // done
  await untilState(e, 'c2', 'idle');
  await waitFor(() => card(e.projectDir, 'c1').runs[0].state === 'done');
  const done = card(e.projectDir, 'c1').runs[0];
  assert.equal(done.ok, true);
  assert.ok(Date.parse(done.finishedAt) > 0);
  assert.equal(done.reportFile, true);
  assert.equal(done.steps, 2);
  assert.equal(done.snapshot, true);
  assert.ok(done.usage && done.usage.output > 0);
  assert.equal(done.note, undefined);
  const report = runs.readRunText(e.projectDir, 'c1', done, 'report');
  assert.equal(report.full, true);
  assert.equal(report.text, thread(e.projectDir, 'c2').lastResult);
  assert.ok(done.result.length <= 300 && report.text.startsWith(done.result.replace(/…$/, '')));
  assert.ok(fs.existsSync(path.join(logsDir(e), 'c1.r1.activity.jsonl')), 'the trace is kept apart from the thread');
  assert.equal(card(e.projectDir, 'c1').kind, 'task');
  assert.equal(card(e.projectDir, 'c1').status, 'new', 'nothing moved the card');

  // the trace is read from the snapshot, also when the thread card is gone
  const act = runs.runActivity(e.projectDir, 'c1', done, 0);
  assert.equal(act.running, false);
  assert.equal(act.next, null);
  assert.deepEqual(act.events.filter((v) => v.kind === 'tool').map((v) => v.name), ['Read', 'Grep']);
  await core.removeCard(e.projectDir, 'c2', { source: 'user' });
  assert.deepEqual(runs.runActivity(e.projectDir, 'c1', card(e.projectDir, 'c1').runs[0], 0).events, act.events);
  assert.equal(card(e.projectDir, 'c1').runs.length, 1);
});

test('a follow-up turn adds run 2 with turn 2, and its prompt is the follow-up', async (t) => {
  const e = setup(t, 'ok');
  await task(e, { criteria: undefined });
  await start(e);
  await untilState(e, 'c2', 'idle');
  await waitFor(() => card(e.projectDir, 'c1').runs[0].state === 'done');
  await core.continueThread(e.projectDir, 'c2', 'Now the second file, please.');
  const runsNow = card(e.projectDir, 'c1').runs;
  assert.equal(runsNow.length, 2);
  assert.equal(runsNow[1].n, 2);
  assert.equal(runsNow[1].turn, 2);
  assert.equal(runsNow[1].state, 'running');
  assert.ok(runs.readRunText(e.projectDir, 'c1', runsNow[1], 'prompt').text.includes('Now the second file, please.'));
  await untilState(e, 'c2', 'idle');
  await waitFor(() => card(e.projectDir, 'c1').runs[1].state === 'done');
  assert.equal(card(e.projectDir, 'c1').runs[0].state, 'done');
  assert.equal(thread(e.projectDir, 'c2').turns.length, 2);
});

test('a thread on claude (no lane) names the run after its agent, else "thread"; a thread without a card opens no run', async (t) => {
  const e = setup(t, 'ok');
  await task(e, { criteria: undefined });
  await core.addCard(e.projectDir, { title: 'Another', criteria: undefined });
  await start(e, { lane: undefined });
  const r = card(e.projectDir, 'c1').runs[0];
  assert.equal(r.agentType, 'thread');
  assert.equal(r.lane, undefined);
  assert.deepEqual(core.workedBy(card(e.projectDir, 'c1')), ['thread:c3']);
  await untilState(e, 'c3', 'idle');
  await waitFor(() => card(e.projectDir, 'c1').runs[0].state === 'done');
  assert.match(runs.readRunText(e.projectDir, 'c1', card(e.projectDir, 'c1').runs[0], 'report').text, /## Happened/);
  // no card: as before
  const plain = await core.startThread(e.projectDir, { title: 'Plain', task: TASK, sessionId: PARENT_SESSION });
  assert.equal('forCard' in plain.thread, false);
  await untilState(e, plain.id, 'idle');
  assert.equal(card(e.projectDir, 'c2').runs, undefined);
  assert.equal(card(e.projectDir, 'c1').runs.length, 1);
});

test('a failed relay closes the run as stopped with a note and no report', async (t) => {
  const e = setup(t, 'failed');
  await task(e, { criteria: undefined });
  await start(e);
  await untilState(e, 'c2', 'failed');
  await waitFor(() => card(e.projectDir, 'c1').runs[0].state === 'stopped');
  const run = card(e.projectDir, 'c1').runs[0];
  assert.equal(run.ok, false);
  assert.ok(run.finishedAt);
  assert.ok(run.note && run.note.length <= 300);
  assert.ok(thread(e.projectDir, 'c2').turns[0].error.startsWith(run.note.slice(0, 40)));
  assert.equal(run.result, null);
  assert.equal(run.reportFile, undefined);
  assert.equal(run.snapshot, true, 'the trace of a failed turn is kept too');
});

test('ending a running thread closes its run as stopped', async (t) => {
  const e = setup(t, 'slow', { FAKE_RELAY_DELAY_MS: '20000' });
  await task(e, { criteria: undefined });
  await start(e);
  await waitFor(() => fs.existsSync(path.join(logsDir(e), 'c2.alive')));   // the runner is up, so it records the turn when it is told to stop
  await core.endThread(e.projectDir, 'c2');
  await waitFor(() => card(e.projectDir, 'c1').runs[0].state === 'stopped', { timeout: 20000 });
  const run = card(e.projectDir, 'c1').runs[0];
  assert.equal(run.ok, false);
  assert.match(run.note, /ended by user/);
});

// ---------------------------------------------------------------- the sweep

test('reconcile closes a running run whose thread is not running that turn', async (t) => {
  const e = setup(t, 'ok');
  const now = new Date().toISOString();
  const open = (n, over) => ({ n, thread: 'c5', turn: 1, lane: 'claude-edit', agentType: 'claude-edit', mode: 'background', description: 'Job', state: 'running', sessionId: PARENT_SESSION, startedAt: now, finishedAt: null, ok: null, prompt: null, result: null, ...over });
  const dead = threadCard({ id: 'c5', title: 'Job', status: 'in_progress' }, { runState: 'running', forCard: 'c1', lastResult: null, turns: [{ prompt: 'p', startedAt: now, finishedAt: null, ok: null, result: null, error: null }] });
  const finished = threadCard({ id: 'c6', title: 'Done job' }, { forCard: 'c1' });
  const cards = [
    { id: 'c1', kind: 'task', title: 'Work', note: '', status: 'new', source: 'user', seenByClaude: true, createdAt: now, updatedAt: now,
      runs: [open(1), open(2, { thread: 'c9', turn: 1 }), open(3, { thread: 'c6', turn: 1 }), open(4, { thread: 'c6', turn: 2 })] },
    dead, finished,
  ];
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, cards));
  assert.deepEqual(runs.staleLinkedRuns(core.readState(e.projectDir).cards).map((x) => x.run.n), [2, 3, 4], 'run 1 is for the turn the thread is running; reconcile finds its runner gone');
  await core.reconcile(e.projectDir);
  const r = card(e.projectDir, 'c1').runs;
  assert.deepEqual(r.map((x) => [x.n, x.state, x.ok]), [[1, 'stopped', false], [2, 'stopped', false], [3, 'done', true], [4, 'stopped', false]]);
  assert.match(r[0].note, /runner exited without a result/, 'the thread was marked failed first; its error is the note');
  assert.match(r[1].note, /ended without a result/, 'a thread that is gone');
  assert.match(r[3].note, /ended without a result/, 'a turn the thread does not have');
  assert.ok(r.every((x) => x.finishedAt));
  assert.equal(runs.staleLinkedRuns(core.readState(e.projectDir).cards).length, 0);
  const after = JSON.stringify(card(e.projectDir, 'c1').runs);
  await core.reconcile(e.projectDir);
  assert.equal(JSON.stringify(card(e.projectDir, 'c1').runs), after, 'a second pass changes nothing');
});

// A task c1 with the runs given, and the threads given, as a hand-made state (runs are open: state running).
const NOW = () => new Date().toISOString();
const openRun = (n, over = {}) => ({ n, thread: 'c2', turn: 1, lane: 'claude-edit', agentType: 'claude-edit', mode: 'background', description: 'Job', state: 'running', sessionId: PARENT_SESSION, startedAt: NOW(), finishedAt: null, ok: null, prompt: null, result: null, ...over });
const turnOf = (over = {}) => ({ prompt: 'p', startedAt: NOW(), finishedAt: NOW(), ok: true, result: 'Report of the turn\n## Happened\n- x', error: null, steps: 3, ...over });
function handState(e, { runs, threads }) {
  const now = NOW();
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [
    { id: 'c1', kind: 'task', title: 'Work', note: '', status: 'new', source: 'user', seenByClaude: true, createdAt: now, updatedAt: now, ...(runs ? { runs } : {}) },
    ...threads,
  ]));
}
const writeAlive = (e, id, over = {}) => {
  fs.mkdirSync(logsDir(e), { recursive: true });
  fs.writeFileSync(path.join(logsDir(e), `${id}.alive`), JSON.stringify({ pid: process.pid, at: Date.now(), ...over }));
};

test('removing a finished thread before the sweep closes its run from the turn\'s stored result, steps and trace', async (t) => {
  const e = setup(t);
  const usage = { input: 5, cacheRead: 0, cacheWrite: 0, output: 7 };
  handState(e, { runs: [openRun(1)], threads: [threadCard({ id: 'c2', title: 'Job' }, { forCard: 'c1', turns: [turnOf({ usage })], lastResult: 'x' })] });
  fs.mkdirSync(logsDir(e), { recursive: true });
  fs.writeFileSync(path.join(logsDir(e), 'c2.t1.activity.jsonl'), JSON.stringify({ at: NOW(), kind: 'tool', id: 'a', name: 'Read', summary: 'a.txt' }) + '\n');
  await core.removeCard(e.projectDir, 'c2', { source: 'user' });
  assert.equal(card(e.projectDir, 'c2'), undefined);
  const run = card(e.projectDir, 'c1').runs[0];
  assert.deepEqual([run.state, run.ok, run.steps], ['done', true, 3]);
  assert.deepEqual({ ...run.usage }, usage);
  assert.equal(run.snapshot, true);
  assert.match(runs.readRunText(e.projectDir, 'c1', run, 'report').text, /^Report of the turn/);
  assert.deepEqual(runs.runActivity(e.projectDir, 'c1', run, 0).events.map((v) => v.name), ['Read']);
  assert.equal(fs.existsSync(path.join(logsDir(e), 'c2.t1.activity.jsonl')), false);
  await core.reconcile(e.projectDir);
  assert.equal(card(e.projectDir, 'c1').runs[0].state, 'done', 'the sweep finds nothing left to close');
});

test('removing a thread whose turn failed or never finished closes its run as stopped with that error', async (t) => {
  const e = setup(t);
  handState(e, { runs: [openRun(1), openRun(2, { thread: 'c3' })], threads: [
    threadCard({ id: 'c2', title: 'Job' }, { forCard: 'c1', runState: 'failed', turns: [turnOf({ ok: false, result: null, error: 'relay failed' })], lastResult: null }),
    threadCard({ id: 'c3', title: 'Job 2' }, { forCard: 'c1', runState: 'running', pid: 2147483000, turns: [{ prompt: 'p', startedAt: NOW(), finishedAt: null, ok: null, result: null, error: null }], lastResult: null }),
  ] });
  await core.removeCard(e.projectDir, 'c2', { source: 'user' });
  await core.removeCard(e.projectDir, 'c3', { source: 'user' });
  const r = card(e.projectDir, 'c1').runs;
  assert.deepEqual(r.map((x) => [x.state, x.ok]), [['stopped', false], ['stopped', false]]);
  assert.match(r[0].note, /relay failed/);
  assert.match(r[1].note, /ended without a result/);
});

test('a thread that does a card\'s work, removed before the sweep in a repo-backed project, still leaves a finished run', { skip: !HAVE_GIT }, async (t) => {
  const e = setup(t, 'ok', { FAKE_RELAY_EVENTS: '1' });
  e.base = fs.realpathSync(e.base);
  e.projectDir = fs.realpathSync(e.projectDir);
  core.resetRepoCache();
  execFileSync('git', ['init', '-q', e.projectDir], { stdio: 'ignore' });
  core.enableRepo(e.projectDir);
  const c1 = await task(e);
  const th = await start(e, { card: c1.id });
  await untilState(e, th.id, 'idle');
  assert.equal(card(e.projectDir, c1.id).runs[0].state, 'running', 'the runner cannot close a repo card\'s run');
  await core.removeCard(e.projectDir, th.id, { source: 'user' });
  const run = card(e.projectDir, c1.id).runs[0];
  assert.deepEqual([run.state, run.ok, run.steps, run.snapshot], ['done', true, 2, true]);
  assert.match(runs.readRunText(e.projectDir, c1.id, run, 'report').text, /## Happened/);
});

test('a thread that was ended is not swept while its runner is still writing; the sweep then says the user ended it', async (t) => {
  const e = setup(t);
  const open = { prompt: 'p', startedAt: NOW(), finishedAt: null, ok: null, result: null, error: null };
  handState(e, { runs: [openRun(1)], threads: [threadCard({ id: 'c2', title: 'Job' }, { forCard: 'c1', runState: 'ended', pid: null, turns: [open], lastResult: null })] });
  writeAlive(e, 'c2');   // a runner that is alive (this process) and beating
  assert.deepEqual(runs.staleLinkedRuns(core.readState(e.projectDir).cards).map((x) => x.run.n), [1], 'without the runner check it would be closed');
  await core.reconcile(e.projectDir);
  assert.equal(card(e.projectDir, 'c1').runs[0].state, 'running', 'the runner records the turn and closes the run');
  writeAlive(e, 'c2', { at: Date.now() - 60000 });   // stale: the runner is gone
  await core.reconcile(e.projectDir);
  const run = card(e.projectDir, 'c1').runs[0];
  assert.deepEqual([run.state, run.ok], ['stopped', false]);
  assert.match(run.note, /ended by the user/);
});

test('the turn\'s own record updates a run the sweep closed early, and leaves a run that kept a report alone', async (t) => {
  const e = setup(t);
  const closed = openRun(1, { state: 'stopped', ok: false, finishedAt: NOW(), note: 'ended by the user' });
  const kept = openRun(2, { thread: 'c3', state: 'done', ok: true, finishedAt: NOW(), result: 'Old report', reportFile: true });
  handState(e, { runs: [closed, kept], threads: [
    threadCard({ id: 'c2', title: 'Job' }, { forCard: 'c1', turns: [turnOf()] }),
    threadCard({ id: 'c3', title: 'Job 3' }, { forCard: 'c1', turns: [turnOf()] }),
  ] });
  const outcome = { ok: true, result: 'The real report', steps: 4, usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 2 } };
  const did = await core.updateState(e.projectDir, (s) => [runs.closeLinkedRun(e.projectDir, s, 'c2', 1, outcome), runs.closeLinkedRun(e.projectDir, s, 'c3', 1, outcome)]);
  assert.deepEqual(did, [true, false]);
  const [a, b] = card(e.projectDir, 'c1').runs;
  assert.deepEqual([a.state, a.ok, a.steps, a.note], ['done', true, 4, undefined]);
  assert.equal(runs.readRunText(e.projectDir, 'c1', a, 'report').text, 'The real report');
  assert.equal(b.result, 'Old report');
});

test('Mark as stopped refuses a run whose thread is running that turn (409), and works once the thread is not', async (t) => {
  const e = setup(t);
  const live = { prompt: 'p', startedAt: NOW(), finishedAt: null, ok: null, result: null, error: null };
  handState(e, { runs: [openRun(1)], threads: [threadCard({ id: 'c2', title: 'Job' }, { forCard: 'c1', runState: 'running', pid: process.pid, turns: [live], lastResult: null })] });
  writeAlive(e, 'c2');
  await assert.rejects(runs.markRunStopped(e.projectDir, 'c1', 1), /still going/);
  const b = await boot(t, e);
  const post = (n) => fetch(`${b.base}/api/p/${b.key}/cards/c1/runs/${n}/stop`, { method: 'POST', headers: { 'X-Thread-Token': b.token, 'Content-Type': 'application/json' }, body: '{}' });
  const refused = await post(1);
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /still going/);
  assert.equal(card(e.projectDir, 'c1').runs[0].state, 'running');
  // a run of an older turn is not the one the thread is running
  await core.updateState(e.projectDir, (s) => { s.cards.find((c) => c.id === 'c1').runs.push(openRun(2, { turn: 2, thread: 'c9' })); });
  const ok = await post(2);
  assert.equal(ok.status, 200);
  assert.equal(card(e.projectDir, 'c1').runs[1].state, 'stopped');
});

test('reconcile opens a run for a turn of a thread that has none (an older plugin version continued it), from the turn\'s own record', async (t) => {
  const e = setup(t);
  const t1 = turnOf({ prompt: 'first brief', startedAt: '2026-10-14T03:00:00.000Z' });
  const t2 = turnOf({ prompt: 'follow-up two', startedAt: '2026-10-14T03:10:00.000Z', result: 'Second report', steps: 5 });
  const t3 = turnOf({ prompt: 'follow-up three', startedAt: '2026-10-14T03:20:00.000Z', ok: false, result: null, error: 'it broke' });
  handState(e, { runs: [openRun(1, { state: 'done', ok: true, finishedAt: t1.finishedAt, startedAt: t1.startedAt })],
    threads: [threadCard({ id: 'c2', title: 'Job' }, { forCard: 'c1', runState: 'failed', turns: [t1, t2, t3], lastResult: 'Second report' })] });
  await core.reconcile(e.projectDir);
  const r = card(e.projectDir, 'c1').runs;
  assert.deepEqual(r.map((x) => [x.n, x.turn, x.state]), [[1, 1, 'done'], [2, 2, 'done'], [3, 3, 'stopped']]);
  assert.equal(r[1].startedAt, t2.startedAt);
  assert.equal(r[1].steps, 5);
  assert.equal(runs.readRunText(e.projectDir, 'c1', r[1], 'prompt').text, 'follow-up two');
  assert.equal(runs.readRunText(e.projectDir, 'c1', r[1], 'report').text, 'Second report');
  assert.match(r[2].note, /it broke/);
  const after = JSON.stringify(card(e.projectDir, 'c1').runs);
  await core.reconcile(e.projectDir);
  assert.equal(JSON.stringify(card(e.projectDir, 'c1').runs), after, 'a second pass changes nothing');
});

test('a missing run is opened as running while its turn is still going, and none comes back for a turn whose run the limit dropped', async (t) => {
  const e = setup(t);
  const live = { prompt: 'p', startedAt: NOW(), finishedAt: null, ok: null, result: null, error: null };
  handState(e, { runs: [openRun(1, { state: 'done', ok: true, finishedAt: NOW() })],
    threads: [threadCard({ id: 'c2', title: 'Job' }, { forCard: 'c1', runState: 'running', pid: process.pid, turns: [turnOf(), live], lastResult: 'x' })] });
  await core.reconcile(e.projectDir);
  assert.deepEqual(card(e.projectDir, 'c1').runs.map((x) => [x.turn, x.state]), [[1, 'done'], [2, 'running']]);
  // a card at its limit may have dropped the run of an older turn: it is not opened again
  const full = Array.from({ length: runs.MAX_RUNS }, (_, i) => openRun(i + 10, { thread: 'c9', turn: i + 1, state: 'done', ok: true, finishedAt: NOW() }));
  handState(e, { runs: full, threads: [threadCard({ id: 'c2', title: 'Job' }, { forCard: 'c1', turns: [turnOf(), turnOf()] })] });
  await core.reconcile(e.projectDir);
  assert.equal(card(e.projectDir, 'c1').runs.length, runs.MAX_RUNS);
  assert.equal(card(e.projectDir, 'c1').runs.some((x) => x.thread === 'c2'), false);
});

test('workedBy names a run of a thread as the thread is named: its lane, else its agent, else the thread', () => {
  const run = (over) => ({ n: 1, thread: 'c9', turn: 1, agentType: 'thread', startedAt: '2026-10-14T03:00:00.000Z', ...over });
  assert.deepEqual(core.workedBy({ runs: [run({ lane: 'code-codex', agentType: 'code-codex' })] }), ['lane:code-codex']);
  assert.deepEqual(core.workedBy({ runs: [run({ agentType: 'worker' })] }), ['agent:worker'], 'the thread\'s tokens are listed under the agent too');
  assert.deepEqual(core.workedBy({ runs: [run()] }), ['thread:c9']);
  assert.deepEqual(core.workedBy({ runs: [{ n: 2, agentType: 'worker', agentId: 'abcdef', startedAt: '2026-10-14T03:00:00.000Z' }] }), ['agent:worker']);
});

// ---------------------------------------------------------------- stopRun, the activity route, the page's view

test('the hooks\' stopRun leaves a linked run alone, and the board route reads its steps and has no path', async (t) => {
  const e = setup(t, 'ok', { FAKE_RELAY_EVENTS: '1' });
  await task(e, { criteria: undefined });
  await start(e);
  await untilState(e, 'c2', 'idle');
  await waitFor(() => card(e.projectDir, 'c1').runs[0].state === 'done');
  const before = JSON.stringify(card(e.projectDir, 'c1').runs);
  const stopped = await runs.stopRun(e.projectDir, { agent_id: 'abcdef0123456789', session_id: PARENT_SESSION, transcript_path: path.join(e.base, 'x.jsonl') }, { settleMs: 0 });
  assert.equal(stopped, false);
  assert.equal(JSON.stringify(card(e.projectDir, 'c1').runs), before);

  const b = await boot(t, e);
  const state = await b.get('state');
  const view = state.cards.find((c) => c.id === 'c1');
  assert.equal(view.runs.length, 1);
  assert.equal(view.runs[0].thread, 'c2');
  assert.equal('transcript' in view.runs[0], false);
  assert.equal(JSON.stringify(view).includes(e.base), false, 'no path in the card\'s view');
  assert.equal(view.runs[0].quiet, undefined);
  const act = await b.get('cards/c1/runs/1/activity');
  assert.equal(act.running, false);
  assert.deepEqual(act.events.filter((v) => v.kind === 'tool').map((v) => v.name), ['Read', 'Grep']);
  assert.equal(JSON.stringify(act).includes(e.base), false);
  const rep = await b.get('cards/c1/runs/1/report');
  assert.equal(rep.text, thread(e.projectDir, 'c2').lastResult);
});

test('runActivity reads a running linked run from an offset, from the thread\'s activity file only', async (t) => {
  const e = setup(t);
  const now = new Date().toISOString();
  const th = threadCard({ id: 'c2', title: 'Job', status: 'in_progress' }, { runState: 'running', forCard: 'c1' });
  th.thread.turns = [{ prompt: 'p', startedAt: now, finishedAt: null, ok: null, result: null, error: null }];
  const run = { n: 1, thread: 'c2', turn: 1, agentType: 'thread', mode: 'background', description: 'Job', state: 'running', sessionId: PARENT_SESSION, startedAt: now, finishedAt: null, ok: null, prompt: null, result: null, transcript: '/etc/passwd' };
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [{ id: 'c1', kind: 'task', title: 'Work', note: '', status: 'new', source: 'user', seenByClaude: true, createdAt: now, updatedAt: now, runs: [run] }, th]));
  fs.mkdirSync(logsDir(e), { recursive: true });
  const file = path.join(logsDir(e), 'c2.t1.activity.jsonl');
  const line = (o) => JSON.stringify({ at: now, ...o }) + '\n';
  fs.writeFileSync(file, line({ kind: 'text', text: 'Looking.' }) + line({ kind: 'tool', id: 'a', name: 'Read', summary: 'a.txt' }));
  const first = runs.runActivity(e.projectDir, 'c1', run, 0);
  assert.equal(first.running, true);
  assert.deepEqual(first.events.map((v) => v.kind), ['text', 'tool']);
  assert.ok(first.next > 0);
  fs.appendFileSync(file, line({ kind: 'tool_result', id: 'a', ok: true, preview: 'x' }));
  const second = runs.runActivity(e.projectDir, 'c1', run, first.next);
  assert.deepEqual(second.events.map((v) => v.kind), ['tool_result']);
  assert.equal(second.reset, false);
  // a stored transcript path is never read: the run reads the thread's file
  assert.equal(second.events.length, 1);
  // the sweep's predicate and the page's quiet flag: the thread runs turn 1, so the run is alive
  assert.equal(runs.linkedAlive(run, core.readState(e.projectDir).cards), true);
  assert.equal(runs.isLinkedRun({ ...run, agentId: 'abc123' }), false);

  // the board marks a running linked run whose thread is not running it as quiet, so "Mark as stopped" shows
  const b = await boot(t, e);
  await core.updateState(e.projectDir, (s) => { s.cards.find((c) => c.id === 'c2').thread.runState = 'idle'; });
  const orphan = await b.get('state');
  // the state route reconciles first: the run is closed rather than quiet
  assert.equal(orphan.cards.find((c) => c.id === 'c1').runs[0].state, 'stopped');
});

// ---------------------------------------------------------------- refusals, MCP, chat-only

test('thread_start refuses a milestone, a thread, an unknown id and chat-only mode, and starts nothing', async (t) => {
  const e = setup(t, 'ok');
  await core.addCard(e.projectDir, { title: 'Plan', kind: 'milestone' });   // c1
  await core.addCard(e.projectDir, { title: 'Work', criteria: undefined });   // c2
  const plain = await core.startThread(e.projectDir, { title: 'Plain', task: TASK, sessionId: PARENT_SESSION });   // c3
  await untilState(e, plain.id, 'idle');
  const count = core.readState(e.projectDir).cards.length;
  await assert.rejects(start(e, { card: 'c1' }), /c1 is a milestone/);
  await assert.rejects(start(e, { card: plain.id }), /is a thread/);
  await assert.rejects(start(e, { card: 'c77' }), /card not found: c77/);
  assert.equal(core.readState(e.projectDir).cards.length, count, 'a refused start leaves no card');
  await core.saveConfig(e.projectDir, 'project', { mode: 'chat' });
  await assert.rejects(start(e, { card: 'c2' }), /chat-only|switched off|board/i);
  assert.equal(core.readState(e.projectDir).cards.length, count);
});

test('thread_start through MCP takes card, thread_status shows "for c1", and the guide names the argument', async (t) => {
  const e = setup(t, 'ok');
  await task(e, { criteria: undefined });
  const c = new McpClient(e);
  t.after(() => c.kill());
  await c.init();
  const tools = await c.request('tools/list', {});
  const spec = tools.result.tools.find((x) => x.name === 'thread_start');
  assert.match(spec.inputSchema.properties.card.description, /Refused for a milestone, a thread, an unknown id, and in chat-only mode/);
  const r = await c.call('thread_start', { title: 'Zebra', task: TASK, session_id: PARENT_SESSION, lane: 'claude-edit', card: 'c1' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /for c1/);
  const bad = await c.call('thread_start', { title: 'x', task: 'y', session_id: PARENT_SESSION, card: 'c99' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /card not found: c99/);
  await untilState(e, 'c2', 'idle');
  const s = await c.call('thread_status', { session_id: PARENT_SESSION });
  assert.match(s.text, /c2 "Zebra".*for c1/);
  assert.equal(card(e.projectDir, 'c1').runs.length, 1);
});

// ---------------------------------------------------------------- a project kept in the repo



(HAVE_GIT ? test : test.skip)('in a repo-backed project the run lives on this machine only: the card file holds no runs, paths or session ids', async (t) => {
  const e = setup(t, 'ok', { FAKE_RELAY_EVENTS: '1' });
  e.base = fs.realpathSync(e.base);
  e.projectDir = fs.realpathSync(e.projectDir);
  core.resetRepoCache();
  execFileSync('git', ['init', '-q', e.projectDir], { stdio: 'ignore' });
  core.enableRepo(e.projectDir);
  const c1 = await task(e);
  const th = await start(e, { card: c1.id });
  assert.equal(th.thread.forCard, c1.id);
  await untilState(e, th.id, 'idle');
  // the runner works in the thread's own store, where the repo's cards are not: the sweep, which sees both, closes the run from the turn's record
  assert.equal(card(e.projectDir, c1.id).runs[0].state, 'running');
  // the runner says idle and beats a moment longer while it exits, and the sweep leaves a beating thread alone: a board poll comes again
  await waitFor(async () => { await core.reconcile(e.projectDir); return card(e.projectDir, c1.id).runs[0].state !== 'running'; });
  const closed = card(e.projectDir, c1.id).runs[0];
  assert.equal(closed.state, 'done');
  assert.equal(closed.ok, true);
  assert.equal(closed.steps, 2);
  assert.equal(closed.snapshot, true);
  assert.equal(runs.readRunText(e.projectDir, c1.id, closed, 'report').text, thread(e.projectDir, th.id).lastResult);
  assert.equal(closed.thread, th.id);
  assert.equal(card(e.projectDir, c1.id).kind, 'task');

  const dir = path.join(e.projectDir, '.claude', 'thread');
  const files = fs.readdirSync(dir, { recursive: true }).map((n) => path.join(dir, n)).filter((p) => fs.statSync(p).isFile());
  assert.ok(files.length >= 1);
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const bad of [os.homedir(), e.base, e.dataDir, '"runs"', '"thread"', 'sessionId', 'forCard', 'claude-edit', PARENT_SESSION]) assert.equal(text.includes(bad), false, `${path.relative(e.projectDir, f)} must not contain ${bad}`);
    assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  }
  // a follow-up and the sweep work on a repo card too
  await core.continueThread(e.projectDir, th.id, 'Once more.');
  assert.equal(card(e.projectDir, c1.id).runs.length, 2);
  await untilState(e, th.id, 'idle');
  await waitFor(async () => { await core.reconcile(e.projectDir); return card(e.projectDir, c1.id).runs[1].state !== 'running'; });
  assert.equal(card(e.projectDir, c1.id).runs[1].state, 'done');
  await core.updateState(e.projectDir, (s) => { s.cards = s.cards.filter((c) => c.id !== th.id); });
  await core.updateState(e.projectDir, (s) => { s.cards.find((c) => c.id === c1.id).runs.push({ n: 3, thread: 'c9', turn: 1, agentType: 'thread', mode: 'background', description: 'x', state: 'running', sessionId: '', startedAt: new Date().toISOString(), finishedAt: null, ok: null, prompt: null, result: null }); });
  await core.reconcile(e.projectDir);
  assert.equal(card(e.projectDir, c1.id).runs[2].state, 'stopped');
});
