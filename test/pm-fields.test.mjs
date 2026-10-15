// The project-management fields of a card (type, priority, labels, blockedBy, criteria), who worked on it, and the done gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import {
  setupThreadEnv, cleanAmbientEnv, McpClient, runNode, writeStateFile, emptyState, threadCard, oldServerFrom, RELEASED_REFS,
  PARENT_SESSION, TEST_DIR,
} from './helpers.mjs';
import * as core from '../server/core.mjs';
import { startBoardServer } from '../server/http.mjs';

cleanAmbientEnv();

const TOKEN = 'a'.repeat(32);
const JSON_HDR = { 'content-type': 'application/json', 'x-thread-token': TOKEN };
const cardOf = (e, id) => core.readState(e.projectDir).cards.find((c) => c.id === id);
const task = (id, over = {}) => ({ id, kind: 'task', title: id, note: '', status: 'new', source: 'claude', seenByClaude: true, createdAt: '2026-10-14T03:00:00.000Z', updatedAt: '2026-10-14T03:00:00.000Z', ...over });
const rejects = (p, re) => assert.rejects(p, re);   // a third argument (a label) is ignored

/** Raise a review item on `id` and answer it on the board (what the owner does). */
async function review(e, id, verdict) {
  const { item } = await core.addWait(e.projectDir, { card: id, kind: 'review', text: 'Please check it', sessionId: PARENT_SESSION });
  if (verdict) await core.answerWait(e.projectDir, id, item.id, { verdict });
  return item;
}

