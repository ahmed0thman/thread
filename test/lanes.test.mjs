// Delegation lanes, stage 1: reading them from the delegate skills, labelling cards with them, and serving them.
// The real delegate skills are never used: THREAD_DELEGATE_DIR points at test/fake-delegate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupThreadEnv, cleanAmbientEnv, McpClient, FAKE_DELEGATE, writeStateFile, emptyState, threadCard } from './helpers.mjs';
import * as core from '../server/core.mjs';
import { listLanes, clearLanesCache } from '../server/lanes.mjs';
import { startBoardServer } from '../server/http.mjs';

cleanAmbientEnv();

const NONE = { available: false, projectTrusted: false, lanes: [] };
const withFake = (mode, extra = {}) => ({ THREAD_DELEGATE_DIR: FAKE_DELEGATE, FAKE_DELEGATE_MODE: mode, ...extra });
const plain = (x) => JSON.parse(JSON.stringify(x));

function setup(t, mode = 'ok', extra = {}) {
  clearLanesCache();
  t.after(clearLanesCache);
  return setupThreadEnv(t, withFake(mode, extra));
}

function mcp(t, e) {
  const c = new McpClient(e);
  t.after(() => c.kill());
  return c;
}

// ------------------------------------------------------------ listLanes

test('listLanes returns the four providers\' lanes in the shape the page needs, and drops the others', async (t) => {
  const e = setup(t);
  const r = plain(await listLanes(e.projectDir));
  assert.equal(r.available, true);
  assert.equal(r.projectTrusted, true);
  assert.deepEqual(r.lanes.map((l) => l.name), ['code-codex', 'ui-open', 'review-ro', 'agy-fast', 'claude-edit'], 'a grok lane is not one of the four providers');
  assert.deepEqual(r.lanes[0], { name: 'code-codex', implementer: 'codex', model: 'gpt-fake', effort: 'high', variant: null, readOnly: false, sandbox: null, source: 'global', approved: true });
  assert.deepEqual(r.lanes[1], { name: 'ui-open', implementer: 'opencode', model: 'vendor/model-x', effort: null, variant: 'max', readOnly: false, sandbox: null, source: 'global', approved: true });
  assert.equal(r.lanes[2].readOnly, true);
  assert.equal(r.lanes[3].model, 'gemini-fake');
});

test('listLanes marks project lanes not approved when the project config is not trusted, and global ones stay approved', async (t) => {
  const e = setup(t, 'untrusted');
  const r = await listLanes(e.projectDir);
  assert.equal(r.available, true);
  assert.equal(r.projectTrusted, false);
  assert.deepEqual(r.lanes.map((l) => [l.name, l.source, l.approved]), [
    ['code-codex', 'global', true], ['ui-open', 'global', true], ['review-ro', 'project', false], ['agy-fast', 'project', false], ['claude-edit', 'global', true],
  ]);
});

test('listLanes never throws: missing skills, a failing script, garbage and a hang all give "not available"', async (t) => {
  const e = setup(t, 'ok');
  e.setEnv('THREAD_DELEGATE_DIR', path.join(e.base, 'no-such-skills'));
  assert.deepEqual(plain(await listLanes(e.projectDir)), NONE, 'script missing');
  for (const mode of ['fail', 'garbage']) {
    clearLanesCache();
    e.setEnv('THREAD_DELEGATE_DIR', FAKE_DELEGATE);
    e.setEnv('FAKE_DELEGATE_MODE', mode);
    assert.deepEqual(plain(await listLanes(e.projectDir)), NONE, mode);
  }
  clearLanesCache();
  e.setEnv('FAKE_DELEGATE_MODE', 'hang');
  const t0 = Date.now();
  assert.deepEqual(plain(await listLanes(e.projectDir, { timeoutMs: 300 })), NONE, 'timeout');
  assert.ok(Date.now() - t0 < 4000, 'the hang is cut short');
});

