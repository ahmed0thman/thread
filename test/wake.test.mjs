// Waking an idle session from the board: the `wake` setting, the Stop hook's waiter (scripts/waiter.mjs) and what the
// UserPromptSubmit hook does on the turn that wakes the session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  setupThreadEnv, cleanAmbientEnv, McpClient, runNode, waitFor, sleep, writeStateFile, emptyState, threadCard, oldServerFrom, RELEASED_REFS,
  HOOK_PATH, PARENT_SESSION, ROOT, TEST_DIR,
} from './helpers.mjs';
import * as core from '../server/core.mjs';
import { pendingWake } from '../server/wake.mjs';

cleanAmbientEnv();

const WAITER = path.join(ROOT, 'scripts', 'waiter.mjs');
const OTHER_SESSION = '99999999-9999-4999-8999-999999999999';
const stateOf = (e) => core.readState(e.projectDir);
const cardOf = (e, id) => stateOf(e).cards.find((c) => c.id === id);
const itemOf = (e, id) => core.waitsOf(cardOf(e, id.split('.')[0])).find((w) => w.id === id);
const waiterFiles = (e) => fs.readdirSync(core.projectPaths(e.projectDir).dir).filter((n) => n.startsWith('waiter-') && n.endsWith('.json'));

/** A task card with one open question asked by PARENT_SESSION, and `wake` on for the project. */
async function world(t, { wake = true, extra = {} } = {}) {
  const e = setupThreadEnv(t, extra);
  await core.addCard(e.projectDir, { title: 'Fix the importer' });
  await core.addWait(e.projectDir, { card: 'c1', kind: 'question', text: 'Which retry limit?', sessionId: PARENT_SESSION });
  if (wake) await core.saveConfig(e.projectDir, 'project', { wake: true });
  return e;
}
const answer = (e, id = 'c1.w1') => core.answerWait(e.projectDir, 'c1', id, { text: 'three' });

/** Start the Stop hook's waiter. `done` resolves with { code, stderr } when it exits. */
function startWaiter(t, e, { session = PARENT_SESSION, env = {}, input } = {}) {
  const childEnv = { ...process.env, CLAUDE_PROJECT_DIR: e.projectDir, THREAD_DATA_DIR: e.dataDir, THREAD_WAKE_POLL_MS: '100', ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete childEnv[k];
  const child = spawn(process.execPath, [WAITER], { env: childEnv, cwd: e.projectDir, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.on('data', (d) => (stdout += d));
  child.stdin.on('error', () => {});
  child.stdin.end(input ?? JSON.stringify({ session_id: session, cwd: e.projectDir, hook_event_name: 'Stop' }));
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr, stdout })));
  t.after(() => child.kill('SIGKILL'));
  return { child, done, exited: () => child.exitCode !== null || child.signalCode !== null };
}
const running = async (w, ms = 700) => { await sleep(ms); return !w.exited(); };

function hook(e, session, prompt = 'next') {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: e.projectDir, THREAD_DATA_DIR: e.dataDir };
  const input = JSON.stringify({ cwd: e.projectDir, hook_event_name: 'UserPromptSubmit', session_id: session, prompt });
  return runNode([HOOK_PATH, 'UserPromptSubmit'], { env, input, cwd: e.projectDir });
}
const confirmCodeOf = (r) => /confirm_code "([0-9a-f]+)"/.exec(r.text)?.[1];
const context = (r) => (r.stdout.trim() ? JSON.parse(r.stdout.trim()).hookSpecificOutput.additionalContext : '');

// ---------------------------------------------------------------- the setting

test('wake is off by default, follows the project over the global file, and rejects a value that is not true or false', async (t) => {
  const e = setupThreadEnv(t);
  assert.equal(core.readConfig(e.projectDir).wake, false);
  assert.equal(core.readConfig(e.projectDir).source.wake, 'default');
  await core.saveConfig(e.projectDir, 'global', { wake: true });
  assert.equal(core.readConfig(e.projectDir).wake, true);
  assert.equal(core.readConfig(e.projectDir).source.wake, 'global');
  await core.saveConfig(e.projectDir, 'project', { wake: false, mode: 'chat' });
  assert.equal(core.readConfig(e.projectDir).wake, false);
  assert.equal(core.readConfig(e.projectDir).source.wake, 'project');
  await core.saveConfig(e.projectDir, 'project', { wake: null });
  assert.equal(core.readConfig(e.projectDir).wake, true, 'null removes it from the project file');
  assert.equal(core.readConfig(e.projectDir).mode, 'chat', 'the other settings of the file stay');
  assert.throws(() => core.validateConfig({ wake: 'yes' }), /wake must be true or false/);
  fs.writeFileSync(core.configPaths(e.projectDir).project, JSON.stringify({ wake: 1 }));
  assert.equal(core.readConfig(e.projectDir).invalid.project, 'wake must be true or false');
});