async function board(t, e) {
  const b = await startBoardServer(e.projectDir, { port: 0, token: TOKEN });
  t.after(() => new Promise((r) => { b.server.closeAllConnections?.(); b.server.close(() => r()); }));
  const base = `http://127.0.0.1:${b.port}`;
  const api = async (method, p, body, headers = JSON_HDR) => {
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { ...b, base, api, patch: (id, body) => api('PATCH', `/api/cards/${id}`, body), view: async (id) => (await api('GET', '/api/state')).body.cards.find((c) => c.id === id) };
}

function mcp(t, e) {
  const c = new McpClient(e);
  t.after(() => c.kill());
  return c;
}

// ---------------------------------------------------------------- the fields

test('each field is checked, and stored only when it differs from its default', async (t) => {
  const e = setupThreadEnv(t);
  const blocker = await core.addCard(e.projectDir, { title: 'Blocker' });
  // validation
  await rejects(core.addCard(e.projectDir, { title: 'x', type: 'epic' }), /type must be one of: task, bug/);
  await rejects(core.addCard(e.projectDir, { title: 'x', type: 3 }), /type must be one of/);
  await rejects(core.addCard(e.projectDir, { title: 'x', priority: 'urgent' }), /priority must be one of: high, normal, low/);
  await rejects(core.addCard(e.projectDir, { title: 'x', labels: 'bug' }), /labels must be a list/);
  await rejects(core.addCard(e.projectDir, { title: 'x', labels: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }), /labels has too many entries \(9, the limit is 8\)/);
  await rejects(core.addCard(e.projectDir, { title: 'x', labels: ['ok', '  '] }), /each label must be 1 to 24 characters/);
  await rejects(core.addCard(e.projectDir, { title: 'x', labels: ['x'.repeat(25)] }), /each label must be 1 to 24 characters/);
  await rejects(core.addCard(e.projectDir, { title: 'x', labels: [4] }), /each label must be 1 to 24 characters/);
  await rejects(core.addCard(e.projectDir, { title: 'x', labels: ['Api', ' api '] }), /the label "api" is given twice/);
  await rejects(core.addCard(e.projectDir, { title: 'x', blockedBy: Array.from({ length: 11 }, (_, i) => `c${i + 1}`) }), /blocked_by has too many entries/);
  await rejects(core.addCard(e.projectDir, { title: 'x', blockedBy: ['four'] }), /blocked_by takes card ids/);
  await rejects(core.addCard(e.projectDir, { title: 'x', criteria: Array.from({ length: 11 }, () => 'a') }), /criteria has too many entries/);
  await rejects(core.addCard(e.projectDir, { title: 'x', criteria: ['a', ' '] }), /each criterion must be 1 to 200 characters/);
  await rejects(core.addCard(e.projectDir, { title: 'x', criteria: ['a'.repeat(201)] }), /each criterion must be 1 to 200 characters/);
  await rejects(core.addCard(e.projectDir, { title: 'x', criteria: [null] }), /each criterion must be 1 to 200 characters/);
  assert.equal(core.readState(e.projectDir).cards.length, 1, 'a refused card is not created');
  // the limits themselves are fine
  const edge = await core.addCard(e.projectDir, { title: 'Edge', labels: Array.from({ length: 8 }, (_, i) => `l${i}`), criteria: Array.from({ length: 10 }, () => 'c'.repeat(200)), blockedBy: [blocker.id] });
  assert.equal(edge.labels.length, 8);
  assert.equal(edge.criteria.length, 10);
  // defaults are not stored
  const plain = await core.addCard(e.projectDir, { title: 'Plain', type: 'task', priority: 'normal', labels: [], blockedBy: [], criteria: [] });
  for (const k of ['type', 'priority', 'labels', 'blockedBy', 'criteria']) assert.equal(k in plain, false, k);
  // values are cleaned
  const full = await core.addCard(e.projectDir, { title: 'Full', type: ' Bug ', priority: 'HIGH', labels: [' Backend ', 'UI'], blockedBy: [` ${blocker.id} `], criteria: [' it works '] });
  assert.equal(full.type, 'bug');
  assert.equal(full.priority, 'high');
  assert.deepEqual(full.labels, ['backend', 'ui']);
  assert.deepEqual(full.blockedBy, [blocker.id]);
  assert.deepEqual(full.criteria, ['it works']);
  // an update checks them the same way, and a refused update changes nothing
  await rejects(core.updateCard(e.projectDir, full.id, { title: 'New title', priority: 'urgent' }), /priority must be one of/);
  assert.equal(cardOf(e, full.id).title, 'Full');
  // a task is the default type: giving it removes a bug mark
  await core.updateCard(e.projectDir, full.id, { type: 'task', priority: 'normal' });
  assert.equal('type' in cardOf(e, full.id), false);
  assert.equal('priority' in cardOf(e, full.id), false);
});

test('an empty value removes a field, and the edit is in the history', async (t) => {
  const e = setupThreadEnv(t);
  const b = await core.addCard(e.projectDir, { title: 'B' });
  const c = await core.addCard(e.projectDir, { title: 'C', type: 'bug', priority: 'low', labels: ['x'], blockedBy: [b.id], criteria: ['y'] });
  // Claude may not remove criteria (see the criteria tests below), the board may
  await core.updateCard(e.projectDir, c.id, { type: '', priority: null, labels: [], blockedBy: [], criteria: '' }, { source: 'user' });
  const after = cardOf(e, c.id);
  for (const k of ['type', 'priority', 'labels', 'blockedBy', 'criteria']) assert.equal(k in after, false, k);
  const last = after.history[after.history.length - 1];
  assert.deepEqual(last.fields, ['type', 'priority', 'labels', 'blocked by', 'criteria']);
  // removing what is not there changes nothing: no new history entry
  const n = after.history.length;
  await core.updateCard(e.projectDir, c.id, { type: '', labels: [] });
  assert.equal(cardOf(e, c.id).history.length, n);
  // one field can be changed alone
  await core.updateCard(e.projectDir, c.id, { labels: ['one', 'two'] });
  await core.updateCard(e.projectDir, c.id, { priority: 'high' });
  assert.deepEqual(cardOf(e, c.id).labels, ['one', 'two']);
  assert.equal(cardOf(e, c.id).priority, 'high');
});

test('a milestone takes none of the fields; a thread takes type, priority and labels only', async (t) => {
  const e = setupThreadEnv(t);
  const m = await core.addCard(e.projectDir, { title: 'M', kind: 'milestone' });
  const other = await core.addCard(e.projectDir, { title: 'Other' });
  const given = { type: 'bug', priority: 'high', labels: ['a'], blockedBy: [other.id], criteria: ['c'] };
  for (const [k, v] of Object.entries(given)) {
    await rejects(core.addCard(e.projectDir, { title: 'M2', kind: 'milestone', [k]: v }), /a milestone cannot have/);
    await rejects(core.updateCard(e.projectDir, m.id, { [k]: v }), /a milestone cannot have/);
  }
  assert.equal(core.readState(e.projectDir).cards.length, 2);
  // removing from a milestone is no change, not an error
  await core.updateCard(e.projectDir, m.id, { type: '', labels: [], criteria: null });
  // a thread card
  const state = core.readState(e.projectDir);
  state.cards.push(threadCard({ id: 'c3' }));
  state.seq = 3;
  writeStateFile(e.dataDir, e.projectDir, state);
  await core.updateCard(e.projectDir, 'c3', { type: 'bug', priority: 'low', labels: ['t'] });
  assert.equal(cardOf(e, 'c3').type, 'bug');
  await rejects(core.updateCard(e.projectDir, 'c3', { blockedBy: [other.id] }), /a thread cannot have blocked by/);
  await rejects(core.updateCard(e.projectDir, 'c3', { criteria: ['c'] }), /a thread cannot have criteria/);
});

test('blockedBy names other cards of the project, never a milestone, and the views drop a card that is gone', async (t) => {
  const e = setupThreadEnv(t);
  const m = await core.addCard(e.projectDir, { title: 'M', kind: 'milestone' });
  const a = await core.addCard(e.projectDir, { title: 'A' });
  const b = await core.addCard(e.projectDir, { title: 'B' });
  await rejects(core.updateCard(e.projectDir, a.id, { blockedBy: ['c99'] }), /blocked_by: card not found: c99/);
  await rejects(core.updateCard(e.projectDir, a.id, { blockedBy: [a.id] }), /c2 cannot be blocked by itself/);
  await rejects(core.updateCard(e.projectDir, a.id, { blockedBy: [m.id] }), /blocked_by: c1 is a milestone/);
  await rejects(core.updateCard(e.projectDir, a.id, { blockedBy: [b.id, b.id] }), /given twice/);
  await rejects(core.addCard(e.projectDir, { title: 'N', blockedBy: [m.id] }), /is a milestone/);
  await core.updateCard(e.projectDir, a.id, { blockedBy: [b.id] });
  // a card that is blocked by a thread is fine
  const state = core.readState(e.projectDir);
  state.cards.push(threadCard({ id: 'c4' }));
  state.seq = 4;
  writeStateFile(e.dataDir, e.projectDir, state);
  await core.updateCard(e.projectDir, a.id, { blockedBy: [b.id, 'c4'] });
  assert.deepEqual(cardOf(e, a.id).blockedBy, ['c3', 'c4']);
  // b goes; the stored ids stay, the view drops it
  await core.removeCard(e.projectDir, b.id);
  assert.deepEqual(cardOf(e, a.id).blockedBy, ['c3', 'c4'], 'nothing is rewritten');
  const bd = await board(t, e);
  assert.deepEqual((await bd.view(a.id)).blockedBy, ['c4']);
  await core.removeCard(e.projectDir, 'c4');
  assert.equal('blockedBy' in (await bd.view(a.id)), false, 'no live blocker: no field');
});

// ---------------------------------------------------------------- who worked on a card

test('a history entry takes a worker of one of four forms', async (t) => {
  const e = setupThreadEnv(t);
  for (const w of ['main', 'agent:worker-high', 'agent:plugin:reviewer', 'thread:c12', 'thread:c8k2x1', 'lane:code-codex']) {
    const c = await core.addCard(e.projectDir, { title: w, worker: w });
    assert.equal(c.history[0].worker, w);
  }
  for (const w of ['mainx', 'agent:', 'agent: x', 'thread:12', 'thread:cxx', 'lane:', 'someone', 'agent:' + 'a'.repeat(60), 42]) {
    await rejects(core.addCard(e.projectDir, { title: 'x', worker: w }), /worker must be/, String(w));
  }
  assert.equal((await core.addCard(e.projectDir, { title: 'none', worker: '  ' })).history[0].worker, undefined, 'an empty worker is no worker');
  // every entry a call creates carries it
  const c = await core.addCard(e.projectDir, { title: 'Moves' });
  await core.updateCard(e.projectDir, c.id, { status: 'review', note: 'n' }, { source: 'claude' });
  const h = cardOf(e, c.id).history;
  assert.deepEqual(h.map((x) => x.worker), [undefined, undefined, undefined]);
  await core.updateCard(e.projectDir, c.id, { status: 'done', title: 'T', worker: 'agent:worker' }, { source: 'claude' });
  const h2 = cardOf(e, c.id).history;
  assert.deepEqual(h2.slice(3).map((x) => [x.type, x.worker]), [['moved', 'agent:worker'], ['edited', 'agent:worker']]);
  await rejects(core.updateCard(e.projectDir, c.id, { note: 'm', worker: 'bogus' }), /worker must be/);
  assert.equal(cardOf(e, c.id).note, 'n');
});

test('wait_add records the worker in the history, and only then', async (t) => {
  const e = setupThreadEnv(t);
  const c = await core.addCard(e.projectDir, { title: 'Work' });
  await core.addWait(e.projectDir, { card: c.id, kind: 'todo', text: 'a', sessionId: PARENT_SESSION });
  assert.equal(cardOf(e, c.id).history.length, 1, 'no worker: the history is left alone');
  await core.addWait(e.projectDir, { card: c.id, kind: 'todo', text: 'b', sessionId: PARENT_SESSION, worker: 'thread:c9' });
  const last = cardOf(e, c.id).history.at(-1);
  assert.equal(last.worker, 'thread:c9');
  assert.equal(last.by, 'claude');
  assert.equal(last.wait, 'c1.w2');
  await rejects(core.addWait(e.projectDir, { card: c.id, kind: 'todo', text: 'c', sessionId: PARENT_SESSION, worker: 'me' }), /worker must be/);
  assert.equal(cardOf(e, c.id).waits.length, 2);
});

test('workedBy lists each worker once, in the order they first appear', () => {
  const card = {
    createdAt: '2026-10-14T03:00:00.000Z',
    history: [
      { at: '2026-10-14T03:00:00.000Z', by: 'claude', type: 'created', worker: 'main' },
      { at: '2026-10-14T03:10:00.000Z', by: 'user', type: 'edited' },
      { at: '2026-10-14T03:30:00.000Z', by: 'claude', type: 'moved', worker: 'lane:code-codex' },
      { at: '2026-10-14T03:40:00.000Z', by: 'claude', type: 'moved', worker: 'main' },
      { at: '2026-10-14T03:50:00.000Z', by: 'claude', type: 'edited', worker: 'not a worker' },
    ],
    runs: [
      { n: 1, agentType: 'worker', startedAt: '2026-10-14T03:20:00.000Z' },
      { n: 2, agentType: 'worker', startedAt: '2026-10-14T03:35:00.000Z' },
      { n: 3, agentType: 'critic', startedAt: '2026-10-14T03:45:00.000Z' },
      { n: 4, agentType: 'two words', startedAt: '2026-10-14T03:46:00.000Z' },
    ],
  };
  assert.deepEqual(core.workedBy(card), ['main', 'agent:worker', 'lane:code-codex', 'agent:critic']);
  assert.deepEqual(core.workedBy({}), []);
  assert.deepEqual(core.workedBy(null), []);
  // a thread card: its agent or lane
  assert.deepEqual(core.workedBy(threadCard({}, { agent: 'analyst' })), ['agent:analyst']);
  assert.deepEqual(core.workedBy(threadCard({}, { lane: { name: 'code-codex', implementer: 'codex' } })), ['lane:code-codex']);
  assert.deepEqual(core.workedBy(threadCard({}, { model: 'haiku' })), [], 'a plain model is nobody in particular');
  // with no times at all the sources keep their order: history, then runs
  assert.deepEqual(core.workedBy({ history: [{ worker: 'thread:c2' }], runs: [{ agentType: 'a' }] }), ['thread:c2', 'agent:a']);
});

test('the card view carries workedBy', async (t) => {
  const e = setupThreadEnv(t);
  const c = await core.addCard(e.projectDir, { title: 'Seen', worker: 'main' });
  const state = core.readState(e.projectDir);
  state.cards[0].runs = [{ n: 1, agentId: 'a1', agentType: 'worker', state: 'done', startedAt: new Date(Date.now() + 1000).toISOString(), finishedAt: null, ok: true }];
  writeStateFile(e.dataDir, e.projectDir, state);
  const bd = await board(t, e);
  assert.deepEqual((await bd.view(c.id)).workedBy, ['main', 'agent:worker']);
});

// ---------------------------------------------------------------- the done gate

const GATE = /c1 has acceptance criteria: raise a review item with wait_add \(kind review\) and move it to done after the owner approves/;

test('a card with criteria cannot go to done without an approved review', async (t) => {
  const e = setupThreadEnv(t);
  const c = await core.addCard(e.projectDir, { title: 'Gated', criteria: ['it works'] });
  // no review at all
  await rejects(core.updateCard(e.projectDir, c.id, { status: 'done' }), GATE);
  assert.equal(cardOf(e, c.id).status, 'new');
  // a review that is still open
  const first = await review(e, c.id);
  await rejects(core.updateCard(e.projectDir, c.id, { status: 'done' }), GATE);
  // the owner asks for changes
  await core.answerWait(e.projectDir, c.id, first.id, { verdict: 'changes' });
  await rejects(core.updateCard(e.projectDir, c.id, { status: 'done' }), GATE);
  // a review withdrawn is no approval
  const second = await review(e, c.id);
  await core.closeWait(e.projectDir, second.id, { withdraw: true });
  await rejects(core.updateCard(e.projectDir, c.id, { status: 'done' }), GATE);
  // a review the owner answered in the chat holds no verdict
  const third = await review(e, c.id);
  await core.closeWait(e.projectDir, third.id, { answeredInChat: 'yes, looks good' });
  await rejects(core.updateCard(e.projectDir, c.id, { status: 'done' }), GATE);
  // any other stage is free
  await core.updateCard(e.projectDir, c.id, { status: 'review' });
  // approved
  await review(e, c.id, 'approve');
  const moved = await core.updateCard(e.projectDir, c.id, { status: 'done' });
  assert.equal(moved.status, 'done');
});

test('the latest review counts: an approval is undone by a later request for changes or an open review', async (t) => {
  const e = setupThreadEnv(t);
  const c = await core.addCard(e.projectDir, { title: 'Gated', criteria: ['a'] });
  await review(e, c.id, 'approve');
  const again = await review(e, c.id);
  await rejects(core.updateCard(e.projectDir, c.id, { status: 'done' }), GATE, 'an open review after the approval');
  await core.answerWait(e.projectDir, c.id, again.id, { verdict: 'changes' });
  await rejects(core.updateCard(e.projectDir, c.id, { status: 'done' }), GATE, 'the latest asked for changes');
  await review(e, c.id, 'approve');
  assert.equal((await core.updateCard(e.projectDir, c.id, { status: 'done' })).status, 'done');
  // the review's time decides, not its place in the list
  const state = core.readState(e.projectDir);
  const waits = state.cards[0].waits;
  waits.find((w) => w.id === 'c1.w2').answeredAt = '2099-01-01T00:00:00.000Z';
  writeStateFile(e.dataDir, e.projectDir, state);
  assert.equal(core.reviewApproved(cardOf(e, c.id)), false);
});

test('the gate uses the project\'s done stage, covers a card made in it, and leaves other cards alone', async (t) => {
  const e = setupThreadEnv(t);
  await core.saveConfig(e.projectDir, 'project', { stages: [{ id: 'todo', label: 'To do' }, { id: 'doing', label: 'Doing' }, { id: 'shipped', label: 'Shipped' }], roles: { start: 'todo', working: 'doing', review: 'doing', blocked: 'doing', done: 'shipped' } });
  const c = await core.addCard(e.projectDir, { title: 'Gated', criteria: ['a'] });
  await rejects(core.updateCard(e.projectDir, c.id, { status: 'shipped' }), /move it to shipped after the owner approves/);
  await core.updateCard(e.projectDir, c.id, { status: 'doing' });
  await rejects(core.addCard(e.projectDir, { title: 'Born done', status: 'shipped', criteria: ['a'] }), /has acceptance criteria/);
  assert.equal(core.readState(e.projectDir).cards.length, 1);
  // criteria given in the same call count
  await rejects(core.updateCard(e.projectDir, 'c1', { status: 'shipped', criteria: ['a', 'new one'] }), /has acceptance criteria/);
  const plain = await core.addCard(e.projectDir, { title: 'Plain' });
  await rejects(core.updateCard(e.projectDir, plain.id, { status: 'shipped', criteria: ['new one'] }), /has acceptance criteria/);
  // a card without criteria moves freely
  const free = await core.addCard(e.projectDir, { title: 'Free' });
  assert.equal((await core.updateCard(e.projectDir, free.id, { status: 'shipped' })).status, 'shipped');
  // removing the criteria in the same call is not a way round the gate: Claude may not remove them at all
  await rejects(core.updateCard(e.projectDir, c.id, { status: 'shipped', criteria: [] }), /can only be changed by the owner/);
  assert.equal(cardOf(e, c.id).status, 'doing');
  assert.deepEqual(cardOf(e, c.id).criteria, ['a']);
  // an idea has criteria too
  const idea = await core.addCard(e.projectDir, { title: 'Idea', kind: 'idea', criteria: ['x'] });
  await rejects(core.updateCard(e.projectDir, idea.id, { status: 'shipped' }), /has acceptance criteria/);
});

test('the board\'s PATCH is never gated, and shows the card as not verified', async (t) => {
  const e = setupThreadEnv(t);
  const gated = await core.addCard(e.projectDir, { title: 'Gated', criteria: ['a'] });
  const plain = await core.addCard(e.projectDir, { title: 'Plain' });
  const bd = await board(t, e);
  let r = await bd.patch(gated.id, { status: 'done' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'done');
  assert.equal(r.body.verified, false);
  assert.equal(cardOf(e, gated.id).status, 'done');
  assert.equal('verified' in cardOf(e, gated.id), false, 'the mark is never stored');
  assert.equal('verified' in (await bd.view(plain.id)), false);
  await bd.patch(plain.id, { status: 'done' });
  assert.equal('verified' in (await bd.view(plain.id)), false, 'no criteria: nothing to verify');
  // not in the done stage: no mark
  r = await bd.patch(gated.id, { status: 'review' });
  assert.equal('verified' in r.body, false);
  // approved: no mark
  await bd.patch(gated.id, { status: 'done' });
  await review(e, gated.id, 'approve');
  assert.equal('verified' in (await bd.view(gated.id)), false);
  // approval undone by a later review
  await review(e, gated.id, 'changes');
  assert.equal((await bd.view(gated.id)).verified, false);
  // a milestone (even one that someone gave criteria by hand) and a thread card without criteria are not marked
  const state = core.readState(e.projectDir);
  state.cards.push(threadCard({ id: 'c3', status: 'done' }, { runState: 'ended' }));
  state.cards.push({ ...task('c4', { kind: 'milestone', status: 'done' }), criteria: ['hand-written'] });
  state.seq = 4;
  writeStateFile(e.dataDir, e.projectDir, state);
  assert.equal((await bd.view('c3')).status, 'done');
  assert.equal('verified' in (await bd.view('c3')), false);
  assert.equal((await bd.view('c4')).kind, 'milestone');
  assert.equal('verified' in (await bd.view('c4')), false);
});

// ---------------------------------------------------------------- the gate holds (fixes after review)

const tick = () => new Promise((r) => setTimeout(r, 5));   // timestamps are in ms; a step that must come after another waits one out

test('Claude can add lines to a card\'s criteria but not remove, change or reorder them; the board can', async (t) => {
  const e = setupThreadEnv(t);
  const c = await core.addCard(e.projectDir, { title: 'Gated', criteria: ['a', 'b'] });
  const REFUSED = /c1's acceptance criteria can only be changed by the owner on the board; you may add lines/;
  for (const criteria of [[], '', null, ['a'], ['b', 'a'], ['a', 'x'], ['x', 'a', 'b'], ['b']]) {
    await rejects(core.updateCard(e.projectDir, c.id, { criteria }), REFUSED, JSON.stringify(criteria));
  }
  await rejects(core.updateCard(e.projectDir, c.id, { status: 'review', criteria: [] }), REFUSED);
  assert.deepEqual(cardOf(e, c.id).criteria, ['a', 'b'], 'refused edits changed nothing');
  assert.equal(cardOf(e, c.id).status, 'new');
  // the same lines, or more lines at the end, are fine
  await core.updateCard(e.projectDir, c.id, { criteria: [' a ', 'b'] });
  const grown = await core.updateCard(e.projectDir, c.id, { criteria: ['a', 'b', 'c'] });
  assert.deepEqual(grown.criteria, ['a', 'b', 'c']);
  // through the tool
  const mc = mcp(t, e);
  await mc.init();
  const r = await mc.call('board_update', { id: c.id, criteria: [] });
  assert.equal(r.isError, true);
  assert.match(r.text, REFUSED);
  assert.equal((await mc.call('board_update', { id: c.id, criteria: ['a', 'b', 'c', 'd'] })).isError, false);
  // a card that has none can be given some, and can be given none
  const bare = await core.addCard(e.projectDir, { title: 'Bare' });
  await core.updateCard(e.projectDir, bare.id, { criteria: [] });
  assert.deepEqual((await core.updateCard(e.projectDir, bare.id, { criteria: ['x'] })).criteria, ['x']);
  // the board's PATCH changes them freely
  const bd = await board(t, e);
  let p = await bd.patch(c.id, { criteria: ['only this'] });
  assert.equal(p.status, 200);
  assert.deepEqual(p.body.criteria, ['only this']);
  p = await bd.patch(c.id, { criteria: null });
  assert.equal(p.status, 200);
  assert.equal('criteria' in p.body, false);
});

test('Claude cannot remove a card with criteria that is not done or approved; the board can, and so can Claude when it is done or approved', async (t) => {
  const e = setupThreadEnv(t);
  const open = await core.addCard(e.projectDir, { title: 'Open', criteria: ['a'] });
  const REFUSED = /c1 has acceptance criteria and is not done or approved, so only the owner can remove it, on the board/;
  await rejects(core.removeCard(e.projectDir, open.id), REFUSED);
  const mc = mcp(t, e);
  await mc.init();
  const r = await mc.call('board_remove', { id: open.id });
  assert.equal(r.isError, true);
  assert.match(r.text, REFUSED);
  assert.ok(cardOf(e, open.id), 'still there');
  // the board's DELETE is the owner's
  const bd = await board(t, e);
  const gone = await core.addCard(e.projectDir, { title: 'Owner removes', criteria: ['a'] });
  assert.equal((await bd.api('DELETE', `/api/cards/${gone.id}`)).status, 200);
  assert.equal(cardOf(e, gone.id), undefined);
  // done (moved by the board), or approved
  const done = await core.addCard(e.projectDir, { title: 'Done', criteria: ['a'] });
  await core.updateCard(e.projectDir, done.id, { status: 'done' }, { source: 'user' });
  assert.equal((await mc.call('board_remove', { id: done.id })).isError, false);
  const approved = await core.addCard(e.projectDir, { title: 'Approved', criteria: ['a'] });
  await review(e, approved.id, 'approve');
  assert.equal((await mc.call('board_remove', { id: approved.id })).isError, false);
  // no criteria: free
  const plain = await core.addCard(e.projectDir, { title: 'Plain' });
  assert.equal((await mc.call('board_remove', { id: plain.id })).isError, false);
  assert.deepEqual(core.readState(e.projectDir).cards.map((c) => c.id), [open.id]);
});

test('reopening a card resets its approval: only reviews answered after it left done count', async (t) => {
  const e = setupThreadEnv(t);
  const c = await core.addCard(e.projectDir, { title: 'Gated', criteria: ['a'] });
  await review(e, c.id, 'approve');
  await tick();
  await core.updateCard(e.projectDir, c.id, { status: 'done' });
  await tick();
  assert.equal(core.reviewApproved(cardOf(e, c.id), 'done'), true);
  await core.updateCard(e.projectDir, c.id, { status: 'review' });   // reopened
  await tick();
  assert.equal(core.reviewApproved(cardOf(e, c.id), 'done'), false, 'the old approval is spent');
  assert.equal(core.reviewApproved(cardOf(e, c.id)), true, 'without a done stage nothing is spent');
  await rejects(core.updateCard(e.projectDir, c.id, { status: 'done' }), GATE);
  // the board shows it as not verified when it puts the card back
  const bd = await board(t, e);
  assert.equal((await bd.patch(c.id, { status: 'done' })).body.verified, false);
  await bd.patch(c.id, { status: 'review' });   // reopened by the owner
  await tick();
  await review(e, c.id, 'approve');
  assert.equal((await core.updateCard(e.projectDir, c.id, { status: 'done' })).status, 'done', 'the gate lets the new approval through');
  const after = await bd.view(c.id);
  assert.equal(after.status, 'done');
  assert.equal('verified' in after, false, 'and the view of the done card is not marked');
  // a card that was never in done has all its reviews counted, and an edit of the criteria does not undo an approval
  const fresh = await core.addCard(e.projectDir, { title: 'Fresh', criteria: ['a'] });
  await review(e, fresh.id, 'approve');
  await core.updateCard(e.projectDir, fresh.id, { criteria: ['a', 'b'] });
  assert.equal((await core.updateCard(e.projectDir, fresh.id, { status: 'done' })).status, 'done');
});

test('reopening uses the project\'s done stage', async (t) => {
  const e = setupThreadEnv(t);
  await core.saveConfig(e.projectDir, 'project', { stages: [{ id: 'todo', label: 'To do' }, { id: 'doing', label: 'Doing' }, { id: 'qa', label: 'QA' }, { id: 'shipped', label: 'Shipped' }], roles: { start: 'todo', working: 'doing', review: 'doing', blocked: 'doing', done: 'shipped' } });
  const c = await core.addCard(e.projectDir, { title: 'Gated', criteria: ['a'] });
  await review(e, c.id, 'approve');
  await tick();
  // leaving a stage before the done role (a stage that is not finished) does not reset anything
  await core.updateCard(e.projectDir, c.id, { status: 'qa' });
  await core.updateCard(e.projectDir, c.id, { status: 'doing' });
  await tick();
  assert.equal(core.reviewApproved(cardOf(e, c.id), 'shipped'), true);
  await core.updateCard(e.projectDir, c.id, { status: 'shipped' });
  await tick();
  await core.updateCard(e.projectDir, c.id, { status: 'doing' });
  await tick();
  await rejects(core.updateCard(e.projectDir, c.id, { status: 'shipped' }), /move it to shipped after the owner approves/);
});

test('the latest closed review decides, and a withdrawn one is closed', async (t) => {
  const e = setupThreadEnv(t);
  const c = await core.addCard(e.projectDir, { title: 'Gated', criteria: ['a'] });
  await review(e, c.id, 'approve');
  await tick();
  const w2 = await review(e, c.id);
  await rejects(core.updateCard(e.projectDir, c.id, { status: 'done' }), GATE, 'w2 is open');
  await tick();
  await core.closeWait(e.projectDir, w2.id, { withdraw: true });
  assert.equal(core.reviewApproved(cardOf(e, c.id), 'done'), false, 'approve w1, open w2, withdraw w2: not approved');
  await rejects(core.updateCard(e.projectDir, c.id, { status: 'done' }), GATE);
  // a new approval after the withdrawn one counts again
  await tick();
  await review(e, c.id, 'approve');
  assert.equal(core.reviewApproved(cardOf(e, c.id), 'done'), true);
  // a withdrawn review older than the approval does not undo it
  const d = await core.addCard(e.projectDir, { title: 'Other', criteria: ['a'] });
  const first = await review(e, d.id);
  await core.closeWait(e.projectDir, first.id, { withdraw: true });
  await tick();
  await review(e, d.id, 'approve');
  assert.equal(core.reviewApproved(cardOf(e, d.id), 'done'), true);
});

test('a card with criteria or blockers cannot be started as a thread', async (t) => {
  const e = setupThreadEnv(t);
  const blocker = await core.addCard(e.projectDir, { title: 'Blocker' });
  const withCriteria = await core.addCard(e.projectDir, { title: 'Criteria', criteria: ['a'] });
  const blocked = await core.addCard(e.projectDir, { title: 'Blocked', blockedBy: [blocker.id] });
  const both = await core.addCard(e.projectDir, { title: 'Both', criteria: ['a'], blockedBy: [blocker.id] });
  const plain = await core.addCard(e.projectDir, { title: 'Plain' });
  const opts = { sessionId: PARENT_SESSION };
  await rejects(core.startThreadFromCard(e.projectDir, withCriteria.id, opts), /A card with acceptance criteria or a Blocked by list cannot be started as a thread; clear them first \(c2 has acceptance criteria\)/);
  await rejects(core.startThreadFromCard(e.projectDir, blocked.id, opts), /A card with acceptance criteria or a Blocked by list cannot be started as a thread; clear them first \(c3 has a Blocked by list\)/);
  await rejects(core.startThreadFromCard(e.projectDir, both.id, opts), /clear them first \(c4 has acceptance criteria and a Blocked by list\)/);
  // the board's "Start as thread" (POST /cards/<id>/start)
  const bd = await board(t, e);
  for (const id of [withCriteria.id, blocked.id, both.id]) {
    const r = await bd.api('POST', `/api/cards/${id}/start`, opts);
    assert.equal(r.status, 400, id);
    assert.match(r.body.error, /cannot be started as a thread; clear them first/);
    assert.equal(cardOf(e, id).kind, 'task', 'a refused start leaves the card alone');
  }
  assert.equal(e.readLog().length, 0, 'nothing was launched');
  // a blocker that is gone no longer counts
  await core.removeCard(e.projectDir, blocker.id);
  assert.equal((await bd.api('POST', `/api/cards/${blocked.id}/start`, opts)).status, 200);
  // no tool starts a card as a thread: thread_start makes a new card and takes no card id
  const mc = mcp(t, e);
  await mc.init();
  const props = (await mc.request('tools/list', {})).result.tools.find((x) => x.name === 'thread_start').inputSchema.properties;
  assert.equal('card' in props || 'id' in props, false);
  assert.equal(cardOf(e, plain.id).kind, 'task');
});

test('PATCH takes blockedBy, and refuses keys it does not know', async (t) => {
  const e = setupThreadEnv(t);
  await core.addCard(e.projectDir, { title: 'A' });
  await core.addCard(e.projectDir, { title: 'B' });
  await core.addCard(e.projectDir, { title: 'M', kind: 'milestone' });
  const bd = await board(t, e);
  // everything the board page sends, and the card fields
  let r = await bd.patch('c1', { title: 'A2', note: 'n', status: 'review', parent: 'c3' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await bd.patch('c1', { parent: null });
  assert.equal(r.status, 200);
  r = await bd.patch('c1', { blockedBy: ['c2'], type: 'bug', priority: 'low', labels: ['x'], criteria: ['y'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.blockedBy, ['c2']);
  // unknown keys are 400, and nothing is written
  const before = JSON.stringify(cardOf(e, 'c1'));
  for (const body of [{ blocked_by: ['c2'] }, { lane: 'code-codex' }, { worker: 'main' }, { id: 'c9' }, { title: 'T', whatever: 1 }]) {
    r = await bd.patch('c1', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, /unknown key/);
  }
  assert.match((await bd.patch('c1', { blocked_by: ['c2'] })).body.error, /the key is blockedBy/);
  assert.equal(JSON.stringify(cardOf(e, 'c1')), before);
  // a wrong value names the key that was sent
  r = await bd.patch('c1', { blockedBy: 7 });
  assert.match(r.body.error, /^blockedBy must be a list/);
  r = await bd.patch('c1', { blockedBy: ['four'] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /^blockedBy takes card ids/);
  r = await bd.patch('c1', { blockedBy: ['c77'] });
  assert.match(r.body.error, /^blockedBy: card not found: c77/);
  r = await bd.patch('c1', { blockedBy: Array.from({ length: 11 }, (_, i) => `c${i + 1}`) });
  assert.match(r.body.error, /^blockedBy has too many entries/);
  assert.equal(JSON.stringify(cardOf(e, 'c1')), before);
});

test('a board_update that changes only the worker is noted in the history as "worked"', async (t) => {
  const e = setupThreadEnv(t);
  const c = await core.addCard(e.projectDir, { title: 'Work' });
  const updatedAt = cardOf(e, c.id).updatedAt;
  await core.updateCard(e.projectDir, c.id, { title: 'Work' });   // no change, no worker: no entry
  assert.equal(cardOf(e, c.id).history.length, 1);
  await tick();
  const mc = mcp(t, e);
  await mc.init();
  const r = await mc.call('board_update', { id: c.id, worker: 'agent:worker' });
  assert.equal(r.isError, false, r.text);
  const last = cardOf(e, c.id).history.at(-1);
  assert.deepEqual([last.type, last.by, last.worker], ['worked', 'claude', 'agent:worker']);
  assert.equal(cardOf(e, c.id).updatedAt, updatedAt, 'the card itself is not edited');
  assert.equal(cardOf(e, c.id).seenByClaude, true);
  assert.deepEqual(core.workedBy(cardOf(e, c.id)), ['agent:worker']);
  // the same worker again, while the latest entry already names them: no new entry
  await mc.call('board_update', { id: c.id, worker: 'agent:worker' });
  await core.updateCard(e.projectDir, c.id, { worker: 'agent:worker' });
  assert.equal(cardOf(e, c.id).history.length, 2, 'one created and one worked');
  // another worker is noted, and so is the first one again after that
  await core.updateCard(e.projectDir, c.id, { worker: 'main' });
  await core.updateCard(e.projectDir, c.id, { worker: 'agent:worker' });
  assert.deepEqual(cardOf(e, c.id).history.slice(1).map((x) => x.worker), ['agent:worker', 'main', 'agent:worker']);
  // with another change, the usual entries carry the worker and there is no extra one
  const entries = cardOf(e, c.id).history.length;
  await core.updateCard(e.projectDir, c.id, { note: 'n', worker: 'main' });
  assert.deepEqual(cardOf(e, c.id).history.slice(entries).map((x) => [x.type, x.worker]), [['edited', 'main']]);
  assert.equal((await mc.call('board_update', { id: c.id, worker: 'nobody' })).isError, true);
  // the board never records a worker
  const bd = await board(t, e);
  await bd.patch(c.id, { note: 'n2' });
  assert.equal('worker' in cardOf(e, c.id).history.at(-1), false);
});

test('the tools and the skills tell Claude to send worker', async (t) => {
  const e = setupThreadEnv(t);
  const mc = mcp(t, e);
  await mc.init();
  const tools = (await mc.request('tools/list', {})).result.tools;
  for (const name of ['board_add', 'board_update', 'wait_add']) {
    const d = tools.find((x) => x.name === name).description;
    assert.match(d, /Pass worker: "main" from the main session, "agent:<type>" from a sub-agent, "thread:<id>" from a side thread, or "lane:<name>" from a lane run\./, name);
  }
  for (const skill of ['track', 'add']) {
    assert.match(readFileSync(path.join(TEST_DIR, '..', 'skills', skill, 'SKILL.md'), 'utf8'), /`worker`[^\n]*`main`[^\n]*`agent:<type>`[^\n]*`thread:<id>`[^\n]*`lane:<name>`/, skill);
  }
});

test('workedBy keeps the long agent and lane names of runs and threads, cut to fit', () => {
  const clipped = `${'a'.repeat(59)}…`;   // runs.mjs keeps an agent type to 60 characters, ending in "…"
  const out = core.workedBy({ runs: [{ n: 1, agentType: clipped, startedAt: '2026-10-14T03:00:00.000Z' }] });
  assert.equal(out.length, 1);
  assert.match(out[0], /^agent:a+$/);
  assert.ok(out[0].length <= core.MAX_WORKER);
  assert.ok(core.isWorker(out[0]));
  const lane = core.workedBy(threadCard({}, { lane: { name: 'l'.repeat(80), implementer: 'codex' } }));
  assert.equal(lane.length, 1);
  assert.ok(lane[0].startsWith('lane:l') && lane[0].length === core.MAX_WORKER);
  const agent = core.workedBy(threadCard({}, { agent: 'b'.repeat(70) }));
  assert.ok(agent[0].startsWith('agent:b') && agent[0].length === core.MAX_WORKER);
  // two runs of the same long agent are one worker; a name that cannot be a worker is still dropped
  assert.equal(core.workedBy({ runs: [{ agentType: clipped }, { agentType: clipped }, { agentType: 'two words' }] }).length, 1);
});

// ---------------------------------------------------------------- the board's PATCH and listing

test('PATCH takes the fields, checks them and removes one with null', async (t) => {
  const e = setupThreadEnv(t);
  await core.addCard(e.projectDir, { title: 'A' });
  await core.addCard(e.projectDir, { title: 'B' });
  const m = await core.addCard(e.projectDir, { title: 'M', kind: 'milestone' });
  const bd = await board(t, e);
  let r = await bd.patch('c1', { type: 'bug', priority: 'high', labels: ['Ui', 'api'], blockedBy: ['c2'], criteria: ['works'] });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.type, r.body.priority, r.body.labels, r.body.blockedBy, r.body.criteria], ['bug', 'high', ['ui', 'api'], ['c2'], ['works']]);
  assert.equal(r.body.seenByClaude, false, 'a change by the user is new to Claude');
  assert.equal(cardOf(e, 'c1').history.at(-1).by, 'user');
  assert.equal('worker' in cardOf(e, 'c1').history.at(-1), false);
  for (const [body, re] of [
    [{ type: 'epic' }, /type must be one of/],
    [{ priority: 'urgent' }, /priority must be one of/],
    [{ labels: 'ui' }, /labels must be a list/],
    [{ labels: [1] }, /each label must be 1 to 24 characters/],
    [{ blockedBy: ['c1'] }, /cannot be blocked by itself/],
    [{ blockedBy: [m.id] }, /is a milestone/],
    [{ blockedBy: ['c77'] }, /card not found/],
    [{ criteria: ['x'.repeat(201)] }, /each criterion must be 1 to 200 characters/],
  ]) {
    r = await bd.patch('c1', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, re);
  }
  r = await bd.patch('c1', { type: 7 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /type must be a string/);
  r = await bd.patch('c1', { criteria: 7 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /criteria must be a list/);
  r = await bd.patch(m.id, { criteria: ['x'] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /a milestone cannot have criteria/);
  assert.deepEqual(cardOf(e, 'c1').labels, ['ui', 'api'], 'refused edits changed nothing');
  r = await bd.patch('c1', { type: null, priority: '', labels: null, blockedBy: [], criteria: null });
  assert.equal(r.status, 200);
  for (const k of ['type', 'priority', 'labels', 'blockedBy', 'criteria']) assert.equal(k in r.body, false, k);
});

test('PATCH with the fields still needs the token and a local origin', async (t) => {
  const e = setupThreadEnv(t);
  await core.addCard(e.projectDir, { title: 'A' });
  const bd = await board(t, e);
  const body = JSON.stringify({ type: 'bug' });
  const send = (headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: bd.port, method: 'PATCH', path: '/api/cards/c1', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers }, agent: false }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(await send({ 'x-thread-token': TOKEN, Origin: 'https://evil.example.com' }), 403);
  assert.equal(await send({}), 401);
  assert.equal(await send({ 'x-thread-token': TOKEN, Host: 'evil.example.com' }), 403);
  assert.equal('type' in cardOf(e, 'c1'), false);
  assert.equal(await send({ 'x-thread-token': TOKEN, Origin: `http://127.0.0.1:${bd.port}` }), 200);
  assert.equal(cardOf(e, 'c1').type, 'bug');
});

test('POST /api/cards takes the fields, checks them like PATCH, and leaves a card without them as before', async (t) => {
  const e = setupThreadEnv(t);
  const m = await core.addCard(e.projectDir, { title: 'M', kind: 'milestone' });
  await core.addCard(e.projectDir, { title: 'B' });
  const bd = await board(t, e);
  let r = await bd.api('POST', '/api/cards', { title: 'Crash on save', type: 'Bug', priority: 'high', labels: ['Ui', 'api'], blockedBy: ['c2'], criteria: ['it saves'] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.type, r.body.priority, r.body.labels, r.body.blockedBy, r.body.criteria], ['bug', 'high', ['ui', 'api'], ['c2'], ['it saves']]);
  assert.equal(cardOf(e, r.body.id).source, 'user');
  // defaults are not stored, and a card sent without the fields has none
  r = await bd.api('POST', '/api/cards', { title: 'Plain', type: 'task', priority: 'normal', labels: [] });
  assert.equal(r.status, 201);
  for (const k of ['type', 'priority', 'labels', 'blockedBy', 'criteria']) assert.equal(k in r.body, false, k);
  r = await bd.api('POST', '/api/cards', { title: 'Old form', status: 'new', kind: 'idea' });
  assert.equal(r.status, 201);
  // the same checks as PATCH, with the key the page sent in the message; a refused card is not created
  const count = core.readState(e.projectDir).cards.length;
  for (const [body, re] of [
    [{ type: 'epic' }, /type must be one of/],
    [{ priority: 7 }, /priority must be a string/],
    [{ labels: 'ui' }, /labels must be a list/],
    [{ labels: ['x'.repeat(25)] }, /each label must be 1 to 24 characters/],
    [{ blockedBy: [m.id] }, /^blockedBy: .*is a milestone/],
    [{ blockedBy: ['c77'] }, /^blockedBy: card not found: c77/],
    [{ kind: 'milestone', type: 'bug' }, /a milestone cannot have type/],
  ]) {
    r = await bd.api('POST', '/api/cards', { title: 'X', ...body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, re, JSON.stringify(body));
  }
  assert.equal(core.readState(e.projectDir).cards.length, count);
  // keys the page does not send are refused, as PATCH refuses them; every key the page's New panel sends is accepted
  for (const body of [{ blocked_by: ['c2'] }, { lane: 'code-codex' }, { worker: 'main' }, { id: 'c9' }, { source: 'claude' }, { whatever: 1 }]) {
    r = await bd.api('POST', '/api/cards', { title: 'X', ...body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, /unknown key/);
  }
  assert.match((await bd.api('POST', '/api/cards', { title: 'X', blocked_by: ['c2'] })).body.error, /the key is blockedBy/);
  assert.equal(core.readState(e.projectDir).cards.length, count, 'nothing was created');
  r = await bd.api('POST', '/api/cards', { title: 'Everything', note: 'n', status: 'new', kind: 'task', parent: m.id, type: 'bug', priority: 'low', labels: ['a'], blockedBy: ['c2'], criteria: ['x'] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
});

test('/api/projects counts the open and done cards and the waiting items', async (t) => {
  const e = setupThreadEnv(t);
  await core.saveConfig(e.projectDir, 'project', { stages: [{ id: 'todo', label: 'To do' }, { id: 'shipped', label: 'Shipped' }], roles: { start: 'todo', working: 'todo', review: 'todo', blocked: 'todo', done: 'shipped' } });
  await core.addCard(e.projectDir, { title: 'Open 1' });
  await core.addCard(e.projectDir, { title: 'Open 2', kind: 'idea' });
  await core.addCard(e.projectDir, { title: 'Done 1', status: 'shipped' });
  await core.addCard(e.projectDir, { title: 'A milestone', kind: 'milestone' });
  await core.addCard(e.projectDir, { title: 'Another', kind: 'milestone' });
  await core.addWait(e.projectDir, { card: 'c1', kind: 'todo', text: 'a', sessionId: PARENT_SESSION });
  await core.addWait(e.projectDir, { card: 'c2', kind: 'question', text: 'b', sessionId: PARENT_SESSION });
  const state = core.readState(e.projectDir);
  state.cards.push(threadCard({ id: 'c6', status: 'todo' }, { runState: 'running', pid: 1 }), threadCard({ id: 'c7' }, { runState: 'ended' }));
  state.seq = 7;
  writeStateFile(e.dataDir, e.projectDir, state);
  const bd = await board(t, e);
  const { body } = await bd.api('GET', '/api/projects');
  const mine = body.projects.find((p) => p.projectDir === e.projectDir);
  assert.equal(mine.cards, 7);
  assert.equal(mine.open, 3, 'two cards and a running thread');
  assert.equal(mine.done, 2, 'a card and an ended thread; milestones are not counted');
  assert.equal(mine.waiting, 2);
  // a project with no state yet is listed with zero counts
  const fresh = setupThreadEnv(t);
  const b2 = await startBoardServer(fresh.projectDir, { port: 0, token: TOKEN });
  t.after(() => new Promise((r) => { b2.server.closeAllConnections?.(); b2.server.close(() => r()); }));
  const res = await (await fetch(`http://127.0.0.1:${b2.port}/api/projects`, { headers: { 'x-thread-token': TOKEN } })).json();
  const home = res.projects.find((p) => p.key === res.home);
  assert.deepEqual([home.open, home.done, home.waiting], [0, 0, 0]);
});

// ---------------------------------------------------------------- the MCP tools

test('board_add and board_update take the fields and the worker; board_list marks them', async (t) => {
  const e = setupThreadEnv(t);
  const c = mcp(t, e);
  await c.init();
  const tools = (await c.request('tools/list', {})).result.tools;
  for (const name of ['board_add', 'board_update']) {
    const props = tools.find((x) => x.name === name).inputSchema.properties;
    for (const k of ['type', 'priority', 'labels', 'blocked_by', 'criteria', 'worker']) assert.ok(props[k], `${name} takes ${k}`);
  }
  assert.ok(tools.find((x) => x.name === 'wait_add').inputSchema.properties.worker);

  await c.call('board_add', { title: 'The blocker' });
  const added = await c.call('board_add', { title: 'Fix the login', type: 'bug', priority: 'high', labels: ['Auth', 'ui'], blocked_by: ['c1'], criteria: ['logs in', 'logs out'], worker: 'main' });
  assert.equal(added.isError, false, added.text);
  assert.deepEqual([cardOf(e, 'c2').type, cardOf(e, 'c2').priority, cardOf(e, 'c2').labels, cardOf(e, 'c2').blockedBy, cardOf(e, 'c2').criteria], ['bug', 'high', ['auth', 'ui'], ['c1'], ['logs in', 'logs out']]);
  assert.equal(cardOf(e, 'c2').history[0].worker, 'main');

  let list = (await c.call('board_list')).text;
  assert.match(list, /^- c1 \[task\] The blocker$/m, 'a plain card has no marks');
  assert.match(list, /^- c2 \[task\] Fix the login \(bug\) !high #auth #ui \{blocked by c1\} \[criteria 2\]$/m);

  await c.call('board_add', { title: 'Low one', priority: 'low' });
  assert.match((await c.call('board_list')).text, /^- c3 \[task\] Low one !low$/m);

  // the gate, through the tool
  const refused = await c.call('board_update', { id: 'c2', status: 'done' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /c2 has acceptance criteria: raise a review item with wait_add \(kind review\) and move it to done after the owner approves/);
  const wait = await c.call('wait_add', { card: 'c2', kind: 'review', text: 'Check the login', session_id: PARENT_SESSION, worker: 'agent:worker' });
  assert.equal(wait.isError, false, wait.text);
  assert.equal(cardOf(e, 'c2').history.at(-1).worker, 'agent:worker');
  assert.equal((await c.call('board_update', { id: 'c2', status: 'done' })).isError, true, 'the review is still open');
  await core.answerWait(e.projectDir, 'c2', 'c2.w1', { verdict: 'approve' });
  const moved = await c.call('board_update', { id: 'c2', status: 'done', worker: 'agent:worker' });
  assert.equal(moved.isError, false, moved.text);
  assert.deepEqual(cardOf(e, 'c2').history.slice(-1)[0].worker, 'agent:worker');
  assert.match((await c.call('board_list')).text, /^- c2 \[task\] Fix the login \(bug\) !high #auth #ui \{blocked by c1\} \[criteria 2\]$/m, 'approved: not marked');

  // a card moved there by the board, or an older version, is marked
  await core.updateCard(e.projectDir, 'c3', { criteria: ['x'] });
  await core.updateCard(e.projectDir, 'c3', { status: 'done' }, { source: 'user' });
  assert.match((await c.call('board_list')).text, /^- c3 \[task\] Low one !low \[criteria 1\] \(done, not verified\)( \(new from user\))?$/m);

  // removing, a card that is gone, and the checks
  await core.updateCard(e.projectDir, 'c2', { criteria: [] }, { source: 'user' });   // only the board can remove criteria
  await c.call('board_update', { id: 'c2', type: '', priority: '', labels: [], blocked_by: [] });
  assert.match((await c.call('board_list')).text, /^- c2 \[task\] Fix the login( \(new from user\))?$/m);
  await core.removeCard(e.projectDir, 'c1');
  await c.call('board_update', { id: 'c3', blocked_by: ['c2'] });
  await core.removeCard(e.projectDir, 'c2');
  assert.match((await c.call('board_list')).text, /^- c3 \[task\] Low one !low \[criteria 1\] \(done, not verified\)( \(new from user\))?$/m, 'a blocker that is gone is not shown');
  for (const args of [{ type: 'epic' }, { priority: 'urgent' }, { labels: 'x' }, { blocked_by: ['c88'] }, { criteria: [''] }, { worker: 'nobody' }]) {
    const r = await c.call('board_update', { id: 'c3', ...args });
    assert.equal(r.isError, true, JSON.stringify(args));
  }
  const ms = await c.call('board_add', { title: 'A milestone', kind: 'milestone', labels: ['x'] });
  assert.equal(ms.isError, true);
  assert.match(ms.text, /a milestone cannot have labels/);
});

test('board_list puts the marks in order, after the title and before the milestone', async (t) => {
  const e = setupThreadEnv(t);
  const c = mcp(t, e);
  await c.init();
  await c.call('board_add', { title: 'Shop', kind: 'milestone' });
  await c.call('board_add', { title: 'One', parent: 'c1', type: 'bug', priority: 'low', labels: ['a', 'b'], criteria: ['x'] });
  await c.call('board_add', { title: 'Two', parent: 'c1', blocked_by: ['c2'] });
  const list = (await c.call('board_list')).text;
  assert.match(list, /^- c2 \[task\] One \(bug\) !low #a #b \[criteria 1\] \[Shop\]/m);
  assert.match(list, /^- c3 \[task\] Two \{blocked by c2\} \[Shop\]$/m);
});

test('a reopened card stays reopened after the history has dropped the move (the card keeps leftDoneAt)', async (t) => {
  const e = setupThreadEnv(t);
  const c = await core.addCard(e.projectDir, { title: 'Gated', criteria: ['a'] });
  await review(e, c.id, 'approve');
  await tick();
  await core.updateCard(e.projectDir, c.id, { status: 'done' });
  assert.equal('leftDoneAt' in cardOf(e, c.id), false, 'nothing is stored before the card leaves done');
  await tick();
  const bd = await board(t, e);
  await bd.patch(c.id, { status: 'review' });   // the owner reopens it, on the board
  const left = cardOf(e, c.id).leftDoneAt;
  assert.match(left, /^\d{4}-\d\d-\d\dT/);
  assert.equal(cardOf(e, c.id).history.at(-1).type, 'moved');
  await tick();
  // more than the history keeps: other workers and edits push the move out of it
  for (let i = 0; i < core.MAX_HISTORY + 5; i += 1) {
    await core.updateCard(e.projectDir, c.id, { note: `edit ${i}`, worker: i % 2 ? 'main' : 'agent:worker' });
  }
  const kept = cardOf(e, c.id);
  assert.equal(kept.history.length, core.MAX_HISTORY);
  assert.equal(kept.history.some((h) => h.type === 'moved' && h.from === 'done'), false, 'the move is no longer in the history');
  assert.equal(kept.leftDoneAt, left, 'later edits leave it as it was');
  assert.equal(core.reviewApproved(kept, 'done'), false);
  await rejects(core.updateCard(e.projectDir, c.id, { status: 'done' }), GATE);
  // a new approval after it counts, and moving to done again does not touch the field
  await review(e, c.id, 'approve');
  assert.equal((await core.updateCard(e.projectDir, c.id, { status: 'done' })).status, 'done');
  assert.equal(cardOf(e, c.id).leftDoneAt, left);
  // Claude's own move out of done is recorded too; the later of the field and the history decides
  await tick();
  await core.updateCard(e.projectDir, c.id, { status: 'in_progress' });
  assert.ok(Date.parse(cardOf(e, c.id).leftDoneAt) > Date.parse(left));
  assert.equal(core.leftDoneAt({ leftDoneAt: '2026-10-14T03:00:00.000Z', history: [{ type: 'moved', from: 'done', at: '2026-10-14T04:00:00.000Z' }] }, 'done'), Date.parse('2026-10-14T04:00:00.000Z'));
  assert.equal(core.leftDoneAt({ leftDoneAt: '2026-10-14T05:00:00.000Z', history: [{ type: 'moved', from: 'done', at: '2026-10-14T04:00:00.000Z' }] }, 'done'), Date.parse('2026-10-14T05:00:00.000Z'));
  assert.equal(core.leftDoneAt({ leftDoneAt: 'garbage' }, 'done'), -Infinity);
});

test('an approval and a withdrawal closed in the same millisecond: the withdrawal wins, in either order', () => {
  const at = '2026-10-14T03:00:00.000Z';
  const approve = { id: 'c1.w1', kind: 'review', text: 't', state: 'answered', answer: { verdict: 'approve' }, answeredAt: at };
  const withdrawn = { id: 'c1.w2', kind: 'review', text: 't', state: 'withdrawn', withdrawnAt: at };
  const changes = { id: 'c1.w3', kind: 'review', text: 't', state: 'answered', answer: { verdict: 'changes' }, answeredAt: at };
  const card = (...waits) => ({ id: 'c1', criteria: ['a'], waits });
  assert.equal(core.reviewApproved(card(approve), 'done'), true);
  assert.equal(core.reviewApproved(card(approve, withdrawn), 'done'), false);
  assert.equal(core.reviewApproved(card(withdrawn, approve), 'done'), false);
  assert.equal(core.reviewApproved(card(approve, changes), 'done'), false);
  assert.equal(core.reviewApproved(card(changes, approve), 'done'), false);
  // a later approval still wins
  const later = { ...approve, id: 'c1.w4', answeredAt: '2026-10-14T03:00:00.001Z' };
  assert.equal(core.reviewApproved(card(withdrawn, later), 'done'), true);
});

test('a criterion is one line', async (t) => {
  const e = setupThreadEnv(t);
  for (const criteria of [['two\nlines'], ['carriage\rreturn'], ['ok', 'a\r\nb']]) {
    await rejects(core.addCard(e.projectDir, { title: 'x', criteria }), /a criterion must be one line: it cannot contain a line break/, JSON.stringify(criteria));
  }
  const c = await core.addCard(e.projectDir, { title: 'x', criteria: ['  one line  '] });
  assert.deepEqual(c.criteria, ['one line']);
  await rejects(core.updateCard(e.projectDir, c.id, { criteria: ['one line', 'two\nlines'] }), /must be one line/);
  assert.deepEqual(cardOf(e, c.id).criteria, ['one line']);
  const bd = await board(t, e);
  const r = await bd.patch(c.id, { criteria: ['a\nb'] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /must be one line/);
});

test('cards that 0.11.0 turned into threads while they had criteria: not verified when done, and Claude cannot remove them', async (t) => {
  const e = setupThreadEnv(t);
  const withCriteria = (id, runState, over = {}) => threadCard({ id, status: runState === 'ended' ? 'done' : 'review', criteria: ['it works'], ...over }, { runState });
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [
    withCriteria('c1', 'ended'),
    withCriteria('c2', 'idle'),
    threadCard({ id: 'c3', status: 'done' }, { runState: 'ended' }),
    withCriteria('c4', 'ended', { waits: [{ id: 'c4.w1', kind: 'review', text: 't', state: 'answered', answer: { verdict: 'approve' }, answeredAt: '2026-10-14T03:00:00.000Z', askedBy: PARENT_SESSION, askedAt: '2026-10-14T02:00:00.000Z' }] }),
  ]));
  const bd = await board(t, e);
  assert.equal((await bd.view('c1')).verified, false);
  assert.equal('verified' in (await bd.view('c2')), false, 'not in the done stage');
  assert.equal('verified' in (await bd.view('c3')), false, 'no criteria');
  assert.equal('verified' in (await bd.view('c4')), false, 'approved');
  const mc = mcp(t, e);
  await mc.init();
  const list = (await mc.call('board_list')).text;
  assert.match(list, /^- c1 \[thread:ended\] .*\[criteria 1\] \(done, not verified\)/m);
  assert.match(list, /^- c2 \[thread:idle\] .*\[criteria 1\]$/m);
  assert.doesNotMatch(list, /^- c4 .*not verified/m);
  assert.doesNotMatch(list, /^- c3 .*criteria/m);
  // Claude cannot remove one that is not done or approved
  const REFUSED = /has acceptance criteria and is not done or approved, so only the owner can remove it/;
  const r = await mc.call('board_remove', { id: 'c2' });
  assert.equal(r.isError, true);
  assert.match(r.text, REFUSED);
  assert.ok(cardOf(e, 'c2'));
  assert.equal((await mc.call('board_remove', { id: 'c1' })).isError, false, 'done: removable, as a task is');
  assert.equal((await mc.call('board_remove', { id: 'c3' })).isError, false);
  // the owner's DELETE is not gated; thread_end is not either
  assert.equal((await bd.api('DELETE', '/api/cards/c2')).status, 200);
  assert.equal(cardOf(e, 'c2'), undefined);
});

test('board_list marks only the blockers that are not done yet', async (t) => {
  const e = setupThreadEnv(t);
  const mc = mcp(t, e);
  await mc.init();
  await mc.call('board_add', { title: 'First' });
  await mc.call('board_add', { title: 'Second' });
  await mc.call('board_add', { title: 'Third', blocked_by: ['c1', 'c2'] });
  assert.match((await mc.call('board_list')).text, /^- c3 \[task\] Third \{blocked by c1, c2\}$/m);
  await core.updateCard(e.projectDir, 'c1', { status: 'done' });
  assert.match((await mc.call('board_list')).text, /^- c3 \[task\] Third \{blocked by c2\}$/m, 'a done blocker is not listed');
  await core.updateCard(e.projectDir, 'c2', { status: 'done' });
  assert.match((await mc.call('board_list')).text, /^- c3 \[task\] Third$/m, 'all done: no mark');
  // the field itself is kept
  assert.deepEqual(cardOf(e, 'c3').blockedBy, ['c1', 'c2']);
  // and a card whose blockers are all done still cannot start as a thread: it cannot hold the field
  await rejects(core.startThreadFromCard(e.projectDir, 'c3', { sessionId: PARENT_SESSION }), /A card with acceptance criteria or a Blocked by list cannot be started as a thread; clear them first \(c3 has a Blocked by list\)/);
});

// ---------------------------------------------------------------- older plugin versions

// an older version reads and writes the same state file as this one (see "Several plugin versions" in .claude/CLAUDE.md)
const FIELDS_WRITER = path.join(TEST_DIR, 'fixtures', 'old-fields-writer.mjs');
const oldRun = (e, old, mode) => runNode([FIELDS_WRITER, old, e.projectDir, mode], { env: { ...process.env, THREAD_DATA_DIR: e.dataDir } });

for (const ref of RELEASED_REFS) test(`the plugin version at ${ref} keeps the new card fields and the workers in the history when it writes the card`, async (t) => {
  const old = oldServerFrom(t, ref);
  if (!old) return;
  const e = setupThreadEnv(t);
  const fields = { type: 'bug', priority: 'high', labels: ['ui', 'api'], blockedBy: ['c2'], criteria: ['works'], leftDoneAt: '2026-10-14T03:10:00.000Z' };
  const history = [
    { at: '2026-10-14T03:00:00.000Z', by: 'claude', type: 'created', to: 'new', worker: 'main' },
    { at: '2026-10-14T03:05:00.000Z', by: 'claude', type: 'waiting', wait: 'c1.w1', kind: 'review', worker: 'agent:worker' },
  ];
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [task('c1', { ...fields, history }), task('c2')]));
  const r = await oldRun(e, old, 'edit');
  assert.equal(r.code, 0, r.stderr);
  const c = cardOf(e, 'c1');
  assert.equal(c.title, 'Renamed by the older version', 'the older version did write');
  for (const [k, v] of Object.entries(fields)) assert.deepEqual(c[k], v, k);
  assert.deepEqual(c.history.slice(0, 2), history, 'its own entries have no worker, the earlier ones keep theirs');
  assert.deepEqual(core.workedBy(c), ['main', 'agent:worker']);
});

for (const ref of RELEASED_REFS) test(`this version reads cards the plugin version at ${ref} made, which have none of the new fields`, async (t) => {
  const old = oldServerFrom(t, ref);
  if (!old) return;
  const e = setupThreadEnv(t);
  const r = await oldRun(e, old, 'create');
  assert.equal(r.code, 0, r.stderr);
  const bd = await board(t, e);
  const c1 = await bd.view('c1');
  const c2 = await bd.view('c2');
  assert.equal(c1.title, 'Made by the older version');
  assert.equal(c2.status, 'done');
  for (const c of [c1, c2]) {
    for (const k of ['type', 'priority', 'labels', 'blockedBy', 'criteria', 'verified']) assert.equal(k in c, false, k);
    assert.deepEqual(c.workedBy, []);
  }
  const mc = mcp(t, e);
  await mc.init();
  const list = (await mc.call('board_list')).text;
  assert.match(list, /^- c1 \[task\] Made by the older version$/m);
  assert.match(list, /^- c2 \[task\] Also made by it( \(new from user\))?$/m);
  const projects = (await bd.api('GET', '/api/projects')).body.projects.find((p) => p.projectDir === e.projectDir);
  assert.deepEqual([projects.open, projects.done], [1, 1]);
  // and can give them the fields
  const done = await mc.call('board_update', { id: 'c2', criteria: ['a'] });
  assert.equal(done.isError, false, done.text);
  assert.equal((await bd.view('c2')).verified, false, 'already in done: not verified');
});

// 0.12.0 brought the gate, so only the versions before it let Claude move such a card
for (const ref of RELEASED_REFS.filter((r) => !['v0.12.1', 'v0.13.0', 'v0.14.0'].includes(r))) test(`a card with criteria that the plugin version at ${ref} moves to done is shown as not verified`, async (t) => {
  const old = oldServerFrom(t, ref);
  if (!old) return;
  const e = setupThreadEnv(t);
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [task('c1', { criteria: ['works'] }), task('c2', { criteria: ['also'] })]));
  const r = await oldRun(e, old, 'move');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(cardOf(e, 'c1').status, 'done', 'the older version has no gate');
  const bd = await board(t, e);
  assert.equal((await bd.view('c1')).verified, false);
  assert.equal('verified' in (await bd.view('c2')), false, 'c2 is not in the done stage');
  await review(e, 'c1', 'approve');
  assert.equal('verified' in (await bd.view('c1')), false);
});
