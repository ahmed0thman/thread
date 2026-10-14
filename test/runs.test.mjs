import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupThreadEnv, cleanAmbientEnv, runNode, waitFor, sleep, writeStateFile, emptyState, statePathFor, threadCard, oldServerFrom, RELEASED_REFS, HOOK_PATH, TEST_DIR } from './helpers.mjs';
import * as core from '../server/core.mjs';
import * as runs from '../server/runs.mjs';
import { startBoardServer } from '../server/http.mjs';

cleanAmbientEnv();

const FIXTURES = path.join(TEST_DIR, 'fixtures', 'subagent');
const SESSION = '6ae41e2c-1306-4bce-9b23-c130a80d69a0';
const READ_ID = 'a6c7a9a2c6c7bf0eb';     // four tool calls and two text blocks, [c8] in the real run
const COUNT_ID = 'ace0e2202a4df1a13';    // one tool call, [c7] in the real run

const task = (id, over = {}) => ({ id, kind: 'task', title: `Task ${id}`, note: '', status: 'new', source: 'user', seenByClaude: true, createdAt: '2026-10-14T03:00:00.000Z', updatedAt: '2026-10-14T03:00:00.000Z', ...over });

/** A temporary data dir, project and fake ~/.claude/projects (THREAD_CLAUDE_PROJECTS_DIR) with one main session transcript. */
function world(t, cards = [task('c7'), task('c8')]) {
  const e = setupThreadEnv(t);
  const projects = path.join(e.base, 'claude-projects');
  const folder = path.join(projects, '-work-shop');
  const subDir = path.join(folder, SESSION, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const main = path.join(folder, `${SESSION}.jsonl`);
  fs.writeFileSync(main, '');
  e.setEnv('THREAD_CLAUDE_PROJECTS_DIR', projects);
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, cards));
  /** Put a fixture sub-agent in place, as Claude Code does: its meta file, and its transcript unless `transcript` is false. */
  const install = (fixture, { description, spawnDepth = 1, requestShape = 'foreground', transcript = true } = {}) => {
    const meta = JSON.parse(fs.readFileSync(path.join(FIXTURES, `agent-${fixture}.meta.json`), 'utf8'));
    if (description !== undefined) meta.description = description;
    meta.spawnDepth = spawnDepth;
    meta.requestShape = requestShape;
    fs.writeFileSync(path.join(subDir, `agent-${fixture}.meta.json`), JSON.stringify(meta));
    const file = path.join(subDir, `agent-${fixture}.jsonl`);
    if (transcript) fs.copyFileSync(path.join(FIXTURES, `agent-${fixture}.jsonl`), file);
    return file;
  };
  const input = (event, agentId, extra = {}) => ({ session_id: SESSION, transcript_path: main, cwd: e.projectDir, hook_event_name: event, agent_id: agentId, agent_type: 'tiny', ...extra });
  const state = () => core.readState(e.projectDir);
  const card = (id) => state().cards.find((c) => c.id === id);
  return { ...e, projects, folder, subDir, main, install, input, state, card };
}

function hook(w, event, input, extraEnv = {}) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: w.projectDir, THREAD_DATA_DIR: w.dataDir, ...extraEnv };
  for (const [k, v] of Object.entries(extraEnv)) if (v === undefined) delete env[k];
  return runNode([HOOK_PATH, event], { env, input: JSON.stringify(input), cwd: w.projectDir });
}

const STOP_TEXT = 'The word found in c.txt is **gamma**.';

// ---------------------------------------------------------------- the hooks

test('SubagentStart with a [cN] description adds a running run to the card and prints nothing', async (t) => {
  const w = world(t);
  w.install(READ_ID, { description: '[c8] read each file' });
  const r = await hook(w, 'SubagentStart', w.input('SubagentStart', READ_ID));
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '', 'nothing may enter the session\'s context');
  assert.equal(r.stderr, '');
  await waitFor(() => w.card('c8').runs);   // the background worker records it
  const c = w.card('c8');
  assert.equal(c.runs.length, 1);
  const run = c.runs[0];
  assert.equal(run.n, 1);
  assert.equal(run.agentId, READ_ID);
  assert.equal(run.agentType, 'tiny');
  assert.equal(run.mode, 'foreground');
  assert.equal(run.description, '[c8] read each file');
  assert.equal(run.state, 'running');
  assert.equal(run.sessionId, SESSION);
  assert.equal(run.finishedAt, null);
  assert.equal(run.ok, null);
  assert.ok(Date.parse(run.startedAt) > 0);
  assert.equal(run.transcript, path.join(fs.realpathSync(w.subDir), `agent-${READ_ID}.jsonl`));
  assert.match(run.prompt, /^Read a\.txt, then b\.txt/, 'the prompt is the first line of the transcript');
  assert.equal(w.card('c7').runs, undefined, 'the other card is untouched');
  assert.equal(c.updatedAt, '2026-10-14T03:00:00.000Z', 'a run does not count as an edit of the card, so an open form shows no conflict');
});

test('SubagentStart without a marker, with an unknown card, or on a thread or milestone writes nothing', async (t) => {
  const w = world(t, [task('c7'), threadCard({ id: 'c3' }), task('c4', { kind: 'milestone' })]);
  const before = fs.readFileSync(statePathFor(w.dataDir, w.projectDir), 'utf8');
  const cases = [['read each file', 'no marker'], ['c7 read each file', 'no brackets'], ['[c99] read each file', 'unknown card'], ['[c3] read each file', 'a thread card'], ['[c4] read each file', 'a milestone'], ['read [c7] each file', 'marker not first']];
  for (const [description, why] of cases) {
    w.install(READ_ID, { description });
    const r = await hook(w, 'SubagentStart', w.input('SubagentStart', READ_ID));
    assert.equal(r.code, 0, why);
    assert.equal(r.stdout, '', why);
    await sleep(500);   // a background worker would be done by now
    assert.equal(fs.readFileSync(statePathFor(w.dataDir, w.projectDir), 'utf8'), before, `${why}: the state file is not touched`);
  }
});

test('SubagentStart for a card of another project records nothing, and creates no state file', async (t) => {
  const w = world(t);
  const other = path.join(w.base, 'other-project');
  fs.mkdirSync(other);
  w.install(READ_ID, { description: '[c8] read each file' });
  const r = await hook(w, 'SubagentStart', w.input('SubagentStart', READ_ID, { cwd: other }), { CLAUDE_PROJECT_DIR: other });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  await sleep(500);
  assert.equal(w.card('c8').runs, undefined, 'the card of this project is not given the run');
  assert.equal(fs.existsSync(statePathFor(w.dataDir, other)), false, 'the other project got no state file');
});

