// A milestone has no stage of its own: it is empty (no counted card), open (a counted card is not finished) or done (all are), and the
// state follows its cards. Ideas do not count. A card in a stage after the done stage is finished. Nothing sets a milestone's status by hand.
// A task and an idea can swap kind. The core, the board's API and the MCP tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupThreadEnv, cleanAmbientEnv, McpClient, writeStateFile, emptyState, threadCard, FAKE_DELEGATE,
} from './helpers.mjs';
import * as core from '../server/core.mjs';
import { startBoardServer } from '../server/http.mjs';
import { clearLanesCache } from '../server/lanes.mjs';

cleanAmbientEnv();

const TOKEN = 'b'.repeat(32);
const JSON_HDR = { 'content-type': 'application/json', 'x-thread-token': TOKEN };
const NO_STAGE = /a milestone has no stage: it is done when all its cards are done/;
const NOW = '2026-10-14T03:00:00.000Z';
const stored = (id, over = {}) => ({ id, kind: 'task', title: id, note: '', status: 'new', source: 'claude', seenByClaude: true, createdAt: NOW, updatedAt: NOW, ...over });
const cardsOf = (e) => core.readState(e.projectDir).cards;
const cardOf = (e, id) => cardsOf(e).find((c) => c.id === id);
const stateOf = (e, id) => core.milestoneState(cardsOf(e), id, core.readConfig(e.projectDir));
const progressOf = (e, id) => core.milestoneProgress(cardsOf(e), id, core.readConfig(e.projectDir));
const LATER = [{ id: 'todo', label: 'To do' }, { id: 'doing', label: 'Doing' }, { id: 'done', label: 'Done' }, { id: 'released', label: 'Released' }];
const LATER_ROLES = { start: 'todo', working: 'doing', review: 'doing', blocked: 'doing', done: 'done' };

async function board(t, e) {
  const b = await startBoardServer(e.projectDir, { port: 0, token: TOKEN });
  t.after(() => new Promise((r) => { b.server.closeAllConnections?.(); b.server.close(() => r()); }));
  const base = `http://127.0.0.1:${b.port}`;
  const api = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: JSON_HDR, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { ...b, api, view: async (id) => (await api('GET', '/api/state')).body.cards.find((c) => c.id === id) };
}

const mcp = (t, e) => {
  const c = new McpClient(e);
  t.after(() => c.kill());
  return c;
};

// ---------------------------------------------------------------- the state

test('a milestone is empty with no card, open while a card is not finished and done when every card is', async (t) => {
  const e = setupThreadEnv(t);
  const m = await core.addCard(e.projectDir, { title: 'Launch', kind: 'milestone' });
  assert.equal(stateOf(e, m.id), 'empty');
  assert.deepEqual(progressOf(e, m.id), { done: 0, total: 0 });
  const a = await core.addCard(e.projectDir, { title: 'A', parent: m.id });
  await core.addCard(e.projectDir, { title: 'B', parent: m.id, status: 'done' });
  assert.equal(stateOf(e, m.id), 'open');
  assert.deepEqual(progressOf(e, m.id), { done: 1, total: 2 });
  await core.updateCard(e.projectDir, a.id, { status: 'done' });
  assert.equal(stateOf(e, m.id), 'done');
  assert.deepEqual(progressOf(e, m.id), { done: 2, total: 2 });
});

test('a card in a stage after the done stage is finished, and a stage before it is not', async (t) => {
  const e = setupThreadEnv(t);
  await core.saveConfig(e.projectDir, 'project', { stages: LATER, roles: LATER_ROLES });
  const m = await core.addCard(e.projectDir, { title: 'Launch', kind: 'milestone' });
  await core.addCard(e.projectDir, { title: 'Released one', parent: m.id, status: 'released' });
  await core.addCard(e.projectDir, { title: 'Done one', parent: m.id, status: 'done' });
  assert.equal(stateOf(e, m.id), 'done');
  const late = await core.addCard(e.projectDir, { title: 'Working', parent: m.id, status: 'doing' });
  assert.equal(stateOf(e, m.id), 'open');
  assert.deepEqual(progressOf(e, m.id), { done: 2, total: 3 });
  await core.updateCard(e.projectDir, late.id, { status: 'released' });
  assert.equal(stateOf(e, m.id), 'done');
});