test('config_set and config_get change and show wake', async (t) => {
  const e = setupThreadEnv(t);
  const c = new McpClient(e);
  t.after(() => c.kill());
  await c.init();
  assert.match((await c.call('config_get')).text, /Wake the session from the board: off .* from default/);
  const set = await c.call('config_set', { scope: 'project', wake: true, confirm_code: confirmCodeOf(await c.call('config_set', { scope: 'project', wake: true })) });
  assert.equal(set.isError, false, set.text);
  assert.match(set.text, /Wake the session from the board: on .* from project config file/);
  assert.equal(core.readConfig(e.projectDir).wake, true);
  assert.equal(JSON.parse(fs.readFileSync(core.configPaths(e.projectDir).project, 'utf8')).wake, true);
  assert.equal((await c.call('config_set', { scope: 'project', wake: 'yes' })).isError, true);
  assert.equal((await c.call('config_set', { scope: 'project', wake: true, reset: true })).isError, true);
  assert.equal((await c.call('config_set', { scope: 'project', wake: null })).isError, false);
  assert.equal(core.readConfig(e.projectDir).wake, false);
});

test('hooks.json runs the waiter on Stop in the background with a long timeout, and quotes the plugin root', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const entry = hooks.Stop[0].hooks[0];
  assert.equal(entry.type, 'command');
  assert.equal(entry.asyncRewake, true);
  assert.ok(entry.timeout >= 86400, 'the timeout is enforced on an asyncRewake hook, so it is long');
  assert.equal(entry.command, 'node "${CLAUDE_PLUGIN_ROOT}/scripts/waiter.mjs"');
});

// ---------------------------------------------------------------- the waiter exits at once

test('wake off: the waiter exits 0 at once and leaves no file', async (t) => {
  const e = await world(t, { wake: false });
  await answer(e);
  const r = await startWaiter(t, e).done;
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  assert.deepEqual(waiterFiles(e), []);
});

test('inside a side thread the waiter exits 0, even with an answer pending', async (t) => {
  const e = await world(t);
  await answer(e);
  const r = await startWaiter(t, e, { env: { THREAD_DEPTH: '1' } }).done;
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
});

test('no session id, a bad id or unreadable input: exit 0', async (t) => {
  const e = await world(t);
  await answer(e);
  for (const input of [JSON.stringify({ cwd: e.projectDir }), JSON.stringify({ session_id: 'x', cwd: e.projectDir }), 'not json', '']) {
    const r = await startWaiter(t, e, { input }).done;
    assert.equal(r.code, 0, input);
    assert.equal(r.stderr, '');
  }
});

test('a chat-only project with no thread: exit 0; with a thread, a report click still wakes', async (t) => {
  const e = setupThreadEnv(t);
  await core.saveConfig(e.projectDir, 'project', { wake: true, mode: 'chat' });
  assert.equal((await startWaiter(t, e).done).code, 0);
  assert.deepEqual(waiterFiles(e), []);
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [threadCard({ id: 'c1' }, { reportRequestedAt: new Date().toISOString() })]));
  const r = await startWaiter(t, e).done;
  assert.equal(r.code, 2);
});

test('the waiter gives up after the idle cap', async (t) => {
  const e = await world(t);
  const r = await startWaiter(t, e, { env: { THREAD_WAKE_IDLE_MS: '400' } }).done;
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
});

test('with no state file yet, or a corrupt one, the waiter keeps waiting and does not wake', async (t) => {
  const e = setupThreadEnv(t);
  await core.saveConfig(e.projectDir, 'project', { wake: true });
  const w = startWaiter(t, e);
  assert.equal(await running(w), true);
  fs.writeFileSync(core.projectPaths(e.projectDir).state, '{ half');
  assert.equal(await running(w, 400), true, 'a corrupt state file is not a reason to leave or to wake');
  w.child.kill('SIGKILL');
  await w.done;
});

// ---------------------------------------------------------------- an answer

test('a pending answer wakes at once: exit 2 with the instruction on stderr, and nothing marked delivered', async (t) => {
  const e = await world(t);
  await answer(e);
  const r = await startWaiter(t, e).done;
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^\[thread\] Not an error: the user acted on the thread board while you were idle\./);
  assert.match(r.stderr, /act on them now, as if they had typed them/);
  assert.doesNotMatch(r.stderr, /wait_list|thread_status/, 'no fallback that sends a turn looking for work');
  assert.equal(r.stdout, '');
  assert.equal(itemOf(e, 'c1.w1').deliveredAt, undefined, 'the UserPromptSubmit hook delivers it, not the waiter');
});