test('a thread\'s own process records nothing', async (t) => {
  const w = world(t);
  w.install(READ_ID, { description: '[c8] read each file' });
  const r = await hook(w, 'SubagentStart', w.input('SubagentStart', READ_ID), { THREAD_DEPTH: '1' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  await sleep(500);
  assert.equal(w.card('c8').runs, undefined);
});

test('chat-only mode records nothing, at start and at stop', async (t) => {
  const w = world(t);
  w.install(READ_ID, { description: '[c8] read each file' });
  await core.saveConfig(w.projectDir, 'project', { mode: 'chat' });
  const r = await hook(w, 'SubagentStart', w.input('SubagentStart', READ_ID));
  assert.equal(r.code, 0);
  await sleep(500);
  assert.equal(w.card('c8').runs, undefined);
  // a run that exists when the project turns chat-only stays as it is
  await core.saveConfig(w.projectDir, 'project', { mode: 'tasks' });
  await hook(w, 'SubagentStart', w.input('SubagentStart', READ_ID));
  await waitFor(() => w.card('c8').runs);
  await core.saveConfig(w.projectDir, 'project', { mode: 'chat' });
  await hook(w, 'SubagentStop', w.input('SubagentStop', READ_ID, { last_assistant_message: STOP_TEXT }));
  assert.equal(w.card('c8').runs[0].state, 'running');
});

test('a background agent is recorded as background', async (t) => {
  const w = world(t);
  w.install(COUNT_ID, { description: '[c7] count the files', requestShape: 'background' });
  assert.equal(await runs.startRun(w.projectDir, w.input('SubagentStart', COUNT_ID)), true);
  assert.equal(w.card('c7').runs[0].mode, 'background');
});

test('a second SubagentStart for the same agent reopens its run instead of adding one', async (t) => {
  const w = world(t);
  w.install(COUNT_ID, { description: '[c7] count the files' });
  await runs.startRun(w.projectDir, w.input('SubagentStart', COUNT_ID));
  await runs.stopRun(w.projectDir, w.input('SubagentStop', COUNT_ID, { last_assistant_message: 'first report' }), { settleMs: 0 });
  assert.equal(w.card('c7').runs[0].state, 'done');
  await runs.startRun(w.projectDir, w.input('SubagentStart', COUNT_ID));
  const list = w.card('c7').runs;
  assert.equal(list.length, 1);
  assert.equal(list[0].state, 'running');
  assert.equal(list[0].finishedAt, null);
  assert.equal(list[0].ok, null);
  assert.equal(list[0].result, 'first report', 'the earlier report stays until the new one comes');
  await runs.stopRun(w.projectDir, w.input('SubagentStop', COUNT_ID, { last_assistant_message: 'second report' }), { settleMs: 0 });
  assert.equal(w.card('c7').runs[0].result, 'second report');
  assert.equal(w.card('c7').runs[0].state, 'done');
});

test('a nested sub-agent (spawnDepth 2) is ignored', async (t) => {
  const w = world(t);
  w.install(COUNT_ID, { description: '[c7] count the files', spawnDepth: 2 });
  assert.equal(await runs.startRun(w.projectDir, w.input('SubagentStart', COUNT_ID)), false);
  assert.equal(w.card('c7').runs, undefined);
});

test('input that is not what Claude Code sends records nothing', async (t) => {
  const w = world(t);
  w.install(COUNT_ID, { description: '[c7] count the files' });
  const good = w.input('SubagentStart', COUNT_ID);
  const outside = path.join(w.base, 'elsewhere', '-work-shop', `${SESSION}.jsonl`);
  const bad = [
    { ...good, agent_id: '../../x' }, { ...good, agent_id: 'agent-' + COUNT_ID }, { ...good, agent_id: 7 },
    { ...good, transcript_path: outside }, { ...good, transcript_path: 'relative/path.jsonl' }, { ...good, transcript_path: path.join(w.folder, 'notes.txt') },
    { ...good, transcript_path: path.join(w.folder, '...jsonl') },
  ];
  for (const input of bad) assert.equal(await runs.startRun(w.projectDir, input), false, JSON.stringify(input).slice(0, 120));
  assert.equal(w.card('c7').runs, undefined);
  for (const raw of ['', 'not json', '[]', 'null']) {
    const r = await runNode([HOOK_PATH, 'SubagentStart'], { env: { ...process.env, CLAUDE_PROJECT_DIR: w.projectDir }, input: raw, cwd: w.projectDir });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  }
});

test('SubagentStop closes the run with the report from last_assistant_message, the steps, the tokens, and a snapshot', async (t) => {
  const w = world(t);
  w.install(READ_ID, { description: '[c8] read each file' });
  await hook(w, 'SubagentStart', w.input('SubagentStart', READ_ID));
  const started = Date.now();
  const r = await hook(w, 'SubagentStop', w.input('SubagentStop', READ_ID, {
    last_assistant_message: STOP_TEXT,
    agent_transcript_path: path.join(w.subDir, `agent-${READ_ID}.jsonl`),
    stop_hook_active: false,
    background_tasks: [],
  }));
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  assert.ok(Date.now() - started >= 450, 'the hook waits for the last transcript line');
  const run = w.card('c8').runs[0];
  assert.equal(run.state, 'done');
  assert.equal(run.ok, true);
  assert.equal(run.result, STOP_TEXT);
  assert.ok(Date.parse(run.finishedAt) >= Date.parse(run.startedAt));
  assert.equal(run.steps, 4);
  assert.deepEqual(run.usage, { input: 3662, cacheRead: 16551, cacheWrite: 6041, output: 1124 });
  assert.equal(run.snapshot, true);
  const snap = path.join(core.projectPaths(w.projectDir).logs, 'c8.r1.activity.jsonl');
  const events = fs.readFileSync(snap, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => e.kind), ['tool', 'tool_result', 'tool', 'tool_result', 'tool', 'tool_result', 'text', 'tool', 'tool_result', 'text']);
  assert.deepEqual(events.filter((e) => e.kind === 'tool').map((e) => e.name), ['Read', 'Read', 'Read', 'Grep']);
  assert.match(events[0].summary, /a\.txt$/);
  assert.equal(events[1].ok, true);
  assert.equal(events[1].preview, '1 alpha 2');
  assert.match(events[0].at, /^2026-10-14T03:07:/);
});

test('SubagentStop for an agent with no run returns at once and writes nothing', async (t) => {
  const w = world(t);
  const before = fs.readFileSync(statePathFor(w.dataDir, w.projectDir), 'utf8');
  const started = Date.now();
  assert.equal(await runs.stopRun(w.projectDir, w.input('SubagentStop', COUNT_ID, { last_assistant_message: 'x' })), false);
  assert.ok(Date.now() - started < 300, 'no half-second wait for an agent that is not tracked');
  assert.equal(fs.readFileSync(statePathFor(w.dataDir, w.projectDir), 'utf8'), before);
  assert.equal(fs.existsSync(core.projectPaths(w.projectDir).logs), false);
});

test('SubagentStop still closes the run when the transcript is gone', async (t) => {
  const w = world(t);
  const file = w.install(COUNT_ID, { description: '[c7] count the files' });
  await runs.startRun(w.projectDir, w.input('SubagentStart', COUNT_ID));
  fs.rmSync(file);
  await runs.stopRun(w.projectDir, w.input('SubagentStop', COUNT_ID, { last_assistant_message: 'done anyway' }), { settleMs: 0 });
  const run = w.card('c7').runs[0];
  assert.equal(run.state, 'done');
  assert.equal(run.result, 'done anyway');
  assert.equal(run.snapshot, undefined);
  assert.equal(run.usage, undefined);
});

test('tokens count each message id once, by its last line, not every line', () => {
  const scan = runs.scanTranscript(path.join(FIXTURES, `agent-${READ_ID}.jsonl`));
  assert.deepEqual(scan.usage, { input: 3662, cacheRead: 16551, cacheWrite: 6041, output: 1124 });
  const naive = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const l of fs.readFileSync(path.join(FIXTURES, `agent-${READ_ID}.jsonl`), 'utf8').trim().split('\n')) {
    const u = JSON.parse(l).message.usage;
    if (!u) continue;
    naive.input += u.input_tokens; naive.cacheRead += u.cache_read_input_tokens; naive.cacheWrite += u.cache_creation_input_tokens; naive.output += u.output_tokens;
  }
  assert.notDeepEqual(scan.usage, naive, 'summing every line would double count');
  assert.equal(naive.input, 7332);
  const count = runs.scanTranscript(path.join(FIXTURES, `agent-${COUNT_ID}.jsonl`));
  assert.deepEqual(count.usage, { input: 3607, cacheRead: 0, cacheWrite: 5608, output: 1784 });
  assert.equal(count.steps, 1);
  assert.match(count.prompt, /^List the files/);
});

