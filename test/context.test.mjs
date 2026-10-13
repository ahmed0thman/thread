// Context modes (brief or full), agents, the model a thread inherits, and token use per turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  setupThreadEnv, waitFor, cleanAmbientEnv, writeStateFile, emptyState, threadCard, McpClient,
  PARENT_SESSION, THREAD_SESSION,
} from './helpers.mjs';
import * as core from '../server/core.mjs';
import { startBoardServer } from '../server/http.mjs';

cleanAmbientEnv();

/** setupThreadEnv, with the home folder moved into the temp dir so the user's real agents are never read. */
function setup(t) {
  const e = setupThreadEnv(t);
  e.setEnv('HOME', path.join(e.base, 'home'));
  e.setEnv('USERPROFILE', path.join(e.base, 'home'));
  return e;
}

const JSON_HDR = { 'content-type': 'application/json' };
const thread = (e, id = 'c1') => core.readState(e.projectDir).cards.find((c) => c.id === id)?.thread;
const idle = (e, id = 'c1') => waitFor(() => thread(e, id)?.runState === 'idle');
const start = (e, over = {}) => core.startThread(e.projectDir, { title: 'Side job', task: 'look around', sessionId: PARENT_SESSION, ...over });
const argsCard = (over = {}) => ({ id: 'c1', title: 't', thread: { parentSessionId: PARENT_SESSION, sessionId: null, mode: 'read', turns: [{ prompt: 'p' }], ...over } });
const valueOf = (argv, flag) => argv[argv.indexOf(flag) + 1];

/** Write agent files into <dir>/<name>.md. */
function writeAgents(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text);
}
const agentFile = (fields, body = 'You are an agent.') => `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}\n`;

/** A transcript for the parent session, registered in the state so the model can be found. */
async function parentTranscript(e, lines) {
  const file = path.join(e.base, 'parent.jsonl');
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  await core.touchSession(e.projectDir, PARENT_SESSION, { transcriptPath: file });
}
const assistantLine = (model, effort) => ({ type: 'assistant', message: { model, role: 'assistant', content: [] }, ...(effort ? { effort } : {}) });

// ------------------------------------------------------------ arguments and prompt

test('a brief thread starts a fresh session: -p with no --resume and no --fork-session', () => {
  const argv = core.buildClaudeArgs(argsCard({ context: 'brief' }));
  assert.equal(argv[0], '-p');
  assert.equal(argv.includes('--resume'), false);
  assert.equal(argv.includes('--fork-session'), false);
});

test('a full thread forks the main session on the first turn; both modes resume the thread session afterwards', () => {
  const first = core.buildClaudeArgs(argsCard({ context: 'full' }));
  assert.deepEqual(first.slice(0, 4), ['-p', '--resume', PARENT_SESSION, '--fork-session']);
  for (const context of ['brief', 'full']) {
    const later = core.buildClaudeArgs(argsCard({ context, sessionId: THREAD_SESSION }));
    assert.deepEqual(later.slice(0, 3), ['-p', '--resume', THREAD_SESSION]);
    assert.equal(later.includes('--fork-session'), false);
  }
});

test('a thread stored without a context is an old full copy', () => {
  assert.equal(core.threadContext({}), 'full');
  assert.ok(core.buildClaudeArgs(argsCard()).includes('--fork-session'));
  const p = core.buildPrompt({ id: 'c1', title: 't', thread: { parentSessionId: PARENT_SESSION, sessionId: null, mode: 'read', turns: [{ prompt: 'do it' }], brief: 'ignored' } });
  assert.match(p, /copied from the main session/);
  assert.ok(!p.includes('## Context') && !p.includes('ignored'));
});

test('an agent is passed on every turn, without --model or --effort', () => {
  const over = { agent: 'worker', model: 'claude-opus-5-5', effort: 'high' };
  for (const sessionId of [null, THREAD_SESSION]) {
    const argv = core.buildClaudeArgs(argsCard({ ...over, sessionId }));
    assert.equal(valueOf(argv, '--agent'), 'worker');
    assert.equal(argv.includes('--model'), false);
    assert.equal(argv.includes('--effort'), false);
  }
});

