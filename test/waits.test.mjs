// "Waiting for you": the stored items, the tools, the board's route, the hook that delivers answers, an older
// version writing the state, and the fixed columns of chat-only mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  setupThreadEnv, cleanAmbientEnv, McpClient, runNode, writeStateFile, emptyState, threadCard, oldServerFrom, RELEASED_REFS,
  HOOK_PATH, PARENT_SESSION, TEST_DIR, ROOT,
} from './helpers.mjs';
import * as core from '../server/core.mjs';
import { startBoardServer } from '../server/http.mjs';

cleanAmbientEnv();

const OTHER_SESSION = '99999999-9999-4999-8999-999999999999';
const TOKEN = 'a'.repeat(32);
const stateOf = (e) => core.readState(e.projectDir);
const cardOf = (e, id) => stateOf(e).cards.find((c) => c.id === id);
const itemOf = (e, id) => core.waitsOf(cardOf(e, id.split('.')[0])).find((w) => w.id === id);

function mcp(t, e, extraEnv) {
  const c = new McpClient(e, extraEnv);
  t.after(() => c.kill());
  return c;
}
const add = (c, over = {}) => c.call('wait_add', { card: 'c1', kind: 'question', text: 'Which retry limit?', session_id: PARENT_SESSION, ...over });

async function world(t, extra = {}) {
  const e = setupThreadEnv(t, extra);
  await core.addCard(e.projectDir, { title: 'Fix the importer' });
  const c = mcp(t, e);
  await c.init();
  return { e, c };
}

// ---------------------------------------------------------------- the tools

test('wait_add records an item on the card, numbers it per card and does not touch the card\'s own fields', async (t) => {
  const { e, c } = await world(t);
  await core.addCard(e.projectDir, { title: 'Second' });
  const before = cardOf(e, 'c1');
  const r = await add(c);
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Added c1\.w1 \[question\] on c1 "Fix the importer"/);
  assert.match(r.text, /Waiting on you: c1\.w1/);
  const item = itemOf(e, 'c1.w1');
  assert.deepEqual(Object.keys(item).sort(), ['askedAt', 'askedBy', 'id', 'kind', 'state', 'text']);
  assert.equal(item.state, 'open');
  assert.equal(item.askedBy, PARENT_SESSION);
  assert.ok(Number.isFinite(Date.parse(item.askedAt)));
  const after = cardOf(e, 'c1');
  assert.equal(after.updatedAt, before.updatedAt, 'an item is not an edit of the card');
  assert.equal(after.seenByClaude, true);
  assert.equal(after.status, before.status);
  assert.deepEqual(after.history, before.history);

  assert.match((await add(c, { kind: 'todo', text: 'Run the migration' })).text, /Added c1\.w2 \[todo\]/);
  assert.match((await add(c, { card: 'c2', kind: 'review', text: 'Check the diff' })).text, /Added c2\.w1 \[review\]/, 'every card counts from 1');
});

test('item numbers are never reused, even after the items are closed or a writer pruned them', async (t) => {
  const { e, c } = await world(t);
  await add(c);
  await add(c);
  await c.call('wait_close', { id: 'c1.w2', withdraw: true });
  assert.match((await add(c)).text, /c1\.w3/);
  // a writer that dropped the items but left the counter
  await core.updateState(e.projectDir, (s) => { s.cards[0].waits = []; });
  assert.match((await add(c)).text, /c1\.w4/);
  // a writer that dropped both: the highest number on record still counts
  await core.updateState(e.projectDir, (s) => { delete s.cards[0].waitSeq; });
  assert.match((await add(c)).text, /c1\.w5/);
});

test('a choice stores its options and multi; a question, a to-do and a review store neither', async (t) => {
  const { e, c } = await world(t);
  assert.equal((await add(c, { kind: 'choice', text: 'Pick', choices: ['a', 'b'] })).isError, false);
  assert.equal((await add(c, { kind: 'choice', text: 'Pick many', choices: [' x ', 'y', 'z'], multi: true })).isError, false);
  assert.deepEqual(itemOf(e, 'c1.w1').choices, ['a', 'b']);
  assert.equal(itemOf(e, 'c1.w1').multi, false, 'one pick by default');
  assert.deepEqual(itemOf(e, 'c1.w2').choices, ['x', 'y', 'z'], 'options are trimmed');
  assert.equal(itemOf(e, 'c1.w2').multi, true);
  await add(c, { kind: 'review', text: 'Look' });
  await add(c, { kind: 'todo', text: 'Do' });
  for (const id of ['c1.w3', 'c1.w4']) {
    assert.equal('choices' in itemOf(e, id), false);
    assert.equal('multi' in itemOf(e, id), false);
  }
});

test('wait_add refuses bad input and says why', async (t) => {
  const { e, c } = await world(t);
  await core.addCard(e.projectDir, { title: 'Release', kind: 'milestone' });
  const refused = async (args, re) => {
    const r = await add(c, args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.text, re, JSON.stringify(args));
  };
  await refused({ card: 'c2' }, /c2 is a milestone: put the item on one of its cards/);
  await refused({ card: 'c99' }, /card not found: c99/);
  await refused({ kind: 'poll' }, /invalid kind "poll"/);
  await refused({ text: '   ' }, /argument "text" is required/);
  await refused({ text: 'x'.repeat(2001) }, /text is too long \(2001 characters, the limit is 2000\)/);
  await refused({ kind: 'choice', text: 'p' }, /a choice needs 2 to 8 options/);
  await refused({ kind: 'choice', text: 'p', choices: ['only'] }, /a choice needs 2 to 8 options/);
  await refused({ kind: 'choice', text: 'p', choices: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] }, /a choice needs 2 to 8 options/);
  await refused({ kind: 'choice', text: 'p', choices: ['a', 'a'] }, /given twice/);
  await refused({ kind: 'choice', text: 'p', choices: ['a', ''] }, /1 to 120 characters/);
  await refused({ kind: 'choice', text: 'p', choices: ['a', 'b'.repeat(121)] }, /1 to 120 characters/);
  await refused({ kind: 'question', text: 'p', choices: ['a', 'b'] }, /belong to the kind "choice" only/);
  await refused({ kind: 'todo', text: 'p', multi: true }, /belong to the kind "choice" only/);
  await refused({ kind: 'choice', text: 'p', choices: ['a', 'b'], multi: 'yes' }, /multi must be true or false/);
  const noSession = await c.call('wait_add', { card: 'c1', kind: 'question', text: 'q' });
  assert.equal(noSession.isError, true);
  assert.match(noSession.text, /no session id/);
  assert.deepEqual(core.waitsOf(cardOf(e, 'c1')), [], 'nothing was written');
});

test('wait_add allows 20 open items on a card, and a closed one makes room', async (t) => {
  const { e, c } = await world(t);
  for (let i = 0; i < 20; i++) assert.equal((await add(c, { text: `q${i}` })).isError, false);
  const over = await add(c);
  assert.equal(over.isError, true);
  assert.match(over.text, /already has 20 open items/);
  await c.call('wait_close', { id: 'c1.w1', withdraw: true });
  assert.equal((await add(c)).isError, false);
  assert.equal(core.waitsOf(cardOf(e, 'c1')).length, 21);
});

