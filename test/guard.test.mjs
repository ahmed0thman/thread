// Wrong-session guard: reportThread / endThread confirmation, pickReportable, the MCP tools and the runner folder check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  setupThreadEnv, waitFor, cleanAmbientEnv, writeStateFile, emptyState, threadCard, McpClient, PARENT_SESSION, REPLY_WITH_MAP,
} from './helpers.mjs';
import * as core from '../server/core.mjs';
import { startBoardServer } from '../server/http.mjs';

cleanAmbientEnv();

const OTHER = '99999999-9999-4999-8999-999999999999';
const THIRD = '77777777-7777-4777-8777-777777777777';
const DIGEST = 'done\n## Happened\nx';

const thread = (dir, id = 'c1') => core.readState(dir).cards.find((c) => c.id === id).thread;

function seed(e, cards = [threadCard({ id: 'c1', title: 'Zebra research' })], sessions) {
  const state = emptyState(e.projectDir, cards);
  state.sessions = sessions ?? {
    [PARENT_SESSION]: { name: 'Plan the thing', nameSource: 'title', transcriptPath: '', firstSeenAt: 'a', lastSeenAt: new Date(Date.now() - 5 * 60000).toISOString() },
  };
  writeStateFile(e.dataDir, e.projectDir, state);
}

function expireConfirm(e, id = 'c1') {
  return core.updateState(e.projectDir, (s) => {
    s.cards.find((c) => c.id === id).thread.pendingConfirm.expiresAt = new Date(Date.now() - 1000).toISOString();
  });
}

// ---------------------------------------------------------------- reportThread

test('the parent session reports normally, whatever the case of its id', async (t) => {
  const e = setupThreadEnv(t);
  seed(e);
  const r = await core.reportThread(e.projectDir, 'c1', { sessionId: PARENT_SESSION.toUpperCase() });
  assert.equal(r.text, DIGEST);
  assert.equal(r.needsConfirm, undefined);
  assert.equal(r.otherSession, undefined);
  assert.equal(thread(e.projectDir).reported, true);
  assert.equal(thread(e.projectDir).pendingConfirm, undefined);
});

test('without a session id reportThread behaves as before', async (t) => {
  const e = setupThreadEnv(t);
  seed(e);
  const r = await core.reportThread(e.projectDir, 'c1');
  assert.equal(r.text, DIGEST);
  assert.equal(thread(e.projectDir).reported, true);
});

