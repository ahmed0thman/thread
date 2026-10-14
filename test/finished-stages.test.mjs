// One meaning of "finished": a card is finished in the task board's done stage and in every stage after it (Done and Released), a thread
// in the stage of the done role. The done gate, the approval, the not-verified mark, blockers and the project listing all use it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  setupThreadEnv, cleanAmbientEnv, McpClient, runNode, writeStateFile, emptyState, oldServerFrom, PARENT_SESSION, TEST_DIR,
} from './helpers.mjs';
import * as core from '../server/core.mjs';
import { startBoardServer } from '../server/http.mjs';

cleanAmbientEnv();

const TOKEN = 'c'.repeat(32);
const STAGES = [{ id: 'todo', label: 'To do' }, { id: 'doing', label: 'Doing' }, { id: 'done', label: 'Done' }, { id: 'released', label: 'Released' }];
const ROLES = { start: 'todo', working: 'doing', review: 'doing', blocked: 'doing', done: 'done' };
const GATE = (id, to) => new RegExp(`${id} has acceptance criteria: raise a review item with wait_add \\(kind review\\) and move it to ${to} after the owner approves`);
const cardOf = (e, id) => core.readState(e.projectDir).cards.find((c) => c.id === id);
const tick = () => new Promise((r) => setTimeout(r, 5));   // timestamps are in ms; a step that must come after another waits one out
const finished = (e) => core.finishedStageIds(core.readConfig(e.projectDir));

async function setup(t) {
  const e = setupThreadEnv(t);
  await core.saveConfig(e.projectDir, 'project', { stages: STAGES, roles: ROLES });
  return e;
}

/** Raise a review item on `id` and answer it on the board (what the owner does). */
async function review(e, id, verdict = 'approve') {
  const { item } = await core.addWait(e.projectDir, { card: id, kind: 'review', text: 'Please check it', sessionId: PARENT_SESSION });
  await core.answerWait(e.projectDir, id, item.id, { verdict });
  return item;
}

