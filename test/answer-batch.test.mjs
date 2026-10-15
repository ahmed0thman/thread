// The drafted answers sent together: POST .../waits/answer-batch applies them all in one state write, or none; what is answered
// meanwhile is reported, not an error; each session gets only its own answers, in one turn; the single-answer route still works.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  setupThreadEnv, cleanAmbientEnv, runNode, sleep, oldServerFrom, RELEASED_REFS, HOOK_PATH, PARENT_SESSION, TEST_DIR,
} from './helpers.mjs';
import * as core from '../server/core.mjs';
import { startBoardServer } from '../server/http.mjs';

cleanAmbientEnv();

const OTHER_SESSION = '99999999-9999-4999-8999-999999999999';
const TOKEN = 'a'.repeat(32);
const cardOf = (e, id) => core.readState(e.projectDir).cards.find((c) => c.id === id);
const itemOf = (e, id) => core.waitsOf(cardOf(e, id.split('.')[0])).find((w) => w.id === id);
const context = (r) => (r.stdout.trim() ? JSON.parse(r.stdout.trim()).hookSpecificOutput.additionalContext : '');
const stateFile = (e) => core.projectPaths(e.projectDir).state;

function hook(e, session) {
  const input = JSON.stringify({ cwd: e.projectDir, hook_event_name: 'UserPromptSubmit', session_id: session, prompt: 'next' });
  return runNode([HOOK_PATH, 'UserPromptSubmit'], { env: { ...process.env, CLAUDE_PROJECT_DIR: e.projectDir, THREAD_DATA_DIR: e.dataDir }, input, cwd: e.projectDir });
}

