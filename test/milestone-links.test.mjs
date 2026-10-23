// The Milestones map's hand-made parts: the links a milestone has to other milestones (`dependsOn`), and where the owner dragged the
// milestones (the layout, kept on this machine). Validation, the MCP tools, the board's routes, the layout store, and older plugin versions.
// The repo-backed side is in repo.test.mjs, the tunnel's refusal in tunnel.test.mjs, the page in milestones-map.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  setupThreadEnv, cleanAmbientEnv, McpClient, runNode, waitFor, writeStateFile, emptyState, oldServerFrom, RELEASED_REFS, PARENT_SESSION, TEST_DIR,
} from './helpers.mjs';
import * as core from '../server/core.mjs';
import { startBoardServer } from '../server/http.mjs';

cleanAmbientEnv();

const TOKEN = 'a'.repeat(32);
const JSON_HDR = { 'content-type': 'application/json', 'x-thread-token': TOKEN };
const cardOf = (e, id) => core.readState(e.projectDir).cards.find((c) => c.id === id);
const rejects = (p, re) => assert.rejects(p, re);

/** Three milestones M1 to M3, and a task in M3 and one in M1. */
async function shop(e) {
  const m1 = await core.addCard(e.projectDir, { title: 'M1: Payments', kind: 'milestone' });
  const m2 = await core.addCard(e.projectDir, { title: 'M2: Checkout', kind: 'milestone' });
  const m3 = await core.addCard(e.projectDir, { title: 'M3: Launch', kind: 'milestone' });
  const t1 = await core.addCard(e.projectDir, { title: 'Take a card', parent: m1.id });
  const t3 = await core.addCard(e.projectDir, { title: 'Go live', parent: m3.id });
  return { m1: m1.id, m2: m2.id, m3: m3.id, t1: t1.id, t3: t3.id };
}