test('wait_add is refused inside a side thread and in chat-only mode', async (t) => {
  const { e } = await world(t);
  const inThread = mcp(t, e, { THREAD_DEPTH: '1' });
  await inThread.init();
  const r = await add(inThread);
  assert.equal(r.isError, true);
  assert.match(r.text, /side thread cannot ask the user/);
  const closed = await inThread.call('wait_close', { id: 'c1.w1', withdraw: true });
  assert.equal(closed.isError, true);
  assert.match(closed.text, /side thread cannot close/);
  assert.deepEqual(core.waitsOf(cardOf(e, 'c1')), []);

  await core.saveConfig(e.projectDir, 'project', { mode: 'chat' });
  const c = mcp(t, e);
  await c.init();
  const chat = await add(c);
  assert.equal(chat.isError, true);
  assert.match(chat.text, /task board is off for this project \(chat-only\)/);
});

test('wait_add takes the session from CLAUDE_CODE_SESSION_ID like the other tools, and keeps it lower case', async (t) => {
  const e = setupThreadEnv(t);
  await core.addCard(e.projectDir, { title: 'T' });
  const c = mcp(t, e, { CLAUDE_CODE_SESSION_ID: PARENT_SESSION.toUpperCase() });
  await c.init();
  const r = await c.call('wait_add', { card: 'c1', kind: 'todo', text: 'Do it' });
  assert.equal(r.isError, false, r.text);
  assert.equal(itemOf(e, 'c1.w1').askedBy, PARENT_SESSION);
});