async function board(t, e) {
  const b = await startBoardServer(e.projectDir, { port: 0, token: TOKEN });
  t.after(() => new Promise((r) => { b.server.closeAllConnections?.(); b.server.close(() => r()); }));
  const post = async (p, body) => {
    const res = await fetch(`http://127.0.0.1:${b.port}${p}`, { method: 'POST', headers: { 'x-thread-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { ...b, post, batch: (items) => post(`/api/p/${core.projectKey(e.projectDir)}/waits/answer-batch`, { items }) };
}

/** Two cards; PARENT_SESSION asked a question, a choice and a review on c1 and a to-do on c2; OTHER_SESSION asked a to-do on c2. */
async function world(t) {
  const e = setupThreadEnv(t);
  await core.addCard(e.projectDir, { title: 'Fix the importer' });
  await core.addCard(e.projectDir, { title: 'Ship rates' });
  const ask = (card, kind, text, sessionId, extra = {}) => core.addWait(e.projectDir, { card, kind, text, sessionId, ...extra });
  await ask('c1', 'question', 'Which retry limit?', PARENT_SESSION);
  await ask('c1', 'choice', 'Pick one', PARENT_SESSION, { choices: ['a', 'b', 'c'] });
  await ask('c1', 'review', 'Check the diff', PARENT_SESSION);
  await ask('c2', 'todo', 'Run the migration', PARENT_SESSION);
  await ask('c2', 'todo', 'Theirs', OTHER_SESSION);
  return e;
}
const ALL = [
  { id: 'c1.w1', text: '  5  ' },
  { id: 'c1.w2', choices: ['b'], comment: 'the safe one' },
  { id: 'c1.w3', verdict: 'changes', comment: 'rename it' },
  { id: 'c2.w1', done: true },
  { id: 'c2.w2', done: true },
];

test('the batch answers every item with the same checks and stores as the single route, and returns what changed', async (t) => {
  const e = await world(t);
  const b = await board(t, e);
  const r = await b.batch(ALL);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.applied, ['c1.w1', 'c1.w2', 'c1.w3', 'c2.w1', 'c2.w2']);
  assert.deepEqual(r.body.skipped, []);
  assert.deepEqual(r.body.cards.map((c) => c.id), ['c1', 'c2'], 'each card once, as the page gets it from a single answer');
  assert.equal(r.body.cards[0].waits.find((w) => w.id === 'c1.w3').state, 'answered');
  assert.deepEqual(itemOf(e, 'c1.w1').answer, { text: '5' });
  assert.deepEqual(itemOf(e, 'c1.w2').answer, { choices: ['b'] });
  assert.equal(itemOf(e, 'c1.w2').comment, 'the safe one');
  assert.deepEqual(itemOf(e, 'c1.w3').answer, { verdict: 'changes' });
  for (const id of ['c1.w1', 'c1.w2', 'c1.w3', 'c2.w1', 'c2.w2']) {
    const w = itemOf(e, id);
    assert.equal(w.state, 'answered');
    assert.equal(w.answeredVia, 'board');
    assert.equal(w.deliveredAt, undefined, 'the board never marks an answer delivered');
  }
  assert.equal(new Set(['c1.w1', 'c1.w2', 'c1.w3', 'c2.w1', 'c2.w2'].map((id) => itemOf(e, id).answeredAt)).size, 1, 'one moment: they were applied in one pass');
  assert.equal(cardOf(e, 'c1').seenByClaude, true, 'an answer does not mark the card unseen');
  // the old route shape works too
  await core.addWait(e.projectDir, { card: 'c1', kind: 'todo', text: 'More', sessionId: PARENT_SESSION });
  const old = await b.post('/api/waits/answer-batch', { items: [{ id: 'c1.w4', done: true }] });
  assert.equal(old.status, 200, JSON.stringify(old.body));
});

test('all or nothing: one invalid item refuses the batch, names each bad item, and the file is not written', async (t) => {
  const e = await world(t);
  const b = await board(t, e);
  const before = fs.readFileSync(stateFile(e), 'utf8');
  const mtime = fs.statSync(stateFile(e)).mtimeMs;
  await sleep(20);
  const bad = await b.batch([
    { id: 'c1.w1', text: 'fine' },
    { id: 'c1.w2', choices: ['b', 'c'] },                 // a single choice with two picks
    { id: 'c1.w3', verdict: 'maybe' },
    { id: 'c2.w1', done: true },
    { id: 'c2.w2', done: false },
  ]);
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.match(bad.body.error, /^nothing was sent: /);
  assert.match(bad.body.error, /c1\.w2: choose exactly one option/);
  assert.match(bad.body.error, /c1\.w3: verdict must be one of: approve, changes/);
  assert.match(bad.body.error, /c2\.w2: done must be true/);
  assert.doesNotMatch(bad.body.error, /c1\.w1|c2\.w1/, 'the valid ones are not blamed');
  assert.equal(fs.readFileSync(stateFile(e), 'utf8'), before, 'not one byte changed');
  assert.equal(fs.statSync(stateFile(e)).mtimeMs, mtime, 'and the file was not written');
  // the shapes the route refuses outright
  const refused = [
    [[], /items must be a list of answers/],
    [[{ id: 'c1.w1', text: 'x' }, { id: 'c1.w1', text: 'y' }], /c1\.w1: given twice/],
    [[{ id: 'nonsense', text: 'x' }], /item 1: not a waiting item id/],
    [[{ text: 'no id' }], /item 1: not a waiting item id/],
    [[{ id: 'c1.w1', text: 'x'.repeat(4001) }], /c1\.w1: the answer is too long/],
    [[{ id: 'c1.w1', text: 'x', comment: 'y'.repeat(2001) }], /c1\.w1: the comment is too long/],
    [[{ id: 'c1.w2', text: 'a choice takes choices' }], /c1\.w2: choices must be options of this item/],
    [Array.from({ length: 51 }, () => ({ id: 'c1.w1', text: 'x' })), /too many answers at once \(51, the limit is 50\)/],
  ];
  for (const [items, message] of refused) {
    const r = await b.batch(items);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, message);
  }
  const notAList = await b.post(`/api/p/${core.projectKey(e.projectDir)}/waits/answer-batch`, { items: 'c1.w1' });
  assert.equal(notAList.status, 400);
  assert.equal(fs.readFileSync(stateFile(e), 'utf8'), before, 'nothing above wrote anything');
});

test('an item answered or withdrawn meanwhile, or on a card that is gone, is reported and left alone; the rest is applied', async (t) => {
  const e = await world(t);
  const b = await board(t, e);
  await core.answerWait(e.projectDir, 'c1', 'c1.w1', { text: 'from another tab' });
  await core.closeWait(e.projectDir, 'c1.w2', { withdraw: true });
  const taken = itemOf(e, 'c1.w1');
  const r = await b.batch([
    { id: 'c1.w1', text: 'my draft' },
    { id: 'c1.w2', choices: ['a'] },
    { id: 'c1.w3', verdict: 'approve' },
    { id: 'c9.w1', done: true },
    { id: 'c2.w1', done: true },
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.applied, ['c1.w3', 'c2.w1']);
  assert.deepEqual(r.body.skipped, [{ id: 'c1.w1', reason: 'answered' }, { id: 'c1.w2', reason: 'withdrawn' }, { id: 'c9.w1', reason: 'gone' }]);
  assert.deepEqual(itemOf(e, 'c1.w1'), taken, 'the answer given first stands');
  assert.equal(itemOf(e, 'c1.w2').state, 'withdrawn');
  assert.equal(itemOf(e, 'c1.w3').state, 'answered');
  // nothing left to apply is not an error either
  const none = await b.batch([{ id: 'c1.w1', text: 'again' }]);
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.applied, []);
  assert.deepEqual(none.body.cards, []);
});

test('a chat-only project refuses the batch', async (t) => {
  const e = await world(t);
  await core.saveConfig(e.projectDir, 'project', { mode: 'chat' });
  const b = await board(t, e);
  const r = await b.batch(ALL);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /chat-only/);
});

test('no reader ever sees half a batch', async (t) => {
  const e = setupThreadEnv(t);
  await core.addCard(e.projectDir, { title: 'Many' });
  for (let i = 1; i <= 20; i++) await core.addWait(e.projectDir, { card: 'c1', kind: 'todo', text: `todo ${i}`, sessionId: PARENT_SESSION });
  await core.addCard(e.projectDir, { title: 'Many more' });
  for (let i = 1; i <= 20; i++) await core.addWait(e.projectDir, { card: 'c2', kind: 'todo', text: `todo ${i}`, sessionId: PARENT_SESSION });
  const seen = new Set();
  let stop = false;
  const reader = (async () => {
    while (!stop) {
      try { seen.add(core.readState(e.projectDir).cards.flatMap((c) => core.waitsOf(c)).filter((w) => w.state === 'answered').length); } catch { /* mid-rename */ }
      await sleep(0);
    }
  })();
  const items = ['c1', 'c2'].flatMap((c) => Array.from({ length: 20 }, (_, i) => ({ id: `${c}.w${i + 1}`, done: true })));
  const r = await core.answerWaits(e.projectDir, items.slice(0, 40));
  stop = true;
  await reader;
  assert.equal(r.applied.length, 40);
  seen.add(40);
  assert.deepEqual([...seen].sort((a, b) => a - b), [0, 40], `a reader saw ${[...seen].join(', ')} answered`);
});

test('the batch route has a body limit of its own: seventeen answers of the longest length go through, other routes keep 64 KB', async (t) => {
  const e = setupThreadEnv(t);
  await core.addCard(e.projectDir, { title: 'Many' });
  for (let i = 1; i <= 17; i++) await core.addWait(e.projectDir, { card: 'c1', kind: 'question', text: `question ${i}`, sessionId: PARENT_SESSION });
  const b = await board(t, e);
  const items = Array.from({ length: 17 }, (_, i) => ({ id: `c1.w${i + 1}`, text: String.fromCharCode(97 + (i % 26)).repeat(core.MAX_ANSWER) }));
  assert.ok(JSON.stringify({ items }).length > 64 * 1024, 'more than the usual limit');
  const r = await b.batch(items);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.applied.length, 17);
  assert.equal(itemOf(e, 'c1.w17').answer.text.length, core.MAX_ANSWER);
  // another route refuses the same size
  const big = await b.post('/api/cards/c1/waits/c1.w1', { text: 'x'.repeat(70 * 1024) });
  assert.equal(big.status, 413);
  assert.match(big.body.error, /limit 64 KB/);
});