async function board(t, e) {
  const b = await startBoardServer(e.projectDir, { port: 0, token: TOKEN });
  t.after(() => new Promise((r) => { b.server.closeAllConnections?.(); b.server.close(() => r()); }));
  const api = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${b.port}${p}`, { method, headers: { 'content-type': 'application/json', 'x-thread-token': TOKEN }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { ...b, api, patch: (id, body) => api('PATCH', `/api/cards/${id}`, body), view: async (id) => (await api('GET', '/api/state')).body.cards.find((c) => c.id === id) };
}

const mcp = (t, e) => {
  const c = new McpClient(e);
  t.after(() => c.kill());
  return c;
};

// ---------------------------------------------------------------- the rule

test('finished stages are the done stage and every stage after it; a thread is finished in the stage of the done role', async (t) => {
  const e = await setup(t);
  const cfg = core.readConfig(e.projectDir);
  assert.deepEqual(finished(e), ['done', 'released']);
  assert.equal(core.stageFinished(cfg, 'released'), true);
  assert.equal(core.stageFinished(cfg, 'doing'), false);
  assert.equal(core.stageFinished(cfg, 'no-such-stage'), false);
  const a = await core.addCard(e.projectDir, { title: 'A', status: 'released' });
  const b = await core.addCard(e.projectDir, { title: 'B', status: 'doing' });
  assert.deepEqual([core.isFinished(a, cfg), core.isFinished(b, cfg)], [true, false]);
  // a card whose stage was removed from the config is shown in the start stage: not finished
  assert.equal(core.isFinished({ ...a, status: 'gone' }, cfg), false);
  const cards = [{ ...b, blockedBy: [a.id, 'c99'] }, a];
  assert.deepEqual(core.openBlockers(cards[0], cards, cfg), [], 'a finished blocker, and one that is gone');
  assert.deepEqual(core.openBlockers({ ...a, blockedBy: [b.id] }, [a, b], cfg), [b.id]);
});

// ---------------------------------------------------------------- (a) the done gate

test('Claude cannot move a card with criteria into Released, or add one there, without an approved review; the owner can', async (t) => {
  const e = await setup(t);
  const c = await core.addCard(e.projectDir, { title: 'Gated', criteria: ['works'] });
  await assert.rejects(core.updateCard(e.projectDir, c.id, { status: 'released' }), GATE('c1', 'released'));
  await assert.rejects(core.updateCard(e.projectDir, c.id, { status: 'done' }), GATE('c1', 'done'));
  assert.equal(cardOf(e, c.id).status, 'todo');
  await assert.rejects(core.addCard(e.projectDir, { title: 'Straight in', status: 'released', criteria: ['a'] }), GATE('c2', 'released'));
  assert.equal(core.readState(e.projectDir).cards.length, 1, 'nothing was added');
  // the owner's moves are not held to it
  assert.equal((await core.updateCard(e.projectDir, c.id, { status: 'released' }, { source: 'user' })).status, 'released');
  // criteria added in the same call count
  const d = await core.addCard(e.projectDir, { title: 'Plain', status: 'doing' });
  await assert.rejects(core.updateCard(e.projectDir, d.id, { status: 'released', criteria: ['x'] }), GATE('c2', 'released'));
  // through the tools too
  const m = mcp(t, e);
  await m.init();
  const r = await m.call('board_update', { id: d.id, criteria: ['x'] });
  assert.equal(r.isError, false, r.text);
  const refused = await m.call('board_update', { id: d.id, status: 'released' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /move it to released/);
  await review(e, d.id);
  assert.equal((await m.call('board_update', { id: d.id, status: 'released' })).isError, false);
});

test('a card approved in Done moves to Released and back for Claude, and keeps its approval', async (t) => {
  const e = await setup(t);
  const c = await core.addCard(e.projectDir, { title: 'Gated', criteria: ['works'] });
  await review(e, c.id);
  await tick();
  await core.updateCard(e.projectDir, c.id, { status: 'done' });
  await tick();
  assert.equal((await core.updateCard(e.projectDir, c.id, { status: 'released' })).status, 'released');
  assert.equal('leftDoneAt' in cardOf(e, c.id), false, 'Done to Released is no way out of the finished stages');
  assert.equal(core.reviewApproved(cardOf(e, c.id), finished(e)), true);
  assert.equal((await core.updateCard(e.projectDir, c.id, { status: 'done' })).status, 'done', 'and back');
  const bd = await board(t, e);
  const v = await bd.view(c.id);
  assert.equal(v.status, 'done');
  assert.equal('verified' in v, false);
  // the history alone says the same: a move between finished stages does not reset the approval
  const h = { ...cardOf(e, c.id), leftDoneAt: undefined };
  assert.equal(core.leftDoneAt(h, finished(e)), -Infinity);
});

test('a card the owner dragged into Done unverified cannot be moved on to Released by Claude', async (t) => {
  const e = await setup(t);
  const c = await core.addCard(e.projectDir, { title: 'Dragged', criteria: ['works'] });
  await core.updateCard(e.projectDir, c.id, { status: 'done' }, { source: 'user' });
  await assert.rejects(core.updateCard(e.projectDir, c.id, { status: 'released' }), GATE('c1', 'released'));
  await review(e, c.id);
  assert.equal((await core.updateCard(e.projectDir, c.id, { status: 'released' })).status, 'released');
});

// ---------------------------------------------------------------- (b) approval expiry

test('leaving the finished stages expires the approval; Released to doing does, and the old approval is spent', async (t) => {
  const e = await setup(t);
  const c = await core.addCard(e.projectDir, { title: 'Gated', criteria: ['works'] });
  await review(e, c.id);
  await tick();
  await core.updateCard(e.projectDir, c.id, { status: 'released' });
  await tick();
  const back = await core.updateCard(e.projectDir, c.id, { status: 'doing' });
  assert.equal(typeof back.leftDoneAt, 'string', 'a move from a finished stage to an unfinished one is recorded');
  assert.equal(core.reviewApproved(cardOf(e, c.id), finished(e)), false);
  await assert.rejects(core.updateCard(e.projectDir, c.id, { status: 'released' }), GATE('c1', 'released'));
  await assert.rejects(core.updateCard(e.projectDir, c.id, { status: 'done' }), GATE('c1', 'done'));
  await tick();
  await review(e, c.id);
  assert.equal((await core.updateCard(e.projectDir, c.id, { status: 'released' })).status, 'released', 'a new approval lets it through');
});

test('without the stored field the history decides: only a move from a finished stage to an unfinished one is an exit', () => {
  const range = ['done', 'released'];
  const mv = (at, from, to) => ({ at, type: 'moved', from, to });
  const at = (s) => Date.parse(s);
  assert.equal(core.leftDoneAt({ history: [mv('2026-10-14T03:00:00.000Z', 'done', 'released')] }, range), -Infinity);
  assert.equal(core.leftDoneAt({ history: [mv('2026-10-14T03:00:00.000Z', 'released', 'doing')] }, range), at('2026-10-14T03:00:00.000Z'));
  assert.equal(core.leftDoneAt({ history: [mv('2026-10-14T03:00:00.000Z', 'doing', 'done')] }, range), -Infinity, 'entering is no exit');
  // a card an older version moved from Done to Released has the stored field, and keeps it: stricter, never looser
  assert.equal(core.leftDoneAt({ leftDoneAt: '2026-10-14T04:00:00.000Z', history: [mv('2026-10-14T04:00:00.000Z', 'done', 'released')] }, range), at('2026-10-14T04:00:00.000Z'));
  // one id still works as it did
  assert.equal(core.leftDoneAt({ history: [mv('2026-10-14T03:00:00.000Z', 'done', 'doing')] }, 'done'), at('2026-10-14T03:00:00.000Z'));
  assert.deepEqual(core.finishedStageIds({ taskStages: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], taskRoles: { done: 'b' } }), ['b', 'c']);
  assert.deepEqual(core.finishedStageIds({ taskStages: [{ id: 'a' }], taskRoles: { done: 'zz' } }), []);
});

// ---------------------------------------------------------------- (c) not verified

test('a card with criteria in Released and no approval is marked not verified on the board and in board_list', async (t) => {
  const e = await setup(t);
  const c = await core.addCard(e.projectDir, { title: 'Dragged', criteria: ['works'] });
  const p = await core.addCard(e.projectDir, { title: 'Plain' });
  const bd = await board(t, e);
  assert.equal((await bd.patch(c.id, { status: 'released' })).body.verified, false);
  assert.equal('verified' in await bd.view(c.id), true);
  const m = mcp(t, e);
  await m.init();
  assert.match((await m.call('board_list')).text, new RegExp(`- ${c.id} \\[task\\] Dragged \\[criteria 1\\] \\(done, not verified\\)`));
  await bd.patch(p.id, { status: 'released' });
  assert.equal('verified' in await bd.view(p.id), false, 'no criteria, nothing to verify');
  await review(e, c.id);
  assert.equal('verified' in await bd.view(c.id), false);
  assert.doesNotMatch((await m.call('board_list')).text, /not verified/);
  // not in a finished stage: no mark
  const d = await core.addCard(e.projectDir, { title: 'Doing', criteria: ['a'], status: 'doing' });
  assert.equal('verified' in await bd.view(d.id), false);
});

// ---------------------------------------------------------------- (d) blockers

test('a blocker in Released holds nothing up in board_list, and the board still names every blocker on the card', async (t) => {
  const e = await setup(t);
  const open = await core.addCard(e.projectDir, { title: 'Open', status: 'doing' });
  const shipped = await core.addCard(e.projectDir, { title: 'Shipped', status: 'released' });
  const done = await core.addCard(e.projectDir, { title: 'Done', status: 'done' });
  await core.addCard(e.projectDir, { title: 'Waits', blockedBy: [open.id, shipped.id, done.id] });
  await core.addCard(e.projectDir, { title: 'Free', blockedBy: [shipped.id, done.id] });
  const m = mcp(t, e);
  await m.init();
  const text = (await m.call('board_list')).text;
  assert.match(text, new RegExp(`Waits \\{blocked by ${open.id}\\}`), text);
  assert.doesNotMatch(text, new RegExp(`${shipped.id}[,}]`), 'Released is not listed as a blocker');
  assert.match(text, /\[task\] Free$/m, 'every blocker is finished: not blocked');
  // the board still names all blockers on the card (it marks the open ones itself)
  const bd = await board(t, e);
  assert.deepEqual((await bd.view('c4')).blockedBy, [open.id, shipped.id, done.id]);
});

// ---------------------------------------------------------------- (e) the listing

test('the project listing counts a card in Released as done', async (t) => {
  const e = await setup(t);
  await core.addCard(e.projectDir, { title: 'a', status: 'todo' });
  await core.addCard(e.projectDir, { title: 'b', status: 'doing' });
  await core.addCard(e.projectDir, { title: 'c', status: 'done' });
  await core.addCard(e.projectDir, { title: 'd', status: 'released' });
  await core.addCard(e.projectDir, { title: 'ms', kind: 'milestone' });
  const bd = await board(t, e);
  const mine = (await bd.api('GET', '/api/projects')).body.projects.find((p) => p.projectDir === e.projectDir);
  assert.deepEqual([mine.open, mine.done], [2, 2]);
});

test('removing a card with criteria is allowed to Claude once the card is finished, in Released too', async (t) => {
  const e = await setup(t);
  const c = await core.addCard(e.projectDir, { title: 'Dragged', criteria: ['a'] });
  await assert.rejects(core.removeCard(e.projectDir, c.id), /not done or approved/);
  await core.updateCard(e.projectDir, c.id, { status: 'released' }, { source: 'user' });
  assert.equal(await core.removeCard(e.projectDir, c.id), true);
});

// ---------------------------------------------------------------- an older plugin version (0.12.1)

const WRITER = path.join(TEST_DIR, 'fixtures', 'old-finished-writer.mjs');
const oldRun = (e, old, mode) => runNode([WRITER, old, e.projectDir, mode], { env: { ...process.env, THREAD_DATA_DIR: e.dataDir } });
const stored = (id, over = {}) => ({ id, kind: 'task', title: id, note: '', status: 'new', source: 'claude', seenByClaude: true, createdAt: '2026-10-14T03:00:00.000Z', updatedAt: '2026-10-14T03:00:00.000Z', ...over });

// the version just before cards got one meaning of "finished" and milestones lost their stage
const V0121 = 'v0.12.1';

test(`a status the plugin version at ${V0121} wrote onto a milestone with open cards is not read as its state`, async (t) => {
  const old = oldServerFrom(t, V0121);
  if (!old) return;
  const e = setupThreadEnv(t);
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [stored('c1', { kind: 'milestone' }), stored('c2', { parent: 'c1', status: 'new' })]));
  const r = await oldRun(e, old, 'milestone');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(cardOf(e, 'c1').status, 'done', 'the older version did write a stage');
  const cfg = core.readConfig(e.projectDir);
  assert.equal(core.milestoneState(core.readState(e.projectDir).cards, 'c1', cfg), 'open');
  const bd = await board(t, e);
  const v = await bd.view('c1');
  assert.deepEqual([v.msState, v.progress], ['open', { done: 0, total: 1 }]);
  const m = mcp(t, e);
  await m.init();
  assert.match((await m.call('board_list')).text, /- c1 \[milestone:open\] c1 \(0\/1 done\)/);
});

test(`the plugin version at ${V0121} reads a card that this version turned from a task into an idea, and writes it back`, async (t) => {
  const old = oldServerFrom(t, V0121);
  if (!old) return;
  const e = setupThreadEnv(t);
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [stored('c1', { kind: 'milestone' }), stored('c2', { parent: 'c1', type: 'bug', criteria: ['a'] }), stored('c3', { parent: 'c1' })]));
  await core.updateCard(e.projectDir, 'c2', { kind: 'idea' }, { source: 'user' });
  const r = await oldRun(e, old, 'read');
  assert.equal(r.code, 0, r.stderr);
  const seen = JSON.parse(r.stdout.trim().split('\n')[0]);
  assert.deepEqual(seen.cards, [['c1', 'milestone', 'new'], ['c2', 'idea', 'new'], ['c3', 'task', 'new']]);
  assert.deepEqual(seen.progress, { done: 0, total: 2 }, 'it counts the idea; this version does not');
  const c = cardOf(e, 'c2');
  assert.equal(c.title, 'Renamed by the older version');
  assert.deepEqual([c.kind, c.type, c.criteria], ['idea', 'bug', ['a']], 'its kind, type and criteria survive its write');
});

test(`a card the plugin version at ${V0121} moves from Done to Released needs a new approval here: stricter, never looser`, async (t) => {
  const old = oldServerFrom(t, V0121);
  if (!old) return;
  const e = await setup(t);
  const c = await core.addCard(e.projectDir, { title: 'Shipped', criteria: ['works'] });
  await review(e, c.id);
  await tick();
  await core.updateCard(e.projectDir, c.id, { status: 'done' });
  await tick();
  const r = await oldRun(e, old, 'release');
  assert.equal(r.code, 0, r.stderr);
  const moved = cardOf(e, c.id);
  assert.equal(moved.status, 'released');
  assert.equal(typeof moved.leftDoneAt, 'string', 'the older version recorded the move as leaving done');
  assert.equal(core.reviewApproved(moved, finished(e)), false);
  const bd = await board(t, e);
  assert.equal((await bd.view(c.id)).verified, false);
  await assert.rejects(core.updateCard(e.projectDir, c.id, { status: 'done' }), GATE('c1', 'done'));
  await tick();
  await review(e, c.id);
  assert.equal((await core.updateCard(e.projectDir, c.id, { status: 'done' })).status, 'done');
  // nothing was migrated: the stored field is as the older version left it
  assert.equal(cardOf(e, c.id).leftDoneAt, moved.leftDoneAt);
});