test('wait_list reads one item whole, the open and undelivered ones by default, and filters by card and state', async (t) => {
  const { e, c } = await world(t);
  await core.addCard(e.projectDir, { title: 'Second' });
  await add(c, { text: 'First?' });
  await add(c, { kind: 'choice', text: 'Which?', choices: ['A', 'B'], multi: true });
  await add(c, { card: 'c2', kind: 'review', text: 'Check c2' });
  await c.call('wait_close', { id: 'c1.w1', withdraw: true });
  await core.answerWait(e.projectDir, 'c1', 'c1.w2', { choices: ['A', 'B'], comment: 'both' });

  const one = (await c.call('wait_list', { id: 'c1.w2', session_id: PARENT_SESSION })).text;
  assert.match(one, /^c1\.w2 \[choice\] on c1 "Fix the importer" — answered, asked by this session/);
  assert.match(one, /Options \(pick any\): "A", "B"/);
  assert.match(one, /Answered on the board.*: chose "A", "B", with the comment "both" \(NOT delivered yet/);

  const def = (await c.call('wait_list')).text;
  assert.match(def, /c1\.w2/, 'answered and not delivered');
  assert.match(def, /c2\.w1/);
  assert.doesNotMatch(def, /c1\.w1/, 'withdrawn items are not listed by default');
  assert.match((await c.call('wait_list', { card: 'c2' })).text, /^c2\.w1 \[review\]/);
  assert.match((await c.call('wait_list', { state: 'withdrawn' })).text, /^c1\.w1[\s\S]*Withdrawn/);
  assert.match((await c.call('wait_list', { state: 'open' })).text, /^c2\.w1/);

  await core.deliverWaitAnswers(e.projectDir, PARENT_SESSION);
  assert.doesNotMatch((await c.call('wait_list')).text, /c1\.w2/, 'delivered ones leave the default list');
  assert.match((await c.call('wait_list', { id: 'c1.w2' })).text, /delivered to the asking session/);

  for (const [args, re] of [[{ id: 'c1.w9' }, /waiting item not found: c1\.w9/], [{ id: 'nope' }, /not a waiting item id/], [{ card: 'c9' }, /card not found: c9/], [{ state: 'closed' }, /state must be one of/]]) {
    const r = await c.call('wait_list', args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.text, re);
  }
});

test('wait_list says so when nothing is waiting, and names another session that asked', async (t) => {
  const { e, c } = await world(t);
  assert.equal((await c.call('wait_list')).text, 'Nothing is waiting for the user.');
  await core.addWait(e.projectDir, { card: 'c1', kind: 'todo', text: 'Do', sessionId: OTHER_SESSION });
  assert.match((await c.call('wait_list', { session_id: PARENT_SESSION })).text, /asked by session 99999999/);
});

test('wait_close withdraws an item, or records an answer given in the chat that nothing needs to deliver', async (t) => {
  const { e, c } = await world(t);
  await add(c);
  await add(c, { kind: 'choice', text: 'Pick', choices: ['a', 'b'] });
  assert.match((await c.call('wait_close', { id: 'c1.w1', withdraw: true })).text, /Withdrew c1\.w1/);
  assert.equal(itemOf(e, 'c1.w1').state, 'withdrawn');
  assert.ok(itemOf(e, 'c1.w1').withdrawnAt);
  assert.match((await c.call('wait_close', { id: 'c1.w2', answered_in_chat: 'they said b' })).text, /Closed c1\.w2 as answered in the chat/);
  const w2 = itemOf(e, 'c1.w2');
  assert.equal(w2.state, 'answered');
  assert.deepEqual(w2.answer, { text: 'they said b' });
  assert.equal(w2.answeredVia, 'chat');
  assert.ok(w2.answeredAt && w2.deliveredAt, 'the session that closes it has the answer already');
  assert.deepEqual(await core.deliverWaitAnswers(e.projectDir, PARENT_SESSION), []);

  await add(c);
  for (const [args, re] of [
    [{ id: 'c1.w3' }, /either withdraw: true or answered_in_chat/],
    [{ id: 'c1.w3', withdraw: true, answered_in_chat: 'x' }, /either withdraw: true or answered_in_chat/],
    [{ id: 'c1.w3', withdraw: false }, /either withdraw: true or answered_in_chat/],
    [{ id: 'c1.w3', withdraw: 'yes' }, /withdraw.*true or false/],
    [{ id: 'c1.w1', withdraw: true }, /c1\.w1 is withdrawn, not open/],
    [{ id: 'c1.w2', answered_in_chat: 'again' }, /c1\.w2 is answered, not open/],
    [{ id: 'c1.w7', withdraw: true }, /not found/],
  ]) {
    const r = await c.call('wait_close', args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.text, re);
  }
  assert.equal(itemOf(e, 'c1.w3').state, 'open');
});

test('an item answered on the board cannot be closed from the chat afterwards', async (t) => {
  const { e, c } = await world(t);
  await add(c);
  await core.answerWait(e.projectDir, 'c1', 'c1.w1', { text: '5' });
  const r = await c.call('wait_close', { id: 'c1.w1', withdraw: true });
  assert.equal(r.isError, true);
  assert.deepEqual(itemOf(e, 'c1.w1').answer, { text: '5' });
});

test('board_list marks cards with open items and leaves the mark off in chat-only mode', async (t) => {
  const { e, c } = await world(t);
  await core.addCard(e.projectDir, { title: 'Quiet' });
  await add(c);
  await add(c, { kind: 'todo', text: 'Do' });
  await add(c, { kind: 'todo', text: 'Do too' });
  await c.call('wait_close', { id: 'c1.w3', withdraw: true });
  let list = (await c.call('board_list')).text;
  assert.match(list, /- c1 \[task\] Fix the importer \(2 waiting\)/);
  assert.doesNotMatch(list, /Quiet.*waiting/);
  await core.answerWait(e.projectDir, 'c1', 'c1.w1', { text: 'x' });
  list = (await c.call('board_list')).text;
  assert.match(list, /Fix the importer \(1 waiting\)/, 'an answered item no longer waits');
  await core.saveConfig(e.projectDir, 'project', { mode: 'chat' });
  assert.doesNotMatch((await c.call('board_list')).text, /waiting/);
});

test('the tool descriptions tell Claude when to raise an item and how little to say in the chat', async (t) => {
  const { c } = await world(t);
  const tools = (await c.request('tools/list', {})).result.tools;
  const byName = Object.fromEntries(tools.map((x) => [x.name, x]));
  const d = byName.wait_add.description;
  for (const word of ['review', 'question', 'choice', 'todo', 'Waiting on you: c37.w2', 'wait_close', 'answered_in_chat', 'next message', 'milestone', 'chat-only']) assert.ok(d.includes(word), `wait_add says ${word}`);
  assert.deepEqual(byName.wait_add.inputSchema.required, ['card', 'kind', 'text']);
  assert.deepEqual(byName.wait_add.inputSchema.properties.kind.enum, ['question', 'choice', 'todo', 'review']);
  assert.match(byName.wait_list.description, /what is c37\.w2/);
  assert.match(byName.wait_close.description, /withdraw/);
  assert.match(byName.board_list.description, /\(2 waiting\)/);
});

// ---------------------------------------------------------------- the board's route

async function board(t, e) {
  const b = await startBoardServer(e.projectDir, { port: 0, token: TOKEN });
  t.after(() => new Promise((r) => { b.server.closeAllConnections?.(); b.server.close(() => r()); }));
  const url = (p) => `http://127.0.0.1:${b.port}${p}`;
  const post = async (p, body, headers = {}) => {
    const res = await fetch(url(p), { method: 'POST', headers: { 'x-thread-token': TOKEN, 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const get = async (p) => {
    const res = await fetch(url(p), { headers: { 'x-thread-token': TOKEN } });
    return { status: res.status, body: await res.json() };
  };
  return { ...b, post, get, url };
}
const ROUTE = (card, id) => `/api/cards/${card}/waits/${id}`;

async function seed(e) {
  const s = PARENT_SESSION;
  await core.addWait(e.projectDir, { card: 'c1', kind: 'question', text: 'Which retry limit?', sessionId: s });
  await core.addWait(e.projectDir, { card: 'c1', kind: 'choice', text: 'Pick one', choices: ['a', 'b', 'c'], sessionId: s });
  await core.addWait(e.projectDir, { card: 'c1', kind: 'choice', text: 'Pick several', choices: ['a', 'b', 'c'], multi: true, sessionId: s });
  await core.addWait(e.projectDir, { card: 'c1', kind: 'todo', text: 'Run the migration', sessionId: s });
  await core.addWait(e.projectDir, { card: 'c1', kind: 'review', text: 'Check the diff', sessionId: s });
}

test('the route answers each kind, stores only the answer fields, and returns the card', async (t) => {
  const { e } = await world(t);
  await seed(e);
  const b = await board(t, e);
  const cases = [
    ['c1.w1', { text: '  5  ' }, { text: '5' }],
    ['c1.w2', { choices: ['b'] }, { choices: ['b'] }],
    ['c1.w3', { choices: ['c', 'a'] }, { choices: ['c', 'a'] }],
    ['c1.w4', { done: true }, { done: true }],
    ['c1.w5', { verdict: 'changes', comment: ' rename it ' }, { verdict: 'changes' }],
  ];
  for (const [id, body, answer] of cases) {
    const before = JSON.parse(JSON.stringify(itemOf(e, id)));
    const r = await b.post(ROUTE('c1', id), body);
    assert.equal(r.status, 200, `${id}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.id, 'c1');
    const item = itemOf(e, id);
    assert.equal(item.state, 'answered');
    assert.deepEqual(item.answer, answer);
    assert.equal(item.answeredVia, 'board');
    assert.ok(Number.isFinite(Date.parse(item.answeredAt)));
    assert.equal(item.deliveredAt, undefined, 'the board never marks an answer delivered');
    // nothing else changed
    const { state, answer: a, answeredAt, answeredVia, comment, ...rest } = item;
    const { state: s0, ...rest0 } = before;
    assert.deepEqual(rest, rest0, `${id}: only the answer fields were written`);
    assert.equal(r.body.waits.find((w) => w.id === id).state, 'answered', 'the response carries the card with its items');
  }
  assert.equal(itemOf(e, 'c1.w5').comment, 'rename it');
  assert.equal('comment' in itemOf(e, 'c1.w1'), false, 'no comment, no field');
  const c = cardOf(e, 'c1');
  assert.equal(c.seenByClaude, true, 'an answer does not mark the card unseen: markSeen is project-wide');
  assert.equal(c.title, 'Fix the importer');
});

test('an answer does not move the card, does not touch updatedAt and leaves the card seen', async (t) => {
  const { e } = await world(t);
  await seed(e);
  const before = JSON.parse(JSON.stringify(cardOf(e, 'c1')));
  const b = await board(t, e);
  assert.equal((await b.post(ROUTE('c1', 'c1.w4'), { done: true })).status, 200);
  const after = cardOf(e, 'c1');
  for (const k of ['status', 'updatedAt', 'seenByClaude', 'title', 'note', 'history', 'parent']) assert.deepEqual(after[k], before[k], k);
});

test('a body field that is not an answer field cannot change the item', async (t) => {
  const { e } = await world(t);
  await seed(e);
  const b = await board(t, e);
  const before = JSON.parse(JSON.stringify(itemOf(e, 'c1.w2')));
  const r = await b.post(ROUTE('c1', 'c1.w2'), { choices: ['a'], text: 'rewritten', id: 'c1.w9', kind: 'question', askedBy: OTHER_SESSION, deliveredAt: '2026-01-01T00:00:00.000Z', state: 'open', multi: true, choicesList: ['x'] });
  assert.equal(r.status, 200);
  const item = itemOf(e, 'c1.w2');
  for (const k of ['id', 'kind', 'text', 'askedBy', 'askedAt', 'choices', 'multi']) assert.deepEqual(item[k], before[k], k);
  assert.equal(item.deliveredAt, undefined);
  assert.equal(item.state, 'answered');
});

test('the route refuses an answer that does not fit the kind', async (t) => {
  const { e } = await world(t);
  await seed(e);
  const b = await board(t, e);
  const bad = [
    ['c1.w1', {}, /answer must not be empty/],
    ['c1.w1', { text: '   ' }, /answer must not be empty/],
    ['c1.w1', { text: 5 }, /answer must not be empty/],
    ['c1.w1', { text: 'x'.repeat(4001) }, /too long/],
    ['c1.w1', { text: 'ok', comment: 7 }, /comment must be text/],
    ['c1.w1', { text: 'ok', comment: 'x'.repeat(2001) }, /comment is too long/],
    ['c1.w2', {}, /choices must be options/],
    ['c1.w2', { choices: [] }, /choose exactly one/],
    ['c1.w2', { choices: ['a', 'b'] }, /choose exactly one/],
    ['c1.w2', { choices: ['z'] }, /choices must be options/],
    ['c1.w2', { choices: 'a' }, /choices must be options/],
    ['c1.w2', { choices: [1] }, /choices must be options/],
    ['c1.w3', { choices: [] }, /choose at least one/],
    ['c1.w3', { choices: ['a', 'a'] }, /chosen twice/],
    ['c1.w3', { choices: ['a', 'zz'] }, /choices must be options/],
    ['c1.w4', {}, /done must be true/],
    ['c1.w4', { done: false }, /done must be true/],
    ['c1.w4', { done: 'true' }, /done must be true/],
    ['c1.w5', {}, /verdict must be one of: approve, changes/],
    ['c1.w5', { verdict: 'maybe' }, /verdict must be one of/],
    ['c1.w5', { text: 'looks good' }, /verdict must be one of/],
  ];
  for (const [id, body, re] of bad) {
    const r = await b.post(ROUTE('c1', id), body);
    assert.equal(r.status, 400, `${id} ${JSON.stringify(body).slice(0, 60)}`);
    assert.match(r.body.error, re, `${id} ${JSON.stringify(body).slice(0, 60)}`);
  }
  assert.ok(core.waitsOf(cardOf(e, 'c1')).every((w) => w.state === 'open' && !w.answer), 'a refused answer writes nothing');
  const multi = await b.post(ROUTE('c1', 'c1.w3'), { choices: ['a', 'b', 'c'] });
  assert.equal(multi.status, 200, 'all options are fine for a multiple choice');
});

test('an item that is not open cannot be answered again', async (t) => {
  const { e } = await world(t);
  await seed(e);
  const b = await board(t, e);
  assert.equal((await b.post(ROUTE('c1', 'c1.w1'), { text: 'first' })).status, 200);
  const again = await b.post(ROUTE('c1', 'c1.w1'), { text: 'second' });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /c1\.w1 is answered, not open/);
  assert.deepEqual(itemOf(e, 'c1.w1').answer, { text: 'first' });
  await core.closeWait(e.projectDir, 'c1.w4', { withdraw: true });
  const gone = await b.post(ROUTE('c1', 'c1.w4'), { done: true });
  assert.equal(gone.status, 409);
  assert.match(gone.body.error, /withdrawn, not open/);
});

test('an unknown item, an item of another card and a malformed id are not found', async (t) => {
  const { e } = await world(t);
  await core.addCard(e.projectDir, { title: 'Other' });
  await seed(e);
  const b = await board(t, e);
  for (const [card, id] of [['c1', 'c1.w99'], ['c2', 'c1.w1'], ['c9', 'c9.w1'], ['c1', 'w1'], ['c1', 'c1.w1x'], ['c1', 'c2.w1']]) {
    const r = await b.post(ROUTE(card, id), { text: 'x' });
    assert.equal(r.status, 404, `${card} ${id}`);
  }
  assert.equal(itemOf(e, 'c1.w1').state, 'open');
});

test('the route needs the token, a local Host, no foreign Origin and a JSON body', async (t) => {
  const { e } = await world(t);
  await seed(e);
  const b = await board(t, e);
  const p = ROUTE('c1', 'c1.w1');
  const raw = (headers, body = '{"text":"x"}') => fetch(b.url(p), { method: 'POST', headers, body });
  assert.equal((await raw({ 'content-type': 'application/json' })).status, 401, 'no token');
  assert.equal((await raw({ 'content-type': 'application/json', 'x-thread-token': 'b'.repeat(32) })).status, 401, 'wrong token');
  assert.equal((await raw({ 'content-type': 'application/json', 'x-thread-token': TOKEN, origin: 'http://evil.example' })).status, 403, 'foreign origin');
  assert.equal((await raw({ 'content-type': 'text/plain', 'x-thread-token': TOKEN })).status, 415, 'not JSON');
  assert.equal((await raw({ 'content-type': 'application/json', 'x-thread-token': TOKEN }, '[1]')).status, 400, 'not an object');
  assert.equal((await raw({ 'content-type': 'application/json', 'x-thread-token': TOKEN }, '{nope')).status, 400, 'invalid JSON');
  const viaHost = await new Promise((resolve) => {
    import('node:http').then(({ default: http }) => {
      const req = http.request({ host: '127.0.0.1', port: b.port, path: p, method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json', 'x-thread-token': TOKEN } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.end('{"text":"x"}');
    });
  });
  assert.equal(viaHost, 403, 'foreign Host');
  assert.equal(itemOf(e, 'c1.w1').state, 'open', 'none of them wrote');
  const own = await raw({ 'content-type': 'application/json', 'x-thread-token': TOKEN, origin: `http://127.0.0.1:${b.port}` });
  assert.equal(own.status, 200, 'the page\'s own origin is fine');
});

test('the route is not a way to change settings, and answering is refused in chat-only mode and on a read-only board', async (t) => {
  const { e } = await world(t);
  await seed(e);
  const b = await board(t, e);
  const before = fs.existsSync(core.configPaths(e.projectDir).project);
  await b.post(ROUTE('c1', 'c1.w1'), { text: 'x', mode: 'chat', stages: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
  assert.equal(fs.existsSync(core.configPaths(e.projectDir).project), before);
  assert.equal(fs.existsSync(core.configPaths(e.projectDir).global), false);
  await core.saveConfig(e.projectDir, 'project', { mode: 'chat' });
  const chat = await b.post(ROUTE('c1', 'c1.w4'), { done: true });
  assert.equal(chat.status, 409);
  assert.match(chat.body.error, /chat-only/);
  assert.equal(itemOf(e, 'c1.w4').state, 'open');
  await core.saveConfig(e.projectDir, 'project', { mode: 'tasks' });
  fs.rmSync(e.projectDir, { recursive: true });
  const ro = await b.post(ROUTE('c1', 'c1.w4'), { done: true });
  assert.equal(ro.status, 409, 'a project whose folder is gone is read-only');
  assert.equal(itemOf(e, 'c1.w4').state, 'open');
});

test('GET state carries the items on the card, and the project list counts the open ones', async (t) => {
  const { e } = await world(t);
  await seed(e);
  const b = await board(t, e);
  await core.closeWait(e.projectDir, 'c1.w5', { withdraw: true });
  await core.answerWait(e.projectDir, 'c1', 'c1.w4', { done: true });
  const st = await b.get('/api/state');
  const card = st.body.cards.find((c) => c.id === 'c1');
  assert.equal(card.waits.length, 5);
  assert.equal(card.waits.filter((w) => w.state === 'open').length, 3);
  assert.equal(card.waitSeq, 5);
  const projects = (await b.get('/api/projects')).body.projects;
  assert.equal(projects.find((p) => p.projectDir === e.projectDir).waiting, 3);
  await core.saveConfig(e.projectDir, 'project', { mode: 'chat' });
  assert.equal((await b.get('/api/projects')).body.projects.find((p) => p.projectDir === e.projectDir).waiting, 0, 'a chat-only project shows none');
});

// ---------------------------------------------------------------- delivery through the hook

function hook(e, session, extraEnv = {}) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: e.projectDir, THREAD_DATA_DIR: e.dataDir, ...extraEnv };
  return runNode([HOOK_PATH, 'UserPromptSubmit'], { env, input: JSON.stringify({ cwd: e.projectDir, hook_event_name: 'UserPromptSubmit', session_id: session, prompt: 'next' }), cwd: e.projectDir });
}
const context = (r) => (r.stdout.trim() ? JSON.parse(r.stdout.trim()).hookSpecificOutput.additionalContext : '');

test('the hook hands an answer to the session that asked, once, and marks it delivered', async (t) => {
  const { e } = await world(t);
  await core.addWait(e.projectDir, { card: 'c1', kind: 'question', text: 'Which retry limit?', sessionId: PARENT_SESSION });
  assert.equal(context(await hook(e, PARENT_SESSION)), '', 'nothing before it is answered');
  await core.answerWait(e.projectDir, 'c1', 'c1.w1', { text: '5' });
  const other = await hook(e, OTHER_SESSION);
  assert.equal(context(other), '', 'another session gets nothing');
  assert.equal(itemOf(e, 'c1.w1').deliveredAt, undefined, 'and does not use it up');
  const first = context(await hook(e, PARENT_SESSION));
  assert.equal(first, 'The user answered c1.w1 on the board ("Which retry limit?"): "5". Continue with it.');
  assert.ok(Number.isFinite(Date.parse(itemOf(e, 'c1.w1').deliveredAt)));
  assert.equal(context(await hook(e, PARENT_SESSION)), '', 'the second prompt carries nothing');
  assert.equal(itemOf(e, 'c1.w1').state, 'answered');
});

test('the hook words each kind of answer, comment included', async (t) => {
  const { e } = await world(t);
  const s = PARENT_SESSION;
  await core.addWait(e.projectDir, { card: 'c1', kind: 'choice', text: 'Pick', choices: ['a', 'b', 'c'], multi: true, sessionId: s });
  await core.addWait(e.projectDir, { card: 'c1', kind: 'todo', text: 'Run the migration', sessionId: s });
  await core.addWait(e.projectDir, { card: 'c1', kind: 'review', text: 'Check the diff', sessionId: s });
  await core.addWait(e.projectDir, { card: 'c1', kind: 'review', text: 'Check the docs', sessionId: s });
  await core.answerWait(e.projectDir, 'c1', 'c1.w1', { choices: ['a', 'c'] });
  await core.answerWait(e.projectDir, 'c1', 'c1.w2', { done: true, comment: 'took a minute' });
  await core.answerWait(e.projectDir, 'c1', 'c1.w3', { verdict: 'approve' });
  await core.answerWait(e.projectDir, 'c1', 'c1.w4', { verdict: 'changes', comment: 'fix the typo' });
  assert.deepEqual(context(await hook(e, s)).split('\n'), [
    'The user answered c1.w1 on the board ("Pick"): chose "a", "c". Continue with it.',
    'The user answered c1.w2 on the board ("Run the migration"): did it, with the comment "took a minute". Continue with it.',
    'The user answered c1.w3 on the board ("Check the diff"): approved. Continue with it.',
    'The user answered c1.w4 on the board ("Check the docs"): asked for changes, with the comment "fix the typo". Continue with it.',
  ]);
});

test('the hook does not deliver items closed in the chat, withdrawn ones or open ones', async (t) => {
  const { e } = await world(t);
  const s = PARENT_SESSION;
  for (const text of ['one', 'two', 'three']) await core.addWait(e.projectDir, { card: 'c1', kind: 'question', text, sessionId: s });
  await core.closeWait(e.projectDir, 'c1.w1', { answeredInChat: 'in the chat' });
  await core.closeWait(e.projectDir, 'c1.w2', { withdraw: true });
  assert.equal(context(await hook(e, s)), '');
  assert.equal(itemOf(e, 'c1.w3').deliveredAt, undefined);
});

test('a long answer is cut short in the hook\'s line and points to wait_list', async (t) => {
  const { e } = await world(t);
  await core.addWait(e.projectDir, { card: 'c1', kind: 'question', text: 'q'.repeat(200), sessionId: PARENT_SESSION });
  await core.answerWait(e.projectDir, 'c1', 'c1.w1', { text: `start ${'word '.repeat(300)}end` });
  const line = context(await hook(e, PARENT_SESSION));
  assert.ok(line.length < 560, `the line is ${line.length} characters`);
  assert.match(line, /^The user answered c1\.w1 on the board \("q{59}…"\): "start word/);
  assert.match(line, /… \(cut short; wait_list with id c1\.w1 shows it whole\)\. Continue with it\.$/);
  assert.equal(itemOf(e, 'c1.w1').answer.text.endsWith('end'), true, 'the stored answer is whole');
});

test('answers come first and whole, ahead of the other notices that the cap cuts', async (t) => {
  const e = setupThreadEnv(t);
  const long = 'L'.repeat(60);
  const cards = [];
  for (let i = 1; i <= 7; i++) cards.push(threadCard({ id: `c${i}`, title: `${long}${i}` }, { announced: false, reportRequestedAt: i > 4 ? new Date().toISOString() : undefined }));
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, cards));
  const first = cards[0];
  for (let i = 1; i <= 5; i++) {
    await core.addWait(e.projectDir, { card: 'c1', kind: 'question', text: `question ${i}`, sessionId: PARENT_SESSION });
    await core.answerWait(e.projectDir, 'c1', `c1.w${i}`, { text: 'a'.repeat(280) });
  }
  assert.ok(first);
  const lines = context(await hook(e, PARENT_SESSION)).split('\n');
  assert.equal(lines.length > 6, true);
  const waitLines = lines.slice(0, 5);
  waitLines.forEach((l, i) => {
    assert.match(l, new RegExp(`^The user answered c1\\.w${i + 1} on the board \\("question ${i + 1}"\\): "a{280}"\\. Continue with it\\.$`), `line ${i}`);
  });
  assert.match(lines[5], /^The user clicked "Report to main session"/, 'then the report requests');
  const joined = lines.join('\n');
  assert.ok(joined.length > 1500, 'the whole text is longer than the cap on the other notices');
});

test('at most five answers go with one prompt; the rest follow with the next', async (t) => {
  const { e } = await world(t);
  for (let i = 1; i <= 7; i++) {
    await core.addWait(e.projectDir, { card: 'c1', kind: 'todo', text: `todo ${i}`, sessionId: PARENT_SESSION });
    await core.answerWait(e.projectDir, 'c1', `c1.w${i}`, { done: true });
  }
  const one = context(await hook(e, PARENT_SESSION)).split('\n');
  assert.equal(one.length, 5);
  const two = context(await hook(e, PARENT_SESSION)).split('\n');
  assert.equal(two.length, 2);
  assert.deepEqual([...one, ...two].map((l) => /c1\.w(\d)/.exec(l)[1]), ['1', '2', '3', '4', '5', '6', '7']);
  assert.equal(context(await hook(e, PARENT_SESSION)), '');
});

test('two prompts at the same moment carry an answer once between them', async (t) => {
  const { e } = await world(t);
  for (let i = 1; i <= 3; i++) {
    await core.addWait(e.projectDir, { card: 'c1', kind: 'todo', text: `todo ${i}`, sessionId: PARENT_SESSION });
    await core.answerWait(e.projectDir, 'c1', `c1.w${i}`, { done: true });
  }
  const runs = await Promise.all([1, 2, 3, 4].map(() => hook(e, PARENT_SESSION)));
  const lines = runs.flatMap((r) => context(r).split('\n')).filter(Boolean);
  assert.equal(lines.length, 3, lines.join('\n'));
  assert.equal(new Set(lines).size, 3, 'no answer twice');
});

test('chat-only mode delivers nothing, and an older session\'s answer waits until the task board is back', async (t) => {
  const { e } = await world(t);
  await core.addWait(e.projectDir, { card: 'c1', kind: 'todo', text: 'Do', sessionId: PARENT_SESSION });
  await core.answerWait(e.projectDir, 'c1', 'c1.w1', { done: true });
  await core.saveConfig(e.projectDir, 'project', { mode: 'chat' });
  assert.equal(context(await hook(e, PARENT_SESSION)), '');
  assert.equal(itemOf(e, 'c1.w1').deliveredAt, undefined);
  await core.saveConfig(e.projectDir, 'project', { mode: 'tasks' });
  assert.match(context(await hook(e, PARENT_SESSION)), /answered c1\.w1/);
});

test('a hook for a session that is not the asker leaves another asker\'s answer for that asker', async (t) => {
  const { e } = await world(t);
  await core.addWait(e.projectDir, { card: 'c1', kind: 'todo', text: 'Mine', sessionId: PARENT_SESSION });
  await core.addWait(e.projectDir, { card: 'c1', kind: 'todo', text: 'Theirs', sessionId: OTHER_SESSION });
  await core.answerWait(e.projectDir, 'c1', 'c1.w1', { done: true });
  await core.answerWait(e.projectDir, 'c1', 'c1.w2', { done: true });
  assert.match(context(await hook(e, OTHER_SESSION)), /^The user answered c1\.w2 .*"Theirs"/);
  assert.equal(itemOf(e, 'c1.w1').deliveredAt, undefined);
  assert.match(context(await hook(e, PARENT_SESSION)), /^The user answered c1\.w1 .*"Mine"/);
});

// ---------------------------------------------------------------- an older version writing the state

// the released versions (RELEASED_REFS), not HEAD, which stops meaning a release once new work is committed
for (const ref of RELEASED_REFS) test(`the plugin version at ${ref} keeps the items and the counter when it writes the card`, async (t) => {
  const old = oldServerFrom(t, ref);
  if (!old) return;
  const e = setupThreadEnv(t);
  const mk = (id) => ({ id, kind: 'task', title: id, note: '', status: 'new', source: 'claude', seenByClaude: true, createdAt: '2026-10-14T03:00:00.000Z', updatedAt: '2026-10-14T03:00:00.000Z' });
  const waits = [
    { id: 'c1.w1', kind: 'choice', text: 'Pick', choices: ['a', 'b'], multi: true, askedBy: PARENT_SESSION, askedAt: '2026-10-14T03:00:00.000Z', state: 'answered', answer: { choices: ['a'] }, comment: 'ok', answeredAt: '2026-10-14T03:01:00.000Z', answeredVia: 'board' },
    { id: 'c1.w2', kind: 'review', text: 'Look', askedBy: PARENT_SESSION, askedAt: '2026-10-14T03:00:00.000Z', state: 'open' },
  ];
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [{ ...mk('c1'), waits, waitSeq: 2 }, mk('c2')]));
  const r = await runNode([path.join(TEST_DIR, 'fixtures', 'old-writer.mjs'), old, e.projectDir], { env: { ...process.env, THREAD_DATA_DIR: e.dataDir } });
  assert.equal(r.code, 0, r.stderr);
  const c = cardOf(e, 'c1');
  assert.equal(c.title, 'Renamed by the older version', 'the older version did write');
  assert.deepEqual(c.waits, waits);
  assert.equal(c.waitSeq, 2);
  assert.match((await core.addWait(e.projectDir, { card: 'c1', kind: 'todo', text: 'again', sessionId: PARENT_SESSION })).item.id, /^c1\.w3$/);
});

test('this version skips a malformed or unknown item and keeps it in the file', async (t) => {
  const { e, c } = await world(t);
  const odd = [null, 7, { id: 'c1.w1', kind: 'poll', text: 'a newer kind', state: 'open' }, { kind: 'todo', text: 'no id' }];
  await core.updateState(e.projectDir, (s) => { s.cards[0].waits = [...odd]; });
  assert.deepEqual(core.waitsOf(cardOf(e, 'c1')), []);
  assert.equal((await c.call('wait_list')).text, 'Nothing is waiting for the user.');
  assert.match((await add(c)).text, /c1\.w2/, 'a number on record is not reused');
  assert.deepEqual(cardOf(e, 'c1').waits.slice(0, 4), odd);
});

// ---------------------------------------------------------------- chat-only: three fixed columns

const TASK_STAGES = [{ id: 'todo', label: 'To do' }, { id: 'doing', label: 'Doing' }, { id: 'check', label: 'Checking' }, { id: 'done', label: 'Finished' }];
const TASK_ROLES = { start: 'todo', working: 'doing', review: 'check', blocked: 'doing', done: 'done' };

test('chat-only has the columns New, Review and Done, whatever stages the task board has, and the roles follow', async (t) => {
  const e = setupThreadEnv(t);
  await core.saveConfig(e.projectDir, 'project', { mode: 'chat', stages: TASK_STAGES, roles: TASK_ROLES });
  const cfg = core.readConfig(e.projectDir);
  assert.deepEqual(cfg.stages, [{ id: 'new', label: 'New' }, { id: 'review', label: 'Review' }, { id: 'done', label: 'Done' }]);
  assert.deepEqual(cfg.roles, { start: 'new', working: 'new', review: 'review', blocked: 'review', done: 'done' });
  assert.deepEqual(cfg.taskStages, TASK_STAGES, 'the stored stages are not touched');
  assert.deepEqual(cfg.taskRoles, TASK_ROLES);
  assert.deepEqual(JSON.parse(fs.readFileSync(core.configPaths(e.projectDir).project, 'utf8')), { mode: 'chat', stages: TASK_STAGES, roles: TASK_ROLES }, 'nor is the file');
  // without any stages of its own
  await core.resetConfig(e.projectDir, 'project');
  await core.saveConfig(e.projectDir, 'global', { mode: 'chat' });
  assert.deepEqual(core.readConfig(e.projectDir).stages.map((s) => s.id), ['new', 'review', 'done']);
  assert.equal(core.readConfig(e.projectDir).taskStages.length, 6);
});

test('a thread sits in New while it runs, in Review when a turn finished or failed, and in Done once ended', async (t) => {
  const e = setupThreadEnv(t);
  await core.saveConfig(e.projectDir, 'project', { mode: 'chat', stages: TASK_STAGES, roles: TASK_ROLES });
  const cards = [
    threadCard({ id: 'c1', status: 'doing' }, { runState: 'running', pid: process.pid }),
    threadCard({ id: 'c2', status: 'check' }, { runState: 'idle' }),
    threadCard({ id: 'c3', status: 'doing' }, { runState: 'failed' }),
    threadCard({ id: 'c4', status: 'done' }, { runState: 'ended' }),
  ];
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, cards));
  const b = await board(t, e);
  const st = (await b.get('/api/state')).body;
  assert.deepEqual(st.config.stages.map((s) => s.id), ['new', 'review', 'done']);
  assert.equal(st.config.mode, 'chat');
  assert.deepEqual(Object.fromEntries(st.cards.map((c) => [c.id, c.status])), { c1: 'new', c2: 'review', c3: 'review', c4: 'done' });
  // board_list groups by the same columns
  const c = mcp(t, e);
  await c.init();
  const list = (await c.call('board_list')).text;
  assert.match(list, /New \(1\)\n- c1 \[thread:running\]/);
  assert.match(list, /Review \(2\)\n- c2 \[thread:idle\][\s\S]*- c3 \[thread:failed\]/);
  assert.match(list, /Done \(1\)\n- c4 \[thread:ended\]/);
  assert.match(list, /- new: New \[start, working\]\n- review: Review \[review, blocked\]\n- done: Done \[done\]/);
});

test('a chat-only project written by an older version, with other stage ids on its thread cards, still shows its columns', async (t) => {
  const e = setupThreadEnv(t);
  await core.saveConfig(e.projectDir, 'project', { mode: 'chat' });
  // 0.8.x stored in_progress and blocked on thread cards; one stage that no project has is stored too
  const cards = [
    threadCard({ id: 'c1', status: 'in_progress' }, { runState: 'running', pid: process.pid }),
    threadCard({ id: 'c2', status: 'blocked' }, { runState: 'failed' }),
    threadCard({ id: 'c3', status: 'gone_stage' }, { runState: 'idle' }),
    threadCard({ id: 'c4', status: 'review' }, { runState: 'ended' }),
  ];
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, cards));
  const b = await board(t, e);
  const st = (await b.get('/api/state')).body;
  assert.deepEqual(Object.fromEntries(st.cards.map((c) => [c.id, c.status])), { c1: 'new', c2: 'review', c3: 'review', c4: 'done' });
  const stored = stateOf(e).cards.map((c) => c.status);
  assert.deepEqual(stored, ['in_progress', 'blocked', 'gone_stage', 'review'], 'the file is not rewritten');
});