async function board(t, e) {
  const b = await startBoardServer(e.projectDir, { port: 0, token: TOKEN });
  t.after(() => new Promise((r) => { b.server.closeAllConnections?.(); b.server.close(() => r()); }));
  const base = `http://127.0.0.1:${b.port}`;
  const key = core.projectKey(e.projectDir);
  const api = async (method, p, body, headers = JSON_HDR) => {
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const P = `/api/p/${key}`;
  return {
    ...b, base, api, key, P,
    link: (id, body) => api('POST', `${P}/milestones/${id}/depends-on`, body),
    state: async () => (await api('GET', `${P}/state`)).body,
    setLayout: (set) => api('PUT', `${P}/milestone-layout`, { set }),
    resetLayout: () => api('DELETE', `${P}/milestone-layout`),
  };
}

function mcp(t, e) {
  const c = new McpClient(e);
  t.after(() => c.kill());
  return c;
}

// ---------------------------------------------------------------- the field

test('depends_on is checked: only milestones, other milestones, no repeats, at most 20; an empty list removes it and a default is not stored', async (t) => {
  const e = setupThreadEnv(t);
  const { m1, m2, m3, t1 } = await shop(e);
  await rejects(core.updateCard(e.projectDir, m2, { dependsOn: [m2] }), /depends_on: .* cannot depend on itself/);
  await rejects(core.updateCard(e.projectDir, m2, { dependsOn: [t1] }), new RegExp(`depends_on: ${t1} is not a milestone`));
  await rejects(core.updateCard(e.projectDir, m2, { dependsOn: ['c999'] }), /depends_on: milestone not found: c999/);
  await rejects(core.updateCard(e.projectDir, m2, { dependsOn: [m1, m1] }), new RegExp(`${m1} is given twice in depends_on`));
  await rejects(core.updateCard(e.projectDir, m2, { dependsOn: 'c1' }), /depends_on must be a list/);
  await rejects(core.updateCard(e.projectDir, m2, { dependsOn: ['M1'] }), /depends_on takes milestone card ids/);
  await rejects(core.updateCard(e.projectDir, m2, { dependsOn: Array.from({ length: 21 }, (_, i) => `c${i + 100}`) }), /depends_on has too many entries \(21, the limit is 20\)/);
  await rejects(core.updateCard(e.projectDir, t1, { dependsOn: [m1] }), /depends_on is only for milestones/);
  await rejects(core.addCard(e.projectDir, { title: 'A task', dependsOn: [m1] }), /depends_on is only for milestones/);
  assert.equal(cardOf(e, m2).dependsOn, undefined, 'a refused call writes nothing');
  // twenty is fine
  const many = [];
  for (let i = 0; i < 20; i++) many.push((await core.addCard(e.projectDir, { title: `Extra ${i}`, kind: 'milestone' })).id);
  assert.deepEqual((await core.updateCard(e.projectDir, m3, { dependsOn: many })).dependsOn, many);
  assert.equal((await core.updateCard(e.projectDir, m3, { dependsOn: [] })).dependsOn, undefined, 'an empty list removes it');
  const one = await core.updateCard(e.projectDir, m2, { dependsOn: [` ${m1} `] });
  assert.deepEqual(one.dependsOn, [m1], 'ids are trimmed');
  assert.deepEqual(core.cardById(core.readState(e.projectDir).cards, m2).history.at(-1).fields, ['depends on']);
  // a milestone made with links
  const made = await core.addCard(e.projectDir, { title: 'M4: After', kind: 'milestone', dependsOn: [m1, m2] });
  assert.deepEqual(made.dependsOn, [m1, m2]);
  // setting the same list again changes nothing
  const before = cardOf(e, m2).updatedAt;
  await core.updateCard(e.projectDir, m2, { dependsOn: [m1] });
  assert.equal(cardOf(e, m2).updatedAt, before);
  // removing it with null on a task is no error, and a task is never given the field
  assert.equal('dependsOn' in (await core.updateCard(e.projectDir, t1, { dependsOn: '' })), false);
});

test('links that would make a loop of hand links are refused with the loop named; a loop through card links is the map\'s to show', async (t) => {
  const e = setupThreadEnv(t);
  const { m1, m2, m3 } = await shop(e);
  await core.updateCard(e.projectDir, m2, { dependsOn: [m1] });
  await core.updateCard(e.projectDir, m3, { dependsOn: [m2] });
  await rejects(core.updateCard(e.projectDir, m1, { dependsOn: [m2] }), /that would make a loop of milestone links: .*M1: Payments.* would depend on .*M2: Checkout.*, which depends on .*M1: Payments/);
  await rejects(core.updateCard(e.projectDir, m1, { dependsOn: [m3] }), /would depend on .*M3: Launch.*, which depends on .*M2: Checkout.*, which depends on .*M1: Payments/);
  await rejects(core.changeMilestoneLink(e.projectDir, m1, { add: m3 }), /loop of milestone links/);
  assert.equal(cardOf(e, m1).dependsOn, undefined);
  // a diamond is not a loop
  const m4 = (await core.addCard(e.projectDir, { title: 'M4', kind: 'milestone', dependsOn: [m2, m3] })).id;
  assert.deepEqual(cardOf(e, m4).dependsOn, [m2, m3]);
  // card links that make a cycle do not stop a hand link: that is not the owner's drawing (and the map shows the cycle)
  const a = await core.addCard(e.projectDir, { title: 'Needs payments', parent: m2 });
  await core.updateCard(e.projectDir, (await core.addCard(e.projectDir, { title: 'Payments card', parent: m1 })).id, { blockedBy: [a.id] });
  await core.updateCard(e.projectDir, a.id, { blockedBy: [(core.readState(e.projectDir).cards.find((c) => c.title === 'Payments card')).id] });
  assert.ok((await core.changeMilestoneLink(e.projectDir, m4, { add: m1 })).dependsOn.includes(m1));
});

test('a link to a milestone that was removed is dropped with it, and a dangling id in a stored card is ignored and dropped by the next write', async (t) => {
  const e = setupThreadEnv(t);
  const { m1, m2, m3 } = await shop(e);
  await core.updateCard(e.projectDir, m3, { dependsOn: [m1, m2] });
  await core.removeCard(e.projectDir, m1);
  assert.deepEqual(cardOf(e, m3).dependsOn, [m2], 'removing a milestone takes the links to it away');
  await core.removeCard(e.projectDir, m2);
  assert.equal(cardOf(e, m3).dependsOn, undefined);
  // an older version removes a milestone and leaves the id behind: read as if it were not there
  const m4 = (await core.addCard(e.projectDir, { title: 'M4', kind: 'milestone' })).id;
  const stateFile = core.projectPaths(e.projectDir).state;
  const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  raw.cards.find((c) => c.id === m3).dependsOn = ['c777', m3, m4, 5, m4];
  fs.writeFileSync(stateFile, JSON.stringify(raw));
  assert.deepEqual(core.liveDependsOn(cardOf(e, m3), core.readState(e.projectDir).cards), [m4], 'gone ids, itself, a number and a repeat are left out');
  const b = await board(t, e);
  assert.deepEqual((await b.state()).cards.find((c) => c.id === m3).dependsOn, [m4]);
  // the next change of its links rebuilds them from the live ones
  const m5 = (await core.addCard(e.projectDir, { title: 'M5', kind: 'milestone' })).id;
  assert.deepEqual((await core.changeMilestoneLink(e.projectDir, m3, { add: m5 })).dependsOn, [m4, m5]);
});

test('a hand link gates nothing: its cards move to done and start as threads whatever the milestone it depends on has left', async (t) => {
  const e = setupThreadEnv(t);
  const { m1, m3, t1, t3 } = await shop(e);
  await core.updateCard(e.projectDir, m3, { dependsOn: [m1] });
  assert.equal(core.milestoneState(core.readState(e.projectDir).cards, m1, core.readConfig(e.projectDir)), 'open');
  const moved = await core.updateCard(e.projectDir, t3, { status: 'done' });
  assert.equal(moved.status, 'done', 'a card of M3 is finished while M1 is not');
  assert.equal(core.milestoneState(core.readState(e.projectDir).cards, m3, core.readConfig(e.projectDir)), 'done');
  assert.deepEqual(core.openBlockers(cardOf(e, t3), core.readState(e.projectDir).cards, core.readConfig(e.projectDir)), []);
  const t2 = await core.addCard(e.projectDir, { title: 'Another of M3', parent: m3 });
  const th = await core.startThreadFromCard(e.projectDir, t2.id, { sessionId: PARENT_SESSION });
  assert.equal(th.kind, 'thread', 'a card of the milestone starts as a thread');
  await waitFor(() => cardOf(e, t2.id).thread.runState !== 'running', { timeout: 15000 });
  assert.equal(cardOf(e, t1).status, 'new');
});

test('a loop that is already there (two clones each drew a link and git merged them) blocks no other change: only a new link that closes a loop is refused, and taking a link away never fails', async (t) => {
  const e = setupThreadEnv(t);
  const { m1, m2, m3 } = await shop(e);
  await core.changeMilestoneLink(e.projectDir, m2, { add: m1 });
  await core.changeMilestoneLink(e.projectDir, m2, { add: m3 });
  // the merge: M1 now depends on M2 as well
  const stateFile = core.projectPaths(e.projectDir).state;
  const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  raw.cards.find((c) => c.id === m1).dependsOn = [m2];
  fs.writeFileSync(stateFile, JSON.stringify(raw));
  const m4 = (await core.addCard(e.projectDir, { title: 'M4', kind: 'milestone' })).id;
  // another link of M2, or of M1, goes through; so does a rename, a replaced list that keeps the loop, and removing a link of the loop
  assert.deepEqual((await core.changeMilestoneLink(e.projectDir, m2, { add: m4 })).dependsOn, [m1, m3, m4]);
  assert.deepEqual((await core.updateCard(e.projectDir, m2, { dependsOn: [m1, m3] })).dependsOn, [m1, m3], 'the list without M4, loop kept');
  assert.deepEqual((await core.changeMilestoneLink(e.projectDir, m1, { add: m4 })).dependsOn, [m2, m4]);
  assert.equal((await core.updateCard(e.projectDir, m1, { title: 'M1 again' })).title, 'M1 again');
  // a new link that closes a loop is still refused
  await rejects(core.changeMilestoneLink(e.projectDir, m3, { add: m2 }), /loop of milestone links/);
  assert.deepEqual((await core.changeMilestoneLink(e.projectDir, m1, { remove: m2 })).dependsOn, [m4], 'taking the link away that closes the loop');
});

test('the layout keeps at most 200 places in all and refuses the 201st with a message; two places in one cell in the file never block a save', async (t) => {
  const e = setupThreadEnv(t);
  const ids = Array.from({ length: 201 }, (_, i) => `c${i + 1}`);
  const live = new Set(ids);
  const at = (i) => ({ col: i % 80, row: Math.floor(i / 80) });
  for (let i = 0; i < 200; i += 20) await core.setMilestoneLayout(e.projectDir, Object.fromEntries(ids.slice(i, i + 20).map((id, k) => [id, at(i + k)])), live);
  assert.equal(Object.keys(core.readMilestoneLayout(e.projectDir)).length, 200);
  await rejects(core.setMilestoneLayout(e.projectDir, { c201: at(200) }, live), /the map keeps at most 200 saved places/);
  assert.equal(Object.keys(core.readMilestoneLayout(e.projectDir)).length, 200, 'nothing was lost and nothing added');
  assert.ok(core.MAX_POSITIONS === 200);
  // moving one that is saved is still fine at the limit
  assert.equal((await core.setMilestoneLayout(e.projectDir, { c1: { col: 79, row: 5 } }, live)).c1.col, 79);
  // a file with two in one cell (a hand edit): the first keeps it, the other is read as not placed, and a save goes through
  const file = core.projectPaths(e.projectDir).layout;
  fs.writeFileSync(file, JSON.stringify({ version: 1, positions: { c1: { col: 3, row: 3 }, c2: { col: 3, row: 3 }, c3: { col: 4, row: 4 } } }));
  assert.deepEqual(core.readMilestoneLayout(e.projectDir), { c1: { col: 3, row: 3 }, c3: { col: 4, row: 4 } });
  const next = await core.setMilestoneLayout(e.projectDir, { c4: { col: 0, row: 0 } }, new Set(['c1', 'c2', 'c3', 'c4']));
  assert.deepEqual(next, { c1: { col: 3, row: 3 }, c3: { col: 4, row: 4 }, c4: { col: 0, row: 0 } });
});

// ---------------------------------------------------------------- MCP

test('board_add and board_update take depends_on for a milestone only, board_list shows it, and an empty list removes it', async (t) => {
  const e = setupThreadEnv(t);
  const c = mcp(t, e);
  await c.init();
  const text = (r) => { assert.equal(r.isError, false, r.text); return r.text; };
  text(await c.call('board_add', { title: 'M1: Payments', kind: 'milestone' }));
  text(await c.call('board_add', { title: 'M2: Checkout', kind: 'milestone' }));
  const [m1, m2] = core.readState(e.projectDir).cards.map((x) => x.id);
  text(await c.call('board_add', { title: 'M3: Launch', kind: 'milestone', depends_on: [m1, m2] }));
  const m3 = core.readState(e.projectDir).cards.find((x) => x.title.startsWith('M3')).id;
  assert.deepEqual(cardOf(e, m3).dependsOn, [m1, m2]);
  let list = text(await c.call('board_list'));
  assert.match(list, new RegExp(`^- ${m3} \\[milestone:empty\\] M3: Launch \\{depends on M1 \\(${m1}\\), M2 \\(${m2}\\)\\}`, 'm'));
  assert.doesNotMatch(list, new RegExp(`^- ${m1} .*depends on`, 'm'));
  // the by-hand links are shown beside a card's own marks
  const r = await c.call('board_update', { id: m3, depends_on: [m2] });
  assert.match(text(r), /Updated/);
  assert.deepEqual(cardOf(e, m3).dependsOn, [m2]);
  // refused: a task, a loop, an unknown milestone, itself, not a list
  const task = text(await c.call('board_add', { title: 'A task' }));
  const t1 = /Added (c\S+)/.exec(task)[1];
  assert.match((await c.call('board_add', { title: 'x', depends_on: [m1] })).text, /depends_on is only for milestones/);
  assert.match((await c.call('board_update', { id: t1, depends_on: [m1] })).text, /depends_on is only for milestones/);
  assert.match((await c.call('board_update', { id: m2, depends_on: [m3] })).text, /loop of milestone links/);
  assert.match((await c.call('board_update', { id: m2, depends_on: ['c9999'] })).text, /milestone not found: c9999/);
  assert.match((await c.call('board_update', { id: m2, depends_on: [m2] })).text, /cannot depend on itself/);
  assert.match((await c.call('board_update', { id: m2, depends_on: 'c1' })).text, /depends_on must be a list/);
  assert.match((await c.call('board_update', { id: m2, depends_on: Array.from({ length: 21 }, (_, i) => `c${i + 50}`) })).text, /too many entries/);
  // empty removes
  text(await c.call('board_update', { id: m3, depends_on: [] }));
  assert.equal(cardOf(e, m3).dependsOn, undefined);
  list = text(await c.call('board_list'));
  assert.doesNotMatch(list, /depends on/);
  // the tool descriptions say what it is and that it gates nothing
  const tools = (await c.request('tools/list', {})).result.tools;
  for (const name of ['board_add', 'board_update']) {
    const d = tools.find((x) => x.name === name).inputSchema.properties.depends_on;
    assert.equal(d.type, 'array');
    assert.match(d.description, /gate nothing/);
  }
  assert.match(tools.find((x) => x.name === 'board_list').description, /depends on M2 \(c4\)/);
});

test('board_list names a milestone with no number by its title, and the milestone report keeps the mark', async (t) => {
  const e = setupThreadEnv(t);
  const a = await core.addCard(e.projectDir, { title: 'Holiday sale, a long name that goes on and on', kind: 'milestone' });
  const b = await core.addCard(e.projectDir, { title: 'M2: Checkout', kind: 'milestone', dependsOn: [a.id] });
  const c = mcp(t, e);
  await c.init();
  assert.match((await c.call('board_list')).text, new RegExp(`\\{depends on Holiday sale, a long na… \\(${a.id}\\)\\}`));
  assert.match((await c.call('board_list', { parent: b.id })).text, new RegExp(`${b.id} \\[milestone:empty\\].*\\{depends on Holiday`));
});

// ---------------------------------------------------------------- the board's routes

test('POST depends-on adds and removes one link; the card comes back with it; refusals are 400 with the loop named; PATCH cannot set it', async (t) => {
  const e = setupThreadEnv(t);
  const { m1, m2, m3, t1 } = await shop(e);
  const b = await board(t, e);
  const added = await b.link(m2, { add: m1 });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.deepEqual(added.body.dependsOn, [m1]);
  assert.equal(added.body.kind, 'milestone');
  assert.deepEqual((await b.state()).cards.find((c) => c.id === m2).dependsOn, [m1]);
  assert.equal(cardOf(e, m2).seenByClaude, false, 'the owner changed it: Claude has not seen it');
  // the same twice, itself, a loop, a task, an unknown one, a bad body
  const twice = await b.link(m2, { add: m1 });
  assert.equal(twice.status, 400);
  assert.match(twice.body.error, /already depends on .* by a link drawn by hand/);
  assert.match((await b.link(m2, { add: m2 })).body.error, /cannot depend on itself/);
  const loop = await b.link(m1, { add: m2 });
  assert.equal(loop.status, 400);
  assert.match(loop.body.error, /loop of milestone links/);
  assert.match((await b.link(m2, { add: t1 })).body.error, /is not a milestone/);
  assert.match((await b.link(m2, { add: 'c999' })).body.error, /milestone not found/);
  assert.match((await b.link('c999', { add: m1 })).body.error, /milestone not found: c999/);
  assert.match((await b.link(t1, { add: m1 })).body.error, /milestone not found/, 'a task has no links');
  assert.equal((await b.link(m2, {})).status, 400);
  assert.equal((await b.link(m2, { add: m1, remove: m1 })).status, 400);
  assert.match((await b.link(m2, { add: 5 })).body.error, /add must be a string/);
  assert.match((await b.link(m2, { add: m3, other: 1 })).body.error, /unknown key other/);
  assert.match((await b.link(m2, { add: 'M1' })).body.error, /card id/);
  // removing: one that is there, and one that is not (it may come from cards)
  assert.match((await b.link(m3, { remove: m1 })).body.error, /has no link of its own to .*a link that comes from cards is changed by editing those cards/);
  const removed = await b.link(m2, { remove: m1 });
  assert.equal(removed.status, 200);
  assert.equal('dependsOn' in removed.body, false);
  assert.equal(cardOf(e, m2).dependsOn, undefined);
  // not on the card route: it has no such key
  const patch = await b.api('PATCH', `/api/cards/${m2}`, { dependsOn: [m1] });
  assert.equal(patch.status, 400);
  assert.match(patch.body.error, /unknown key dependsOn/);
  // the project-less legacy path does not have the routes either
  assert.equal((await b.api('POST', `/api/milestones/${m2}/depends-on`, { add: m1 })).status, 404);
});

test('the link routes need the token and an allowed origin, like every write, and refuse a chat-only project', async (t) => {
  const e = setupThreadEnv(t);
  const { m1, m2 } = await shop(e);
  const b = await board(t, e);
  const url = `${b.P}/milestones/${m2}/depends-on`;
  const noToken = await b.api('POST', `${b.P}/milestones/${m2}/depends-on`, { add: m1 }, { 'content-type': 'application/json' });
  assert.equal(noToken.status, 401);
  const wrongToken = await b.api('POST', `${b.P}/milestones/${m2}/depends-on`, { add: m1 }, { ...JSON_HDR, 'x-thread-token': 'b'.repeat(32) });
  assert.equal(wrongToken.status, 401);
  const evil = await fetch(b.base + url, { method: 'POST', headers: { ...JSON_HDR, origin: 'https://evil.example' }, body: JSON.stringify({ add: m1 }) });
  assert.equal(evil.status, 403);
  const evilLayout = await fetch(`${b.base}${b.P}/milestone-layout`, { method: 'PUT', headers: { ...JSON_HDR, origin: 'https://evil.example' }, body: JSON.stringify({ set: { [m1]: { col: 0, row: 0 } } }) });
  assert.equal(evilLayout.status, 403);
  const evilReset = await fetch(`${b.base}${b.P}/milestone-layout`, { method: 'DELETE', headers: { ...JSON_HDR, origin: 'https://evil.example' } });
  assert.equal(evilReset.status, 403);
  const noTokenLayout = await b.api('PUT', `${b.P}/milestone-layout`, { set: {} }, { 'content-type': 'application/json' });
  assert.equal(noTokenLayout.status, 401);
  const badHost = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: b.port, method: 'POST', path: url, headers: { ...JSON_HDR, host: 'evil.example' }, agent: false }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(JSON.stringify({ add: m1 }));
  });
  assert.equal(badHost, 403, 'a foreign Host header is not served');
  assert.equal(cardOf(e, m2).dependsOn, undefined, 'none of them wrote');
  assert.equal(fs.existsSync(core.projectPaths(e.projectDir).layout), false);
  // chat-only: the task board is off, so there is no map to arrange
  await core.saveConfig(e.projectDir, 'project', { mode: 'chat' });
  const chat = await b.link(m2, { add: m1 });
  assert.equal(chat.status, 409, JSON.stringify(chat.body));
  assert.match(chat.body.error, /chat-only/);
  for (const r of [await b.setLayout({ [m1]: { col: 0, row: 0 } }), await b.resetLayout()]) {
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /chat-only/);
  }
  assert.equal(fs.existsSync(core.projectPaths(e.projectDir).layout), false);
});