test('an answer that arrives after the waiter started wakes it', async (t) => {
  const e = await world(t);
  const w = startWaiter(t, e);
  await waitFor(() => waiterFiles(e).length === 1);
  assert.equal(await running(w, 400), true);
  await answer(e);
  const r = await w.done;
  assert.equal(r.code, 2);
});

test('another session\'s answer, an open item and an answer already delivered do not wake', async (t) => {
  const e = await world(t);
  await core.addWait(e.projectDir, { card: 'c1', kind: 'todo', text: 'Theirs', sessionId: OTHER_SESSION });
  await core.addWait(e.projectDir, { card: 'c1', kind: 'todo', text: 'Done already', sessionId: PARENT_SESSION });
  await core.closeWait(e.projectDir, 'c1.w3', { answeredInChat: 'in the chat' });
  const w = startWaiter(t, e);
  await core.answerWait(e.projectDir, 'c1', 'c1.w2', { done: true });
  assert.equal(await running(w, 800), true, 'c1.w1 is open, c1.w2 is for the other session, c1.w3 was answered in the chat');
  w.child.kill('SIGKILL');
  await w.done;
  assert.equal(itemOf(e, 'c1.w2').deliveredAt, undefined);
});

test('a second waiter for the session replaces the first, and only the second wakes', async (t) => {
  const e = await world(t);
  const first = startWaiter(t, e);
  await waitFor(() => waiterFiles(e).length === 1);
  const second = startWaiter(t, e);
  const r1 = await first.done;
  assert.equal(r1.code, 0, 'the older waiter notices it was replaced and leaves quietly');
  assert.equal(r1.stderr, '');
  assert.equal(waiterFiles(e).length, 1);
  assert.equal(second.exited(), false);
  await answer(e);
  assert.equal((await second.done).code, 2);
});

test('waiters of two sessions do not replace each other', async (t) => {
  const e = await world(t);
  const mine = startWaiter(t, e);
  const theirs = startWaiter(t, e, { session: OTHER_SESSION });
  await waitFor(() => waiterFiles(e).length === 2);
  assert.equal(await running(mine, 500), true);
  assert.equal(theirs.exited(), false);
  await answer(e);
  assert.equal((await mine.done).code, 2);
  assert.equal(theirs.exited(), false);
  theirs.child.kill('SIGKILL');
  await theirs.done;
});

test('the UserPromptSubmit hook stops the waiter when a turn starts', async (t) => {
  const e = await world(t);
  const w = startWaiter(t, e);
  await waitFor(() => waiterFiles(e).length === 1);
  const r = await hook(e, PARENT_SESSION, 'typed by the user');
  assert.equal(r.code, 0);
  const done = await w.done;
  assert.equal(done.code, 0, 'a turn started, so the idle waiter leaves');
  assert.equal(done.stderr, '');
  // a hook of another session leaves this one's waiter alone
  await sleep(50);   // the turn that the hook started is over by the time the next Stop starts a waiter
  const w2 = startWaiter(t, e);
  await waitFor(() => waiterFiles(e).length === 1 && !w2.exited());
  await hook(e, OTHER_SESSION, 'typed elsewhere');
  assert.equal(await running(w2, 500), true);
  w2.child.kill('SIGKILL');
  await w2.done;
});

test('the woken turn delivers the answer once; a later typed prompt does not carry it again, and the next waiter stays quiet', async (t) => {
  const e = await world(t);
  const w = startWaiter(t, e);
  await waitFor(() => waiterFiles(e).length === 1);
  await answer(e);
  const woke = await w.done;
  assert.equal(woke.code, 2);
  // what Claude Code gives the hook on the woken turn: a task-notification block and the system-reminder with the stderr
  const wokenPrompt = `<task-notification>Stop hook</task-notification>\n<system-reminder>Stop hook blocking error from command "Stop": ${woke.stderr.trim()}</system-reminder>`;
  const first = context(await hook(e, PARENT_SESSION, wokenPrompt));
  assert.match(first, /^This turn was started by the thread board, not typed by the user\./);
  assert.match(first, /The user answered c1\.w1 on the board \("Which retry limit\?"\): "three"\. Continue with it\./);
  assert.ok(itemOf(e, 'c1.w1').deliveredAt);
  assert.equal(context(await hook(e, PARENT_SESSION, 'a typed prompt')), '');
  await sleep(50);
  const next = startWaiter(t, e);
  assert.equal(await running(next, 600), true, 'the delivered answer wakes nobody');
  next.child.kill('SIGKILL');
  await next.done;
});

