// Live activity, starting a thread from a card, and report requests from the board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  setupThreadEnv, waitFor, cleanAmbientEnv, writeStateFile, emptyState, threadCard, runNode, McpClient,
  HOOK_PATH, PARENT_SESSION, THREAD_SESSION,
} from './helpers.mjs';
import * as core from '../server/core.mjs';
import { startBoardServer } from '../server/http.mjs';

cleanAmbientEnv();

const JSON_HDR = { 'content-type': 'application/json' };
const OTHER_SESSION = '99999999-9999-4999-8999-999999999999';
const thread = (e, id = 'c1') => core.readState(e.projectDir).cards.find((c) => c.id === id)?.thread;
const idle = (e, id = 'c1') => waitFor(() => thread(e, id)?.runState === 'idle');
const start = (e, over = {}) => core.startThread(e.projectDir, { title: 'Side job', task: 'look around', sessionId: PARENT_SESSION, ...over });
const logsDir = (e) => core.projectPaths(e.projectDir).logs;
const activityOf = (e, turn = 1, id = 'c1') => core.readActivity(e.projectDir, id, turn);

// ------------------------------------------------------------ runner: live activity

test('a streamed turn succeeds and its activity file holds text, tool, tool_result and a nested tool in order', async (t) => {
  const e = setupThreadEnv(t, { FAKE_CLAUDE_MODE: 'stream' });
  await start(e);
  await idle(e);

  const th = thread(e);
  assert.equal(th.turns[0].ok, true);
  assert.equal(th.sessionId, THREAD_SESSION);
  assert.ok(th.lastResult.includes('## Happened'));
  assert.equal(th.turns[0].steps, 2);

  const argv = e.readLog()[0].argv;
  assert.equal(argv[argv.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(argv.includes('--verbose'));

  const ev = activityOf(e);
  assert.deepEqual(ev.map((x) => x.kind), ['text', 'tool', 'tool_result', 'tool'], 'thinking, init and the garbage line are skipped');
  for (const x of ev) assert.ok(!Number.isNaN(Date.parse(x.at)), x.at);
  assert.equal(ev[0].text, 'Looking at the file.');
  assert.equal(ev[1].name, 'Read');
  assert.equal(ev[1].id, 'toolu_1');
  assert.equal(ev[1].summary, '/p/src/a.js', 'file_path wins over the other keys');
  assert.equal(ev[2].id, 'toolu_1');
  assert.equal(ev[2].ok, true);
  assert.equal(ev[2].preview, 'line one line two');
  assert.equal(ev[3].summary, 'foo');
  assert.equal(ev[3].nested, true);
  assert.ok(ev.slice(0, 3).every((x) => !('nested' in x)));

  assert.ok(fs.readFileSync(path.join(logsDir(e), 'c1.out'), 'utf8').includes('this line is not json'), 'the raw stream is still logged');
});

test('the plain result-only output still succeeds, with no steps and an empty activity file', async (t) => {
  const e = setupThreadEnv(t);
  await start(e);
  await idle(e);
  assert.equal(thread(e).turns[0].ok, true);
  assert.equal(thread(e).turns[0].steps, 0);
  assert.deepEqual(activityOf(e), []);
});

test('a result line without a final newline is still read', async (t) => {
  const e = setupThreadEnv(t, { FAKE_CLAUDE_MODE: 'stream-no-newline' });
  await start(e);
  await idle(e);
  assert.equal(thread(e).turns[0].ok, true);
});

test('summaries and previews are clipped, and an input without a known key falls back to JSON', async (t) => {
  const e = setupThreadEnv(t, { FAKE_CLAUDE_MODE: 'stream-edge' });
  await start(e);
  await idle(e);
  const ev = activityOf(e);
  assert.equal(ev[0].text.length, 4000);
  assert.ok(ev[0].text.endsWith('…'));
  const tools = ev.filter((x) => x.kind === 'tool');
  assert.equal(tools[0].summary, '{"foo":"bar","n":1}');
  assert.equal(tools[1].summary.length, 300, 'command beats query, and is clipped');
  assert.ok(tools[1].summary.startsWith('echo echo'));
  assert.equal(tools[2].summary, '{}');
  const res = ev.find((x) => x.kind === 'tool_result');
  assert.equal(res.ok, false);
  assert.equal(res.preview.length, 300);
});

test('a turn stops recording at 1000 events with one truncated marker, and still counts its steps', async (t) => {
  const e = setupThreadEnv(t, { FAKE_CLAUDE_MODE: 'stream-many' });
  await start(e);
  await idle(e);
  const ev = activityOf(e);
  assert.equal(ev.length, 1001);
  assert.equal(ev[999].kind, 'tool');
  assert.deepEqual(Object.keys(ev[1000]).sort(), ['at', 'kind']);
  assert.equal(ev[1000].kind, 'truncated');
  assert.equal(thread(e).turns[0].steps, 1100);
});

test('each turn has its own activity file; a follow-up leaves the first intact; a rerun starts clean', async (t) => {
  const e = setupThreadEnv(t, { FAKE_CLAUDE_MODE: 'stream' });
  // An old file for the turn that is about to run, as a rerun would find it.
  fs.mkdirSync(logsDir(e), { recursive: true });
  fs.writeFileSync(path.join(logsDir(e), 'c1.t1.activity.jsonl'), '{"at":"x","kind":"old"}\n');
  await start(e);
  await idle(e);
  const first = fs.readFileSync(path.join(logsDir(e), 'c1.t1.activity.jsonl'), 'utf8');
  assert.ok(!first.includes('"old"'));

  await core.continueThread(e.projectDir, 'c1', 'again');
  await waitFor(() => thread(e).turns.length === 2 && thread(e).runState === 'idle');
  assert.equal(fs.readFileSync(path.join(logsDir(e), 'c1.t1.activity.jsonl'), 'utf8'), first);
  assert.equal(activityOf(e, 2).length, 4);
});

test('a failed turn still records its steps', async (t) => {
  const e = setupThreadEnv(t, { FAKE_CLAUDE_MODE: 'stream-fail' });
  await start(e);
  await waitFor(() => thread(e).runState === 'failed');
  assert.equal(thread(e).turns[0].steps, 1);
  assert.match(thread(e).turns[0].error, /exit code 3/);
});

// ------------------------------------------------------------ core: readActivity, removeCard

test('readActivity: missing file, a partial last line, and ids that are not cards', (t) => {
  const e = setupThreadEnv(t);
  assert.deepEqual(activityOf(e), []);
  fs.mkdirSync(logsDir(e), { recursive: true });
  fs.writeFileSync(path.join(logsDir(e), 'c1.t1.activity.jsonl'), '{"kind":"text","text":"a"}\n{"kind":"tool","na');
  assert.deepEqual(activityOf(e), [{ kind: 'text', text: 'a' }]);

  for (const id of ['../x', 'c1/../c2', 'x1', 'c', '', 'c1.t1', undefined]) {
    assert.throws(() => core.readActivity(e.projectDir, id, 1), /invalid card id/, String(id));
  }
  for (const n of [0, -1, 1.5, '1', NaN, undefined]) {
    assert.throws(() => core.readActivity(e.projectDir, 'c1', n), /invalid turn number/, String(n));
  }
});

test('removeCard deletes that card\'s log and activity files and leaves other cards\' files', async (t) => {
  const e = setupThreadEnv(t);
  const a = await core.addCard(e.projectDir, { title: 'A' });
  await core.addCard(e.projectDir, { title: 'Other' });   // c2
  fs.mkdirSync(logsDir(e), { recursive: true });
  for (const n of ['c1.out', 'c1.err', 'c1.alive', 'c1.t1.activity.jsonl', 'c10.out', 'c2.t1.activity.jsonl']) fs.writeFileSync(path.join(logsDir(e), n), 'x');
  await core.removeCard(e.projectDir, a.id);
  // c10 belongs to no card: the sweep that follows a removal clears it; c2's files stay (c1 is never mistaken for c10)
  assert.deepEqual(fs.readdirSync(logsDir(e)).sort(), ['c2.t1.activity.jsonl']);
  const b = await core.addCard(e.projectDir, { title: 'B' });
  fs.rmSync(logsDir(e), { recursive: true });
  assert.equal(await core.removeCard(e.projectDir, b.id), true, 'no logs folder is fine');
});

// ------------------------------------------------------------ core: start from a card

test('startThreadFromCard converts a task in place and starts the first turn with title and note', async (t) => {
  const e = setupThreadEnv(t);
  const task = await core.addCard(e.projectDir, { title: 'Fix the login bug', note: 'It fails on Safari.\nSee issue 12.', source: 'user' });
  const c = await core.startThreadFromCard(e.projectDir, task.id, { sessionId: PARENT_SESSION, context: 'full' });
  assert.equal(c.id, task.id);
  assert.equal(c.kind, 'thread');
  assert.equal(c.title, task.title);
  assert.equal(c.note, task.note);
  assert.equal(c.source, 'user');
  assert.equal(c.createdAt, task.createdAt);
  assert.equal(c.status, 'in_progress');
  assert.equal(c.thread.runState, 'running');
  assert.equal(c.thread.mode, 'read');
  assert.equal(c.thread.parentSessionId, PARENT_SESSION);
  assert.equal(c.thread.turns.length, 1);
  assert.equal(c.thread.turns[0].prompt, 'Fix the login bug\n\nIt fails on Safari.\nSee issue 12.');
  assert.equal(core.readState(e.projectDir).cards.length, 1);

  await idle(e, task.id);
  const { prompt, argv } = e.readLog()[0];
  assert.ok(prompt.includes('Fix the login bug'));
  assert.ok(prompt.includes('It fails on Safari.'));
  assert.equal(argv[argv.indexOf('--resume') + 1], PARENT_SESSION);
  assert.ok(argv.includes('--fork-session'));
});

test('startThreadFromCard on an idea without a note uses the title alone, and passes mode and extra folders', async (t) => {
  const e = setupThreadEnv(t);
  const idea = await core.addCard(e.projectDir, { title: 'Try a cache', kind: 'idea' });
  const c = await core.startThreadFromCard(e.projectDir, idea.id, { sessionId: PARENT_SESSION, mode: 'write', extraDirs: [e.base] });
  assert.equal(c.thread.turns[0].prompt, 'Try a cache');
  assert.equal(c.thread.mode, 'write');
  assert.deepEqual(c.thread.dirs, [path.resolve(e.base)]);
  await idle(e);
  assert.ok(e.readLog()[0].prompt.includes('Task: Try a cache\n'));
});

test('startThreadFromCard refuses a thread, an unknown card, a bad session, a bad mode and a thread session, leaving the card unchanged', async (t) => {
  const e = setupThreadEnv(t);
  const task = await core.addCard(e.projectDir, { title: 'Task', note: 'n' });
  const th = await start(e);
  await idle(e, th.id);
  const before = JSON.stringify(core.readState(e.projectDir));
  const from = (id, over) => core.startThreadFromCard(e.projectDir, id, { sessionId: PARENT_SESSION, ...over });

  await assert.rejects(from(th.id), new RegExp(`card ${th.id} is already a thread`));
  await assert.rejects(from('c42'), /card not found: c42/);
  await assert.rejects(from(task.id, { sessionId: 'nope' }), /session_id must be a UUID/);
  await assert.rejects(from(task.id, { sessionId: undefined }), /session_id must be a UUID/);
  await assert.rejects(from(task.id, { mode: 'rw' }), /invalid mode/);
  await assert.rejects(from(task.id, { extraDirs: ['relative'] }), /absolute/);
  e.setEnv('THREAD_DEPTH', '1');
  await assert.rejects(from(task.id), /a side thread cannot start threads/);

  assert.equal(JSON.stringify(core.readState(e.projectDir)), before);
  assert.equal(e.readLog().length, 1, 'no runner was launched for a refused start');
});

// ------------------------------------------------------------ core: report requests

function seed(e, over = {}, threadOver = {}) {
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [threadCard(over, threadOver)]));
}

