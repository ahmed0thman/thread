// Delegation lanes, stage 2: running a thread, or a card, on a lane. Both the delegate-setup script and the four provider
// relays are fakes (test/fake-delegate); no real provider CLI and no real claude CLI is ever started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupThreadEnv, cleanAmbientEnv, waitFor, sleep, isAlive, McpClient, runNode, HOOK_PATH, PARENT_SESSION, FAKE_DELEGATE, writeStateFile, emptyState } from './helpers.mjs';
import * as core from '../server/core.mjs';
import { clearLanesCache } from '../server/lanes.mjs';
import { startBoardServer } from '../server/http.mjs';

cleanAmbientEnv();

const TASK = 'check-the-zebra-crossing-bug-on-a-lane';
const card = (dir, id = 'c1') => core.readState(dir).cards.find((c) => c.id === id);
const thread = (dir, id = 'c1') => card(dir, id)?.thread;
const untilState = (e, runState, id = 'c1', timeout = 8000) => waitFor(() => thread(e.projectDir, id)?.runState === runState, { timeout });
const plain = (x) => JSON.parse(JSON.stringify(x));

// One lane per provider in the fake delegate-setup: code-codex, agy-fast, ui-open (opencode), claude-edit (can edit) and review-ro (read-only).
const PROVIDER_LANE = { codex: 'code-codex', agy: 'agy-fast', opencode: 'ui-open', claude: 'claude-edit' };
const RESUME_FLAG = { codex: '--session', agy: '--conversation', opencode: '--session', claude: '--session' };

