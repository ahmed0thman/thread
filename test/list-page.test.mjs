// The board page's List view and Milestones view: the row of a card, the sort of each column, the filters, and the table the page draws.
// The page's own code runs in a vm; the pure blocks alone, the table drawing against a small fake DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { FakeEl } from './helpers.mjs';
import { assembleBoardPage } from '../server/page.mjs';

const html = await assembleBoardPage();
const block = (name) => {
  const m = new RegExp(`// ---- ${name}[^\\n]*\\n([\\s\\S]*?)// ---- end ${name} ----`).exec(html);
  assert.ok(m, `the "${name}" block is missing from the board page`);
  return m[1];
};
const plain = (x) => JSON.parse(JSON.stringify(x));

const CONFIG = {
  mode: 'tasks',
  stages: [{ id: 'idea', label: 'Idea' }, { id: 'new', label: 'New' }, { id: 'in_progress', label: 'In progress' }, { id: 'review', label: 'Review' }, { id: 'blocked', label: 'Blocked' }, { id: 'done', label: 'Done' }],
  roles: { start: 'new', working: 'in_progress', review: 'review', blocked: 'blocked', done: 'done' },
};
const CUSTOM = {
  mode: 'tasks',
  stages: [{ id: 'backlog', label: 'Backlog' }, { id: 'doing', label: 'Doing' }, { id: 'testing', label: 'Testing' }, { id: 'shipped', label: 'Shipped' }],
  roles: { start: 'backlog', working: 'doing', review: 'testing', blocked: 'backlog', done: 'shipped' },
};

const lib = vm.runInNewContext(
  `${block('working now')}\n${block('milestones and stages')}\n${block('list model')}\n${block('milestone view model')}\n`
  + '({ rowType, workerText, listRows, LIST_COLS, LIST_DEFAULT_SORT, sortRows, nextSort, listFilter, listFiltering, listChoices, milestoneStats, milestonesShown, milestonesOrdered, msStateOf, listRowSig, NO_MS })',
  {},
);