test('model and effort are passed on every turn when known, and nothing when not', () => {
  for (const sessionId of [null, THREAD_SESSION]) {
    const argv = core.buildClaudeArgs(argsCard({ model: 'claude-opus-5-5', effort: 'high', sessionId }));
    assert.equal(valueOf(argv, '--model'), 'claude-opus-5-5');
    assert.equal(valueOf(argv, '--effort'), 'high');
  }
  const none = core.buildClaudeArgs(argsCard({ model: null, effort: null }));
  assert.ok(!none.includes('--model') && !none.includes('--effort') && !none.includes('--agent'));
});

test('stored values that are not safe arguments are dropped when the arguments are built', () => {
  const argv = core.buildClaudeArgs(argsCard({ agent: '--bad', model: '--model', effort: 'ultra' }));
  assert.ok(!argv.includes('--agent') && !argv.includes('--bad') && !argv.includes('--model') && !argv.includes('--effort'));
});

test('the variadic flags stay last, so the prompt on stdin is safe', () => {
  const argv = core.buildClaudeArgs(argsCard({ agent: 'worker', dirs: [path.resolve('/tmp')] }));
  assert.ok(argv.indexOf('--agent') < argv.indexOf('--disallowedTools'));
  assert.ok(argv.indexOf('--disallowedTools') < argv.indexOf('--add-dir'));
});