test('switching back from chat-only restores the task board\'s own stages and the threads follow their roles', async (t) => {
  const e = setupThreadEnv(t);
  await core.saveConfig(e.projectDir, 'project', { mode: 'chat', stages: TASK_STAGES, roles: TASK_ROLES });
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [
    threadCard({ id: 'c1', status: 'review' }, { runState: 'failed' }),
    { id: 'c2', kind: 'task', title: 'A task', note: '', status: 'check', source: 'user', seenByClaude: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  ]));
  const b = await board(t, e);
  await core.saveConfig(e.projectDir, 'project', { mode: 'tasks' });
  const st = (await b.get('/api/state')).body;
  assert.equal(st.config.mode, 'tasks');
  assert.deepEqual(st.config.stages, TASK_STAGES);
  assert.deepEqual(st.config.roles, TASK_ROLES);
  assert.deepEqual(Object.fromEntries(st.cards.map((c) => [c.id, c.status])), { c1: 'doing', c2: 'check' });
  // and back to chat-only and to the task board again with a null mode
  await core.saveConfig(e.projectDir, 'project', { mode: 'chat' });
  assert.deepEqual((await b.get('/api/state')).body.config.stages.map((s) => s.id), ['new', 'review', 'done']);
  await core.saveConfig(e.projectDir, 'project', { mode: null });
  assert.deepEqual((await b.get('/api/state')).body.config.stages, TASK_STAGES);
});