test('ideas are not counted until they become tasks', async (t) => {
  const e = setupThreadEnv(t);
  const m = await core.addCard(e.projectDir, { title: 'Launch', kind: 'milestone' });
  const idea = await core.addCard(e.projectDir, { title: 'Maybe', kind: 'idea', parent: m.id });
  assert.equal(stateOf(e, m.id), 'empty', 'only an idea: nothing counts');
  assert.deepEqual(progressOf(e, m.id), { done: 0, total: 0 });
  await core.addCard(e.projectDir, { title: 'Real', parent: m.id, status: 'done' });
  assert.equal(stateOf(e, m.id), 'done', 'an open idea does not hold the milestone open');
  await core.updateCard(e.projectDir, idea.id, { kind: 'task' });
  assert.equal(stateOf(e, m.id), 'open', 'now it counts');
  assert.deepEqual(progressOf(e, m.id), { done: 1, total: 2 });
  await core.updateCard(e.projectDir, idea.id, { kind: 'idea' });
  assert.equal(stateOf(e, m.id), 'done');
});

test('an ended thread under a milestone is finished; an idle or running one is not', async (t) => {
  const e = setupThreadEnv(t);
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [
    stored('c1', { kind: 'milestone' }),
    threadCard({ id: 'c2', parent: 'c1', status: 'done' }, { runState: 'ended' }),
  ]));
  assert.equal(stateOf(e, 'c1'), 'done');
  const state = core.readState(e.projectDir);
  state.cards.push(threadCard({ id: 'c3', parent: 'c1', status: 'review' }, { runState: 'idle' }));
  state.seq = 3;
  writeStateFile(e.dataDir, e.projectDir, state);
  assert.equal(stateOf(e, 'c1'), 'open');
  assert.deepEqual(progressOf(e, 'c1'), { done: 1, total: 2 });
  state.cards[2].thread.runState = 'ended';
  writeStateFile(e.dataDir, e.projectDir, state);
  assert.equal(stateOf(e, 'c1'), 'done');
});

test('a done milestone reopens when a card is added to it or a card leaves the done stage', async (t) => {
  const e = setupThreadEnv(t);
  const m = await core.addCard(e.projectDir, { title: 'Launch', kind: 'milestone' });
  const a = await core.addCard(e.projectDir, { title: 'A', parent: m.id, status: 'done' });
  assert.equal(stateOf(e, m.id), 'done');
  const b = await core.addCard(e.projectDir, { title: 'B', parent: m.id });
  assert.equal(stateOf(e, m.id), 'open', 'adding a card');
  await core.updateCard(e.projectDir, b.id, { status: 'done' });
  assert.equal(stateOf(e, m.id), 'done');
  await core.updateCard(e.projectDir, a.id, { status: 'in_progress' });
  assert.equal(stateOf(e, m.id), 'open', 'a card leaves done');
  await core.updateCard(e.projectDir, a.id, { status: 'done' });
  assert.equal(stateOf(e, m.id), 'done');
  const c = await core.addCard(e.projectDir, { title: 'C' });
  await core.updateCard(e.projectDir, c.id, { parent: m.id });
  assert.equal(stateOf(e, m.id), 'open', 'a card moved into the milestone');
});

test('a state file an older version wrote (a milestone stored as done with open cards) reads as open', async (t) => {
  const e = setupThreadEnv(t);
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [
    stored('c1', { kind: 'milestone', status: 'done' }),
    stored('c2', { parent: 'c1', status: 'new' }),
    stored('c3', { kind: 'milestone', status: 'new' }),
    stored('c4', { parent: 'c3', status: 'done' }),
  ]));
  assert.equal(stateOf(e, 'c1'), 'open', 'the stored status is ignored');
  assert.equal(stateOf(e, 'c3'), 'done');
  const b = await board(t, e);
  const view = (await b.api('GET', '/api/state')).body.cards;
  assert.equal(view.find((c) => c.id === 'c1').msState, 'open');
  assert.equal(view.find((c) => c.id === 'c3').msState, 'done');
  // nothing was migrated: the stored statuses are what they were
  assert.deepEqual(cardsOf(e).filter((c) => c.kind === 'milestone').map((c) => c.status), ['done', 'new']);
  // the project listing leaves milestones out of its counts
  const mine = (await b.api('GET', '/api/projects')).body.projects.find((p) => p.projectDir === e.projectDir);
  assert.deepEqual([mine.open, mine.done], [1, 1]);
});

// ---------------------------------------------------------------- no status by hand