test('requestReport refuses before any result and once reported, otherwise stores the time', async (t) => {
  const e = setupThreadEnv(t);
  seed(e, {}, { lastResult: null, runState: 'running' });
  await assert.rejects(core.requestReport(e.projectDir, 'c1'), /thread c1 has nothing to report yet/);
  seed(e, {}, { reported: true });
  await assert.rejects(core.requestReport(e.projectDir, 'c1'), /thread c1 is already reported/);
  await assert.rejects(core.requestReport(e.projectDir, 'c9'), /card not found/);

  seed(e);
  const c = await core.requestReport(e.projectDir, 'c1');
  assert.ok(!Number.isNaN(Date.parse(c.thread.reportRequestedAt)));
  assert.equal(thread(e).reportRequestedAt, c.thread.reportRequestedAt);
});

test('pendingReportRequests names the parent session only, does not consume the request, and cancel clears it', async (t) => {
  const e = setupThreadEnv(t);
  seed(e);
  assert.deepEqual(await core.pendingReportRequests(e.projectDir, PARENT_SESSION), [], 'nothing before the click');
  await core.requestReport(e.projectDir, 'c1');
  for (let i = 0; i < 2; i++) {
    assert.deepEqual((await core.pendingReportRequests(e.projectDir, PARENT_SESSION)).map((c) => c.id), ['c1']);
  }
  assert.deepEqual(await core.pendingReportRequests(e.projectDir, OTHER_SESSION), []);

  const cancelled = await core.cancelReportRequest(e.projectDir, 'c1');
  assert.equal('reportRequestedAt' in cancelled.thread, false);
  assert.deepEqual(await core.pendingReportRequests(e.projectDir, PARENT_SESSION), []);
  await core.cancelReportRequest(e.projectDir, 'c1'); // not set: no error
});

