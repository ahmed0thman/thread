// Full access: a card's `allowFull` switch (the user's, on this machine's board) and the thread mode "full" it opens (no sandbox, no permission
// checks). The claude CLI is test/fake-claude.mjs and the lanes' relays are the fakes in test/fake-delegate; nothing real is started.
import { test as baseTest } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setupThreadEnv, cleanAmbientEnv, waitFor, runNode, McpClient, PARENT_SESSION, FAKE_DELEGATE, ROOT, TEST_DIR, oldServerFrom, writeStateFile, emptyState, threadCard } from './helpers.mjs';
import * as core from '../server/core.mjs';
import { clearLanesCache } from '../server/lanes.mjs';
import { startBoardServer, closeBoardServer } from '../server/http.mjs';

cleanAmbientEnv();

const HAVE_GIT = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const gitTest = HAVE_GIT ? baseTest : baseTest.skip;
const test = baseTest;

const card = (dir, id = 'c1') => core.readState(dir).cards.find((c) => c.id === id);
const thread = (dir, id = 'c1') => card(dir, id)?.thread;
const untilIdle = (e, id = 'c1') => waitFor(() => thread(e.projectDir, id)?.runState === 'idle', { timeout: 15000 });
const has = (argv, ...flags) => flags.every((f) => argv.includes(f));
const valueOf = (argv, flag) => argv[argv.indexOf(flag) + 1];
const NOT_ALLOWED = /full access is not allowed for c[0-9a-z]+: only the user can allow it, on that card's page on the board \("Allow full access"\)/;