// ---------------------------------------------------------------- the layout

test('the layout is saved in this machine\'s data folder, in a private file, never in state.json, and /state shows it for milestones that exist', async (t) => {
  const e = setupThreadEnv(t);
  const { m1, m2, m3 } = await shop(e);
  const b = await board(t, e);
  assert.deepEqual((await b.state()).milestoneLayout, {});
  const set = await b.setLayout({ [m1]: { col: 2, row: 1 } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.deepEqual(set.body.layout, { [m1]: { col: 2, row: 1 } });
  const second = await b.setLayout({ [m2]: { col: 0, row: 0 }, [m3]: { col: 1, row: 0 } });
  assert.deepEqual(second.body.layout, { [m1]: { col: 2, row: 1 }, [m2]: { col: 0, row: 0 }, [m3]: { col: 1, row: 0 } }, 'a call adds to what was saved');
  assert.deepEqual((await b.state()).milestoneLayout, second.body.layout);
  const file = core.projectPaths(e.projectDir).layout;
  assert.equal(path.dirname(file), core.projectPaths(e.projectDir).dir);
  assert.ok(file.startsWith(e.dataDir), 'in the data directory');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'a private file');
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o077, 0, 'in a private folder');
  }
  assert.equal(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp')).length, 0, 'written atomically: no temp file is left');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).positions[m1].col, 2);
  const stateText = fs.readFileSync(core.projectPaths(e.projectDir).state, 'utf8');
  assert.equal(stateText.includes('milestoneLayout'), false);
  assert.equal(stateText.includes('"col"'), false, 'state.json holds no position');
  assert.equal(fs.existsSync(path.join(e.projectDir, '.claude')), false, 'nothing is written into the project');
  // a milestone that is gone is not shown, and its place is dropped by the next save
  await core.removeCard(e.projectDir, m3);
  assert.deepEqual(Object.keys((await b.state()).milestoneLayout).sort(), [m1, m2].sort());
  const third = await b.setLayout({ [m1]: { col: 3, row: 1 } });
  assert.deepEqual(third.body.layout, { [m1]: { col: 3, row: 1 }, [m2]: { col: 0, row: 0 } });
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))).includes(m3), false);
});