test('a report by the parent session or ending the thread clears the request; a confirmed report from another session does not', async (t) => {
  const e = setupThreadEnv(t);
  seed(e);
  await core.requestReport(e.projectDir, 'c1');

  const needs = await core.reportThread(e.projectDir, 'c1', { sessionId: OTHER_SESSION });
  assert.equal(needs.needsConfirm, true);
  const other = await core.reportThread(e.projectDir, 'c1', { sessionId: OTHER_SESSION, confirmCode: needs.code });
  assert.equal(other.otherSession, true);
  assert.ok(thread(e).reportRequestedAt, 'the parent session has still not been given the report');
  assert.equal((await core.pendingReportRequests(e.projectDir, PARENT_SESSION)).length, 1);

  await core.reportThread(e.projectDir, 'c1', { sessionId: PARENT_SESSION });
  assert.equal(thread(e).reported, true);
  assert.equal('reportRequestedAt' in thread(e), false);

  seed(e);
  await core.requestReport(e.projectDir, 'c1');
  await core.endThread(e.projectDir, 'c1');
  assert.equal('reportRequestedAt' in thread(e), false);
});

// ------------------------------------------------------------ http

async function boot(t, { env, token } = {}) {
  const e = setupThreadEnv(t, env);
  const b = await startBoardServer(e.projectDir, { port: 0, token });
  t.after(() => new Promise((r) => { b.server.closeAllConnections?.(); b.server.close(() => r()); }));
  return { ...e, ...b, key: crypto.createHash('sha1').update(e.projectDir).digest('hex').slice(0, 12) };
}