test('listLanes asks the delegate script once per project folder within the cache time, and again after it', async (t) => {
  const e = setup(t);
  const log = path.join(e.base, 'delegate.log');
  e.setEnv('FAKE_DELEGATE_LOG', log);
  const runs = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0);
  const [a, b] = await Promise.all([listLanes(e.projectDir), listLanes(e.projectDir)]);
  assert.equal(a, b, 'a call made while the first is running shares it');
  await listLanes(e.projectDir);
  assert.equal(runs(), 1);
  const line = fs.readFileSync(log, 'utf8').trim();
  assert.equal(line, `load --cwd ${e.projectDir}`);
  await listLanes(path.join(e.base, 'other-project'));
  assert.equal(runs(), 2, 'another folder is another entry');
  await listLanes(e.projectDir, { ttlMs: 0 });
  assert.equal(runs(), 3, 'an entry older than the cache time is asked for again');
});

// ------------------------------------------------------------ store

test('a card\'s lane is stored by name on tasks and ideas, never on milestones or threads, and updates keep or clear it', async (t) => {
  const e = setup(t);
  const task = await core.addCard(e.projectDir, { title: 'T', lane: 'code-codex' });
  assert.equal(task.lane, 'code-codex');
  const idea = await core.addCard(e.projectDir, { title: 'I', kind: 'idea', lane: ' ui-open ' });
  assert.equal(idea.lane, 'ui-open');
  await assert.rejects(core.addCard(e.projectDir, { title: 'M', kind: 'milestone', lane: 'x' }), /milestone cannot have a lane/);
  assert.equal((await core.addCard(e.projectDir, { title: 'none', lane: '' })).lane, undefined);
  const kept = await core.updateCard(e.projectDir, task.id, { title: 'T2' });
  assert.equal(kept.lane, 'code-codex', 'an update that does not mention the lane keeps it');
  assert.equal((await core.updateCard(e.projectDir, task.id, { lane: 'ui-open' })).lane, 'ui-open');
  const cleared = await core.updateCard(e.projectDir, task.id, { lane: '' });
  assert.equal('lane' in cleared, false);
  const ms = await core.addCard(e.projectDir, { title: 'M', kind: 'milestone' });
  await assert.rejects(core.updateCard(e.projectDir, ms.id, { lane: 'x' }), /milestone cannot have a lane/);
});

test('cross-version: a card with a lane survives updates, moves, reads that mark it seen and a reconcile, and so does a field this version does not know', async (t) => {
  const e = setup(t);
  const thr = threadCard({ id: 'c2', title: 'A thread' });
  const old = { id: 'c1', kind: 'task', title: 'Old', note: '', status: 'new', source: 'claude', seenByClaude: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', lane: 'code-codex', futureField: { keep: true } };
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [old, thr]));
  await core.updateCard(e.projectDir, 'c1', { note: 'edited' });
  await core.updateCard(e.projectDir, 'c1', { status: 'in_progress' });
  await core.updateCard(e.projectDir, 'c1', { parent: '' });
  await core.markSeen(e.projectDir);
  await core.reconcile(e.projectDir);
  const c = core.readState(e.projectDir).cards.find((x) => x.id === 'c1');
  assert.equal(c.lane, 'code-codex');
  assert.deepEqual(c.futureField, { keep: true });
  assert.equal(c.note, 'edited');
});

// ------------------------------------------------------------ board_add and board_update