test('the layout refuses what is not a milestone, a cell outside the grid, a taken cell and a bad body, and writes nothing then', async (t) => {
  const e = setupThreadEnv(t);
  const { m1, m2, t1 } = await shop(e);
  const b = await board(t, e);
  await b.setLayout({ [m1]: { col: 1, row: 1 } });
  const file = core.projectPaths(e.projectDir).layout;
  const before = fs.readFileSync(file, 'utf8');
  const bad = async (set, re, label) => {
    const r = await b.setLayout(set);
    assert.equal(r.status, 400, label);
    assert.match(r.body.error, re, label);
    assert.equal(fs.readFileSync(file, 'utf8'), before, `${label}: nothing written`);
  };
  await bad({ [t1]: { col: 0, row: 0 } }, /milestone not found/, 'a task');
  await bad({ c999: { col: 0, row: 0 } }, /milestone not found: c999/, 'unknown');
  await bad({ [m2]: { col: -1, row: 0 } }, /whole number from 0 to 79/, 'negative');
  await bad({ [m2]: { col: 0, row: 80 } }, /whole number from 0 to 79/, 'too far');
  await bad({ [m2]: { col: 1.5, row: 0 } }, /whole number/, 'a fraction');
  await bad({ [m2]: { col: '1', row: 0 } }, /whole number/, 'a string');
  await bad({ [m2]: { col: 1 } }, /whole number/, 'no row');
  await bad({ [m2]: 5 }, /whole number/, 'not a cell');
  await bad({ [m2]: { col: 1, row: 1 } }, /^the cell column 2, row 2 is taken by "M1: Payments"; "M2: Checkout" cannot share it$/, 'the cell of another');
  await bad({ [m2]: { col: -1, row: 0 } }, /^the cell of "M2: Checkout" must be/, 'named');
  await bad({}, /holds no milestone/, 'empty');
  await bad(undefined, /set must be an object/, 'no set');
  await bad([], /set must be an object/, 'a list');
  const many = {};
  for (let i = 0; i < 21; i++) many[`c${i + 10}`] = { col: i, row: 0 };
  await bad(many, /too many milestones/, 'a flood');
  const extra = await b.api('PUT', `${b.P}/milestone-layout`, { set: { [m2]: { col: 5, row: 5 } }, other: 1 });
  assert.equal(extra.status, 400);
  assert.match(extra.body.error, /unknown key other/);
  // the limits are fine
  assert.equal((await b.setLayout({ [m2]: { col: 79, row: 79 } })).status, 200);
  // two in one call may not share a cell either
  const e2 = await b.setLayout({ [m1]: { col: 7, row: 7 }, [m2]: { col: 7, row: 7 } });
  assert.equal(e2.status, 400);
  // a swap in one call is fine
  const swap = await b.setLayout({ [m1]: { col: 79, row: 79 }, [m2]: { col: 1, row: 1 } });
  assert.equal(swap.status, 200, JSON.stringify(swap.body));
  assert.deepEqual(swap.body.layout, { [m1]: { col: 79, row: 79 }, [m2]: { col: 1, row: 1 } });
});