test('a thread card keeps a stage of the task board stored, also while the project is chat-only', async (t) => {
  const e = setupThreadEnv(t);
  await core.saveConfig(e.projectDir, 'project', { mode: 'chat', stages: TASK_STAGES, roles: TASK_ROLES });
  const card = threadCard({ id: 'c1', status: 'doing' }, { runState: 'running' });
  core.setRunState(e.projectDir, card, 'idle');
  assert.equal(card.status, 'check', 'an older version reads this stage, so it is one of the task board\'s');
  core.setRunState(e.projectDir, card, 'ended');
  assert.equal(card.status, 'done');
  assert.equal(core.effectiveStatus(card, core.readConfig(e.projectDir)), 'done');
  card.thread.runState = 'failed';
  assert.equal(core.effectiveStatus(card, core.readConfig(e.projectDir)), 'review', 'but it is shown in the chat-only column');
});

test('in chat-only mode a task card\'s status is refused for the board being off, not for its name', async (t) => {
  const e = setupThreadEnv(t);
  await core.addCard(e.projectDir, { title: 'T' });
  await core.saveConfig(e.projectDir, 'project', { mode: 'chat' });
  await assert.rejects(() => core.updateCard(e.projectDir, 'c1', { status: 'in_progress' }), /chat-only/);
  await assert.rejects(() => core.updateCard(e.projectDir, 'c1', { status: 'nonsense' }), /chat-only/);
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [threadCard({ id: 'c1', status: 'review' }, { runState: 'idle' })]));
  await assert.rejects(() => core.updateCard(e.projectDir, 'c1', { status: 'done' }), /thread status follows the thread/);
  await core.updateCard(e.projectDir, 'c1', { title: 'Renamed', status: 'review' });
  assert.equal(cardOf(e, 'c1').title, 'Renamed');
});