test('a card keeps at most 50 runs: the oldest go, with their snapshots', async (t) => {
  const w = world(t);
  w.install(COUNT_ID, { description: '[c7] count the files' });
  const logs = core.projectPaths(w.projectDir).logs;
  fs.mkdirSync(logs, { recursive: true });
  const old = Array.from({ length: 50 }, (_, i) => ({ n: i + 1, agentId: `b${String(i).padStart(8, '0')}`, agentType: 'tiny', mode: 'foreground', description: '[c7] x', state: 'done', sessionId: SESSION, startedAt: '2026-10-14T03:00:00.000Z', finishedAt: '2026-10-14T03:01:00.000Z', ok: true, prompt: 'p', result: 'r', transcript: '/x' }));
  writeStateFile(w.dataDir, w.projectDir, emptyState(w.projectDir, [task('c7', { runs: old })]));
  fs.writeFileSync(path.join(logs, 'c7.r1.activity.jsonl'), '');
  fs.writeFileSync(path.join(logs, 'c7.r2.activity.jsonl'), '');
  await runs.startRun(w.projectDir, w.input('SubagentStart', COUNT_ID));
  const list = w.card('c7').runs;
  assert.equal(list.length, 50);
  assert.equal(list[0].n, 2);
  assert.equal(list[49].n, 51, 'numbers keep counting up, so a snapshot never changes owner');
  assert.equal(fs.existsSync(path.join(logs, 'c7.r1.activity.jsonl')), false);
  assert.equal(fs.existsSync(path.join(logs, 'c7.r2.activity.jsonl')), true);
});

// ---------------------------------------------------------------- card history

test('history records create, move and edit, by the user and by Claude', async (t) => {
  const e = setupThreadEnv(t);
  const a = await core.addCard(e.projectDir, { title: 'From Claude' });
  const b = await core.addCard(e.projectDir, { title: 'From the user', source: 'user' });
  assert.deepEqual(a.history.map((x) => [x.type, x.by, x.to]), [['created', 'claude', 'new']]);
  assert.deepEqual(b.history.map((x) => [x.type, x.by]), [['created', 'user']]);
  assert.ok(Date.parse(a.history[0].at) > 0);
  await core.updateCard(e.projectDir, a.id, { status: 'in_progress' }, { source: 'claude' });
  await core.updateCard(e.projectDir, a.id, { status: 'review', title: 'Renamed', note: 'n' }, { source: 'user' });
  const m = await core.addCard(e.projectDir, { title: 'Launch', kind: 'milestone' });
  await core.updateCard(e.projectDir, a.id, { parent: m.id }, { source: 'claude' });
  await core.updateCard(e.projectDir, a.id, { parent: '' }, { source: 'claude' });
  const h = core.readState(e.projectDir).cards.find((c) => c.id === a.id).history.map(({ at, ...x }) => x);
  assert.deepEqual(h, [
    { by: 'claude', type: 'created', to: 'new' },
    { by: 'claude', type: 'moved', from: 'new', to: 'in_progress' },
    { by: 'user', type: 'moved', from: 'in_progress', to: 'review' },
    { by: 'user', type: 'edited', fields: ['title', 'note'] },
    { by: 'claude', type: 'edited', fields: ['milestone'] },
    { by: 'claude', type: 'edited', fields: ['milestone'] },
  ]);
});

test('an update that changes nothing adds no history, and a thread card gets none', async (t) => {
  const e = setupThreadEnv(t);
  const c = await core.addCard(e.projectDir, { title: 'Same' });
  await core.updateCard(e.projectDir, c.id, { title: 'Same', status: 'new', note: '' }, { source: 'user' });
  assert.equal(core.readState(e.projectDir).cards[0].history.length, 1);
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [threadCard({ id: 'c1' })]));
  await core.updateCard(e.projectDir, 'c1', { title: 'Renamed thread' }, { source: 'user' });
  assert.equal(core.readState(e.projectDir).cards[0].history, undefined);
});