test('a damaged layout file is no layout: the board still works and the next save starts again; Reset removes the file', async (t) => {
  const e = setupThreadEnv(t);
  const { m1, m2 } = await shop(e);
  const b = await board(t, e);
  await b.setLayout({ [m1]: { col: 1, row: 1 } });
  const file = core.projectPaths(e.projectDir).layout;
  for (const junk of ['{ not json', '[]', '{"version":1,"positions":[1,2]}', JSON.stringify({ positions: { [m1]: { col: -4, row: 'x' }, '../../etc': { col: 1, row: 1 }, [m2]: { col: 2, row: 3 } } })]) {
    fs.writeFileSync(file, junk);
    const st = await b.state();
    assert.equal(st.cards.length > 0, true, 'the board loads');
    assert.deepEqual(st.milestoneLayout, junk.includes(m2) ? { [m2]: { col: 2, row: 3 } } : {}, junk.slice(0, 30));
  }
  fs.writeFileSync(file, '{ not json');
  const set = await b.setLayout({ [m2]: { col: 4, row: 0 } });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.layout, { [m2]: { col: 4, row: 0 } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).positions, { [m2]: { col: 4, row: 0 } });
  const reset = await b.resetLayout();
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.body.layout, {});
  assert.equal(fs.existsSync(file), false);
  assert.equal((await b.resetLayout()).status, 200, 'resetting what is not there is no error');
  assert.deepEqual((await b.state()).milestoneLayout, {});
  assert.equal(core.readState(e.projectDir).cards.length, 5, 'no card was touched');
});

test('two layout saves at once both land', async (t) => {
  const e = setupThreadEnv(t);
  const { m1, m2, m3 } = await shop(e);
  const b = await board(t, e);
  const all = await Promise.all([m1, m2, m3].map((id, i) => b.setLayout({ [id]: { col: i, row: 3 } })));
  assert.deepEqual(all.map((r) => r.status), [200, 200, 200]);
  assert.deepEqual((await b.state()).milestoneLayout, { [m1]: { col: 0, row: 3 }, [m2]: { col: 1, row: 3 }, [m3]: { col: 2, row: 3 } });
});

// ---------------------------------------------------------------- older plugin versions

const OLD_WRITER = path.join(TEST_DIR, 'fixtures', 'old-milestone-writer.mjs');
const oldRun = (e, old, args) => runNode([OLD_WRITER, old, e.projectDir, ...args], { env: { ...process.env, THREAD_DATA_DIR: e.dataDir } });

const KNOWS_LINKS = ['v0.21.0', 'v0.24.1'];   // the versions that know the field: they drop the link to a milestone they remove

for (const ref of RELEASED_REFS) test(`the plugin version at ${ref} keeps a milestone's links when it writes the card, and this version ignores a link to a milestone it removed`, async (t) => {
  const old = oldServerFrom(t, ref);
  if (!old) return;
  const e = setupThreadEnv(t);
  const card = (id, extra) => ({ id, kind: 'milestone', title: id, note: '', status: 'new', source: 'claude', seenByClaude: true, createdAt: '2026-10-14T03:00:00.000Z', updatedAt: '2026-10-14T03:00:00.000Z', ...extra });
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [card('c1', { dependsOn: ['c2', 'c3'], linkNames: { c2: 'first', c3: 'second' } }), card('c2'), card('c3')]));
  const r = await oldRun(e, old, ['c1', 'c3']);
  assert.equal(r.code, 0, r.stderr);
  const c1 = cardOf(e, 'c1');
  assert.equal(c1.title, 'Renamed by the older version', 'the older version did write');
  // the version that knows the field drops the link to the milestone it removes; an older one keeps the list as it was
  assert.deepEqual(c1.dependsOn, KNOWS_LINKS.includes(ref) ? ['c2'] : ['c2', 'c3'], 'the field is kept as it was');
  const names = ref === 'v0.24.1' ? { c2: 'first' } : { c2: 'first', c3: 'second' };   // 0.24.1 also knows the names and drops the one of the line it removes
  assert.deepEqual(c1.linkNames, names, 'and the names of its lines');
  assert.deepEqual(core.liveLinkNames(c1, core.readState(e.projectDir).cards), { c2: 'first' }, 'a name of a line that is gone is not shown');
  assert.equal(cardOf(e, 'c3'), undefined, 'and it removed c3 without knowing the link');
  assert.deepEqual(core.liveDependsOn(c1, core.readState(e.projectDir).cards), ['c2'], 'this version reads the link to c3 as gone');
  const next = await core.changeMilestoneLink(e.projectDir, 'c1', { add: 'c1' }).catch((err) => err);
  assert.match(String(next.message), /cannot depend on itself/);
  const done = await core.updateCard(e.projectDir, 'c1', { title: 'Back again' }, { source: 'user' });
  assert.deepEqual(done.dependsOn, KNOWS_LINKS.includes(ref) ? ['c2'] : ['c2', 'c3'], 'a write that is not about links leaves them as they are');
  assert.deepEqual(done.linkNames, names, 'a rename is no write about lines: the stored names stay');
  assert.deepEqual(core.liveLinkNames(done, core.readState(e.projectDir).cards), { c2: 'first' }, 'and the name of the line that is gone is still not shown');
  const fixed = await core.changeMilestoneLink(e.projectDir, 'c1', { remove: 'c2' });
  assert.equal(fixed.dependsOn, undefined, 'a change of the links rebuilds them from the live ones');
});