test('a full batch of fifty, each with the longest comment, goes through; a body past the batch limit is refused with 413', async (t) => {
  const e = setupThreadEnv(t);
  for (const c of ['c1', 'c2', 'c3']) await core.addCard(e.projectDir, { title: `Card ${c}` });
  const ids = [];
  for (const [c, n] of [['c1', 20], ['c2', 20], ['c3', 10]]) {
    for (let i = 1; i <= n; i++) { await core.addWait(e.projectDir, { card: c, kind: 'review', text: `review ${c} ${i}`, sessionId: PARENT_SESSION }); ids.push(`${c}.w${i}`); }
  }
  assert.equal(ids.length, core.MAX_BATCH);
  const b = await board(t, e);
  const items = ids.map((id) => ({ id, verdict: 'approve', comment: 'é'.repeat(core.MAX_COMMENT) }));
  const r = await b.batch(items);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.applied.length, 50);
  const tooBig = await b.post(`/api/p/${core.projectKey(e.projectDir)}/waits/answer-batch`, { items: [{ id: 'c1.w1', text: 'x'.repeat(2 * 1024 * 1024) }] });
  assert.equal(tooBig.status, 413);
  assert.match(tooBig.body.error, /request body too large \(limit \d/);
});

test('each session gets only its own answers, all of them in one turn, and the others are not carried', async (t) => {
  const e = await world(t);
  const b = await board(t, e);
  assert.equal((await b.batch(ALL)).status, 200);
  const mine = context(await hook(e, PARENT_SESSION)).split('\n');
  assert.equal(mine.length, 4, mine.join('\n'));
  assert.match(mine[0], /^The user answered c1\.w1 on the board \("Which retry limit\?"\): "5"\. Continue with it\.$/);
  assert.match(mine[1], /^The user answered c1\.w2 on the board \("Pick one"\): chose "b", with the comment "the safe one"\./);
  assert.match(mine[2], /^The user answered c1\.w3 on the board \("Check the diff"\): asked for changes, with the comment "rename it"\./);
  assert.match(mine[3], /^The user answered c2\.w1 on the board \("Run the migration"\): did it\./);
  assert.equal(context(await hook(e, PARENT_SESSION)), '', 'once');
  const theirs = context(await hook(e, OTHER_SESSION));
  assert.match(theirs, /^The user answered c2\.w2 on the board \("Theirs"\): did it\. Continue with it\.$/);
  assert.equal(itemOf(e, 'c2.w2').deliveredAt !== undefined, true);
});