test('a milestone is added without a stage, and a status is refused; the start stage is stored for older versions', async (t) => {
  const e = setupThreadEnv(t);
  await assert.rejects(core.addCard(e.projectDir, { title: 'M', kind: 'milestone', status: 'done' }), NO_STAGE);
  await assert.rejects(core.addCard(e.projectDir, { title: 'M', kind: 'milestone', status: 'nonsense' }), NO_STAGE);
  assert.equal(cardsOf(e).length, 0, 'nothing was added');
  const m = await core.addCard(e.projectDir, { title: 'M', kind: 'milestone' });
  assert.equal(m.status, core.readConfig(e.projectDir).roles.start);
  assert.equal(core.readConfig(e.projectDir).roles.start, 'new');
  // custom stages: their start stage
  await core.saveConfig(e.projectDir, 'project', { stages: LATER, roles: LATER_ROLES });
  assert.equal((await core.addCard(e.projectDir, { title: 'M2', kind: 'milestone' })).status, 'todo');
  // a task still takes one
  assert.equal((await core.addCard(e.projectDir, { title: 'T', status: 'doing' })).status, 'doing');
});

test('a status on a milestone is refused in board_update, in the core and in PATCH, with the same words', async (t) => {
  const e = setupThreadEnv(t);
  const m = await core.addCard(e.projectDir, { title: 'M', kind: 'milestone' });
  await assert.rejects(core.updateCard(e.projectDir, m.id, { status: 'done' }), NO_STAGE);
  await assert.rejects(core.updateCard(e.projectDir, m.id, { status: 'new' }, { source: 'user' }), NO_STAGE, 'the same status it has is refused too');
  assert.equal(cardOf(e, m.id).status, 'new');
  // other changes still work
  assert.equal((await core.updateCard(e.projectDir, m.id, { title: 'M 2' })).title, 'M 2');

  const b = await board(t, e);
  const r = await b.api('PATCH', `/api/cards/${m.id}`, { status: 'done' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, NO_STAGE);
  assert.equal((await b.api('PATCH', `/api/cards/${m.id}`, { title: 'M 3' })).status, 200);
  const made = await b.api('POST', '/api/cards', { title: 'X', kind: 'milestone', status: 'done' });
  assert.equal(made.status, 400);
  assert.match(made.body.error, NO_STAGE);
  const ok = await b.api('POST', '/api/cards', { title: 'Y', kind: 'milestone' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.status, 'new');

  const c = mcp(t, e);
  await c.init();
  const upd = await c.call('board_update', { id: m.id, status: 'done' });
  assert.equal(upd.isError, true);
  assert.match(upd.text, NO_STAGE);
  const add = await c.call('board_add', { title: 'Z', kind: 'milestone', status: 'done' });
  assert.equal(add.isError, true);
  assert.match(add.text, NO_STAGE);
  const fine = await c.call('board_add', { title: 'Z', kind: 'milestone' });
  assert.equal(fine.isError, false, fine.text);
  assert.doesNotMatch(fine.text, / in new/, 'a milestone has no stage to report');
  const note = await c.call('board_update', { id: m.id, note: 'n' });
  assert.equal(note.isError, false, note.text);
  assert.doesNotMatch(note.text, /\(new/);
  const tools = (await c.request('tools/list', {})).result.tools;
  const byName = Object.fromEntries(tools.map((x) => [x.name, x]));
  assert.match(byName.board_add.inputSchema.properties.status.description, /milestone.*no stage/);
  assert.match(byName.board_update.inputSchema.properties.status.description, /milestone.*no stage/);
  assert.deepEqual(byName.board_update.inputSchema.properties.kind.enum, ['task', 'idea']);
});

// ---------------------------------------------------------------- task and idea swap kind

test('a task becomes an idea and back, and the change is in the history', async (t) => {
  const e = setupThreadEnv(t);
  const c = await core.addCard(e.projectDir, { title: 'Maybe', labels: ['x'], priority: 'high', lane: undefined });
  const idea = await core.updateCard(e.projectDir, c.id, { kind: 'idea' }, { source: 'user' });
  assert.equal(idea.kind, 'idea');
  assert.deepEqual(idea.history.slice(-1)[0], { at: idea.updatedAt, by: 'user', type: 'edited', fields: ['kind'] });
  assert.deepEqual([idea.labels, idea.priority, idea.status], [['x'], 'high', 'new'], 'everything else stays');
  const task = await core.updateCard(e.projectDir, c.id, { kind: 'task' });
  assert.equal(task.kind, 'task');
  assert.deepEqual(task.history.slice(-1)[0].fields, ['kind']);
  assert.equal(task.history.slice(-1)[0].by, 'claude');
  // the same kind is no change and no entry
  const n = cardOf(e, c.id).history.length;
  await core.updateCard(e.projectDir, c.id, { kind: 'task' });
  assert.equal(cardOf(e, c.id).history.length, n);
  // with another edit in the same call it is one entry naming both
  const both = await core.updateCard(e.projectDir, c.id, { kind: 'idea', title: 'Maybe, later' });
  assert.deepEqual(both.history.slice(-1)[0].fields.sort(), ['kind', 'title']);
});

test('a card keeps its lane, criteria, blockers and waiting items when it changes kind', async (t) => {
  clearLanesCache();
  t.after(clearLanesCache);
  // a real lane from the fake delegate skills: board_add checks the name against them
  const e = setupThreadEnv(t, { THREAD_DELEGATE_DIR: FAKE_DELEGATE, FAKE_DELEGATE_MODE: 'ok' });
  const blocker = await core.addCard(e.projectDir, { title: 'Blocker' });
  const c = mcp(t, e);
  await c.init();
  const added = await c.call('board_add', { title: 'Idea', kind: 'idea', lane: 'code-codex', criteria: ['one'], blocked_by: [blocker.id], type: 'bug' });
  assert.equal(added.isError, false, added.text);
  const id = /Added (c\d+)/.exec(added.text)[1];
  const { item } = await core.addWait(e.projectDir, { card: id, kind: 'question', text: 'Which retry limit?', sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
  const before = cardOf(e, id);
  assert.deepEqual([before.lane, before.criteria, before.blockedBy, before.type, before.waits.length], ['code-codex', ['one'], [blocker.id], 'bug', 1]);
  for (const kind of ['task', 'idea', 'task']) {
    const card = await core.updateCard(e.projectDir, id, { kind }, { source: 'user' });
    assert.equal(card.kind, kind);
    assert.deepEqual([card.lane, card.criteria, card.blockedBy, card.type], ['code-codex', ['one'], [blocker.id], 'bug'], `after ${kind}`);
    assert.deepEqual(core.openWaits(card).map((w) => w.id), [item.id], 'the waiting item is still open');
    assert.equal(card.history.at(-1).fields.includes('kind'), true);
  }
  // through the tool too: board_list shows all of it on the card
  assert.equal((await c.call('board_update', { id, kind: 'idea' })).isError, false);
  const listed = (await c.call('board_list')).text;
  assert.match(listed, new RegExp(`- ${id} \\[idea\\] Idea \\(bug\\) \\{blocked by ${blocker.id}\\} \\[criteria 1\\] \\{lane: code-codex\\} \\(1 waiting\\)`), listed);
  assert.equal(core.checkLaneKind('task'), undefined);
  assert.equal(core.checkLaneKind('idea'), undefined, 'a task and an idea can both have a lane');
});

test('a thread or a milestone never changes kind, and no card becomes a milestone or a thread', async (t) => {
  const e = setupThreadEnv(t);
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [
    stored('c1', { kind: 'milestone' }), stored('c2'), stored('c3', { kind: 'idea' }), threadCard({ id: 'c4' }),
  ]));
  await assert.rejects(core.updateCard(e.projectDir, 'c1', { kind: 'task' }), /c1 is a milestone: its kind cannot be changed/);
  await assert.rejects(core.updateCard(e.projectDir, 'c4', { kind: 'idea' }), /c4 is a thread: its kind cannot be changed/);
  await assert.rejects(core.updateCard(e.projectDir, 'c2', { kind: 'milestone' }), /can only become a task or an idea/);
  await assert.rejects(core.updateCard(e.projectDir, 'c3', { kind: 'milestone' }), /can only become a task or an idea/);
  await assert.rejects(core.updateCard(e.projectDir, 'c2', { kind: 'thread' }), /can only become a task or an idea/);
  await assert.rejects(core.updateCard(e.projectDir, 'c2', { kind: 'nonsense' }), /can only become a task or an idea/);
  await assert.rejects(core.updateCard(e.projectDir, 'c2', { kind: 5 }), /kind must be/);
  assert.deepEqual(cardsOf(e).map((c) => c.kind), ['milestone', 'task', 'idea', 'thread']);
  // a thread or a milestone sent its own kind is no change
  await core.updateCard(e.projectDir, 'c1', { kind: 'milestone', title: 'M' });

  const b = await board(t, e);
  for (const [id, kind] of [['c1', 'task'], ['c4', 'idea'], ['c2', 'milestone'], ['c2', 'thread']]) {
    const r = await b.api('PATCH', `/api/cards/${id}`, { kind });
    assert.equal(r.status, 400, `${id} ${kind}`);
  }
  assert.equal((await b.api('PATCH', '/api/cards/c2', { kind: 'idea' })).body.kind, 'idea');
  assert.equal((await b.api('PATCH', '/api/cards/c2', { kind: 7 })).status, 400);

  const c = mcp(t, e);
  await c.init();
  const turned = await c.call('board_update', { id: 'c3', kind: 'task' });
  assert.equal(turned.isError, false, turned.text);
  assert.equal(cardOf(e, 'c3').kind, 'task');
  assert.equal((await c.call('board_update', { id: 'c1', kind: 'task' })).isError, true);
  assert.equal((await c.call('board_update', { id: 'c3', kind: 'milestone' })).isError, true, 'the tool only takes task or idea');
});

// ---------------------------------------------------------------- what the tools and the board show

test('board_list puts milestones in their own section with their state and progress, after the stages\' cards', async (t) => {
  const e = setupThreadEnv(t);
  const open = await core.addCard(e.projectDir, { title: 'Open one', kind: 'milestone', note: 'the note' });
  const done = await core.addCard(e.projectDir, { title: 'Done one', kind: 'milestone' });
  const empty = await core.addCard(e.projectDir, { title: 'Empty one', kind: 'milestone' });
  await core.addCard(e.projectDir, { title: 'a', parent: open.id, status: 'done' });
  await core.addCard(e.projectDir, { title: 'b', parent: open.id });
  await core.addCard(e.projectDir, { title: 'c', parent: done.id, status: 'done' });
  await core.addCard(e.projectDir, { title: 'idea', kind: 'idea', parent: empty.id });
  await core.addCard(e.projectDir, { title: 'loose' });
  const c = mcp(t, e);
  await c.init();
  const text = (await c.call('board_list')).text;
  const lines = text.split('\n');
  assert.ok(lines.includes('Milestones (3)'), text);
  assert.ok(lines.includes(`- ${open.id} [milestone:open] Open one (1/2 done) — the note`), text);
  assert.ok(lines.includes(`- ${done.id} [milestone:done] Done one (1/1 done)`), text);
  assert.ok(lines.includes(`- ${empty.id} [milestone:empty] Empty one (0/0 done)`), text);
  // the milestones are not in the stage groups, and the groups' own lines are as before
  assert.match(text, /^New \(3\)$/m, 'the loose card, the open one\'s b and the idea');
  assert.match(text, /^Done \(2\)$/m);
  assert.ok(text.indexOf('Milestones (3)') > text.indexOf('Done (2)'), 'after the stages');
  assert.ok(text.indexOf('Milestones (3)') < text.indexOf('Stages, as id'));
  assert.match(text, /^- c\d+ \[task\] loose$/m);
  // the report for one milestone says its state
  const report = (await c.call('board_list', { parent: open.id })).text;
  assert.equal(report.split('\n')[0], `Milestone ${open.id} "Open one": open, 1 of 2 done.`);
  assert.ok(report.includes(`[milestone:open] Open one`));
  assert.equal((await c.call('board_list', { parent: done.id })).text.split('\n')[0], `Milestone ${done.id} "Done one": done, 1 of 1 done.`);
  assert.match((await c.call('board_list', { parent: empty.id })).text.split('\n')[0], /: empty, 0 of 0 done\.$/);
  const desc = (await c.request('tools/list', {})).result.tools.find((x) => x.name === 'board_list').description;
  assert.match(desc, /milestones are listed in their own section/);
});

test('a board with only milestones is not listed as empty', async (t) => {
  const e = setupThreadEnv(t);
  await core.addCard(e.projectDir, { title: 'Only', kind: 'milestone' });
  const c = mcp(t, e);
  await c.init();
  const text = (await c.call('board_list')).text;
  assert.match(text, /^Milestones \(1\)$/m);
  assert.doesNotMatch(text, /The board is empty/);
});

test('the board sends msState with a milestone, next to its progress', async (t) => {
  const e = setupThreadEnv(t);
  const m = await core.addCard(e.projectDir, { title: 'M', kind: 'milestone' });
  const b = await board(t, e);
  let v = await b.view(m.id);
  assert.deepEqual([v.msState, v.progress], ['empty', { done: 0, total: 0 }]);
  await core.addCard(e.projectDir, { title: 'a', parent: m.id });
  v = await b.view(m.id);
  assert.deepEqual([v.msState, v.progress], ['open', { done: 0, total: 1 }]);
  await core.addCard(e.projectDir, { title: 'i', parent: m.id, kind: 'idea' });
  assert.deepEqual((await b.view(m.id)).progress, { done: 0, total: 1 }, 'the idea is left out');
  const t1 = (await b.api('GET', '/api/state')).body.cards.find((c) => c.title === 'a');
  await b.api('PATCH', `/api/cards/${t1.id}`, { status: 'done' });
  v = await b.view(m.id);
  assert.deepEqual([v.msState, v.progress], ['done', { done: 1, total: 1 }]);
  assert.equal((await b.view(t1.id)).msState, undefined, 'only a milestone has one');
});