function raw(port, { method = 'GET', path: p, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, text, json: text ? JSON.parse(text) : null }); });
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('GET threads/:id/activity returns the events of a finished turn, under both route forms', async (t) => {
  const b = await boot(t, { env: { FAKE_CLAUDE_MODE: 'stream' } });
  await start(b);
  await idle(b);
  for (const prefix of ['/api', `/api/p/${b.key}`]) {
    const r = await fetch(`http://127.0.0.1:${b.port}${prefix}/threads/c1/activity?turn=1`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.turn, 1);
    assert.equal(body.running, false);
    assert.deepEqual(body.events.map((x) => x.kind), ['text', 'tool', 'tool_result', 'tool']);
  }
});

test('the activity route says running for the newest turn of a running thread, and 404s for what does not exist', async (t) => {
  const b = await boot(t, { env: { FAKE_CLAUDE_MODE: 'hang' } });
  const base = `http://127.0.0.1:${b.port}/api`;
  const task = await core.addCard(b.projectDir, { title: 'Just a task' });
  await start(b); // c2
  const run = await (await fetch(`${base}/threads/c2/activity?turn=1`)).json();
  assert.deepEqual(run, { turn: 1, running: true, events: [] });

  for (const q of ['/threads/c9/activity?turn=1', `/threads/${task.id}/activity?turn=1`, '/threads/c2/activity?turn=2', '/threads/c2/activity?turn=0', '/threads/c2/activity?turn=x', '/threads/c2/activity']) {
    const r = await fetch(base + q);
    assert.equal(r.status, 404, q);
    assert.equal(typeof (await r.json()).error, 'string');
  }
  assert.equal((await fetch(`${base}/threads/c2/activity?turn=1`, { method: 'POST', headers: JSON_HDR, body: '{}' })).status, 404, 'a read route only');
  await core.endThread(b.projectDir, 'c2');
});