test('history keeps the last 50 entries', async (t) => {
  const e = setupThreadEnv(t);
  const c = await core.addCard(e.projectDir, { title: 'Busy' });
  for (let i = 0; i < 60; i++) await core.updateCard(e.projectDir, c.id, { status: i % 2 ? 'new' : 'review' }, { source: i % 3 ? 'claude' : 'user' });
  const h = core.readState(e.projectDir).cards[0].history;
  assert.equal(h.length, 50);
  assert.equal(h[0].type, 'moved', 'the created entry was pushed out');
  assert.equal(h[49].to, 'new');
  assert.equal(core.MAX_HISTORY, 50);
});

// ---------------------------------------------------------------- an older version writing

for (const ref of RELEASED_REFS) test(`the plugin version at ${ref} keeps runs and history when it writes`, async (t) => {
  const old = oldServerFrom(t, ref);
  if (!old) return;
  const e = setupThreadEnv(t);
  const run = { n: 1, agentId: COUNT_ID, agentType: 'tiny', mode: 'foreground', description: '[c1] x', state: 'done', sessionId: SESSION, startedAt: '2026-10-14T03:00:00.000Z', finishedAt: '2026-10-14T03:01:00.000Z', ok: true, prompt: 'p', result: 'r', steps: 2, usage: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 }, transcript: '/x', snapshot: true };
  const history = [{ at: '2026-10-14T03:00:00.000Z', by: 'user', type: 'created', to: 'new' }];
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [task('c1', { runs: [run], history }), task('c2')]));
  const r = await runNode([path.join(TEST_DIR, 'fixtures', 'old-writer.mjs'), old, e.projectDir], { env: { ...process.env, THREAD_DATA_DIR: e.dataDir } });
  assert.equal(r.code, 0, r.stderr);
  const c = core.readState(e.projectDir).cards.find((x) => x.id === 'c1');
  assert.equal(c.title, 'Renamed by the older version', 'the older version did write');
  assert.deepEqual(c.runs, [run]);
  assert.deepEqual(c.history.slice(0, history.length), history, 'the older version drops none of the entries (from 0.11.0 on it adds its own)');
});

// ---------------------------------------------------------------- the board's route

async function board(t, w) {
  const b = await startBoardServer(w.projectDir, { port: 0, token: 'a'.repeat(32) });
  t.after(() => new Promise((r) => { b.server.closeAllConnections?.(); b.server.close(() => r()); }));
  const get = async (p, headers = { 'x-thread-token': 'a'.repeat(32) }) => {
    const res = await fetch(`http://127.0.0.1:${b.port}${p}`, { headers });
    return { status: res.status, body: await res.json() };
  };
  return { ...b, get };
}

const runRecord = (over = {}) => ({ n: 1, agentId: COUNT_ID, agentType: 'tiny', mode: 'foreground', description: '[c7] count the files', state: 'running', sessionId: SESSION, startedAt: '2026-10-14T03:05:33.000Z', finishedAt: null, ok: null, prompt: null, result: null, ...over });
const ACT = '/api/cards/c7/runs/1/activity';

test('the route reads a running run\'s transcript from an offset, a whole line at a time', async (t) => {
  const w = world(t);
  const file = w.install(COUNT_ID, { description: '[c7] count the files' });
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(file, lines.slice(0, 3).join('\n') + '\n');
  writeStateFile(w.dataDir, w.projectDir, emptyState(w.projectDir, [task('c7', { runs: [runRecord({ transcript: file })] })]));
  const b = await board(t, w);
  let r = await b.get(ACT);
  assert.equal(r.status, 200);
  assert.equal(r.body.running, true);
  assert.equal(r.body.run, 1);
  assert.match(r.body.prompt, /^List the files/);
  assert.deepEqual(r.body.events.map((e) => e.kind), ['tool']);
  assert.equal(r.body.more, false);
  assert.equal(r.body.next, fs.statSync(file).size);
  // the file grows, the last line only half written
  fs.appendFileSync(file, lines[3] + '\n' + lines[4].slice(0, 40));
  r = await b.get(`${ACT}?offset=${r.body.next}`);
  assert.deepEqual(r.body.events.map((e) => e.kind), ['tool_result'], 'only whole lines are returned');
  assert.equal(r.body.prompt, null, 'the prompt comes with the first read only');
  const afterWhole = r.body.next;
  assert.ok(afterWhole < fs.statSync(file).size, 'the half line is left for the next read');
  fs.appendFileSync(file, lines[4].slice(40) + '\n' + lines[5] + '\n');
  r = await b.get(`${ACT}?offset=${afterWhole}`);
  assert.deepEqual(r.body.events.map((e) => e.kind), ['text']);
  // an offset past the end starts over
  r = await b.get(`${ACT}?offset=999999999`);
  assert.equal(r.body.events.length, 3);
});

test('a finished run is read from its snapshot, which outlives the transcript', async (t) => {
  const w = world(t);
  const file = w.install(COUNT_ID, { description: '[c7] count the files' });
  writeStateFile(w.dataDir, w.projectDir, emptyState(w.projectDir, [task('c7', { runs: [runRecord({ transcript: file })] })]));
  await runs.stopRun(w.projectDir, w.input('SubagentStop', COUNT_ID, { last_assistant_message: 'five' }), { settleMs: 0 });
  fs.rmSync(file);
  const b = await board(t, w);
  const r = await b.get(ACT);
  assert.equal(r.status, 200);
  assert.equal(r.body.running, false);
  assert.equal(r.body.next, null);
  assert.deepEqual(r.body.events.map((e) => e.kind), ['tool', 'tool_result', 'text']);
  assert.equal(r.body.gone, undefined);
});

test('a finished run without a snapshot is read from its transcript while that exists, and says it is gone after', async (t) => {
  const w = world(t);
  const file = w.install(COUNT_ID, { description: '[c7] count the files' });
  writeStateFile(w.dataDir, w.projectDir, emptyState(w.projectDir, [task('c7', { runs: [runRecord({ transcript: file, state: 'done', ok: true, finishedAt: '2026-10-14T03:06:00.000Z' })] })]));
  const b = await board(t, w);
  assert.equal((await b.get(ACT)).body.events.length, 3);
  fs.rmSync(file);
  const r = await b.get(ACT);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.events, []);
  assert.equal(r.body.gone, true);
});