test('brief prompt says the conversation was not shared, then the brief, the task, the mode line and the digest', () => {
  const card = (brief) => ({ id: 'c3', title: 'Dig', thread: { parentSessionId: PARENT_SESSION, sessionId: null, context: 'brief', brief, mode: 'read', turns: [{ prompt: 'find the cause' }] } });
  const p = core.buildPrompt(card('We use Postgres.\nSee src/db.ts.'));
  assert.match(p, /side thread started from a main session/);
  assert.match(p, /have not been given that session's conversation/);
  const order = ['## Context', 'We use Postgres.\nSee src/db.ts.', 'Task: find the cause', 'Do not modify any files', '## Happened', 'thread-map'].map((x) => p.indexOf(x));
  assert.ok(order.every((i) => i >= 0), `all parts present: ${order}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  for (const empty of ['', '   ', undefined]) assert.ok(!core.buildPrompt(card(empty)).includes('## Context'));
  assert.ok(core.buildPrompt(card('')).includes('Task: find the cause'));
});

test('full prompt keeps the copied-session text', () => {
  const p = core.buildPrompt({ id: 'c3', title: 'Dig', thread: { parentSessionId: PARENT_SESSION, sessionId: null, context: 'full', mode: 'write', turns: [{ prompt: 'x' }] } });
  assert.match(p, /side thread copied from the main session/);
  assert.match(p, /You may edit files/);
});

// ------------------------------------------------------------ starting

test('startThread defaults to brief, stores the brief, and the first turn is a fresh session with the brief on stdin', async (t) => {
  const e = setup(t);
  const c = await start(e, { brief: '  Use pnpm.  ' });
  assert.equal(c.thread.context, 'brief');
  assert.equal(c.thread.brief, 'Use pnpm.');
  assert.equal(c.thread.agent, null);
  assert.equal(c.thread.parentSessionId, PARENT_SESSION);
  await idle(e);
  const { argv, prompt } = e.readLog()[0];
  assert.deepEqual(argv.slice(0, 1), ['-p']);
  assert.equal(argv.includes('--resume'), false);
  assert.ok(prompt.includes('## Context\nUse pnpm.'));
});

test('startThread with context full forks the parent and keeps no brief', async (t) => {
  const e = setup(t);
  const c = await start(e, { context: 'full', brief: 'unused' });
  assert.equal(c.thread.context, 'full');
  assert.equal(c.thread.brief, '');
  await idle(e);
  const { argv, prompt } = e.readLog()[0];
  assert.deepEqual(argv.slice(0, 4), ['-p', '--resume', PARENT_SESSION, '--fork-session']);
  assert.ok(!prompt.includes('unused'));
});

test('a follow-up of a brief thread resumes the thread session and keeps its model and agent', async (t) => {
  const e = setup(t);
  const dir = path.join(e.projectDir, '.claude', 'agents');
  writeAgents(dir, { 'worker.md': agentFile({ name: 'worker', description: 'Does work' }) });
  await start(e, { agent: 'worker' });
  await idle(e);
  await core.continueThread(e.projectDir, 'c1', 'and more');
  await waitFor(() => thread(e).turns.length === 2 && thread(e).runState === 'idle');
  const runs = e.readLog();
  assert.deepEqual(runs[1].argv.slice(0, 3), ['-p', '--resume', THREAD_SESSION]);
  for (const r of runs) assert.equal(valueOf(r.argv, '--agent'), 'worker');
});

test('startThread rejects a bad context and a brief over 50,000 characters, creating no card', async (t) => {
  const e = setup(t);
  await assert.rejects(start(e, { context: 'half' }), /invalid context/);
  await assert.rejects(start(e, { brief: 'x'.repeat(50001) }), /too long.*50000.*"full"/);
  assert.equal(core.readState(e.projectDir).cards.length, 0);
  const ok = await start(e, { brief: 'x'.repeat(50000) });
  assert.equal(ok.thread.brief.length, 50000);
  const full = await start(e, { context: 'full', brief: 'x'.repeat(50001) });
  assert.equal(full.thread.context, 'full', 'a full thread ignores the brief, so its length does not matter');
});

test('startThread with an unknown agent names the available ones, or says none are defined', async (t) => {
  const e = setup(t);
  const userDir = path.join(e.base, 'home', '.claude', 'agents');
  await assert.rejects(start(e, { agent: 'ghost' }), /Unknown agent "ghost"\. No agents are defined/);
  writeAgents(path.join(e.projectDir, '.claude', 'agents'), { 'b.md': agentFile({ name: 'b' }), 'a.md': agentFile({ name: 'a' }) });
  writeAgents(userDir, { 'c.md': agentFile({ name: 'c' }) });
  await assert.rejects(start(e, { agent: 'ghost' }), /Unknown agent "ghost"\. Available: a, b, c\./);
  await assert.rejects(start(e, { agent: '--agent' }), /Unknown agent/);
  assert.equal(core.readState(e.projectDir).cards.length, 0);
  const c = await start(e, { agent: ' c ' });
  assert.equal(c.thread.agent, 'c');
  assert.equal(c.thread.model, null);
  assert.equal(c.thread.effort, null);
});

// ------------------------------------------------------------ agents

test('listAgents reads frontmatter from the project and user folders, project wins, top level only', (t) => {
  const e = setup(t);
  const projectAgents = path.join(e.projectDir, '.claude', 'agents');
  const userAgents = path.join(e.base, 'user-agents');
  writeAgents(projectAgents, {
    'worker.md': agentFile({ name: 'worker', description: '"Does the   work"', model: 'sonnet', effort: 'xhigh' }),
    'no-name.md': agentFile({ description: 'Name comes from the file' }),
    'bad.md': 'no frontmatter here\n',
    'weird.md': agentFile({ name: '-rf', description: 'unsafe name' }),
    'notes.txt': 'not an agent',
  });
  fs.mkdirSync(path.join(projectAgents, 'nested'));
  fs.writeFileSync(path.join(projectAgents, 'nested', 'deep.md'), agentFile({ name: 'deep' }));
  writeAgents(userAgents, {
    'worker.md': agentFile({ name: 'worker', description: 'The user one' }),
    'critic.md': agentFile({ name: 'critic', description: 'Hunts bugs', model: 'opus', effort: 'ultra' }),
  });
  assert.deepEqual(core.listAgents(e.projectDir, userAgents), [
    { name: 'critic', description: 'Hunts bugs', model: 'opus', effort: 'ultra', scope: 'user' },
    { name: 'no-name', description: 'Name comes from the file', model: null, effort: null, scope: 'project' },
    { name: 'worker', description: 'Does the work', model: 'sonnet', effort: 'xhigh', scope: 'project' },
  ]);
});

test('listAgents returns an empty list when neither folder exists', (t) => {
  const e = setup(t);
  assert.deepEqual(core.listAgents(e.projectDir, path.join(e.base, 'nope')), []);
});

// ------------------------------------------------------------ model and effort of the main session

test('a thread inherits the model and effort of the last real assistant line of the parent transcript', async (t) => {
  const e = setup(t);
  await parentTranscript(e, [
    assistantLine('claude-sonnet-5-5', 'low'),
    assistantLine('claude-opus-5-5', 'high'),
    '{"type":"assistant","message":{"model":"<synthetic>","content":[]}}',
    { type: 'user', message: { content: 'hello' } },
  ]);
  assert.deepEqual(await core.sessionModel(e.projectDir, PARENT_SESSION), { model: 'claude-opus-5-5', effort: 'high' });
  const c = await start(e);
  assert.equal(c.thread.model, 'claude-opus-5-5');
  assert.equal(c.thread.effort, 'high');
  await idle(e);
  const { argv } = e.readLog()[0];
  assert.equal(valueOf(argv, '--model'), 'claude-opus-5-5');
  assert.equal(valueOf(argv, '--effort'), 'high');
});

test('invalid model or effort values are dropped, and unknown sources give nulls', async (t) => {
  const e = setup(t);
  const unknown = { model: null, effort: null };
  assert.deepEqual(await core.sessionModel(e.projectDir, PARENT_SESSION), unknown, 'session not recorded');
  await parentTranscript(e, [assistantLine('--evil model', 'ultra')]);
  assert.deepEqual(await core.sessionModel(e.projectDir, PARENT_SESSION), unknown);
  await parentTranscript(e, [assistantLine('claude-opus-5-5[1m]', 'max'), 'not json', '{"type":"assistant"}']);
  assert.deepEqual(await core.sessionModel(e.projectDir, PARENT_SESSION), { model: 'claude-opus-5-5[1m]', effort: 'max' });
  await parentTranscript(e, [{ type: 'user', message: { content: 'only a user line' } }]);
  assert.deepEqual(await core.sessionModel(e.projectDir, PARENT_SESSION), unknown);
  const c = await start(e);
  assert.equal(c.thread.model, null);
  await idle(e);
  const { argv } = e.readLog()[0];
  assert.ok(!argv.includes('--model') && !argv.includes('--effort'));
});

test('a long transcript is read from its end only', async (t) => {
  const e = setup(t);
  const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(1000) } });
  await parentTranscript(e, [assistantLine('claude-old-1', 'low'), ...Array(400).fill(filler), assistantLine('claude-new-1', 'medium')]);
  assert.deepEqual(await core.sessionModel(e.projectDir, PARENT_SESSION), { model: 'claude-new-1', effort: 'medium' });
  await parentTranscript(e, [assistantLine('claude-old-1', 'low'), ...Array(400).fill(filler)]);
  assert.deepEqual(await core.sessionModel(e.projectDir, PARENT_SESSION), { model: null, effort: null });
});

// ------------------------------------------------------------ token use

test('a turn records the usage from its result event; a result without usage leaves it off', async (t) => {
  const e = setup(t);
  await start(e);
  await idle(e);
  assert.deepEqual(thread(e).turns[0].usage, { input: 12, cacheRead: 300, cacheWrite: 40, output: 7 });
  e.setEnv('FAKE_CLAUDE_MODE', 'no-usage');
  await core.continueThread(e.projectDir, 'c1', 'again');
  await waitFor(() => thread(e).turns.length === 2 && thread(e).runState === 'idle');
  assert.equal('usage' in thread(e).turns[1], false);
});

// ------------------------------------------------------------ board API

async function boot(t) {
  const e = setup(t);
  const b = await startBoardServer(e.projectDir, { port: 0 });
  t.after(() => new Promise((r) => { b.server.closeAllConnections?.(); b.server.close(() => r()); }));
  return { ...e, base: `http://127.0.0.1:${b.port}`, tmp: e.base };
}

test('GET agents lists agents for the home route and a project route', async (t) => {
  const b = await boot(t);
  writeAgents(path.join(b.projectDir, '.claude', 'agents'), { 'worker.md': agentFile({ name: 'worker', description: 'Does work', model: 'sonnet' }) });
  writeAgents(path.join(b.tmp, 'home', '.claude', 'agents'), { 'critic.md': agentFile({ name: 'critic', effort: 'high' }) });
  const expected = [
    { name: 'critic', description: '', model: null, effort: 'high', scope: 'user' },
    { name: 'worker', description: 'Does work', model: 'sonnet', effort: null, scope: 'project' },
  ];
  const home = await fetch(b.base + '/api/agents');
  assert.equal(home.status, 200);
  assert.deepEqual(await home.json(), { agents: expected });
  const key = core.projectKey(b.projectDir);
  assert.deepEqual(await (await fetch(`${b.base}/api/p/${key}/agents`)).json(), { agents: expected });
  assert.equal((await fetch(b.base + '/api/agents', { method: 'POST', headers: JSON_HDR, body: '{}' })).status, 404);
});

test('POST cards/:id/start takes context and agent; a brief thread uses the note as its brief', async (t) => {
  const b = await boot(t);
  writeAgents(path.join(b.projectDir, '.claude', 'agents'), { 'worker.md': agentFile({ name: 'worker' }) });
  await core.addCard(b.projectDir, { title: 'Fix login', note: 'Fails on Safari.', source: 'user' });
  await core.addCard(b.projectDir, { title: 'Try cache', source: 'user' });
  const post = (id, body) => fetch(`${b.base}/api/cards/${id}/start`, { method: 'POST', headers: JSON_HDR, body: JSON.stringify({ sessionId: PARENT_SESSION, ...body }) });

  const bad = await post('c1', { agent: 'ghost' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /Unknown agent "ghost"\. Available: worker\./);
  assert.equal((await post('c1', { context: 'half' })).status, 400);
  assert.equal(core.readState(b.projectDir).cards[0].kind, 'task', 'a refused start leaves the card alone');

  const res = await post('c1', { agent: 'worker' });
  assert.equal(res.status, 200);
  const card = await res.json();
  assert.equal(card.thread.context, 'brief');
  assert.equal(card.thread.brief, 'Fails on Safari.');
  assert.equal(card.thread.agent, 'worker');
  assert.equal(card.thread.turns[0].prompt, 'Fix login', 'the note travels once, as the brief');

  const full = await (await post('c2', { context: 'full' })).json();
  assert.equal(full.thread.context, 'full');
  assert.equal(full.thread.brief, '');
  await waitFor(() => core.readState(b.projectDir).cards.every((c) => c.thread.runState === 'idle'));
  const [first, second] = ['Fix login', 'Try cache'].map((x) => b.readLog().find((r) => r.prompt.includes(x)));
  assert.equal(first.argv.includes('--resume'), false);
  assert.equal(valueOf(first.argv, '--agent'), 'worker');
  assert.ok(second.argv.includes('--fork-session'));
});

test('GET state carries the context, agent, model and turn usage through', async (t) => {
  const b = await boot(t);
  const ts = new Date().toISOString();
  const usage = { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 };
  writeStateFile(b.dataDir, b.projectDir, emptyState(b.projectDir, [threadCard({}, {
    context: 'brief', brief: 'b', agent: 'worker', model: null, effort: null,
    turns: [{ prompt: 'p', startedAt: ts, finishedAt: ts, ok: true, result: 'done\n## Happened\nx', error: null, usage }],
  })]));
  const th = (await (await fetch(b.base + '/api/state')).json()).cards[0].thread;
  assert.equal(th.context, 'brief');
  assert.equal(th.brief, 'b');
  assert.equal(th.agent, 'worker');
  assert.equal(th.model, null);
  assert.deepEqual(th.turns[0].usage, usage);
});

// ------------------------------------------------------------ MCP

function mcp(t, e) {
  const c = new McpClient(e);
  t.after(() => c.kill());
  return c;
}

test('thread_start defaults to brief context and says so, with the model it runs as', async (t) => {
  const e = setup(t);
  await parentTranscript(e, [assistantLine('claude-opus-5-5', 'high')]);
  const c = mcp(t, e);
  await c.init();
  const r = await c.call('thread_start', { title: 'Dig', task: 'find it', brief: 'Context here.', session_id: PARENT_SESSION });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /\(mode read, brief context, model claude-opus-5-5, effort high\)/);
  const th = core.readState(e.projectDir).cards[0].thread;
  assert.equal(th.context, 'brief');
  assert.equal(th.brief, 'Context here.');
});

test('thread_start with an agent or context full reports them, and refuses an unknown agent', async (t) => {
  const e = setup(t);
  writeAgents(path.join(e.projectDir, '.claude', 'agents'), { 'worker.md': agentFile({ name: 'worker' }) });
  const c = mcp(t, e);
  await c.init();
  const withAgent = await c.call('thread_start', { title: 'A', task: 't', agent: 'worker', session_id: PARENT_SESSION });
  assert.match(withAgent.text, /\(mode read, brief context, agent worker\)/);
  const full = await c.call('thread_start', { title: 'F', task: 't', context: 'full', session_id: PARENT_SESSION });
  assert.match(full.text, /\(mode read, full context, default model\)/);
  const bad = await c.call('thread_start', { title: 'B', task: 't', agent: 'ghost', session_id: PARENT_SESSION });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Unknown agent "ghost"\. Available: worker\./);
  const badCtx = await c.call('thread_start', { title: 'B', task: 't', context: 'half', session_id: PARENT_SESSION });
  assert.equal(badCtx.isError, true);
  assert.match(badCtx.text, /context/);
});

test('thread_status shows context, agent or model, and total tokens over the turns', async (t) => {
  const e = setup(t);
  const ts = new Date().toISOString();
  const turn = (usage) => ({ prompt: 'p', startedAt: ts, finishedAt: ts, ok: true, result: 'r', error: null, ...(usage ? { usage } : {}) });
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [
    threadCard({ id: 'c1' }, { context: 'brief', agent: 'worker', turns: [turn({ input: 100, cacheRead: 2000, cacheWrite: 400, output: 300 }), turn({ input: 5, cacheRead: 0, cacheWrite: 0, output: 1200 }), turn()] }),
    threadCard({ id: 'c2' }, { context: 'brief', model: 'claude-opus-5-5', effort: 'high' }),
    threadCard({ id: 'c3' }, {}),
  ]));
  const c = mcp(t, e);
  await c.init();
  const one = (await c.call('thread_status', { id: 'c1' })).text;
  assert.match(one, /brief context, agent worker, 3 turn\(s\), tokens 2\.5k in \/ 1\.5k out,/);
  const all = (await c.call('thread_status', {})).text.split('\n');
  assert.match(all[1], /brief context, model claude-opus-5-5, effort high, 1 turn\(s\), reported/);
  assert.ok(!all[1].includes('tokens'), 'no usage recorded, none shown');
  assert.match(all[2], /full context, default model/);
});