const card = (id, extra = {}) => ({ id, kind: 'task', title: `Card ${id}`, note: '', status: 'new', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', ...extra });
const wait = (id, state = 'open') => ({ id, kind: 'question', text: 'Why?', state });
const rows = (cards, config = CONFIG) => lib.listRows(cards, config);
const ids = (rs) => plain(rs).map((r) => r.id);
const idsOf = ids;
const order = (cards, col, dir, config = CONFIG) => ids(lib.sortRows(rows(cards, config), col, dir));

// ---------------------------------------------------------------- the row of a card

test('the type of a row: task, bug, idea, thread, milestone, and a kind this page does not know shows as a task', () => {
  assert.equal(lib.rowType(card('c1')), 'task');
  assert.equal(lib.rowType(card('c1', { type: 'bug' })), 'bug');
  assert.equal(lib.rowType(card('c1', { kind: 'idea' })), 'idea');
  assert.equal(lib.rowType(card('c1', { kind: 'thread', thread: {} })), 'thread');
  assert.equal(lib.rowType(card('c1', { kind: 'milestone' })), 'milestone');
  assert.equal(lib.rowType(card('c1', { kind: 'epic' })), 'task');
  // a milestone or thread is what it is, whatever type says
  assert.equal(lib.rowType(card('c1', { kind: 'milestone', type: 'bug' })), 'milestone');
});

test('a row has the stage label from the config, the priority, the labels, the milestone, the last worker, the open waits and the time', () => {
  const cards = [
    card('c1', { kind: 'milestone', title: 'Launch' }),
    card('c2', {
      status: 'in_progress', type: 'bug', priority: 'high', labels: ['ui', 'checkout'], parent: 'c1', updatedAt: '2026-10-12T08:00:00.000Z',
      workedBy: ['main', 'agent:worker', 'lane:code-codex'], waits: [wait('c2.w1'), wait('c2.w2', 'answered'), wait('c2.w3')],
      blockedBy: ['c3', 'c4', 'c9'], criteria: ['one'], verified: false,
    }),
    card('c3', { status: 'done' }),
    card('c4'),
  ];
  const r = plain(rows(cards)).find((x) => x.id === 'c2');
  assert.equal(r.type, 'bug');
  assert.equal(r.num, 2);
  assert.equal(r.title, 'Card c2');
  assert.equal(r.stageLabel, 'In progress');
  assert.equal(r.stageIdx, 2);
  assert.equal(r.priority, 'high');
  assert.deepEqual(r.labels, ['ui', 'checkout']);
  assert.equal(r.milestoneId, 'c1');
  assert.equal(r.milestoneTitle, 'Launch');
  assert.equal(r.lastWorker, 'lane:code-codex');
  assert.equal(r.moreWorkers, 2);
  assert.equal(r.waits, 2, 'only the open items count');
  assert.equal(r.updated, '2026-10-12T08:00:00.000Z');
  assert.equal(r.updatedMs, Date.parse('2026-10-12T08:00:00.000Z'));
  assert.deepEqual(r.blockedBy, ['c4'], 'only the blocker that is not done: c3 is done and c9 is gone');
  assert.equal(r.unverified, true);
  assert.equal(r.progress, null);
});

test('a milestone row has its progress and state, no waits and no milestone of its own', () => {
  const cards = [
    card('c1', { kind: 'milestone', title: 'Launch', parent: 'c9', waits: [wait('w')] }),
    card('c2', { parent: 'c1', status: 'done' }), card('c3', { parent: 'c1' }), card('c4', { parent: 'c1', status: 'in_progress' }),
  ];
  const m = plain(rows(cards))[0];
  assert.equal(m.type, 'milestone');
  assert.deepEqual(m.progress, { done: 1, total: 3 });
  assert.equal(m.msState, 'open');
  assert.equal(m.stageIdx, null);
  assert.equal(m.waits, 0);
  assert.equal(m.milestoneId, '');
});

test('a card with none of the newer fields (data from an older version) still has a row', () => {
  const old = { id: 'c7', kind: 'task', title: 'Old card', note: '', status: 'new' };
  const r = plain(rows([old]))[0];
  assert.equal(r.type, 'task');
  assert.equal(r.priority, 'normal');
  assert.deepEqual(r.labels, []);
  assert.deepEqual(r.blockedBy, []);
  assert.equal(r.unverified, false);
  assert.equal(r.lastWorker, '');
  assert.equal(r.moreWorkers, 0);
  assert.equal(r.waits, 0);
  assert.equal(r.milestoneId, '');
  assert.equal(r.updated, '');
  assert.equal(r.updatedMs, null);
  assert.equal(r.stageLabel, 'New');
  // and every column can sort and every filter can run over it
  for (const col of lib.LIST_COLS) assert.deepEqual(order([old, card('c8')], col.id, 'asc').length, 2, col.id);
  assert.deepEqual(ids(lib.listFilter(rows([old]), { q: '', blocked: true })), []);
  assert.deepEqual(ids(lib.listFilter(rows([old]), { q: 'old' })), ['c7']);
});

test('a value the page does not know falls back: an unknown priority is normal, a stage that is not in the config keeps its id', () => {
  const r = plain(rows([card('c1', { priority: 'urgent', status: 'archived', labels: 'ui', blockedBy: 'c2', workedBy: [null, 4] })]))[0];
  assert.equal(r.priority, 'normal');
  assert.equal(r.stageLabel, 'archived');
  assert.equal(r.stageIdx, null);
  assert.deepEqual(r.labels, []);
  assert.deepEqual(r.blockedBy, []);
  assert.equal(r.lastWorker, '');
});

test('a worker reads as its kind and its name', () => {
  assert.equal(lib.workerText('main'), 'main');
  assert.equal(lib.workerText('agent:worker'), 'agent worker');
  assert.equal(lib.workerText('thread:c4'), 'thread c4');
  assert.equal(lib.workerText('lane:code-codex'), 'lane code-codex');
});

// ---------------------------------------------------------------- sorting

test('the default sort is the last update, newest first; there is a column for everything the table shows', () => {
  assert.deepEqual(plain(lib.LIST_DEFAULT_SORT), { col: 'updated', dir: 'desc' });
  assert.deepEqual(plain(lib.LIST_COLS).map((c) => c.id), ['id', 'type', 'title', 'stage', 'priority', 'labels', 'milestone', 'worked', 'waiting', 'updated']);
  const cards = [card('c1', { updatedAt: '2026-10-01T00:00:00.000Z' }), card('c2', { updatedAt: '2026-10-09T00:00:00.000Z' }), card('c3', { updatedAt: '2026-10-05T00:00:00.000Z' })];
  assert.deepEqual(order(cards, 'updated', 'desc'), ['c2', 'c3', 'c1']);
  assert.deepEqual(order(cards, 'updated', 'asc'), ['c1', 'c3', 'c2']);
});

test('number columns: the id sorts as a number, not as text', () => {
  const cards = [card('c10'), card('c2'), card('c1'), card('c21')];
  assert.deepEqual(order(cards, 'id', 'asc'), ['c1', 'c2', 'c10', 'c21']);
  assert.deepEqual(order(cards, 'id', 'desc'), ['c21', 'c10', 'c2', 'c1']);
});

test('text columns: the title ignores case and counts digits as numbers; labels, milestone and worker sort as text', () => {
  const cards = [card('c1', { title: 'banana' }), card('c2', { title: 'Apple 10' }), card('c3', { title: 'apple 9' }), card('c4', { title: 'Cherry' })];
  assert.deepEqual(order(cards, 'title', 'asc'), ['c3', 'c2', 'c1', 'c4']);
  assert.deepEqual(order(cards, 'title', 'desc'), ['c4', 'c1', 'c2', 'c3']);
  const labelled = [card('c1', { labels: ['zeta'] }), card('c2', { labels: ['alpha', 'beta'] }), card('c3', { labels: ['beta'] })];
  assert.deepEqual(order(labelled, 'labels', 'asc'), ['c2', 'c3', 'c1']);
  const ms = [card('c1', { kind: 'milestone', title: 'Zed' }), card('c2', { kind: 'milestone', title: 'Alpha' }), card('c3', { parent: 'c1' }), card('c4', { parent: 'c2' })];
  assert.deepEqual(order(ms, 'milestone', 'asc').slice(0, 2), ['c4', 'c3']);
  const workers = [card('c1', { workedBy: ['thread:c4'] }), card('c2', { workedBy: ['agent:worker'] }), card('c3', { workedBy: ['main'] })];
  assert.deepEqual(order(workers, 'worked', 'asc'), ['c2', 'c3', 'c1']);
});

test('priority is high, then normal, then low; a click on its header starts with the high ones', () => {
  const cards = [card('c1', { priority: 'low' }), card('c2'), card('c3', { priority: 'high' }), card('c4', { priority: 'normal' })];
  assert.deepEqual(order(cards, 'priority', 'desc'), ['c3', 'c4', 'c2', 'c1'], 'high, normal (the card with no priority is normal), low');
  assert.deepEqual(order(cards, 'priority', 'asc'), ['c1', 'c2', 'c4', 'c3']);
  assert.deepEqual(plain(lib.nextSort({ col: 'updated', dir: 'desc' }, 'priority')), { col: 'priority', dir: 'desc' });
});

test('the stage sorts in the order of the board columns, also for stages of your own', () => {
  const cards = [card('c1', { status: 'done' }), card('c2', { status: 'idea', kind: 'idea' }), card('c3', { status: 'review' }), card('c4', { status: 'new' }), card('c5', { status: 'in_progress' })];
  assert.deepEqual(order(cards, 'stage', 'asc'), ['c2', 'c4', 'c5', 'c3', 'c1']);
  assert.deepEqual(order(cards, 'stage', 'desc'), ['c1', 'c3', 'c5', 'c4', 'c2']);
  const own = [card('c1', { status: 'shipped' }), card('c2', { status: 'testing' }), card('c3', { status: 'backlog' }), card('c4', { status: 'doing' })];
  assert.deepEqual(order(own, 'stage', 'asc', CUSTOM), ['c3', 'c4', 'c2', 'c1']);
  assert.equal(plain(rows(own, CUSTOM))[0].stageLabel, 'Shipped');
});

test('in the Stage column the milestones come after every stage, open first, then empty, then done, whichever way it is sorted', () => {
  const cards = [
    card('c1', { kind: 'milestone', title: 'Done one' }), card('c2', { parent: 'c1', status: 'done' }),
    card('c3', { kind: 'milestone', title: 'Empty one' }),
    card('c4', { kind: 'milestone', title: 'Open one' }), card('c5', { parent: 'c4', status: 'new' }),
    card('c6', { status: 'idea', kind: 'idea' }), card('c7', { status: 'done' }),
  ];
  assert.deepEqual(order(cards, 'stage', 'asc'), ['c6', 'c5', 'c2', 'c7', 'c4', 'c3', 'c1']);
  assert.deepEqual(order(cards, 'stage', 'desc'), ['c7', 'c2', 'c5', 'c6', 'c4', 'c3', 'c1']);
  assert.deepEqual(plain(rows(cards)).filter((r) => r.type === 'milestone').map((r) => [r.id, r.msState]), [['c1', 'done'], ['c3', 'empty'], ['c4', 'open']]);
});

test('waiting sorts by the number of open items, the most first; the type sorts task, bug, idea, thread, milestone', () => {
  const cards = [card('c1'), card('c2', { waits: [wait('a'), wait('b')] }), card('c3', { waits: [wait('a')] })];
  assert.deepEqual(order(cards, 'waiting', 'desc'), ['c2', 'c3', 'c1']);
  assert.deepEqual(plain(lib.nextSort({ col: 'id', dir: 'asc' }, 'waiting')), { col: 'waiting', dir: 'desc' });
  const kinds = [card('c1', { kind: 'milestone' }), card('c2', { kind: 'thread', thread: {} }), card('c3', { kind: 'idea' }), card('c4', { type: 'bug' }), card('c5')];
  assert.deepEqual(order(kinds, 'type', 'asc'), ['c5', 'c4', 'c3', 'c2', 'c1']);
});

test('a row with no value goes last whichever way the column is sorted, and equal rows keep card order', () => {
  const cards = [card('c1', { labels: ['a'] }), card('c2'), card('c3', { labels: ['b'] }), card('c4')];
  assert.deepEqual(order(cards, 'labels', 'asc'), ['c1', 'c3', 'c2', 'c4']);
  assert.deepEqual(order(cards, 'labels', 'desc'), ['c3', 'c1', 'c4', 'c2']);
  const dated = [card('c1', { updatedAt: undefined }), card('c2'), card('c3', { updatedAt: 'not a date' })];
  assert.deepEqual(order(dated, 'updated', 'desc'), ['c2', 'c3', 'c1']);
  assert.deepEqual(order(dated, 'updated', 'asc'), ['c2', 'c1', 'c3']);
  // the same priority: card number, in the direction of the sort
  const same = [card('c3'), card('c1'), card('c2')];
  assert.deepEqual(order(same, 'priority', 'asc'), ['c1', 'c2', 'c3']);
  assert.deepEqual(order(same, 'priority', 'desc'), ['c3', 'c2', 'c1']);
});

test('sorting does not change the rows it is given, and an unknown column sorts like the default', () => {
  const rs = rows([card('c1', { updatedAt: '2026-10-01T00:00:00.000Z' }), card('c2')]);
  const before = ids(rs);
  lib.sortRows(rs, 'title', 'desc');
  assert.deepEqual(ids(rs), before);
  assert.deepEqual(ids(lib.sortRows(rs, 'nope', 'desc')), ['c2', 'c1']);
});

test('a second click on the sorted column reverses it, another column starts in its own direction', () => {
  let s = lib.LIST_DEFAULT_SORT;
  s = lib.nextSort(s, 'updated');
  assert.deepEqual(plain(s), { col: 'updated', dir: 'asc' });
  s = lib.nextSort(s, 'updated');
  assert.deepEqual(plain(s), { col: 'updated', dir: 'desc' });
  assert.deepEqual(plain(lib.nextSort(s, 'title')), { col: 'title', dir: 'asc' });
  assert.deepEqual(plain(lib.nextSort(s, 'id')), { col: 'id', dir: 'asc' });
});

// ---------------------------------------------------------------- filters and search

const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const DATA = [
  card('c1', { kind: 'milestone', title: 'Launch v1' }),
  card('c2', { title: 'Apple Pay', parent: 'c1', priority: 'high', labels: ['payments', 'ui'], note: 'Needs the merchant id' }),
  card('c3', { title: 'Slow product page', type: 'bug', priority: 'high', labels: ['performance'], blockedBy: ['c2'], parent: 'c1' }),
  card('c4', { title: 'Wishlist', kind: 'idea', status: 'idea' }),
  card('c5', { title: 'Privacy policy', status: 'done', criteria: ['read'], verified: false, labels: ['legal'] }),
  card('c6', { title: 'Cart badge', type: 'bug', priority: 'low', status: 'done', labels: ['ui'] }),
  card('c7', { title: 'Build is flaky', kind: 'thread', thread: { parentSessionId: SESSION } }),
  card('c8', { title: 'Old card without fields' }),
];
const run = (f) => ids(lib.listFilter(rows(DATA), f));

test('no filter shows every card, milestones included', () => {
  assert.deepEqual(run({}), ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8']);
  assert.equal(lib.listFiltering({}), false);
  assert.equal(lib.listFiltering({ q: '', type: '', blocked: false }), false);
});

test('each filter on its own: type, priority, label, blocked, done not verified', () => {
  assert.deepEqual(run({ type: 'bug' }), ['c3', 'c6']);
  assert.deepEqual(run({ type: 'task' }), ['c2', 'c5', 'c8']);
  assert.deepEqual(run({ type: 'milestone' }), ['c1']);
  assert.deepEqual(run({ type: 'idea' }), ['c4']);
  assert.deepEqual(run({ type: 'thread' }), ['c7']);
  assert.deepEqual(run({ priority: 'high' }), ['c2', 'c3']);
  assert.deepEqual(run({ priority: 'low' }), ['c6']);
  assert.deepEqual(run({ priority: 'normal' }), ['c1', 'c4', 'c5', 'c7', 'c8'], 'a card with no priority is normal');
  assert.deepEqual(run({ label: 'ui' }), ['c2', 'c6']);
  assert.deepEqual(run({ label: 'nothing' }), []);
  assert.deepEqual(run({ blocked: true }), ['c3']);
  assert.deepEqual(run({ unverified: true }), ['c5']);
});

test('filters together narrow the list: every one has to fit', () => {
  assert.deepEqual(run({ type: 'bug', priority: 'high' }), ['c3']);
  assert.deepEqual(run({ type: 'bug', label: 'ui' }), ['c6']);
  assert.deepEqual(run({ type: 'bug', priority: 'low', label: 'ui' }), ['c6']);
  assert.deepEqual(run({ type: 'bug', priority: 'low', label: 'performance' }), []);
  assert.deepEqual(run({ blocked: true, unverified: true }), []);
  assert.deepEqual(run({ priority: 'high', blocked: true, label: 'performance' }), ['c3']);
  assert.equal(lib.listFiltering({ type: 'bug', priority: 'high' }), true);
});

test('the search looks at the id, the title and the note, in any case', () => {
  assert.deepEqual(run({ q: 'apple' }), ['c2']);
  assert.deepEqual(run({ q: 'merchant' }), ['c2'], 'the note');
  assert.deepEqual(run({ q: 'c6' }), ['c6'], 'the id');
  assert.deepEqual(run({ q: 'zzz' }), []);
  assert.deepEqual(run({ q: 'cart', type: 'bug' }), ['c6'], 'together with a filter');
  assert.deepEqual(run({ q: 'cart', type: 'task' }), []);
  assert.equal(lib.listFiltering({ q: 'x' }), true);
});

test('the board\'s own filters work here: the milestone and the session', () => {
  assert.deepEqual(run({ milestone: 'c1' }), ['c1', 'c2', 'c3'], 'the milestone and its cards');
  assert.deepEqual(run({ milestone: lib.NO_MS }), ['c4', 'c5', 'c6', 'c7', 'c8'], 'cards in no milestone');
  assert.deepEqual(run({ milestone: 'c1', type: 'bug' }), ['c3']);
  assert.deepEqual(run({ session: SESSION }), ['c7'], 'a session selects its threads');
  assert.deepEqual(run({ session: 'other' }), []);
});

test('a card removed since it was a blocker is not "blocked" (the server drops it), and a card with no list of blockers is not either', () => {
  const rs = rows([card('c1', { blockedBy: [] }), card('c2')]);
  assert.deepEqual(ids(lib.listFilter(rs, { blocked: true })), []);
});

test('blocked means one blocker that is not in the done stage: the mark, the Blocked filter and the board face agree', () => {
  const cards = [
    card('c1', { blockedBy: ['c4'] }),                  // the blocker is open
    card('c2', { blockedBy: ['c5'] }),                  // the only blocker is done
    card('c3', { blockedBy: ['c4', 'c5'] }),            // one open, one done
    card('c4'), card('c5', { status: 'done' }),
  ];
  const rs = rows(cards);
  assert.deepEqual(ids(lib.listFilter(rs, { blocked: true })), ['c1', 'c3']);
  assert.deepEqual(plain(rs.find((r) => r.id === 'c3').blockedBy), ['c4'], 'only the open one is named');
  assert.deepEqual(plain(rs.find((r) => r.id === 'c2').blockedBy), []);
  // a blocker in a stage after the done stage is finished too
  const stages = [...CONFIG.stages, { id: 'released', label: 'Released' }];
  const later = [card('c1', { blockedBy: ['c2'] }), card('c2', { status: 'released' }), card('c3', { blockedBy: ['c4'] }), card('c4', { status: 'blocked' })];
  assert.deepEqual(ids(lib.listFilter(rows(later, { ...CONFIG, stages }), { blocked: true })), ['c3'], 'a blocker in Released holds nothing up');
  // a custom done stage
  const custom = [card('c1', { status: 'doing', blockedBy: ['c2'] }), card('c2', { status: 'shipped' }), card('c3', { status: 'doing', blockedBy: ['c4'] }), card('c4', { status: 'testing' })];
  assert.deepEqual(ids(lib.listFilter(rows(custom, CUSTOM), { blocked: true })), ['c3']);
});

test('the Type filter "Bug" matches every card with type bug, whatever its kind, as the Summary counts open bugs', () => {
  const cards = [
    card('c1', { type: 'bug' }), card('c2', { type: 'bug', kind: 'idea' }),
    card('c3', { type: 'bug', kind: 'thread', thread: {} }), card('c4', { type: 'bug', status: 'done' }), card('c5'),
  ];
  const rs = rows(cards);
  assert.deepEqual(ids(lib.listFilter(rs, { type: 'bug' })), ['c1', 'c2', 'c3', 'c4']);
  // the Type column still says Idea and Thread for what they are
  assert.deepEqual(plain(rs).map((r) => r.type), ['bug', 'idea', 'thread', 'bug', 'task']);
  assert.deepEqual(ids(lib.listFilter(rs, { type: 'idea' })), ['c2'], 'the other types still go by what the row shows');
  // the select offers Bug when only an idea has the type
  assert.deepEqual(plain(lib.listChoices(rows([card('c1', { kind: 'idea', type: 'bug' })]))).types, ['bug', 'idea']);
  // and the Summary's open-bug tile counts the same cards that are not in the done stage
  const sum = vm.runInNewContext(`${block('tokens and agents')}\n${block('milestones and stages')}\n${block('summary')}\n({ summaryModel })`, {});
  const open = lib.listFilter(rs, { type: 'bug' }).filter((r) => r.card.status !== CONFIG.roles.done).length;
  assert.equal(sum.summaryModel(cards, CONFIG, Date.parse('2026-10-14T00:00:00Z')).tiles.bugs, open);
});

test('the selects offer only what some card has, in a fixed order, and the labels from A to Z', () => {
  const ch = plain(lib.listChoices(rows(DATA)));
  assert.deepEqual(ch.types, ['task', 'bug', 'idea', 'thread', 'milestone']);
  assert.deepEqual(ch.priorities, ['high', 'normal', 'low']);
  assert.deepEqual(ch.labels, ['legal', 'payments', 'performance', 'ui']);
  const plainOnly = plain(lib.listChoices(rows([card('c1'), card('c2')])));
  assert.deepEqual(plainOnly, { types: ['task'], priorities: ['normal'], labels: [] });
  assert.deepEqual(plain(lib.listChoices([])), { types: [], priorities: [], labels: [] });
});

// ---------------------------------------------------------------- what the panes draw again for

// The pane keys (list.js, milestones-view.js) are made of these; the page code that joins them reads the state that is not in a vm test.
const SHOWN = () => [
  card('c1', { kind: 'milestone', title: 'Launch' }), card('c2', { kind: 'milestone', title: 'Later' }),
  card('c3', { parent: 'c1', title: 'Open one', status: 'in_progress', note: 'a note', history: [{ at: '2026-10-10T00:00:00.000Z', type: 'created' }] }),
  card('c4', { parent: 'c1', title: 'Done one', status: 'done' }), card('c5', { title: 'Loose card', labels: ['x'] }),
];
const shownKey = (cards, config = CONFIG) => JSON.stringify(lib.milestonesShown(cards.filter((c) => c.kind === 'milestone'), cards, config));
const listKey = (cards, config = CONFIG) => JSON.stringify(rows(cards, config).map(lib.listRowSig));

test('the Milestones key is made of what the view shows: an edit to a card it does not list leaves it alone', () => {
  const base = shownKey(SHOWN());
  const edit = (id, over) => shownKey(SHOWN().map((c) => (c.id === id ? { ...c, ...over } : c)));
  // a card of no milestone, a note, a history entry, a label, an updated time: none is drawn
  assert.equal(edit('c5', { title: 'Renamed loose card', labels: ['y'], note: 'n', updatedAt: '2026-10-20T00:00:00.000Z' }), base);
  assert.equal(edit('c3', { note: 'another note', history: [], updatedAt: '2026-10-20T00:00:00.000Z', labels: ['z'], priority: 'high' }), base);
  assert.equal(edit('c4', { title: 'A done card is not listed' }), base);
  // what it draws does change it: a title or stage of a listed card, a card's move, a milestone's title, a new card in it
  assert.notEqual(edit('c3', { title: 'Renamed open one' }), base);
  assert.notEqual(edit('c3', { status: 'review' }), base);
  assert.notEqual(edit('c3', { status: 'done' }), base);
  assert.notEqual(edit('c5', { parent: 'c1' }), base);
  assert.notEqual(edit('c1', { title: 'Launch 2' }), base);
  assert.notEqual(shownKey([...SHOWN(), card('c6', { parent: 'c2' })]), base);
  assert.notEqual(shownKey(SHOWN(), { ...CONFIG, stages: CONFIG.stages.map((st) => (st.id === 'in_progress' ? { ...st, label: 'Doing' } : st)) }), base, 'the name of a stage');
  assert.match(html, /function milestonesPaneKey\(\) \{ return JSON\.stringify\(\['milestones', selKey, current \? milestonesShown\(/);
  assert.doesNotMatch(html, /milestonesPaneKey[^\n]*currentKey/);
});

test('the List key is made of the rows: a change no row shows keeps it, and one a row shows changes it', () => {
  const base = listKey(SHOWN());
  const edit = (id, over) => listKey(SHOWN().map((c) => (c.id === id ? { ...c, ...over } : c)));
  assert.equal(edit('c3', { note: 'another note' }), base, 'the note is not in a row');
  assert.equal(edit('c3', { history: [] }), base, 'a history entry that changes nothing shown');
  assert.equal(edit('c3', { history: [{ at: '2026-10-10T00:00:00.000Z', type: 'created' }, { at: '2026-10-10T01:00:00.000Z', type: 'worked' }] }), base);
  assert.equal(edit('c3', { runs: [{ n: 1 }], criteria: ['one'] }), base);
  assert.equal(listKey([...SHOWN()].reverse().reverse()), base);
  for (const [what, over] of [['title', { title: 'T' }], ['stage', { status: 'review' }], ['priority', { priority: 'high' }], ['labels', { labels: ['q'] }],
    ['updated time', { updatedAt: '2026-10-20T00:00:00.000Z' }], ['workers', { workedBy: ['main'] }], ['open waits', { waits: [wait('c3.w1')] }],
    ['blockers', { blockedBy: ['c5'] }], ['verified mark', { criteria: ['x'], verified: false }], ['type', { type: 'bug' }], ['milestone', { parent: 'c2' }]]) {
    assert.notEqual(edit('c3', over), base, what);
  }
  assert.notEqual(listKey(SHOWN().filter((c) => c.id !== 'c5')), base, 'a card gone');
  assert.notEqual(edit('c1', { title: 'Launch 2' }), base, 'a milestone title is the Milestone column of its cards');
  assert.match(html, /function listPaneKey\(\) \{[\s\S]*?all\.map\(listRowSig\)/);
  assert.doesNotMatch(html, /function listPaneKey[\s\S]{0,900}currentKey/);
});

test('the Summary key is its model: an unrelated edit does not change it, a shown number does', () => {
  const sum = vm.runInNewContext(`${block('tokens and agents')}\n${block('milestones and stages')}\n${block('summary')}\n({ summaryModel })`, {});
  const now = Date.parse('2026-10-14T12:00:00Z');
  const key = (cards) => JSON.stringify(sum.summaryModel(cards, CONFIG, now));
  const base = key(SHOWN());
  const edit = (id, over) => key(SHOWN().map((c) => (c.id === id ? { ...c, ...over } : c)));
  assert.equal(edit('c5', { note: 'n', labels: ['y'], title: 'Renamed' }), base);
  assert.equal(edit('c3', { history: [], updatedAt: '2026-10-20T00:00:00.000Z' }), base);
  assert.notEqual(edit('c3', { type: 'bug' }), base, 'an open bug is a tile');
  assert.match(html, /JSON\.stringify\(\['summary', selKey, summaryModel\(current\.cards, cfg\(\), Date\.now\(\)\)\]\)/);
});

test('Escape in the search box is followed by the List after the board has cleared the box', () => {
  assert.match(html, /elSearch\.addEventListener\('keydown', \(e\) => \{ if \(e\.key === 'Escape'\) setTimeout\(listFollows, 0\); \}\);/);
  // the board's handler clears the box; the List's runs first, so it must wait
  assert.match(html, /if \(e\.key === 'Escape' && elSearch\.value\) \{ e\.stopPropagation\(\); elSearch\.value = ''; renderBoard\(false\); \}/);
  assert.ok(html.indexOf("setTimeout(listFollows, 0)") < html.indexOf("e.key === 'Escape' && elSearch.value"), 'the List\'s handler is registered first');
});

// ---------------------------------------------------------------- the Milestones view's numbers

test('a milestone counts its cards by the role of their stage and lists the ones not done in stage order', () => {
  const cards = [
    card('c1', { kind: 'milestone' }),
    card('c2', { parent: 'c1', status: 'done' }), card('c3', { parent: 'c1', status: 'in_progress' }), card('c4', { parent: 'c1', status: 'review' }),
    card('c5', { parent: 'c1', status: 'new' }), card('c6', { parent: 'c1', status: 'blocked' }), card('c7', { parent: 'c1', status: 'idea', kind: 'idea' }),
    card('c8', { status: 'new' }),
  ];
  const st = lib.milestoneStats(cards, cards[0], CONFIG);
  assert.equal(st.total, 5, 'the idea (c7) does not count until it is a task');
  assert.equal(st.done, 1);
  assert.equal(st.working, 2, 'working and review');
  assert.equal(st.todo, 2, 'new and blocked');
  assert.deepEqual(idsOf(st.open), ['c5', 'c3', 'c4', 'c6']);
  assert.deepEqual(idsOf(st.shown), ['c5', 'c3', 'c4', 'c6']);
  assert.equal(st.more, 0);
  // the same card as a task is counted again
  const asTask = lib.milestoneStats(cards.map((c) => (c.id === 'c7' ? { ...c, kind: 'task' } : c)), cards[0], CONFIG);
  assert.deepEqual([asTask.total, asTask.todo], [6, 3]);
});

test('a card in a stage after the done stage counts as done in the Milestones view', () => {
  const stages = [...CONFIG.stages, { id: 'released', label: 'Released' }];
  const config = { ...CONFIG, stages };
  const cards = [card('c1', { kind: 'milestone' }), card('c2', { parent: 'c1', status: 'released' }), card('c3', { parent: 'c1', status: 'done' }), card('c4', { parent: 'c1', status: 'blocked' })];
  const st = lib.milestoneStats(cards, cards[0], config);
  assert.deepEqual([st.total, st.done, st.todo, st.working], [3, 2, 1, 0]);
  assert.deepEqual(idsOf(st.open), ['c4']);
});

test('the Milestones view lists open milestones first, then empty ones, then done ones, each group by title', () => {
  const cards = [
    card('c1', { kind: 'milestone', title: 'A done one' }), card('c2', { parent: 'c1', status: 'done' }),
    card('c3', { kind: 'milestone', title: 'An empty one' }), card('c4', { parent: 'c3', kind: 'idea' }),
    card('c5', { kind: 'milestone', title: 'An open one' }), card('c6', { parent: 'c5' }),
    card('c7', { kind: 'milestone', title: 'Another done one' }), card('c8', { parent: 'c7', status: 'done' }),
    card('c9', { kind: 'milestone', title: 'Another open one' }), card('c10', { parent: 'c9', status: 'in_progress' }),
    card('c11', { kind: 'milestone', title: 'Another empty one' }),
  ];
  const ms = cards.filter((c) => c.kind === 'milestone');
  assert.deepEqual(idsOf(lib.milestonesOrdered(ms, cards, CONFIG)), ['c5', 'c9', 'c3', 'c11', 'c1', 'c7']);
  assert.deepEqual(ms.map((m) => lib.msStateOf(m, cards, CONFIG)), ['done', 'empty', 'open', 'done', 'open', 'empty']);
  // the page works the state out from the cards it holds, so it agrees with the progress beside it even when the server's msState is stale
  assert.equal(lib.msStateOf({ ...ms[0], msState: 'open' }, cards, CONFIG), 'done', 'a stale server state is not used');
  const moved = cards.map((c) => (c.id === 'c2' ? { ...c, status: 'new' } : c));   // a child changed here, the milestone card not yet
  assert.equal(lib.msStateOf({ ...ms[0], msState: 'done' }, moved, CONFIG), 'open');
});

test('at most five open cards are listed, and the rest are counted', () => {
  const cards = [card('c1', { kind: 'milestone' })];
  for (let i = 2; i <= 9; i++) cards.push(card('c' + i, { parent: 'c1' }));
  cards.push(card('c10', { parent: 'c1', status: 'done' }));
  const st = lib.milestoneStats(cards, cards[0], CONFIG);
  assert.equal(st.open.length, 8);
  assert.deepEqual(idsOf(st.shown), ['c2', 'c3', 'c4', 'c5', 'c6']);
  assert.equal(st.more, 3);
  assert.equal(st.done, 1);
});

test('a milestone with no cards, or only done ones, has nothing open; custom stages use their roles', () => {
  const empty = lib.milestoneStats([card('c1', { kind: 'milestone' })], card('c1', { kind: 'milestone' }), CONFIG);
  assert.deepEqual(plain(empty), { total: 0, todo: 0, working: 0, done: 0, open: [], shown: [], more: 0 });
  const done = [card('c1', { kind: 'milestone' }), card('c2', { parent: 'c1', status: 'shipped' })];
  const st = lib.milestoneStats(done, done[0], CUSTOM);
  assert.equal(st.done, 1);
  assert.equal(st.open.length, 0);
  const own = [card('c1', { kind: 'milestone' }), card('c2', { parent: 'c1', status: 'doing' }), card('c3', { parent: 'c1', status: 'testing' }), card('c4', { parent: 'c1', status: 'backlog' })];
  const s2 = lib.milestoneStats(own, own[0], CUSTOM);
  assert.deepEqual([s2.todo, s2.working, s2.done], [1, 2, 0]);
  assert.deepEqual(idsOf(s2.open), ['c4', 'c2', 'c3']);
});

// ---------------------------------------------------------------- the table the page draws

function tablePage() {
  const doc = { activeElement: null, createElement: (tag) => new FakeEl(doc, tag) };
  doc.body = new FakeEl(doc, 'body');
  const state = { sort: { col: 'updated', dir: 'desc' }, opened: [], rerendered: 0, ui: null };
  state.ui = { sort: state.sort };
  const env = {
    document: doc,
    h(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; },
    shape(cls) { const s = doc.createElement('span'); s.className = 'shape ' + cls; s.setAttribute('aria-hidden', 'true'); return s; },
    timeEl: (iso) => { const t = doc.createElement('time'); t.textContent = 'rel ' + iso; return t; },
    openCard: (id, el) => state.opened.push([id, el.tagName]),
    listUi: () => state.ui,
    maybeRenderPane: () => { state.rerendered++; },
  };
  const start = html.indexOf('  const TYPE_SHAPE');
  const end = html.indexOf('  function clearListFilters');
  assert.ok(start > 0 && end > start);
  const src = `${block('list model')}\n${block('card field marks')}\n${html.slice(start, end)}\n({ buildListRow, buildListHead, LIST_COLS })`;
  const page = vm.runInNewContext(src, vm.createContext({ ...env, progressOf: () => ({ done: 0, total: 0 }), msStateOf: () => 'empty', MS_STATE_LABEL: { empty: 'Empty', open: 'Open', done: 'Done' }, MS_ORDER: { open: 0, empty: 1, done: 2 }, MS_STATE_HINT: {}, openWaitsOf: () => [] , matches: () => true }));
  return { page, state, doc };
}

test('the header has a button in each column and says in aria-sort which way the table is sorted', () => {
  const t = tablePage();
  const head = t.page.buildListHead({ col: 'updated', dir: 'desc' });
  const ths = head.querySelectorAll('th');
  assert.equal(ths.length, 10);
  assert.equal(head.querySelectorAll('button').length, 10);
  assert.deepEqual(ths.map((th) => th.getAttribute('aria-sort')), [null, null, null, null, null, null, null, null, null, 'descending']);
  assert.ok(ths.every((th) => th.scope === 'col'));
  const sortedAsc = t.page.buildListHead({ col: 'title', dir: 'asc' }).querySelectorAll('th');
  assert.equal(sortedAsc[2].getAttribute('aria-sort'), 'ascending');
  assert.equal(sortedAsc.filter((th) => th.getAttribute('aria-sort')).length, 1);
});

test('a click on a header sorts by that column, and a second click reverses it', () => {
  const t = tablePage();
  const click = (col) => {
    const head = t.page.buildListHead(t.state.ui.sort);
    head.querySelectorAll('button').find((b) => b.dataset.col === col).click();
  };
  click('title');
  assert.deepEqual(plain(t.state.ui.sort), { col: 'title', dir: 'asc' });
  click('title');
  assert.deepEqual(plain(t.state.ui.sort), { col: 'title', dir: 'desc' });
  click('priority');
  assert.deepEqual(plain(t.state.ui.sort), { col: 'priority', dir: 'desc' });
  assert.equal(t.state.rerendered, 3);
});

test('a row can be focused, opens its card on a click and on Enter, and marks a blocked card and an unverified one in words', () => {
  const t = tablePage();
  const cards = [card('c4', { type: 'bug', title: 'Slow page', priority: 'high', blockedBy: ['c2', 'c3'], labels: ['a', 'b', 'c'], workedBy: ['main', 'agent:worker'], waits: [wait('w')], criteria: ['x'], verified: false, status: 'done' })];
  const r = lib.listRows([...cards, card('c2'), card('c3')], CONFIG)[0];
  const tr = t.page.buildListRow(r);
  assert.equal(tr.tabIndex, 0);
  assert.equal(tr.dataset.id, 'c4');
  const text = tr.textContent;
  assert.match(text, /c4/);
  assert.match(text, /Bug/);
  assert.ok(tr.querySelector('.type-mark .shape.s-beetle'), 'List uses the same beetle as the board face');
  assert.equal(tr.querySelector('.type-mark .shape').getAttribute('aria-hidden'), 'true');
  assert.equal(tr.querySelector('.type-mark .tm-word').textContent, 'Bug', 'the visible word also names the type for screen readers');
  assert.doesNotMatch(html, /s-bug/, 'the old oval shape and its CSS are removed');
  assert.match(text, /Slow page/);
  assert.match(text, /blocked by c2, c3/);
  assert.match(text, /done, not verified/);
  assert.match(text, /High/);
  assert.match(text, /agent worker/);
  assert.match(text, /\+1/, 'one more worker');
  assert.match(text, /\+1/, 'and one more label');
  assert.equal(tr.querySelector('.wait-count').textContent, '1');
  assert.match(tr.querySelector('.sr-only').textContent, /waiting for you/);
  tr.click();
  tr.fire('keydown', { key: 'Enter' });
  tr.fire('keydown', { key: 'a' });
  tr.fire('keydown', { key: 'Enter', target: new FakeEl(t.doc, 'button') });
  assert.deepEqual(t.state.opened, [['c4', 'TR'], ['c4', 'TR']]);
});

test('an idea or a thread of type bug keeps a bug mark beside its own type in the row; a bug and a plain idea have none extra', () => {
  const t = tablePage();
  const rowOf = (extra) => t.page.buildListRow(lib.listRows([card('c1', extra)], CONFIG)[0]);
  const idea = rowOf({ kind: 'idea', type: 'bug', status: 'idea' });
  assert.equal(idea.querySelector('.type-mark .tm-word').textContent, 'Idea');
  assert.ok(idea.querySelector('.c-type .fm-bug .shape.s-beetle'), 'the bug mark of the face');
  assert.equal(rowOf({ kind: 'idea', status: 'idea' }).querySelector('.fm-bug'), null);
  assert.equal(rowOf({ type: 'bug' }).querySelector('.c-type .fm-bug'), null, 'a bug is already marked as one by its type');
  assert.equal(rowOf({ kind: 'task' }).querySelector('.fm-bug'), null);
});

test('a card of an older version draws a plain row: no marks, normal priority, empty cells', () => {
  const t = tablePage();
  const tr = t.page.buildListRow(lib.listRows([{ id: 'c1', kind: 'task', title: 'Old', note: '', status: 'new' }], CONFIG)[0]);
  assert.equal(tr.querySelector('.l-marks'), null);
  assert.equal(tr.querySelector('.wait-count'), null);
  assert.match(tr.textContent, /Normal/);
  assert.match(tr.textContent, /Task/);
  assert.equal(tr.querySelector('time'), null);
});

test('a milestone row shows its state and progress where the stage would be, and text from a card is set as text', () => {
  const t = tablePage();
  const page = vm.runInNewContext(`${block('working now')}\n${block('list model')}\n({ listRows })`, { progressOf: () => ({ done: 2, total: 5 }), msStateOf: () => 'open', openWaitsOf: () => [], matches: () => true });
  const m = page.listRows([card('c1', { kind: 'milestone', title: '<img src=x onerror=alert(1)>' })], CONFIG)[0];
  const tr = t.page.buildListRow(m);
  assert.equal(tr.querySelector('.c-stage').textContent, 'Open · 2/5');
  const done = t.page.buildListRow({ ...m, msState: 'done', progress: { done: 3, total: 3 } });
  assert.equal(done.querySelector('.c-stage').textContent, 'Done · 3/3');
  const none = t.page.buildListRow({ ...m, msState: 'empty', progress: { done: 0, total: 0 } });
  assert.equal(none.querySelector('.c-stage').textContent, 'Empty');
  assert.match(tr.textContent, /Milestone/);
  assert.equal(tr.querySelector('.l-title').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(tr.querySelector('img'), null);
});

// ---------------------------------------------------------------- the Milestones view's links

function milestonesPage(cards) {
  const doc = { activeElement: null, createElement: (tag) => new FakeEl(doc, tag) };
  doc.body = new FakeEl(doc, 'body');
  const pane = new FakeEl(doc, 'main');
  doc.body.append(pane);
  const opened = [];
  const env = {
    document: doc, elPane: pane, selKey: 'k1', current: { cards }, opened,
    openCard: (id, el) => opened.push([id, el]),
    cfg: () => CONFIG, milestoneCards: () => cards.filter((c) => c.kind === 'milestone'), label: (s) => s,
    hashFor: (k, t) => '#/' + k + (t ? '/' + t : ''),
    h(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; },
    plainBtn: (text) => { const b = doc.createElement('button'); b.textContent = text; return b; },
    progressEl: (p) => { const e = doc.createElement('div'); e.textContent = p.done + '/' + p.total; return e; },
    msStateTag: (state) => { const e = doc.createElement('span'); e.className = 'tag ms-st'; e.textContent = state; return e; },
    shape(cls) { const s = doc.createElement('span'); s.className = 'shape ' + cls; return s; },
    fmtMs: (ms) => Math.round(ms / 1000) + 's',
    waitTag: () => null,
    goView: () => {}, milestoneSel: '',
  };
  const start = html.indexOf('  function milestonesPaneKey');
  const end = html.indexOf('  // ---------- projects home');
  assert.ok(start > 0 && end > start);
  const src = `${block('card link')}\n${block('working now')}\n${block('milestones and stages')}\n${block('milestone view model')}\n${html.slice(start, end)}\n({ renderMilestones, milestonesPaneKey })`;
  const page = vm.runInNewContext(src, vm.createContext(env));
  return { page, pane, opened };
}

test('a card or milestone link in the Milestones view opens the card page on a plain click, and keeps its address for the others', () => {
  const t = milestonesPage([card('c1', { kind: 'milestone', title: 'Launch' }), card('c2', { parent: 'c1', title: 'Open one' }), card('c3', { parent: 'c1', status: 'done' })]);
  t.page.renderMilestones();
  const head = t.pane.querySelector('a.ms-item-head'), link = t.pane.querySelector('a.ms-open-link');
  assert.deepEqual([head.href, link.href], ['#/k1/c1', '#/k1/c2']);
  const e1 = head.fire('click', { button: 0 });
  const e2 = link.fire('click');
  assert.deepEqual([e1.defaultPrevented, e2.defaultPrevented], [true, true], 'the page opens it, as for a board card');
  assert.deepEqual(t.opened, [['c1', head], ['c2', link]]);
  for (const mod of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) {
    assert.equal(link.fire('click', mod).defaultPrevented, false, JSON.stringify(mod));
  }
  assert.equal(t.opened.length, 2);
  // the key follows what is drawn
  assert.match(t.page.milestonesPaneKey(), /^\["milestones","k1",\[\["c1","Launch","open","",2,1,0,1,0,\[\["c2","Open one","New",""\]\]\]\]\]$/);
});

test('a card with a running agent has a dot in the Milestones view, named for screen readers, and the key follows it', () => {
  const run = { n: 1, agentType: 'worker', state: 'running', startedAt: '2026-10-14T03:26:00.000Z' };
  const cards = [card('c1', { kind: 'milestone', title: 'Launch' }), card('c2', { parent: 'c1', title: 'Busy', runs: [run] }), card('c3', { parent: 'c1', title: 'Idle' })];
  const t = milestonesPage(cards);
  t.page.renderMilestones();
  const rows = t.pane.querySelectorAll('a.ms-open-link');
  assert.equal(rows.length, 2);
  const dot = rows[0].querySelector('.work-dot');
  assert.ok(dot && dot.querySelector('.shape.s-pulse'));
  assert.equal(dot.querySelector('.sr-only').textContent, 'worker working');
  assert.equal(rows[1].querySelector('.work-dot'), null);
  const before = t.page.milestonesPaneKey();
  cards[1].runs = [{ ...run, state: 'done' }];
  assert.notEqual(t.page.milestonesPaneKey(), before, 'the view is drawn again when the run ends');
});

test('closing a card page opened from a link in the Milestones or the Summary puts focus back on that link', () => {
  assert.match(html, /Array\.prototype\.find\.call\(elPane\.querySelectorAll\('a\[href\]'\), \(a\) => a\.getAttribute\('href'\) === href\)/);
  assert.match(html, /const href = hashFor\(selKey, rf\.id\);/);
});

test('a redraw of the pane gives focus back to the link, row or button that had it', () => {
  assert.match(html, /const focus = !keep && where === paneWhere \? paneFocusKey\(\) : null;/);
  assert.match(html, /restorePaneFocus\(focus\);/);
});

// ---------------------------------------------------------------- the wiring

test('the List is a view with its own filters in the toolbar, the search works on it, and the table scrolls in its own box', () => {
  assert.match(html, /const SEARCH_VIEWS = \['board', 'waiting', 'list'\];/);
  for (const id of ['list-filters', 'ltype-filter', 'lprio-filter', 'llabel-filter', 'lblocked', 'lunverified']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /if \(viewSel === 'list'\) return listPaneKey\(\);/);
  assert.match(html, /else if \(viewSel === 'list'\) renderList\(keep\);/);
  assert.match(html, /\.list-scroll \{[^}]*overflow: auto;/, 'the table scrolls inside its box');
  assert.match(html, /\.list-table \{[^}]*min-width: \d+px;/);
  assert.match(html, /@media \(max-width: 760px\) \{\n  \.list-table/);
});

test('the card page of a row returns focus to the row, and the chat-only route has no List', () => {
  assert.match(html, /elPane\.querySelector\('\.lrow\[data-id="' \+ cssEscape\(rf\.id\) \+ '"\]'\)/);
  // a chat-only project only has the board; the route test (shell-page.test.mjs) covers the redirect
  const routes = vm.runInNewContext(`${block('routes')}\n({ viewsOf, resolveView, parseRoute })`, {});
  assert.deepEqual(plain(routes.viewsOf(true)), ['board']);
  assert.deepEqual(plain(routes.resolveView(routes.parseRoute('#/k/list'), true, '')), { view: 'board', fix: true });
});

test('milestones in one state go by title with numbers compared as numbers, not by id (random in a repo-backed project)', () => {
  const ms = (id, title) => card(id, { kind: 'milestone', title });
  const cards = [ms('cq7z2a', 'M10: Billing'), ms('c3kd9x', 'M2: Channels'), ms('ca1b2c', 'M1: Setup'), ms('cz9y8x', 'm3: Inbox')];
  cards.push(...cards.map((m, i) => card('k' + i, { parent: m.id })));
  const list = cards.filter((c) => c.kind === 'milestone');
  assert.deepEqual(lib.milestonesOrdered(list, cards, CONFIG).map((m) => m.title), ['M1: Setup', 'M2: Channels', 'm3: Inbox', 'M10: Billing']);
});