test('the single-answer route still works beside it, for a page from before', async (t) => {
  const e = await world(t);
  const b = await board(t, e);
  const one = await b.post('/api/cards/c1/waits/c1.w1', { text: 'single' });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  const r = await b.batch([{ id: 'c1.w2', choices: ['a'] }]);
  assert.deepEqual(r.body.applied, ['c1.w2']);
  const again = await b.post('/api/cards/c1/waits/c1.w1', { text: 'second' });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /c1\.w1 is answered, not open/);
});

// ---------------------------------------------------------------- an older version

const ANSWER_WRITER = path.join(TEST_DIR, 'fixtures', 'old-answer-writer.mjs');

for (const ref of RELEASED_REFS) test(`the plugin version at ${ref} answers a single item beside answers sent as a batch, and keeps them`, async (t) => {
  const old = oldServerFrom(t, ref);
  if (!old) return;
  const e = await world(t);
  await core.answerWaits(e.projectDir, [{ id: 'c1.w1', text: 'five' }, { id: 'c1.w2', choices: ['c'] }]);
  const before = JSON.parse(JSON.stringify(core.waitsOf(cardOf(e, 'c1')).filter((w) => w.state === 'answered')));
  const r = await runNode([ANSWER_WRITER, old, e.projectDir, 'c2', 'c2.w1'], { env: { ...process.env, THREAD_DATA_DIR: e.dataDir } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(cardOf(e, 'c2').title, 'Renamed by the older version');
  assert.deepEqual(core.waitsOf(cardOf(e, 'c1')).filter((w) => w.state === 'answered'), before, 'the batch answers are as they were');
  if (r.stdout.trim() === 'answered') {
    assert.equal(itemOf(e, 'c2.w1').state, 'answered');
    // the answer the older version gave is delivered the usual way
    assert.match(context(await hook(e, PARENT_SESSION)), /The user answered c1\.w1[^]*The user answered c1\.w2[^]*The user answered c2\.w1/);
  }
});