test('thread_start documents the brief, context and agent parameters', async (t) => {
  const e = setup(t);
  const c = mcp(t, e);
  await c.init();
  const tool = (await c.request('tools/list', {})).result.tools.find((x) => x.name === 'thread_start');
  const props = tool.inputSchema.properties;
  assert.deepEqual(props.context.enum, ['brief', 'full']);
  assert.equal(props.brief.type, 'string');
  assert.equal(props.agent.type, 'string');
  assert.ok(!/full copy of this conversation/.test(tool.description));
  assert.equal(tool.inputSchema.required.includes('brief'), false);
});

// ------------------------------------------------------------ a chosen model and effort

test('a named model replaces the session model and does not inherit its effort; a named effort is kept', async (t) => {
  const e = setup(t);
  await parentTranscript(e, [assistantLine('claude-opus-5-5', 'max')]);
  const a = await start(e, { model: 'haiku' });
  assert.deepEqual([a.thread.model, a.thread.effort, a.thread.agent], ['haiku', null, null]);
  const b = await start(e, { model: ' sonnet ', effort: 'low' });
  assert.deepEqual([b.thread.model, b.thread.effort], ['sonnet', 'low']);
  const c = await start(e, { effort: 'medium' });
  assert.deepEqual([c.thread.model, c.thread.effort], ['claude-opus-5-5', 'medium'], 'the session model with another effort');
  await waitFor(() => core.readState(e.projectDir).cards.every((x) => x.thread.runState === 'idle'));
  const first = e.readLog().find((r) => valueOf(r.argv, '--model') === 'haiku');
  assert.ok(first, 'the named model reaches the CLI');
  assert.equal(first.argv.includes('--effort'), false);
});