test('the config tools describe the fixed chat-only columns and keep counting orphaned task cards against the task stages', async (t) => {
  const e = setupThreadEnv(t);
  await core.addCard(e.projectDir, { title: 'T' });
  const c = mcp(t, e);
  await c.init();
  const set = await c.call('config_set', { scope: 'project', mode: 'chat', stages: TASK_STAGES, roles: TASK_ROLES });
  assert.match(set.text, /Mode: chat/);
  assert.match(set.text, /Stages, in order — fixed for chat-only \(what the board shows now\):\n- new: New\n- review: Review\n- done: Done/);
  assert.match(set.text, /In this project, 1 card\(s\) have a status that is no longer a stage; they show in the start stage \(todo\)/);
});

// ---------------------------------------------------------------- review follow-ups

test('a missing git ref fails the test run loudly instead of skipping it', () => {
  let skipped = false;
  const cleanups = [];
  const stand = { skip() { skipped = true; }, after: (fn) => cleanups.push(fn) };   // a stand-in for the test context, so a skip is seen and not swallowed
  assert.throws(() => oldServerFrom(stand, 'v9.9.9-not-a-ref'), /the git ref v9\.9\.9-not-a-ref is not in this checkout/);
  assert.equal(skipped, false);
  cleanups.forEach((fn) => fn());
});