test('the route refuses a transcript outside the projects folder, a symlink, a wrong name and any path from the request', async (t) => {
  const w = world(t);
  const good = w.install(COUNT_ID, { description: '[c7] count the files' });
  const secret = path.join(w.base, 'secret.jsonl');
  fs.copyFileSync(good, secret);                                       // a valid transcript, in the wrong place
  const cases = {};
  cases.outside = secret;
  cases.relative = `claude-projects/-work-shop/${SESSION}/subagents/agent-${COUNT_ID}.jsonl`;
  cases.traversal = path.join(w.subDir, '..', '..', '..', '..', 'secret.jsonl');
  cases.notAgentFile = path.join(w.folder, `${SESSION}.jsonl`);
  cases.wrongDepth = path.join(w.folder, `agent-${COUNT_ID}.jsonl`);
  fs.mkdirSync(path.join(w.folder, SESSION, 'tool-results'));
  fs.copyFileSync(good, path.join(w.folder, SESSION, 'tool-results', `agent-${COUNT_ID}.jsonl`));
  cases.notSubagentsDir = path.join(w.folder, SESSION, 'tool-results', `agent-${COUNT_ID}.jsonl`);
  cases.notHex = path.join(w.subDir, 'agent-zzzzzz.jsonl');
  fs.copyFileSync(good, cases.notHex);
  const other = path.join(w.subDir, 'agent-bbbbbbbbbbbb.jsonl');       // a real agent file, but another agent's
  fs.copyFileSync(good, other);
  cases.otherAgent = other;
  const link = path.join(w.subDir, 'agent-cccccccccccc.jsonl');       // a link to a file outside
  fs.symlinkSync(secret, link);
  cases.symlink = link;
  const linkedDir = path.join(w.folder, 'aaaaaaaa-0000-4000-8000-000000000000');   // a subagents folder that is a link
  fs.mkdirSync(linkedDir);
  fs.mkdirSync(path.join(w.base, 'elsewhere'));
  fs.copyFileSync(good, path.join(w.base, 'elsewhere', `agent-${COUNT_ID}.jsonl`));
  fs.symlinkSync(path.join(w.base, 'elsewhere'), path.join(linkedDir, 'subagents'));
  cases.linkedDir = path.join(linkedDir, 'subagents', `agent-${COUNT_ID}.jsonl`);
  cases.dir = w.subDir;
  cases.empty = '';
  cases.nul = good + '\0';
  const cards = Object.keys(cases).map((k, i) => task(`c${100 + i}`, { runs: [runRecord({ transcript: cases[k] })] }));
  cards.push(task('c7', { runs: [runRecord({ transcript: good })] }));
  writeStateFile(w.dataDir, w.projectDir, emptyState(w.projectDir, cards));
  const b = await board(t, w);
  for (const [i, k] of Object.keys(cases).entries()) {
    const r = await b.get(`/api/cards/c${100 + i}/runs/1/activity`);
    assert.equal(r.status, 200, k);
    assert.equal(r.body.gone, true, `${k}: not read`);
    assert.deepEqual(r.body.events, [], k);
  }
  // the one recorded and well-formed path works, and a path in the request changes nothing
  assert.equal((await b.get(ACT)).body.events.length, 3);
  const asked = await b.get(`${ACT}?path=${encodeURIComponent(secret)}&transcript=${encodeURIComponent(secret)}&file=${encodeURIComponent(secret)}`);
  assert.equal(asked.body.events.length, 3);
  // a run that is not on the card, a card that is not there and a thread
  assert.equal((await b.get('/api/cards/c7/runs/2/activity')).status, 404);
  assert.equal((await b.get('/api/cards/c99/runs/1/activity')).status, 404);
  assert.equal((await b.get('/api/cards/c7/runs/x/activity')).status, 404);
});

test('the route needs the board token and the card list never carries a transcript path', async (t) => {
  const w = world(t);
  const file = w.install(COUNT_ID, { description: '[c7] count the files' });
  writeStateFile(w.dataDir, w.projectDir, emptyState(w.projectDir, [task('c7', { runs: [runRecord({ transcript: file, prompt: 'the prompt' })] }), threadCard({ id: 'c3' })]));
  const b = await board(t, w);
  assert.equal((await b.get(ACT, {})).status, 401);
  assert.equal((await b.get('/api/cards/c3/runs/1/activity')).status, 404);
  const s = await b.get('/api/state');
  const run = s.body.cards.find((c) => c.id === 'c7').runs[0];
  assert.equal(run.transcript, undefined);
  assert.equal(run.prompt, 'the prompt');
  assert.equal(JSON.stringify(s.body).includes(w.projects), false);
});