// ---------------------------------------------------------------- the names of lines, and taking the card links of a line off their cards

/** M1, M2 and M3; M2 depends on M1 by hand, and a card of M3 is blocked by two cards of M2 (one line from cards). */
async function lines(e) {
  const { m1, m2, m3 } = await shop(e);
  await core.changeMilestoneLink(e.projectDir, m2, { add: m1 });
  const a = (await core.addCard(e.projectDir, { title: 'Cart page', parent: m2 })).id;
  const b = (await core.addCard(e.projectDir, { title: 'Pay form', parent: m2 })).id;
  const c = (await core.addCard(e.projectDir, { title: 'Receipt', parent: m3, blockedBy: [a, b] })).id;
  return { m1, m2, m3, a, b, c };
}

test('a line can be named: a hand link or a card link, one line of text, trimmed, at most 40 characters and 20 names; an empty text takes it away; a name needs a line', async (t) => {
  const e = setupThreadEnv(t);
  const { m1, m2, m3 } = await lines(e);
  await rejects(core.updateCard(e.projectDir, m2, { linkNames: { [m3]: 'x' } }), /no line runs from .* to /);
  await rejects(core.updateCard(e.projectDir, m2, { linkNames: { [m2]: 'x' } }), /cannot have a line to itself/);
  await rejects(core.updateCard(e.projectDir, m2, { linkNames: { c999: 'x' } }), /milestone not found: c999/);
  await rejects(core.updateCard(e.projectDir, m2, { linkNames: { [m1]: 'x'.repeat(41) } }), /1 to 40 characters on one line/);
  await rejects(core.updateCard(e.projectDir, m2, { linkNames: { [m1]: 'two\nlines' } }), /on one line/);
  await rejects(core.updateCard(e.projectDir, m2, { linkNames: { [m1]: 'bell\u0007' } }), /on one line/);
  await rejects(core.updateCard(e.projectDir, m2, { linkNames: { [m1]: 5 } }), /1 to 40 characters/);
  await rejects(core.updateCard(e.projectDir, m2, { linkNames: ['x'] }), /link_names must be an object/);
  await rejects(core.updateCard(e.projectDir, m2, { linkNames: { 'M1': 'x' } }), /link_names takes milestone card ids/);
  await rejects(core.updateCard(e.projectDir, m2, { linkNames: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`c${i + 50}`, 'x'])) }), /too many entries/);
  await rejects(core.updateCard(e.projectDir, (await core.addCard(e.projectDir, { title: 'A task' })).id, { linkNames: { [m1]: 'x' } }), /only for milestones/);
  assert.equal(cardOf(e, m2).linkNames, undefined, 'a refused call writes nothing');
  const named = await core.updateCard(e.projectDir, m2, { linkNames: { [m1]: '  pay   first  ' } });
  assert.deepEqual(named.linkNames, { [m1]: 'pay first' }, 'trimmed, spaces collapsed');
  assert.deepEqual(core.cardById(core.readState(e.projectDir).cards, m2).history.at(-1).fields, ['link names']);
  assert.deepEqual((await core.updateCard(e.projectDir, m3, { linkNames: { [m2]: 'blocks launch' } })).linkNames, { [m2]: 'blocks launch' }, 'a line from cards');
  assert.equal((await core.updateCard(e.projectDir, m2, { linkNames: { [m1]: 'x'.repeat(40) } })).linkNames[m1].length, 40, '40 is fine');
  // a call adds or replaces the names it gives and leaves the others; an empty one takes a name away
  assert.deepEqual((await core.updateCard(e.projectDir, m3, { linkNames: { [m2]: '' } })).linkNames, undefined);
  assert.deepEqual((await core.updateCard(e.projectDir, m2, { linkNames: { [m1]: null } })).linkNames, undefined);
  // the same text again changes nothing
  await core.updateCard(e.projectDir, m2, { linkNames: { [m1]: 'pay first' } });
  const before = cardOf(e, m2).updatedAt;
  await core.updateCard(e.projectDir, m2, { linkNames: { [m1]: 'pay first' } });
  assert.equal(cardOf(e, m2).updatedAt, before);
  // a link and its name in one call
  const m4 = (await core.addCard(e.projectDir, { title: 'M4', kind: 'milestone' })).id;
  const both = await core.updateCard(e.projectDir, m4, { dependsOn: [m1], linkNames: { [m1]: 'first' } });
  assert.deepEqual([both.dependsOn, both.linkNames], [[m1], { [m1]: 'first' }]);
  assert.deepEqual((await core.addCard(e.projectDir, { title: 'M5', kind: 'milestone', dependsOn: [m1], linkNames: { [m1]: 'made with it' } })).linkNames, { [m1]: 'made with it' });
});