const sessionStart = (e, session = PARENT_SESSION) => hookEvent(e, 'SessionStart', session);
function hookEvent(e, event, session) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: e.projectDir, THREAD_DATA_DIR: e.dataDir };
  return runNode([HOOK_PATH, event], { env, input: JSON.stringify({ cwd: e.projectDir, hook_event_name: event, session_id: session }), cwd: e.projectDir });
}

test('the session start note tells Claude when to raise a waiting item, in tasks mode only', async (t) => {
  const e = setupThreadEnv(t);
  const note = context(await sessionStart(e));
  assert.match(note, /^\[thread plugin\] This session's id is /);
  assert.match(note, /When you finish work that needs the user's check, have a question, or need the user to do something, raise it with wait_add on the card for that work, and say only a one-line pointer in the chat, for example "Waiting on you: c37\.w2"\./);
  assert.ok(note.length < 700, `short: ${note.length}`);
  await core.saveConfig(e.projectDir, 'project', { mode: 'chat' });
  const chat = context(await sessionStart(e));
  assert.match(chat, /This session's id is/);
  assert.doesNotMatch(chat, /wait_add|waiting item/);
});

test('the session start note counts answers that no session received, only above zero, never the session\'s own, and not in chat-only mode', async (t) => {
  const { e } = await world(t);
  assert.doesNotMatch(context(await sessionStart(e)), /answered waiting item/, 'none: no line');
  for (const [who, text] of [[PARENT_SESSION, 'mine'], [OTHER_SESSION, 'theirs one'], [OTHER_SESSION, 'theirs two'], [OTHER_SESSION, 'theirs three']]) await core.addWait(e.projectDir, { card: 'c1', kind: 'todo', text, sessionId: who });
  await core.answerWait(e.projectDir, 'c1', 'c1.w1', { done: true });
  await core.answerWait(e.projectDir, 'c1', 'c1.w2', { done: true });
  await core.answerWait(e.projectDir, 'c1', 'c1.w3', { done: true });
  const one = context(await sessionStart(e, PARENT_SESSION)).split('\n');
  assert.equal(one.filter((l) => /answered waiting item/.test(l)).length, 1, 'one line');
  assert.match(one.join('\n'), /2 answered waiting items on the board were asked by another session and not delivered; wait_list reads them if relevant\./);
  assert.match(context(await sessionStart(e, OTHER_SESSION)), /1 answered waiting item on the board was asked by another session and not delivered; wait_list reads it if relevant\./);
  assert.equal(itemOf(e, 'c1.w2').deliveredAt, undefined, 'a session start delivers nothing');
  await core.closeWait(e.projectDir, 'c1.w4', { answeredInChat: 'x' });   // closed in the chat: delivered at birth, not counted
  await core.saveConfig(e.projectDir, 'project', { mode: 'chat' });
  assert.doesNotMatch(context(await sessionStart(e)), /answered waiting item/);
});

test('delivery is the last thing the hook does before it prints: no step that can wait or fail lies between', () => {
  const src = fs.readFileSync(HOOK_PATH, 'utf8');
  const at = src.indexOf('await core.deliverWaitAnswers(');
  const printed = src.indexOf("await emit('UserPromptSubmit'");
  assert.ok(at > 0 && printed > at, 'delivery comes before the print');
  const between = src.slice(at + 'await core.deliverWaitAnswers('.length, printed);
  assert.doesNotMatch(between, /\bawait\b/, 'nothing is awaited between marking an answer delivered and printing it');
  assert.doesNotMatch(between, /\b(reconcile|pendingAnnouncements|pendingReportRequests|readState|readConfig|updateState|withLock)\(/);
  for (const earlier of ['await reconcile(', 'await pendingAnnouncements(', 'await pendingReportRequests(', 'core.readConfig(projectDir).mode', 'readState(projectDir)']) {
    assert.ok(src.indexOf(earlier) < at, `${earlier} runs before the delivery`);
  }
});

const CUSTOM = [{ id: 'todo', label: 'To do' }, { id: 'doing', label: 'Doing' }, { id: 'check', label: 'Checking' }, { id: 'fin', label: 'Finished' }];
const CUSTOM_ROLES = { start: 'todo', working: 'doing', review: 'check', blocked: 'doing', done: 'fin' };

test('in chat-only mode board_update never stores a chat column on a thread, and a thread keeps a stage of the task board', async (t) => {
  const e = setupThreadEnv(t);
  await core.saveConfig(e.projectDir, 'project', { mode: 'chat', stages: CUSTOM, roles: CUSTOM_ROLES });
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [
    threadCard({ id: 'c1', status: 'doing' }, { runState: 'running', pid: process.pid }),
    threadCard({ id: 'c2', status: 'check' }, { runState: 'idle' }),
  ]));
  const c = mcp(t, e);
  await c.init();
  const same = await c.call('board_update', { id: 'c1', status: 'new' });   // 'new' is where a running thread is shown in chat-only mode
  assert.equal(same.isError, false, same.text);
  assert.equal(cardOf(e, 'c1').status, 'doing', 'not stored: it is no stage of the task board');
  assert.equal((await c.call('board_update', { id: 'c2', status: 'review' })).isError, false);
  assert.equal(cardOf(e, 'c2').status, 'check');
  const renamed = await c.call('board_update', { id: 'c2', title: 'New name', status: 'review' });
  assert.equal(renamed.isError, false);
  assert.equal(cardOf(e, 'c2').status, 'check', 'an edit that carries the shown stage still leaves the stored one');
  const moved = await c.call('board_update', { id: 'c1', status: 'done' });
  assert.equal(moved.isError, true, 'a stage the thread is not in is still refused');
  assert.match(moved.text, /thread status follows the thread/);
  // back in tasks mode the stored stages are all valid
  await core.saveConfig(e.projectDir, 'project', { mode: 'tasks' });
  const stored = stateOf(e).cards.map((x) => x.status);
  assert.ok(stored.every((s) => CUSTOM.some((st) => st.id === s)), stored.join());
  assert.deepEqual(stateOf(e).cards.map((x) => core.effectiveStatus(x, core.readConfig(e.projectDir))), ['doing', 'check']);
});

test('milestone progress counts the same in chat-only mode as in tasks mode, with the task board\'s own done stage', async (t) => {
  const e = setupThreadEnv(t);
  await core.saveConfig(e.projectDir, 'project', { mode: 'tasks', stages: CUSTOM, roles: CUSTOM_ROLES });
  const task = (id, status, parent) => ({ id, kind: 'task', title: id, note: '', status, source: 'claude', seenByClaude: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...(parent ? { parent } : {}) });
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [
    { ...task('c1', 'doing'), kind: 'milestone' },
    task('c2', 'fin', 'c1'), task('c3', 'doing', 'c1'), task('c4', 'gone_stage', 'c1'),
    threadCard({ id: 'c5', status: 'fin', parent: 'c1' }, { runState: 'ended' }),
    threadCard({ id: 'c6', status: 'check', parent: 'c1' }, { runState: 'idle' }),
  ]));
  const progress = () => core.milestoneProgress(stateOf(e).cards, 'c1', core.readConfig(e.projectDir));
  assert.deepEqual(progress(), { done: 2, total: 5 }, 'the finished task and the ended thread');
  await core.saveConfig(e.projectDir, 'project', { mode: 'chat' });
  assert.deepEqual(progress(), { done: 2, total: 5 }, 'the same in chat-only mode');
  const b = await board(t, e);
  assert.deepEqual((await b.get('/api/state')).body.cards.find((x) => x.id === 'c1').progress, { done: 2, total: 5 });
  const c = mcp(t, e);
  await c.init();
  assert.match((await c.call('board_list', { parent: 'c1' })).text, /^Milestone c1 "c1": 2 of 5 done\./);
  assert.equal(core.effectiveStatus(stateOf(e).cards[3], core.readConfig(e.projectDir)), 'todo', 'a card whose stage is gone is in the task board\'s start stage');
});