test('a woken turn with nothing left to deliver is told so; a typed prompt gets no such line', async (t) => {
  const e = await world(t);
  await answer(e);
  const woke = await startWaiter(t, e).done;
  assert.equal(woke.code, 2);
  await core.deliverWaitAnswers(e.projectDir, PARENT_SESSION);   // delivered meanwhile, say by a typed prompt on another path
  assert.match(context(await hook(e, PARENT_SESSION, woke.stderr)), /nothing more to act on/);
  assert.equal(context(await hook(e, PARENT_SESSION, 'hello')), '');
});

test('an answer the woken turn failed to deliver wakes the session only once', async (t) => {
  const e = await world(t);
  await answer(e);
  assert.equal((await startWaiter(t, e).done).code, 2);
  const again = startWaiter(t, e);
  assert.equal(await running(again, 700), true, 'no wake loop');
  // the answer is still undelivered, so the next typed prompt carries it
  again.child.kill('SIGKILL');
  await again.done;
  assert.match(context(await hook(e, PARENT_SESSION)), /The user answered c1\.w1/);
});

// ---------------------------------------------------------------- a report click

async function threadWorld(t) {
  const e = setupThreadEnv(t);
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [threadCard({ id: 'c1', title: 'Zebra research' })]));
  await core.saveConfig(e.projectDir, 'project', { wake: true });
  return e;
}

test('a report click wakes once: reportPushedAt is set, and the same click does not wake again', async (t) => {
  const e = await threadWorld(t);
  const w = startWaiter(t, e);
  await waitFor(() => waiterFiles(e).length === 1);
  assert.equal(await running(w, 300), true, 'nothing was clicked');
  await core.requestReport(e.projectDir, 'c1');
  const r = await w.done;
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^\[thread\] Not an error/);
  const th = cardOf(e, 'c1').thread;
  assert.ok(th.reportRequestedAt && th.reportPushedAt && th.reportPushedAt >= th.reportRequestedAt);
  assert.equal(th.reportPushedFor, th.reportRequestedAt, 'the push is remembered as the request it was for');
  const again = startWaiter(t, e);
  assert.equal(await running(again, 700), true, 'the same click wakes nobody twice');
  // a second click is a new request
  await sleep(5);
  await core.requestReport(e.projectDir, 'c1');
  assert.equal((await again.done).code, 2);
});

test('the woken turn adds the report request, which stays until the report is made', async (t) => {
  const e = await threadWorld(t);
  await core.requestReport(e.projectDir, 'c1');
  const woke = await startWaiter(t, e).done;
  assert.equal(woke.code, 2);
  const ctx = context(await hook(e, PARENT_SESSION, `[thread] Not an error: the user acted on the thread board\n${woke.stderr}`));
  assert.match(ctx, /^This turn was started by the thread board/);
  assert.match(ctx, /Call thread_report with id "c1" now and give them the digest\./);
  await core.reportThread(e.projectDir, 'c1');
  assert.equal(cardOf(e, 'c1').thread.reportRequestedAt, undefined);
});

test('a report click for another session\'s thread, or for a thread already reported, wakes nobody', async (t) => {
  const e = setupThreadEnv(t);
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [
    threadCard({ id: 'c1' }, { parentSessionId: OTHER_SESSION, reportRequestedAt: new Date().toISOString() }),
    threadCard({ id: 'c2' }, { reported: true, reportRequestedAt: new Date().toISOString() }),
  ]));
  await core.saveConfig(e.projectDir, 'project', { wake: true });
  const w = startWaiter(t, e);
  assert.equal(await running(w, 700), true);
  w.child.kill('SIGKILL');
  await w.done;
  assert.equal(cardOf(e, 'c1').thread.reportPushedAt, undefined);
});

// ---------------------------------------------------------------- an older version

const WAKE_WRITER = path.join(TEST_DIR, 'fixtures', 'old-wake-writer.mjs');

for (const ref of RELEASED_REFS) test(`the plugin version at ${ref} reads a config with wake, and keeps reportPushedAt when it writes the thread`, async (t) => {
  const old = oldServerFrom(t, ref);
  if (!old) return;
  const e = setupThreadEnv(t);
  const pushed = '2026-10-14T03:05:00.000Z';
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [threadCard({ id: 'c1' }, { reportRequestedAt: '2026-10-14T03:04:00.000Z', reportPushedAt: pushed })]));
  await core.saveConfig(e.projectDir, 'project', { wake: true, mode: 'tasks' });
  const r = await runNode([WAKE_WRITER, old, e.projectDir], { env: { ...process.env, THREAD_DATA_DIR: e.dataDir } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'tasks', 'the older version reads the file and ignores the key');
  const th = cardOf(e, 'c1').thread;
  assert.equal(th.reportPushedAt, pushed, 'the older version kept the field');
  assert.ok(th.reportRequestedAt > pushed, 'its own click request is newer, so this version wakes for it');
  assert.deepEqual(pendingWake(e.projectDir, PARENT_SESSION).reports, ['c1']);
});