test('the activity route needs the token when the server has one, and works for a project whose folder is gone', async (t) => {
  const token = 'a'.repeat(32);
  const b = await boot(t, { token });
  const gone = path.join(b.base, 'gone'); // never created
  writeStateFile(b.dataDir, gone, emptyState(gone, [threadCard()]));
  const key = crypto.createHash('sha1').update(gone).digest('hex').slice(0, 12);
  fs.mkdirSync(core.projectPaths(gone).logs, { recursive: true });
  fs.writeFileSync(path.join(core.projectPaths(gone).logs, 'c1.t1.activity.jsonl'), '{"at":"x","kind":"text","text":"hi"}\n');

  const p = `/api/p/${key}/threads/c1/activity?turn=1`;
  assert.equal((await raw(b.port, { path: p })).status, 401);
  const ok = await raw(b.port, { path: p, headers: { 'x-thread-token': token } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.events, [{ at: 'x', kind: 'text', text: 'hi' }]);
});

test('POST cards/:id/start converts the card, and is refused with 409 for a missing project folder', async (t) => {
  const b = await boot(t);
  const base = `http://127.0.0.1:${b.port}/api`;
  const task = await core.addCard(b.projectDir, { title: 'Do it', note: 'carefully' });
  const r = await fetch(`${base}/cards/${task.id}/start`, { method: 'POST', headers: JSON_HDR, body: JSON.stringify({ sessionId: PARENT_SESSION, mode: 'read' }) });
  assert.equal(r.status, 200);
  const c = await r.json();
  assert.equal(c.id, task.id);
  assert.equal(c.kind, 'thread');
  assert.equal(c.thread.parentSessionId, PARENT_SESSION);
  await idle(b, task.id);
  const done = await (await fetch(`${base}/state`)).json();
  assert.ok(done.cards[0].thread.turns[0].view, 'thread responses carry the parsed views');

  const again = await fetch(`${base}/cards/${task.id}/start`, { method: 'POST', headers: JSON_HDR, body: JSON.stringify({ sessionId: PARENT_SESSION }) });
  assert.equal(again.status, 400);
  assert.match((await again.json()).error, /already a thread/);
  const bad = await fetch(`${base}/cards/${task.id}/start`, { method: 'POST', headers: JSON_HDR, body: JSON.stringify({ sessionId: 5 }) });
  assert.equal(bad.status, 400);

  const gone = path.join(b.base, 'gone');
  writeStateFile(b.dataDir, gone, emptyState(gone, [{ id: 'c1', kind: 'task', title: 'T', note: '', status: 'new', source: 'claude', seenByClaude: true, createdAt: 'x', updatedAt: 'x' }]));
  const key = crypto.createHash('sha1').update(gone).digest('hex').slice(0, 12);
  const missing = await fetch(`${base}/p/${key}/cards/c1/start`, { method: 'POST', headers: JSON_HDR, body: JSON.stringify({ sessionId: PARENT_SESSION }) });
  assert.equal(missing.status, 409);
  assert.equal(b.readLog().length, 1);
});

test('POST and DELETE threads/:id/report-request set and clear the request; DELETE needs no Content-Type', async (t) => {
  const b = await boot(t);
  seed(b);
  const p = '/api/threads/c1/report-request';
  const set = await raw(b.port, { method: 'POST', path: p, headers: JSON_HDR, body: '{}' });
  assert.equal(set.status, 200);
  assert.ok(set.json.thread.reportRequestedAt);
  assert.ok(thread(b).reportRequestedAt);
  const again = await raw(b.port, { method: 'POST', path: `/api/p/${b.key}/threads/c1/report-request`, headers: JSON_HDR, body: '{}' });
  assert.equal(again.status, 200);

  const del = await raw(b.port, { method: 'DELETE', path: p });
  assert.equal(del.status, 200);
  assert.equal('reportRequestedAt' in del.json.thread, false);
  assert.equal('reportRequestedAt' in thread(b), false);
  assert.equal((await raw(b.port, { method: 'DELETE', path: p })).status, 200, 'clearing twice is fine');

  seed(b, {}, { reported: true });
  const refused = await raw(b.port, { method: 'POST', path: p, headers: JSON_HDR, body: '{}' });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /already reported/);
});