function setup(t, relayMode = 'ok', extra = {}) {
  cleanAmbientEnv();   // a test with several setups would otherwise carry the first one's FAKE_* values into the next
  clearLanesCache();
  t.after(clearLanesCache);
  const e = setupThreadEnv(t, { THREAD_DELEGATE_DIR: FAKE_DELEGATE, FAKE_DELEGATE_MODE: 'ok', FAKE_RELAY_MODE: relayMode, ...extra });
  e.relayLog = path.join(e.base, 'relay.log');
  e.setEnv('FAKE_RELAY_LOG', e.relayLog);
  e.relays = () => (fs.existsSync(e.relayLog) ? fs.readFileSync(e.relayLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return e;
}
const start = (e, over = {}) => core.startThread(e.projectDir, { title: 'Lane job', task: TASK, sessionId: PARENT_SESSION, lane: 'code-codex', ...over });
const logsDir = (e) => path.join(e.dataDir, 'projects', core.projectKey(e.projectDir), 'logs');

/** A copy of the fake skills folder with the delegate-setup script and, optionally, some relays. */
function skillsCopy(e, relays = []) {
  const dir = path.join(e.base, 'skills');
  fs.cpSync(path.join(FAKE_DELEGATE, 'delegate-setup'), path.join(dir, 'delegate-setup'), { recursive: true });
  for (const r of relays) {
    fs.cpSync(path.join(FAKE_DELEGATE, `${r}-delegate`), path.join(dir, `${r}-delegate`), { recursive: true });
    fs.copyFileSync(path.join(FAKE_DELEGATE, 'fake-relay.mjs'), path.join(dir, 'fake-relay.mjs'));
  }
  return dir;
}

// ------------------------------------------------------------ refusals on start

test('start refuses a lane given with an agent, a model, an effort, a full copy or extra folders, each in one line', async (t) => {
  const e = setup(t);
  const extra = fs.mkdtempSync(path.join(e.base, 'extra-'));
  const cases = [
    [{ agent: 'worker' }, /lane brings its own provider, model and effort/],
    [{ model: 'haiku' }, /lane brings its own provider, model and effort/],
    [{ effort: 'high' }, /lane brings its own provider, model and effort/],
    [{ context: 'full' }, /cannot be a full copy/],
    [{ extraDirs: [extra] }, /cannot take extra_dirs/],
  ];
  for (const [over, re] of cases) {
    await assert.rejects(start(e, over), (err) => re.test(err.message) && !err.message.includes('\n'), JSON.stringify(over));
  }
  assert.equal(core.readState(e.projectDir).cards.length, 0, 'a refused start leaves no card');
});

test('start refuses a lane that is unknown, not approved, without the delegate skills, without its relay, or read-only for a write thread', async (t) => {
  const e = setup(t);
  await assert.rejects(start(e, { lane: 'nope' }), /unknown lane "nope"; valid lanes: code-codex/);
  await assert.rejects(start(e, { lane: 'review-ro', mode: 'write' }), /lane "review-ro" is read-only; start the thread with mode "read"/);
  e.setEnv('FAKE_DELEGATE_MODE', 'untrusted');
  clearLanesCache();
  await assert.rejects(start(e, { lane: 'agy-fast' }), /lane "agy-fast" is not approved; approve this project's lane config with the delegate-setup skill/);
  e.setEnv('FAKE_DELEGATE_MODE', 'fail');
  clearLanesCache();
  await assert.rejects(start(e), /delegate skills.*not found/);
  e.setEnv('FAKE_DELEGATE_MODE', 'ok');
  e.setEnv('THREAD_DELEGATE_DIR', skillsCopy(e, ['agy']));   // an agy relay only
  clearLanesCache();
  await assert.rejects(start(e, { lane: 'code-codex' }), /runs on codex, but its relay \(the codex-delegate skill\) was not found/);
  assert.equal(core.readState(e.projectDir).cards.length, 0);
  assert.equal(e.relays().length, 0, 'no relay ran');
});

test('thread_start through MCP refuses with the same one-line messages', async (t) => {
  const e = setup(t);
  const c = new McpClient(e);
  t.after(() => c.kill());
  await c.init();
  const r = await c.call('thread_start', { title: 'x', task: 'y', session_id: PARENT_SESSION, lane: 'code-codex', model: 'haiku' });
  assert.equal(r.isError, true);
  assert.match(r.text, /^a lane brings its own provider/);
  const r2 = await c.call('thread_start', { title: 'x', task: 'y', session_id: PARENT_SESSION, lane: 'nope' });
  assert.match(r2.text, /^unknown lane "nope"/);
  assert.ok(!r2.text.includes('\n'));
});

// ------------------------------------------------------------ the relay's arguments, per provider

for (const [provider, lane] of Object.entries(PROVIDER_LANE)) {
  test(`${provider}: first turn and follow-up call the relay with the exact arguments; the brief is in a file, never in argv`, async (t) => {
    const e = setup(t);
    const c = await start(e, { lane, brief: 'BRIEF-TEXT-FOR-THE-LANE' });
    assert.equal(c.thread.lane.implementer, provider);
    await untilState(e, 'idle');
    const [first] = e.relays();
    assert.equal(first.implementer, provider);
    const outDir = path.join(logsDir(e), 'c1.t1.lane');
    assert.deepEqual(first.argv, ['--brief', path.join(logsDir(e), 'c1.t1.brief.txt'), '--cd', e.projectDir, '--lane', lane, '--out-dir', outDir, '--timeout', '1200s', '--read-only']);
    assert.equal(first.argv.some((a) => a.includes(TASK) || a.includes('BRIEF-TEXT')), false, 'no brief text in argv');
    assert.ok(first.brief.includes(TASK) && first.brief.includes('BRIEF-TEXT-FOR-THE-LANE'), 'the brief file holds the prompt');
    assert.ok(first.brief.includes('[side thread c1: Lane job]'));
    assert.equal(fs.realpathSync(first.cwd), fs.realpathSync(e.projectDir));

    await core.continueThread(e.projectDir, 'c1', 'Since your last turn: nothing. Now check the second file.');
    await untilState(e, 'idle');
    const second = e.relays()[1];
    assert.deepEqual(second.argv, ['--brief', path.join(logsDir(e), 'c1.t2.brief.txt'), '--cd', e.projectDir, '--lane', lane, '--out-dir', path.join(logsDir(e), 'c1.t2.lane'), '--timeout', '1200s', '--read-only', RESUME_FLAG[provider], `${provider}-sess-1`]);
    assert.ok(second.brief.startsWith('[side thread c1: follow-up]'));
    assert.ok(second.brief.includes('Now check the second file.'));
    assert.ok(!second.brief.includes('BRIEF-TEXT'), 'a follow-up does not repeat the brief');
    assert.match(thread(e.projectDir).lastResult, /\(resumed \w+-sess-1\)/, 'the relay really continued the session');
  });
}

test('a write thread on a lane that can edit files drops --read-only', async (t) => {
  const e = setup(t);
  await start(e, { mode: 'write', lane: 'claude-edit' });
  await untilState(e, 'idle');
  assert.equal(e.relays()[0].argv.includes('--read-only'), false);
});

// ------------------------------------------------------------ outcomes

test('a completed turn is a normal finished thread; its stored shape keeps sessionId, agent, model and effort empty', async (t) => {
  const e = setup(t);
  await start(e, { lane: 'ui-open' });
  await untilState(e, 'idle');
  const c = card(e.projectDir);
  assert.equal(c.status, 'review', 'the stage follows the run state');
  const th = c.thread;
  assert.deepEqual(plain(th.lane), { name: 'ui-open', implementer: 'opencode', model: 'vendor/model-x', effort: null, variant: 'max', readOnly: false, sandbox: null, source: 'global', session: 'opencode-sess-1' });
  assert.equal(th.sessionId, null, 'an older plugin version then refuses a follow-up instead of resuming a foreign id');
  assert.equal(th.agent, null);
  assert.equal(th.model, null);
  assert.equal(th.effort, null);
  assert.equal(th.context, 'brief');
  assert.match(th.lastResult, /opencode lane reply/);
  assert.equal(th.turns[0].ok, true);
  assert.equal(th.pid, null);
  assert.equal(th.reported, false);
});

test('each failed result gives a failed thread with a short error, and the resume id is kept when the provider gave one', async (t) => {
  // a failed codex run has stderrTail and no error; an unavailable one has neither, only the relay's own stderr line
  const cases = [
    ['failed', /^codex failed: boom$/, 'codex-sess-1'],
    ['timeout', /^codex timed out: codex did not finish within --timeout 1200s; killed by the relay watchdog$/, 'codex-sess-1'],
    ['unavailable', /^codex codex_unavailable: relay: `codex` not found on PATH\. Install it and log in\.$/, 'codex-sess-1'],
    ['garbage', /^the codex relay exited with code 0 and wrote no result$/, null],
    ['exit2', /^the codex relay exited with code 2 and wrote no result: error: lane "x" is not approved/, null],
  ];
  for (const [mode, re, session] of cases) {
    const e = setup(t, mode);
    await start(e);
    await untilState(e, 'failed');
    const th = thread(e.projectDir);
    assert.match(th.turns[0].error, re, mode);
    assert.equal(th.turns[0].ok, false);
    assert.equal(th.lane.session, session, `${mode}: resume id`);
    assert.equal(card(e.projectDir).status, 'blocked');
    assert.ok(!th.turns[0].error.includes('\n'), 'one line');
    await core.removeCard(e.projectDir, 'c1');
  }
});

test('a real-shaped failure shows its reason for every provider: relay error first, else the last line of stderrTail, else the relay\'s stderr', async (t) => {
  const tail = 'Reading prompt from stdin...|ERROR: not logged in|';
  for (const provider of ['codex', 'agy', 'opencode']) {
    const e = setup(t, 'failed', { FAKE_RELAY_STDERR_TAIL: tail });
    await start(e, { lane: PROVIDER_LANE[provider] });
    await untilState(e, 'failed');
    assert.equal(thread(e.projectDir).turns[0].error, `${provider} failed: ERROR: not logged in`, `${provider}: no relay error, so the last non-empty stderrTail line`);
  }
  const e = setup(t, 'failed', { FAKE_RELAY_STDERR_TAIL: tail });
  await start(e, { lane: 'claude-edit' });
  await untilState(e, 'failed');
  assert.equal(thread(e.projectDir).turns[0].error, 'claude failed: claude returned an error result (error_during_execution)', 'a relay error wins over stderrTail');
  // codex outside a git repository: its own message reaches the turn error (the plugin never passes --skip-git-repo-check)
  const g = setup(t, 'failed', { FAKE_RELAY_STDERR_TAIL: 'Not inside a trusted directory and --skip-git-repo-check was not specified.' });
  await start(g);
  await untilState(g, 'failed');
  assert.match(thread(g.projectDir).turns[0].error, /Not inside a trusted directory and --skip-git-repo-check was not specified\.$/);
  assert.equal(g.relays()[0].argv.some((a) => /skip-git-repo-check|dangerously|skip-permissions/i.test(a)), false, 'no flag that skips a safety check is ever passed');
});

test('a provider that gives no session can finish its turn, but the thread cannot be continued', async (t) => {
  const e = setup(t, 'noresume');
  await start(e, { lane: 'agy-fast' });
  await untilState(e, 'idle');
  assert.equal(thread(e.projectDir).lane.session, null);
  assert.equal(thread(e.projectDir).turns[0].ok, true);
  await assert.rejects(core.continueThread(e.projectDir, 'c1', 'more'), /has no session to continue: the agy provider gave none; start a new thread instead/);
});

test('a failed first turn that still gave a session can be continued, as a follow-up', async (t) => {
  const e = setup(t, 'failed');
  await start(e);
  await untilState(e, 'failed');
  e.setEnv('FAKE_RELAY_MODE', 'ok');
  await core.continueThread(e.projectDir, 'c1', 'try again');
  await untilState(e, 'idle');
  const second = e.relays()[1];
  assert.ok(second.argv.includes('codex-sess-1'));
  assert.ok(second.brief.startsWith('[side thread c1: follow-up]'));
});

// ------------------------------------------------------------ follow-up refusals

test('continue refuses a lane that is gone, not approved or without its relay, with the same messages as start', async (t) => {
  const e = setup(t);
  await start(e, { lane: 'agy-fast' });
  await untilState(e, 'idle');
  e.setEnv('FAKE_DELEGATE_MODE', 'untrusted');
  clearLanesCache();
  await assert.rejects(core.continueThread(e.projectDir, 'c1', 'more'), /lane "agy-fast" is not approved; approve this project's lane config/);
  e.setEnv('FAKE_DELEGATE_MODE', 'fail');
  clearLanesCache();
  await assert.rejects(core.continueThread(e.projectDir, 'c1', 'more'), /delegate skills.*not found/);
  e.setEnv('FAKE_DELEGATE_MODE', 'ok');
  e.setEnv('THREAD_DELEGATE_DIR', skillsCopy(e, ['codex']));
  clearLanesCache();
  await assert.rejects(core.continueThread(e.projectDir, 'c1', 'more'), /runs on agy, but its relay/);
  assert.equal(thread(e.projectDir).runState, 'idle', 'a refused follow-up changes nothing');
  assert.equal(thread(e.projectDir).turns.length, 1);
  assert.equal(e.relays().length, 1);
});

test('a follow-up takes the lane as it is now, and refuses a lane that changed provider', async (t) => {
  const e = setup(t);
  await start(e);
  await untilState(e, 'idle');
  assert.equal(thread(e.projectDir).lane.model, 'gpt-fake');
  e.setEnv('FAKE_DELEGATE_CODEX_MODEL', 'gpt-newer');
  clearLanesCache();
  await core.continueThread(e.projectDir, 'c1', 'again');
  assert.equal(thread(e.projectDir).lane.model, 'gpt-newer', 'the snapshot is refreshed at the start of the turn');
  assert.equal(thread(e.projectDir).lane.session, 'codex-sess-1', 'the session stays');
  await untilState(e, 'idle');
  // a hand-edited state in which the stored provider differs from the lane's now
  const s = core.readState(e.projectDir);
  s.cards[0].thread.lane.implementer = 'opencode';
  writeStateFile(e.dataDir, e.projectDir, s);
  clearLanesCache();
  await assert.rejects(core.continueThread(e.projectDir, 'c1', 'again'), /now runs on codex, which cannot continue a opencode session/);
});

// ------------------------------------------------------------ end, stop, time limit

test('ending a running lane thread sends SIGTERM to the relay, which writes its aborted result; the card ends in the end stage', async (t) => {
  const e = setup(t, 'slow');
  await start(e);
  await waitFor(() => e.relays().length === 1);
  const relayPid = e.relays()[0].pid;
  const runnerPid = thread(e.projectDir).pid;
  assert.ok(isAlive(relayPid));
  const r = await core.endThread(e.projectDir, 'c1');
  assert.equal(r.card.thread.runState, 'ended');
  await waitFor(() => !isAlive(runnerPid) && !isAlive(relayPid));
  const result = JSON.parse(fs.readFileSync(path.join(logsDir(e), 'c1.t1.lane', 'result.json'), 'utf8'));
  assert.equal(result.status, 'aborted', 'the relay was asked to stop (SIGTERM), not killed');
  const c = card(e.projectDir);
  assert.equal(c.thread.runState, 'ended');
  assert.equal(c.status, 'done');
  assert.equal(c.thread.turns[0].ok, false);
  assert.equal(c.thread.turns[0].error, 'ended by user');
  assert.equal(c.thread.lane.session, 'codex-sess-1', 'the id of an aborted run is kept');
  assert.equal(c.thread.pid, null);
});

test('stopping the runner itself with SIGTERM stops the relay the same way', async (t) => {
  const e = setup(t, 'slow');
  await start(e);
  await waitFor(() => e.relays().length === 1);
  const relayPid = e.relays()[0].pid;
  process.kill(thread(e.projectDir).pid, 'SIGTERM');
  await waitFor(() => !isAlive(relayPid));
  await waitFor(() => thread(e.projectDir).runState !== 'running');
  assert.equal(JSON.parse(fs.readFileSync(path.join(logsDir(e), 'c1.t1.lane', 'result.json'), 'utf8')).status, 'aborted');
});

test('the runner\'s own limit comes after the relay\'s --timeout and stops the relay with SIGTERM', async (t) => {
  const e = setup(t, 'slow', { THREAD_TIMEOUT_MS: '500', THREAD_LANE_GRACE_MS: '400' });
  await start(e);
  await untilState(e, 'failed');
  const th = thread(e.projectDir);
  assert.equal(th.turns[0].error, 'timed out after 1s');
  assert.equal(e.relays()[0].argv[e.relays()[0].argv.indexOf('--timeout') + 1], '1s');
  await waitFor(() => !isAlive(e.relays()[0].pid));
  assert.equal(JSON.parse(fs.readFileSync(path.join(logsDir(e), 'c1.t1.lane', 'result.json'), 'utf8')).status, 'aborted');
});

test('a running lane thread stays running for reconcile while its runner beats, and removing its card removes the lane folders', async (t) => {
  const e = setup(t, 'slow');
  await start(e);
  await waitFor(() => e.relays().length === 1);
  await core.reconcile(e.projectDir);
  assert.equal(thread(e.projectDir).runState, 'running');
  await core.endThread(e.projectDir, 'c1');
  await waitFor(() => !isAlive(e.relays()[0].pid));
  await waitFor(() => thread(e.projectDir).turns[0].finishedAt);
  assert.ok(fs.readdirSync(logsDir(e)).some((n) => n.startsWith('c1.t1.lane')));
  await core.removeCard(e.projectDir, 'c1');
  assert.deepEqual(fs.readdirSync(logsDir(e)).filter((n) => n.startsWith('c1.')), []);
});

// ------------------------------------------------------------ trace and tokens, and the hook mark

test('a claude lane gives the turn its steps and token use from events.jsonl, counted once; other providers give none', async (t) => {
  const e = setup(t, 'ok', { FAKE_RELAY_EVENTS: '1' });
  await start(e, { lane: 'claude-edit' });
  await untilState(e, 'idle');
  const turn = thread(e.projectDir).turns[0];
  assert.equal(turn.steps, 2);
  assert.deepEqual(plain(turn.usage), { input: 10, cacheRead: 100, cacheWrite: 5, output: 20 });
  const activity = core.readActivity(e.projectDir, 'c1', 1);
  assert.deepEqual(activity.map((a) => a.kind), ['text', 'tool', 'tool_result', 'tool', 'tool_result']);
  assert.equal(activity[1].name, 'Read');
  await core.continueThread(e.projectDir, 'c1', 'again');
  await untilState(e, 'idle');
  const turns = thread(e.projectDir).turns;
  assert.deepEqual(plain(turns[1].usage), { input: 10, cacheRead: 100, cacheWrite: 5, output: 20 }, 'each turn has its own figures');
  assert.equal(turns[1].steps, 2);
});

test('a claude lane without events takes its token use from result.json once; codex, agy and opencode have no trace and no tokens', async (t) => {
  const e = setup(t, 'ok', { FAKE_RELAY_EVENTS: 'usage' });
  await start(e, { lane: 'claude-edit' });
  await untilState(e, 'idle');
  const turn = thread(e.projectDir).turns[0];
  assert.deepEqual(plain(turn.usage), { input: 10, cacheRead: 100, cacheWrite: 5, output: 20 });
  assert.equal(turn.steps, 0, 'no events, no trace');
  e.setEnv('FAKE_RELAY_EVENTS', '1');
  for (const lane of ['code-codex', 'agy-fast', 'ui-open']) {
    const c = await start(e, { lane });
    await untilState(e, 'idle', c.id);
    const turn = thread(e.projectDir, c.id).turns[0];
    assert.equal(turn.steps, 0, lane);
    assert.equal(turn.usage, undefined, lane);
    assert.deepEqual(core.readActivity(e.projectDir, c.id, 1), [], lane);
  }
});

test('the thread mark reaches the relay\'s environment, and the plugin hook then registers nothing and prints nothing', async (t) => {
  const e = setup(t, 'ok', { FAKE_RELAY_EVENTS: '1' });
  e.setEnv('THREAD_PROJECT_DIR', e.projectDir);
  e.setEnv('CLAUDE_PROJECT_DIR', e.projectDir);
  await start(e, { lane: 'claude-edit' });
  await untilState(e, 'idle');
  const run = e.relays()[0];
  assert.equal(run.depth, '1', 'THREAD_DEPTH reaches the relay, which passes its environment to a claude child');
  assert.equal(run.threadEnv.THREAD_PROJECT_DIR, undefined);
  assert.equal(run.threadEnv.CLAUDE_PROJECT_DIR, undefined);
  const childSession = 'cccccccc-1111-4222-8333-dddddddddddd';
  const before = JSON.stringify(core.readState(e.projectDir).sessions || null);
  const input = JSON.stringify({ hook_event_name: 'SessionStart', session_id: childSession, cwd: e.projectDir });
  const out = await runNode([HOOK_PATH, 'SessionStart'], { input, env: { ...process.env, THREAD_DEPTH: run.depth, CLAUDE_PROJECT_DIR: e.projectDir } });
  assert.equal(out.stdout.trim(), '', 'no session note, no setup hint');
  assert.equal(JSON.stringify(core.readState(e.projectDir).sessions || null), before, 'the child session is not registered');
  assert.equal(fs.existsSync(path.join(e.dataDir, 'setup-hint')), false);
  // control: without the mark the same hook call does register the session and print its note
  const unmarked = await runNode([HOOK_PATH, 'SessionStart'], { input, env: { ...process.env, THREAD_DEPTH: undefined, CLAUDE_PROJECT_DIR: e.projectDir } });
  assert.match(unmarked.stdout, /\[thread plugin\]/);
});

// ------------------------------------------------------------ a card that has a lane

test('a card with a lane runs on it when started (the start from a card that the board route calls); the thread holds the lane, the card field is gone', async (t) => {
  const e = setup(t);
  const added = await core.addCard(e.projectDir, { title: 'Fix the parser', note: 'The parser drops commas.', lane: 'code-codex' });
  const th = await core.startThreadFromCard(e.projectDir, added.id, { sessionId: PARENT_SESSION });
  assert.equal(th.thread.lane.name, 'code-codex');
  assert.equal('lane' in th, false);
  await untilState(e, 'idle', added.id);
  const run = e.relays()[0];
  assert.ok(run.brief.includes('The parser drops commas.'), 'the note is the brief');
  assert.ok(run.brief.includes('Task: Fix the parser'));
  assert.equal(core.readState(e.projectDir).cards[0].thread.lane.implementer, 'codex');
});

test('a card with a lane is refused a full copy, an agent, or write access to a read-only lane; a card without a lane is untouched', async (t) => {
  const e = setup(t);
  const a = await core.addCard(e.projectDir, { title: 'Review it', lane: 'review-ro' });
  await assert.rejects(core.startThreadFromCard(e.projectDir, a.id, { sessionId: PARENT_SESSION, context: 'full' }), /cannot be a full copy/);
  await assert.rejects(core.startThreadFromCard(e.projectDir, a.id, { sessionId: PARENT_SESSION, agent: 'worker' }), /lane brings its own provider/);
  await assert.rejects(core.startThreadFromCard(e.projectDir, a.id, { sessionId: PARENT_SESSION, mode: 'write' }), /is read-only/);
  assert.equal(card(e.projectDir, a.id).kind, 'task');
  assert.equal(card(e.projectDir, a.id).lane, 'review-ro', 'a refused start leaves the card as it was');
  const plainCard = await core.addCard(e.projectDir, { title: 'No lane here' });
  const th = await core.startThreadFromCard(e.projectDir, plainCard.id, { sessionId: PARENT_SESSION });
  assert.equal(th.thread.lane, undefined);
  await untilState(e, 'idle', plainCard.id);
  assert.equal(e.relays().length, 0, 'it ran as a normal thread, on the fake claude');
});

async function boot(t, e) {
  const token = 'ab'.repeat(16);
  const b = await startBoardServer(e.projectDir, { port: 0, token });
  t.after(() => new Promise((r) => { b.server.closeAllConnections?.(); b.server.close(() => r()); }));
  const base = `http://127.0.0.1:${b.port}`;
  const key = (await (await fetch(`${base}/api/projects`, { headers: { 'X-Thread-Token': token } })).json()).projects[0].key;
  const post = (p, body) => fetch(`${base}/api/p/${key}/${p}`, { method: 'POST', headers: { 'X-Thread-Token': token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { post, base, key, token };
}

test('the board starts a card on its own lane, and a lane in the request is ignored', async (t) => {
  const e = setup(t);
  const b = await boot(t, e);
  const laned = await core.addCard(e.projectDir, { title: 'Laned', lane: 'code-codex' });
  const r = await b.post(`cards/${laned.id}/start`, { sessionId: PARENT_SESSION, mode: 'read', context: 'brief', agent: '', lane: 'ui-open' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.thread.lane.name, 'code-codex', 'the lane comes from the card');
  await untilState(e, 'idle', laned.id);
  assert.equal(e.relays()[0].implementer, 'codex');
  const bare = await core.addCard(e.projectDir, { title: 'Bare' });
  const r2 = await b.post(`cards/${bare.id}/start`, { sessionId: PARENT_SESSION, mode: 'read', context: 'brief', lane: 'ui-open' });
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).thread.lane, undefined, 'a body cannot give a card a lane');
  await untilState(e, 'idle', bare.id);
  assert.equal(e.relays().length, 1);
});

test('the board route refuses what a lane cannot do, with the reason', async (t) => {
  const e = setup(t);
  const b = await boot(t, e);
  const laned = await core.addCard(e.projectDir, { title: 'Laned', lane: 'review-ro' });
  const full = await b.post(`cards/${laned.id}/start`, { sessionId: PARENT_SESSION, mode: 'read', context: 'full' });
  assert.equal(full.status, 400);
  assert.match((await full.json()).error, /cannot be a full copy/);
  const write = await b.post(`cards/${laned.id}/start`, { sessionId: PARENT_SESSION, mode: 'write', context: 'brief' });
  assert.equal(write.status, 400);
  assert.match((await write.json()).error, /is read-only/);
  assert.equal(card(e.projectDir, laned.id).kind, 'task');
});

// ------------------------------------------------------------ the tools

test('lane_list lists the lanes with what each can do, flags the unusable ones, and says so when the skills are missing', async (t) => {
  const e = setup(t, 'ok');
  e.setEnv('THREAD_DELEGATE_DIR', skillsCopy(e, ['codex', 'claude']));
  const c = new McpClient(e);
  t.after(() => c.kill());
  await c.init();
  const text = (await c.call('lane_list')).text;
  assert.match(text, /^Delegation lanes\./);
  assert.match(text, /^- code-codex: codex, model gpt-fake, effort high, can edit files, all projects, approved$/m);
  assert.match(text, /^- ui-open: opencode, model vendor\/model-x, variant max, can edit files, all projects, approved \(cannot be used: the opencode relay is not installed\)$/m);
  assert.match(text, /^- review-ro: claude, model claude-fake, effort medium, read-only, this project, approved$/m);
  assert.ok(!text.includes('other-cli'), 'a provider that is not one of the four is left out');
  const none = new McpClient(e, { FAKE_DELEGATE_MODE: 'fail' });
  t.after(() => none.kill());
  await none.init();
  assert.match((await none.call('lane_list')).text, /delegate skills are not installed/);
  const un = new McpClient(e, { FAKE_DELEGATE_MODE: 'untrusted' });
  t.after(() => un.kill());
  await un.init();
  assert.match((await un.call('lane_list')).text, /^- agy-fast: .*, read-only \(agy lanes are read-only in this version\), this project, not approved: approve this project's lane config with the delegate-setup skill \(cannot be used: the agy relay is not installed\)$/m);
});

test('thread_status and thread_report name the lane and provider; thread_start answers with it', async (t) => {
  const e = setup(t);
  const c = new McpClient(e);
  t.after(() => c.kill());
  await c.init();
  const started = await c.call('thread_start', { title: 'Lane thread', task: TASK, session_id: PARENT_SESSION, lane: 'code-codex' });
  assert.equal(started.isError, false, started.text);
  assert.match(started.text, /brief context, lane code-codex \(codex, model gpt-fake, effort high\)/);
  await untilState(e, 'idle');
  const status = (await c.call('thread_status', { id: 'c1', session_id: PARENT_SESSION })).text;
  assert.match(status, /lane code-codex \(codex, model gpt-fake, effort high\)/);
  assert.match(status, /codex session codex-sess-1/);
  const report = (await c.call('thread_report', { id: 'c1', session_id: PARENT_SESSION })).text;
  assert.match(report, /^Thread c1 "Lane thread" \(idle, lane code-codex \(codex, model gpt-fake, effort high\)\):/);
  assert.ok(report.includes('codex lane reply'));
  const end = await c.call('thread_end', { id: 'c1', session_id: PARENT_SESSION });
  assert.equal(end.isError, false);
});

test('thread_continue through MCP resumes a lane thread, and says why when it cannot', async (t) => {
  const e = setup(t, 'noresume');
  const c = new McpClient(e);
  t.after(() => c.kill());
  await c.init();
  await c.call('thread_start', { title: 'Lane thread', task: TASK, session_id: PARENT_SESSION, lane: 'agy-fast' });
  await untilState(e, 'idle');
  const r = await c.call('thread_continue', { id: 'c1', message: 'more', session_id: PARENT_SESSION });
  assert.equal(r.isError, true);
  assert.match(r.text, /^thread c1 has no session to continue: the agy provider gave none; start a new thread instead$/);
});

// ------------------------------------------------------------ files a provider reports (read-only violation, touched files)

const resultOf = (e, id = 'c1') => thread(e.projectDir, id).turns.at(-1).result;

test('a read-only turn that the provider says may have changed files gets one plain line saying so, with the file names', async (t) => {
  for (const lane of ['agy-fast', 'claude-edit']) {
    for (const violation of ['true', 'null']) {
      const e = setup(t, 'ok', { FAKE_RELAY_VIOLATION: violation, FAKE_RELAY_TOUCHED: ' M a.txt|?? b.txt' });
      await start(e, { lane });
      await untilState(e, 'idle');
      const first = resultOf(e).split('\n\n')[0];
      const who = PROVIDER_LANE.agy === lane ? 'agy' : 'claude';
      assert.equal(first, `Note: ${who} reported that it may have changed files during this read-only turn. Uncommitted changes in the working tree after this turn (from the relay): a.txt, b.txt. Check the working tree.`, `${lane} ${violation}`);
      assert.ok(resultOf(e).includes(`${who} lane reply`), 'the report follows');
      assert.equal(core.parseHandback(resultOf(e)).sections.open, '- none', 'the note does not land inside the Open section');
      await core.removeCard(e.projectDir, 'c1');
    }
  }
});

test('no file note without a reason: violation false, a provider with no tripwire, and a write turn without touched files', async (t) => {
  const e = setup(t, 'ok', { FAKE_RELAY_VIOLATION: 'false', FAKE_RELAY_TOUCHED: ' M a.txt' });
  await start(e, { lane: 'agy-fast' });
  await untilState(e, 'idle');
  assert.ok(resultOf(e).startsWith('agy lane reply'), 'readOnlyViolation false: nothing to say');
  const c = await start(e, { lane: 'code-codex' });
  await untilState(e, 'idle', c.id);
  assert.ok(resultOf(e, c.id).startsWith('codex lane reply'), 'codex read-only is a sandbox and has no tripwire key');
  e.setEnv('FAKE_RELAY_TOUCHED', '');
  const w = await start(e, { lane: 'claude-edit', mode: 'write' });
  await untilState(e, 'idle', w.id);
  assert.ok(resultOf(e, w.id).startsWith('claude lane reply'));
});

test('a write turn lists the uncommitted files the relay reported for the working tree, worded as that and not as what the turn did, capped', async (t) => {
  const names = Array.from({ length: 11 }, (_, i) => `f${i + 1}.txt`);
  const e = setup(t, 'ok', { FAKE_RELAY_TOUCHED: names.map((n, i) => (i ? '?? ' : ' M ') + n).join('|') });
  await start(e, { lane: 'claude-edit', mode: 'write' });
  await untilState(e, 'idle');
  assert.ok(resultOf(e).startsWith('Uncommitted changes in the working tree after this turn (from the relay): f1.txt, f2.txt, f3.txt, f4.txt, f5.txt, f6.txt, f7.txt, f8.txt and 3 more.\n\n'));
});

test('a failed read-only turn with a possible change says so in its error', async (t) => {
  const e = setup(t, 'failed', { FAKE_RELAY_VIOLATION: 'true', FAKE_RELAY_TOUCHED: ' M a.txt' });
  await start(e, { lane: 'agy-fast' });
  await untilState(e, 'failed');
  assert.match(thread(e.projectDir).turns[0].error, /^agy failed: boom Note: agy reported that it may have changed files during this read-only turn\. Uncommitted changes in the working tree after this turn \(from the relay\): a\.txt\./);
});

test('a completed result with an empty finalMessage is a success with a stand-in report', async (t) => {
  const e = setup(t, 'emptyreport', { FAKE_RELAY_TOUCHED: ' M a.txt' });
  await start(e, { lane: 'agy-fast', mode: 'read' });
  await untilState(e, 'idle');
  const th = thread(e.projectDir);
  assert.equal(th.turns[0].ok, true);
  assert.equal(th.lastResult, 'agy finished the turn without a written report.');
  const w = setup(t, 'emptyreport', { FAKE_RELAY_TOUCHED: ' M a.txt' });
  await start(w, { lane: 'claude-edit', mode: 'write' });
  await untilState(w, 'idle');
  assert.equal(thread(w.projectDir).lastResult, 'Uncommitted changes in the working tree after this turn (from the relay): a.txt.\n\nclaude finished the turn without a written report.');
});

// ------------------------------------------------------------ write mode: sandbox, agy

test('a codex lane passes its sandbox explicitly on every turn: --read-only for a read thread, else the lane\'s sandbox or workspace-write', async (t) => {
  const e = setup(t);
  await start(e, { mode: 'write' });
  await untilState(e, 'idle');
  await core.continueThread(e.projectDir, 'c1', 'again');
  await untilState(e, 'idle');
  const [a, b] = e.relays();
  for (const run of [a, b]) {
    const i = run.argv.indexOf('--sandbox');
    assert.ok(i >= 0 && run.argv[i + 1] === 'workspace-write', `--sandbox workspace-write in ${run.argv}`);
    assert.equal(run.argv.includes('--read-only'), false);
  }
  assert.ok(b.argv.includes('--session'), 'the resumed turn also has it');
  const full = setup(t, 'ok', { FAKE_DELEGATE_SANDBOX: 'danger-full-access' });
  await start(full, { mode: 'write' });
  await untilState(full, 'idle');
  const run = full.relays()[0];
  assert.equal(run.argv[run.argv.indexOf('--sandbox') + 1], 'danger-full-access');
  const ro = setup(t, 'ok', { FAKE_DELEGATE_SANDBOX: 'danger-full-access' });
  await start(ro, { mode: 'read' });
  await untilState(ro, 'idle');
  assert.equal(ro.relays()[0].argv.includes('--sandbox'), false, 'a read thread passes --read-only, whatever the lane\'s sandbox');
  assert.ok(ro.relays()[0].argv.includes('--read-only'));
  const other = setup(t);
  await start(other, { lane: 'claude-edit', mode: 'write' });
  await untilState(other, 'idle');
  assert.equal(other.relays()[0].argv.includes('--sandbox'), false, 'only codex takes it');
});

test('a codex lane whose sandbox is read-only is read-only: a write thread is refused', async (t) => {
  const e = setup(t, 'ok', { FAKE_DELEGATE_SANDBOX: 'read-only' });
  await assert.rejects(start(e, { mode: 'write' }), /lane "code-codex" is read-only/);
});

test('agy lanes are read-only in this version: write mode is refused at start, with a one-line reason, and nothing skips permissions', async (t) => {
  const e = setup(t);
  await assert.rejects(start(e, { lane: 'agy-fast', mode: 'write' }), (err) => err.message === 'lane "agy-fast" runs on agy: agy lanes are read-only in this version');
  const c = new McpClient(e);
  t.after(() => c.kill());
  await c.init();
  const r = await c.call('thread_start', { title: 'x', task: 'y', session_id: PARENT_SESSION, lane: 'agy-fast', mode: 'write' });
  assert.equal(r.isError, true);
  assert.match(r.text, /agy lanes are read-only in this version$/);
  const card = await core.addCard(e.projectDir, { title: 'Agy card', lane: 'agy-fast' });
  await assert.rejects(core.startThreadFromCard(e.projectDir, card.id, { sessionId: PARENT_SESSION, mode: 'write' }), /agy lanes are read-only/);
  assert.equal(e.relays().length, 0);
  await start(e, { lane: 'agy-fast' });
  await untilState(e, 'idle', 'c2');
  assert.equal(e.relays()[0].argv.some((a) => /dangerously|skip/i.test(a)), false);
});

// ------------------------------------------------------------ an unusable lane record never falls through to claude

test('a thread whose lane record is unusable fails its turn, never runs claude, and cannot be continued', async (t) => {
  const bad = [
    ['an unknown provider', { name: 'x', implementer: 'grok', session: null }, /unknown provider \(grok\)/],
    ['a bad name', { name: '../x', implementer: 'codex', session: null }, /no valid name/],
    ['a bad session id', { name: 'x', implementer: 'codex', session: '--oops' }, /session id is not usable/],
    ['not an object', 'codex', /not an object/],
  ];
  for (const [label, lane, re] of bad) {
    const e = setup(t);
    const state = emptyState(e.projectDir, [{ id: 'c1', kind: 'thread', title: 'Odd', note: '', status: 'in_progress', source: 'claude', seenByClaude: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), thread: { parentSessionId: PARENT_SESSION, sessionId: null, context: 'brief', brief: '', mode: 'read', runState: 'running', pid: null, lane, turns: [{ prompt: 'p', startedAt: new Date().toISOString(), finishedAt: null, ok: null, result: null, error: null }], lastResult: null, reported: false, announced: false }, }]);
    writeStateFile(e.dataDir, e.projectDir, state);
    const out = await runNode([path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'server', 'runner.mjs'), e.projectDir, 'c1'], { env: { ...process.env, THREAD_DATA_DIR: e.dataDir } });
    assert.equal(out.code, 0, label);
    const th = thread(e.projectDir);
    assert.equal(th.runState, 'failed', label);
    assert.match(th.turns[0].error, /^this thread's lane cannot run: /, label);
    assert.match(th.turns[0].error, re, label);
    assert.equal(th.sessionId, null, `${label}: no session id was taken from anything`);
    assert.deepEqual(e.readLog(), [], `${label}: the claude CLI was never started`);
    assert.deepEqual(e.relays(), [], `${label}: no relay either`);
    await assert.rejects(core.continueThread(e.projectDir, 'c1', 'more'), /cannot continue: .*start a new thread instead/, label);
    assert.equal(e.readLog().length, 0);
  }
});

// ------------------------------------------------------------ files an older version left behind

function logsWith(e, names) {
  const dir = logsDir(e);
  fs.mkdirSync(dir, { recursive: true });
  for (const n of names) {
    const f = path.join(dir, n);
    if (n.endsWith('/')) { fs.mkdirSync(path.join(f, 'inner'), { recursive: true }); fs.writeFileSync(path.join(f, 'brief.txt'), 'brief'); } else fs.writeFileSync(f, 'x');
  }
  return dir;
}

test('the sweep removes the log files and folders of cards that are gone, and nothing else', async (t) => {
  const e = setup(t);
  const live = await core.addCard(e.projectDir, { title: 'Live' });   // c1
  const dir = logsWith(e, ['c1.out', 'c1.t1.lane/', 'c1.alive', 'c7.out', 'c7.t1.lane/', 'c7.t1.brief.txt', 'c12.t3.activity.jsonl', 'notes.txt', 'c7', 'cx7.out', 'x.c7.out', 'c.out', 'c7-1.out', '.c7.out']);
  const outside = path.join(e.base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep');
  fs.symlinkSync(outside, path.join(dir, 'c9.t1.lane'));
  fs.symlinkSync(path.join(outside, 'precious.txt'), path.join(dir, 'c9.out'));
  const n = await core.sweepOrphanLogs(e.projectDir);
  assert.equal(n, 6, 'c7.out, c7.t1.lane, c7.t1.brief.txt, c12.t3.activity.jsonl and the two links');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.c7.out', 'c.out', 'c1.alive', 'c1.out', 'c1.t1.lane', 'c7', 'c7-1.out', 'cx7.out', 'notes.txt', 'x.c7.out'].sort());
  assert.ok(fs.existsSync(path.join(dir, 'c1.t1.lane', 'brief.txt')), 'a live card\'s folder is kept whole');
  assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'keep', 'a symlink is never followed');
  assert.equal(live.id, 'c1');
});

test('the sweep does nothing without a state file or a logs folder, and runs when a card is removed, when the MCP server starts and when the board starts', async (t) => {
  const e = setup(t);
  assert.equal(await core.sweepOrphanLogs(e.projectDir), 0, 'no logs folder');
  const dir = logsWith(e, ['c5.out']);
  assert.equal(await core.sweepOrphanLogs(e.projectDir), 0, 'no state file: nothing says what is an orphan');
  assert.ok(fs.existsSync(path.join(dir, 'c5.out')));
  const a = await core.addCard(e.projectDir, { title: 'A' });
  const b = await core.addCard(e.projectDir, { title: 'B' });
  logsWith(e, [`${a.id}.t1.lane/`, `${b.id}.t1.lane/`, 'c8.t1.lane/', 'c8.out']);
  await core.removeCard(e.projectDir, b.id);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('c')).sort(), [`${a.id}.t1.lane`].sort(), 'removing a card also clears what an older version left');
  logsWith(e, ['c9.t1.lane/']);
  const c = new McpClient(e);
  t.after(() => c.kill());
  await c.init();
  await waitFor(() => !fs.existsSync(path.join(dir, 'c9.t1.lane')));
  logsWith(e, ['c10.t1.lane/']);
  const board = await startBoardServer(e.projectDir, { port: 0, token: 'ab'.repeat(16) });
  t.after(() => new Promise((r) => { board.server.closeAllConnections?.(); board.server.close(() => r()); }));
  await waitFor(() => !fs.existsSync(path.join(dir, 'c10.t1.lane')));
});

test('the lanes route says for each lane whether its provider\'s relay is installed, which the board needs to judge a follow-up', async (t) => {
  const e = setup(t);
  e.setEnv('THREAD_DELEGATE_DIR', skillsCopy(e, ['codex']));
  const b = await boot(t, e);
  const data = await (await fetch(`${b.base}/api/p/${b.key}/lanes`, { headers: { 'X-Thread-Token': b.token } })).json();
  const relay = Object.fromEntries(data.lanes.map((l) => [l.name, l.relay]));
  assert.equal(relay['code-codex'], true);
  assert.equal(relay['ui-open'], false);
  assert.equal(relay['agy-fast'], false);
});

// ------------------------------------------------------------ a failure only the provider's events give

test('a failed result with no error and an empty stderrTail takes the reason from the provider\'s events.jsonl', async (t) => {
  const inner = "The 'no-such-model-xyz' model is not supported when using Codex with a ChatGPT account.";
  for (const provider of ['codex', 'opencode', 'claude']) {
    const e = setup(t, 'failedevents');
    await start(e, { lane: PROVIDER_LANE[provider] });
    await untilState(e, 'failed');
    const th = thread(e.projectDir);
    assert.equal(th.turns[0].error, `${provider} failed: ${inner}`, provider);
    const result = JSON.parse(fs.readFileSync(path.join(logsDir(e), 'c1.t1.lane', 'result.json'), 'utf8'));
    assert.equal('error' in result, false, `${provider}: the result itself gives no reason`);
    assert.deepEqual(result.stderrTail, []);
    await core.removeCard(e.projectDir, 'c1');
  }
  const e = setup(t, 'failedevents');
  await start(e, { lane: 'agy-fast' });
  await untilState(e, 'failed');
  assert.equal(thread(e.projectDir).turns[0].error, 'agy failed', 'agy writes no events: nothing to add');
});

test('the events reason: turn.failed beats an error event, a JSON body is reduced, bad lines are skipped, and the line is one and capped', async (t) => {
  const j = (message) => JSON.stringify({ type: 'error', message });
  const failed = (message) => JSON.stringify({ type: 'turn.failed', error: { message } });
  const long = 'x'.repeat(900);
  const cases = [
    [[j('first error'), failed('the turn failed')], 'the turn failed'],
    [[failed('the turn failed'), j('a later error event')], 'the turn failed'],
    [[JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'only a warning' } }), j('plain text error')], 'plain text error'],
    [[JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'only a warning' } })], ''],
    [['not json at all', '{"type":', j('JSON bodies are reduced'), '', '[1,2]'], 'JSON bodies are reduced'],
    [[failed(JSON.stringify({ error: { message: 'inner message' } }))], 'inner message'],
    [[failed('line one\nline two')], 'line one'],
    [[failed(long)], 'x'.repeat(300)],
  ];
  for (const [lines, want] of cases) {
    const file = path.join(setup(t).base, 'events.txt');
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const e = setup(t, 'failedevents', { FAKE_RELAY_EVENTS_FILE: file });
    await start(e);
    await untilState(e, 'failed');
    assert.equal(thread(e.projectDir).turns[0].error, want ? `codex failed: ${want}` : 'codex failed', JSON.stringify(lines).slice(0, 60));
    await core.removeCard(e.projectDir, 'c1');
  }
});

