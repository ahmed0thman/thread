// A card's worker: a delegation lane or a sub-agent (the board's Worker picker). A card holds one of them; the lane field is the one older
// versions know, the agent field is new and safe for them to ignore. The delegate skills and the relays are fakes (test/fake-delegate) and
// the claude CLI is test/fake-claude.mjs; the sub-agents are files in a temp project and a temp home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupThreadEnv, cleanAmbientEnv, waitFor, McpClient, PARENT_SESSION, FAKE_DELEGATE, writeStateFile, emptyState, threadCard } from './helpers.mjs';
import * as core from '../server/core.mjs';
import { notifyRev } from '../server/notify.mjs';
import { clearLanesCache, listLanesWithRelay } from '../server/lanes.mjs';
import { startBoardServer, closeBoardServer } from '../server/http.mjs';

cleanAmbientEnv();

const card = (dir, id = 'c1') => core.readState(dir).cards.find((c) => c.id === id);
const untilIdle = (e, id) => waitFor(() => card(e.projectDir, id)?.thread?.runState === 'idle', { timeout: 8000 });
const agentFile = (name, extra = {}) => `---\n${Object.entries({ name, description: `${name} agent`, ...extra }).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\nYou are ${name}.\n`;
const valueOf = (argv, flag) => argv[argv.indexOf(flag) + 1];