test('board_add and board_update take a valid lane, show it, and clear it with an empty string', async (t) => {
  const e = setup(t);
  const c = mcp(t, e);
  await c.init();
  const added = await c.call('board_add', { title: 'Build the parser', lane: 'code-codex' });
  assert.equal(added.isError, false, added.text);
  assert.match(added.text, /, lane code-codex\./);
  const id = added.text.match(/\bc\d+\b/)[0];
  assert.equal(core.readState(e.projectDir).cards[0].lane, 'code-codex');
  const idea = await c.call('board_add', { title: 'Maybe a cache', kind: 'idea', lane: 'ui-open' });
  assert.equal(idea.isError, false, idea.text);
  const listed = (await c.call('board_list')).text;
  assert.ok(listed.includes(`- ${id} [task] Build the parser {lane: code-codex}`), listed);
  assert.ok(listed.includes('Maybe a cache {lane: ui-open}'), listed);
  const moved = await c.call('board_update', { id, lane: 'ui-open' });
  assert.equal(moved.isError, false, moved.text);
  assert.match(moved.text, /lane ui-open/);
  const same = await c.call('board_update', { id, note: 'only a note' });
  assert.match(same.text, /lane ui-open/, 'an update without lane keeps it');
  const cleared = await c.call('board_update', { id, lane: '' });
  assert.equal(cleared.isError, false, cleared.text);
  assert.ok(!cleared.text.includes('lane'));
  assert.equal(core.readState(e.projectDir).cards.find((x) => x.id === id).lane, undefined);
  assert.ok(!(await c.call('board_list')).text.includes(`${id} [task] Build the parser {lane`));
});

test('board_add and board_update refuse a bad lane with a one-line message that says what to do', async (t) => {
  const e = setup(t, 'untrusted');
  const c = mcp(t, e);
  await c.init();
  const base = await c.call('board_add', { title: 'Plain' });
  const id = base.text.match(/\bc\d+\b/)[0];
  const ms = (await c.call('board_add', { title: 'Group', kind: 'milestone' })).text.match(/\bc\d+\b/)[0];
  const refuse = async (tool, args, re) => {
    const r = await c.call(tool, args);
    assert.equal(r.isError, true, `${tool} ${JSON.stringify(args)} was accepted: ${r.text}`);
    assert.ok(!r.text.includes('\n'), 'one line');
    assert.match(r.text, re);
  };
  await refuse('board_add', { title: 'x', kind: 'milestone', lane: 'code-codex' }, /milestone cannot have a lane/);
  await refuse('board_update', { id: ms, lane: 'code-codex' }, /milestone cannot have a lane/);
  await refuse('board_add', { title: 'x', lane: 'nope' }, /unknown lane "nope"; valid lanes: code-codex, ui-open, review-ro, agy-fast, claude-edit/);
  await refuse('board_update', { id, lane: 'nope' }, /unknown lane "nope"; valid lanes: code-codex/);
  await refuse('board_add', { title: 'x', lane: 'review-ro' }, /lane "review-ro" is not approved; approve this project's lane config with the delegate-setup skill/);
  await refuse('board_update', { id, lane: 'agy-fast' }, /not approved; approve this project's lane config with the delegate-setup skill/);
  await refuse('board_update', { id: 'c999', lane: 'code-codex' }, /not found/);
  assert.equal(core.readState(e.projectDir).cards.length, 2, 'a refused add leaves no card');
  assert.equal(core.readState(e.projectDir).cards.find((x) => x.id === id).lane, undefined);
  // a thread card cannot have one either
  const thr = threadCard({ id: 'c9', title: 'A thread' });
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [...core.readState(e.projectDir).cards, thr]));
  await refuse('board_update', { id: 'c9', lane: 'code-codex' }, /lane is chosen when it starts/);
});

test('without the delegate skills every lane is refused, and cards without a lane work as before', async (t) => {
  const e = setup(t, 'fail');
  const c = mcp(t, e);
  await c.init();
  const r = await c.call('board_add', { title: 'x', lane: 'code-codex' });
  assert.equal(r.isError, true);
  assert.match(r.text, /delegate skills.*not found/);
  assert.equal((await c.call('board_add', { title: 'fine' })).isError, false);
  const id = core.readState(e.projectDir).cards[0].id;
  assert.equal((await c.call('board_update', { id, lane: '' })).isError, false, 'removing a lane needs no skills');
  assert.equal((await c.call('board_update', { id, lane: 'code-codex' })).isError, true);
});

test('tools/list describes the lane argument of board_add and board_update', async (t) => {
  const e = setup(t);
  const c = mcp(t, e);
  await c.init();
  const tools = (await c.request('tools/list', {})).result.tools;
  for (const name of ['board_add', 'board_update']) {
    const tool = tools.find((x) => x.name === name);
    assert.equal(tool.inputSchema.properties.lane.type, 'string', name);
  }
});