/** Temp data and project dirs, the fake claude, the fake delegate skills and relays (their calls are in e.relays()). */
function setup(t, extra = {}) {
  cleanAmbientEnv();
  clearLanesCache();
  t.after(clearLanesCache);
  const e = setupThreadEnv(t, { THREAD_DELEGATE_DIR: FAKE_DELEGATE, FAKE_DELEGATE_MODE: 'ok', FAKE_RELAY_MODE: 'ok', ...extra });
  e.relayLog = path.join(e.base, 'relay.log');
  e.setEnv('FAKE_RELAY_LOG', e.relayLog);
  e.relays = () => (fs.existsSync(e.relayLog) ? fs.readFileSync(e.relayLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return e;
}

/** The board on port 0 with a token; calls go to this project's routes. */
async function boot(t, e) {
  const token = 'ef'.repeat(16);
  const b = await startBoardServer(e.projectDir, { port: 0, token });
  t.after(() => closeBoardServer(b.server));
  const key = core.projectKey(e.projectDir);
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${b.port}/api/p/${key}/${p}`, { method, headers: { 'X-Thread-Token': token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { patch: (id, body) => call('PATCH', `cards/${id}`, body), post: (p, body) => call('POST', p, body), get: (p) => call('GET', p) };
}

/** A task the user has allowed full access on (the board's own call). */
async function allowed(e, over = {}) {
  const c = await core.addCard(e.projectDir, { title: 'Render the video', note: 'Use the GPU.', source: 'user', ...over });
  await core.updateCard(e.projectDir, c.id, { allowFull: true }, { source: 'user' });
  return c;
}
const startFull = (e, over = {}) => core.startThread(e.projectDir, { title: 'Render', task: 'render it', sessionId: PARENT_SESSION, mode: 'full', card: 'c1', ...over });

// ------------------------------------------------------------ the switch

test('the board route turns allowFull on and off for a task or idea, and the history says so', async (t) => {
  const e = setup(t);
  const b = await boot(t, e);
  const task = await core.addCard(e.projectDir, { title: 'Render', source: 'user' });
  const idea = await core.addCard(e.projectDir, { title: 'Maybe', kind: 'idea', source: 'user' });
  assert.equal(task.allowFull, undefined, 'off by default: the field is absent');
  let r = await b.patch(task.id, { allowFull: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.allowFull, true);
  assert.equal(card(e.projectDir, task.id).allowFull, true);
  let last = card(e.projectDir, task.id).history.at(-1);
  assert.deepEqual([last.type, last.fields, last.allowed, last.by], ['edited', ['full access'], true, 'user']);
  const n = card(e.projectDir, task.id).history.length;
  assert.equal((await b.patch(task.id, { allowFull: true })).status, 200);
  assert.equal(card(e.projectDir, task.id).history.length, n, 'no change, no history entry');
  assert.equal((await b.patch(task.id, { title: 'Render it', note: 'n' })).body.allowFull, true, 'an edit that does not mention it keeps it');
  assert.equal((await b.patch(task.id, { kind: 'idea' })).body.allowFull, true, 'and so does a change of kind');
  r = await b.patch(task.id, { kind: 'task', allowFull: false });
  assert.equal(r.status, 200);
  assert.equal('allowFull' in card(e.projectDir, task.id), false, 'off: the field is gone, not false');
  last = card(e.projectDir, task.id).history.at(-1);
  assert.deepEqual([last.type, last.fields, last.allowed], ['edited', ['full access'], false]);
  assert.equal((await b.patch(idea.id, { allowFull: true })).body.allowFull, true, 'an idea too');
  const state = (await b.get('state')).body.cards.find((c) => c.id === idea.id);
  assert.equal(state.allowFull, true, 'the page is told');
});

test('the board route refuses a value that is not true or false, a milestone, a new card with it, and a thread card turning it on', async (t) => {
  const e = setup(t);
  const b = await boot(t, e);
  const task = await core.addCard(e.projectDir, { title: 'Render', source: 'user' });
  const ms = await core.addCard(e.projectDir, { title: 'M', kind: 'milestone', source: 'user' });
  for (const v of ['yes', 1, null, 'true']) {
    const r = await b.patch(task.id, { allowFull: v });
    assert.equal(r.status, 400, `${JSON.stringify(v)} -> ${r.status}`);
    assert.match(r.body.error, /allowFull must be true or false/);
  }
  const m = await b.patch(ms.id, { allowFull: true });
  assert.equal(m.status, 400);
  assert.match(m.body.error, /a milestone does no work/);
  assert.equal('allowFull' in card(e.projectDir, ms.id), false);
  const made = await b.post('cards', { title: 'New', allowFull: true });
  assert.equal(made.status, 400, 'a new card has no switch: the page sets it on a saved card');
  assert.match(made.body.error, /unknown key allowFull/);
  assert.equal(core.readState(e.projectDir).cards.length, 2, 'nothing was created');
  const started = await core.startThread(e.projectDir, { title: 'T', task: 't', sessionId: PARENT_SESSION });
  const th = await b.patch(started.id, { allowFull: true });
  assert.equal(th.status, 400);
  assert.match(th.body.error, /is a thread: turn full access on for the card before it is started/);
  assert.equal((await b.patch(started.id, { allowFull: false })).status, 200, 'taking it away from a thread card is no change and no error');
});

test('Claude cannot set allowFull: the core refuses a call from Claude, and board_add and board_update refuse the argument and change nothing', async (t) => {
  const e = setup(t);
  const task = await core.addCard(e.projectDir, { title: 'Render', source: 'user' });
  await assert.rejects(core.updateCard(e.projectDir, task.id, { allowFull: true }), /only the user can allow full access, on the card's page on the board/);
  await assert.rejects(core.updateCard(e.projectDir, task.id, { allowFull: false }, { source: 'claude' }), /only the user can allow full access/);
  assert.equal((await core.addCard(e.projectDir, { title: 'Sneaky', allowFull: true })).allowFull, undefined, 'a card Claude adds has no switch');
  const c = new McpClient(e);
  t.after(() => c.kill());
  await c.init();
  const tools = (await c.request('tools/list', {})).result.tools;
  for (const name of ['board_add', 'board_update']) {
    const props = Object.keys(tools.find((x) => x.name === name).inputSchema.properties);
    assert.equal(props.some((p) => /full/i.test(p)), false, `${name} takes no such argument`);
  }
  for (const arg of ['allowFull', 'allow_full']) {
    const upd = await c.call('board_update', { id: task.id, title: 'Renamed', [arg]: true });
    assert.equal(upd.isError, true, arg);
    assert.match(upd.text, /only the user can allow full access, on the card's page on the board; it cannot be set through the tools/);
    const add = await c.call('board_add', { title: 'Sneaky card', [arg]: true });
    assert.equal(add.isError, true, arg);
  }
  const now = card(e.projectDir, task.id);
  assert.equal(now.allowFull, undefined);
  assert.equal(now.title, 'Render', 'a refused call changes nothing at all');
  assert.equal(core.readState(e.projectDir).cards.length, 2, 'and adds no card');
  // the user's switch is shown to Claude, which can then start a full thread for it
  await core.updateCard(e.projectDir, task.id, { allowFull: true }, { source: 'user' });
  assert.match((await c.call('board_list')).text, new RegExp(`- ${task.id} \\[task\\] Render .*\\{full access allowed\\}`));
});

// ------------------------------------------------------------ a repo-backed project: the switch is this machine's

gitTest('allowFull stays on this machine: a repo card file never carries it, and one that says so allows nothing', async (t) => {
  const e = setup(t);
  e.base = fs.realpathSync(e.base);
  e.projectDir = fs.realpathSync(e.projectDir);
  core.resetRepoCache();
  execFileSync('git', ['init', '-q', e.projectDir], { stdio: 'ignore' });
  core.enableRepo(e.projectDir);
  const c = await core.addCard(e.projectDir, { title: 'Render', source: 'user' });
  const file = path.join(e.projectDir, '.claude', 'thread', 'cards', `${c.id}.json`);
  // someone else's commit says the card allows full access
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...doc, allowFull: true }, null, 2) + '\n');
  assert.equal(card(e.projectDir, c.id).allowFull, undefined, 'the join strips it from a file');
  await assert.rejects(core.startThread(e.projectDir, { title: 'Render', task: 'r', sessionId: PARENT_SESSION, mode: 'full', card: c.id }), NOT_ALLOWED);
  await assert.rejects(core.startThreadFromCard(e.projectDir, c.id, { sessionId: PARENT_SESSION, mode: 'full' }), NOT_ALLOWED);
  assert.deepEqual(e.readLog(), [], 'nothing was started');
  // a write from Claude rewrites the file without it
  await core.updateCard(e.projectDir, c.id, { title: 'Render it' }, { source: 'claude' });
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /allowFull/);
  // the user's switch on this board: kept in this machine's record, never in the file
  await core.updateCard(e.projectDir, c.id, { allowFull: true }, { source: 'user' });
  assert.equal(card(e.projectDir, c.id).allowFull, true);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /allowFull/, 'not in the card file');
  const overlay = JSON.parse(fs.readFileSync(core.projectPaths(e.projectDir).repo, 'utf8')).overlay[c.id];
  assert.equal(overlay.allowFull, true, 'in this machine\'s record');
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')).history).includes('full access'), true, 'only the history line, which is display text, is shared');
  const th = await startFull(e, { card: c.id });
  await untilIdle(e, th.id);
  assert.ok(has(e.readLog()[0].argv, '--permission-mode', 'bypassPermissions'));
  // taking it away is local too
  await core.updateCard(e.projectDir, c.id, { allowFull: false }, { source: 'user' });
  assert.equal(card(e.projectDir, c.id).allowFull, undefined);
  assert.equal(JSON.parse(fs.readFileSync(core.projectPaths(e.projectDir).repo, 'utf8')).overlay[c.id].allowFull, undefined);
  await assert.rejects(core.continueThread(e.projectDir, th.id, 'more'), /cannot continue: full access is not allowed/);
  // a repo card started as a thread itself: the thread card is local and keeps the switch
  const own = await core.addCard(e.projectDir, { title: 'Own', note: 'x', source: 'user' });
  await assert.rejects(core.startThreadFromCard(e.projectDir, own.id, { sessionId: PARENT_SESSION, mode: 'full' }), NOT_ALLOWED);
  await core.updateCard(e.projectDir, own.id, { allowFull: true }, { source: 'user' });
  await core.startThreadFromCard(e.projectDir, own.id, { sessionId: PARENT_SESSION, mode: 'full' });
  await untilIdle(e, own.id);
  assert.equal(card(e.projectDir, own.id).allowFull, true);
  assert.equal(valueOf(e.readLog().at(-1).argv, '--permission-mode'), 'bypassPermissions');
});

// ------------------------------------------------------------ starting a full thread

test('thread_start with mode full is refused without a card, for a card without the switch, a milestone and a thread; it runs for a card with it', async (t) => {
  const e = setup(t);
  const c = new McpClient(e);
  t.after(() => c.kill());
  await c.init();
  const task = await core.addCard(e.projectDir, { title: 'Render the video', source: 'user' });
  const args = { title: 'Render', task: 'render it', session_id: PARENT_SESSION, mode: 'full' };
  const noCard = await c.call('thread_start', args);
  assert.equal(noCard.isError, true);
  assert.match(noCard.text, /mode "full" runs with no sandbox and no permission checks, and only for a card the user allowed it on: pass card \(a task or idea\) after the user turned on "Allow full access" on its page on the board/);
  const refused = await c.call('thread_start', { ...args, card: task.id });
  assert.equal(refused.isError, true);
  assert.match(refused.text, NOT_ALLOWED);
  assert.match(refused.text, new RegExp(`for ${task.id}:`));
  const ms = await core.addCard(e.projectDir, { title: 'M', kind: 'milestone' });
  assert.equal((await c.call('thread_start', { ...args, card: ms.id })).isError, true);
  assert.equal((await c.call('thread_start', { ...args, card: 'c999' })).isError, true);
  assert.deepEqual(e.readLog(), [], 'nothing ran');
  assert.equal(core.readState(e.projectDir).cards.filter((x) => x.kind === 'thread').length, 0, 'and no thread card was made');
  await core.updateCard(e.projectDir, task.id, { allowFull: true }, { source: 'user' });
  const ok = await c.call('thread_start', { ...args, card: task.id });
  assert.equal(ok.isError, false, ok.text);
  assert.match(ok.text, /mode full/);
  await untilIdle(e, 'c3');
  assert.match((await c.call('thread_status', { id: 'c3' })).text, /mode full \(full access: no sandbox, no permission checks\)/);
  const desc = (await c.request('tools/list', {})).result.tools.find((x) => x.name === 'thread_start');
  assert.deepEqual(desc.inputSchema.properties.mode.enum, ['read', 'write', 'full']);
  assert.match(desc.inputSchema.properties.mode.description, /"full" runs with no sandbox and no permission checks; only for a card the user allowed it on \(card, or the card started as a thread\)/);
  assert.equal((await c.call('thread_start', { ...args, card: task.id, mode: 'root' })).isError, true, 'other modes are still refused');
});

test('a Claude thread in full mode runs with bypassPermissions and none of the read-mode restrictions; write and read are as before', async (t) => {
  const e = setup(t);
  await allowed(e);
  await startFull(e);
  await untilIdle(e, 'c2');
  const full = e.readLog()[0].argv;
  assert.equal(valueOf(full, '--permission-mode'), 'bypassPermissions');
  assert.equal(full.some((a) => a === 'acceptEdits' || a === 'dontAsk' || a === '--disallowedTools'), false);
  assert.match(e.readLog()[0].prompt, /You may edit files and run commands without a sandbox or permission checks\. Keep changes limited to this task\./);
  assert.equal(thread(e.projectDir, 'c2').mode, 'full');
  assert.equal(thread(e.projectDir, 'c2').forCard, 'c1');
  // the same card, other modes
  await core.startThread(e.projectDir, { title: 'W', task: 'w', sessionId: PARENT_SESSION, mode: 'write', card: 'c1' });
  await core.startThread(e.projectDir, { title: 'R', task: 'r', sessionId: PARENT_SESSION, card: 'c1' });
  await untilIdle(e, 'c3');
  await untilIdle(e, 'c4');
  const modes = e.readLog().slice(1).map((l) => valueOf(l.argv, '--permission-mode')).sort();
  assert.deepEqual(modes, ['acceptEdits', 'dontAsk']);
});

test('a lane thread in full mode gets each provider\'s own flag: codex has no sandbox, claude and agy skip permissions, opencode is as in write mode', async (t) => {
  const e = setup(t);
  await allowed(e);
  const run = async (lane, mode = 'full') => {
    const before = e.relays().length;
    const th = await startFull(e, { lane, mode });
    await untilIdle(e, th.id);
    const calls = e.relays();
    assert.equal(calls.length, before + 1);
    return calls.at(-1).argv;
  };
  const codex = await run('code-codex');
  assert.equal(valueOf(codex, '--sandbox'), 'danger-full-access');
  assert.equal(has(codex, '--read-only', '--dangerously-skip-permissions'), false);
  const claude = await run('claude-edit');
  assert.ok(claude.includes('--dangerously-skip-permissions'));
  assert.equal(has(claude, '--read-only') || claude.includes('--sandbox'), false);
  const agy = await run('agy-fast');
  assert.ok(agy.includes('--dangerously-skip-permissions'), 'agy may edit in full mode');
  assert.equal(agy.includes('--read-only'), false);
  const opencode = await run('ui-open');
  assert.equal(opencode.some((a) => /dangerously|sandbox|read-only/.test(a)), false, 'opencode has no sandbox: the same as write mode');
  // the write-mode argv of the same lanes is unchanged
  const writeCodex = await run('code-codex', 'write');
  assert.equal(valueOf(writeCodex, '--sandbox'), 'workspace-write');
  const writeClaude = await run('claude-edit', 'write');
  assert.equal(writeClaude.includes('--dangerously-skip-permissions'), false);
  // the brief of a full lane turn does not carry the read-only note, and says what it may do
  const last = e.relays().find((r) => r.implementer === 'codex');
  assert.match(last.brief, /You may edit files and run commands without a sandbox or permission checks/);
  assert.equal(/read-only|Do not modify/i.test(last.brief), false);
  // a codex turn that is continued passes the sandbox again
  await core.continueThread(e.projectDir, 'c2', 'more');
  await untilIdle(e, 'c2');
  const again = e.relays().filter((r) => r.implementer === 'codex' && r.argv.includes('--session'))[0].argv;
  assert.equal(valueOf(again, '--sandbox'), 'danger-full-access');
  assert.ok(again.includes('--session'));
});

test('a lane that is read-only refuses full mode like write mode; an agy lane refuses write but not full', async (t) => {
  const e = setup(t);
  await allowed(e);
  await assert.rejects(startFull(e, { lane: 'review-ro' }), /lane "review-ro" is read-only/);
  await assert.rejects(startFull(e, { lane: 'agy-fast', mode: 'write' }), (err) => err.message === 'lane "agy-fast" runs on agy: agy lanes are read-only in this version');
  assert.equal(e.relays().length, 0, 'no relay ran');
  assert.equal(core.readState(e.projectDir).cards.filter((c) => c.kind === 'thread').length, 0);
  const th = await startFull(e, { lane: 'agy-fast' });
  await untilIdle(e, th.id);
  assert.equal(e.relays().length, 1);
  const ro = setup(t, { FAKE_DELEGATE_SANDBOX: 'read-only' });
  await allowed(ro);
  await assert.rejects(startFull(ro, { lane: 'code-codex' }), /lane "code-codex" is read-only/, 'a codex lane with a read-only sandbox too');
  assert.equal(ro.relays().length, 0);
});

// ------------------------------------------------------------ the switch is checked again at every turn

test('a full thread cannot be continued once the user took the switch away, and can again when it is back', async (t) => {
  const e = setup(t);
  await allowed(e);
  await startFull(e);
  await untilIdle(e, 'c2');
  await core.continueThread(e.projectDir, 'c2', 'a second turn');
  await untilIdle(e, 'c2');
  assert.equal(e.readLog().length, 2);
  assert.ok(has(e.readLog()[1].argv, '--resume'));
  assert.equal(valueOf(e.readLog()[1].argv, '--permission-mode'), 'bypassPermissions', 'a resumed turn passes it too');
  await core.updateCard(e.projectDir, 'c1', { allowFull: false }, { source: 'user' });
  await assert.rejects(core.continueThread(e.projectDir, 'c2', 'a third turn'), /thread c2 cannot continue: full access is not allowed for c1: only the user can allow it/);
  const c = new McpClient(e);
  t.after(() => c.kill());
  await c.init();
  const viaTool = await c.call('thread_continue', { id: 'c2', message: 'again', session_id: PARENT_SESSION });
  assert.equal(viaTool.isError, true);
  assert.match(viaTool.text, /full access is not allowed for c1/);
  assert.equal(e.readLog().length, 2, 'no turn was launched');
  assert.equal(thread(e.projectDir, 'c2').turns.length, 2, 'and none was recorded');
  assert.equal(thread(e.projectDir, 'c2').runState, 'idle');
  await core.updateCard(e.projectDir, 'c1', { allowFull: true }, { source: 'user' });
  await core.continueThread(e.projectDir, 'c2', 'a third turn');
  await untilIdle(e, 'c2');
  assert.equal(e.readLog().length, 3);
  // a card that was removed allows nothing
  await core.removeCard(e.projectDir, 'c1', { source: 'user' });
  await assert.rejects(core.continueThread(e.projectDir, 'c2', 'orphan'), /full access is not allowed for c1/);
});

test('a lane thread in full mode is re-checked too, before its lane is even looked at', async (t) => {
  const e = setup(t);
  await allowed(e);
  const th = await startFull(e, { lane: 'code-codex' });
  await untilIdle(e, th.id);
  await core.updateCard(e.projectDir, 'c1', { allowFull: false }, { source: 'user' });
  await assert.rejects(core.continueThread(e.projectDir, th.id, 'more'), /cannot continue: full access is not allowed for c1/);
  assert.equal(e.relays().length, 1);
  await core.updateCard(e.projectDir, 'c1', { allowFull: true }, { source: 'user' });
  await core.continueThread(e.projectDir, th.id, 'more');
  await untilIdle(e, th.id);
  assert.equal(e.relays().length, 2);
  // a write thread on the same card does not care about the switch
  const w = await core.startThread(e.projectDir, { title: 'W', task: 'w', sessionId: PARENT_SESSION, mode: 'write', card: 'c1', lane: 'claude-edit' });
  await untilIdle(e, w.id);
  await core.updateCard(e.projectDir, 'c1', { allowFull: false }, { source: 'user' });
  await core.continueThread(e.projectDir, w.id, 'more');
  await untilIdle(e, w.id);
});

test('a card started as a thread keeps its switch, runs full, and stops being continuable when the user takes the switch away', async (t) => {
  const e = setup(t);
  const plain = await core.addCard(e.projectDir, { title: 'Plain', note: 'brief', source: 'user' });
  await assert.rejects(core.startThreadFromCard(e.projectDir, plain.id, { sessionId: PARENT_SESSION, mode: 'full' }), NOT_ALLOWED);
  assert.equal(card(e.projectDir, plain.id).kind, 'task', 'still a card');
  assert.deepEqual(e.readLog(), []);
  const c = await core.addCard(e.projectDir, { title: 'Render', note: 'Use the GPU.', source: 'user' });
  await core.updateCard(e.projectDir, c.id, { allowFull: true }, { source: 'user' });
  const started = await core.startThreadFromCard(e.projectDir, c.id, { sessionId: PARENT_SESSION, mode: 'full' });
  assert.equal(started.kind, 'thread');
  assert.equal(started.allowFull, true, 'the card itself became the thread and keeps the switch');
  await untilIdle(e, c.id);
  assert.equal(valueOf(e.readLog()[0].argv, '--permission-mode'), 'bypassPermissions');
  await core.continueThread(e.projectDir, c.id, 'more');
  await untilIdle(e, c.id);
  const b = await boot(t, e);
  assert.equal((await b.patch(c.id, { allowFull: false })).status, 200, 'the route takes it away from the thread card');
  await assert.rejects(core.continueThread(e.projectDir, c.id, 'again'), new RegExp(`cannot continue: full access is not allowed for ${c.id}`));
  assert.equal(e.readLog().length, 2);
});

test('the runner checks again as a turn launches: a full record without the switch fails the turn and starts nothing', async (t) => {
  const runner = path.join(ROOT, 'server', 'runner.mjs');
  const turn = [{ prompt: 'p', startedAt: new Date().toISOString(), finishedAt: null, ok: null, result: null, error: null }];
  const record = (e, over = {}, cards = []) => writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [
    ...cards,
    threadCard({ id: 'c1', status: 'in_progress', ...over.card }, { sessionId: null, context: 'brief', brief: '', mode: 'full', runState: 'running', turns: turn, lastResult: null, ...over.thread }),
  ]));
  const task = { id: 'c2', kind: 'task', title: 'T', note: '', status: 'new', source: 'user', seenByClaude: true, createdAt: 'x', updatedAt: 'x' };
  // a thread record that says "full" and no card behind it
  const a = setup(t);
  record(a);
  assert.equal((await runNode([runner, a.projectDir, 'c1'], { env: { ...process.env, THREAD_DATA_DIR: a.dataDir } })).code, 0);
  assert.equal(thread(a.projectDir).runState, 'failed');
  assert.match(thread(a.projectDir).turns[0].error, /^this thread cannot run a turn: full access is not allowed for c1: only the user can allow it/);
  assert.deepEqual(a.readLog(), [], 'the claude CLI was never started');
  // for a card that does not allow it
  const b = setup(t);
  record(b, { thread: { forCard: 'c2' } }, [task]);
  await runNode([runner, b.projectDir, 'c1'], { env: { ...process.env, THREAD_DATA_DIR: b.dataDir } });
  assert.match(thread(b.projectDir).turns[0].error, /full access is not allowed for c2/);
  assert.deepEqual(b.readLog(), []);
  // for a card that does
  const c = setup(t);
  record(c, { thread: { forCard: 'c2' } }, [{ ...task, allowFull: true, allowFullHash: core.contentHash(task) }]);
  await runNode([runner, c.projectDir, 'c1'], { env: { ...process.env, THREAD_DATA_DIR: c.dataDir } });
  assert.equal(thread(c.projectDir).runState, 'idle');
  assert.equal(valueOf(c.readLog()[0].argv, '--permission-mode'), 'bypassPermissions');
  // a lane record too: no relay is run
  const d = setup(t);
  record(d, { thread: { lane: { name: 'code-codex', implementer: 'codex', session: null } } });
  await runNode([runner, d.projectDir, 'c1'], { env: { ...process.env, THREAD_DATA_DIR: d.dataDir } });
  assert.match(thread(d.projectDir).turns[0].error, /full access is not allowed/);
  assert.deepEqual(d.relays(), []);
});

// ------------------------------------------------------------ the board's Start as thread

test('the board\'s Start accepts mode full only for a card that allows it, and the server checks even when the page offered it', async (t) => {
  const e = setup(t);
  await core.touchSession(e.projectDir, PARENT_SESSION, {});
  const b = await boot(t, e);
  const plain = await core.addCard(e.projectDir, { title: 'Plain', note: 'do it', source: 'user' });
  const body = { sessionId: PARENT_SESSION, mode: 'full', context: 'brief' };
  let r = await b.post(`cards/${plain.id}/start`, body);
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, NOT_ALLOWED);
  assert.equal(card(e.projectDir, plain.id).kind, 'task');
  assert.deepEqual(e.readLog(), []);
  // the switch is turned on from the page's own save, then Start takes mode full
  assert.equal((await b.patch(plain.id, { allowFull: true })).status, 200);
  r = await b.post(`cards/${plain.id}/start`, body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.thread.mode, 'full');
  assert.equal(r.body.allowFull, true);
  await untilIdle(e, plain.id);
  assert.equal(valueOf(e.readLog()[0].argv, '--permission-mode'), 'bypassPermissions');
  // a lane card: agy may, a read-only lane may not
  const agy = await core.addCard(e.projectDir, { title: 'Agy', note: 'x', lane: 'agy-fast', source: 'user' });
  await b.patch(agy.id, { allowFull: true });
  const ro = await core.addCard(e.projectDir, { title: 'Ro', note: 'x', lane: 'review-ro', source: 'user' });
  await b.patch(ro.id, { allowFull: true });
  r = await b.post(`cards/${ro.id}/start`, { ...body, expectLane: 'review-ro' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /lane "review-ro" is read-only/);
  r = await b.post(`cards/${agy.id}/start`, { ...body, expectLane: 'agy-fast' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await untilIdle(e, agy.id);
  assert.ok(e.relays()[0].argv.includes('--dangerously-skip-permissions'));
  // the page's own plain modes still work for a card that allows full access
  const again = await core.addCard(e.projectDir, { title: 'Again', note: 'x', source: 'user' });
  await b.patch(again.id, { allowFull: true });
  r = await b.post(`cards/${again.id}/start`, { ...body, mode: 'write' });
  assert.equal(r.status, 200);
  assert.equal(r.body.thread.mode, 'write');
});

// ------------------------------------------------------------ revoking, and what a thread may authorize

/** A project kept in the repo (a plain git folder), with the paths made real. */
function repoProject(t) {
  const e = setup(t);
  e.base = fs.realpathSync(e.base);
  e.projectDir = fs.realpathSync(e.projectDir);
  core.resetRepoCache();
  execFileSync('git', ['init', '-q', e.projectDir], { stdio: 'ignore' });
  core.enableRepo(e.projectDir);
  e.file = (id) => path.join(e.projectDir, '.claude', 'thread', 'cards', `${id}.json`);
  e.overlay = (id) => (JSON.parse(fs.readFileSync(core.projectPaths(e.projectDir).repo, 'utf8')).overlay || {})[id] || {};
  return e;
}

gitTest('a revoke on the thread a repo card became also drops the card\'s own switch: removing the thread later does not bring the card back allowed', async (t) => {
  const e = repoProject(t);
  const c = await core.addCard(e.projectDir, { title: 'Render', note: 'Use the GPU.', source: 'user' });
  await core.updateCard(e.projectDir, c.id, { allowFull: true }, { source: 'user' });
  assert.equal(e.overlay(c.id).allowFull, true, 'the card\'s record holds the switch');
  await core.startThreadFromCard(e.projectDir, c.id, { sessionId: PARENT_SESSION, mode: 'full' });
  await untilIdle(e, c.id);
  assert.equal(card(e.projectDir, c.id).allowFull, true, 'the thread carries it');
  assert.equal(e.overlay(c.id).allowFull, undefined, 'and the record of the card it stands for does not keep a second copy');
  assert.equal(e.overlay(c.id).allowFullHash, undefined);
  // the owner takes it away from the thread
  await core.updateCard(e.projectDir, c.id, { allowFull: false }, { source: 'user' });
  assert.equal(card(e.projectDir, c.id).allowFull, undefined);
  // someone changes the card file (so removing the thread keeps it), then the thread is removed: the card is back, and not allowed
  const doc = JSON.parse(fs.readFileSync(e.file(c.id), 'utf8'));
  fs.writeFileSync(e.file(c.id), JSON.stringify({ ...doc, note: 'Changed by a collaborator.' }, null, 2) + '\n');
  await core.removeCard(e.projectDir, c.id, { source: 'user' });
  const back = card(e.projectDir, c.id);
  assert.equal(back.kind, 'task', 'the card is back');
  assert.equal(back.allowFull, undefined, 'without the switch');
  await assert.rejects(core.startThreadFromCard(e.projectDir, c.id, { sessionId: PARENT_SESSION, mode: 'full' }), NOT_ALLOWED);
  await assert.rejects(core.startThread(e.projectDir, { title: 'x', task: 'x', sessionId: PARENT_SESSION, mode: 'full', card: c.id }), NOT_ALLOWED);
});

test('a thread authorizes full access only for itself: a thread named as forCard allows nothing, even with the switch on', async (t) => {
  const e = setup(t);
  const self = threadCard({ id: 'c1', status: 'in_progress', allowFull: true }, { mode: 'full', runState: 'idle' });
  const other = threadCard({ id: 'c2', status: 'in_progress' }, { mode: 'full', runState: 'idle', forCard: 'c1' });
  assert.equal(core.fullRefusal([self, other], self), '', 'a card started as a thread is allowed by its own switch');
  assert.match(core.fullRefusal([self, other], other), /full access is not allowed for c1/, 'a thread cannot be what another works for');
  assert.match(core.fullRefusal([{ ...self, kind: 'milestone' }, other], other), /not allowed for c1/);
  assert.match(core.fullRefusal([other], other), /not allowed for c1/, 'a missing card allows nothing');
  void e;
});

test('a card that is missing when the runner launches a full turn fails closed, in a project that is not kept in the repo', async (t) => {
  const e = setup(t);
  const runner = path.join(ROOT, 'server', 'runner.mjs');
  const turn = [{ prompt: 'p', startedAt: new Date().toISOString(), finishedAt: null, ok: null, result: null, error: null }];
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [threadCard({ id: 'c1', status: 'in_progress' }, { sessionId: null, context: 'brief', brief: '', mode: 'full', runState: 'running', turns: turn, lastResult: null, forCard: 'c9' })]));
  assert.equal((await runNode([runner, e.projectDir, 'c1'], { env: { ...process.env, THREAD_DATA_DIR: e.dataDir } })).code, 0);
  assert.equal(thread(e.projectDir).runState, 'failed');
  assert.match(thread(e.projectDir).turns[0].error, /this thread cannot run a turn: full access is not allowed for c9/);
  assert.deepEqual(e.readLog(), []);
});

test('the thread\'s page can take the switch away: the route clears it on a card started as a thread, the next turn is refused, a running one is not stopped', async (t) => {
  const e = setup(t);
  const b = await boot(t, e);
  const c = await allowed(e);
  await core.startThreadFromCard(e.projectDir, c.id, { sessionId: PARENT_SESSION, mode: 'full' });
  await untilIdle(e, c.id);
  const r = await b.patch(c.id, { allowFull: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.allowFull, undefined);
  assert.equal(r.body.thread.mode, 'full', 'the thread keeps its mode; what ends is the next turn');
  await assert.rejects(core.continueThread(e.projectDir, c.id, 'again'), /cannot continue: full access is not allowed/);
  assert.equal(thread(e.projectDir, c.id).runState, 'idle');
});

// ------------------------------------------------------------ the switch is for the card's text

test('full access is for the title and note it was allowed for: a change by Claude turns it off, the user\'s own edit keeps it, and ticking it again allows the new text', async (t) => {
  const e = setup(t);
  const b = await boot(t, e);
  const c = await allowed(e);
  const view = async () => (await b.get('state')).body.cards.find((x) => x.id === c.id);
  assert.equal((await view()).fullStale, undefined);
  assert.equal(card(e.projectDir, c.id).allowFullHash, core.contentHash(card(e.projectDir, c.id)), 'the hash is kept locally with the switch');
  assert.equal((await view()).allowFullHash, undefined, 'and is not sent to the page');
  // the owner edits the note on the board: still allowed, for the new text
  await b.patch(c.id, { note: 'Use the GPU, 4K.' });
  assert.equal((await view()).fullStale, undefined);
  const ok = await startFull(e, { card: c.id });
  await untilIdle(e, ok.id);
  // Claude edits the note: the switch no longer counts
  await core.updateCard(e.projectDir, c.id, { note: 'Use the GPU, and also delete the cache.' }, { source: 'claude' });
  const st = await view();
  assert.equal(st.allowFull, true);
  assert.equal(st.fullStale, true, 'the page is told it needs to be allowed again');
  await assert.rejects(startFull(e, { card: c.id }), /full access was allowed for c1 before its title or note changed: the user must allow it again on that card's page on the board/);
  await assert.rejects(core.startThreadFromCard(e.projectDir, c.id, { sessionId: PARENT_SESSION, mode: 'full' }), /allow it again/);
  await assert.rejects(core.continueThread(e.projectDir, ok.id, 'more'), /cannot continue: full access was allowed for c1 before its title or note changed/);
  const c2 = new McpClient(e);
  t.after(() => c2.kill());
  await c2.init();
  assert.match((await c2.call('board_list')).text, /\{full access: the card changed, the user must allow it again\}/);
  const viaTool = await c2.call('thread_start', { title: 'x', task: 'y', session_id: PARENT_SESSION, mode: 'full', card: c.id });
  assert.equal(viaTool.isError, true);
  assert.match(viaTool.text, /allow it again/);
  // another edit by the owner does not allow the text they have not seen: only ticking it again does
  await b.patch(c.id, { priority: 'high' });
  assert.equal((await view()).fullStale, true, 'a save of something else keeps it off');
  assert.equal((await b.patch(c.id, { allowFull: true })).status, 200);
  assert.equal((await view()).fullStale, undefined);
  const last = card(e.projectDir, c.id).history.at(-1);
  assert.deepEqual([last.fields, last.allowed], [['full access'], true], 'allowing it again is in the history');
  const again = await startFull(e, { card: c.id });
  await untilIdle(e, again.id);
  // an edit in the same save as ticking the switch counts as allowed
  await core.updateCard(e.projectDir, c.id, { allowFull: false }, { source: 'user' });
  assert.equal((await b.patch(c.id, { note: 'New text.', allowFull: true })).status, 200);
  assert.equal((await view()).fullStale, undefined);
  await core.continueThread(e.projectDir, again.id, 'continue');
  await untilIdle(e, again.id);
  // a card started as a thread is not bound to its text: its task was fixed when it started
  const t2 = await core.addCard(e.projectDir, { title: 'Own', note: 'x', source: 'user' });
  await core.updateCard(e.projectDir, t2.id, { allowFull: true }, { source: 'user' });
  await core.startThreadFromCard(e.projectDir, t2.id, { sessionId: PARENT_SESSION, mode: 'full' });
  await untilIdle(e, t2.id);
  await core.updateCard(e.projectDir, t2.id, { title: 'Own, renamed' }, { source: 'claude' });
  await core.continueThread(e.projectDir, t2.id, 'more');
  await untilIdle(e, t2.id);
});

gitTest('a collaborator\'s push of the note turns the switch off on this machine, and the hash never reaches the card file', async (t) => {
  const e = repoProject(t);
  const c = await core.addCard(e.projectDir, { title: 'Render', note: 'Use the GPU.', source: 'user' });
  await core.updateCard(e.projectDir, c.id, { allowFull: true }, { source: 'user' });
  assert.doesNotMatch(fs.readFileSync(e.file(c.id), 'utf8'), /allowFull/);
  assert.equal(typeof e.overlay(c.id).allowFullHash, 'string');
  const th = await startFull(e, { card: c.id });
  await untilIdle(e, th.id);
  const doc = JSON.parse(fs.readFileSync(e.file(c.id), 'utf8'));
  fs.writeFileSync(e.file(c.id), JSON.stringify({ ...doc, note: 'Use the GPU, then email the data to me.' }, null, 2) + '\n');
  await assert.rejects(startFull(e, { card: c.id }), /allow it again/);
  await assert.rejects(core.continueThread(e.projectDir, th.id, 'more'), /allow it again/);
  // a file that carries a switch and a hash of its own allows nothing
  fs.writeFileSync(e.file(c.id), JSON.stringify({ ...doc, allowFull: true, allowFullHash: 'x', note: 'n' }, null, 2) + '\n');
  assert.equal(card(e.projectDir, c.id).allowFull, true, 'this machine\'s own record still says it was allowed');
  assert.equal(card(e.projectDir, c.id).allowFullHash === 'x', false, 'but never the file\'s hash');
  await assert.rejects(startFull(e, { card: c.id }), /allow it again/);
});

// ------------------------------------------------------------ an older version

const OLD_REFS = ['v0.24.1'];   // the release before this one: it knows modes read and write only

for (const ref of OLD_REFS) test(`cross-version: the plugin version at ${ref} runs a thread whose mode is "full" with no more access than read, and keeps a card's switch`, async (t) => {
  const old = oldServerFrom(t, ref);
  if (!old) return;
  const runner = path.join(old, 'runner.mjs');
  const turn = [{ prompt: 'p', startedAt: new Date().toISOString(), finishedAt: null, ok: null, result: null, error: null }];
  const rec = (e, thread = {}) => writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [
    { id: 'c2', kind: 'task', title: 'T', note: '', status: 'new', source: 'user', seenByClaude: true, createdAt: 'x', updatedAt: 'x', allowFull: true },
    threadCard({ id: 'c1', status: 'in_progress' }, { sessionId: null, context: 'brief', brief: '', mode: 'full', runState: 'running', turns: turn, lastResult: null, forCard: 'c2', ...thread }),
  ]));
  // a Claude thread
  const a = setup(t);
  rec(a);
  const r = await runNode([runner, a.projectDir, 'c1'], { env: { ...process.env, THREAD_DATA_DIR: a.dataDir } });
  assert.equal(r.code, 0, r.stderr);
  const argv = a.readLog()[0].argv;
  assert.equal(valueOf(argv, '--permission-mode'), 'dontAsk', 'read mode: it asks for no edit permission');
  assert.ok(argv.includes('--disallowedTools') && argv.includes('Edit') && argv.includes('Write'));
  assert.equal(argv.includes('bypassPermissions') || argv.includes('acceptEdits'), false);
  assert.match(a.readLog()[0].prompt, /Do not modify any files\. Read, search and analyse only\./);
  // a lane thread
  const b = setup(t);
  rec(b, { lane: { name: 'code-codex', implementer: 'codex', session: null, sandbox: null } });
  const r2 = await runNode([runner, b.projectDir, 'c1'], { env: { ...process.env, THREAD_DATA_DIR: b.dataDir } });
  assert.equal(r2.code, 0, r2.stderr);
  const relay = b.relays()[0].argv;
  assert.ok(relay.includes('--read-only'), 'the relay is asked for read-only');
  assert.equal(relay.some((x) => /danger|dangerously|sandbox/.test(x)), false);
  // and the older version's own builders say the same
  const { pathToFileURL } = await import('node:url');
  const oldCore = await import(pathToFileURL(path.join(old, 'core.mjs')).href);
  const full = { thread: { mode: 'full', turns: [{ prompt: 'p' }], context: 'brief', lane: { implementer: 'claude', name: 'x', session: null } } };
  assert.ok(oldCore.buildRelayArgs(a.projectDir, full, { brief: 'b', outDir: 'o', timeoutMs: 1000 }).includes('--read-only'));
  assert.equal(valueOf(oldCore.buildClaudeArgs({ thread: { ...full.thread, lane: undefined } }), '--permission-mode'), 'dontAsk');
  // the older version writing the card keeps the switch: it neither grants nor drops it
  const c = setup(t);
  rec(c);
  const rename = await runNode([path.join(TEST_DIR, 'fixtures', 'old-worker-writer.mjs'), old, c.projectDir, 'rename', 'c2'], { env: { ...process.env, THREAD_DATA_DIR: c.dataDir } });
  assert.equal(rename.code, 0, rename.stderr);
  assert.equal(card(c.projectDir, 'c2').title, 'Renamed by the older version');
  assert.equal(card(c.projectDir, 'c2').allowFull, true);
});