test('a huge transcript is read a chunk at a time, and a line longer than a chunk is skipped', async (t) => {
  const w = world(t);
  const file = path.join(w.subDir, `agent-${COUNT_ID}.jsonl`);
  const tool = (i) => JSON.stringify({ type: 'assistant', message: { id: `m${i}`, content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: `/work/shop/f${i}.txt` } }] } });
  const parts = [JSON.stringify({ type: 'user', message: { content: 'p' } })];
  for (let i = 0; i < 40000; i++) parts.push(tool(i));
  parts.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'y'.repeat(3 * 1024 * 1024) }] } }));
  parts.push(tool(99999));
  fs.writeFileSync(file, parts.join('\n') + '\n');
  assert.ok(fs.statSync(file).size > 4 * 1024 * 1024);
  writeStateFile(w.dataDir, w.projectDir, emptyState(w.projectDir, [task('c7', { runs: [runRecord({ transcript: file })] })]));
  const b = await board(t, w);
  let offset = 0, total = 0, requests = 0, last = null;
  for (;;) {
    const r = await b.get(`${ACT}?offset=${offset}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.events.length <= 500, 'a response holds at most 500 events');
    assert.ok(r.body.next - offset <= 1024 * 1024, 'a request reads at most one chunk');
    total += r.body.events.length;
    requests += 1;
    last = r.body.events[r.body.events.length - 1] || last;
    offset = r.body.next;
    if (!r.body.more) break;
    assert.ok(requests < 400);
  }
  assert.equal(offset, fs.statSync(file).size);
  assert.ok(requests > 80, `read in ${requests} requests`);
  assert.equal(total, 40001, 'the 3 MB line made no event, every other line did');
  assert.equal(last.summary, '/work/shop/f99999.txt');
});

// ---------------------------------------------------------------- the meta file lands late, or the start is missed

test('a meta file that appears 150 ms after SubagentStart is waited for; one that never appears gives up after about 400 ms', async (t) => {
  const w = world(t);
  const metaFile = path.join(w.subDir, `agent-${COUNT_ID}.meta.json`);
  fs.copyFileSync(path.join(FIXTURES, `agent-${COUNT_ID}.jsonl`), path.join(w.subDir, `agent-${COUNT_ID}.jsonl`));
  const meta = fs.readFileSync(path.join(FIXTURES, `agent-${COUNT_ID}.meta.json`), 'utf8');
  setTimeout(() => fs.writeFileSync(metaFile, meta), 150);
  assert.equal(await runs.startRun(w.projectDir, w.input('SubagentStart', COUNT_ID)), true);
  assert.equal(w.card('c7').runs[0].agentId, COUNT_ID);
  fs.rmSync(metaFile);
  const t0 = Date.now();
  assert.equal(await runs.startRun(w.projectDir, w.input('SubagentStart', 'bbbbbbbbbbbb')), false);
  assert.ok(Date.now() - t0 >= 350 && Date.now() - t0 < 1500, `waited ${Date.now() - t0} ms`);
});

test('a start that found no meta file is made up for at stop: the run is created and closed in one step', async (t) => {
  const w = world(t);
  w.install(READ_ID, { description: '[c8] read each file', transcript: true });
  fs.rmSync(path.join(w.subDir, `agent-${READ_ID}.meta.json`));
  assert.equal(await runs.startRun(w.projectDir, w.input('SubagentStart', READ_ID), { retryMs: 0 }), false);
  assert.equal(w.card('c8').runs, undefined);
  w.install(READ_ID, { description: '[c8] read each file' });   // the meta file is there by the time the agent stops
  assert.equal(await runs.stopRun(w.projectDir, w.input('SubagentStop', READ_ID, { last_assistant_message: STOP_TEXT }), { settleMs: 0 }), true);
  const run = w.card('c8').runs[0];
  assert.equal(run.state, 'done');
  assert.equal(run.result, STOP_TEXT);
  assert.equal(run.steps, 4);
  assert.equal(run.agentType, 'tiny');
  assert.equal(run.snapshot, true);
  assert.match(run.prompt, /^Read a\.txt/);
  // a stop for an agent whose meta has no marker, or names no card, still creates nothing
  w.install(COUNT_ID, { description: 'no marker' });
  assert.equal(await runs.stopRun(w.projectDir, w.input('SubagentStop', COUNT_ID, { last_assistant_message: 'x' }), { settleMs: 0 }), false);
  w.install(COUNT_ID, { description: '[c99] unknown' });
  assert.equal(await runs.stopRun(w.projectDir, w.input('SubagentStop', COUNT_ID, { last_assistant_message: 'x' }), { settleMs: 0 }), false);
  assert.equal(w.card('c7').runs, undefined);
});

// ---------------------------------------------------------------- the lock, and CLAUDE_CONFIG_DIR

test('the stop hook waits for the state lock long enough to close the run, and the start hook does not wait long', async (t) => {
  const w = world(t);
  w.install(COUNT_ID, { description: '[c7] count the files' });
  await runs.startRun(w.projectDir, w.input('SubagentStart', COUNT_ID));
  const held = core.withLock(w.projectDir, () => new Promise((r) => setTimeout(r, 1800)));
  await new Promise((r) => setTimeout(r, 100));
  const r = await hook(w, 'SubagentStop', w.input('SubagentStop', COUNT_ID, { last_assistant_message: 'late but recorded' }));
  await held;
  assert.equal(r.code, 0);
  assert.equal(w.card('c7').runs[0].state, 'done', 'the stop waited out the lock');
  assert.equal(w.card('c7').runs[0].result, 'late but recorded');
  const src = fs.readFileSync(HOOK_PATH, 'utf8');
  assert.match(src, /event === 'SubagentStop' \? '5000' : '1000'/);
});

test('CLAUDE_CONFIG_DIR/projects is the projects folder when set, and THREAD_CLAUDE_PROJECTS_DIR still wins', async (t) => {
  const w = world(t);
  const cfgRoot = path.join(w.base, 'claude-config');
  const folder = path.join(cfgRoot, 'projects', '-work-shop');
  const sub = path.join(folder, SESSION, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const main = path.join(folder, `${SESSION}.jsonl`);
  fs.writeFileSync(main, '');
  fs.copyFileSync(path.join(FIXTURES, `agent-${COUNT_ID}.jsonl`), path.join(sub, `agent-${COUNT_ID}.jsonl`));
  fs.writeFileSync(path.join(sub, `agent-${COUNT_ID}.meta.json`), JSON.stringify({ agentType: 'tiny', description: '[c7] count', spawnDepth: 1, requestShape: 'foreground' }));
  const input = { ...w.input('SubagentStart', COUNT_ID), transcript_path: main };
  w.setEnv('THREAD_CLAUDE_PROJECTS_DIR', undefined);
  w.setEnv('CLAUDE_CONFIG_DIR', cfgRoot);
  assert.equal(runs.projectsRoot(), path.join(cfgRoot, 'projects'));
  assert.equal(await runs.startRun(w.projectDir, input, { retryMs: 0 }), true);
  w.setEnv('CLAUDE_CONFIG_DIR', undefined);
  assert.equal(runs.projectsRoot(), path.join(os.homedir(), '.claude', 'projects'));
  w.setEnv('CLAUDE_CONFIG_DIR', cfgRoot);
  w.setEnv('THREAD_CLAUDE_PROJECTS_DIR', w.projects);
  assert.equal(runs.projectsRoot(), w.projects, 'the test-only variable wins');
  w.setEnv('THREAD_CLAUDE_PROJECTS_DIR', undefined);
  w.setEnv('CLAUDE_CONFIG_DIR', 'relative/dir');
  assert.equal(runs.projectsRoot(), path.join(os.homedir(), '.claude', 'projects'), 'a relative path is not trusted');
});

// ---------------------------------------------------------------- mark as stopped

const post = async (b, p, body = {}, headers = {}) => {
  const res = await fetch(`http://127.0.0.1:${b.port}${p}`, { method: 'POST', headers: { 'x-thread-token': 'a'.repeat(32), 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test('Mark as stopped sets only that run\'s state fields, and only for a running run of a task or idea', async (t) => {
  const w = world(t);
  const other = runRecord({ n: 2, agentId: 'bbbbbbbbbbbb', state: 'done', ok: true, finishedAt: '2026-10-14T03:06:00.000Z', result: 'r' });
  const cards = [task('c7', { runs: [runRecord(), other] }), task('c8', { runs: [runRecord({ agentId: 'cccccccccccc' })] }), threadCard({ id: 'c3' })];
  writeStateFile(w.dataDir, w.projectDir, emptyState(w.projectDir, cards));
  const before = JSON.parse(JSON.stringify(w.state()));
  const b = await board(t, w);
  const r = await post(b, '/api/cards/c7/runs/1/stop');
  assert.equal(r.status, 200);
  assert.equal(r.body.runs[0].state, 'stopped');
  const after = w.state();
  const run = after.cards[0].runs[0];
  assert.equal(run.ok, false);
  assert.ok(Date.parse(run.finishedAt) > 0);
  assert.match(run.note, /Marked as stopped/);
  const { state: _s, ok: _o, finishedAt: _f, note: _n, ...rest } = run;
  const { state: _s2, ok: _o2, finishedAt: _f2, ...restBefore } = before.cards[0].runs[0];
  assert.deepEqual(rest, restBefore, 'no other field of the run changed');
  assert.deepEqual(after.cards[0].runs[1], before.cards[0].runs[1], 'the other run is untouched');
  assert.deepEqual(after.cards[1], before.cards[1], 'the other card is untouched');
  assert.deepEqual({ ...after.cards[0], runs: 0 }, { ...before.cards[0], runs: 0 }, 'the card itself is untouched, updatedAt included');
  assert.equal((await post(b, '/api/cards/c7/runs/1/stop')).status, 400, 'a run that is not running cannot be marked');
  assert.equal((await post(b, '/api/cards/c7/runs/2/stop')).status, 400);
  assert.equal((await post(b, '/api/cards/c7/runs/9/stop')).status, 404, 'unknown run');
  assert.equal((await post(b, '/api/cards/c8/runs/2/stop')).status, 404, 'a run of another card');
  assert.equal((await post(b, '/api/cards/c3/runs/1/stop')).status, 404, 'a thread');
  assert.equal((await post(b, '/api/cards/c99/runs/1/stop')).status, 404);
  assert.equal((await post(b, '/api/cards/c8/runs/1/stop', {}, { 'x-thread-token': 'wrong' })).status, 401);
  assert.equal((await post(b, '/api/cards/c8/runs/1/stop', {}, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await post(b, '/api/cards/c8/runs/1/stop', {}, { 'content-type': 'text/plain' })).status, 415);
  assert.equal(w.card('c8').runs[0].state, 'running', 'none of the refused calls changed it');
  // a late stop event from the agent closes it for real
  w.install(COUNT_ID, { description: '[c8] x' });
});

test('a running run whose transcript is quiet reports how long, and a missing transcript counts from the start', async (t) => {
  const w = world(t);
  const file = w.install(COUNT_ID, { description: '[c7] count the files' });
  const old = new Date(Date.now() - 15 * 60 * 1000);
  fs.utimesSync(file, old, old);
  writeStateFile(w.dataDir, w.projectDir, emptyState(w.projectDir, [task('c7', { runs: [runRecord({ transcript: file }), runRecord({ n: 2, agentId: 'bbbbbbbbbbbb', transcript: path.join(w.subDir, 'agent-bbbbbbbbbbbb.jsonl'), startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString() })] })]));
  const b = await board(t, w);
  const quiet = (await b.get(ACT)).body.quietMs;
  assert.ok(quiet >= 14 * 60 * 1000 && quiet < 16 * 60 * 1000, String(quiet));
  const gone = (await b.get('/api/cards/c7/runs/2/activity')).body;
  assert.equal(gone.gone, true);
  assert.ok(gone.quietMs >= 19 * 60 * 1000);
});

// ---------------------------------------------------------------- long runs, big texts, offsets

test('a long run keeps its newest events and its true step count, with a marker for the earlier ones', async (t) => {
  const w = world(t);
  const file = path.join(w.subDir, `agent-${COUNT_ID}.jsonl`);
  fs.writeFileSync(path.join(w.subDir, `agent-${COUNT_ID}.meta.json`), JSON.stringify({ agentType: 'tiny', description: '[c7] long', spawnDepth: 1, requestShape: 'foreground' }));
  const parts = [JSON.stringify({ type: 'user', message: { content: 'the prompt' } })];
  for (let i = 0; i < 3000; i++) {
    parts.push(JSON.stringify({ type: 'assistant', message: { id: `m${i}`, content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: `/work/shop/f${i}.txt` } }], usage: { input_tokens: 1, output_tokens: 1 } } }));
    parts.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }] } }));
  }
  fs.writeFileSync(file, parts.join('\n') + '\n');
  await runs.startRun(w.projectDir, w.input('SubagentStart', COUNT_ID));
  await runs.stopRun(w.projectDir, w.input('SubagentStop', COUNT_ID, { last_assistant_message: 'done' }), { settleMs: 0 });
  const run = w.card('c7').runs[0];
  assert.equal(run.steps, 3000, 'the real count, not the number of events kept');
  assert.deepEqual(run.usage, { input: 3000, cacheRead: 0, cacheWrite: 0, output: 3000 });
  const b = await board(t, w);
  const ev = (await b.get(ACT)).body.events;
  assert.equal(ev.length, runs.MAX_RUN_EVENTS + 1);
  assert.equal(ev[0].kind, 'earlier');
  assert.equal(ev[0].dropped, 6000 - runs.MAX_RUN_EVENTS);
  assert.equal(ev[ev.length - 1].kind, 'tool_result');
  assert.equal(ev[ev.length - 2].summary, '/work/shop/f2999.txt', 'the newest step is kept, the first ones are not');
  assert.equal(ev.some((e) => e.summary === '/work/shop/f0.txt'), false);
});