test('reportThread leaves the step map out of the text given to the main session', async (t) => {
  const e = setupThreadEnv(t);
  seed(e, [threadCard({ id: 'c1' }, { lastResult: REPLY_WITH_MAP })]);
  const { text } = await core.reportThread(e.projectDir, 'c1');
  assert.match(text, /## Decided/);
  assert.doesNotMatch(text, /thread-map/);
});

test('another session gets needsConfirm, no text, and reported stays false', async (t) => {
  const e = setupThreadEnv(t);
  seed(e);
  const r = await core.reportThread(e.projectDir, 'c1', { sessionId: OTHER });
  assert.equal(r.needsConfirm, true);
  assert.equal(r.action, 'report');
  assert.match(r.code, /^[0-9a-f]{8}$/);
  assert.equal(r.card.id, 'c1');
  assert.equal(r.text, undefined);
  const th = thread(e.projectDir);
  assert.equal(th.reported, false);
  assert.equal(th.reports, undefined);
  assert.equal(th.pendingConfirm.code, r.code);
  assert.equal(th.pendingConfirm.action, 'report');
  assert.equal(th.pendingConfirm.sessionId, OTHER);
  const ttl = Date.parse(th.pendingConfirm.expiresAt) - Date.now();
  assert.ok(ttl > 9 * 60000 && ttl <= 10 * 60000, `ttl ${ttl}`);
});

test('the right code returns the digest, logs the pull, keeps reported false and is single use', async (t) => {
  const e = setupThreadEnv(t);
  seed(e);
  const { code } = await core.reportThread(e.projectDir, 'c1', { sessionId: OTHER });
  const r = await core.reportThread(e.projectDir, 'c1', { sessionId: OTHER, confirmCode: code });
  assert.equal(r.otherSession, true);
  assert.equal(r.text, DIGEST);
  const th = thread(e.projectDir);
  assert.equal(th.reported, false);
  assert.equal(th.pendingConfirm, undefined);
  assert.equal(th.reports.length, 1);
  assert.equal(th.reports[0].sessionId, OTHER);
  assert.ok(Date.parse(th.reports[0].at) > Date.now() - 5000);

  const again = await core.reportThread(e.projectDir, 'c1', { sessionId: OTHER, confirmCode: code });
  assert.equal(again.needsConfirm, true);
  assert.equal(again.text, undefined);
  assert.equal(thread(e.projectDir).reports.length, 1);
});

test('a wrong, foreign, cross-action or expired code is refused with a fresh code', async (t) => {
  const e = setupThreadEnv(t);
  seed(e);
  const refused = async (sessionId, confirmCode, label) => {
    const before = thread(e.projectDir).pendingConfirm?.code;
    const r = await core.reportThread(e.projectDir, 'c1', { sessionId, confirmCode });
    assert.equal(r.needsConfirm, true, label);
    assert.equal(r.text, undefined, label);
    assert.notEqual(r.code, before, `${label}: fresh code`);
    const th = thread(e.projectDir);
    assert.equal(th.reported, false, label);
    assert.equal(th.reports, undefined, label);
    assert.equal(th.pendingConfirm.code, r.code, label);
    return r.code;
  };

  const first = (await core.reportThread(e.projectDir, 'c1', { sessionId: OTHER })).code;
  await refused(OTHER, 'deadbeef', 'wrong code');
  await refused(OTHER, undefined, 'no code');

  const forOther = (await core.reportThread(e.projectDir, 'c1', { sessionId: OTHER })).code;
  await refused(THIRD, forOther, 'code issued to a different session');

  const endCode = (await core.endThread(e.projectDir, 'c1', { sessionId: OTHER })).code;
  await refused(OTHER, endCode, 'code for the other action');

  const reportCode = (await core.reportThread(e.projectDir, 'c1', { sessionId: OTHER })).code;
  await expireConfirm(e);
  await refused(OTHER, reportCode, 'expired code');
  assert.notEqual(first, undefined);
});

test('reportThread refuses inside a side thread', async (t) => {
  const e = setupThreadEnv(t, { THREAD_DEPTH: '1' });
  seed(e);
  await assert.rejects(core.reportThread(e.projectDir, 'c1'), /side thread cannot report/);
  await assert.rejects(core.reportThread(e.projectDir, 'c1', { sessionId: PARENT_SESSION }), /side thread cannot report/);
  assert.equal(thread(e.projectDir).reported, false);
});

// ---------------------------------------------------------------- endThread

test('endThread: the parent and a caller without a session id end the thread directly', async (t) => {
  const e = setupThreadEnv(t);
  seed(e, [threadCard({ id: 'c1' }), threadCard({ id: 'c2' })]);
  assert.equal((await core.endThread(e.projectDir, 'c1', { sessionId: PARENT_SESSION })).card.thread.runState, 'ended');
  assert.equal((await core.endThread(e.projectDir, 'c2')).card.thread.runState, 'ended');
});

test('endThread: another session needs the code and the thread is not ended until it is given', async (t) => {
  const e = setupThreadEnv(t);
  seed(e);
  const r = await core.endThread(e.projectDir, 'c1', { sessionId: OTHER });
  assert.equal(r.needsConfirm, true);
  assert.equal(r.action, 'end');
  assert.match(r.code, /^[0-9a-f]{8}$/);
  assert.equal(thread(e.projectDir).runState, 'idle');
  assert.equal(thread(e.projectDir).pendingConfirm.action, 'end');

  const reportCode = (await core.reportThread(e.projectDir, 'c1', { sessionId: OTHER })).code;
  const wrongAction = await core.endThread(e.projectDir, 'c1', { sessionId: OTHER, confirmCode: reportCode });
  assert.equal(wrongAction.needsConfirm, true);
  assert.equal(thread(e.projectDir).runState, 'idle');

  const { code } = await core.endThread(e.projectDir, 'c1', { sessionId: OTHER });
  const wrongSession = await core.endThread(e.projectDir, 'c1', { sessionId: THIRD, confirmCode: code });
  assert.equal(wrongSession.needsConfirm, true);
  assert.equal(thread(e.projectDir).runState, 'idle');

  const { code: code2 } = await core.endThread(e.projectDir, 'c1', { sessionId: OTHER });
  await expireConfirm(e);
  const expired = await core.endThread(e.projectDir, 'c1', { sessionId: OTHER, confirmCode: code2 });
  assert.equal(expired.needsConfirm, true);

  const { code: code3 } = await core.endThread(e.projectDir, 'c1', { sessionId: OTHER });
  const done = await core.endThread(e.projectDir, 'c1', { sessionId: OTHER, confirmCode: code3 });
  assert.equal(done.needsConfirm, undefined);
  assert.equal(done.card.thread.runState, 'ended');
  assert.equal(done.card.status, 'done');
  assert.equal(thread(e.projectDir).pendingConfirm, undefined);
});

test('endThread keeps refusing inside a side thread', async (t) => {
  const e = setupThreadEnv(t, { THREAD_DEPTH: '1' });
  seed(e);
  await assert.rejects(core.endThread(e.projectDir, 'c1', { sessionId: PARENT_SESSION }), /side thread cannot end/);
});

// ---------------------------------------------------------------- continueThread

test('continueThread records who sent a turn when it is not the parent', async (t) => {
  const e = setupThreadEnv(t);
  seed(e, [threadCard({ id: 'c1' }), threadCard({ id: 'c2' })]);
  await core.continueThread(e.projectDir, 'c1', 'more please', { sessionId: OTHER });
  await core.continueThread(e.projectDir, 'c2', 'more please', { sessionId: PARENT_SESSION });
  assert.equal(thread(e.projectDir, 'c1').turns[1].sentBy, OTHER);
  assert.equal(thread(e.projectDir, 'c2').turns[1].sentBy, undefined);
  await waitFor(() => ['c1', 'c2'].every((id) => thread(e.projectDir, id).runState === 'idle'), { timeout: 10000 });
});

// ---------------------------------------------------------------- pickReportable

test('pickReportable splits mine and others and ignores running, failed-without-result and reported threads', async (t) => {
  const e = setupThreadEnv(t);
  seed(e, [
    threadCard({ id: 'c1' }),
    threadCard({ id: 'c2' }, { parentSessionId: OTHER }),
    threadCard({ id: 'c3' }, { runState: 'running' }),
    threadCard({ id: 'c4' }, { runState: 'failed', lastResult: null }),
    threadCard({ id: 'c5' }, { reported: true }),
    threadCard({ id: 'c6' }, { parentSessionId: THIRD }),
    { id: 'c7', kind: 'task', title: 'plain', note: '', status: 'new' },
  ]);
  const { mine, others } = await core.pickReportable(e.projectDir, PARENT_SESSION);
  assert.deepEqual(mine.map((c) => c.id), ['c1']);
  assert.deepEqual(others.map((c) => c.id), ['c2', 'c6']);
});

// ---------------------------------------------------------------- MCP

async function mcp(t, e, extraEnv) {
  const c = new McpClient(e, extraEnv);
  t.after(() => c.kill());
  await c.init();
  return c;
}

test('MCP thread_report from another session asks for confirmation without the digest, then returns it with the code', async (t) => {
  const e = setupThreadEnv(t);
  seed(e);
  const c = await mcp(t, e);
  const first = await c.call('thread_report', { id: 'c1', session_id: OTHER });
  assert.equal(first.isError, false);
  assert.ok(first.text.startsWith('CONFIRMATION REQUIRED. Nothing was reported.'), first.text);
  assert.ok(first.text.includes('AskUserQuestion'));
  assert.ok(first.text.includes('Started by: Plan the thing · aaaaaaaa, last active 5 min ago'), first.text);
  assert.ok(first.text.includes('You are in: session 99999999'));
  assert.ok(first.text.includes('header: "Wrong session"'));
  assert.ok(first.text.includes('label "Cancel (Recommended)"'));
  assert.ok(first.text.includes('Run /thread:report c1 in the session that started it.'));
  assert.ok(!first.text.includes('## Happened'));
  assert.ok(!first.text.includes('done\n'));
  const code = first.text.match(/confirm_code "([0-9a-f]{8})"/)?.[1];
  assert.ok(code, first.text);
  assert.equal(thread(e.projectDir).reported, false);

  const second = await c.call('thread_report', { id: 'c1', session_id: OTHER, confirm_code: code });
  assert.equal(second.isError, false);
  assert.ok(second.text.startsWith('Reported into a different session than the one that started this thread (Plan the thing · aaaaaaaa).'), second.text);
  assert.ok(second.text.includes('## Happened'));
  assert.equal(thread(e.projectDir).reported, false);
  assert.equal(thread(e.projectDir).reports.length, 1);
});

test('MCP thread_report from the parent session reports at once', async (t) => {
  const e = setupThreadEnv(t);
  seed(e);
  const c = await mcp(t, e);
  const r = await c.call('thread_report', { id: 'c1', session_id: PARENT_SESSION });
  assert.ok(r.text.startsWith('Thread c1 "Zebra research"'), r.text);
  assert.ok(r.text.includes('## Happened'));
  assert.equal(thread(e.projectDir).reported, true);
});

test('MCP thread_end from another session needs the code', async (t) => {
  const e = setupThreadEnv(t);
  seed(e);
  const c = await mcp(t, e);
  const first = await c.call('thread_end', { id: 'c1', session_id: OTHER });
  assert.ok(first.text.startsWith('CONFIRMATION REQUIRED. Nothing was ended.'), first.text);
  assert.ok(first.text.includes('Run /thread:end c1 in the session that started it.'));
  assert.ok(first.text.includes('call thread_end again'));
  assert.equal(thread(e.projectDir).runState, 'idle');
  const code = first.text.match(/confirm_code "([0-9a-f]{8})"/)[1];
  const second = await c.call('thread_end', { id: 'c1', session_id: OTHER, confirm_code: code });
  assert.equal(second.isError, false);
  assert.ok(second.text.includes('ended'), second.text);
  assert.equal(thread(e.projectDir).runState, 'ended');
});

test('MCP thread_report without an id picks the caller\'s single thread and never another session\'s', async (t) => {
  const e = setupThreadEnv(t);
  seed(e, [
    threadCard({ id: 'c1', title: 'Mine' }),
    threadCard({ id: 'c2', title: 'Theirs' }, { parentSessionId: OTHER }),
  ]);
  const c = await mcp(t, e);
  const first = await c.call('thread_report', { session_id: PARENT_SESSION });
  assert.ok(first.text.startsWith('Thread c1 "Mine"'), first.text);
  assert.equal(thread(e.projectDir, 'c1').reported, true);

  const second = await c.call('thread_report', { session_id: PARENT_SESSION });
  assert.equal(second.isError, false);
  assert.ok(second.text.startsWith('Nothing was reported'), second.text);
  assert.ok(second.text.includes('c2 "Theirs"'));
  assert.ok(second.text.includes('session 99999999'));
  assert.ok(second.text.includes('by id'));
  assert.ok(!second.text.includes('## Happened'));
  assert.equal(thread(e.projectDir, 'c2').reported, false);
  assert.equal(thread(e.projectDir, 'c2').pendingConfirm, undefined);
});

test('MCP thread_report without an id lists the caller\'s threads when there are two', async (t) => {
  const e = setupThreadEnv(t);
  seed(e, [
    threadCard({ id: 'c1', title: 'First job' }),
    threadCard({ id: 'c2', title: 'Second job' }),
    threadCard({ id: 'c3', title: 'Foreign job' }, { parentSessionId: OTHER }),
  ]);
  const c = await mcp(t, e);
  const r = await c.call('thread_report', { session_id: PARENT_SESSION });
  assert.equal(r.isError, false);
  assert.ok(r.text.includes('c1 "First job"') && r.text.includes('c2 "Second job"') && r.text.includes('c3 "Foreign job"'), r.text);
  assert.ok(!r.text.includes('## Happened'));
  assert.equal(thread(e.projectDir, 'c1').reported, false);
  assert.equal(thread(e.projectDir, 'c2').reported, false);
});

test('MCP thread_report and thread_end without a resolvable caller are errors; the environment is a fallback', async (t) => {
  const e = setupThreadEnv(t);
  seed(e, [threadCard({ id: 'c1' }), threadCard({ id: 'c2' })]);
  const c = await mcp(t, e);
  for (const args of [{ id: 'c1' }, { id: 'c1', session_id: 'not-a-uuid' }, { session_id: '${CLAUDE_SESSION_ID}' }]) {
    const r = await c.call('thread_report', args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.ok(r.text.includes('session_id'));
  }
  const end = await c.call('thread_end', { id: 'c1' });
  assert.equal(end.isError, true);
  assert.equal(thread(e.projectDir).runState, 'idle');

  const withEnv = await mcp(t, e, { CLAUDE_CODE_SESSION_ID: PARENT_SESSION });
  const ok = await withEnv.call('thread_report', { id: 'c1', session_id: 'junk' });
  assert.equal(ok.isError, false);
  assert.ok(ok.text.includes('## Happened'));
});

test('MCP thread_status shows who started each thread', async (t) => {
  const e = setupThreadEnv(t);
  seed(e, [threadCard({ id: 'c1' }), threadCard({ id: 'c2' }, { parentSessionId: OTHER })]);
  const c = await mcp(t, e);
  const mine = await c.call('thread_status', { session_id: PARENT_SESSION });
  const l1 = mine.text.split('\n').find((l) => l.startsWith('c1 '));
  const l2 = mine.text.split('\n').find((l) => l.startsWith('c2 '));
  assert.ok(l1.includes('started by: this session'), l1);
  assert.ok(l2.includes('started by: session 99999999'), l2);
  const anon = await c.call('thread_status', {});
  assert.ok(anon.text.split('\n').find((l) => l.startsWith('c1 ')).includes('started by: Plan the thing · aaaaaaaa'));
  const one = await c.call('thread_status', { id: 'c2', session_id: OTHER });
  assert.ok(one.text.includes('started by: this session'), one.text);
});

test('MCP thread_continue from another session says whose thread it is', async (t) => {
  const e = setupThreadEnv(t);
  seed(e);
  const c = await mcp(t, e);
  const r = await c.call('thread_continue', { id: 'c1', message: 'one more thing', session_id: OTHER });
  assert.equal(r.isError, false, r.text);
  assert.ok(r.text.includes('belongs to Plan the thing · aaaaaaaa'), r.text);
  assert.ok(r.text.includes('"finished" notice will go to that session'));
  assert.equal(thread(e.projectDir).turns[1].sentBy, OTHER);
  await waitFor(() => thread(e.projectDir).runState === 'idle', { timeout: 10000 });
  const own = await c.call('thread_continue', { id: 'c1', message: 'and again', session_id: PARENT_SESSION });
  assert.ok(!own.text.includes('belongs to'), own.text);
  await waitFor(() => thread(e.projectDir).runState === 'idle' && thread(e.projectDir).turns.length === 3, { timeout: 10000 });
});

// ---------------------------------------------------------------- runner

test('a thread whose project folder was removed fails with "project folder not found"', async (t) => {
  const e = setupThreadEnv(t);
  const gone = path.join(e.base, 'removed-project');
  fs.mkdirSync(gone);
  fs.rmSync(gone, { recursive: true });
  const card = await core.startThread(gone, { title: 'Orphan', task: 'anything', sessionId: PARENT_SESSION });
  await waitFor(() => thread(gone, card.id).runState === 'failed', { timeout: 10000 });
  const err = thread(gone, card.id).turns[0].error;
  assert.equal(err, `project folder not found: ${gone}`);
  assert.equal(e.readLog().length, 0, 'the CLI was never started');
});

test('the board API never exposes a pending confirm code', async (t) => {
  const e = setupThreadEnv(t);
  seed(e);
  const first = await core.reportThread(e.projectDir, 'c1', { sessionId: OTHER });
  assert.equal(first.needsConfirm, true);
  const { server, url } = await startBoardServer(e.projectDir, { port: 0 });
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }));
  const body = await (await fetch(url + 'api/state')).text();
  assert.equal(body.includes(first.code), false, 'confirm code leaked');
  assert.equal(body.includes('pendingConfirm'), false);
});