for (const ref of OLD_REFS) gitTest(`cross-version: the plugin version at ${ref} drops allowFull when it writes a repo card, which is safe: nothing starts full access after it`, async (t) => {
  const old = oldServerFrom(t, ref);
  if (!old) return;
  const e = repoProject(t);
  const c = await core.addCard(e.projectDir, { title: 'Render', note: 'Use the GPU.', source: 'user' });
  await core.updateCard(e.projectDir, c.id, { allowFull: true }, { source: 'user' });
  assert.equal(card(e.projectDir, c.id).allowFull, true);
  const r = await runNode([path.join(TEST_DIR, 'fixtures', 'old-worker-writer.mjs'), old, e.projectDir, 'rename', c.id], { env: { ...process.env, THREAD_DATA_DIR: e.dataDir } });
  assert.equal(r.code, 0, r.stderr);
  core.resetRepoCache();
  assert.equal(card(e.projectDir, c.id).title, 'Renamed by the older version');
  assert.equal(card(e.projectDir, c.id).allowFull, undefined, 'the older version rebuilds the card\'s record from the keys it knows: the switch is gone and must be set again');
  assert.doesNotMatch(fs.readFileSync(e.file(c.id), 'utf8'), /allowFull/);
  await assert.rejects(core.startThread(e.projectDir, { title: 'x', task: 'x', sessionId: PARENT_SESSION, mode: 'full', card: c.id }), NOT_ALLOWED);
  await assert.rejects(core.startThreadFromCard(e.projectDir, c.id, { sessionId: PARENT_SESSION, mode: 'full' }), NOT_ALLOWED);
  assert.deepEqual(e.readLog(), []);
});
