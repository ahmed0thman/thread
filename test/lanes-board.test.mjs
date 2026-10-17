// Delegation lanes, stage 3: choosing a card's lane on the board (the card page's Lane select and the start step's lane choice).
// The delegate skills and the relays are fakes (test/fake-delegate); no real provider CLI and no real claude CLI is ever started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupThreadEnv, cleanAmbientEnv, waitFor, PARENT_SESSION, FAKE_DELEGATE, writeStateFile, emptyState, threadCard } from './helpers.mjs';
import * as core from '../server/core.mjs';
import { clearLanesCache } from '../server/lanes.mjs';
import { startBoardServer, closeBoardServer } from '../server/http.mjs';

cleanAmbientEnv();

const card = (dir, id = 'c1') => core.readState(dir).cards.find((c) => c.id === id);
const untilIdle = (e, id) => waitFor(() => card(e.projectDir, id)?.thread?.runState === 'idle', { timeout: 8000 });

function setup(t, delegateMode = 'ok') {
  cleanAmbientEnv();
  clearLanesCache();
  t.after(clearLanesCache);
  const e = setupThreadEnv(t, { THREAD_DELEGATE_DIR: FAKE_DELEGATE, FAKE_DELEGATE_MODE: delegateMode, FAKE_RELAY_MODE: 'ok' });
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

test('the board sets a card\'s lane with the card update, and takes it off again', async (t) => {
  const e = setup(t);
  const b = await boot(t, e);
  await core.addCard(e.projectDir, { title: 'Fix it', note: 'The note.' });
  let r = await b.patch('c1', { lane: 'code-codex' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.lane, 'code-codex');
  assert.equal(card(e.projectDir).lane, 'code-codex');
  r = await b.patch('c1', { lane: 'ui-open', title: 'Fix it now' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.lane, r.body.title], ['ui-open', 'Fix it now'], 'a lane changes with other fields in one save');
  r = await b.patch('c1', { lane: null });
  assert.equal(r.status, 200);
  assert.equal('lane' in r.body, false);
  assert.equal('lane' in card(e.projectDir), false);
  await b.patch('c1', { lane: 'code-codex' });
  r = await b.patch('c1', { lane: '' });
  assert.equal(r.status, 200);
  assert.equal('lane' in card(e.projectDir), false, 'an empty name takes it off too');
  r = await b.patch('c1', { lane: null });
  assert.equal(r.status, 200, 'taking off a lane the card does not have is no error');
});

test('an idea can have a lane too; a milestone and a thread cannot, and a new card is not given one', async (t) => {
  const e = setup(t);
  const b = await boot(t, e);
  await core.addCard(e.projectDir, { title: 'An idea', kind: 'idea' });
  await core.addCard(e.projectDir, { title: 'A milestone', kind: 'milestone' });
  assert.equal((await b.patch('c1', { lane: 'code-codex' })).status, 200);
  const ms = await b.patch('c2', { lane: 'code-codex' });
  assert.equal(ms.status, 400);
  assert.match(ms.body.error, /a milestone cannot have a lane/);
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [...core.readState(e.projectDir).cards, threadCard({ id: 'c3', title: 'A thread', status: 'review' })]));
  const th = await b.patch('c3', { lane: 'code-codex' });
  assert.equal(th.status, 400);
  assert.match(th.body.error, /a thread's lane is chosen when it starts/);
  assert.equal('lane' in card(e.projectDir, 'c2'), false);
  assert.equal('lane' in card(e.projectDir, 'c3'), false);
  const made = await b.post('cards', { title: 'New', lane: 'code-codex' });
  assert.equal(made.status, 400);
  assert.match(made.body.error, /unknown key lane/);
  assert.equal(core.readState(e.projectDir).cards.length, 3);
});

test('a lane that is unknown, not approved, or not a name is refused with its reason, and the rest of the save is not written', async (t) => {
  const e = setup(t, 'untrusted');
  const b = await boot(t, e);
  await core.addCard(e.projectDir, { title: 'Keep me' });
  const before = JSON.stringify(card(e.projectDir));
  let r = await b.patch('c1', { lane: 'nope', title: 'Changed' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /^unknown lane "nope"; valid lanes: code-codex, ui-open, review-ro, agy-fast, claude-edit$/);
  r = await b.patch('c1', { lane: 'review-ro', title: 'Changed' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /^lane "review-ro" is not approved; approve this project's lane config with the delegate-setup skill$/);
  for (const lane of [7, ['code-codex'], { name: 'code-codex' }]) {
    r = await b.patch('c1', { lane });
    assert.equal(r.status, 400, JSON.stringify(lane));
    assert.match(r.body.error, /^lane must be a lane name/);
  }
  assert.equal(JSON.stringify(card(e.projectDir)), before, 'nothing was written');
  assert.equal((await b.patch('c1', { lane: 'code-codex' })).status, 200, 'a global lane is approved');
});

test('without the delegate skills a lane is refused, but one that is already there can be taken off', async (t) => {
  const e = setup(t);
  const b = await boot(t, e);
  await core.addCard(e.projectDir, { title: 'Has one', lane: 'code-codex' });
  clearLanesCache();
  e.setEnv('THREAD_DELEGATE_DIR', path.join(e.base, 'no-skills'));
  let r = await b.patch('c1', { lane: 'ui-open' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /lanes need the delegate skills/);
  assert.equal(card(e.projectDir).lane, 'code-codex');
  r = await b.patch('c1', { lane: null });
  assert.equal(r.status, 200);
  assert.equal('lane' in card(e.projectDir), false);
});

test('a lane picked on the board starts the card on that lane, and with none picked it starts as a normal thread', async (t) => {
  const e = setup(t);
  const b = await boot(t, e);
  await core.addCard(e.projectDir, { title: 'On a lane', note: 'Do the lane thing.' });
  await core.addCard(e.projectDir, { title: 'Back to Claude', note: 'Do it on Claude.', lane: 'code-codex' });
  // what the page does on Start: save the chosen lane on the card, then start it
  assert.equal((await b.patch('c1', { lane: 'code-codex' })).status, 200);
  const started = await b.post('cards/c1/start', { sessionId: PARENT_SESSION, mode: 'read', context: 'brief' });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.thread.lane.name, 'code-codex');
  assert.equal('lane' in started.body, false, 'the thread holds the lane now');
  await untilIdle(e, 'c1');
  assert.equal(e.relays().length, 1);
  assert.equal(e.relays()[0].implementer, 'codex');
  assert.ok(e.relays()[0].brief.includes('Do the lane thing.'));
  // "Claude (no lane)": the lane comes off first, so the card starts as a normal thread on the fake claude
  assert.equal((await b.patch('c2', { lane: null })).status, 200);
  const plainStart = await b.post('cards/c2/start', { sessionId: PARENT_SESSION, mode: 'read', context: 'brief' });
  assert.equal(plainStart.status, 200, JSON.stringify(plainStart.body));
  assert.equal(plainStart.body.thread.lane, undefined);
  await untilIdle(e, 'c2');
  assert.equal(e.relays().length, 1, 'no relay ran for it');
});

test('a read-only lane picked on the board cannot be started for write, and its card keeps the lane', async (t) => {
  const e = setup(t);
  const b = await boot(t, e);
  await core.addCard(e.projectDir, { title: 'Review' });
  assert.equal((await b.patch('c1', { lane: 'review-ro' })).status, 200);
  const w = await b.post('cards/c1/start', { sessionId: PARENT_SESSION, mode: 'write', context: 'brief' });
  assert.equal(w.status, 400);
  assert.match(w.body.error, /is read-only/);
  assert.equal(card(e.projectDir).lane, 'review-ro');
  assert.equal(card(e.projectDir).kind, 'task');
});

test('the lanes route lists each lane with its approval and relay, which is what the Lane select is made of', async (t) => {
  const e = setup(t, 'untrusted');
  const b = await boot(t, e);
  const r = await b.get('lanes');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.lanes.map((l) => [l.name, l.approved, l.relay]), [
    ['code-codex', true, true], ['ui-open', true, true], ['review-ro', false, true], ['agy-fast', false, true], ['claude-edit', true, true],
  ]);
});

// ------------------------------------------------------------ what the start must still find, and a lane that is not a name

test('Start refuses with a 409 when the card\'s lane is not the one the page showed, and nothing starts; with no expectLane it is as before', async (t) => {
  const e = setup(t);
  const b = await boot(t, e);
  await core.addCard(e.projectDir, { title: 'Laned', note: 'Look at it.', lane: 'code-codex' });
  await core.addCard(e.projectDir, { title: 'Bare', note: 'Look at it too.' });
  const go = (id, expectLane) => b.post(`cards/${id}/start`, { sessionId: PARENT_SESSION, mode: 'read', context: 'brief', ...(expectLane === undefined ? {} : { expectLane }) });
  // the page showed ui-open; the card has code-codex (Claude changed it, or a pull did)
  let r = await go('c1', 'ui-open');
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /^the card's lane changed since you looked at it/);
  // the page showed no lane; the card has one
  r = await go('c1', null);
  assert.equal(r.status, 409);
  // the page showed a lane; the card has none
  r = await go('c2', 'code-codex');
  assert.equal(r.status, 409);
  assert.equal(card(e.projectDir, 'c1').kind, 'task');
  assert.equal(card(e.projectDir, 'c2').kind, 'task');
  assert.equal(card(e.projectDir, 'c1').lane, 'code-codex', 'a refused start leaves the card as it was');
  assert.equal(e.relays().length, 0, 'nothing ran');
  // a wrong type is a plain 400
  r = await go('c1', 5);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /^expectLane must be a lane name or null/);
  // the lane that was shown: it starts, on that lane, and the bare card starts as a normal thread
  r = await go('c1', 'code-codex');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.thread.lane.name, 'code-codex');
  r = await go('c2', null);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.thread.lane, undefined);
  await untilIdle(e, 'c1');
  await untilIdle(e, 'c2');
  assert.equal(e.relays().length, 1);
  // an older page sends no expectLane: the card's own lane runs, as before
  await core.addCard(e.projectDir, { title: 'Older page', note: 'n', lane: 'ui-open' });
  r = await go('c3');
  assert.equal(r.status, 200);
  assert.equal(r.body.thread.lane.name, 'ui-open');
  await untilIdle(e, 'c3');
});

test('a lane that is not a name (a card file written by hand) is left out of what the page gets, is not removed by a save, and the card starts without it', async (t) => {
  const e = setup(t);
  const b = await boot(t, e);
  for (const bad of [5, ['code-codex'], { name: 'code-codex' }, true]) {
    writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [
      { id: 'c1', kind: 'task', title: 'Pulled', note: 'Do it.', status: 'new', source: 'user', seenByClaude: true, lane: bad, createdAt: 'x', updatedAt: 'x' },
    ]));
    const view = (await b.get('state')).body.cards.find((c) => c.id === 'c1');
    assert.equal('lane' in view, false, `${JSON.stringify(bad)} is not shown to the page`);
    const r = await b.patch('c1', { title: 'Pulled, renamed' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(card(e.projectDir).lane, bad, 'a save that sends no lane leaves what the file holds');
  }
  const started = await b.post('cards/c1/start', { sessionId: PARENT_SESSION, mode: 'read', context: 'brief', expectLane: null });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.thread.lane, undefined, 'a lane that is not a name is no lane');
  await untilIdle(e, 'c1');
  assert.equal(e.relays().length, 0);
});