// ------------------------------------------------------------ http

async function boot(t, mode = 'ok', token = 'ab'.repeat(16)) {
  const e = setup(t, mode);
  const b = await startBoardServer(e.projectDir, { port: 0, token });
  t.after(() => new Promise((r) => { b.server.closeAllConnections?.(); b.server.close(() => r()); }));
  const base = `http://127.0.0.1:${b.port}`;
  const key = (await (await fetch(`${base}/api/projects`, { headers: { 'X-Thread-Token': token } })).json()).projects[0].key;
  return { ...e, base, key, token };
}

test('GET /api/p/<key>/lanes serves the lanes behind the token, and nothing on the board writes one', async (t) => {
  const b = await boot(t);
  const url = `${b.base}/api/p/${b.key}/lanes`;
  const none = await fetch(url);
  assert.equal(none.status, 401);
  assert.equal((await fetch(url, { headers: { 'X-Thread-Token': 'wrong' } })).status, 401);
  const r = await fetch(url, { headers: { 'X-Thread-Token': b.token } });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.available, true);
  assert.equal(data.lanes.length, 5);
  assert.equal(data.lanes[0].name, 'code-codex');
  assert.equal((await fetch(`${b.base}/api/p/nonesuch00000/lanes`, { headers: { 'X-Thread-Token': b.token } })).status, 404);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'X-Thread-Token': b.token, 'content-type': 'application/json' }, body: '{}' })).status, 404, 'read-only route');
  // a lane in a write body does not reach the card: the board has no way to set one (a new card ignores it, PATCH refuses the key)
  const H = { 'X-Thread-Token': b.token, 'content-type': 'application/json' };
  const made = await (await fetch(`${b.base}/api/p/${b.key}/cards`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'Via board', lane: 'code-codex' }) })).json();
  assert.equal(made.lane, undefined);
  const patched = await (await fetch(`${b.base}/api/p/${b.key}/cards/${made.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ note: 'n', lane: 'code-codex' }) })).json();
  assert.equal(patched.lane, undefined);
});

test('GET /api/p/<key>/lanes answers "not available" when the delegate skills are absent or broken, and shows a stored lane on a card', async (t) => {
  const b = await boot(t, 'fail');
  const data = await (await fetch(`${b.base}/api/p/${b.key}/lanes`, { headers: { 'X-Thread-Token': b.token } })).json();
  assert.deepEqual(data, NONE);
  await core.addCard(b.projectDir, { title: 'Has lane', lane: 'code-codex' });
  const state = await (await fetch(`${b.base}/api/p/${b.key}/state`, { headers: { 'X-Thread-Token': b.token } })).json();
  assert.equal(state.cards[0].lane, 'code-codex', 'the state view carries the stored lane');
});

test('a codex lane\'s sandbox dial is kept, and a read-only sandbox makes the lane read-only', async (t) => {
  const e = setup(t, 'ok', { FAKE_DELEGATE_SANDBOX: 'danger-full-access' });
  let lane = (await listLanes(e.projectDir)).lanes.find((l) => l.name === 'code-codex');
  assert.equal(lane.sandbox, 'danger-full-access');
  assert.equal(lane.readOnly, false);
  clearLanesCache();
  e.setEnv('FAKE_DELEGATE_SANDBOX', 'read-only');
  lane = (await listLanes(e.projectDir)).lanes.find((l) => l.name === 'code-codex');
  assert.equal(lane.readOnly, true);
  clearLanesCache();
  e.setEnv('FAKE_DELEGATE_SANDBOX', 'not-a-sandbox');
  assert.equal((await listLanes(e.projectDir)).lanes.find((l) => l.name === 'code-codex').sandbox, null, 'a value that is not a sandbox is dropped');
  assert.equal((await listLanes(e.projectDir)).lanes.find((l) => l.name === 'agy-fast').sandbox, null, 'only codex has the dial');
});