test('config_get in chat-only mode shows the fixed columns and roles and the task board\'s own stages and roles', async (t) => {
  const e = setupThreadEnv(t);
  await core.saveConfig(e.projectDir, 'project', { mode: 'chat', stages: CUSTOM, roles: CUSTOM_ROLES });
  const c = mcp(t, e);
  await c.init();
  const text = (await c.call('config_get')).text;
  const [chat, own] = text.split("The task board's own settings, kept for when it is turned on.");
  assert.ok(own, 'both are shown');
  assert.match(chat, /Stages, in order — fixed for chat-only \(what the board shows now\):\n- new: New\n- review: Review\n- done: Done\nRoles in chat-only mode \(fixed\):\n- start: new /);
  assert.match(chat, /- working: new .*\n- review: review .*\n- blocked: review .*\n- done: done /);
  assert.match(own, /Stages, in order — from project config file:\n- todo: To do\n- doing: Doing\n- check: Checking\n- fin: Finished\nRoles of the task board[^\n]*\n- start: todo .*\n- working: doing .*\n- review: check .*\n- blocked: doing .*\n- done: fin /);
  await core.saveConfig(e.projectDir, 'project', { mode: 'tasks' });
  const tasks = (await c.call('config_get')).text;
  assert.doesNotMatch(tasks, /fixed for chat-only|kept for when it is turned on/);
  assert.match(tasks, /Roles \(the stage the plugin itself uses\):\n- start: todo/);
});

test('the track skill loads when work is finished for the user to check, not only on a new instruction', () => {
  const head = fs.readFileSync(path.join(ROOT, 'skills', 'track', 'SKILL.md'), 'utf8').split('---')[1];
  const description = /description: (.*)/.exec(head)[1];
  assert.match(description, /new instruction/);
  assert.match(description, /finish.*check/i);
  assert.match(description, /question/);
  assert.match(description, /do something/);
  assert.ok(description.length < 420, `short: ${description.length}`);
  assert.match(fs.readFileSync(path.join(ROOT, 'skills', 'track', 'SKILL.md'), 'utf8'), /`wait_add`/);
});