test('the state keeps a short preview of a run\'s prompt and report, and the full text is in the logs and served by the route', async (t) => {
  const w = world(t);
  const file = w.install(COUNT_ID, { description: '[c7] count the files' });
  const prompt = 'P'.repeat(5000) + '\nsecond line';
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const first = JSON.parse(lines[0]);
  first.message.content = prompt;
  fs.writeFileSync(file, [JSON.stringify(first), ...lines.slice(1)].join('\n'));
  const report = 'R'.repeat(30000) + '\nthe end';
  await runs.startRun(w.projectDir, w.input('SubagentStart', COUNT_ID));
  await runs.stopRun(w.projectDir, w.input('SubagentStop', COUNT_ID, { last_assistant_message: report }), { settleMs: 0 });
  const run = w.card('c7').runs[0];
  assert.ok(run.prompt.length <= 300 && run.prompt.startsWith('PPP'));
  assert.ok(run.result.length <= 300 && run.result.startsWith('RRR'));
  assert.equal(run.promptFile, true);
  assert.equal(run.reportFile, true);
  assert.ok(fs.statSync(statePathFor(w.dataDir, w.projectDir)).size < 5000, 'the state file does not grow with the texts');
  const logs = core.projectPaths(w.projectDir).logs;
  assert.equal(fs.readFileSync(path.join(logs, 'c7.r1.prompt.txt'), 'utf8'), prompt);
  assert.equal(fs.readFileSync(path.join(logs, 'c7.r1.report.txt'), 'utf8'), report);
  const b = await board(t, w);
  assert.deepEqual((await b.get('/api/cards/c7/runs/1/prompt')).body, { text: prompt, full: true });
  assert.deepEqual((await b.get('/api/cards/c7/runs/1/report')).body, { text: report, full: true });
  assert.equal((await b.get('/api/cards/c7/runs/2/report')).status, 404);
  // a run recorded without the files answers with its preview
  writeStateFile(w.dataDir, w.projectDir, emptyState(w.projectDir, [task('c7', { runs: [runRecord({ prompt: 'short', result: 'also short' })] })]));
  assert.deepEqual((await b.get('/api/cards/c7/runs/1/prompt')).body, { text: 'short', full: false });
  // deleting the card removes the files with it
  writeStateFile(w.dataDir, w.projectDir, emptyState(w.projectDir, [task('c7', { runs: [run] })]));
  await core.removeCard(w.projectDir, 'c7');
  assert.deepEqual(fs.readdirSync(logs).filter((n) => n.startsWith('c7.')), []);
});