// ---------------------------------------------------------------- a run nobody attends

// Claude Code runs an asyncRewake hook in the foreground in `claude -p` (see the top of scripts/waiter.mjs), so a waiter that
// stayed would hold the run up for as long as it lives. A pending answer makes the difference visible: a waiter that did not
// leave at once would wake the session (exit 2).
test('headless run: with CLAUDE_CODE_SESSION_ATTENDED=0 the waiter exits 0 at once, even with an answer pending, and leaves no file', async (t) => {
  const e = await world(t);
  await answer(e);
  const r = await startWaiter(t, e, { env: { CLAUDE_CODE_SESSION_ATTENDED: '0' } }).done;
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  assert.deepEqual(waiterFiles(e), []);
});

test('headless run: where CLAUDE_CODE_SESSION_ATTENDED is not set, an sdk entry point counts as unattended; an attended session is never skipped', async (t) => {
  const cases = [
    [{ CLAUDE_CODE_SESSION_ATTENDED: undefined, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, 0],
    [{ CLAUDE_CODE_SESSION_ATTENDED: undefined, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }, 0],
    [{ CLAUDE_CODE_SESSION_ATTENDED: '1', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, 2],   // the attended flag wins over the entry point
    [{ CLAUDE_CODE_SESSION_ATTENDED: undefined, CLAUDE_CODE_ENTRYPOINT: 'cli' }, 2],
    [{ CLAUDE_CODE_SESSION_ATTENDED: undefined, CLAUDE_CODE_ENTRYPOINT: undefined }, 2],
  ];
  for (const [env, code] of cases) {
    const e = await world(t);
    await answer(e);
    const r = await startWaiter(t, e, { env }).done;
    assert.equal(r.code, code, JSON.stringify(env));
  }
});

test('headless run: the prompt hook writes no waiter file either', async (t) => {
  const e = await world(t);
  const env = { ...process.env, CLAUDE_PROJECT_DIR: e.projectDir, THREAD_DATA_DIR: e.dataDir, CLAUDE_CODE_SESSION_ATTENDED: '0' };
  const input = JSON.stringify({ cwd: e.projectDir, hook_event_name: 'UserPromptSubmit', session_id: PARENT_SESSION, prompt: 'say ok' });
  assert.equal((await runNode([HOOK_PATH, 'UserPromptSubmit'], { env, input, cwd: e.projectDir })).code, 0);
  assert.deepEqual(waiterFiles(e), [], 'a `claude -p` run leaves nothing behind');
});

// ---------------------------------------------------------------- what makes a turn a woken turn

test('a typed prompt that quotes the waiter\'s message is not a woken turn, with waking on or off', async (t) => {
  const quote = 'You said "[thread] Not an error: the user acted on the thread board while you were idle" earlier, what did that mean?';
  for (const wake of [true, false]) {
    const e = await world(t, { wake });
    await core.addCard(e.projectDir, { title: 'From the user', source: 'user' });
    await answer(e);
    const ctx = context(await hook(e, PARENT_SESSION, quote));
    assert.doesNotMatch(ctx, /started by the thread board/, `wake ${wake}`);
    assert.match(ctx, /The user answered c1\.w1/, 'the answer is still delivered, as on any typed prompt');
    assert.match(ctx, /new board card/);
  }
});

test('the woken turn is recognised once: the record is cleared, expires after two minutes, and needs waking on', async (t) => {
  const e = await world(t);
  await answer(e);
  const woke = await startWaiter(t, e).done;
  assert.equal(woke.code, 2);
  assert.ok(JSON.parse(fs.readFileSync(path.join(core.projectPaths(e.projectDir).dir, `waiter-${PARENT_SESSION}.json`), 'utf8')).wokeAt, 'the waiter wrote when it woke the session');
  assert.match(context(await hook(e, PARENT_SESSION, 'whatever the harness shows')), /^This turn was started by the thread board/);
  const file = path.join(core.projectPaths(e.projectDir).dir, `waiter-${PARENT_SESSION}.json`);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).wokeAt, undefined, 'taken by the woken turn');
  await core.addCard(e.projectDir, { title: 'Later', source: 'user' });
  assert.doesNotMatch(context(await hook(e, PARENT_SESSION, 'a typed prompt right after')), /started by the thread board/);
  // a record older than two minutes is stale
  fs.writeFileSync(file, JSON.stringify({ token: null, fired: [], wokeAt: Date.now() - 3 * 60 * 1000 }));
  await core.addCard(e.projectDir, { title: 'Stale', source: 'user' });
  assert.doesNotMatch(context(await hook(e, PARENT_SESSION, 'typed')), /started by the thread board/);
  // a fresh record does not count once waking is off
  fs.writeFileSync(file, JSON.stringify({ token: null, fired: [], wokeAt: Date.now() }));
  await core.saveConfig(e.projectDir, 'project', { wake: false });
  await core.addCard(e.projectDir, { title: 'Off', source: 'user' });
  assert.doesNotMatch(context(await hook(e, PARENT_SESSION, 'typed')), /started by the thread board/);
});