/** A temp project with two sub-agents (one of the project, one of the user), the fake delegate skills and the fake claude. */
function setup(t, delegateMode = 'ok', extra = {}) {
  cleanAmbientEnv();
  clearLanesCache();
  t.after(clearLanesCache);
  const e = setupThreadEnv(t, { THREAD_DELEGATE_DIR: FAKE_DELEGATE, FAKE_DELEGATE_MODE: delegateMode, FAKE_RELAY_MODE: 'ok', ...extra });
  e.setEnv('HOME', path.join(e.base, 'home'));
  e.setEnv('USERPROFILE', path.join(e.base, 'home'));
  fs.mkdirSync(path.join(e.projectDir, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(e.base, 'home', '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(e.projectDir, '.claude', 'agents', 'reviewer.md'), agentFile('reviewer', { model: 'sonnet' }));
  fs.writeFileSync(path.join(e.base, 'home', '.claude', 'agents', 'helper.md'), agentFile('helper'));
  e.relayLog = path.join(e.base, 'relay.log');
  e.setEnv('FAKE_RELAY_LOG', e.relayLog);
  e.relays = () => (fs.existsSync(e.relayLog) ? fs.readFileSync(e.relayLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return e;
}

async function boot(t, e) {
  const token = 'cd'.repeat(16);
  const b = await startBoardServer(e.projectDir, { port: 0, token });
  t.after(() => closeBoardServer(b.server));
  const base = `http://127.0.0.1:${b.port}`;
  const key = core.projectKey(e.projectDir);
  const call = async (method, p, body) => {
    const r = await fetch(`${base}/api/p/${key}/${p}`, { method, headers: { 'X-Thread-Token': token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { patch: (id, body) => call('PATCH', `cards/${id}`, body), post: (p, body) => call('POST', p, body), get: (p) => call('GET', p) };
}

function mcp(t, e) {
  const c = new McpClient(e);
  t.after(() => c.kill());
  return c;
}

// ------------------------------------------------------------ the store

test('an agent is stored by name on a task or idea, trimmed, kept by updates that do not mention it, and removed by an empty value', async (t) => {
  const e = setup(t);
  const task = await core.addCard(e.projectDir, { title: 'T', agent: ' reviewer ' });
  assert.equal(task.agent, 'reviewer');
  const idea = await core.addCard(e.projectDir, { title: 'I', kind: 'idea', agent: 'helper' });
  assert.equal(idea.agent, 'helper', 'an agent of the user\'s own folder too');
  assert.equal((await core.addCard(e.projectDir, { title: 'none', agent: '' })).agent, undefined);
  assert.equal((await core.updateCard(e.projectDir, task.id, { note: 'n' })).agent, 'reviewer', 'an update that does not mention the agent keeps it');
  assert.equal((await core.updateCard(e.projectDir, task.id, { agent: 'helper' })).agent, 'helper');
  assert.equal('agent' in (await core.updateCard(e.projectDir, task.id, { agent: '' })), false);
  assert.equal('agent' in (await core.updateCard(e.projectDir, task.id, { agent: null })), false, 'taking off an agent the card does not have is no error');
  const edited = card(e.projectDir, task.id).history.filter((h) => h.type === 'edited').map((h) => h.fields);
  assert.deepEqual(edited.flat().filter((f) => f === 'agent').length, 2, 'the history says the agent was edited');
});

test('an unknown agent is refused with the list of the ones there are; a milestone and a thread cannot have one', async (t) => {
  const e = setup(t);
  const c = await core.addCard(e.projectDir, { title: 'T' });
  const ms = await core.addCard(e.projectDir, { title: 'M', kind: 'milestone' });
  await assert.rejects(core.addCard(e.projectDir, { title: 'x', agent: 'ghost' }), /Unknown agent "ghost"\. Available: helper, reviewer\./);
  await assert.rejects(core.updateCard(e.projectDir, c.id, { agent: '--agent' }), /Unknown agent/);
  await assert.rejects(core.updateCard(e.projectDir, c.id, { agent: 5 }), /agent must be a sub-agent name/);
  await assert.rejects(core.addCard(e.projectDir, { title: 'x', kind: 'milestone', agent: 'reviewer' }), /a milestone cannot have an agent/);
  await assert.rejects(core.updateCard(e.projectDir, ms.id, { agent: 'reviewer' }), /a milestone cannot have an agent/);
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [...core.readState(e.projectDir).cards, threadCard({ id: 'c9', title: 'A thread', status: 'review' })]));
  await assert.rejects(core.updateCard(e.projectDir, 'c9', { agent: 'reviewer' }), /a thread's agent is chosen when it starts/);
  assert.equal(core.readState(e.projectDir).cards.length, 3, 'a refused add leaves no card');
  assert.equal('agent' in card(e.projectDir, c.id), false);
  assert.equal('agent' in card(e.projectDir, ms.id), false);
  assert.equal('agent' in card(e.projectDir, 'c9'), false);
});

test('a card has one worker: setting an agent takes the lane off, setting a lane takes the agent off, and both at once are refused', async (t) => {
  const e = setup(t);
  const c = await core.addCard(e.projectDir, { title: 'T', lane: 'code-codex' });
  let r = await core.updateCard(e.projectDir, c.id, { agent: 'reviewer' });
  assert.deepEqual([r.agent, 'lane' in r], ['reviewer', false], 'the lane went with it');
  r = await core.updateCard(e.projectDir, c.id, { lane: 'ui-open' });
  assert.deepEqual([r.lane, 'agent' in r], ['ui-open', false], 'and the other way round');
  r = await core.updateCard(e.projectDir, c.id, { agent: 'helper', lane: '' });
  assert.deepEqual([r.agent, 'lane' in r], ['helper', false], 'an agent with the lane taken off in the same call');
  r = await core.updateCard(e.projectDir, c.id, { lane: 'code-codex', agent: null });
  assert.deepEqual([r.lane, 'agent' in r], ['code-codex', false]);
  await assert.rejects(core.updateCard(e.projectDir, c.id, { lane: 'ui-open', agent: 'reviewer' }), /a card has one worker/);
  await assert.rejects(core.addCard(e.projectDir, { title: 'x', lane: 'ui-open', agent: 'reviewer' }), /a card has one worker/);
  assert.equal(card(e.projectDir, c.id).lane, 'code-codex', 'a refused call changed nothing');
  assert.equal(core.readState(e.projectDir).cards.length, 1);
});

test('a card file that holds both a lane and an agent (as an older version leaves one) is shown and started with its lane', async (t) => {
  const e = setup(t);
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [
    { id: 'c1', kind: 'task', title: 'Both', note: 'n', status: 'new', source: 'user', seenByClaude: true, lane: 'code-codex', agent: 'reviewer', createdAt: 'x', updatedAt: 'x' },
  ]));
  const b = await boot(t, e);
  const view = (await b.get('state')).body.cards[0];
  assert.deepEqual([view.lane, view.agent], ['code-codex', 'reviewer'], 'the page gets both, and shows the lane');
  const r = await b.patch('c1', { title: 'Renamed' });
  assert.equal(r.status, 200);
  assert.deepEqual([card(e.projectDir).lane, card(e.projectDir).agent], ['code-codex', 'reviewer'], 'a save that sends neither leaves both');
  assert.equal((await b.post('cards/c1/start', { sessionId: PARENT_SESSION, mode: 'read', context: 'brief', expectLane: 'code-codex', expectAgent: null })).status, 200, 'it starts on the lane, and the page was shown the lane');
  await untilIdle(e, 'c1');
  assert.equal(e.relays().length, 1);
  assert.equal(e.readLog().length, 0, 'claude did not run');
});

// ------------------------------------------------------------ the board's PATCH

test('the board sets a card\'s agent with the card update, and takes it off again', async (t) => {
  const e = setup(t);
  const b = await boot(t, e);
  await core.addCard(e.projectDir, { title: 'Fix it', note: 'The note.' });
  let r = await b.patch('c1', { agent: 'reviewer' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.agent, 'reviewer');
  assert.equal(card(e.projectDir).agent, 'reviewer');
  r = await b.patch('c1', { agent: 'helper', title: 'Fix it now' });
  assert.deepEqual([r.status, r.body.agent, r.body.title], [200, 'helper', 'Fix it now'], 'an agent changes with other fields in one save');
  r = await b.patch('c1', { lane: 'code-codex' });
  assert.deepEqual([r.status, r.body.lane, 'agent' in r.body], [200, 'code-codex', false], 'a lane replaces it');
  r = await b.patch('c1', { agent: 'reviewer' });
  assert.deepEqual([r.status, r.body.agent, 'lane' in r.body], [200, 'reviewer', false], 'and an agent replaces the lane');
  r = await b.patch('c1', { agent: null });
  assert.equal(r.status, 200);
  assert.equal('agent' in r.body, false);
  await b.patch('c1', { agent: 'helper' });
  r = await b.patch('c1', { agent: '' });
  assert.equal(r.status, 200);
  assert.equal('agent' in card(e.projectDir), false, 'an empty name takes it off too');
  r = await b.patch('c1', { lane: null, agent: null });
  assert.equal(r.status, 200, 'Claude (default) on a card that holds neither is no error');
});

test('an agent that is unknown or not a name, on a milestone or a thread, is refused with its reason and the rest of the save is not written', async (t) => {
  const e = setup(t);
  const b = await boot(t, e);
  await core.addCard(e.projectDir, { title: 'Keep me' });
  await core.addCard(e.projectDir, { title: 'A milestone', kind: 'milestone' });
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [...core.readState(e.projectDir).cards, threadCard({ id: 'c3', title: 'A thread', status: 'review' })]));
  const before = JSON.stringify(card(e.projectDir));
  let r = await b.patch('c1', { agent: 'ghost', title: 'Changed' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /^Unknown agent "ghost"\. Available: helper, reviewer\.$/);
  for (const agent of [7, ['reviewer'], { name: 'reviewer' }, true]) {
    r = await b.patch('c1', { agent });
    assert.equal(r.status, 400, JSON.stringify(agent));
    assert.match(r.body.error, /^agent must be a sub-agent name/);
  }
  r = await b.patch('c1', { lane: 'code-codex', agent: 'reviewer' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /a card has one worker/);
  assert.equal(JSON.stringify(card(e.projectDir)), before, 'nothing was written');
  r = await b.patch('c2', { agent: 'reviewer' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /a milestone cannot have an agent/);
  r = await b.patch('c3', { agent: 'reviewer' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /a thread's agent is chosen when it starts/);
  const made = await b.post('cards', { title: 'New', agent: 'reviewer' });
  assert.equal(made.status, 400, 'a new card is not given one');
  assert.match(made.body.error, /unknown key agent/);
  assert.equal(core.readState(e.projectDir).cards.length, 3);
});

test('an agent that is not a name (a card file written by hand) is left out of what the page gets, is not removed by a save, and the card starts without it', async (t) => {
  const e = setup(t);
  const b = await boot(t, e);
  for (const bad of [5, ['reviewer'], { name: 'reviewer' }, true]) {
    writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [
      { id: 'c1', kind: 'task', title: 'Pulled', note: 'Do it.', status: 'new', source: 'user', seenByClaude: true, agent: bad, createdAt: 'x', updatedAt: 'x' },
    ]));
    const view = (await b.get('state')).body.cards.find((c) => c.id === 'c1');
    assert.equal('agent' in view, false, `${JSON.stringify(bad)} is not shown to the page`);
    const r = await b.patch('c1', { title: 'Pulled, renamed' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(card(e.projectDir).agent, bad, 'a save that sends no agent leaves what the file holds');
  }
  const started = await b.post('cards/c1/start', { sessionId: PARENT_SESSION, mode: 'read', context: 'brief', expectLane: null, expectAgent: null });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.thread.agent, null, 'an agent that is not a name is no agent');
  await untilIdle(e, 'c1');
  assert.equal(e.readLog()[0].argv.includes('--agent'), false);
});

// ------------------------------------------------------------ Start

test('a card with an agent starts as a thread run as that agent, and the card no longer holds the agent', async (t) => {
  const e = setup(t);
  const b = await boot(t, e);
  await core.addCard(e.projectDir, { title: 'Review it', note: 'Look at the diff.', agent: 'reviewer' });
  await core.addCard(e.projectDir, { title: 'Plain', note: 'No worker.' });
  const started = await b.post('cards/c1/start', { sessionId: PARENT_SESSION, mode: 'read', context: 'brief', expectLane: null, expectAgent: 'reviewer' });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.thread.agent, 'reviewer');
  assert.equal('agent' in started.body, false, 'the thread holds it now');
  await untilIdle(e, 'c1');
  assert.equal(valueOf(e.readLog()[0].argv, '--agent'), 'reviewer');
  assert.equal(e.relays().length, 0, 'no relay ran');
  // none picked: a thread on the session's model, no --agent
  const plain = await b.post('cards/c2/start', { sessionId: PARENT_SESSION, mode: 'read', context: 'brief', expectLane: null, expectAgent: null });
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  assert.equal(plain.body.thread.agent, null);
  await untilIdle(e, 'c2');
  assert.equal(e.readLog()[1].argv.includes('--agent'), false);
});

test('Start refuses with a 409 when the card\'s worker is not the one the page showed, and nothing starts; an older page that sends no expectAgent is not checked', async (t) => {
  const e = setup(t);
  const b = await boot(t, e);
  await core.addCard(e.projectDir, { title: 'Agented', note: 'Look at it.', agent: 'reviewer' });
  await core.addCard(e.projectDir, { title: 'Laned', note: 'Look at it too.', lane: 'code-codex' });
  await core.addCard(e.projectDir, { title: 'Bare', note: 'And this.' });
  const go = (id, shown = {}) => b.post(`cards/${id}/start`, { sessionId: PARENT_SESSION, mode: 'read', context: 'brief', ...shown });
  // the page showed helper; the card has reviewer (Claude changed it, or a pull did)
  let r = await go('c1', { expectLane: null, expectAgent: 'helper' });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /^the card's worker \(lane or agent\) changed since you looked at it/);
  assert.equal((await go('c1', { expectLane: null, expectAgent: null })).status, 409, 'the page showed Claude (default); the card has an agent');
  assert.equal((await go('c1', { expectLane: 'code-codex', expectAgent: null })).status, 409, 'the page showed a lane');
  assert.equal((await go('c2', { expectLane: null, expectAgent: 'reviewer' })).status, 409, 'the page showed an agent; the card has a lane');
  assert.equal((await go('c3', { expectLane: null, expectAgent: 'reviewer' })).status, 409, 'the page showed an agent; the card has none');
  assert.equal((await go('c1', { expectAgent: 'helper' })).status, 409, 'an expectAgent alone is checked too');
  for (const id of ['c1', 'c2', 'c3']) assert.equal(card(e.projectDir, id).kind, 'task', 'a refused start leaves the card as it was');
  assert.equal(card(e.projectDir, 'c1').agent, 'reviewer');
  assert.equal(e.relays().length + e.readLog().length, 0, 'nothing ran');
  r = await go('c1', { expectAgent: 5 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /^expectAgent must be a sub-agent name or null/);
  // the worker that was shown starts
  r = await go('c1', { expectLane: null, expectAgent: 'reviewer' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.thread.agent, 'reviewer');
  await untilIdle(e, 'c1');
  // an older page sends no expectAgent (and 0.16.0 pages only expectLane): the card's own worker runs
  r = await go('c3', { expectLane: null });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await untilIdle(e, 'c3');
  await core.addCard(e.projectDir, { title: 'Older page', note: 'n', agent: 'helper' });
  r = await go('c4');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.thread.agent, 'helper');
  await untilIdle(e, 'c4');
});

test('an older page that picks an agent in its own Start step still works: the agent in the request stands in when the card has none, and another than the card\'s is refused', async (t) => {
  const e = setup(t);
  const b = await boot(t, e);
  await core.addCard(e.projectDir, { title: 'Plain', note: 'n' });
  await core.addCard(e.projectDir, { title: 'Has one', note: 'n', agent: 'reviewer' });
  let r = await b.post('cards/c1/start', { sessionId: PARENT_SESSION, mode: 'read', context: 'brief', agent: 'helper', expectLane: null });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.thread.agent, 'helper');
  // the request names another agent than the card has: refused as stale, nothing starts
  r = await b.post('cards/c2/start', { sessionId: PARENT_SESSION, mode: 'read', context: 'brief', agent: 'helper' });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /the card's agent is not the one in the request/);
  assert.equal(card(e.projectDir, 'c2').kind, 'task');
  // the card's own agent named in the request (the new page does, so that a 0.16.0 server runs it too) is fine
  r = await b.post('cards/c2/start', { sessionId: PARENT_SESSION, mode: 'read', context: 'brief', agent: 'reviewer', expectLane: null, expectAgent: 'reviewer' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.thread.agent, 'reviewer');
  await untilIdle(e, 'c1');
  await untilIdle(e, 'c2');
});

test('an agent that was deleted since it was put on the card makes Start fail with its reason, and the card keeps it', async (t) => {
  const e = setup(t);
  const b = await boot(t, e);
  await core.addCard(e.projectDir, { title: 'Review', note: 'n', agent: 'reviewer' });
  fs.rmSync(path.join(e.projectDir, '.claude', 'agents', 'reviewer.md'));
  const r = await b.post('cards/c1/start', { sessionId: PARENT_SESSION, mode: 'read', context: 'brief', expectLane: null, expectAgent: 'reviewer' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /^Unknown agent "reviewer"\. Available: helper\.$/);
  assert.equal(card(e.projectDir).kind, 'task');
  assert.equal(card(e.projectDir).agent, 'reviewer');
  assert.equal((await b.patch('c1', { agent: null })).status, 200, 'and it can be taken off');
});

// ------------------------------------------------------------ the lists the picker is made of

test('the lanes route says which project lanes replace a global lane of the same name, and only those', async (t) => {
  const e = setup(t, 'ok', { FAKE_DELEGATE_SHADOWED: 'review-ro,not-a-lane' });
  const b = await boot(t, e);
  const r = await b.get('lanes');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.lanes.map((l) => [l.name, l.source, l.overridesGlobal === true]), [
    ['code-codex', 'global', false], ['ui-open', 'global', false], ['review-ro', 'project', true], ['agy-fast', 'project', false], ['claude-edit', 'global', false],
  ]);
  assert.equal('overridesGlobal' in r.body.lanes[0], false, 'the key is only there when it is true');
  assert.equal(r.body.lanes.every((l) => typeof l.relay === 'boolean' && typeof l.approved === 'boolean'), true);
});

test('the project\'s lanes and the global ones are asked for together, and both are cached', async (t) => {
  const e = setup(t, 'ok', { FAKE_DELEGATE_SHADOWED: 'review-ro' });
  const log = path.join(e.base, 'delegate.log');
  e.setEnv('FAKE_DELEGATE_LOG', log);
  const runs = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  const r = await listLanesWithRelay(e.projectDir);
  assert.equal(r.lanes.find((l) => l.name === 'review-ro').overridesGlobal, true);
  assert.deepEqual(runs().sort(), [`load --cwd ${path.parse(e.projectDir).root}`, `load --cwd ${e.projectDir}`].sort());
  await listLanesWithRelay(e.projectDir);
  assert.equal(runs().length, 2, 'both are cached');
});

test('the agents route lists the sub-agents of the project and of the user with where each is defined, which is what the picker\'s first tab is made of', async (t) => {
  const e = setup(t);
  const b = await boot(t, e);
  const r = await b.get('agents');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.agents.map((a) => [a.name, a.scope, a.model]), [['helper', 'user', null], ['reviewer', 'project', 'sonnet']]);
});

// ------------------------------------------------------------ board_add, board_update and board_list

test('board_add and board_update take an agent, show it in board_list, and swap it with a lane', async (t) => {
  const e = setup(t);
  const c = mcp(t, e);
  await c.init();
  const added = await c.call('board_add', { title: 'Review the parser', agent: 'reviewer' });
  assert.equal(added.isError, false, added.text);
  assert.match(added.text, /, agent reviewer\./);
  const id = added.text.match(/\bc\d+\b/)[0];
  assert.equal(core.readState(e.projectDir).cards[0].agent, 'reviewer');
  const idea = await c.call('board_add', { title: 'Maybe a cache', kind: 'idea', agent: 'helper' });
  assert.equal(idea.isError, false, idea.text);
  const listed = (await c.call('board_list')).text;
  assert.ok(listed.includes(`- ${id} [task] Review the parser {agent: reviewer}`), listed);
  assert.ok(listed.includes('Maybe a cache {agent: helper}'), listed);
  const moved = await c.call('board_update', { id, agent: 'helper' });
  assert.equal(moved.isError, false, moved.text);
  assert.match(moved.text, /agent helper/);
  assert.match((await c.call('board_update', { id, note: 'only a note' })).text, /agent helper/, 'an update without agent keeps it');
  const laned = await c.call('board_update', { id, lane: 'code-codex' });
  assert.equal(laned.isError, false, laned.text);
  assert.match(laned.text, /lane code-codex/);
  assert.equal('agent' in core.readState(e.projectDir).cards.find((x) => x.id === id), false, 'a lane takes the agent off');
  assert.ok((await c.call('board_list')).text.includes(`${id} [task] Review the parser {lane: code-codex}`));
  await c.call('board_update', { id, agent: 'reviewer' });
  assert.equal('lane' in core.readState(e.projectDir).cards.find((x) => x.id === id), false, 'and an agent takes the lane off');
  const cleared = await c.call('board_update', { id, agent: '' });
  assert.equal(cleared.isError, false, cleared.text);
  assert.ok(!cleared.text.includes('agent'));
  assert.equal(core.readState(e.projectDir).cards.find((x) => x.id === id).agent, undefined);
  assert.ok(!(await c.call('board_list')).text.includes(`${id} [task] Review the parser {agent`));
});

test('board_add and board_update refuse a bad agent with a one-line message that says what to do', async (t) => {
  const e = setup(t);
  const c = mcp(t, e);
  await c.init();
  const id = (await c.call('board_add', { title: 'Plain' })).text.match(/\bc\d+\b/)[0];
  const ms = (await c.call('board_add', { title: 'Group', kind: 'milestone' })).text.match(/\bc\d+\b/)[0];
  const refuse = async (tool, args, re) => {
    const r = await c.call(tool, args);
    assert.equal(r.isError, true, `${tool} ${JSON.stringify(args)} was accepted: ${r.text}`);
    assert.ok(!r.text.includes('\n'), 'one line');
    assert.match(r.text, re);
  };
  await refuse('board_add', { title: 'x', kind: 'milestone', agent: 'reviewer' }, /milestone cannot have an agent/);
  await refuse('board_update', { id: ms, agent: 'reviewer' }, /milestone cannot have an agent/);
  await refuse('board_add', { title: 'x', agent: 'ghost' }, /Unknown agent "ghost"\. Available: helper, reviewer\./);
  await refuse('board_update', { id, agent: 'ghost' }, /Unknown agent "ghost"/);
  await refuse('board_update', { id, agent: 'reviewer', lane: 'code-codex' }, /a card has one worker/);
  await refuse('board_update', { id: 'c999', agent: 'reviewer' }, /not found/);
  assert.equal(core.readState(e.projectDir).cards.length, 2, 'a refused add leaves no card');
  assert.equal(core.readState(e.projectDir).cards.find((x) => x.id === id).agent, undefined);
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [...core.readState(e.projectDir).cards, threadCard({ id: 'c9', title: 'A thread' })]));
  await refuse('board_update', { id: 'c9', agent: 'reviewer' }, /a thread's agent is chosen when it starts/);
});

test('the tool descriptions say that a card has a lane or an agent, never both', async (t) => {
  const e = setup(t);
  const c = mcp(t, e);
  await c.init();
  const tools = (await c.request('tools/list', {})).result.tools;
  for (const name of ['board_add', 'board_update']) {
    const tool = tools.find((x) => x.name === name);
    assert.ok(tool.inputSchema.properties.agent, `${name} takes an agent`);
    assert.match(tool.inputSchema.properties.agent.description, /lane/);
  }
  assert.match(tools.find((x) => x.name === 'board_list').description, /\{agent: name\}/);
});

// ------------------------------------------------------------ released versions (they share the data directory)

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { oldServerFrom, runNode, TEST_DIR } from './helpers.mjs';

const OLD_WORKER = path.join(TEST_DIR, 'fixtures', 'old-worker-writer.mjs');
const REFS = ['v0.15.2', 'v0.16.0'];   // the versions with a repo-backed board and notify requests, which do not know the card's agent
const oldModule = (old, name) => import(pathToFileURL(path.join(old, name)).href);

for (const ref of REFS) test(`cross-version: a card's agent keeps the same file text order and hash in the plugin version at ${ref}, and survives its rewrite of the card`, async (t) => {
  const old = oldServerFrom(t, ref);
  if (!old) return;
  const e = setup(t);
  const [rNew, rOld] = [await import('../server/repo.mjs'), await oldModule(old, 'repo.mjs')];
  const shared = { id: 'c8k2x1', kind: 'task', title: 'T', note: 'n', status: 'new', source: 'user', lane: 'code-codex', agent: 'reviewer', type: 'bug', priority: 'high', createdAt: 'a', updatedAt: 'b', history: [] };
  assert.equal(rNew.cardText(shared), rOld.cardText(shared), 'the same text: `agent` sorts as an unknown key, last, in every version');
  assert.equal(rNew.sharedHash(shared), rOld.sharedHash(shared), 'so the same hash, and no false drift');
  assert.equal(Object.keys(JSON.parse(rNew.cardText(shared))).at(-1), 'agent');
  // a repo-backed project: this version writes a card with an agent, the older one renames it, this one reads it back
  const git = (...a) => import('node:child_process').then(({ execFileSync }) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...a], { cwd: e.projectDir, stdio: 'ignore' }));
  await git('init', '-q');
  core.resetRepoCache?.();
  core.enableRepo(e.projectDir);
  const c = await core.addCard(e.projectDir, { title: 'Review it', agent: 'reviewer', source: 'user' });
  const file = path.join(e.projectDir, '.claude', 'thread', 'cards', `${c.id}.json`);
  const keysBefore = Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')));
  const r = await runNode([OLD_WORKER, old, e.projectDir, 'rename', c.id], { env: { ...process.env, THREAD_DATA_DIR: e.dataDir } });
  assert.equal(r.code, 0, r.stderr);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.title, 'Renamed by the older version');
  assert.equal(after.agent, 'reviewer', 'the older version keeps a field it does not know');
  assert.deepEqual(Object.keys(after), keysBefore, 'and writes the keys in the order this version does');
  assert.equal(card(e.projectDir, c.id).agent, 'reviewer');
});

for (const ref of REFS) test(`cross-version: the notify revision of a repo card with an agent is the same in the plugin version at ${ref}, so a click is delivered across versions`, async (t) => {
  const old = oldServerFrom(t, ref);
  if (!old) return;
  setup(t);
  const [nNew, nOld] = [await import('../server/notify.mjs'), await oldModule(old, 'notify.mjs')];
  const rc = { id: 'c9', kind: 'task', title: 'T', note: 'n', status: 'new', updatedAt: 'U', approvals: {}, agent: 'reviewer' };
  assert.equal(nNew.notifyRev(rc), nOld.notifyRev(rc));
  assert.equal(nNew.notifyRev(rc), nNew.notifyRev({ ...rc, agent: undefined }), 'the agent is not a part of it');
  const req = { ...rc, notifyId: 'n1', notifySession: PARENT_SESSION, notifyForRev: nNew.notifyRev(rc) };
  assert.equal(nNew.notifyActive(req), true);
  assert.equal(nOld.notifyActive(req), true, 'the older version sees the request this version stored');
  const reqOld = { ...rc, notifyId: 'n1', notifySession: PARENT_SESSION, notifyForRev: nOld.notifyRev(rc) };
  assert.equal(nNew.notifyActive(reqOld), true, 'and this version the one the older version stored');
});

for (const ref of REFS) test(`cross-version: the page's Start request of this version, sent to the board of the plugin version at ${ref}, runs the card's agent`, async (t) => {
  const old = oldServerFrom(t, ref);
  if (!old) return;
  const e = setup(t);
  await core.touchSession(e.projectDir, PARENT_SESSION, {});
  await core.addCard(e.projectDir, { title: 'Review it', note: 'Look at the diff.', agent: 'reviewer', source: 'user' });
  const child = spawn(process.execPath, [OLD_WORKER, old, e.projectDir, 'serve'], { env: { ...process.env, THREAD_DATA_DIR: e.dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  const first = await new Promise((res, rej) => {
    readline.createInterface({ input: child.stdout }).once('line', res);
    child.once('exit', (code) => rej(new Error(`the older board exited (${code})`)));
  });
  const [port, token, key] = first.split(' ');
  // the body the page sends when the worker is an agent (issue.js doStart); the older server ignores expectAgent
  const body = { sessionId: PARENT_SESSION, mode: 'read', context: 'brief', expectLane: null, expectAgent: 'reviewer', agent: 'reviewer' };
  const res = await fetch(`http://127.0.0.1:${port}/api/p/${key}/cards/c1/start`, { method: 'POST', headers: { 'X-Thread-Token': token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.thread.agent, 'reviewer', 'the older server ran it as the agent');
  await untilIdle(e, 'c1');
  assert.equal(valueOf(e.readLog()[0].argv, '--agent'), 'reviewer');
});

for (const ref of REFS) test(`cross-version: the plugin version at ${ref} sets a lane beside a card's agent; both stay, and when it removes the lane the agent is the worker again`, async (t) => {
  const old = oldServerFrom(t, ref);
  if (!old) return;
  const e = setup(t);
  const c = await core.addCard(e.projectDir, { title: 'Review it', agent: 'reviewer', source: 'user' });
  const run = (...args) => runNode([OLD_WORKER, old, e.projectDir, ...args], { env: { ...process.env, THREAD_DATA_DIR: e.dataDir } });
  assert.equal((await run('lane', c.id, 'code-codex')).code, 0);
  assert.deepEqual([card(e.projectDir, c.id).lane, card(e.projectDir, c.id).agent], ['code-codex', 'reviewer'], 'the older version does not know the agent, so both stay');
  const b = await boot(t, e);
  const view = (await b.get('state')).body.cards[0];
  assert.deepEqual([view.lane, view.agent], ['code-codex', 'reviewer'], 'this version shows (and would start) the lane');
  assert.equal((await run('lane', c.id, '')).code, 0);
  assert.deepEqual([card(e.projectDir, c.id).lane, card(e.projectDir, c.id).agent], [undefined, 'reviewer'], 'the lane is off, and the agent is the card\'s worker again');
  const r = await b.patch(c.id, { lane: 'code-codex' });
  assert.deepEqual([r.status, r.body.lane, 'agent' in r.body], [200, 'code-codex', false], 'this version swaps them');
});