test('thread_report on a thread whose only turn failed names that turn\'s error', async (t) => {
  const e = setup(t, 'failed', { FAKE_RELAY_STDERR_TAIL: 'ERROR: not logged in' });
  const c = new McpClient(e);
  t.after(() => c.kill());
  await c.init();
  await c.call('thread_start', { title: 'Lane thread', task: TASK, session_id: PARENT_SESSION, lane: 'code-codex' });
  await untilState(e, 'failed');
  const r = await c.call('thread_report', { id: 'c1', session_id: PARENT_SESSION });
  assert.equal(r.isError, true);
  assert.equal(r.text, 'thread c1 has no successful turn yet (state: failed); its last turn failed: codex failed: ERROR: not logged in');
});

// ------------------------------------------------------------ the read-only sentence

test('a read-mode lane turn\'s prompt says the run is read-only and not to leave plan mode; a write turn and a normal thread do not get it', async (t) => {
  const note = 'This run is read-only: answer from reading and reporting, without editing files and without trying to leave plan mode.';
  const e = setup(t);
  await start(e, { lane: 'claude-edit' });
  await untilState(e, 'idle');
  await core.continueThread(e.projectDir, 'c1', 'and again');
  await untilState(e, 'idle');
  const [first, second] = e.relays();
  assert.ok(first.brief.includes(note), 'first turn');
  assert.ok(second.brief.includes(note), 'follow-up');
  assert.ok(first.brief.indexOf(note) < first.brief.indexOf('End your reply'), 'one sentence among the instructions, before the digest request');
  const w = await start(e, { lane: 'claude-edit', mode: 'write' });
  await untilState(e, 'idle', w.id);
  assert.equal(e.relays()[2].brief.includes(note), false, 'a write turn may edit');
  assert.equal(e.relays()[2].brief.includes('plan mode'), false);
  const plain = await core.startThread(e.projectDir, { title: 'Plain', task: TASK, sessionId: PARENT_SESSION });
  await untilState(e, 'idle', plain.id);
  assert.equal(e.readLog().some((r) => r.prompt.includes('plan mode')), false, 'a thread that is not on a lane is untouched');
});