test('a report click wake is recorded as a woken turn too', async (t) => {
  const e = await threadWorld(t);
  await core.requestReport(e.projectDir, 'c1');
  assert.equal((await startWaiter(t, e).done).code, 2);
  assert.match(context(await hook(e, PARENT_SESSION, 'x')), /^This turn was started by the thread board/);
});

test('only the answers and the report clicks are to be acted on in a woken turn; other notices stay information', async (t) => {
  const e = await world(t);
  await core.addCard(e.projectDir, { title: 'Look at the login page', source: 'user' });
  const tc = threadCard({ id: 'c3', title: 'Zebra research' });
  const st = stateOf(e);
  writeStateFile(e.dataDir, e.projectDir, { ...st, seq: 3, cards: [...st.cards, tc] });
  await answer(e);
  const woke = await startWaiter(t, e).done;
  assert.equal(woke.code, 2);
  const ctx = context(await hook(e, PARENT_SESSION, 'x'));
  const act = ctx.indexOf('act on these lines now');
  const answerAt = ctx.indexOf('The user answered c1.w1');
  const info = ctx.indexOf('Other notices, for information only');
  const cards = ctx.indexOf('new board card');
  const finished = ctx.indexOf('Thread c3');
  assert.ok(act >= 0 && answerAt > act && info > answerAt, ctx);
  assert.ok(cards > info && finished > info, 'the notices come after the line that says they are information');
  assert.doesNotMatch(ctx.slice(0, info), /new board card|Thread c3/);
  // a typed prompt: no lead at all
  await core.addCard(e.projectDir, { title: 'Another', source: 'user' });
  assert.doesNotMatch(context(await hook(e, PARENT_SESSION, 'typed')), /act on these lines|Other notices/);
});

test('a woken turn that has only notices says there is nothing to act on, and the notices are information', async (t) => {
  const e = await world(t);
  await answer(e);
  const woke = await startWaiter(t, e).done;
  assert.equal(woke.code, 2);
  await core.deliverWaitAnswers(e.projectDir, PARENT_SESSION);
  await core.addCard(e.projectDir, { title: 'Look at the login page', source: 'user' });
  const ctx = context(await hook(e, PARENT_SESSION, 'x'));
  assert.match(ctx, /nothing to act on/);
  assert.doesNotMatch(ctx, /act on these lines now/);
  assert.match(ctx, /Other notices, for information only[^\n]*\n.*new board card/);
});

// ---------------------------------------------------------------- the race with the prompt hook