test('a name goes with its line: a write that ends the line takes the name (a hand link or the last card link taken away, a blocker edited, a card moved to another milestone or removed); a rename does not', async (t) => {
  const e = setupThreadEnv(t);
  const { m1, m2, m3, a, b, c } = await lines(e);
  await core.updateCard(e.projectDir, m2, { linkNames: { [m1]: 'pay first' } });
  await core.updateCard(e.projectDir, m3, { linkNames: { [m2]: 'blocks launch' } });
  const view = () => core.liveLinkNames(cardOf(e, m3), core.readState(e.projectDir).cards);
  assert.deepEqual(view(), { [m2]: 'blocks launch' });
  await core.changeMilestoneLink(e.projectDir, m2, { remove: m1 });
  assert.equal(cardOf(e, m2).linkNames, undefined, 'the hand link was the whole line: the name goes with it');
  // a rename is no write about lines
  await core.updateCard(e.projectDir, m3, { title: 'M3: Launch!' });
  assert.deepEqual(cardOf(e, m3).linkNames, { [m2]: 'blocks launch' });
  // one blocker of two: the line stays
  await core.updateCard(e.projectDir, c, { blockedBy: [a] }, { source: 'user' });
  assert.deepEqual(cardOf(e, m3).linkNames, { [m2]: 'blocks launch' });
  // the last blocker, from the board's card edit: the name goes at once
  await core.updateCard(e.projectDir, c, { blockedBy: [] }, { source: 'user' });
  assert.equal(cardOf(e, m3).linkNames, undefined, 'the card edit ended the line');
  // a card moved to another milestone
  await core.updateCard(e.projectDir, c, { blockedBy: [a, b] }, { source: 'user' });
  await core.updateCard(e.projectDir, m3, { linkNames: { [m2]: 'again' } });
  await core.updateCard(e.projectDir, c, { parent: m1 }, { source: 'user' });
  assert.equal(cardOf(e, m3).linkNames, undefined, 'the card left the milestone, so the line is gone');
  await core.updateCard(e.projectDir, c, { parent: m3 }, { source: 'user' });
  // a card removed
  await core.updateCard(e.projectDir, m3, { linkNames: { [m2]: 'third' } });
  await core.removeCard(e.projectDir, c, { source: 'user' });
  assert.equal(cardOf(e, m3).linkNames, undefined, 'the card was removed');
  // a card turned into an idea no longer counts
  const d = (await core.addCard(e.projectDir, { title: 'Another', parent: m3, blockedBy: [a] })).id;
  await core.updateCard(e.projectDir, m3, { linkNames: { [m2]: 'fourth' } });
  await core.updateCard(e.projectDir, d, { kind: 'idea' }, { source: 'user' });
  assert.equal(cardOf(e, m3).linkNames, undefined, 'an idea makes no line');
  // a line that both a hand link and a card make
  await core.updateCard(e.projectDir, d, { kind: 'task' }, { source: 'user' });
  await core.changeMilestoneLink(e.projectDir, m3, { add: m2 });
  await core.updateCard(e.projectDir, m3, { linkNames: { [m2]: 'both' } });
  await core.changeMilestoneLink(e.projectDir, m3, { remove: m2 });
  assert.deepEqual(cardOf(e, m3).linkNames, { [m2]: 'both' }, 'the card link still makes the line');
});