test('a bad model or effort, or an agent together with a model, is refused and creates no card', async (t) => {
  const e = setup(t);
  writeAgents(path.join(e.projectDir, '.claude', 'agents'), { 'worker.md': agentFile({ name: 'worker' }) });
  await assert.rejects(start(e, { model: '--dangerously-skip-permissions' }), /invalid model/);
  await assert.rejects(start(e, { effort: 'ultra' }), /invalid effort "ultra" \(use low, medium, high, xhigh, max\)/);
  await assert.rejects(start(e, { agent: 'worker', model: 'haiku' }), /not both/);
  await assert.rejects(start(e, { agent: 'worker', effort: 'low' }), /not both/);
  assert.equal(core.readState(e.projectDir).cards.length, 0);
});

test('thread_start takes model and effort, reports them, and tells Claude how to choose', async (t) => {
  const e = setup(t);
  const c = mcp(t, e);
  await c.init();
  const r = await c.call('thread_start', { title: 'Lookup', task: 'list the routes', session_id: PARENT_SESSION, model: 'haiku', effort: 'low' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /brief context, model haiku, effort low/);
  const tool = (await c.request('tools/list', {})).result.tools.find((x) => x.name === 'thread_start');
  assert.deepEqual(tool.inputSchema.properties.effort.enum, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.ok(tool.inputSchema.properties.model);
  assert.match(tool.description, /by how hard the task is/);
});