test('a waiter whose process started before a turn began, but claims after it, leaves at once instead of waiting into the busy turn', async (t) => {
  const e = await world(t);
  await answer(e);   // a wake would be tempting
  // The Stop hook has started the process, which is slow to get to its claim (here: its input has not arrived yet) ...
  const child = spawn(process.execPath, [WAITER], { env: { ...process.env, CLAUDE_PROJECT_DIR: e.projectDir, THREAD_DATA_DIR: e.dataDir, THREAD_WAKE_POLL_MS: '100' }, cwd: e.projectDir, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.on('error', () => {});
  const closed = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  await sleep(500);
  // ... and the next turn's prompt hook runs first.
  await hook(e, PARENT_SESSION, 'typed at once');
  await sleep(50);
  child.stdin.end(JSON.stringify({ session_id: PARENT_SESSION, cwd: e.projectDir, hook_event_name: 'Stop' }));
  assert.equal(await closed, 0, 'it must not wake the busy turn');
  assert.equal(stderr, '');
});

test('a waiter that starts after a turn that took a while is the idle session\'s waiter and waits', async (t) => {
  const e = await world(t);
  const file = path.join(core.projectPaths(e.projectDir).dir, `waiter-${PARENT_SESSION}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ token: null, fired: [], turnStartedAt: Date.now() - 5000 }));
  const w = startWaiter(t, e);
  assert.equal(await running(w, 500), true, 'the turn that started 5 s ago is over');
  await answer(e);
  assert.equal((await w.done).code, 2);
});

test('a prompt hook on a session with no waiter file writes the turn marker only while waking is on', async (t) => {
  const on = await world(t);
  await hook(on, PARENT_SESSION, 'typed');
  assert.equal(waiterFiles(on).length, 1);
  assert.ok(JSON.parse(fs.readFileSync(path.join(core.projectPaths(on.projectDir).dir, waiterFiles(on)[0]), 'utf8')).turnStartedAt);
  const off = await world(t, { wake: false });
  await hook(off, PARENT_SESSION, 'typed');
  assert.deepEqual(waiterFiles(off), [], 'off means nothing is written');
});

test('the waiter re-checks the turn marker on every tick', async (t) => {
  const e = await world(t);
  const w = startWaiter(t, e);
  await waitFor(() => waiterFiles(e).length === 1);
  // a prompt hook that kept the token (as an older one would) but recorded a later turn
  const file = path.join(core.projectPaths(e.projectDir).dir, waiterFiles(e)[0]);
  const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...cur, turnStartedAt: Date.now() + 1000 }));
  const r = await w.done;
  assert.equal(r.code, 0);
});

// ---------------------------------------------------------------- the waiter does not outlive Claude Code

const parentFixture = path.join(TEST_DIR, 'fixtures', 'waiter-parent.mjs');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function holdParent(t) {
  const p = spawn(process.execPath, [parentFixture, 'hold'], { stdio: 'ignore' });
  t.after(() => p.kill('SIGKILL'));
  return p;
}

test('the waiter exits when its parent process is killed', async (t) => {
  const e = await world(t);
  const env = { ...process.env, CLAUDE_PROJECT_DIR: e.projectDir, THREAD_DATA_DIR: e.dataDir, THREAD_WAKE_POLL_MS: '100' };
  const parent = spawn(process.execPath, [parentFixture, 'spawn', WAITER], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  t.after(() => parent.kill('SIGKILL'));
  let out = '';
  parent.stdout.on('data', (d) => (out += d));
  parent.stdin.end(JSON.stringify({ session_id: PARENT_SESSION, cwd: e.projectDir, hook_event_name: 'Stop' }));
  await waitFor(() => /^\d+\n/.test(out) && waiterFiles(e).length === 1);
  const pid = Number(out.trim());
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
  assert.equal(alive(pid), true);
  parent.kill('SIGKILL');
  await waitFor(() => !alive(pid), 5000);
});

test('behind a shell wrapper (the parent stays alive), the waiter exits when Claude Code, named by CLAUDE_PID, is gone', async (t) => {
  const e = await world(t);
  const claude = holdParent(t);
  const env = { ...process.env, CLAUDE_PROJECT_DIR: e.projectDir, THREAD_DATA_DIR: e.dataDir, THREAD_WAKE_POLL_MS: '100', CLAUDE_PID: String(claude.pid) };
  const shell = spawn('/bin/sh', ['-c', `"${process.execPath}" "${WAITER}"; echo done > /dev/null`], { env, stdio: ['pipe', 'ignore', 'ignore'] });
  t.after(() => shell.kill('SIGKILL'));
  shell.stdin.end(JSON.stringify({ session_id: PARENT_SESSION, cwd: e.projectDir, hook_event_name: 'Stop' }));
  await waitFor(() => waiterFiles(e).length === 1);
  const pid = JSON.parse(fs.readFileSync(path.join(core.projectPaths(e.projectDir).dir, waiterFiles(e)[0]), 'utf8')).pid;
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
  assert.notEqual(pid, shell.pid, 'the shell is the waiter\'s parent, not the waiter');
  await sleep(400);
  assert.equal(alive(pid), true, 'Claude Code is still there');
  claude.kill('SIGKILL');
  await waitFor(() => !alive(pid), 5000);
});

// ---------------------------------------------------------------- smaller

test('wake switched off while the waiter waits: it leaves without waking, even when an answer comes', async (t) => {
  const e = await world(t);
  const w = startWaiter(t, e);
  await waitFor(() => waiterFiles(e).length === 1);
  assert.equal(await running(w, 300), true);
  await core.saveConfig(e.projectDir, 'project', { wake: false });
  await answer(e);
  const r = await w.done;
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  assert.equal(itemOf(e, 'c1.w1').deliveredAt, undefined);
});

test('wake switched off while waiting with nothing pending: the waiter leaves on its next look', async (t) => {
  const e = await world(t);
  const w = startWaiter(t, e);
  await waitFor(() => waiterFiles(e).length === 1);
  await core.saveConfig(e.projectDir, 'project', { wake: false });
  assert.equal((await w.done).code, 0);
});

test('a report click is told apart by the request it was pushed for, so a clock that steps back cannot wake it twice', (t) => {
  const card = (over) => threadCard({ id: 'c1' }, { reportRequestedAt: '2026-10-14T03:04:00.000Z', ...over });
  const e = setupThreadEnv(t);
  const check = (c) => {
    writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [c]));
    return pendingWake(e.projectDir, PARENT_SESSION).reports;
  };
  assert.deepEqual(check(card({})), ['c1'], 'a click nobody pushed');
  assert.deepEqual(check(card({ reportPushedFor: '2026-10-14T03:04:00.000Z', reportPushedAt: '2026-10-14T03:00:00.000Z' })), [], 'pushed for this click, even though the push time reads earlier (a clock that stepped back)');
  assert.deepEqual(check(card({ reportPushedFor: '2026-10-14T03:00:00.000Z', reportPushedAt: '2026-10-14T09:00:00.000Z' })), ['c1'], 'pushed for an earlier click: this one is new');
  assert.deepEqual(check(card({ reportPushedAt: '2026-10-14T03:05:00.000Z' })), [], 'an older build wrote only the time: still read');
  assert.deepEqual(check(card({ reportPushedAt: '2026-10-14T03:00:00.000Z' })), ['c1']);
});

// ---------------------------------------------------------------- turning waking on needs the user's yes

test('config_set wake: true answers CONFIRMATION REQUIRED, saves nothing, and only a second call with the code saves', async (t) => {
  const e = setupThreadEnv(t);
  const c = new McpClient(e);
  t.after(() => c.kill());
  await c.init();
  const first = await c.call('config_set', { scope: 'project', wake: true, mode: 'chat' });
  assert.equal(first.isError, false);
  assert.match(first.text, /^CONFIRMATION REQUIRED/);
  const code = confirmCodeOf(first);
  assert.ok(code);
  assert.equal(core.readConfig(e.projectDir).wake, false);
  assert.equal(core.readConfig(e.projectDir).mode, 'tasks', 'the other settings of the call are not saved either');
  assert.equal(core.readConfig(e.projectDir).configured, false);
  // a wrong code, and a code for the other scope, get a new question
  const wrong = await c.call('config_set', { scope: 'project', wake: true, confirm_code: 'deadbeef' });
  assert.match(wrong.text, /^CONFIRMATION REQUIRED/);
  const code2 = confirmCodeOf(wrong);
  assert.notEqual(code2, code);
  assert.match((await c.call('config_set', { scope: 'project', wake: true, confirm_code: code })).text, /^CONFIRMATION REQUIRED/, 'the earlier code is void');
  const code3 = confirmCodeOf(await c.call('config_set', { scope: 'global', wake: true }));
  assert.match((await c.call('config_set', { scope: 'project', wake: true, confirm_code: code3 })).text, /^CONFIRMATION REQUIRED/, 'a code belongs to one scope');
  assert.equal(core.readConfig(e.projectDir).wake, false);
  // the right code saves, with the other settings, and works once
  const code4 = confirmCodeOf(await c.call('config_set', { scope: 'project', wake: true }));
  const ok = await c.call('config_set', { scope: 'project', wake: true, mode: 'chat', confirm_code: code4 });
  assert.equal(ok.isError, false, ok.text);
  assert.match(ok.text, /Saved to the project config file/);
  assert.equal(core.readConfig(e.projectDir).wake, true);
  assert.equal(core.readConfig(e.projectDir).mode, 'chat');
  assert.match((await c.call('config_set', { scope: 'project', wake: true, confirm_code: code4 })).text, /^CONFIRMATION REQUIRED/, 'a code works once');
  // turning it off, or removing it, needs no question
  const off = await c.call('config_set', { scope: 'project', wake: false });
  assert.match(off.text, /Saved to the project config file/);
  assert.equal(core.readConfig(e.projectDir).wake, false);
  const gone = await c.call('config_set', { scope: 'project', wake: null });
  assert.match(gone.text, /Saved to the project config file/);
});

test('config_set wake: true is refused inside a side thread, with or without a code', async (t) => {
  const e = setupThreadEnv(t);
  const c = new McpClient(e, { THREAD_DEPTH: '1' });
  t.after(() => c.kill());
  await c.init();
  for (const args of [{ scope: 'project', wake: true }, { scope: 'project', wake: true, confirm_code: 'deadbeef' }]) {
    const r = await c.call('config_set', args);
    assert.equal(r.isError, true);
    assert.match(r.text, /side thread cannot change the plugin settings/);
  }
  assert.equal(core.readConfig(e.projectDir).wake, false);
});

test('the config_set tool and the setup skill tell Claude to ask the user before it passes the code', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'setup', 'SKILL.md'), 'utf8');
  assert.match(skill, /CONFIRMATION REQUIRED/);
  assert.match(skill, /only after they agree/);
});