test('a name from a file is read as one line of plain text, whatever the file says', async (t) => {
  const e = setupThreadEnv(t);
  const { m1, m2 } = await lines(e);
  await core.updateCard(e.projectDir, m2, { linkNames: { [m1]: 'pay first' } });
  const raw = JSON.parse(fs.readFileSync(core.projectPaths(e.projectDir).state, 'utf8'));
  raw.cards.find((c) => c.id === m2).linkNames = { [m1]: 'a\nfake line\u0007  with   gaps ' + 'x'.repeat(60) };
  fs.writeFileSync(core.projectPaths(e.projectDir).state, JSON.stringify(raw));
  const shown = core.liveLinkNames(cardOf(e, m2), core.readState(e.projectDir).cards)[m1];
  assert.equal(shown.includes('\n'), false);
  assert.equal(/[\u0000-\u001f]/.test(shown), false);
  assert.ok(shown.startsWith('a fake line with gaps x'), shown);
  assert.ok(Array.from(shown).length <= 40);
  const c = mcp(t, e);
  await c.init();
  const list = (await c.call('board_list')).text;
  assert.equal(/\{link names:[^}]*\n/.test(list), false, 'one line, whatever the file says');
  assert.match(list, /\{link names: M1 \(c\d+\) "a fake line with gaps x/);
});

test('the routes: link-name names a line and an empty name takes it away (a missing name is refused); unlink-cards takes only the confirmed pairs off the cards as they are now', async (t) => {
  const e = setupThreadEnv(t);
  const { m1, m2, m3, a, b, c } = await lines(e);
  const bd = await board(t, e);
  const name = (id, body) => bd.api('POST', `${bd.P}/milestones/${id}/link-name`, body);
  const named = await name(m2, { link: m1, name: ' pay first ' });
  assert.equal(named.status, 200, JSON.stringify(named.body));
  assert.deepEqual(named.body.linkNames, { [m1]: 'pay first' });
  assert.deepEqual((await bd.state()).cards.find((x) => x.id === m2).linkNames, { [m1]: 'pay first' });
  assert.equal(cardOf(e, m2).seenByClaude, false);
  assert.match((await name(m2, { link: m3, name: 'x' })).body.error, /no line runs from/);
  assert.match((await name(m2, { link: m1, name: 'x'.repeat(41) })).body.error, /1 to 40 characters/);
  assert.match((await name(m2, { link: 'M1', name: 'x' })).body.error, /card id/);
  assert.equal((await name(m2, { link: m1, name: 5 })).status, 400);
  const missing = await name(m2, { link: m1 });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /name must be given/);
  assert.deepEqual(cardOf(e, m2).linkNames, { [m1]: 'pay first' }, 'a missing name takes nothing away');
  assert.match((await name(m2, { link: m1, extra: 1 })).body.error, /unknown key extra; this route takes: link, name/);
  assert.match((await name('c999', { link: m1, name: 'x' })).body.error, /milestone not found/);
  assert.equal('linkNames' in (await name(m2, { link: m1, name: '' })).body, false);
  // the card links of the line M3 -> M2
  await name(m3, { link: m2, name: 'blocks launch' });
  const unlink = (id, body) => bd.api('POST', `${bd.P}/milestones/${id}/unlink-cards`, body);
  assert.match((await unlink(m3, {})).body.error, /dep must be/);
  assert.match((await unlink(m3, { dep: m2 })).body.error, /cards must be the list/);
  assert.match((await unlink(m3, { dep: m2, cards: [] })).body.error, /give the \[card, blocker\] pairs/);
  assert.match((await unlink(m3, { dep: m2, cards: [[c]] })).body.error, /lists of a card id and a blocker id/);
  const nothing = await unlink(m3, { dep: m1, cards: [[c, a]] });
  assert.equal(nothing.status, 200);
  assert.deepEqual([nothing.body.removed, nothing.body.skipped], [[], 1], 'a pair that makes no line of that kind is skipped');
  const r = await unlink(m3, { dep: m2, cards: [[c, a], [c, b]] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.removed.map((x) => [x.card, x.by]).sort(), [[c, a], [c, b]].sort());
  assert.equal(r.body.skipped, 0);
  assert.equal(cardOf(e, c).blockedBy, undefined, 'taken off the card');
  assert.deepEqual(cardOf(e, c).history.at(-1).fields, ['blocked by'], 'its history says so');
  assert.equal(cardOf(e, c).seenByClaude, false);
  assert.equal(cardOf(e, m3).linkNames, undefined, 'the line is gone, and its name');
  assert.ok(r.body.cards.some((x) => x.id === c) && r.body.cards.some((x) => x.id === m3));
  assert.deepEqual(cardOf(e, m2).dependsOn, [m1], 'a hand link is not touched');
  // chat-only: refused
  await core.saveConfig(e.projectDir, 'project', { mode: 'chat' });
  assert.equal((await unlink(m3, { dep: m2, cards: [[c, a]] })).status, 409);
  assert.equal((await name(m2, { link: m1, name: 'x' })).status, 409);
});

test('taking card links off is one update that touches only what was confirmed: a stale list, a blocker added meanwhile, a leftover blocker, a milestone that is gone, none of them throws halfway', async (t) => {
  const e = setupThreadEnv(t);
  const { m1, m2, m3, a, b, c } = await lines(e);
  const d = (await core.addCard(e.projectDir, { title: 'Second receipt', parent: m3, blockedBy: [b] })).id;
  const stateFile = core.projectPaths(e.projectDir).state;
  // a leftover blocker: the id of a card that was deleted by an older version, and a milestone id, stored on the card
  const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  raw.cards.find((x) => x.id === c).blockedBy = [a, b, 'c99999', m1];
  fs.writeFileSync(stateFile, JSON.stringify(raw));
  const shownList = [[c, a], [c, b], [d, b]];   // what the owner was shown
  // meanwhile another blocker is added to c, and d's blocker is taken off by somebody else
  const raw2 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  raw2.cards.find((x) => x.id === c).blockedBy = [a, b, 'c99999', m1, d];
  raw2.cards.find((x) => x.id === d).blockedBy = [];
  delete raw2.cards.find((x) => x.id === d).blockedBy;
  fs.writeFileSync(stateFile, JSON.stringify(raw2));
  const r = await core.removeCardLinks(e.projectDir, m3, m2, shownList);
  assert.deepEqual(r.removed.map((x) => [x.card, x.by]).sort(), [[c, a], [c, b]].sort());
  assert.equal(r.skipped, 1, 'the pair of d no longer made the line');
  assert.deepEqual(cardOf(e, c).blockedBy, ['c99999', m1, d], 'the blocker that was added, the leftover and the milestone stay as they were, and nothing threw');
  assert.equal(cardOf(e, d).blockedBy, undefined);
  assert.equal(cardOf(e, d).history.at(-1).type, 'created', 'a skipped card was not written');
  // a call that finds nothing to do changes nothing and does not throw
  const before = JSON.stringify(core.readState(e.projectDir).cards);
  const again = await core.removeCardLinks(e.projectDir, m3, m2, shownList);
  assert.deepEqual([again.removed, again.skipped], [[], 3]);
  assert.equal(JSON.stringify(core.readState(e.projectDir).cards), before, 'not even a time stamp');
  // a milestone that is gone: refused before anything is changed
  const m4 = (await core.addCard(e.projectDir, { title: 'M4', kind: 'milestone' })).id;
  const e1 = (await core.addCard(e.projectDir, { title: 'Needs cart', parent: m4, blockedBy: [(await core.addCard(e.projectDir, { title: 'Cart item', parent: m2 })).id] })).id;
  const pair = [e1, cardOf(e, e1).blockedBy[0]];
  await core.removeCard(e.projectDir, m4, { source: 'user' });
  await rejects(core.removeCardLinks(e.projectDir, m4, m2, [pair]), /milestone not found/);
  assert.equal(cardOf(e, e1).blockedBy.length, 1, 'nothing was changed');
  // the dependency milestone gone: the pair makes no line, so it is skipped
  const m5 = (await core.addCard(e.projectDir, { title: 'M5', kind: 'milestone' })).id;
  const f = (await core.addCard(e.projectDir, { title: 'F', parent: m5, blockedBy: [a] })).id;
  await core.removeCard(e.projectDir, m2, { source: 'user' });
  const none = await core.removeCardLinks(e.projectDir, m5, m2, [[f, a]]);
  assert.deepEqual([none.removed, none.skipped], [[], 1]);
});

test('a card with criteria in a finished stage keeps its stage and criteria when its blockers are taken off', async (t) => {
  const e = setupThreadEnv(t);
  const { m2, m3, a, c } = await lines(e);
  await core.updateCard(e.projectDir, c, { status: 'done', criteria: ['works'] }, { source: 'user' });
  const bd = await board(t, e);
  const r = await bd.api('POST', `${bd.P}/milestones/${m3}/unlink-cards`, { dep: m2, cards: [[c, a]] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(cardOf(e, c).status, 'done');
  assert.deepEqual(cardOf(e, c).criteria, ['works']);
});

test('board_update link_names names lines, board_list shows the names, and a refused call says why', async (t) => {
  const e = setupThreadEnv(t);
  const { m1, m2 } = await lines(e);
  const c = mcp(t, e);
  await c.init();
  const ok = await c.call('board_update', { id: m2, link_names: { [m1]: 'pay first' } });
  assert.equal(ok.isError, false, ok.text);
  assert.deepEqual(cardOf(e, m2).linkNames, { [m1]: 'pay first' });
  assert.match((await c.call('board_list')).text, new RegExp(`^- ${m2} \\[milestone:[a-z]+\\] M2: Checkout \\{depends on M1 \\(${m1}\\)\\} \\{link names: M1 \\(${m1}\\) "pay first"\\}`, 'm'));
  assert.match((await c.call('board_update', { id: m2, link_names: { c9999: 'x' } })).text, /milestone not found/);
  assert.match((await c.call('board_update', { id: m1, link_names: { [m2]: 'x' } })).text, /no line runs from/);
  assert.match((await c.call('board_update', { id: m2, link_names: 'x' })).text, /link_names must be an object/);
  assert.equal((await c.call('board_update', { id: m2, link_names: { [m1]: '' } })).isError, false);
  assert.equal(cardOf(e, m2).linkNames, undefined);
  const tools = (await c.request('tools/list', {})).result.tools;
  assert.match(tools.find((x) => x.name === 'board_add').inputSchema.properties.link_names.description, /up to 40 characters/);
  assert.equal((await c.call('board_add', { title: 'M9', kind: 'milestone', depends_on: [m1], link_names: { [m1]: 'with it' } })).isError, false);
});