// ------------------------------------------------------------ hook and thread_status

function hook(e, session, extraEnv = {}) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: e.projectDir, THREAD_DATA_DIR: e.dataDir, ...extraEnv };
  return runNode([HOOK_PATH, 'UserPromptSubmit'], { env, cwd: e.projectDir, input: JSON.stringify({ session_id: session, cwd: e.projectDir, hook_event_name: 'UserPromptSubmit', prompt: 'x' }) });
}
const contextOf = (r) => JSON.parse(r.stdout.trim()).hookSpecificOutput.additionalContext;

test('the hook asks the parent session to report, on every prompt until it has, and tells no other session', async (t) => {
  const e = setupThreadEnv(t);
  seed(e, { id: 'c3', title: 'Zebra research' }, { announced: true, reportRequestedAt: new Date().toISOString() });
  const line = 'The user clicked "Report to main session" on the board for thread c3 "Zebra research". Call thread_report with id "c3" now and give them the digest.';
  for (let i = 0; i < 2; i++) {
    const r = await hook(e, PARENT_SESSION);
    assert.equal(r.code, 0);
    assert.equal(contextOf(r), line);
  }
  const other = await hook(e, OTHER_SESSION);
  assert.equal(other.code, 0);
  assert.equal(other.stdout.trim(), '');

  await core.reportThread(e.projectDir, 'c3', { sessionId: PARENT_SESSION });
  assert.equal((await hook(e, PARENT_SESSION)).stdout.trim(), '');
});

test('many other notes do not cut the report request off, and the context stays under 1500 characters', async (t) => {
  const e = setupThreadEnv(t);
  const cards = [threadCard({ id: 'c1', title: 'Zebra research' }, { announced: true, reportRequestedAt: new Date().toISOString() })];
  for (let i = 2; i <= 12; i++) cards.push(threadCard({ id: `c${i}`, title: `A long thread title number ${i} that goes on and on and on` }));
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, cards));
  const ctx = contextOf(await hook(e, PARENT_SESSION));
  assert.ok(ctx.startsWith('The user clicked "Report to main session" on the board for thread c1 "Zebra research". Call thread_report with id "c1" now and give them the digest.\n'), ctx);
  assert.ok(ctx.includes('Thread c2'), 'other notes follow');
  assert.ok(ctx.length > 600 && ctx.length <= 1500, `length ${ctx.length}`);
});

test('thread_status shows "report requested" only while a request is stored', async (t) => {
  const e = setupThreadEnv(t);
  seed(e);
  const c = new McpClient(e);
  t.after(() => c.kill());
  await c.init();
  const status = async () => (await c.call('thread_status', { id: 'c1', session_id: PARENT_SESSION })).text;
  assert.ok(!(await status()).includes('report requested'));
  await core.requestReport(e.projectDir, 'c1');
  assert.ok((await status()).includes(', report requested'));
  await core.cancelReportRequest(e.projectDir, 'c1');
  assert.ok(!(await status()).includes('report requested'));
});