test('an offset past the end of the file starts over and says so, and an empty file is no trouble', async (t) => {
  const w = world(t);
  const file = w.install(COUNT_ID, { description: '[c7] count the files' });
  const size = fs.statSync(file).size;
  let r = runs.readRunActivity(file, size + 1000);
  assert.equal(r.reset, true);
  assert.equal(r.events.length, 3, 'read again from the start');
  assert.equal(runs.readRunActivity(file, 0).reset, false);
  assert.equal(runs.readRunActivity(file, size).reset, false, 'an offset at the end is a normal read');
  fs.writeFileSync(file, '');
  r = runs.readRunActivity(file, 500);
  assert.equal(r.reset, true);
  assert.deepEqual(r.events, []);
  assert.equal(r.next, 0);
  r = runs.readRunActivity(file, 0);
  assert.deepEqual([r.events, r.next, r.more, r.reset], [[], 0, false, false]);
  fs.writeFileSync(file, '{"type":"user","message":{"content":"half a li');
  r = runs.readRunActivity(file, 0);
  assert.deepEqual([r.events, r.next], [[], 0], 'a line still being written waits');
  const b = await board(t, w);
  writeStateFile(w.dataDir, w.projectDir, emptyState(w.projectDir, [task('c7', { runs: [runRecord({ transcript: file })] })]));
  assert.equal((await b.get(`${ACT}?offset=99999`)).body.reset, true);
});

test('lineEnd finds the last whole line of what was read, and nothing when nothing was read', () => {
  const buf = Buffer.from('ab\ncd\nef');
  assert.equal(runs.lineEnd(buf, buf.length), 5);
  assert.equal(runs.lineEnd(buf, 4), 2, 'only the bytes read count');
  assert.equal(runs.lineEnd(Buffer.from('abc\n'), 0), -1, 'a read of nothing has no line, whatever the buffer holds');
  assert.equal(runs.lineEnd(Buffer.from('abc'), 3), -1);
});

// ---------------------------------------------------------------- what a real run showed: the meta file lands after the start hook has returned

test('the start hook returns at once and a worker records the run when the meta file lands after the hook has gone, so the run is running while the agent works', async (t) => {
  const w = world(t);
  // as in a real run: no meta file and no transcript when SubagentStart fires; the meta file lands about 450 ms later, the transcript after it
  const meta = JSON.parse(fs.readFileSync(path.join(FIXTURES, `agent-${COUNT_ID}.meta.json`), 'utf8'));
  meta.description = '[c7] count the files';
  const t0 = Date.now();
  const r = await hook(w, 'SubagentStart', w.input('SubagentStart', COUNT_ID));
  const hookMs = Date.now() - t0;
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.ok(hookMs < 450, `the hook did not wait for the meta file (${hookMs} ms)`);
  assert.equal(w.card('c7').runs, undefined, 'nothing is known yet');
  await sleep(300);
  fs.writeFileSync(path.join(w.subDir, `agent-${COUNT_ID}.meta.json`), JSON.stringify(meta));
  await sleep(80);
  fs.copyFileSync(path.join(FIXTURES, `agent-${COUNT_ID}.jsonl`), path.join(w.subDir, `agent-${COUNT_ID}.jsonl`));
  await waitFor(() => w.card('c7').runs, { timeout: 5000 });
  const run = w.card('c7').runs[0];
  assert.equal(run.state, 'running', 'the run is open while the agent works');
  assert.equal(run.finishedAt, null);
  assert.match(run.prompt, /^List the files/, 'the worker also waited for the transcript to read the prompt');
  await sleep(400);
  await hook(w, 'SubagentStop', w.input('SubagentStop', COUNT_ID, { last_assistant_message: 'five' }));
  const done = w.card('c7').runs;
  assert.equal(done.length, 1, 'the stop closed the run the worker made, it did not make another');
  assert.equal(done[0].state, 'done');
  assert.ok(Date.parse(done[0].finishedAt) - Date.parse(done[0].startedAt) >= 350, 'started when the agent started, not when it stopped');
});

test('a start recorded late does not reopen a run that its own stop has closed; a later start of the same agent does', async (t) => {
  const w = world(t);
  w.install(COUNT_ID, { description: '[c7] count the files' });
  const eventAt = Date.now();
  await sleep(20);
  // the stop is first (the worker was slow): it makes the run and closes it
  await runs.stopRun(w.projectDir, w.input('SubagentStop', COUNT_ID, { last_assistant_message: 'five' }), { settleMs: 0 });
  assert.equal(await runs.startRun(w.projectDir, w.input('SubagentStart', COUNT_ID), { eventAt, retryMs: 0 }), false);
  assert.equal(w.card('c7').runs.length, 1);
  assert.equal(w.card('c7').runs[0].state, 'done');
  // the agent is sent a message and starts again, after it finished: that start reopens the run
  await sleep(20);
  assert.equal(await runs.startRun(w.projectDir, w.input('SubagentStart', COUNT_ID), { eventAt: Date.now(), retryMs: 0 }), true);
  assert.equal(w.card('c7').runs[0].state, 'running');
});

test('the start hook starts no worker for a project that is chat-only or has no task or idea', async (t) => {
  const w = world(t, [threadCard({ id: 'c3' })]);
  assert.equal(runs.canTrack(w.projectDir), false, 'only a thread');
  writeStateFile(w.dataDir, w.projectDir, emptyState(w.projectDir, [task('c7')]));
  assert.equal(runs.canTrack(w.projectDir), true);
  await core.saveConfig(w.projectDir, 'project', { mode: 'chat' });
  assert.equal(runs.canTrack(w.projectDir), false);
  assert.equal(runs.canTrack(path.join(w.base, 'nowhere')), false);
});
